import { Inject, Injectable, OnModuleDestroy } from "@nestjs/common";
import type { CodeAgentEvent, CodeAgentRunResult } from "@agenthub/shared";
import { createOpencodeClient, createOpencodeServer, type OpencodeClient } from "@opencode-ai/sdk";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { ConfigService } from "../../common/config.service.js";
import { RuntimeConfigService } from "../../common/runtime-config.service.js";
import {
  buildOpenCodeConfig,
  ensureWorkspace,
  getOpenCodeModelId,
  normalizeOpenCodeModel,
  normalizeOpenCodeProviderNamespace
} from "./code-agent-adapter.service.js";
import type { CodeAgentBackend, CodeAgentStartInput } from "./code-agent-backend.js";
import { createCodeAgentRunAbortSignal } from "./code-agent-run-control.js";
import { captureWorkspaceSnapshot, diffWorkspaceSnapshots } from "./code-agent-workspace-diff.js";
import { CodeAgentWorkspaceLockService } from "./code-agent-workspace-lock.service.js";

interface OpenCodeServerHandle {
  url: string;
  close(): void;
}

@Injectable()
export class OpenCodeServerBackend implements CodeAgentBackend, OnModuleDestroy {
  readonly provider = "opencode" as const;
  private server: OpenCodeServerHandle | undefined;
  private client: OpencodeClient | undefined;
  private unhealthy = false;

  constructor(
    @Inject(ConfigService) private readonly config: ConfigService,
    @Inject(RuntimeConfigService) private readonly runtimeConfig: RuntimeConfigService,
    @Inject(CodeAgentWorkspaceLockService) private readonly workspaceLock: CodeAgentWorkspaceLockService
  ) {}

  async run(input: CodeAgentStartInput): Promise<CodeAgentRunResult> {
    const runtimeConfig = await this.runtimeConfig.getEffectiveConfig("code");
    const workspaceRoot = await ensureWorkspace(input.workspaceRoot, this.config);
    return this.workspaceLock.withWorkspaceLock(workspaceRoot, async () => {
      const runControl = createCodeAgentRunAbortSignal(this.config.codeRunner.timeoutMs, input.signal);
      try {
        const client = await this.getClient(runtimeConfig, workspaceRoot);
        const sessionId = input.resumeSessionId ?? await this.createSession(client, workspaceRoot);
        await writeCodeAgentLog(input.logFilePath, "meta", `opencode session=${sessionId} workspace=${workspaceRoot}\n`);
        await input.onEvent?.(event("session_started", { provider: this.provider, sessionId }));
        await input.onEvent?.(event("status", { status: "running", message: "OpenCode session started", progress: 0.15 }));
        const beforeSnapshot = await captureWorkspaceSnapshot(workspaceRoot);
        const output = await this.promptSession(client, sessionId, workspaceRoot, input.prompt, runtimeConfig, runControl.signal, input.onEvent);
        const diff = await this.readSessionDiff(client, sessionId, workspaceRoot);
        const fallbackDiff = diffWorkspaceSnapshots(beforeSnapshot, await captureWorkspaceSnapshot(workspaceRoot));
        const diffText = diff.diffText || fallbackDiff.diffText;
        const changedFiles = diff.changedFiles.length > 0 ? diff.changedFiles : fallbackDiff.changedFiles.length > 0 ? fallbackDiff.changedFiles : changedFilesFromUnifiedDiff(diffText);
        const terminalStatus = runControl.timedOut() ? "timed_out" : runControl.cancelled() ? "cancelled" : "completed";
        const finalMessage = output.finalMessage || terminalMessage("OpenCode", terminalStatus);
        await writeCodeAgentLog(input.logFilePath, "stdout", `${finalMessage}\n`);
        await input.onEvent?.(event("message", { text: finalMessage }));
        for (const file of changedFiles) await input.onEvent?.(event("file_edit", file));
        await input.onEvent?.(event("status", { status: terminalStatus, message: terminalMessage("OpenCode", terminalStatus), progress: 1 }));
        return {
          provider: this.provider,
          sessionId,
          finalMessage,
          changedFiles,
          ...(diffText ? { diffText } : {}),
          exitCode: terminalStatus === "completed" ? 0 : 1,
          timedOut: runControl.timedOut(),
          cancelled: runControl.cancelled()
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const terminalStatus = runControl.timedOut() ? "timed_out" : runControl.cancelled() ? "cancelled" : "failed";
        await input.onEvent?.(event("error", { message }));
        await input.onEvent?.(event("status", { status: terminalStatus, message, progress: 1 }));
        return {
          provider: this.provider,
          ...(input.resumeSessionId ? { sessionId: input.resumeSessionId } : {}),
          finalMessage: message,
          changedFiles: [],
          exitCode: 1,
          timedOut: runControl.timedOut(),
          cancelled: runControl.cancelled()
        };
      } finally {
        runControl.dispose();
      }
    });
  }

  async onModuleDestroy() {
    this.server?.close();
    this.server = undefined;
    this.client = undefined;
  }

  private async getClient(runtimeConfig: Awaited<ReturnType<RuntimeConfigService["getEffectiveConfig"]>>, workspaceRoot: string) {
    if (!runtimeConfig.apiKey) throw new Error("Runtime LLM API Key is required for OpenCode protocol execution.");
    const createClient = async () => {
      this.server?.close();
      const serverOptions = {
        hostname: this.config.codeRunner.openCodeServeHost,
        timeout: this.config.codeRunner.openCodeServeStartupMs,
        config: buildOpenCodeConfig(runtimeConfig),
        ...(this.config.codeRunner.openCodeServePort > 0 ? { port: this.config.codeRunner.openCodeServePort } : {})
      };
      this.server = await createOpencodeServer(serverOptions);
      this.client = createOpencodeClient({ baseUrl: this.server.url, directory: workspaceRoot });
      this.unhealthy = false;
      return this.client;
    };
    let client = !this.server || !this.client || this.unhealthy ? await createClient() : this.client;
    try {
      await client.session.list({ query: { directory: workspaceRoot } });
    } catch {
      this.unhealthy = true;
      client = await createClient();
      await client.session.list({ query: { directory: workspaceRoot } });
    }
    return client;
  }

  private async createSession(client: OpencodeClient, workspaceRoot: string) {
    const response = await client.session.create({ query: { directory: workspaceRoot }, body: { title: "AgentHub Code Task" } });
    const id = response.data?.id;
    if (!id) throw new Error("OpenCode session.create did not return a session id");
    return id;
  }

  private async promptSession(
    client: OpencodeClient,
    sessionId: string,
    workspaceRoot: string,
    prompt: string,
    runtimeConfig: Awaited<ReturnType<RuntimeConfigService["getEffectiveConfig"]>>,
    signal?: AbortSignal,
    onEvent?: CodeAgentStartInput["onEvent"]
  ) {
    if (signal?.aborted) return { finalMessage: "", cancelled: true };
    const eventAbort = new AbortController();
    const abortSession = () => {
      eventAbort.abort();
      void client.session.abort({ path: { id: sessionId }, query: { directory: workspaceRoot } }).catch(() => undefined);
    };
    signal?.addEventListener("abort", abortSession, { once: true });
    const eventTask = this.consumeOpenCodeEvents(client, sessionId, workspaceRoot, onEvent ?? (() => undefined), eventAbort.signal);
    const model = normalizeOpenCodeModel(runtimeConfig.openCodeModel ?? runtimeConfig.model, runtimeConfig.provider);
    try {
      const response = await client.session.promptAsync({
        path: { id: sessionId },
        query: { directory: workspaceRoot },
        body: {
          model: {
            providerID: normalizeOpenCodeProviderNamespace(runtimeConfig.provider),
            modelID: getOpenCodeModelId(model)
          },
          parts: [{ type: "text", text: prompt }]
        }
      });
      if (response.error) throw new Error(`OpenCode prompt failed: ${JSON.stringify(response.error)}`);
      const eventOutput = await eventTask;
      return { finalMessage: eventOutput.finalMessage || await this.readLatestAssistantMessage(client, sessionId, workspaceRoot) || "OpenCode 执行完成。" };
    } finally {
      eventAbort.abort();
      signal?.removeEventListener("abort", abortSession);
      await eventTask.catch(() => undefined);
    }
  }

  private async readSessionDiff(client: OpencodeClient, sessionId: string, workspaceRoot: string) {
    const response = await client.session.diff({ path: { id: sessionId }, query: { directory: workspaceRoot } });
    if (response.error || !response.data) return { diffText: "", changedFiles: [] };
    return {
      diffText: formatOpenCodeDiff(response.data),
      changedFiles: changedFilesFromOpenCodeDiff(response.data)
    };
  }

  private async readLatestAssistantMessage(client: OpencodeClient, sessionId: string, workspaceRoot: string) {
    const response = await client.session.messages({ path: { id: sessionId }, query: { directory: workspaceRoot } });
    if (response.error || !Array.isArray(response.data)) return "";
    for (const item of [...response.data].reverse()) {
      const info = asRecord(asRecord(item)?.info);
      if (info?.role !== "assistant") continue;
      const text = extractOpenCodePromptText(item);
      if (text) return text;
    }
    return "";
  }

  private async consumeOpenCodeEvents(
    client: OpencodeClient,
    sessionId: string,
    workspaceRoot: string,
    onEvent: NonNullable<CodeAgentStartInput["onEvent"]>,
    signal: AbortSignal
  ) {
    const subscription = await client.event.subscribe({ query: { directory: workspaceRoot }, signal });
    const textParts: string[] = [];
    let finalMessage = "";
    const repliedPermissionIds = new Set<string>();
    for await (const rawEvent of subscription.stream) {
      for (const mapped of mapOpenCodeEvent(rawEvent, sessionId)) {
        if (mapped.type === "message_delta") textParts.push(mapped.text);
        if (mapped.type === "message") finalMessage = mapped.text;
        await onEvent(mapped);
      }
      const record = unwrapOpenCodeEvent(rawEvent);
      await maybeReplyOpenCodePermission(client, sessionId, workspaceRoot, record, repliedPermissionIds, onEvent);
      const properties = asRecord(record?.properties);
      if (record?.type === "session.idle" && properties?.sessionID === sessionId) break;
    }
    return { finalMessage: finalMessage || textParts.join("").trim() };
  }
}

function event<T extends CodeAgentEvent["type"]>(type: T, payload: Omit<Extract<CodeAgentEvent, { type: T }>, "type" | "at">): Extract<CodeAgentEvent, { type: T }> {
  return { type, at: new Date().toISOString(), ...payload } as Extract<CodeAgentEvent, { type: T }>;
}

function terminalMessage(provider: string, status: "completed" | "failed" | "cancelled" | "timed_out") {
  if (status === "completed") return `${provider} task completed`;
  if (status === "cancelled") return `${provider} task cancelled`;
  if (status === "timed_out") return `${provider} task timed out`;
  return `${provider} task failed`;
}

async function writeCodeAgentLog(logFilePath: string | undefined, stream: "meta" | "stdout" | "stderr", text: string) {
  if (!logFilePath) return;
  await mkdir(dirname(logFilePath), { recursive: true });
  await appendFile(logFilePath, `[${new Date().toISOString()}] [${stream}] ${text}`, "utf8").catch(async () => {
    await writeFile(logFilePath, `[${new Date().toISOString()}] [${stream}] ${text}`, "utf8");
  });
}

function extractOpenCodePromptText(value: unknown) {
  const record = asRecord(value);
  const parts = Array.isArray(record?.parts) ? record.parts : Array.isArray(record?.data) ? record.data : [];
  return parts.map((part) => {
    const item = asRecord(part);
    return typeof item?.text === "string" ? item.text : "";
  }).join("").trim();
}

export function mapOpenCodeEvent(value: unknown, sessionId: string): CodeAgentEvent[] {
  const record = unwrapOpenCodeEvent(value);
  const type = typeof record?.type === "string" ? record.type : "";
  const properties = asRecord(record?.properties);
  if (!type || !properties) return [];
  const part = asRecord(properties.part);
  const info = asRecord(properties.info);
  const eventSessionId = typeof properties.sessionID === "string" ? properties.sessionID
    : typeof part?.sessionID === "string" ? part.sessionID
      : typeof info?.sessionID === "string" ? info.sessionID
        : undefined;
  if (eventSessionId && eventSessionId !== sessionId) return [];
  if (type === "message.part.updated") {
    if (part?.type === "text") {
      const delta = typeof properties.delta === "string" ? properties.delta : "";
      const text = delta || (typeof part.text === "string" ? part.text : "");
      return text ? [event("message_delta", { text })] : [];
    }
    return [];
  }
  if (type === "message.updated") {
    if (info?.role === "assistant" && typeof info.finish === "string") return [event("status", { status: "running", message: `OpenCode message ${info.finish}`, progress: 0.75 })];
    return [];
  }
  if (type === "file.edited") {
    const path = typeof properties.file === "string" ? properties.file : "";
    return path ? [event("file_edit", { path })] : [];
  }
  if (type === "command.executed") {
    const command = [properties.name, properties.arguments].filter((item): item is string => typeof item === "string" && item.trim().length > 0).join(" ");
    return command ? [event("command_run", { command, status: "completed" })] : [];
  }
  if (type === "session.status") {
    const statusRecord = asRecord(properties.status);
    const status = typeof statusRecord?.type === "string" ? statusRecord.type : "running";
    return [event("status", { status: status === "idle" ? "completed" : "running", message: `OpenCode session ${status}`, progress: status === "idle" ? 1 : 0.5 })];
  }
  if (type === "session.idle") return [event("status", { status: "completed", message: "OpenCode session idle", progress: 1 })];
  if (type === "session.error") return [event("error", { message: JSON.stringify(properties.error ?? "OpenCode session error") })];
  return [];
}

function formatOpenCodeDiff(value: unknown) {
  if (typeof value === "string") return value;
  const records = Array.isArray(value) ? value : Array.isArray(asRecord(value)?.diff) ? asRecord(value)!.diff as unknown[] : [];
  return records.map((item) => {
    const record = asRecord(item);
    if (!record) return "";
    const path = typeof record.path === "string" ? record.path : typeof record.file === "string" ? record.file : "unknown";
    if (typeof record.patch === "string") return record.patch;
    const before = typeof record.before === "string" ? record.before : "";
    const after = typeof record.after === "string" ? record.after : "";
    const beforeLines = before.split(/\r?\n/);
    const afterLines = after.split(/\r?\n/);
    return [
      `diff --git a/${path} b/${path}`,
      `--- a/${path}`,
      `+++ b/${path}`,
      `@@ -1,${Math.max(beforeLines.length, 1)} +1,${Math.max(afterLines.length, 1)} @@`,
      ...beforeLines.filter(Boolean).map((line) => `-${line}`),
      ...afterLines.filter(Boolean).map((line) => `+${line}`)
    ].join("\n");
  }).filter(Boolean).join("\n");
}

function changedFilesFromOpenCodeDiff(value: unknown) {
  const records = Array.isArray(value) ? value : Array.isArray(asRecord(value)?.diff) ? asRecord(value)!.diff as unknown[] : [];
  return records.map((item) => {
    const record = asRecord(item);
    const path = typeof record?.path === "string" ? record.path : typeof record?.file === "string" ? record.file : "";
    if (!path) return undefined;
    return {
      path,
      additions: typeof record?.additions === "number" ? Math.max(0, Math.trunc(record.additions)) : 0,
      deletions: typeof record?.deletions === "number" ? Math.max(0, Math.trunc(record.deletions)) : 0
    };
  }).filter((item): item is { path: string; additions: number; deletions: number } => Boolean(item));
}

async function maybeReplyOpenCodePermission(
  client: OpencodeClient,
  sessionId: string,
  workspaceRoot: string,
  record: Record<string, unknown> | null,
  repliedPermissionIds: Set<string>,
  onEvent: NonNullable<CodeAgentStartInput["onEvent"]>
) {
  if (!record || (record.type !== "permission.updated" && record.type !== "permission.asked")) return;
  const properties = asRecord(record.properties);
  const permissionSessionId = typeof properties?.sessionID === "string" ? properties.sessionID : typeof properties?.sessionId === "string" ? properties.sessionId : undefined;
  if (permissionSessionId && permissionSessionId !== sessionId) return;
  const permissionId = typeof properties?.id === "string" ? properties.id
    : typeof properties?.permissionID === "string" ? properties.permissionID
      : typeof properties?.requestID === "string" ? properties.requestID
        : typeof record.id === "string" ? record.id
          : undefined;
  if (!permissionId || repliedPermissionIds.has(permissionId)) return;
  repliedPermissionIds.add(permissionId);
  try {
    const api = client as unknown as {
      permission?: {
        reply?: (parameters: { requestID: string; directory?: string; reply?: "once" | "always" | "reject"; message?: string }) => Promise<unknown>;
        respond?: (parameters: { sessionID: string; permissionID: string; directory?: string; response?: "once" | "always" | "reject" }) => Promise<unknown>;
      };
      postSessionIdPermissionsPermissionId?: (options: {
        path: { id: string; permissionID: string };
        query?: { directory?: string };
        body?: { response: "once" | "always" | "reject" };
      }) => Promise<unknown>;
    };
    if (api.permission?.reply) {
      await api.permission.reply({ requestID: permissionId, directory: workspaceRoot, reply: "always", message: "AgentHub Code Agent workspace execution approved." });
    } else if (api.postSessionIdPermissionsPermissionId) {
      await api.postSessionIdPermissionsPermissionId({
        path: { id: sessionId, permissionID: permissionId },
        query: { directory: workspaceRoot },
        body: { response: "always" }
      });
    } else if (api.permission?.respond) {
      await api.permission.respond({ sessionID: sessionId, permissionID: permissionId, directory: workspaceRoot, response: "always" });
    }
    await onEvent(event("status", { status: "running", message: "OpenCode permission auto-approved", progress: 0.35 }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await onEvent(event("error", { message: `OpenCode permission reply failed: ${message}` }));
  }
}

export function changedFilesFromUnifiedDiff(diffText: string) {
  const files = new Map<string, { path: string; additions: number; deletions: number }>();
  let currentPath = "";
  for (const line of diffText.split(/\r?\n/)) {
    const fileMatch = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (fileMatch) {
      currentPath = fileMatch[2] ?? fileMatch[1] ?? "";
      if (currentPath && !files.has(currentPath)) files.set(currentPath, { path: currentPath, additions: 0, deletions: 0 });
      continue;
    }
    const plusFile = /^\+\+\+ b\/(.+)$/.exec(line);
    if (plusFile) {
      currentPath = plusFile[1] ?? currentPath;
      if (currentPath && !files.has(currentPath)) files.set(currentPath, { path: currentPath, additions: 0, deletions: 0 });
      continue;
    }
    if (!currentPath || line.startsWith("+++") || line.startsWith("---")) continue;
    const file = files.get(currentPath);
    if (!file) continue;
    if (line.startsWith("+")) file.additions += 1;
    if (line.startsWith("-")) file.deletions += 1;
  }
  return [...files.values()];
}

function unwrapOpenCodeEvent(value: unknown) {
  const record = asRecord(value);
  return asRecord(record?.payload) ?? asRecord(record?.data) ?? record;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}
