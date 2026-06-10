import "dotenv/config";
import { Injectable } from "@nestjs/common";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { z } from "zod";

const booleanFromEnv = z
  .union([z.boolean(), z.string()])
  .optional()
  .transform((value) => value === true || value === "true" || value === "1");

const MIN_SECRET_ENCRYPTION_KEY_LENGTH = 32;
const DEFAULT_WORKSPACES_ROOT = fileURLToPath(new URL("../../../workspaces", import.meta.url));

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3100),
  AGENTHUB_HTTP_BODY_LIMIT_BYTES: z.coerce.number().int().positive().default(64 * 1024 * 1024),
  WEB_ORIGIN: z.string().default("http://127.0.0.1:5173"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  AGENTHUB_WORKSPACES_ROOT: z.string().default(DEFAULT_WORKSPACES_ROOT),

  AGENTHUB_LLM_PROVIDER: z.string().default("openai-compatible"),
  AGENTHUB_LLM_BASE_URL: z.string().optional(),
  AGENTHUB_LLM_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_BASE_URL: z.string().optional(),
  AGENTHUB_LLM_MODEL: z.string().default("gpt-5.5"),
  AGENTHUB_LLM_REASONING_EFFORT: z.string().default("high"),
  AGENTHUB_LLM_WIRE_API: z.enum(["responses", "chat_completions"]).default("chat_completions"),
  AGENTHUB_LLM_TIMEOUT_MS: z.coerce.number().int().positive().optional(),

  AGENTHUB_CODE_RUNNER_MODE: z.enum(["docker", "local"]).default("docker"),
  AGENTHUB_ALLOW_UNSAFE_LOCAL_RUNNER: booleanFromEnv.default(false),
  AGENTHUB_CODE_RUNNER_IMAGE: z.string().default("agenthub-code-runner:latest"),
  AGENTHUB_CODE_RUNNER_NETWORK: z.string().default("bridge"),
  AGENTHUB_CODE_RUNNER_CPUS: z.string().default("2"),
  AGENTHUB_CODE_RUNNER_MEMORY: z.string().default("2g"),
  AGENTHUB_CODE_RUNNER_PIDS_LIMIT: z.string().default("512"),
  AGENTHUB_CODE_RUNNER_TIMEOUT_MS: z.coerce.number().int().positive().default(30 * 60_000),
  AGENTHUB_CODE_RUNNER_USE_HOST_USER: booleanFromEnv.default(true),
  AGENTHUB_CODE_BACKEND_MODE: z.enum(["subprocess", "protocol"]).default("subprocess"),
  AGENTHUB_DOCKER_COMMAND: z.string().default("docker"),
  AGENTHUB_CODEX_COMMAND: z.string().default("codex"),
  AGENTHUB_OPENCODE_COMMAND: z.string().default("opencode"),
  AGENTHUB_OPENCODE_SERVE_HOST: z.string().default("127.0.0.1"),
  AGENTHUB_OPENCODE_SERVE_PORT: z.coerce.number().int().nonnegative().default(0),
  AGENTHUB_OPENCODE_SERVE_STARTUP_MS: z.coerce.number().int().positive().default(15_000),
  AGENTHUB_CODEX_MCP_ENABLED: booleanFromEnv.default(false),
  AGENTHUB_CODEX_MCP_COMMAND: z.string().default("codex"),
  AGENTHUB_CODE_AGENT_EVENT_FLUSH_MS: z.coerce.number().int().positive().default(150),
  AGENTHUB_CODEX_MODEL: z.string().default("gpt-5.3-codex"),
  AGENTHUB_CODEX_REASONING_EFFORT: z.string().default("high"),
  AGENTHUB_OPENCODE_MODEL: z.string().default("runapi_openai/gpt-5.5"),
  AGENTHUB_OPENCODE_REASONING_EFFORT: z.string().default("high"),
  AGENTHUB_OPENCODE_SKIP_PERMISSIONS: booleanFromEnv.default(false),

  AGENTHUB_SECRET_ENCRYPTION_KEY: z.string().optional(),
  AGENTHUB_SECRET_ENCRYPTION_PREVIOUS_KEYS: z.string().optional(),
  AGENTHUB_REALTIME_PG_NOTIFY: booleanFromEnv.default(true),
  AGENTHUB_RUNTIME_WORKER_MODE: z.enum(["inline", "worker", "disabled"]).optional(),
  AGENTHUB_RUNTIME_WORKER_CONCURRENCY: z.coerce.number().int().positive().default(4),

  AGENTHUB_EMBEDDING_PROVIDER: z.string().default("gemini"),
  AGENTHUB_EMBEDDING_MODEL: z.string().default("gemini-embedding-001"),
  AGENTHUB_EMBEDDING_API_KEY: z.string().optional(),
  AGENTHUB_EMBEDDING_DIMENSION: z.coerce.number().int().positive().default(768),
  AGENTHUB_CHUNKING_STRATEGY: z.enum(["sentence", "fixed_token"]).default("sentence"),
  AGENTHUB_CHUNKING_SIZE: z.coerce.number().int().positive().default(512),
  AGENTHUB_CHUNKING_OVERLAP: z.coerce.number().int().nonnegative().default(50)
});

export type AgentHubConfig = z.infer<typeof envSchema>;

@Injectable()
export class ConfigService {
  readonly values: AgentHubConfig;

  constructor() {
    const parsed = envSchema.safeParse(process.env);
    if (!parsed.success) {
      const message = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
      throw new Error(`AgentHub configuration is invalid: ${message}`);
    }
    if (parsed.data.NODE_ENV === "production" && !parsed.data.AGENTHUB_REALTIME_PG_NOTIFY) {
      throw new Error("AGENTHUB_REALTIME_PG_NOTIFY must be enabled in production for multi-instance realtime delivery");
    }
    const secretEncryptionKey = parsed.data.AGENTHUB_SECRET_ENCRYPTION_KEY?.trim();
    if (parsed.data.NODE_ENV === "production" && !secretEncryptionKey) {
      throw new Error("AGENTHUB_SECRET_ENCRYPTION_KEY is required in production for stored runtime secrets");
    }
    if (secretEncryptionKey && secretEncryptionKey.length < MIN_SECRET_ENCRYPTION_KEY_LENGTH) {
      throw new Error(`AGENTHUB_SECRET_ENCRYPTION_KEY must be at least ${MIN_SECRET_ENCRYPTION_KEY_LENGTH} characters`);
    }
    const previousSecretEncryptionKeys = (parsed.data.AGENTHUB_SECRET_ENCRYPTION_PREVIOUS_KEYS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    const weakPreviousKeyIndex = previousSecretEncryptionKeys.findIndex((key) => key.length < MIN_SECRET_ENCRYPTION_KEY_LENGTH);
    if (weakPreviousKeyIndex >= 0) {
      throw new Error(`AGENTHUB_SECRET_ENCRYPTION_PREVIOUS_KEYS[${weakPreviousKeyIndex}] must be at least ${MIN_SECRET_ENCRYPTION_KEY_LENGTH} characters`);
    }
    this.values = {
      ...parsed.data,
      AGENTHUB_SECRET_ENCRYPTION_KEY: secretEncryptionKey || undefined,
      AGENTHUB_SECRET_ENCRYPTION_PREVIOUS_KEYS: previousSecretEncryptionKeys.join(",")
    };
  }

  get nodeEnv() {
    return this.values.NODE_ENV;
  }

  get port() {
    return this.values.PORT;
  }

  get webOrigin() {
    return this.webOrigins[0] ?? "http://127.0.0.1:5173";
  }

  get webOrigins() {
    return this.values.WEB_ORIGIN
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
      .map((value) => new URL(value).origin);
  }

  get databaseUrl() {
    return this.values.DATABASE_URL;
  }

  get httpBodyLimitBytes() {
    return this.values.AGENTHUB_HTTP_BODY_LIMIT_BYTES;
  }

  get workspacesRoot() {
    return resolve(this.values.AGENTHUB_WORKSPACES_ROOT);
  }

  get secretEncryptionKey() {
    return this.values.AGENTHUB_SECRET_ENCRYPTION_KEY;
  }

  get previousSecretEncryptionKeys() {
    return (this.values.AGENTHUB_SECRET_ENCRYPTION_PREVIOUS_KEYS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
  }

  get runtimeWorkerMode() {
    return this.values.AGENTHUB_RUNTIME_WORKER_MODE ?? (this.nodeEnv === "production" ? "disabled" : "inline");
  }

  get shouldRunRuntimeWorker() {
    return this.runtimeWorkerMode === "inline" || this.runtimeWorkerMode === "worker";
  }

  get llm() {
    const apiKey = this.values.AGENTHUB_LLM_API_KEY ?? this.values.OPENAI_API_KEY;
    return {
      provider: this.values.AGENTHUB_LLM_PROVIDER,
      baseUrl: (this.values.AGENTHUB_LLM_BASE_URL ?? this.values.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, ""),
      apiKey,
      model: this.values.AGENTHUB_LLM_MODEL,
      reasoningEffort: this.values.AGENTHUB_LLM_REASONING_EFFORT,
      wireApi: this.values.AGENTHUB_LLM_WIRE_API
    };
  }

  get runtimeWorkerConcurrency() {
    return this.values.AGENTHUB_RUNTIME_WORKER_CONCURRENCY;
  }

  get codeRunner() {
    return {
      mode: this.values.AGENTHUB_CODE_RUNNER_MODE,
      allowUnsafeLocal: this.values.AGENTHUB_ALLOW_UNSAFE_LOCAL_RUNNER,
      image: this.values.AGENTHUB_CODE_RUNNER_IMAGE,
      network: this.values.AGENTHUB_CODE_RUNNER_NETWORK,
      cpus: this.values.AGENTHUB_CODE_RUNNER_CPUS,
      memory: this.values.AGENTHUB_CODE_RUNNER_MEMORY,
      pidsLimit: this.values.AGENTHUB_CODE_RUNNER_PIDS_LIMIT,
      timeoutMs: this.values.AGENTHUB_CODE_RUNNER_TIMEOUT_MS,
      useHostUser: this.values.AGENTHUB_CODE_RUNNER_USE_HOST_USER,
      backendMode: this.values.AGENTHUB_CODE_BACKEND_MODE,
      dockerCommand: this.values.AGENTHUB_DOCKER_COMMAND,
      codexCommand: this.values.AGENTHUB_CODEX_COMMAND,
      openCodeCommand: this.values.AGENTHUB_OPENCODE_COMMAND,
      openCodeServeHost: this.values.AGENTHUB_OPENCODE_SERVE_HOST,
      openCodeServePort: this.values.AGENTHUB_OPENCODE_SERVE_PORT,
      openCodeServeStartupMs: this.values.AGENTHUB_OPENCODE_SERVE_STARTUP_MS,
      codexMcpEnabled: this.values.AGENTHUB_CODEX_MCP_ENABLED,
      codexMcpCommand: this.values.AGENTHUB_CODEX_MCP_COMMAND,
      eventFlushMs: this.values.AGENTHUB_CODE_AGENT_EVENT_FLUSH_MS,
      codexModel: this.values.AGENTHUB_CODEX_MODEL,
      codexReasoningEffort: this.values.AGENTHUB_CODEX_REASONING_EFFORT,
      openCodeModel: this.values.AGENTHUB_OPENCODE_MODEL,
      openCodeReasoningEffort: this.values.AGENTHUB_OPENCODE_REASONING_EFFORT,
      openCodeSkipPermissions: this.values.AGENTHUB_OPENCODE_SKIP_PERMISSIONS
    };
  }

  get embedding() {
    const apiKey = this.values.AGENTHUB_EMBEDDING_API_KEY;
    if (!apiKey) {
      return undefined;
    }
    return {
      provider: this.values.AGENTHUB_EMBEDDING_PROVIDER as "gemini",
      model: this.values.AGENTHUB_EMBEDDING_MODEL,
      apiKey,
      dimension: this.values.AGENTHUB_EMBEDDING_DIMENSION
    };
  }

  get chunking() {
    return {
      strategy: this.values.AGENTHUB_CHUNKING_STRATEGY,
      size: this.values.AGENTHUB_CHUNKING_SIZE,
      overlap: this.values.AGENTHUB_CHUNKING_OVERLAP
    };
  }
}
