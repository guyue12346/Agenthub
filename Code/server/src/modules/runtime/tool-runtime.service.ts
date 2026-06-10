import { Inject, Injectable, Optional } from "@nestjs/common";
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import type { Dirent } from "node:fs";
import { copyFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { nanoid } from "nanoid";
import { getQuickJS, shouldInterruptAfterDeadline } from "quickjs-emscripten";
import { Prisma, type WorkspaceAssetKind } from "../../generated/prisma/client.js";
import { ConfigService } from "../../common/config.service.js";
import { PrismaService } from "../../common/prisma.service.js";
import { isInsideAnyWorkspaceRoot } from "../../common/workspace-roots.js";
import { normalizeAgentDocumentPath, WORKSPACE_CODE_DIR, WORKSPACE_DOCS_DIR } from "../../common/workspace-layout.js";
import { KnowledgeService } from "../knowledge/knowledge.service.js";
import { executableRuntimeToolIds } from "../tools/tool-registry.js";
import { ExcalidrawRenderService } from "./excalidraw-render.service.js";
import type { UiAgentDesignCandidate } from "./ui-agent.schemas.js";

export interface RuntimeToolRequest {
  toolId: string;
  input?: Record<string, unknown>;
  reason?: string;
}

export interface RuntimeToolResult {
  toolRunId: string;
  toolId: string;
  status: "queued" | "completed" | "failed" | "cancelled";
  output?: unknown;
  error?: string;
}

export interface RuntimeToolApprovalResume {
  schemaVersion: "agent-tool-approval-resume.v1";
  [key: string]: unknown;
}

export interface RuntimeGeneratedAssetInput {
  conversationId: string;
  path: string;
  content: string | Buffer;
  mimeType?: string;
  kind?: WorkspaceAssetKind;
  summary?: string;
  source: string;
  callerType?: "orchestrator" | "agent" | "user" | "system";
  callerId?: string;
}

export interface RuntimeWorkspacePolicy {
  docRead: boolean;
  docWrite: boolean;
  codeRead: boolean;
  codeWrite: boolean;
  assetCreate: boolean;
}

interface RuntimeToolCaller {
  callerType: "orchestrator" | "agent" | "user" | "system";
  callerId: string;
  workspacePolicy?: RuntimeWorkspacePolicy;
}

const MAX_RUNTIME_WRITE_BYTES = 600_000;
const MAX_RUNTIME_READ_BYTES = 300_000;
const MAX_API_FETCH_BYTES = 300_000;
const RUNTIME_TEXT_EXTENSIONS = new Set([".md", ".markdown", ".txt", ".json", ".yaml", ".yml", ".csv"]);
const BLOCKED_WRITE_SEGMENTS = new Set([".git", ".agenthub", ".versions", "node_modules", "dist", "build", ".next", ".vite", "coverage"]);
const execFile = promisify(execFileCallback);

@Injectable()
export class ToolRuntimeService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ConfigService) private readonly config: ConfigService,
    @Optional()
    @Inject(KnowledgeService)
    private readonly knowledgeService?: KnowledgeService,
    @Optional()
    @Inject(ExcalidrawRenderService)
    private readonly excalidrawRenderer?: ExcalidrawRenderService
  ) {}

  async execute(input: {
    runId?: string;
    conversationId: string;
    callerType: "orchestrator" | "agent" | "user" | "system";
    callerId: string;
    request: RuntimeToolRequest;
    workspacePolicy?: RuntimeWorkspacePolicy;
  }): Promise<RuntimeToolResult> {
    const toolRun = await this.prisma.toolRun.create({
      data: {
        id: `tool-run-${nanoid(10)}`,
        runId: input.runId ?? null,
        toolId: input.request.toolId,
        callerType: input.callerType,
        callerId: input.callerId,
        status: "running",
        input: (input.request.input ?? {}) as Prisma.InputJsonValue
      }
    });
    try {
      const output = await this.executeKnownTool(input.conversationId, input.request, {
        callerType: input.callerType,
        callerId: input.callerId,
        ...(input.workspacePolicy ? { workspacePolicy: input.workspacePolicy } : {})
      });
      await this.prisma.toolRun.update({
        where: { id: toolRun.id },
        data: { status: "completed", output: output as Prisma.InputJsonValue }
      });
      return { toolRunId: toolRun.id, toolId: input.request.toolId, status: "completed", output };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.prisma.toolRun.update({
        where: { id: toolRun.id },
        data: { status: "failed", error: message }
      });
      return { toolRunId: toolRun.id, toolId: input.request.toolId, status: "failed", error: message };
    }
  }

  async queueApproval(input: {
    runId?: string;
    conversationId: string;
    callerType: "orchestrator" | "agent" | "user" | "system";
    callerId: string;
    request: RuntimeToolRequest;
    workspacePolicy?: RuntimeWorkspacePolicy;
    reason?: string;
    resumeState?: RuntimeToolApprovalResume;
  }): Promise<RuntimeToolResult> {
    const toolRun = await this.prisma.toolRun.create({
      data: {
        id: `tool-run-${nanoid(10)}`,
        runId: input.runId ?? null,
        toolId: input.request.toolId,
        callerType: input.callerType,
        callerId: input.callerId,
        status: "queued",
        input: ({
          request: input.request,
          workspacePolicy: input.workspacePolicy ?? null,
          approval: {
            status: "pending",
            conversationId: input.conversationId,
            reason: input.reason ?? input.request.reason ?? "",
            requestedAt: new Date().toISOString(),
            ...(input.resumeState ? { resumeState: input.resumeState } : {})
          }
        } as unknown) as Prisma.InputJsonValue
      }
    });
    return {
      toolRunId: toolRun.id,
      toolId: toolRun.toolId,
      status: "queued",
      output: {
        approvalRequired: true,
        conversationId: input.conversationId,
        reason: input.reason ?? input.request.reason ?? ""
      }
    };
  }

  async approveQueuedToolRun(toolRunId: string, approvedByUserId: string): Promise<RuntimeToolResult> {
    const toolRun = await this.prisma.toolRun.findFirst({ where: { id: toolRunId, deletedAt: null } });
    if (!toolRun) throw new Error("tool run not found");
    if (toolRun.status !== "queued") throw new Error("tool run is not waiting for approval");
    const parsed = parseQueuedApprovalInput(toolRun.input);
    await this.prisma.toolRun.update({
      where: { id: toolRun.id },
      data: {
        status: "running",
        input: {
          ...parsed.rawInput,
          approval: {
            ...parsed.approval,
            status: "approved",
            approvedByUserId,
            approvedAt: new Date().toISOString()
          }
        } as Prisma.InputJsonValue
      }
    });
    try {
      const output = await this.executeKnownTool(parsed.conversationId, parsed.request, {
        callerType: toolRun.callerType,
        callerId: toolRun.callerId,
        ...(parsed.workspacePolicy ? { workspacePolicy: parsed.workspacePolicy } : {})
      });
      await this.prisma.toolRun.update({
        where: { id: toolRun.id },
        data: { status: "completed", output: output as Prisma.InputJsonValue }
      });
      return { toolRunId: toolRun.id, toolId: toolRun.toolId, status: "completed", output };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.prisma.toolRun.update({
        where: { id: toolRun.id },
        data: { status: "failed", error: message }
      });
      return { toolRunId: toolRun.id, toolId: toolRun.toolId, status: "failed", error: message };
    }
  }

  async rejectQueuedToolRun(toolRunId: string, rejectedByUserId: string, reason?: string): Promise<RuntimeToolResult> {
    const toolRun = await this.prisma.toolRun.findFirst({ where: { id: toolRunId, deletedAt: null } });
    if (!toolRun) throw new Error("tool run not found");
    if (toolRun.status !== "queued") throw new Error("tool run is not waiting for approval");
    const parsed = parseQueuedApprovalInput(toolRun.input);
    const message = reason?.trim() || "用户拒绝了高风险工具调用";
    await this.prisma.toolRun.update({
      where: { id: toolRun.id },
      data: {
        status: "cancelled",
        error: message,
        input: {
          ...parsed.rawInput,
          approval: {
            ...parsed.approval,
            status: "rejected",
            rejectedByUserId,
            rejectedAt: new Date().toISOString(),
            reason: message
          }
        } as Prisma.InputJsonValue
      }
    });
    return { toolRunId: toolRun.id, toolId: toolRun.toolId, status: "cancelled", error: message };
  }

  async getApprovalResumeState(toolRunId: string) {
    const toolRun = await this.prisma.toolRun.findFirst({ where: { id: toolRunId, deletedAt: null } });
    if (!toolRun) throw new Error("tool run not found");
    const input = asRecord(toolRun.input);
    const approval = asRecord(input?.approval);
    const resumeState = asRecord(approval?.resumeState);
    return resumeState?.schemaVersion === "agent-tool-approval-resume.v1" ? resumeState : undefined;
  }

  async storeGeneratedAsset(input: RuntimeGeneratedAssetInput) {
    const workspace = await this.resolveWorkspace(input.conversationId);
    const requestedPath = normalizeGeneratedAssetPath(input.path, {
      callerType: input.callerType ?? "system",
      callerId: input.callerId ?? "system"
    });
    assertGeneratedAssetRelativePath(requestedPath);
    const content = typeof input.content === "string" ? Buffer.from(input.content, "utf8") : input.content;
    if (content.byteLength > MAX_RUNTIME_WRITE_BYTES) throw new Error(`generated asset exceeds ${MAX_RUNTIME_WRITE_BYTES} bytes`);
    return this.writeWorkspaceAsset(workspace, requestedPath, content, {
      mimeType: input.mimeType ?? inferMimeType(requestedPath),
      kind: input.kind ?? inferAssetKind(requestedPath),
      summary: input.summary ?? summarizeGeneratedAsset(requestedPath, content),
      source: input.source
    });
  }

  private async executeKnownTool(conversationId: string, request: RuntimeToolRequest, caller: RuntimeToolCaller) {
    const resolvedTool = await this.resolveExecutableTool(request.toolId);
    if (resolvedTool.runtimeType === "function") return this.executeFunctionTool(resolvedTool, request);
    const effectiveRequest = resolvedTool.runtimeToolId && resolvedTool.runtimeToolId !== request.toolId
      ? { ...request, toolId: resolvedTool.runtimeToolId }
      : request;
    if (effectiveRequest.toolId === "api_fetch_json") return this.executeApiFetchJson(effectiveRequest);
    if (effectiveRequest.toolId === "web_search") return this.executeWebSearch(effectiveRequest);
    if (effectiveRequest.toolId === "diagram_draw") return this.executeDiagramDraw(conversationId, effectiveRequest);
    if (effectiveRequest.toolId === "mcp_fetch_markdown") return this.executeMcpFetchMarkdown(conversationId, effectiveRequest);
    if (effectiveRequest.toolId === "mcp_git_inspect") return this.executeMcpGitInspect(conversationId, effectiveRequest, caller);
    if (effectiveRequest.toolId === "mcp_workspace_snapshot") return this.executeMcpWorkspaceSnapshot(conversationId, effectiveRequest, caller);

    if (effectiveRequest.toolId === "search_knowledge") {
      if (!this.knowledgeService) throw new Error("search_knowledge requires KnowledgeService");
      const knowledgeAssetId = stringInput(effectiveRequest.input, "knowledgeAssetId");
      const query = stringInput(effectiveRequest.input, "query");
      const topK = numberInput(effectiveRequest.input, "topK", 5, { min: 1, max: 20 });
      const scoreThreshold = numberInput(effectiveRequest.input, "scoreThreshold", 0.7, { min: 0, max: 1 });

      const conversationUser = caller.callerType === "user"
        ? null
        : await this.prisma.conversationMember.findFirst({
            where: {
              conversationId,
              memberType: "user",
              deletedAt: null
            },
            orderBy: { createdAt: "asc" },
            select: { memberId: true }
          });
      const user = await this.prisma.user.findUnique({
        where: { id: caller.callerType === "user" ? caller.callerId : conversationUser?.memberId ?? "" }
      });
      if (!user) throw new Error("User not found");

      const results = await this.knowledgeService.search(
        { id: user.id, name: user.name, role: user.role } as any,
        knowledgeAssetId,
        {
          query,
          topK,
          scoreThreshold,
          conversationId,
          callerType: caller.callerType,
          callerId: caller.callerId
        }
      );

      return {
        knowledgeAssetId,
        query,
        results: results.map((result) => ({
          id: result.chunkId,
          documentId: result.documentId,
          title: result.metadata.title,
          path: result.metadata.path,
          content: result.content,
          score: result.score
        }))
      };
    }

    const workspace = await this.resolveWorkspace(conversationId);
    if (effectiveRequest.toolId === "list_files") {
      const requestedPath = stringInput(effectiveRequest.input, "path", false);
      const depth = numberInput(effectiveRequest.input, "depth", 2, { min: 0, max: 5 });
      const limit = numberInput(effectiveRequest.input, "limit", 300, { min: 1, max: 500 });
      const absolutePath = resolveWorkspacePath(workspace.rootPath, requestedPath, this.config.workspacesRoot);
      assertWorkspacePolicyForPath("list_files", normalizeDirectoryPath(workspace.rootPath, absolutePath), caller.workspacePolicy);
      const fileStat = await stat(absolutePath);
      if (!fileStat.isDirectory()) throw new Error("list_files path must be a directory");
      const listed = await listFiles(workspace.rootPath, absolutePath, depth, limit);
      return {
        path: normalizeDirectoryPath(workspace.rootPath, absolutePath),
        depth,
        limit,
        ...listed
      };
    }
    if (effectiveRequest.toolId === "read_file") {
      const filePath = stringInput(effectiveRequest.input, "path");
      const absolutePath = resolveWorkspacePath(workspace.rootPath, filePath, this.config.workspacesRoot);
      assertWorkspacePolicyForPath("read_file", normalizeRelativePath(workspace.rootPath, absolutePath), caller.workspacePolicy);
      const fileStat = await stat(absolutePath);
      if (!fileStat.isFile()) throw new Error("file is not readable");
      if (fileStat.size > MAX_RUNTIME_READ_BYTES) throw new Error("file is too large for tool read");
      return {
        path: normalizeRelativePath(workspace.rootPath, absolutePath),
        content: await readFile(absolutePath, "utf8")
      };
    }
    if (effectiveRequest.toolId === "search_files") {
      const query = stringInput(effectiveRequest.input, "query").toLowerCase();
      const requestedPath = stringInput(effectiveRequest.input, "path", false);
      const absolutePath = resolveWorkspacePath(workspace.rootPath, requestedPath, this.config.workspacesRoot);
      assertWorkspacePolicyForPath("search_files", normalizeDirectoryPath(workspace.rootPath, absolutePath), caller.workspacePolicy);
      const fileStat = await stat(absolutePath);
      if (!fileStat.isDirectory()) throw new Error("search_files path must be a directory");
      const { files } = await listFiles(workspace.rootPath, absolutePath, 6, 2_000);
      const matches = files.filter((file) => file.type === "file" && file.path.toLowerCase().includes(query)).slice(0, 50);
      return { query, matches };
    }
    if (effectiveRequest.toolId === "write_file" || effectiveRequest.toolId === "create_asset") {
      const requestedPath = stringInput(effectiveRequest.input, "path", false)
        || stringInput(effectiveRequest.input, "filePath", false)
        || stringInput(effectiveRequest.input, "name");
      const content = stringInput(effectiveRequest.input, "content");
      const summary = stringInput(effectiveRequest.input, "summary", false);
      const normalizedPath = normalizeWritableToolPath(requestedPath, caller);
      assertWorkspacePolicyForPath(effectiveRequest.toolId, normalizedPath, caller.workspacePolicy);
      return this.writeWorkspaceTextAsset(workspace, normalizedPath, content, summary, effectiveRequest.toolId);
    }
    if (effectiveRequest.toolId === "read_asset") {
      const assetId = stringInput(effectiveRequest.input, "assetId", false);
      const assetPath = stringInput(effectiveRequest.input, "path", false);
      const asset = await this.prisma.workspaceAsset.findFirst({
        where: {
          workspaceId: workspace.id,
          deletedAt: null,
          ...(assetId ? { id: assetId } : {}),
          ...(assetPath ? { path: assetPath } : {})
        }
      });
      if (!asset) throw new Error("asset not found");
      assertWorkspacePolicyForPath("read_asset", asset.path, caller.workspacePolicy);
      return {
        id: asset.id,
        kind: asset.kind,
        name: asset.name,
        path: asset.path,
        summary: asset.summary ?? ""
      };
    }
    throw new Error(`unsupported tool: ${request.toolId}`);
  }

  private async resolveExecutableTool(toolId: string) {
    const builtinIds = executableRuntimeToolIds as readonly string[];
    const tool = await this.prisma.toolDefinition.findFirst({
      where: { id: toolId, deletedAt: null }
    });
    if (!tool) {
      if (builtinIds.includes(toolId)) return { toolId, runtimeType: "builtin", runtimeToolId: toolId, metadata: {}, executable: true };
      throw new Error(`unsupported tool: ${toolId}`);
    }
    if (!tool.executable) throw new Error(`tool is not executable: ${toolId}`);
    const metadata = asRecord(tool.metadata) ?? {};
    if (tool.runtimeType === "builtin" || tool.runtimeType === "official_api" || tool.runtimeType === "official_mcp") {
      const runtimeToolId = tool.runtimeToolId || tool.id;
      if (!builtinIds.includes(runtimeToolId)) throw new Error(`tool runtime is not executable: ${toolId}`);
      return { toolId: tool.id, runtimeType: tool.runtimeType, runtimeToolId, metadata, executable: true };
    }
    if (tool.runtimeType === "builtin_alias") {
      const runtimeToolId = tool.runtimeToolId ?? "";
      if (!builtinIds.includes(runtimeToolId)) throw new Error(`tool alias target is not executable: ${toolId}`);
      return { toolId: tool.id, runtimeType: "builtin_alias", runtimeToolId, metadata, executable: true };
    }
    if (tool.runtimeType === "function") {
      return { toolId: tool.id, runtimeType: "function", runtimeToolId: tool.id, metadata, executable: true };
    }
    throw new Error(`unsupported tool runtime: ${tool.runtimeType}`);
  }

  private async executeFunctionTool(
    tool: { toolId: string; metadata: Record<string, unknown> },
    request: RuntimeToolRequest
  ) {
    const runtime = asRecord(tool.metadata.runtime) ?? asRecord(tool.metadata.functionRuntime);
    const source = stringish(asRecord(runtime)?.source ?? asRecord(tool.metadata.functionSpec)?.source);
    if (!source) throw new Error("function tool source is missing");
    const limits = asRecord(asRecord(runtime)?.limits);
    const timeoutMs = clampNumber(limits?.timeoutMs, 800, 50, 2_000);
    const memoryLimitBytes = clampNumber(limits?.memoryMb, 16, 4, 32) * 1024 * 1024;
    const outputLimitBytes = clampNumber(limits?.outputBytes, 32_000, 1_024, 128_000);
    const input = request.input ?? {};
    const code = [
      "\"use strict\";",
      "(() => {",
      "  try {",
      `    const __input = JSON.parse(${JSON.stringify(JSON.stringify(input))});`,
      `    const __source = ${JSON.stringify(source)};`,
      "    const __tool = (0, eval)(\"(\" + __source + \")\");",
      "    if (typeof __tool !== \"function\") throw new Error(\"Tool source must evaluate to a function\");",
      "    const __result = __tool(Object.freeze(__input));",
      "    if (__result && typeof __result.then === \"function\") throw new Error(\"Async function tools are not supported in v1\");",
      "    return JSON.stringify({ ok: true, result: __result === undefined ? null : __result });",
      "  } catch (error) {",
      "    const message = error && typeof error.message === \"string\" ? error.message : String(error);",
      "    return JSON.stringify({ ok: false, error: message });",
      "  }",
      "})()"
    ].join("\n");
    const QuickJS = await getQuickJS();
    const startedAt = Date.now();
    let result: unknown;
    try {
      result = QuickJS.evalCode(code, {
        shouldInterrupt: shouldInterruptAfterDeadline(startedAt + timeoutMs),
        memoryLimitBytes
      });
    } catch (error) {
      throw new Error(`function tool runtime error: ${runtimeErrorMessage(error)}`);
    }
    if (typeof result !== "string") throw new Error("function tool must return JSON-serializable data");
    if (Buffer.byteLength(result, "utf8") > outputLimitBytes) throw new Error("function tool output exceeds limit");
    const envelope = parseJsonOrNull(result);
    const envelopeRecord = asRecord(envelope);
    if (!envelopeRecord?.ok) throw new Error(stringish(envelopeRecord?.error) ?? "function tool failed");
    return {
      toolId: tool.toolId,
      runtimeType: "function",
      elapsedMs: Date.now() - startedAt,
      result: envelopeRecord.result ?? null
    };
  }

  private async executeApiFetchJson(request: RuntimeToolRequest) {
    const url = await assertPublicHttpsUrl(stringInput(request.input, "url"));
    const headersInput = asRecord(request.input?.headers) ?? {};
    const headers = sanitizeApiHeaders(headersInput);
    const startedAt = Date.now();
    const response = await fetch(url, {
      method: "GET",
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(8_000)
    });
    const contentType = response.headers.get("content-type") ?? "";
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > MAX_API_FETCH_BYTES) throw new Error("api response exceeds size limit");
    const parsed = contentType.includes("json") || looksLikeJson(text) ? parseJsonOrNull(text) : null;
    return {
      url,
      status: response.status,
      ok: response.ok,
      contentType,
      elapsedMs: Date.now() - startedAt,
      ...(parsed === null ? { textSnippet: text.slice(0, 20_000) } : { json: parsed })
    };
  }

  private async executeWebSearch(request: RuntimeToolRequest) {
    const query = stringInput(request.input, "query");
    const maxResults = numberInput(request.input, "maxResults", 5, { min: 1, max: 10 });
    const locale = stringInput(request.input, "locale", false);
    const provider = stringInput(request.input, "provider", false) || "bing_via_jina";
    if (provider !== "bing_via_jina") throw new Error(`unsupported web_search provider: ${provider}`);
    const bingUrl = new URL("https://www.bing.com/search");
    bingUrl.searchParams.set("q", query);
    if (locale) bingUrl.searchParams.set("setlang", locale);
    const searchUrl = await assertPublicHttpsUrl(`https://r.jina.ai/http://r.jina.ai/http://${bingUrl.toString()}`);
    const startedAt = Date.now();
    const response = await fetch(searchUrl, {
      method: "GET",
      headers: {
        accept: "text/plain, text/markdown;q=0.9",
        "user-agent": "AgentHubBot/0.1 (+https://agenthub.local)"
      },
      redirect: "error",
      signal: AbortSignal.timeout(12_000)
    });
    const markdown = await response.text();
    if (Buffer.byteLength(markdown, "utf8") > MAX_API_FETCH_BYTES) throw new Error("web search response exceeds size limit");
    const candidates = parseBingJinaSearchResults(markdown, Math.max(maxResults * 4, 20));
    const relevantResults = filterRelevantSearchResults(candidates, query);
    const results = relevantResults.slice(0, maxResults).map((result, index) => ({ ...result, rank: index + 1 }));
    const filteredResultCount = Math.max(0, candidates.length - relevantResults.length);
    return {
      query,
      provider,
      locale: locale || null,
      sourceUrl: bingUrl.toString(),
      status: response.status,
      ok: response.ok,
      elapsedMs: Date.now() - startedAt,
      rawResultCount: candidates.length,
      filteredResultCount,
      ...(filteredResultCount > 0 ? { warnings: ["low_relevance_search_results_filtered"] } : {}),
      resultCount: results.length,
      results
    };
  }

  private async executeDiagramDraw(conversationId: string, request: RuntimeToolRequest) {
    const workspace = await this.resolveWorkspace(conversationId);
    const design = diagramInputToDesign(request.input);
    const renderer = this.excalidrawRenderer ?? new ExcalidrawRenderService();
    const rendered = await renderer.render(design);
    const basePath = `Doc/diagrams/${new Date().toISOString().slice(0, 10)}-${safePathSegment(design.title, "diagram")}-${nanoid(6)}`;
    const mermaid = buildMermaidDiagram(design, request.input);
    const svgAsset = await this.writeWorkspaceAsset(workspace, `${basePath}/diagram.svg`, Buffer.from(rendered.svg, "utf8"), {
      mimeType: "image/svg+xml",
      kind: "image",
      summary: `${design.title} SVG 图表`,
      source: "diagram_draw"
    });
    const pngAsset = await this.writeWorkspaceAsset(workspace, `${basePath}/diagram.png`, rendered.png, {
      mimeType: "image/png",
      kind: "image",
      summary: `${design.title} PNG 预览图`,
      source: "diagram_draw"
    });
    const sourceAsset = await this.writeWorkspaceAsset(workspace, `${basePath}/diagram.md`, Buffer.from(mermaid, "utf8"), {
      mimeType: "text/markdown",
      kind: "doc",
      summary: `${design.title} Mermaid 源文档`,
      source: "diagram_draw"
    });
    return {
      title: design.title,
      summary: design.summary,
      assets: [svgAsset, pngAsset, sourceAsset]
    };
  }

  private async executeMcpFetchMarkdown(conversationId: string, request: RuntimeToolRequest) {
    const workspace = await this.resolveWorkspace(conversationId);
    const url = await assertPublicHttpsUrl(stringInput(request.input, "url"));
    const headersInput = asRecord(request.input?.headers) ?? {};
    const headers = sanitizeApiHeaders(headersInput);
    const startedAt = Date.now();
    const response = await fetch(url, {
      method: "GET",
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(12_000)
    });
    const contentType = response.headers.get("content-type") ?? "";
    const rawText = await response.text();
    if (Buffer.byteLength(rawText, "utf8") > MAX_API_FETCH_BYTES) throw new Error("fetched content exceeds size limit");
    const explicitTitle = stringInput(request.input, "title", false);
    const title = explicitTitle || extractHtmlTitle(rawText) || new URL(url).hostname;
    const markdownBody = htmlToReadableMarkdown(rawText, contentType);
    const outputPath = normalizeFetchMarkdownOutputPath(request.input, title);
    const content = [
      `# ${title}`,
      "",
      `Source: ${url}`,
      `Fetched at: ${new Date().toISOString()}`,
      `Status: ${response.status}`,
      `Content-Type: ${contentType || "unknown"}`,
      "",
      "## Content",
      "",
      markdownBody
    ].join("\n");
    const asset = await this.writeWorkspaceAsset(workspace, outputPath, Buffer.from(content, "utf8"), {
      mimeType: "text/markdown",
      kind: "doc",
      summary: `Fetch Markdown: ${title}`,
      source: "mcp_fetch_markdown"
    });
    return {
      url,
      status: response.status,
      ok: response.ok,
      contentType,
      title,
      elapsedMs: Date.now() - startedAt,
      asset
    };
  }

  private async executeMcpGitInspect(conversationId: string, request: RuntimeToolRequest, caller: RuntimeToolCaller) {
    const workspace = await this.resolveWorkspace(conversationId);
    assertWorkspacePolicyForPath("read_file", WORKSPACE_CODE_DIR, caller.workspacePolicy);
    const codeRoot = resolveWorkspacePath(workspace.rootPath, WORKSPACE_CODE_DIR, this.config.workspacesRoot);
    const codeStat = await stat(codeRoot).catch(() => null);
    if (!codeStat?.isDirectory()) {
      return { repoPresent: false, reason: "Code/ directory does not exist" };
    }
    const gitDir = await stat(join(codeRoot, ".git")).catch(() => null);
    if (!gitDir) {
      return { repoPresent: false, codePath: WORKSPACE_CODE_DIR, reason: "Code/ is not a Git repository" };
    }
    const includeDiff = request.input?.includeDiff !== false;
    const [root, branch, status, diffStat, diffFiles, recentCommits] = await Promise.all([
      runGit(codeRoot, ["rev-parse", "--show-toplevel"]),
      runGit(codeRoot, ["branch", "--show-current"]),
      runGit(codeRoot, ["status", "--short"]),
      includeDiff ? runGit(codeRoot, ["diff", "--stat"]) : Promise.resolve(""),
      includeDiff ? runGit(codeRoot, ["diff", "--name-only"]) : Promise.resolve(""),
      runGit(codeRoot, ["log", "-5", "--oneline"])
    ]);
    return {
      repoPresent: true,
      codePath: WORKSPACE_CODE_DIR,
      root,
      branch: branch || "detached",
      statusLines: splitGitLines(status),
      diffStat: diffStat || "",
      diffFiles: splitGitLines(diffFiles),
      recentCommits: splitGitLines(recentCommits)
    };
  }

  private async executeMcpWorkspaceSnapshot(conversationId: string, request: RuntimeToolRequest, caller: RuntimeToolCaller) {
    const workspace = await this.resolveWorkspace(conversationId);
    if (caller.workspacePolicy && (!caller.workspacePolicy.docWrite || !caller.workspacePolicy.assetCreate)) {
      throw new Error("mcp_workspace_snapshot requires Doc/ write and asset create permission");
    }
    const title = stringInput(request.input, "title", false) || "Workspace Snapshot";
    const depth = numberInput(request.input, "depth", 2, { min: 0, max: 5 });
    const maxFiles = numberInput(request.input, "maxFiles", 300, { min: 1, max: 800 });
    const sections: Array<{ name: string; path: string; files: ListedFile[]; truncated: boolean; skipped?: string }> = [];
    for (const area of [WORKSPACE_DOCS_DIR, WORKSPACE_CODE_DIR]) {
      const policyToolId = area === WORKSPACE_DOCS_DIR ? "list_files" : "read_file";
      try {
        assertWorkspacePolicyForPath(policyToolId, area, caller.workspacePolicy);
      } catch (error) {
        sections.push({ name: area, path: area, files: [], truncated: false, skipped: runtimeErrorMessage(error) });
        continue;
      }
      const absolutePath = resolveWorkspacePath(workspace.rootPath, area, this.config.workspacesRoot);
      const areaStat = await stat(absolutePath).catch(() => null);
      if (!areaStat?.isDirectory()) {
        sections.push({ name: area, path: area, files: [], truncated: false, skipped: `${area}/ directory does not exist` });
        continue;
      }
      const listed = await listFiles(workspace.rootPath, absolutePath, depth, maxFiles);
      sections.push({ name: area, path: area, files: listed.files, truncated: listed.truncated });
    }
    const markdown = buildWorkspaceSnapshotMarkdown(title, sections, { depth, maxFiles });
    const basePath = `Doc/reports/${new Date().toISOString().slice(0, 10)}-${safePathSegment(title, "workspace-snapshot")}-${nanoid(6)}.md`;
    const asset = await this.writeWorkspaceAsset(workspace, basePath, Buffer.from(markdown, "utf8"), {
      mimeType: "text/markdown",
      kind: "doc",
      summary: `${title}：Doc/ 与 Code/ 文件结构快照`,
      source: "mcp_workspace_snapshot"
    });
    return {
      title,
      depth,
      maxFiles,
      sections: sections.map((section) => ({
        name: section.name,
        count: section.files.length,
        truncated: section.truncated,
        ...(section.skipped ? { skipped: section.skipped } : {})
      })),
      asset
    };
  }

  private async writeWorkspaceTextAsset(
    workspace: Awaited<ReturnType<ToolRuntimeService["resolveWorkspace"]>>,
    requestedPath: string,
    content: string,
    summary: string,
    sourceToolId: string
  ) {
    assertWritableRelativePath(requestedPath);
    const contentBytes = Buffer.byteLength(content, "utf8");
    if (contentBytes > MAX_RUNTIME_WRITE_BYTES) throw new Error(`file content exceeds ${MAX_RUNTIME_WRITE_BYTES} bytes`);
    return this.writeWorkspaceAsset(workspace, requestedPath, Buffer.from(content, "utf8"), {
      mimeType: inferMimeType(requestedPath),
      kind: inferAssetKind(requestedPath),
      summary: summary || summarizeText(content),
      source: sourceToolId
    });
  }

  private async writeWorkspaceAsset(
    workspace: Awaited<ReturnType<ToolRuntimeService["resolveWorkspace"]>>,
    requestedPath: string,
    content: Buffer,
    metadata: {
      mimeType: string;
      kind: WorkspaceAssetKind;
      summary: string;
      source: string;
    }
  ) {
    const absolutePath = resolveWorkspacePath(workspace.rootPath, requestedPath, this.config.workspacesRoot);
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content);
    const fileStat = await stat(absolutePath);
    const relativePath = normalizeRelativePath(workspace.rootPath, absolutePath);
    const checksumSha256 = sha256Buffer(content);
    const existing = await this.prisma.workspaceAsset.findFirst({
      where: { workspaceId: workspace.id, path: relativePath, deletedAt: null }
    });
    const existingMetadata = asRecord(existing?.metadata) ?? {};
    const assetData = {
      kind: metadata.kind,
      name: basename(relativePath),
      path: relativePath,
      mimeType: metadata.mimeType,
      size: fileStat.size,
      summary: metadata.summary,
      metadata: {
        ...existingMetadata,
        storage: "local",
        checksumSha256,
        etag: `"sha256-${checksumSha256}"`,
        source: metadata.source
      } as Prisma.InputJsonValue
    };
    const asset = existing
      ? await this.prisma.workspaceAsset.update({ where: { id: existing.id }, data: assetData })
      : await this.prisma.workspaceAsset.create({
          data: {
            id: `asset-${nanoid(10)}`,
            workspaceId: workspace.id,
            ...assetData
          }
        });
    const version = await this.createAssetVersionSnapshot({
      workspaceRoot: workspace.rootPath,
      assetId: asset.id,
      sourceRelativePath: relativePath,
      size: fileStat.size,
      checksumSha256,
      sourceToolId: metadata.source
    });
    return {
      assetId: asset.id,
      id: asset.id,
      workspaceId: workspace.id,
      kind: asset.kind,
      path: asset.path,
      name: asset.name,
      mimeType: asset.mimeType ?? metadata.mimeType,
      size: asset.size ?? fileStat.size,
      summary: asset.summary ?? metadata.summary,
      version,
      contentBytes: content.byteLength
    };
  }

  private async createAssetVersionSnapshot(input: {
    workspaceRoot: string;
    assetId: string;
    sourceRelativePath: string;
    size: number;
    checksumSha256: string;
    sourceToolId: string;
  }) {
    const latest = await this.prisma.workspaceAssetVersion.findFirst({
      where: { assetId: input.assetId },
      orderBy: { version: "desc" }
    });
    const version = (latest?.version ?? 0) + 1;
    const sourcePath = resolveWorkspacePath(input.workspaceRoot, input.sourceRelativePath, this.config.workspacesRoot);
    const snapshotPath = `.versions/${input.assetId}/v${version}-${basename(input.sourceRelativePath)}`;
    const absoluteSnapshotPath = resolveWorkspacePath(input.workspaceRoot, snapshotPath, this.config.workspacesRoot);
    await mkdir(dirname(absoluteSnapshotPath), { recursive: true });
    await copyFile(sourcePath, absoluteSnapshotPath);
    await this.prisma.workspaceAssetVersion.create({
      data: {
        id: `asset-version-${nanoid(10)}`,
        assetId: input.assetId,
        version,
        path: snapshotPath,
        size: input.size,
        checksumSha256: input.checksumSha256,
        createdByUserId: "agent-runtime",
        metadata: { source: input.sourceToolId } as Prisma.InputJsonValue
      }
    });
    const asset = await this.prisma.workspaceAsset.findUnique({ where: { id: input.assetId }, select: { metadata: true } });
    await this.prisma.workspaceAsset.update({
      where: { id: input.assetId },
      data: {
        metadata: {
          ...(asRecord(asset?.metadata) ?? {}),
          storage: "local",
          checksumSha256: input.checksumSha256,
          etag: `"sha256-${input.checksumSha256}"`,
          latestVersion: version,
          source: input.sourceToolId
        } as Prisma.InputJsonValue
      }
    });
    return version;
  }

  private async resolveWorkspace(conversationId: string) {
    const conversation = await this.prisma.conversation.findFirst({
      where: { id: conversationId, deletedAt: null },
      include: { workspace: true }
    });
    if (!conversation?.workspace) throw new Error("conversation has no workspace");
    return conversation.workspace;
  }
}

interface ListedFile {
  name: string;
  path: string;
  type: "file" | "directory";
  size?: number;
}

async function listFiles(
  rootPath: string,
  currentPath: string,
  depth: number,
  maxFiles: number
): Promise<{ files: ListedFile[]; truncated: boolean }> {
  const files: ListedFile[] = [];
  const queue: Array<{ path: string; depth: number }> = [{ path: currentPath, depth }];
  let truncated = false;

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;
    const entries = await readdir(current.path, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.filter((item) => !item.name.startsWith(".")).sort(compareDirectoryEntry)) {
      if (files.length >= maxFiles) {
        truncated = true;
        break;
      }
      const absolutePath = join(current.path, entry.name);
      const itemStat = await stat(absolutePath).catch(() => null);
      const item: ListedFile = {
        name: entry.name,
        path: normalizeRelativePath(rootPath, absolutePath),
        type: entry.isDirectory() ? "directory" : "file"
      };
      if (itemStat?.isFile()) item.size = itemStat.size;
      files.push(item);
      if (entry.isDirectory() && current.depth > 0) queue.push({ path: absolutePath, depth: current.depth - 1 });
    }
    if (truncated) break;
  }
  return { files, truncated };
}

function resolveWorkspacePath(rootPath: string, filePath: string, baseRoot: string) {
  if (isAbsolute(filePath)) throw new Error("workspace file path must be relative");
  const root = resolve(rootPath);
  if (!isInsideAnyWorkspaceRoot(baseRoot, root)) throw new Error(`path outside workspace: ${root}`);
  const absolutePath = resolve(root, filePath);
  assertInside(root, absolutePath);
  return absolutePath;
}

function assertInside(basePath: string, targetPath: string) {
  const pathFromBase = relative(resolve(basePath), resolve(targetPath));
  if (pathFromBase.startsWith("..") || isAbsolute(pathFromBase)) throw new Error(`path outside workspace: ${targetPath}`);
}

function normalizeRelativePath(rootPath: string, absolutePath: string) {
  return relative(resolve(rootPath), resolve(absolutePath)).replaceAll("\\", "/") || basename(absolutePath);
}

function stringInput(input: Record<string, unknown> | undefined, key: string, required = true) {
  const value = input?.[key];
  if (typeof value === "string" && value.trim()) return value.trim();
  if (required) throw new Error(`missing tool input: ${key}`);
  return "";
}

function numberInput(
  input: Record<string, unknown> | undefined,
  key: string,
  defaultValue: number,
  range: { min: number; max: number }
) {
  const value = input?.[key];
  const numeric = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : defaultValue;
  if (!Number.isFinite(numeric)) throw new Error(`invalid numeric tool input: ${key}`);
  return Math.min(range.max, Math.max(range.min, Math.trunc(numeric)));
}

function compareDirectoryEntry(left: Dirent, right: Dirent) {
  if (left.isDirectory() !== right.isDirectory()) return left.isDirectory() ? -1 : 1;
  return left.name.localeCompare(right.name);
}

function normalizeDirectoryPath(rootPath: string, absolutePath: string) {
  const normalized = relative(resolve(rootPath), resolve(absolutePath)).replaceAll("\\", "/");
  return normalized || ".";
}

function assertWritableRelativePath(filePath: string) {
  if (isAbsolute(filePath)) throw new Error("workspace file path must be relative");
  const normalized = filePath.replaceAll("\\", "/").trim();
  if (!normalized || normalized === ".") throw new Error("workspace file path is required");
  const segments = normalized.split("/").filter(Boolean);
  if (segments.some((segment) => segment === "..")) throw new Error("workspace file path cannot contain ..");
  if (segments.some((segment) => BLOCKED_WRITE_SEGMENTS.has(segment))) throw new Error("workspace file path targets a protected directory");
  if (segments.some((segment) => segment.startsWith(".") && segment !== ".well-known")) throw new Error("workspace file path cannot target hidden directories");
  const extension = extname(normalized).toLowerCase();
  if (!RUNTIME_TEXT_EXTENSIONS.has(extension)) throw new Error(`write_file only supports text files: ${[...RUNTIME_TEXT_EXTENSIONS].join(", ")}`);
}

function normalizeWritableToolPath(requestedPath: string, caller: RuntimeToolCaller) {
  if (caller.callerType !== "agent") return requestedPath;
  return normalizeAgentDocumentPath(requestedPath);
}

function normalizeGeneratedAssetPath(requestedPath: string, caller: RuntimeToolCaller) {
  if (caller.callerType !== "agent") return requestedPath;
  return normalizeAgentDocumentPath(requestedPath);
}

function assertWorkspacePolicyForPath(toolId: string, filePath: string, policy: RuntimeWorkspacePolicy | undefined) {
  if (!policy) return;
  const area = classifyWorkspaceArea(filePath);
  if (toolId === "list_files" || toolId === "read_file" || toolId === "search_files" || toolId === "read_asset") {
    if (area === "doc" && !policy.docRead) throw new Error(`${toolId} is not allowed to read Doc/`);
    if (area === "code" && !policy.codeRead) throw new Error(`${toolId} is not allowed to read Code/`);
    if (area === "root" && (!policy.docRead || !policy.codeRead)) {
      throw new Error(`${toolId} at workspace root requires both Doc and Code read permission; query Doc/ or Code/ explicitly`);
    }
    if (area === "other") throw new Error(`${toolId} can only access Doc/ or Code/ paths`);
  }
  if (toolId === "write_file" || toolId === "create_asset") {
    if (area === "doc" && !policy.docWrite) throw new Error(`${toolId} is not allowed to write Doc/`);
    if (area === "code" && !policy.codeWrite) throw new Error(`${toolId} is not allowed to write Code/`);
    if (area === "root") throw new Error(`${toolId} must target Doc/ or Code/`);
    if (area === "other") throw new Error(`${toolId} can only write Doc/ or Code/ paths`);
    if (toolId === "create_asset" && !policy.assetCreate) throw new Error("create_asset is not allowed by assetCreate=false");
  }
}

function classifyWorkspaceArea(filePath: string): "doc" | "code" | "root" | "other" {
  const normalized = filePath.replaceAll("\\", "/").replace(/^\.\/+/, "").trim();
  if (!normalized || normalized === ".") return "root";
  const first = normalized.split("/").filter(Boolean)[0]?.toLowerCase();
  if (first === WORKSPACE_DOCS_DIR.toLowerCase() || first === "docs") return "doc";
  if (first === WORKSPACE_CODE_DIR.toLowerCase()) return "code";
  return "other";
}

function parseQueuedApprovalInput(value: unknown) {
  const rawInput = asRecord(value);
  const approval = asRecord(rawInput?.approval);
  const requestRecord = asRecord(rawInput?.request);
  const conversationId = stringish(approval?.conversationId);
  const toolId = stringish(requestRecord?.toolId);
  if (!rawInput || !approval || !requestRecord || !conversationId || !toolId) throw new Error("queued approval input is invalid");
  const workspacePolicy = parseWorkspacePolicy(rawInput.workspacePolicy);
  const request: RuntimeToolRequest = {
    toolId,
    input: asRecord(requestRecord.input) ?? {},
    ...(stringish(requestRecord.reason) ? { reason: stringish(requestRecord.reason) } : {})
  };
  return {
    rawInput,
    approval,
    conversationId,
    request,
    workspacePolicy
  };
}

function parseWorkspacePolicy(value: unknown): RuntimeWorkspacePolicy | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  return {
    docRead: record.docRead === true,
    docWrite: record.docWrite === true,
    codeRead: record.codeRead === true,
    codeWrite: record.codeWrite === true,
    assetCreate: record.assetCreate === true
  };
}

function stringish(value: unknown) {
  if (typeof value !== "string") return "";
  return value.trim();
}

function assertGeneratedAssetRelativePath(filePath: string) {
  if (isAbsolute(filePath)) throw new Error("generated asset path must be relative");
  const normalized = filePath.replaceAll("\\", "/").trim();
  if (!normalized || normalized === ".") throw new Error("generated asset path is required");
  const segments = normalized.split("/").filter(Boolean);
  if (segments.some((segment) => segment === "..")) throw new Error("generated asset path cannot contain ..");
  if (segments.some((segment) => BLOCKED_WRITE_SEGMENTS.has(segment))) throw new Error("generated asset path targets a protected directory");
  if (segments.some((segment) => segment.startsWith(".") && segment !== ".well-known")) throw new Error("generated asset path cannot target hidden directories");
  const extension = extname(normalized).toLowerCase();
  const allowed = new Set([...RUNTIME_TEXT_EXTENSIONS, ".png", ".svg", ".excalidraw"]);
  if (!allowed.has(extension)) throw new Error(`generated asset extension is not allowed: ${extension || "(none)"}`);
}

function inferAssetKind(filePath: string): WorkspaceAssetKind {
  const extension = extname(filePath).toLowerCase();
  if (extension === ".md" || extension === ".markdown" || extension === ".txt") return "doc";
  if (extension === ".png" || extension === ".svg") return "image";
  if (extension === ".json" && basename(filePath).toLowerCase().includes("report")) return "log";
  return "file";
}

function inferMimeType(filePath: string) {
  const extension = extname(filePath).toLowerCase();
  const table: Record<string, string> = {
    ".md": "text/markdown",
    ".markdown": "text/markdown",
    ".txt": "text/plain",
    ".json": "application/json",
    ".yaml": "application/yaml",
    ".yml": "application/yaml",
    ".csv": "text/csv",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".excalidraw": "application/vnd.excalidraw+json"
  };
  return table[extension] ?? "text/plain";
}

function summarizeText(content: string) {
  return content.replace(/\s+/g, " ").trim().slice(0, 240);
}

function summarizeGeneratedAsset(filePath: string, content: Buffer) {
  const mimeType = inferMimeType(filePath);
  if (mimeType.startsWith("text/") || mimeType === "application/json" || mimeType.includes("excalidraw")) {
    return summarizeText(content.toString("utf8"));
  }
  return `${basename(filePath)} (${content.byteLength} bytes)`;
}

function sha256Buffer(content: Buffer) {
  return createHash("sha256").update(content).digest("hex");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function clampNumber(value: unknown, fallback: number, min: number, max: number) {
  const numeric = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : fallback;
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(numeric)));
}

function runtimeErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  const record = asRecord(error);
  if (record) {
    const message = stringish(record.message) ?? stringish(record.error) ?? stringish(record.name);
    if (message) return message;
    try {
      return JSON.stringify(record);
    } catch {
      return String(error);
    }
  }
  return String(error);
}

async function assertPublicHttpsUrl(rawUrl: string) {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("invalid api url");
  }
  if (url.protocol !== "https:") throw new Error("api_fetch_json only supports https URLs");
  if (url.username || url.password) throw new Error("api url must not contain credentials");
  if (!url.hostname || ["localhost", "localhost.localdomain"].includes(url.hostname.toLowerCase())) {
    throw new Error("api url host is not allowed");
  }
  const addresses = await lookup(url.hostname, { all: true, verbatim: false });
  if (addresses.length === 0) throw new Error("api url host cannot be resolved");
  for (const address of addresses) {
    if (isPrivateOrLocalAddress(address.address)) {
      throw new Error("api url resolves to a private or local address");
    }
  }
  return url.toString();
}

function isPrivateOrLocalAddress(address: string) {
  const ipVersion = isIP(address);
  if (ipVersion === 4) {
    const parts = address.split(".").map((item) => Number(item));
    const a = parts[0] ?? -1;
    const b = parts[1] ?? -1;
    if (a === 10 || a === 127 || a === 0 || a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }
  if (ipVersion === 6) {
    const normalized = address.toLowerCase();
    return normalized === "::1"
      || normalized === "::"
      || normalized.startsWith("fc")
      || normalized.startsWith("fd")
      || normalized.startsWith("fe80:");
  }
  return true;
}

function sanitizeApiHeaders(headers: Record<string, unknown>) {
  const result: Record<string, string> = {};
  const blocked = new Set(["host", "cookie", "authorization", "proxy-authorization", "connection", "content-length"]);
  for (const [key, value] of Object.entries(headers)) {
    const normalizedKey = key.trim().toLowerCase();
    if (!normalizedKey || blocked.has(normalizedKey)) continue;
    if (!/^[a-z0-9-]+$/.test(normalizedKey)) continue;
    if (typeof value !== "string") continue;
    result[normalizedKey] = value.slice(0, 500);
  }
  return result;
}

function looksLikeJson(value: string) {
  const trimmed = value.trim();
  return trimmed.startsWith("{") || trimmed.startsWith("[");
}

function parseJsonOrNull(value: string) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function parseBingJinaSearchResults(markdown: string, maxResults: number) {
  const results: Array<{ rank: number; title: string; url: string; domain: string; snippet: string }> = [];
  let current: { title: string; url: string; snippetLines: string[] } | null = null;
  const flush = () => {
    if (!current || results.length >= maxResults) return;
    const url = decodeBingResultUrl(current.url);
    if (!url || isIgnoredSearchResultUrl(url)) {
      current = null;
      return;
    }
    const title = cleanSearchText(current.title);
    if (!title) {
      current = null;
      return;
    }
    results.push({
      rank: results.length + 1,
      title,
      url,
      domain: safeHostname(url),
      snippet: cleanSearchSnippet(current.snippetLines.join(" "))
    });
    current = null;
  };
  for (const rawLine of markdown.split("\n")) {
    const line = rawLine.trim();
    const match = /^(?:\d+\.\s+)?##\s+\[([^\]]+)\]\((https?:\/\/[^)]+)\)/i.exec(line);
    if (match) {
      flush();
      current = { title: match[1] ?? "", url: match[2] ?? "", snippetLines: [] };
      continue;
    }
    if (!current) continue;
    if (/^(?:\d+\.\s+)?##\s+/i.test(line) || /^Title:|^URL Source:|^About \d/i.test(line)) {
      flush();
      continue;
    }
    if (!line || line.startsWith("![") || /^Sponsored\b/i.test(line)) continue;
    if (/^https?:\/\//i.test(line)) continue;
    current.snippetLines.push(line);
  }
  flush();
  return results.slice(0, maxResults);
}

function filterRelevantSearchResults<T extends { title: string; url: string; domain: string; snippet: string }>(results: T[], query: string) {
  const terms = searchQueryTerms(query);
  if (terms.length === 0) return results;
  const minMatches = terms.length <= 2 ? 1 : 2;
  return results.filter((result) => {
    const haystack = `${result.title} ${result.snippet} ${result.domain} ${result.url}`.toLowerCase();
    let matches = 0;
    for (const term of terms) {
      if (haystack.includes(term)) matches += 1;
      if (matches >= minMatches) return true;
    }
    return false;
  });
}

function searchQueryTerms(query: string) {
  const stopwords = new Set([
    "about",
    "after",
    "also",
    "and",
    "are",
    "for",
    "from",
    "how",
    "into",
    "the",
    "this",
    "with",
    "what",
    "when",
    "where",
    "which",
    "who",
    "why",
    "请",
    "搜索",
    "使用",
    "工具"
  ]);
  return Array.from(new Set(query
    .toLowerCase()
    .replace(/["'`]/g, " ")
    .split(/[^\p{L}\p{N}]+/u)
    .map((term) => term.trim())
    .filter((term) => term.length >= 2 && !stopwords.has(term))
  )).slice(0, 12);
}

function decodeBingResultUrl(rawUrl: string) {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase();
    if (!host.endsWith("bing.com")) return rawUrl;
    const encoded = url.searchParams.get("u");
    if (!encoded) return rawUrl;
    const normalized = encoded.startsWith("a1") ? encoded.slice(2) : encoded;
    const decoded = Buffer.from(normalized.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    if (!/^https?:\/\//i.test(decoded)) return rawUrl;
    return decoded;
  } catch {
    return rawUrl;
  }
}

function isIgnoredSearchResultUrl(rawUrl: string) {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase();
    return host.endsWith("bing.com") && (url.pathname.startsWith("/aclk") || url.pathname.startsWith("/ck/a"));
  } catch {
    return true;
  }
}

function safeHostname(rawUrl: string) {
  try {
    return new URL(rawUrl).hostname.replace(/^www\./i, "");
  } catch {
    return "";
  }
}

function cleanSearchText(value: string) {
  return decodeHtmlEntities(stripHtmlTags(value))
    .replace(/\*\*/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

function cleanSearchSnippet(value: string) {
  return cleanSearchText(value.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")).slice(0, 600);
}

async function runGit(cwd: string, args: string[]) {
  try {
    const { stdout } = await execFile("git", ["-C", cwd, ...args], {
      timeout: 8_000,
      maxBuffer: 200_000
    });
    return stdout.trim();
  } catch (error) {
    return `ERROR: ${runtimeErrorMessage(error)}`;
  }
}

function splitGitLines(value: string) {
  if (!value || value.startsWith("ERROR:")) return value ? [value] : [];
  return value.split("\n").map((line) => line.trimEnd()).filter(Boolean).slice(0, 80);
}

function normalizeFetchMarkdownOutputPath(input: Record<string, unknown> | undefined, title: string) {
  const requestedPath = stringInput(input, "path", false);
  const path = requestedPath || `Doc/research/${new Date().toISOString().slice(0, 10)}-${safePathSegment(title, "fetch")}-${nanoid(6)}.md`;
  assertWritableRelativePath(path);
  if (classifyWorkspaceArea(path) !== "doc") throw new Error("mcp_fetch_markdown output path must be under Doc/");
  return path;
}

function extractHtmlTitle(content: string) {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(content);
  return match ? decodeHtmlEntities(stripHtmlTags(match[1] ?? "")).trim().slice(0, 120) : "";
}

function htmlToReadableMarkdown(content: string, contentType: string) {
  const isHtml = contentType.toLowerCase().includes("html") || /<html[\s>]/i.test(content);
  if (!isHtml) return content.trim().slice(0, 60_000);
  let value = content
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[\s\S]*?<\/nav>/gi, "")
    .replace(/<footer[\s\S]*?<\/footer>/gi, "")
    .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, "\n# $1\n")
    .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, "\n## $1\n")
    .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, "\n### $1\n")
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, "\n- $1")
    .replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, "\n$1\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(div|section|article|main|header)>/gi, "\n");
  value = stripHtmlTags(value);
  value = decodeHtmlEntities(value);
  return value
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, 60_000);
}

function stripHtmlTags(value: string) {
  return value.replace(/<[^>]+>/g, " ");
}

function decodeHtmlEntities(value: string) {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'");
}

function buildWorkspaceSnapshotMarkdown(
  title: string,
  sections: Array<{ name: string; path: string; files: ListedFile[]; truncated: boolean; skipped?: string }>,
  options: { depth: number; maxFiles: number }
) {
  const lines = [
    `# ${title}`,
    "",
    `Generated at: ${new Date().toISOString()}`,
    `Depth: ${options.depth}`,
    `Max files per section: ${options.maxFiles}`,
    ""
  ];
  for (const section of sections) {
    lines.push(`## ${section.name}/`, "");
    if (section.skipped) {
      lines.push(`Skipped: ${section.skipped}`, "");
      continue;
    }
    if (section.files.length === 0) {
      lines.push("No files.", "");
      continue;
    }
    for (const file of section.files) {
      const icon = file.type === "directory" ? "[dir]" : "[file]";
      const size = typeof file.size === "number" ? ` (${file.size} bytes)` : "";
      lines.push(`- ${icon} ${file.path}${size}`);
    }
    if (section.truncated) lines.push("- ... truncated");
    lines.push("");
  }
  return lines.join("\n");
}

function diagramInputToDesign(input: Record<string, unknown> | undefined): UiAgentDesignCandidate {
  const title = stringish(input?.title) || "AgentHub 图表";
  const summary = stringish(input?.summary ?? input?.description) || "由官方 diagram_draw 工具生成。";
  const nodeLabels = normalizeDiagramNodes(input?.nodes);
  const sections = nodeLabels.length > 0 ? nodeLabels : ["输入", "处理", "输出"];
  return {
    id: safePathSegment(title, "diagram"),
    kind: "design",
    title,
    summary,
    targetUsers: [],
    designGoals: ["清晰表达节点关系", "生成可预览图表资产"],
    screens: [{
      name: stringish(input?.type) || "图表",
      purpose: summary,
      layout: "节点关系图",
      sections,
      interactions: normalizeDiagramEdges(input?.edges)
    }],
    visualStyle: {
      tone: "清晰、低干扰、适合技术文档",
      colors: ["#2563eb", "#16a34a", "#f8fafc"],
      typography: "系统字体",
      spacing: "节点间距清晰"
    },
    acceptanceCriteria: ["节点可读", "连线关系明确", "产物可在消息右侧预览"],
    risks: [],
    documentMarkdown: undefined
  };
}

function normalizeDiagramNodes(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const record = asRecord(item);
    const label = stringish(record?.label ?? record?.name ?? record?.id);
    return label ? [label.slice(0, 80)] : [];
  }).slice(0, 12);
}

function normalizeDiagramEdges(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const record = asRecord(item);
    const from = stringish(record?.from);
    const to = stringish(record?.to);
    const label = stringish(record?.label);
    return from && to ? [`${from} -> ${to}${label ? `：${label}` : ""}`] : [];
  }).slice(0, 20);
}

function buildMermaidDiagram(design: UiAgentDesignCandidate, input: Record<string, unknown> | undefined) {
  const nodes = normalizeMermaidNodes(input?.nodes);
  const edges = normalizeMermaidEdges(input?.edges);
  const body = edges.length > 0
    ? edges.map((edge) => `  ${edge.from} -->${edge.label ? `|${escapeMermaid(edge.label)}|` : ""} ${edge.to}`).join("\n")
    : nodes.slice(0, -1).map((node, index) => `  ${node.id} --> ${nodes[index + 1]?.id}`).join("\n");
  const nodeLines = nodes.map((node) => `  ${node.id}[${escapeMermaid(node.label)}]`).join("\n");
  return [
    `# ${design.title}`,
    "",
    design.summary,
    "",
    "```mermaid",
    "flowchart LR",
    nodeLines || "  A[输入] --> B[处理] --> C[输出]",
    body,
    "```"
  ].filter(Boolean).join("\n");
}

function normalizeMermaidNodes(value: unknown) {
  if (!Array.isArray(value)) {
    return [
      { id: "A", label: "输入" },
      { id: "B", label: "处理" },
      { id: "C", label: "输出" }
    ];
  }
  return value.flatMap((item, index) => {
    const record = asRecord(item);
    const id = safeMermaidId(stringish(record?.id) || `N${index + 1}`);
    const label = stringish(record?.label ?? record?.name ?? record?.id) || id;
    return [{ id, label: label.slice(0, 80) }];
  }).slice(0, 20);
}

function normalizeMermaidEdges(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const record = asRecord(item);
    const from = safeMermaidId(stringish(record?.from));
    const to = safeMermaidId(stringish(record?.to));
    const label = stringish(record?.label);
    return from && to ? [{ from, to, label }] : [];
  }).slice(0, 40);
}

function safeMermaidId(value: string) {
  return value.replace(/[^a-zA-Z0-9_]/g, "_").replace(/^(\d)/, "N$1").slice(0, 40);
}

function escapeMermaid(value: string) {
  return value.replaceAll("[", "(").replaceAll("]", ")").replaceAll("|", "/").replaceAll("\n", " ").slice(0, 120);
}

function safePathSegment(value: string, fallback: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || fallback;
}
