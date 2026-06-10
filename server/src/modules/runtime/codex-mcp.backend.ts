import { Inject, Injectable } from "@nestjs/common";
import type { CodeAgentEvent, CodeAgentRunResult } from "@agenthub/shared";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawn } from "node:child_process";
import { z } from "zod";
import { ConfigService } from "../../common/config.service.js";
import { RuntimeConfigService } from "../../common/runtime-config.service.js";
import { ensureWorkspace, prepareCodeAgentRunnerConfig, runtimeFromEnvironment } from "./code-agent-adapter.service.js";
import type { CodeAgentBackend, CodeAgentStartInput } from "./code-agent-backend.js";
import { createCodeAgentRunAbortSignal } from "./code-agent-run-control.js";
import { captureWorkspaceSnapshot, diffWorkspaceSnapshots } from "./code-agent-workspace-diff.js";
import { CodeAgentWorkspaceLockService } from "./code-agent-workspace-lock.service.js";
import { changedFilesFromUnifiedDiff } from "./opencode-server.backend.js";

const CodexEventNotificationSchema = z.object({
  method: z.literal("codex/event"),
  params: z.unknown().optional()
});

@Injectable()
export class CodexMcpBackend implements CodeAgentBackend {
  readonly provider = "codex" as const;

  constructor(
    @Inject(ConfigService) private readonly config: ConfigService,
    @Inject(RuntimeConfigService) private readonly runtimeConfig: RuntimeConfigService,
    @Inject(CodeAgentWorkspaceLockService) private readonly workspaceLock: CodeAgentWorkspaceLockService
  ) {}

  async run(input: CodeAgentStartInput): Promise<CodeAgentRunResult> {
    const runtimeConfig = await this.runtimeConfig.getEffectiveConfig("code").catch(() => runtimeFromEnvironment(this.config));
    const workspaceRoot = await ensureWorkspace(input.workspaceRoot, this.config);
    return this.workspaceLock.withWorkspaceLock(workspaceRoot, async () => {
      const runnerConfig = await prepareCodeAgentRunnerConfig({
        provider: "codex",
        workspaceRoot,
        prompt: input.prompt,
        ...(input.logFilePath ? { logFilePath: input.logFilePath } : {}),
        ...(input.signal ? { signal: input.signal } : {})
      }, this.config, runtimeConfig);
      const env = {
        ...process.env,
        ...runnerConfig.env,
        ...(runnerConfig.localEnv ?? {}),
        AGENTHUB_LLM_PROVIDER: runtimeConfig.provider,
        AGENTHUB_LLM_BASE_URL: runtimeConfig.baseUrl,
        AGENTHUB_LLM_MODEL: runtimeConfig.model,
        AGENTHUB_LLM_WIRE_API: runtimeConfig.wireApi,
        ...(runtimeConfig.apiKey ? { OPENAI_API_KEY: runtimeConfig.apiKey } : {})
      } as Record<string, string>;
      const transport = new StdioClientTransport({
        command: this.config.codeRunner.codexMcpCommand,
        args: ["mcp-server"],
        cwd: workspaceRoot,
        env,
        stderr: "pipe"
      });
      const client = new Client({ name: "agenthub-code-agent", version: "0.1.0" }, { capabilities: {} });
      const runControl = createCodeAgentRunAbortSignal(this.config.codeRunner.timeoutMs, input.signal);
      const closeTransport = () => {
        void transport.close().catch(() => undefined);
      };
      runControl.signal.addEventListener("abort", closeTransport, { once: true });
      try {
        await client.connect(transport);
        let providerSessionId = input.resumeSessionId;
        let latestAssistantMessage = "";
        client.setNotificationHandler(CodexEventNotificationSchema, async (notification) => {
          const mapped = mapCodexEventNotification(notification);
          providerSessionId = mapped.conversationId ?? providerSessionId;
          latestAssistantMessage = mapped.finalMessage ?? latestAssistantMessage;
          for (const item of mapped.events) await input.onEvent?.(item);
        });
        await input.onEvent?.({ type: "status", status: "running", message: "Codex MCP session started", progress: 0.15, at: new Date().toISOString() });
        const beforeSnapshot = await captureWorkspaceSnapshot(workspaceRoot);
        const toolName = input.resumeSessionId ? "codex_reply" : "codex";
        const args = input.resumeSessionId
          ? { conversationId: input.resumeSessionId, prompt: input.prompt }
          : {
              prompt: input.prompt,
              cwd: workspaceRoot,
              sandbox: "workspace-write",
              "approval-policy": "never",
              model: runtimeConfig.codexModel,
              config: { model_reasoning_effort: runtimeConfig.codexReasoningEffort }
            };
        const result = await client.callTool({ name: toolName, arguments: args });
        providerSessionId = extractMcpConversationId(result) ?? providerSessionId;
        const finalMessage = extractMcpText(result) || latestAssistantMessage;
        const terminalStatus = runControl.timedOut() ? "timed_out" : runControl.cancelled() ? "cancelled" : "completed";
        const isError = Boolean(asRecord(result)?.isError) || terminalStatus !== "completed";
        if (finalMessage) await input.onEvent?.({ type: "message", text: finalMessage, at: new Date().toISOString() });
        const snapshotDiff = diffWorkspaceSnapshots(beforeSnapshot, await captureWorkspaceSnapshot(workspaceRoot));
        const gitDiff = snapshotDiff.diffText ? "" : await readGitDiff(workspaceRoot);
        const diffText = snapshotDiff.diffText || gitDiff;
        const changedFiles = snapshotDiff.changedFiles.length > 0 ? snapshotDiff.changedFiles : changedFilesFromUnifiedDiff(diffText);
        await input.onEvent?.({ type: "status", status: isError ? terminalStatus === "completed" ? "failed" : terminalStatus : "completed", message: isError ? terminalMessage("Codex", terminalStatus === "completed" ? "failed" : terminalStatus) : "Codex task completed", progress: 1, at: new Date().toISOString() });
        return {
          provider: this.provider,
          ...(providerSessionId ? { sessionId: providerSessionId } : {}),
          finalMessage: finalMessage || terminalMessage("Codex", isError ? terminalStatus === "completed" ? "failed" : terminalStatus : "completed"),
          changedFiles,
          ...(diffText ? { diffText } : {}),
          exitCode: isError ? 1 : 0,
          timedOut: runControl.timedOut(),
          cancelled: runControl.cancelled()
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const terminalStatus = runControl.timedOut() ? "timed_out" : runControl.cancelled() ? "cancelled" : "failed";
        await input.onEvent?.({ type: "error", message, at: new Date().toISOString() });
        await input.onEvent?.({ type: "status", status: terminalStatus, message, progress: 1, at: new Date().toISOString() });
        return {
          provider: this.provider,
          ...(input.resumeSessionId ? { sessionId: input.resumeSessionId } : {}),
          finalMessage: message,
          changedFiles: changedFilesFromUnifiedDiff(""),
          exitCode: 1,
          timedOut: runControl.timedOut(),
          cancelled: runControl.cancelled()
        };
      } finally {
        runControl.signal.removeEventListener("abort", closeTransport);
        runControl.dispose();
        await transport.close().catch(() => undefined);
      }
    });
  }
}

export function mapCodexEventNotification(value: unknown): { events: CodeAgentEvent[]; conversationId?: string; finalMessage?: string } {
  const notification = asRecord(value);
  const params = asRecord(notification?.params) ?? notification;
  const msg = asRecord(params?.msg) ?? asRecord(params?.message) ?? params;
  const meta = asRecord(notification?._meta) ?? asRecord(params?._meta) ?? asRecord(msg?._meta);
  const conversationId = optionalString(meta?.conversationId)
    ?? optionalString(params?.conversationId)
    ?? optionalString(params?.conversation_id)
    ?? optionalString(msg?.conversationId)
    ?? optionalString(msg?.conversation_id);
  const type = optionalString(msg?.type) ?? optionalString(params?.type);
  const events: CodeAgentEvent[] = [];
  let finalMessage: string | undefined;
  const at = new Date().toISOString();
  if (type === "agent_message_delta") {
    const text = optionalString(msg?.delta) ?? optionalString(msg?.text) ?? optionalString(msg?.content) ?? "";
    if (text) events.push({ type: "message_delta", text, at });
  } else if (type === "agent_message") {
    const text = optionalString(msg?.message) ?? optionalString(msg?.text) ?? optionalString(msg?.content) ?? "";
    if (text) {
      finalMessage = text;
      events.push({ type: "message", text, at });
    }
  } else if (type === "exec_command_begin") {
    events.push({ type: "command_run", command: codexCommandText(msg), status: "started", at });
  } else if (type === "exec_command_end") {
    const exitCode = typeof msg?.exit_code === "number" ? msg.exit_code : typeof msg?.exitCode === "number" ? msg.exitCode : 0;
    events.push({ type: "command_run", command: codexCommandText(msg), status: exitCode === 0 ? "completed" : "failed", at });
  } else if (type === "patch_apply") {
    for (const path of codexPatchFiles(msg)) events.push({ type: "file_edit", path, at });
  } else if (type === "task_complete") {
    const text = optionalString(msg?.last_message) ?? optionalString(msg?.lastMessage) ?? optionalString(msg?.message);
    if (text) {
      finalMessage = text;
      events.push({ type: "message", text, at });
    }
    events.push({ type: "status", status: "completed", message: "Codex task complete", progress: 1, at });
  } else if (type === "error") {
    events.push({ type: "error", message: optionalString(msg?.message) ?? "Codex MCP error", at });
  }
  return {
    events,
    ...(conversationId ? { conversationId } : {}),
    ...(finalMessage ? { finalMessage } : {})
  };
}

function extractMcpText(result: unknown) {
  const content = Array.isArray((result as { content?: unknown[] }).content) ? (result as { content: unknown[] }).content : [];
  return content.map((item) => {
    const record = item && typeof item === "object" ? item as Record<string, unknown> : {};
    return typeof record.text === "string" ? record.text : "";
  }).join("\n").trim();
}

function terminalMessage(provider: string, status: "completed" | "failed" | "cancelled" | "timed_out") {
  if (status === "completed") return `${provider} task completed`;
  if (status === "cancelled") return `${provider} task cancelled`;
  if (status === "timed_out") return `${provider} task timed out`;
  return `${provider} task failed`;
}

function extractMcpConversationId(result: unknown) {
  const record = asRecord(result);
  const meta = asRecord(record?._meta);
  const structured = asRecord(record?.structuredContent);
  return optionalString(meta?.conversationId)
    ?? optionalString(meta?.conversation_id)
    ?? optionalString(structured?.conversationId)
    ?? optionalString(structured?.conversation_id);
}

function codexCommandText(msg: Record<string, unknown> | null) {
  const command = optionalString(msg?.command) ?? optionalString(msg?.cmd);
  if (command) return command;
  const argv = Array.isArray(msg?.argv) ? msg.argv.filter((item): item is string => typeof item === "string") : [];
  if (argv.length > 0) return argv.join(" ");
  return "codex command";
}

function codexPatchFiles(msg: Record<string, unknown> | null) {
  const files = Array.isArray(msg?.files) ? msg.files : Array.isArray(msg?.paths) ? msg.paths : [];
  return files.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function readGitDiff(cwd: string) {
  return new Promise<string>((resolve) => {
    const child = spawn("git", ["diff", "--no-ext-diff", "--"], { cwd, stdio: ["ignore", "pipe", "ignore"] });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("error", () => resolve(""));
    child.on("close", (code) => resolve(code === 0 ? Buffer.concat(chunks).toString("utf8") : ""));
  });
}

function optionalString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}
