import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { AgentHubUser } from "@agenthub/shared";
import { createHash } from "node:crypto";
import { nanoid } from "nanoid";
import { Prisma, type ToolDefinition } from "../../generated/prisma/client.js";
import { PrismaService } from "../../common/prisma.service.js";
import { HubsService } from "../hubs/hubs.service.js";
import { executableRuntimeToolIds, executableRuntimeToolRegistry, publicToolHubToolIds, toolRegistry, type ToolDefinitionView } from "./tool-registry.js";

export type ToolHubScope = "personal" | "public" | undefined;

const INTERNAL_TOOLHUB_CATEGORIES = new Set(["message", "agent", "user"]);
export interface CreatePersonalToolInput {
  name: string;
  description: string;
  runtimeType?: "builtin_alias" | "function";
  runtimeToolId?: (typeof executableRuntimeToolIds)[number] | undefined;
  category?: string | undefined;
  risk?: "read" | "write" | "external" | undefined;
  inputSchema?: Record<string, unknown> | undefined;
  outputSchema?: Record<string, unknown> | undefined;
  permissionScopes?: string[] | undefined;
  availableToAgentTypes?: string[] | undefined;
  functionSource?: string | undefined;
  functionLanguage?: "javascript" | undefined;
  functionTimeoutMs?: number | undefined;
  functionMemoryMb?: number | undefined;
  functionOutputBytes?: number | undefined;
}

@Injectable()
export class ToolsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(HubsService) private readonly hubs: HubsService
  ) {}

  async listTools(currentUser: AgentHubUser, scope?: ToolHubScope) {
    await this.syncBuiltinTools();
    await this.ensurePersonalStarterTools(currentUser);
    const tools = await this.prisma.toolDefinition.findMany({
      where: await this.listWhere(currentUser, scope),
      orderBy: [{ category: "asc" }, { name: "asc" }]
    });
    return this.hubs.applyToolLifecycle(currentUser, tools.map(toolDefinitionToView).filter(isVisibleInToolHub));
  }

  async createPersonalTool(currentUser: AgentHubUser, input: CreatePersonalToolInput) {
    await this.syncBuiltinTools();
    if ((input.runtimeType ?? "builtin_alias") === "function") {
      return this.createFunctionTool(currentUser, input);
    }
    if (!input.runtimeToolId) throw new BadRequestException("runtimeToolId is required");
    const runtimeTool = executableRuntimeToolRegistry.find((tool) => tool.id === input.runtimeToolId);
    if (!runtimeTool) throw new BadRequestException("runtimeToolId is not executable");
    const customTool: ToolDefinitionView = {
      id: await this.nextPersonalToolId(currentUser.id, input.name),
      name: input.name.trim(),
      description: input.description.trim(),
      category: input.category ?? runtimeTool.category,
      risk: input.risk ?? runtimeTool.risk,
      runtimeType: "builtin_alias",
      source: "user",
      visibility: "private",
      ownerType: "user",
      ownerId: currentUser.id,
      runtimeToolId: runtimeTool.id,
      metadata: {
        createdByUserId: currentUser.id,
        runtimeToolName: runtimeTool.name,
        runtimeToolDescription: runtimeTool.description
      },
      executable: true,
      inputSchema: input.inputSchema ?? runtimeTool.inputSchema ?? defaultInputSchema(runtimeTool),
      outputSchema: input.outputSchema ?? runtimeTool.outputSchema ?? defaultOutputSchema(runtimeTool),
      ...(input.permissionScopes ? { permissionScopes: input.permissionScopes } : {}),
      ...(input.availableToAgentTypes ?? runtimeTool.availableToAgentTypes ? { availableToAgentTypes: input.availableToAgentTypes ?? runtimeTool.availableToAgentTypes } : {})
    };
    const definition = completeCustomToolDefinition(customTool);
    const fingerprint = fingerprintToolDefinition(definition);
    const created = await this.prisma.toolDefinition.create({
      data: {
        id: definition.id,
        category: definition.category,
        name: definition.name,
        risk: definition.risk,
        description: definition.description,
        runtimeType: definition.runtimeType,
        source: definition.source,
        visibility: definition.visibility,
        ownerType: definition.ownerType,
        ownerId: definition.ownerId,
        runtimeToolId: definition.runtimeToolId,
        metadata: definition.metadata as Prisma.InputJsonValue,
        executable: definition.executable,
        inputSchema: definition.inputSchema as Prisma.InputJsonValue,
        outputSchema: definition.outputSchema as Prisma.InputJsonValue,
        permissionScopes: definition.permissionScopes as Prisma.InputJsonValue,
        requiresApproval: definition.requiresApproval,
        availableToAgentTypes: definition.availableToAgentTypes as Prisma.InputJsonValue,
        timeoutPolicy: definition.timeoutPolicy,
        auditLevel: definition.auditLevel,
        currentVersion: 1,
        currentFingerprint: fingerprint,
        versions: {
          create: {
            version: 1,
            definition: definition as Prisma.InputJsonValue,
            fingerprint
          }
        }
      }
    });
    return this.hubs.applyToolLifecycle(currentUser, [toolDefinitionToView(created)]).then((tools) => tools[0]);
  }

  async deleteTool(currentUser: AgentHubUser, id: string) {
    const tool = await this.prisma.toolDefinition.findFirst({ where: { id, deletedAt: null } });
    if (!tool) throw new NotFoundException("Tool not found");
    if (tool.ownerType !== "user" || tool.ownerId !== currentUser.id) {
      throw new ForbiddenException("Only the owner can delete this Tool");
    }
    const deletedAt = new Date();
    await this.prisma.$transaction(async (tx) => {
      await tx.toolDefinition.update({
        where: { id },
        data: { deletedAt }
      });
      await tx.hubSubscription.updateMany({
        where: { kind: "tool", assetId: id, deletedAt: null },
        data: { status: "removed", deletedAt, updateAvailable: false, conflictStatus: null }
      });
    });
    return { toolId: id, deletedAt: deletedAt.toISOString() };
  }

  private async createFunctionTool(currentUser: AgentHubUser, input: CreatePersonalToolInput) {
    const source = normalizeFunctionSource(input.functionSource);
    const customTool: ToolDefinitionView = {
      id: await this.nextPersonalToolId(currentUser.id, input.name),
      name: input.name.trim(),
      description: input.description.trim(),
      category: input.category ?? "function",
      risk: "read",
      runtimeType: "function",
      source: "user",
      visibility: "private",
      ownerType: "user",
      ownerId: currentUser.id,
      runtimeToolId: null,
      metadata: {
        createdByUserId: currentUser.id,
        runtime: {
          kind: "function",
          language: input.functionLanguage ?? "javascript",
          source,
          limits: {
            timeoutMs: input.functionTimeoutMs ?? 800,
            memoryMb: input.functionMemoryMb ?? 16,
            outputBytes: input.functionOutputBytes ?? 32_000
          }
        },
        functionSpec: {
          language: input.functionLanguage ?? "javascript",
          signature: "(input: Record<string, unknown>) => JSONValue",
          constraints: [
            "无网络访问",
            "无文件系统访问",
            "无子进程",
            "无环境变量",
            "只允许返回可 JSON 序列化数据"
          ]
        }
      },
      executable: true,
      inputSchema: input.inputSchema ?? { type: "object", additionalProperties: true },
      outputSchema: input.outputSchema ?? { type: "object", additionalProperties: true },
      permissionScopes: input.permissionScopes ?? ["tool:function", "function:execute"],
      requiresApproval: false,
      availableToAgentTypes: input.availableToAgentTypes ?? ["orchestrator", "universal", "product", "ui", "review"],
      timeoutPolicy: "short",
      auditLevel: "full"
    };
    const definition = completeCustomToolDefinition(customTool);
    const fingerprint = fingerprintToolDefinition(definition);
    const created = await this.prisma.toolDefinition.create({
      data: {
        id: definition.id,
        category: definition.category,
        name: definition.name,
        risk: definition.risk,
        description: definition.description,
        runtimeType: definition.runtimeType,
        source: definition.source,
        visibility: definition.visibility,
        ownerType: definition.ownerType,
        ownerId: definition.ownerId,
        runtimeToolId: definition.runtimeToolId,
        metadata: definition.metadata as Prisma.InputJsonValue,
        executable: definition.executable,
        inputSchema: definition.inputSchema as Prisma.InputJsonValue,
        outputSchema: definition.outputSchema as Prisma.InputJsonValue,
        permissionScopes: definition.permissionScopes as Prisma.InputJsonValue,
        requiresApproval: definition.requiresApproval,
        availableToAgentTypes: definition.availableToAgentTypes as Prisma.InputJsonValue,
        timeoutPolicy: definition.timeoutPolicy,
        auditLevel: definition.auditLevel,
        currentVersion: 1,
        currentFingerprint: fingerprint,
        versions: {
          create: {
            version: 1,
            definition: definition as Prisma.InputJsonValue,
            fingerprint
          }
        }
      }
    });
    return this.hubs.applyToolLifecycle(currentUser, [toolDefinitionToView(created)]).then((tools) => tools[0]);
  }

  async syncBuiltinTools() {
    const synced = [];
    for (const tool of toolRegistry) {
      synced.push(await this.syncBuiltinTool(tool));
    }
    return { tools: synced };
  }

  private async syncBuiltinTool(tool: ToolDefinitionView) {
    const definition = completeBuiltinToolDefinition(tool);
    const fingerprint = fingerprintToolDefinition(definition);
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.toolDefinition.findUnique({
        where: { id: definition.id },
        include: { versions: { orderBy: { version: "desc" }, take: 1 } }
      });
      if (!existing) {
        const created = await tx.toolDefinition.create({
          data: {
            id: definition.id,
            category: definition.category,
            name: definition.name,
            risk: definition.risk,
            description: definition.description,
            runtimeType: definition.runtimeType,
            source: definition.source,
            visibility: definition.visibility,
            ownerType: definition.ownerType,
            ownerId: definition.ownerId,
            runtimeToolId: definition.runtimeToolId,
            metadata: definition.metadata as Prisma.InputJsonValue,
            executable: definition.executable,
            inputSchema: definition.inputSchema as Prisma.InputJsonValue,
            outputSchema: definition.outputSchema as Prisma.InputJsonValue,
            permissionScopes: definition.permissionScopes as Prisma.InputJsonValue,
            requiresApproval: definition.requiresApproval,
            availableToAgentTypes: definition.availableToAgentTypes as Prisma.InputJsonValue,
            timeoutPolicy: definition.timeoutPolicy,
            auditLevel: definition.auditLevel,
            currentVersion: 1,
            currentFingerprint: fingerprint,
            versions: {
              create: {
                version: 1,
                definition: definition as Prisma.InputJsonValue,
                fingerprint
              }
            }
          }
        });
        return toolDefinitionToView(created);
      }

      const latestVersion = existing.versions[0]?.version ?? existing.currentVersion;
      const nextVersion = existing.currentFingerprint === fingerprint ? existing.currentVersion : latestVersion + 1;
      if (existing.currentFingerprint !== fingerprint) {
        await tx.toolVersion.create({
          data: {
            toolId: definition.id,
            version: nextVersion,
            definition: definition as Prisma.InputJsonValue,
            fingerprint
          }
        });
      }
      const updated = await tx.toolDefinition.update({
        where: { id: definition.id },
        data: {
          category: definition.category,
          name: definition.name,
          risk: definition.risk,
          description: definition.description,
          runtimeType: definition.runtimeType,
          source: definition.source,
          visibility: definition.visibility,
          ownerType: definition.ownerType,
          ownerId: definition.ownerId,
          runtimeToolId: definition.runtimeToolId,
          metadata: definition.metadata as Prisma.InputJsonValue,
          executable: definition.executable,
          inputSchema: definition.inputSchema as Prisma.InputJsonValue,
          outputSchema: definition.outputSchema as Prisma.InputJsonValue,
          permissionScopes: definition.permissionScopes as Prisma.InputJsonValue,
          requiresApproval: definition.requiresApproval,
          availableToAgentTypes: definition.availableToAgentTypes as Prisma.InputJsonValue,
          timeoutPolicy: definition.timeoutPolicy,
          auditLevel: definition.auditLevel,
          currentVersion: nextVersion,
          currentFingerprint: fingerprint,
          deletedAt: null
        }
      });
      return toolDefinitionToView(updated);
    });
  }

  private async listWhere(currentUser: AgentHubUser, scope: ToolHubScope): Promise<Prisma.ToolDefinitionWhereInput> {
    const base: Prisma.ToolDefinitionWhereInput = { deletedAt: null };
    const subscribedToolIds = await this.subscribedToolIds(currentUser);
    const ownOrSubscribed: Prisma.ToolDefinitionWhereInput[] = [
      { ownerType: "user", ownerId: currentUser.id },
      ...(subscribedToolIds.length > 0 ? [{ id: { in: subscribedToolIds } }] : [])
    ];
    if (scope === "public") {
      return {
        ...base,
        visibility: "public"
      };
    }
    if (scope === "personal") {
      return {
        ...base,
        OR: ownOrSubscribed
      };
    }
    return {
      ...base,
      OR: [
        { visibility: "public" },
        ...ownOrSubscribed
      ]
    };
  }

  private async ensurePersonalStarterTools(currentUser: AgentHubUser) {
    const starters = personalStarterTools(currentUser);
    for (const tool of starters) {
      const definition = completeCustomToolDefinition(tool);
      const fingerprint = fingerprintToolDefinition(definition);
      await this.prisma.toolDefinition.upsert({
        where: { id: definition.id },
        create: {
          id: definition.id,
          category: definition.category,
          name: definition.name,
          risk: definition.risk,
          description: definition.description,
          runtimeType: definition.runtimeType,
          source: definition.source,
          visibility: definition.visibility,
          ownerType: definition.ownerType,
          ownerId: definition.ownerId,
          runtimeToolId: definition.runtimeToolId,
          metadata: definition.metadata as Prisma.InputJsonValue,
          executable: definition.executable,
          inputSchema: definition.inputSchema as Prisma.InputJsonValue,
          outputSchema: definition.outputSchema as Prisma.InputJsonValue,
          permissionScopes: definition.permissionScopes as Prisma.InputJsonValue,
          requiresApproval: definition.requiresApproval,
          availableToAgentTypes: definition.availableToAgentTypes as Prisma.InputJsonValue,
          timeoutPolicy: definition.timeoutPolicy,
          auditLevel: definition.auditLevel,
          currentVersion: 1,
          currentFingerprint: fingerprint,
          versions: {
            create: {
              version: 1,
              definition: definition as Prisma.InputJsonValue,
              fingerprint
            }
          }
        },
        update: {
          deletedAt: null
        }
      });
    }
  }

  private async subscribedToolIds(currentUser: AgentHubUser) {
    const subscriptions = await this.prisma.hubSubscription.findMany({
      where: {
        kind: "tool",
        ownerType: "user",
        ownerId: currentUser.id,
        status: { in: ["active", "forked"] },
        deletedAt: null
      },
      select: { assetId: true }
    });
    return subscriptions.map((subscription) => subscription.assetId);
  }

  private async nextPersonalToolId(userId: string, name: string) {
    const slug = toAsciiSlug(name) || "tool";
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const id = `tool-user-${userId}-${slug}-${nanoid(6).toLowerCase()}`;
      const existing = await this.prisma.toolDefinition.findUnique({ where: { id } });
      if (!existing) return id;
    }
    return `tool-user-${userId}-${nanoid(10).toLowerCase()}`;
  }
}

export function completeBuiltinToolDefinition(tool: ToolDefinitionView) {
  const risk = tool.risk;
  const category = tool.category;
  const permissionScopes = Array.from(new Set([
    `tool:${tool.id}`,
    `tool:${category}:${risk}`,
    ...(tool.runtimeToolId ? [`tool:${tool.runtimeToolId}`] : []),
    ...normalizeStringList(tool.permissionScopes),
    ...defaultPermissionScopes(tool)
  ]));
  return {
    id: tool.id,
    category,
    name: tool.name,
    risk,
    description: tool.description,
    runtimeType: tool.runtimeType ?? "builtin",
    source: tool.source ?? "builtin",
    visibility: tool.visibility ?? "public",
    ownerType: tool.ownerType ?? "system",
    ownerId: tool.ownerId ?? null,
    runtimeToolId: tool.runtimeToolId ?? ((executableRuntimeToolIds as readonly string[]).includes(tool.id) ? tool.id : null),
    metadata: tool.metadata ?? {},
    executable: tool.executable ?? (executableRuntimeToolIds as readonly string[]).includes(tool.id),
    inputSchema: tool.inputSchema ?? defaultInputSchema(tool),
    outputSchema: tool.outputSchema ?? defaultOutputSchema(tool),
    permissionScopes,
    requiresApproval: tool.requiresApproval ?? risk === "dangerous",
    availableToAgentTypes: tool.availableToAgentTypes ?? defaultAgentTypes(tool),
    timeoutPolicy: tool.timeoutPolicy ?? defaultTimeoutPolicy(tool),
    auditLevel: tool.auditLevel ?? (risk === "read" ? "basic" : "full"),
    sourceVersion: tool.sourceVersion ?? 1
  };
}

function completeCustomToolDefinition(tool: ToolDefinitionView) {
  const normalized = completeBuiltinToolDefinition(tool);
  return {
    ...normalized,
    source: tool.source ?? "user",
    visibility: tool.visibility ?? "private",
    ownerType: tool.ownerType ?? "user",
    ownerId: tool.ownerId ?? null,
    runtimeToolId: tool.runtimeToolId ?? null,
    metadata: tool.metadata ?? {},
    runtimeType: tool.runtimeType ?? "builtin_alias",
    executable: tool.executable ?? Boolean(tool.runtimeToolId || tool.runtimeType === "function")
  };
}

export function fingerprintToolDefinition(definition: ReturnType<typeof completeBuiltinToolDefinition>) {
  return createHash("sha256").update(stableJson(definition)).digest("hex");
}

export function toolDefinitionToView(tool: ToolDefinition): ToolDefinitionView {
  return {
    id: tool.id,
    category: tool.category,
    name: tool.name,
    risk: normalizeRisk(tool.risk),
    description: tool.description,
    runtimeType: tool.runtimeType,
    source: tool.source,
    visibility: tool.visibility,
    ownerType: tool.ownerType,
    ownerId: tool.ownerId,
    runtimeToolId: tool.runtimeToolId,
    metadata: asRecord(tool.metadata) ?? {},
    executable: tool.executable,
    inputSchema: asRecord(tool.inputSchema) ?? {},
    outputSchema: asRecord(tool.outputSchema) ?? {},
    permissionScopes: normalizeStringList(tool.permissionScopes),
    requiresApproval: tool.requiresApproval,
    availableToAgentTypes: normalizeStringList(tool.availableToAgentTypes),
    timeoutPolicy: tool.timeoutPolicy,
    auditLevel: tool.auditLevel,
    sourceVersion: tool.currentVersion,
    sourceFingerprint: tool.currentFingerprint,
    updatedAt: tool.updatedAt.toISOString()
  };
}

function defaultPermissionScopes(tool: ToolDefinitionView) {
  if (tool.category === "workspace") return [`workspace:${tool.risk}`];
  if (tool.category === "asset") return [`asset:${tool.risk}`];
  if (tool.category === "message") return [`message:${tool.risk}`];
  if (tool.category === "git") return [`git:${tool.risk}`];
  if (tool.category === "command") return [`command:${tool.risk}`];
  if (tool.category === "browser") return [`browser:${tool.risk}`];
  if (tool.category === "agent") return [`agent:${tool.risk}`];
  if (tool.category === "user") return [`user:${tool.risk}`];
  return [];
}

function defaultInputSchema(tool: ToolDefinitionView) {
  if (tool.id === "read_file") return objectSchema({ path: stringSchema("工作空间内相对路径") }, ["path"]);
  if (tool.id === "write_file") return objectSchema({ path: stringSchema("工作空间内相对路径"), content: stringSchema("写入内容") }, ["path", "content"]);
  if (tool.id === "search_files") return objectSchema({ query: stringSchema("搜索关键词") }, ["query"]);
  if (tool.id === "api_fetch_json") {
    return objectSchema({
      url: stringSchema("HTTPS URL。官方工具会阻断内网、localhost 和重定向。"),
      headers: { type: "object", additionalProperties: { type: "string" }, description: "可选请求头，不允许覆盖 Host/Cookie/Authorization" }
    }, ["url"]);
  }
  if (tool.id === "web_search") {
    return objectSchema({
      query: stringSchema("搜索关键词"),
      maxResults: { type: "number", description: "返回结果数，默认 5，范围 1-10" },
      locale: stringSchema("可选地区/语言，例如 zh-CN 或 en-US")
    }, ["query"]);
  }
  if (tool.id === "diagram_draw") {
    return objectSchema({
      title: stringSchema("图表标题"),
      summary: stringSchema("图表说明"),
      nodes: {
        type: "array",
        items: objectSchema({ id: stringSchema("节点 ID"), label: stringSchema("节点显示名") }, ["id", "label"])
      },
      edges: {
        type: "array",
        items: objectSchema({ from: stringSchema("起点节点 ID"), to: stringSchema("终点节点 ID"), label: stringSchema("连线说明") }, ["from", "to"])
      }
    }, ["title"]);
  }
  if (tool.id === "mcp_fetch_markdown") {
    return objectSchema({
      url: stringSchema("公开 HTTPS URL。官方工具会阻断内网、localhost 和重定向。"),
      title: stringSchema("可选文档标题"),
      path: stringSchema("可选输出路径，默认写入 Doc/research/")
    }, ["url"]);
  }
  if (tool.id === "mcp_git_inspect") {
    return objectSchema({
      includeDiff: { type: "boolean", description: "是否返回 Diff 摘要，默认 true" }
    }, []);
  }
  if (tool.id === "mcp_workspace_snapshot") {
    return objectSchema({
      title: stringSchema("可选快照标题"),
      depth: { type: "number", description: "扫描深度，默认 2，最大 5" },
      maxFiles: { type: "number", description: "最多列出文件数量，默认 300，最大 800" }
    }, []);
  }
  if (tool.id === "send_message") return objectSchema({ conversationId: stringSchema("会话 ID"), blocks: { type: "array", items: { type: "object" } } }, ["conversationId", "blocks"]);
  if (tool.id === "call_agent") return objectSchema({ agentId: stringSchema("Agent ID"), task: stringSchema("分派任务") }, ["agentId", "task"]);
  if (tool.id === "request_approval") return objectSchema({ reason: stringSchema("审批原因"), risk: stringSchema("风险说明") }, ["reason"]);
  return { type: "object", additionalProperties: true };
}

function defaultOutputSchema(_tool: ToolDefinitionView) {
  return { type: "object", additionalProperties: true };
}

function defaultAgentTypes(tool: ToolDefinitionView) {
  if (tool.category === "command" || tool.category === "git") return ["orchestrator", "code"];
  if (tool.category === "browser") return ["orchestrator", "ui", "review", "code"];
  if (tool.category === "user") return ["orchestrator", "universal", "product", "ui", "review"];
  return ["orchestrator", "universal", "product", "ui", "review", "code"];
}

function defaultTimeoutPolicy(tool: ToolDefinitionView) {
  if (tool.category === "command" || tool.category === "browser" || tool.category === "git") return "long";
  if (tool.category === "message" || tool.category === "user") return "short";
  return "none";
}

function personalStarterTools(currentUser: AgentHubUser): ToolDefinitionView[] {
  const owner = { ownerType: "user", ownerId: currentUser.id, visibility: "private", source: "system_starter" };
  return [
    {
      id: `tool-user-${currentUser.id}-doc-reader`,
      category: "workspace",
      name: "个人 Doc 读取工具",
      risk: "read",
      description: "读取当前会话工作空间 Doc/ 或 Code/ 内的文件，适合自建 Agent 查询项目文档。",
      runtimeType: "builtin_alias",
      runtimeToolId: "read_file",
      executable: true,
      inputSchema: defaultInputSchema({ id: "read_file", category: "workspace", name: "Read File", risk: "read", description: "读取工作空间文件" }),
      permissionScopes: ["tool:read_file", "workspace:read", "asset:read"],
      metadata: { starter: true, runtimeToolId: "read_file" },
      ...owner
    },
    {
      id: `tool-user-${currentUser.id}-doc-writer`,
      category: "workspace",
      name: "个人 Doc 写入工具",
      risk: "write",
      description: "在当前会话工作空间写入 Doc/ 下的 Markdown 文档，适合长报告、方案和规范沉淀。",
      runtimeType: "builtin_alias",
      runtimeToolId: "write_file",
      executable: true,
      inputSchema: defaultInputSchema({ id: "write_file", category: "workspace", name: "Write File", risk: "write", description: "写入工作空间文本文件并创建资产记录" }),
      permissionScopes: ["tool:write_file", "workspace:write", "asset:write"],
      metadata: { starter: true, runtimeToolId: "write_file", recommendedPathPrefix: "Doc/" },
      ...owner
    }
  ];
}

function toAsciiSlug(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 36);
}

function objectSchema(properties: Record<string, unknown>, required: string[]) {
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false
  };
}

function stringSchema(description: string) {
  return { type: "string", description };
}

function normalizeFunctionSource(value: unknown) {
  if (typeof value !== "string" || !value.trim()) throw new BadRequestException("functionSource is required");
  const source = value.trim();
  if (source.length > 20_000) throw new BadRequestException("functionSource is too large");
  if (/\b(import|require|fetch|XMLHttpRequest|process|Deno|Bun)\b/.test(source)) {
    throw new BadRequestException("函数工具不能包含 import/require/fetch/process 等外部能力");
  }
  if (!/^\s*(async\s+)?function\b|^\s*\(?[\w\s,{}[\].:=]*\)?\s*=>/.test(source)) {
    throw new BadRequestException("函数工具源码必须是 function(input) { ... } 或 (input) => ...");
  }
  return source;
}

function normalizeRisk(value: string): ToolDefinitionView["risk"] {
  return value === "write" || value === "external" || value === "dangerous" ? value : "read";
}

function normalizeStringList(value: unknown) {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean)));
}

function isVisibleInToolHub(tool: ToolDefinitionView) {
  if (tool.ownerType === "user" || tool.source === "user" || tool.source === "system_starter") return true;
  if (tool.source === "builtin" || tool.source === "system") {
    return Boolean(tool.executable)
      && publicToolHubToolIds.has(tool.id)
      && !INTERNAL_TOOLHUB_CATEGORIES.has(tool.category);
  }
  return true;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
