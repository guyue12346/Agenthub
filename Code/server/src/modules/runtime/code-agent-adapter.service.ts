import { Inject, Injectable, Optional } from "@nestjs/common";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import { access, chmod, mkdir, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { ConfigService } from "../../common/config.service.js";
import { PrismaService } from "../../common/prisma.service.js";
import { RuntimeConfigService, type EffectiveRuntimeConfig } from "../../common/runtime-config.service.js";
import { isInsideAnyWorkspaceRoot, isInsideAnyWorkspaceRootRealpath } from "../../common/workspace-roots.js";
import { CodeAgentWorkspaceLockService } from "./code-agent-workspace-lock.service.js";
import { captureWorkspaceSnapshot, diffWorkspaceSnapshots } from "./code-agent-workspace-diff.js";

export interface CodeAgentTaskInput {
  provider: "codex" | "opencode";
  workspaceRoot: string;
  prompt: string;
  logFilePath?: string;
  signal?: AbortSignal;
}

export interface CodeAgentTaskResult {
  provider: "codex" | "opencode";
  requestedProvider?: "codex" | "opencode";
  command: string;
  cwd: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  sessionId?: string | undefined;
  finalMessage?: string | undefined;
  changedFiles?: Array<{ path: string; additions: number; deletions: number }> | undefined;
  diffText?: string | undefined;
  timedOut?: boolean;
  cancelled?: boolean;
}

interface CommandSpec {
  file: string;
  args: string[];
}

interface ExecutionSpec extends CommandSpec {
  cwd: string;
  env: NodeJS.ProcessEnv;
  displayCommand: string;
}

export interface RunnerMount {
  hostPath: string;
  containerPath: string;
  mode: "rw" | "ro";
}

export interface RunnerConfig {
  mounts: RunnerMount[];
  env: Record<string, string>;
  localEnv?: Record<string, string>;
}

const RUNAPI_PROVIDER_NAME = "runapi";
const RUNAPI_OPENCODE_PROVIDER = "runapi_openai";
const DEFAULT_CODEX_MODEL = "gpt-5.3-codex";
const DEFAULT_CODEX_REASONING_EFFORT = "high";
const WORKSPACE_LOCK_LEASE_MS = 15 * 60_000;
const WORKSPACE_LOCK_HEARTBEAT_MS = 15_000;
const WORKSPACE_LOCK_POLL_MS = 250;
const WORKSPACE_LOCK_TIMEOUT_MS = 15 * 60_000;

export function runtimeFromEnvironment(config: ConfigService): EffectiveRuntimeConfig {
  const llm = config.llm;
  const runner = config.codeRunner;
  return {
    provider: llm.provider,
    baseUrl: llm.baseUrl,
    apiKey: llm.apiKey?.trim() || undefined,
    model: llm.model,
    reasoningEffort: llm.reasoningEffort,
    wireApi: llm.wireApi,
    codexModel: runner.codexModel ?? llm.model,
    codexReasoningEffort: runner.codexReasoningEffort ?? DEFAULT_CODEX_REASONING_EFFORT,
    openCodeModel: runner.openCodeModel ?? llm.model,
    openCodeReasoningEffort: runner.openCodeReasoningEffort ?? llm.reasoningEffort
  };
}

@Injectable()
export class CodeAgentAdapterService {
  private readonly workspaceLocks = new Map<string, Promise<unknown>>();
  private readonly lockOwnerId = `code-agent-${process.pid}-${randomUUID()}`;

  constructor(
    @Inject(ConfigService) private readonly config: ConfigService,
    @Inject(RuntimeConfigService) private readonly runtimeConfig: RuntimeConfigService,
    @Optional()
    @Inject(PrismaService)
    private readonly prisma?: PrismaService,
    @Optional()
    @Inject(CodeAgentWorkspaceLockService)
    private readonly workspaceLock?: Pick<CodeAgentWorkspaceLockService, "withWorkspaceLock">
  ) {}

  async runCodeTask(input: CodeAgentTaskInput): Promise<CodeAgentTaskResult> {
    const runtimeConfig = await this.runtimeConfig.getEffectiveConfig("code");
    const executionProvider = resolveCodeAgentExecutionProvider(input.provider, runtimeConfig);
    const workspaceRoot = await ensureWorkspace(input.workspaceRoot, this.config);
    return this.runWithWorkspaceLock(workspaceRoot, async () => {
      const task = { ...input, provider: executionProvider, workspaceRoot };
      const runnerConfig = await prepareCodeAgentRunnerConfig(task, this.config, runtimeConfig);
      const execution = buildCodeAgentExecution(task, this.config, process.env, runnerConfig, runtimeConfig);
      const beforeSnapshot = await captureWorkspaceSnapshot(workspaceRoot);
      const result = await runCommand(
        execution.file,
        execution.args,
        execution.cwd,
        execution.env,
        this.config.codeRunner.timeoutMs,
        input.signal,
        {
          displayCommand: execution.displayCommand,
          ...(input.logFilePath ? { logFilePath: input.logFilePath } : {})
        }
      );
      const workspaceDiff = diffWorkspaceSnapshots(beforeSnapshot, await captureWorkspaceSnapshot(workspaceRoot));
      return {
        provider: executionProvider,
        ...(executionProvider !== input.provider ? { requestedProvider: input.provider } : {}),
        command: execution.displayCommand,
        cwd: workspaceRoot,
        ...result,
        changedFiles: result.changedFiles?.length ? result.changedFiles : workspaceDiff.changedFiles,
        diffText: result.diffText || workspaceDiff.diffText || undefined
      };
    });
  }

  private async runWithWorkspaceLock<T>(workspaceRoot: string, run: () => Promise<T>) {
    if (this.workspaceLock) return this.workspaceLock.withWorkspaceLock(workspaceRoot, run);
    return this.withWorkspaceLock(workspaceRoot, run);
  }

  private async withWorkspaceLock<T>(workspaceRoot: string, run: () => Promise<T>) {
    if (this.prisma) return this.withPersistentWorkspaceLock(workspaceRoot, run);
    return this.withInMemoryWorkspaceLock(workspaceRoot, run);
  }

  private async withInMemoryWorkspaceLock<T>(workspaceRoot: string, run: () => Promise<T>) {
    const previous = this.workspaceLocks.get(workspaceRoot) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const current = new Promise<void>((resolveLock) => {
      release = resolveLock;
    });
    const lockPromise = previous.then(() => current);
    this.workspaceLocks.set(workspaceRoot, lockPromise);
    await previous.catch(() => undefined);
    try {
      return await run();
    } finally {
      release();
      if (this.workspaceLocks.get(workspaceRoot) === lockPromise) this.workspaceLocks.delete(workspaceRoot);
    }
  }

  private async withPersistentWorkspaceLock<T>(workspaceRoot: string, run: () => Promise<T>) {
    const prisma = this.prisma!;
    const lockKey = await this.acquirePersistentWorkspaceLock(workspaceRoot);
    const heartbeat = setInterval(() => {
      void prisma.runtimeLock.updateMany({
        where: { key: lockKey, ownerId: this.lockOwnerId },
        data: {
          heartbeatAt: new Date(),
          expiresAt: new Date(Date.now() + WORKSPACE_LOCK_LEASE_MS)
        }
      });
    }, WORKSPACE_LOCK_HEARTBEAT_MS);
    try {
      return await run();
    } finally {
      clearInterval(heartbeat);
      await prisma.runtimeLock.deleteMany({ where: { key: lockKey, ownerId: this.lockOwnerId } });
    }
  }

  private async acquirePersistentWorkspaceLock(workspaceRoot: string) {
    const prisma = this.prisma!;
    const lockKey = workspaceLockKey(workspaceRoot);
    const startedAt = Date.now();
    for (;;) {
      const now = new Date();
      const expiresAt = new Date(now.getTime() + WORKSPACE_LOCK_LEASE_MS);
      try {
        await prisma.runtimeLock.create({
          data: {
            key: lockKey,
            ownerId: this.lockOwnerId,
            resourceType: "workspace",
            resourceId: workspaceRoot,
            expiresAt,
            heartbeatAt: now
          }
        });
        return lockKey;
      } catch (error) {
        if (!isUniqueConstraintError(error)) throw error;
      }
      const claimed = await prisma.runtimeLock.updateMany({
        where: {
          key: lockKey,
          OR: [
            { ownerId: this.lockOwnerId },
            { expiresAt: { lt: now } }
          ]
        },
        data: {
          ownerId: this.lockOwnerId,
          resourceType: "workspace",
          resourceId: workspaceRoot,
          expiresAt,
          heartbeatAt: now
        }
      });
      if (claimed.count === 1) return lockKey;
      if (Date.now() - startedAt > WORKSPACE_LOCK_TIMEOUT_MS) {
        throw new Error(`Timed out waiting for Code Agent workspace lock: ${workspaceRoot}`);
      }
      await delay(WORKSPACE_LOCK_POLL_MS);
    }
  }
}

export async function prepareCodeAgentRunnerConfig(
  input: CodeAgentTaskInput,
  config: ConfigService,
  runtimeConfig: EffectiveRuntimeConfig = runtimeFromEnvironment(config)
): Promise<RunnerConfig> {
  if (!runtimeConfig.apiKey) {
    throw new Error("Runtime LLM API Key is required for RunAPI Code Agent execution.");
  }
  if (input.provider === "codex" && !isCodexRuntimeConfigSupported(runtimeConfig)) {
    throw new Error(codexUnsupportedReason(runtimeConfig));
  }
  const runnerRoot = await prepareRunnerRoot(input.workspaceRoot, input.provider, config);
  if (input.provider === "opencode") return prepareOpenCodeRunnerConfig(runnerRoot, config, runtimeConfig);
  return prepareCodexRunnerConfig(runnerRoot, config, runtimeConfig);
}

export function resolveCodeAgentExecutionProvider(
  requestedProvider: CodeAgentTaskInput["provider"],
  runtimeConfig: EffectiveRuntimeConfig
): CodeAgentTaskInput["provider"] {
  if (requestedProvider !== "codex") return requestedProvider;
  return isCodexRuntimeConfigSupported(runtimeConfig) ? "codex" : "opencode";
}

export function isCodexRuntimeConfigSupported(runtimeConfig: Pick<EffectiveRuntimeConfig, "provider" | "baseUrl" | "wireApi">) {
  if (runtimeConfig.wireApi !== "responses") return false;
  return !isKnownChatCompletionsOnlyProvider(runtimeConfig.provider, runtimeConfig.baseUrl);
}

export function codexUnsupportedReason(runtimeConfig: Pick<EffectiveRuntimeConfig, "provider" | "baseUrl" | "wireApi">) {
  const provider = runtimeConfig.provider || "unknown";
  if (runtimeConfig.wireApi !== "responses") {
    return `Codex requires a Responses-compatible model API, but current provider ${provider} is configured for ${runtimeConfig.wireApi}. Use OpenCode for chat/completions models or switch Codex to a Responses-compatible provider.`;
  }
  return `Codex requires a Responses-compatible model API, but current provider ${provider} at ${runtimeConfig.baseUrl} is known to support chat/completions only. Use OpenCode for this provider or configure a Responses-compatible Codex provider.`;
}

export function buildCodeAgentExecution(
  input: CodeAgentTaskInput,
  config: ConfigService,
  env: NodeJS.ProcessEnv = process.env,
  runnerConfig: RunnerConfig = { mounts: [], env: {} },
  runtimeConfig: EffectiveRuntimeConfig = runtimeFromEnvironment(config)
): ExecutionSpec {
  const command = input.provider === "opencode" ? buildOpenCodeCommand(input, config, runtimeConfig) : buildCodexCommand(input, config);
  return buildRunnerCommand(command, input.workspaceRoot, config, env, runnerConfig, runtimeConfig);
}

function buildCodexCommand(input: CodeAgentTaskInput, config: ConfigService): CommandSpec {
  const cwd = getRunnerWorkspacePath(input.workspaceRoot, config);
  const args = [
    "exec",
    "--cd",
    cwd,
    "--sandbox",
    "workspace-write",
    "--skip-git-repo-check",
    input.prompt
  ];
  return { file: config.codeRunner.codexCommand, args };
}

function buildOpenCodeCommand(input: CodeAgentTaskInput, config: ConfigService, runtimeConfig: EffectiveRuntimeConfig): CommandSpec {
  const args = ["run", "--dir", getRunnerWorkspacePath(input.workspaceRoot, config)];
  if (config.codeRunner.openCodeSkipPermissions) args.push("--dangerously-skip-permissions");
  args.push("-m", normalizeOpenCodeModel(runtimeConfig.openCodeModel ?? runtimeConfig.model, runtimeConfig.provider));
  if (runtimeConfig.openCodeReasoningEffort) args.push("--variant", runtimeConfig.openCodeReasoningEffort);
  args.push("--format", "json");
  args.push(input.prompt);
  return { file: config.codeRunner.openCodeCommand, args };
}

function buildRunnerCommand(
  command: CommandSpec,
  workspaceRoot: string,
  config: ConfigService,
  env: NodeJS.ProcessEnv,
  runnerConfig: RunnerConfig,
  runtimeConfig: EffectiveRuntimeConfig
): ExecutionSpec {
  const runner = config.codeRunner;
  const mode = runner.mode;
  const runnerEnv = { ...buildRunnerEnv(config, runtimeConfig, env), ...runnerConfig.env };
  if (mode === "local") {
    if (!runner.allowUnsafeLocal) {
      throw new Error("Local Code Agent runner is disabled. Set AGENTHUB_ALLOW_UNSAFE_LOCAL_RUNNER=true only for trusted local development.");
    }
    return {
      ...command,
      cwd: workspaceRoot,
      env: { ...env, ...runnerEnv, ...(runnerConfig.localEnv ?? {}) },
      displayCommand: formatCommandForDisplay(command.file, command.args)
    };
  }
  if (mode !== "docker") throw new Error(`Unsupported Code Agent runner mode: ${mode}`);
  const dockerEnvArgs = Object.entries(runnerEnv).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
  const mountArgs = runnerConfig.mounts.flatMap((mount) => ["-v", `${mount.hostPath}:${mount.containerPath}:${mount.mode}`]);
  const dockerArgs = [
    "run",
    "--rm",
    "--init",
    "--network",
    runner.network,
    "--cpus",
    runner.cpus,
    "--memory",
    runner.memory,
    "--pids-limit",
    runner.pidsLimit,
    "--security-opt",
    "no-new-privileges",
    "--cap-drop",
    "ALL",
    ...hostUserArgs(runner.useHostUser),
    "-v",
    `${workspaceRoot}:/workspace:rw`,
    ...mountArgs,
    "-w",
    "/workspace",
    ...dockerEnvArgs,
    runner.image,
    command.file,
    ...command.args
  ];
  return {
    file: runner.dockerCommand,
    args: dockerArgs,
    cwd: workspaceRoot,
    env,
    displayCommand: formatCommandForDisplay(runner.dockerCommand, dockerArgs)
  };
}

function getRunnerWorkspacePath(workspaceRoot: string, config: ConfigService) {
  return config.codeRunner.mode === "docker" ? "/workspace" : workspaceRoot;
}

function buildRunnerEnv(config: ConfigService, runtimeConfig: EffectiveRuntimeConfig, env: NodeJS.ProcessEnv) {
  const allowedPrefixes = ["RUNAPI_", "OPENROUTER_"];
  const explicit = [
    "AGENTHUB_CODEX_MODEL",
    "AGENTHUB_CODEX_REASONING_EFFORT",
    "AGENTHUB_OPENCODE_MODEL",
    "AGENTHUB_OPENCODE_REASONING_EFFORT",
    "AGENTHUB_OPENCODE_SKIP_PERMISSIONS"
  ];
  const result: Record<string, string> = {
    HOME: "/runner-home",
    CODEX_HOME: "/runner-home/.codex",
    XDG_CONFIG_HOME: "/runner-home/.config",
    XDG_CACHE_HOME: "/runner-home/.cache",
    XDG_DATA_HOME: "/runner-home/.local/share",
    XDG_STATE_HOME: "/runner-home/.local/state",
    AGENTHUB_LLM_PROVIDER: runtimeConfig.provider,
    AGENTHUB_LLM_BASE_URL: runtimeConfig.baseUrl,
    AGENTHUB_LLM_MODEL: runtimeConfig.model,
    AGENTHUB_LLM_REASONING_EFFORT: runtimeConfig.reasoningEffort,
    AGENTHUB_LLM_WIRE_API: runtimeConfig.wireApi
  };
  if (runtimeConfig.codexModel) result.AGENTHUB_CODEX_MODEL = runtimeConfig.codexModel;
  if (runtimeConfig.codexReasoningEffort) result.AGENTHUB_CODEX_REASONING_EFFORT = runtimeConfig.codexReasoningEffort;
  if (runtimeConfig.openCodeModel) result.AGENTHUB_OPENCODE_MODEL = runtimeConfig.openCodeModel;
  if (runtimeConfig.openCodeReasoningEffort) result.AGENTHUB_OPENCODE_REASONING_EFFORT = runtimeConfig.openCodeReasoningEffort;
  for (const [key, value] of Object.entries(env)) {
    if (!value) continue;
    if (isSensitiveKey(key)) continue;
    if (explicit.includes(key) || allowedPrefixes.some((prefix) => key.startsWith(prefix))) {
      result[key] = value;
    }
  }
  return result;
}

async function prepareRunnerRoot(workspaceRoot: string, provider: CodeAgentTaskInput["provider"], config: ConfigService) {
  const baseRoot = getWorkspaceBaseRoot(config);
  const hash = createHash("sha256").update(workspaceRoot).digest("hex").slice(0, 16);
  const runnerRoot = resolve(baseRoot, ".agenthub-runner", hash, provider);
  await mkdir(runnerRoot, { recursive: true, mode: 0o700 });
  await chmod(runnerRoot, 0o700).catch(() => undefined);
  return runnerRoot;
}

async function prepareCodexRunnerConfig(runnerRoot: string, config: ConfigService, runtimeConfig: EffectiveRuntimeConfig): Promise<RunnerConfig> {
  const localHome = resolve(runnerRoot, "home");
  const codexHome = resolve(runnerRoot, "codex-home");
  const xdgConfigHome = resolve(localHome, ".config");
  const xdgCacheHome = resolve(localHome, ".cache");
  const xdgDataHome = resolve(localHome, ".local", "share");
  const xdgStateHome = resolve(localHome, ".local", "state");
  await Promise.all([
    mkdir(codexHome, { recursive: true, mode: 0o700 }),
    mkdir(xdgConfigHome, { recursive: true, mode: 0o700 }),
    mkdir(xdgCacheHome, { recursive: true, mode: 0o700 }),
    mkdir(xdgDataHome, { recursive: true, mode: 0o700 }),
    mkdir(xdgStateHome, { recursive: true, mode: 0o700 })
  ]);
  const authPath = resolve(codexHome, "auth.json");
  const configPath = resolve(codexHome, "config.toml");
  await writeFile(authPath, `${JSON.stringify({ OPENAI_API_KEY: runtimeConfig.apiKey }, null, 2)}\n`, "utf8");
  await writeFile(configPath, buildCodexToml(runtimeConfig), "utf8");
  await chmod(authPath, 0o600).catch(() => undefined);
  await chmod(configPath, 0o600).catch(() => undefined);
  return {
    mounts: [{ hostPath: codexHome, containerPath: "/runner-home/.codex", mode: "rw" }],
    env: {},
    localEnv: {
      HOME: localHome,
      CODEX_HOME: codexHome,
      XDG_CONFIG_HOME: xdgConfigHome,
      XDG_CACHE_HOME: xdgCacheHome,
      XDG_DATA_HOME: xdgDataHome,
      XDG_STATE_HOME: xdgStateHome
    }
  };
}

export async function prepareOpenCodeRunnerConfig(runnerRoot: string, config: ConfigService, runtimeConfig: EffectiveRuntimeConfig): Promise<RunnerConfig> {
  const localHome = resolve(runnerRoot, "home");
  const xdgConfigHome = resolve(localHome, ".config");
  const xdgCacheHome = resolve(localHome, ".cache");
  const xdgDataHome = resolve(localHome, ".local", "share");
  const xdgStateHome = resolve(localHome, ".local", "state");
  const localCodexHome = resolve(localHome, ".codex");
  const openCodeHome = resolve(xdgConfigHome, "opencode");
  await Promise.all([
    mkdir(openCodeHome, { recursive: true, mode: 0o700 }),
    mkdir(localCodexHome, { recursive: true, mode: 0o700 }),
    mkdir(xdgCacheHome, { recursive: true, mode: 0o700 }),
    mkdir(xdgDataHome, { recursive: true, mode: 0o700 }),
    mkdir(xdgStateHome, { recursive: true, mode: 0o700 })
  ]);
  const configPath = resolve(openCodeHome, "opencode.json");
  await writeFile(configPath, `${JSON.stringify(buildOpenCodeConfig(runtimeConfig), null, 2)}\n`, "utf8");
  await chmod(configPath, 0o600).catch(() => undefined);
  return {
    mounts: [{ hostPath: openCodeHome, containerPath: "/runner-home/.config/opencode", mode: "rw" }],
    env: {},
    localEnv: {
      HOME: localHome,
      CODEX_HOME: localCodexHome,
      XDG_CONFIG_HOME: xdgConfigHome,
      XDG_CACHE_HOME: xdgCacheHome,
      XDG_DATA_HOME: xdgDataHome,
      XDG_STATE_HOME: xdgStateHome
    }
  };
}

function buildCodexToml(runtimeConfig: EffectiveRuntimeConfig) {
  const model = runtimeConfig.codexModel ?? DEFAULT_CODEX_MODEL;
  const reasoningEffort = runtimeConfig.codexReasoningEffort ?? DEFAULT_CODEX_REASONING_EFFORT;
  const providerName = normalizeProviderNamespace(runtimeConfig.provider);
  return [
    `model_provider = ${tomlString(providerName)}`,
    `model = ${tomlString(model)}`,
    `model_reasoning_effort = ${tomlString(reasoningEffort)}`,
    "disable_response_storage = true",
    `preferred_auth_method = ${tomlString("apikey")}`,
    "",
    `[model_providers.${providerName}]`,
    `name = ${tomlString(providerName)}`,
    `base_url = ${tomlString(runtimeConfig.baseUrl)}`,
    `wire_api = ${tomlString("responses")}`,
    "requires_openai_auth = true",
    ""
  ].join("\n");
}

export function buildOpenCodeConfig(runtimeConfig: EffectiveRuntimeConfig) {
  if (!runtimeConfig.apiKey) {
    throw new Error("Runtime LLM API Key is required for OpenCode runner config.");
  }
  const providerName = normalizeOpenCodeProviderNamespace(runtimeConfig.provider);
  const model = normalizeOpenCodeModel(runtimeConfig.openCodeModel ?? runtimeConfig.model, runtimeConfig.provider);
  const modelId = getOpenCodeModelId(model);
  return {
    $schema: "https://opencode.ai/config.json",
    permission: {
      read: "allow",
      list: "allow",
      grep: "allow",
      glob: "allow",
      edit: "allow",
      bash: "allow",
      task: "allow",
      webfetch: "ask",
      websearch: "ask",
      external_directory: "deny"
    } as const,
    provider: {
      [providerName]: {
        npm: "@ai-sdk/openai-compatible",
        name: openCodeProviderDisplayName(runtimeConfig.provider),
        options: {
          baseURL: runtimeConfig.baseUrl,
          apiKey: runtimeConfig.apiKey
        },
        models: buildOpenCodeRunApiModels(modelId)
      }
    },
    model
  };
}

function buildOpenCodeRunApiModels(primaryModelId: string) {
  const modelIds = [
    primaryModelId,
    "gpt-5.5",
    "gpt-5.4",
    "gpt-5.4-mini",
    "gpt-5.3-codex",
    "gpt-5.3-codex-spark",
    "gpt-5.2",
    "gpt-4o",
    "gpt-4o-mini",
    "o1",
    "o3-mini"
  ];
  return Object.fromEntries([...new Set(modelIds)].map((modelId) => [modelId, { name: modelId, options: { store: false } }]));
}

export function normalizeOpenCodeModel(model: string, provider: string) {
  const providerName = normalizeOpenCodeProviderNamespace(provider);
  if (model.startsWith("openai/") && providerName === RUNAPI_OPENCODE_PROVIDER) return `${providerName}/${model.replace(/^openai\//, "")}`;
  if (model.startsWith(`${RUNAPI_OPENCODE_PROVIDER}/`) && providerName !== RUNAPI_OPENCODE_PROVIDER) {
    return `${providerName}/${model.slice(RUNAPI_OPENCODE_PROVIDER.length + 1)}`;
  }
  if (model.includes("/")) return model;
  return `${providerName}/${model}`;
}

export function getOpenCodeModelId(model: string) {
  const parts = model.split("/");
  return parts[parts.length - 1] ?? model;
}

export function normalizeOpenCodeProviderNamespace(provider: string) {
  const normalized = normalizeProviderNamespace(provider);
  return normalized === RUNAPI_PROVIDER_NAME ? RUNAPI_OPENCODE_PROVIDER : normalized;
}

export function normalizeProviderNamespace(provider: string) {
  const normalized = provider.trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  if (normalized === "moonshot" || normalized === "moonshotai") return "kimi";
  return normalized || RUNAPI_PROVIDER_NAME;
}

function isKnownChatCompletionsOnlyProvider(provider: string, baseUrl: string) {
  const normalized = normalizeProviderNamespace(provider);
  if (["kimi", "deepseek"].includes(normalized)) return true;
  const normalizedUrl = baseUrl.trim().toLowerCase();
  return normalizedUrl.includes("api.moonshot.cn") || normalizedUrl.includes("api.deepseek.com");
}

function openCodeProviderDisplayName(provider: string) {
  const normalized = normalizeProviderNamespace(provider);
  if (normalized === "kimi") return "Kimi (OpenAI compatible)";
  if (normalized === "deepseek") return "DeepSeek (OpenAI compatible)";
  if (normalized === "openai") return "OpenAI";
  if (normalized === RUNAPI_PROVIDER_NAME) return "RunAPI (OpenAI)";
  return `${normalized} (OpenAI compatible)`;
}

function hostUserArgs(useHostUser: boolean) {
  if (!useHostUser || typeof process.getuid !== "function" || typeof process.getgid !== "function") return [];
  return ["--user", `${process.getuid()}:${process.getgid()}`];
}

function tomlString(value: string) {
  return JSON.stringify(value);
}

function formatCommandForDisplay(file: string, args: string[]) {
  const safeArgs: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "-e" && args[index + 1]) {
      safeArgs.push(arg, redactEnvAssignment(args[index + 1]!));
      index += 1;
      continue;
    }
    safeArgs.push(redactInlineSecrets(arg));
  }
  return [file, ...safeArgs].map(shellQuote).join(" ");
}

function redactEnvAssignment(value: string) {
  const key = value.split("=")[0] ?? "";
  if (isSensitiveKey(key)) return `${key}=<redacted>`;
  return value;
}

function redactInlineSecrets(value: string) {
  return value.replace(/((?:API_KEY|TOKEN|SECRET|PASSWORD)=)([^ \t]+)/gi, "$1<redacted>");
}

function isSensitiveKey(key: string) {
  return /(API_KEY|TOKEN|SECRET|PASSWORD|AUTH|KEY)$/i.test(key);
}

function shellQuote(value: string) {
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export async function ensureWorkspace(workspaceRoot: string, config: ConfigService) {
  const safeRoot = await resolveWorkspaceRoot(workspaceRoot, config);
  assertLexicallyInsideWorkspaceRoot(safeRoot, config);
  await mkdir(safeRoot, { recursive: true });
  await assertRealpathInsideWorkspaceRoot(safeRoot, config);
  const readmePath = `${safeRoot}/README.md`;
  try {
    await access(readmePath);
  } catch {
    await mkdir(dirname(readmePath), { recursive: true });
    await writeFile(readmePath, "# AgentHub Workspace\n\nThis directory is managed by AgentHub Code Agents.\n", "utf8");
  }
  return safeRoot;
}

async function resolveWorkspaceRoot(workspaceRoot: string, config: ConfigService) {
  const baseRoot = getWorkspaceBaseRoot(config);
  await mkdir(baseRoot, { recursive: true });
  if (workspaceRoot.startsWith("/workspaces/")) {
    return resolve(baseRoot, workspaceRoot.replace(/^\/workspaces\//, ""));
  }
  if (!isAbsolute(workspaceRoot)) return resolve(baseRoot, workspaceRoot);
  return resolve(workspaceRoot);
}

export function getWorkspaceBaseRoot(config: ConfigService) {
  return resolve(config.workspacesRoot);
}

function assertLexicallyInsideWorkspaceRoot(workspaceRoot: string, config: ConfigService) {
  if (!isInsideAnyWorkspaceRoot(getWorkspaceBaseRoot(config), workspaceRoot)) {
    throw new Error(`Workspace root is outside AgentHub workspace root: ${workspaceRoot}`);
  }
}

async function assertRealpathInsideWorkspaceRoot(workspaceRoot: string, config: ConfigService) {
  const resolvedRoot = await realpath(workspaceRoot);
  if (!(await isInsideAnyWorkspaceRootRealpath(getWorkspaceBaseRoot(config), resolvedRoot))) {
    throw new Error(`Workspace root is outside AgentHub workspace root: ${workspaceRoot}`);
  }
}

function workspaceLockKey(workspaceRoot: string) {
  return `workspace:${createHash("sha256").update(resolve(workspaceRoot)).digest("base64url").slice(0, 48)}`;
}

function isUniqueConstraintError(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "P2002");
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runCommand(
  file: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  signal?: AbortSignal,
  options: { displayCommand?: string; logFilePath?: string } = {}
): Promise<Omit<CodeAgentTaskResult, "provider" | "command" | "cwd">> {
  let logStream: WriteStream | undefined;
  if (options.logFilePath) {
    await mkdir(dirname(options.logFilePath), { recursive: true });
    await writeFile(options.logFilePath, [
      `[${new Date().toISOString()}] [meta] command: ${options.displayCommand ?? formatCommandForDisplay(file, args)}`,
      `[${new Date().toISOString()}] [meta] cwd: ${cwd}`,
      ""
    ].join("\n"), "utf8");
    logStream = createWriteStream(options.logFilePath, { flags: "a" });
  }
  return new Promise((resolve) => {
    if (signal?.aborted) {
      writeLogChunk(logStream, "stderr", "Code Agent command was cancelled before start.\n");
      logStream?.end();
      resolve({
        exitCode: null,
        stdout: "",
        stderr: "Code Agent command was cancelled before start.\n",
        cancelled: true
      });
      return;
    }
    const child = spawn(file, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    let timedOut = false;
    let cancelled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const terminate = (reason: "timeout" | "cancelled") => {
      if (settled || timedOut || cancelled) return;
      timedOut = reason === "timeout";
      cancelled = reason === "cancelled";
      stderr.push(Buffer.from(
        reason === "timeout"
          ? `Code Agent command timed out after ${timeoutMs}ms and was terminated.\n`
          : "Code Agent command was cancelled and terminated.\n"
      ));
      writeLogChunk(
        logStream,
        "stderr",
        reason === "timeout"
          ? `Code Agent command timed out after ${timeoutMs}ms and was terminated.\n`
          : "Code Agent command was cancelled and terminated.\n"
      );
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        if (!settled) child.kill("SIGKILL");
      }, 2_000);
    };
    const abort = () => terminate("cancelled");
    signal?.addEventListener("abort", abort, { once: true });
    const finish = (result: Omit<CodeAgentTaskResult, "provider" | "command" | "cwd">) => {
      if (settled) return;
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener("abort", abort);
      writeLogChunk(logStream, "meta", `exitCode=${result.exitCode} timedOut=${Boolean(result.timedOut)} cancelled=${Boolean(result.cancelled)}\n`);
      logStream?.end();
      resolve(result);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdout.push(chunk);
      writeLogChunk(logStream, "stdout", chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr.push(chunk);
      writeLogChunk(logStream, "stderr", chunk);
    });
    child.on("error", (error) => {
      finish({
        exitCode: 127,
        stdout: limitOutput(Buffer.concat(stdout).toString("utf8")),
        stderr: limitOutput(`${Buffer.concat(stderr).toString("utf8")}${error.message}`),
        timedOut,
        cancelled
      });
    });
    child.on("close", (exitCode) => {
      finish({
        exitCode: timedOut || cancelled ? null : exitCode,
        stdout: limitOutput(Buffer.concat(stdout).toString("utf8")),
        stderr: limitOutput(Buffer.concat(stderr).toString("utf8")),
        timedOut,
        cancelled
      });
    });
  });
}

function limitOutput(output: string) {
  return output.length > 12000 ? `${output.slice(0, 12000)}\n\n[output truncated]` : output;
}

function writeLogChunk(stream: WriteStream | undefined, channel: "meta" | "stdout" | "stderr", chunk: Buffer | string) {
  if (!stream) return;
  const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    stream.write(`[${new Date().toISOString()}] [${channel}] ${line}\n`);
  }
}
