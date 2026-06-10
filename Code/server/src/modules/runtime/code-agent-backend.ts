import type { CodeAgentEvent, CodeAgentRunResult } from "@agenthub/shared";

export interface CodeAgentStartInput {
  workspaceRoot: string;
  prompt: string;
  resumeSessionId?: string | undefined;
  logFilePath?: string | undefined;
  signal?: AbortSignal | undefined;
  onEvent?: (event: CodeAgentEvent) => void | Promise<void>;
}

export interface CodeAgentBackend {
  provider: "codex" | "opencode";
  run(input: CodeAgentStartInput): Promise<CodeAgentRunResult>;
  onModuleDestroy?(): void | Promise<void>;
}
