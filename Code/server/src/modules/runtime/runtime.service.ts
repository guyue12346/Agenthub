import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from "@nestjs/common";
import { z } from "zod";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  advanceRun,
  type CodeAgentEvent,
  createInitialRun,
  createMarkdownBlock,
  type CodeAgentRunResult,
  type ChatMessage,
  type ChatMessageReference,
  type MessageBlock,
  type OrchestratorNode
} from "@agenthub/shared";
import { nanoid } from "nanoid";
import { Prisma, type Agent, type Message, type MessageAction } from "../../generated/prisma/client.js";
import { ConfigService } from "../../common/config.service.js";
import { ObservabilityService } from "../../common/observability.service.js";
import { PrismaService } from "../../common/prisma.service.js";
import { RuntimeConfigService } from "../../common/runtime-config.service.js";
import { ensureWorkspaceCodeRoot } from "../../common/workspace-layout.js";
import { DeploymentsService } from "../deployments/deployments.service.js";
import { RealtimeService } from "../realtime/realtime.service.js";
import { toChatMessage } from "../messages/messages.service.js";
import { KnowledgeService } from "../knowledge/knowledge.service.js";
import { AgentRuntimeService, type RuntimeAgentIdentity, type RuntimeAgentResult } from "./agent-runtime.service.js";
import { CodeAgentAdapterService, type CodeAgentTaskResult } from "./code-agent-adapter.service.js";
import { CodeAgentBackendRegistry } from "./code-agent-backend-registry.js";
import type { CodeAgentBackend } from "./code-agent-backend.js";
import { ContextManagerService } from "./context-manager.service.js";
import { LlmService } from "./llm.service.js";
import { MemoryManagerService } from "./memory-manager.service.js";
import { ToolRuntimeService, type RuntimeToolRequest, type RuntimeToolResult } from "./tool-runtime.service.js";
import { ExcalidrawRenderService } from "./excalidraw-render.service.js";
import { UiAgentRuntimeService } from "./ui-agent-runtime.service.js";
import { executableRuntimeToolRegistry } from "../tools/tool-registry.js";

const ORCHESTRATOR_MENTIONS = new Set(["orchestrator", "agent-orchestrator", "all"]);
const CODE_AGENT_MENTION_TO_AGENT: Record<string, string> = {
  codex: "agent-codex",
  "agent-codex": "agent-codex",
  opencode: "agent-opencode",
  "agent-opencode": "agent-opencode"
};
const DEPLOY_MENTIONS = new Set(["deploy", "deployment", "agent-deploy", "部署", "发布"]);
const RUNTIME_JOB_LEASE_MS = 30 * 60_000;
const RUNTIME_JOB_POLL_MS = 1_000;
const RUNTIME_JOB_HEARTBEAT_MS = 15_000;
const RUNTIME_JOB_CANCEL_POLL_MS = 1_000;
const CODE_TASK_RUN_LEASE_MS = 30 * 60_000;
const CODE_TASK_RUN_HEARTBEAT_MS = 15_000;
const AGENT_ACKNOWLEDGEMENT_REPLIES = [
  "我在，马上处理。",
  "收到，我来跟进。",
  "看到了，我先处理一下。",
  "我在看这件事。",
  "收到，我开始判断下一步。",
  "我来处理这条请求。",
  "明白，我先分析一下。",
  "收到，我会按当前上下文推进。",
  "我在，先看一下细节。",
  "好的，我来接手。",
  "收到，我先梳理任务。",
  "我会基于当前对话处理。",
  "看到了，我开始处理。",
  "明白，我会给出结果。",
  "我来推进这一轮。",
  "收到，我先确认任务边界。",
  "我在处理，请稍等。",
  "我会先理解你的需求。",
  "收到，我来安排。",
  "我先检查相关上下文。",
  "好的，我开始执行。",
  "明白，我来完成这一步。",
  "我会按你的要求处理。",
  "收到，我马上进入任务。"
] as const;
const ORCHESTRATOR_NODE_IDS = new Set<OrchestratorNode>([
  "wake",
  "understand",
  "ui_query",
  "tools",
  "decompose",
  "assignment",
  "validate",
  "integrate",
  "summary",
  "memory_manage"
]);
const INTERNAL_MENTION_TO_AGENT: Record<string, string> = {
  universal: "agent-universal",
  "agent-universal": "agent-universal",
  product: "agent-product",
  "agent-product": "agent-product",
  ui: "agent-ui",
  "agent-ui": "agent-ui"
};

const toolRequestSchema = z.object({
  toolId: z.preprocess(stringishOrUndefined, z.string().min(1).max(160)),
  reason: z.preprocess(stringishOrUndefined, z.string().optional()),
  input: z.preprocess(recordOrEmpty, z.record(z.string(), z.unknown()).default({}))
});

const messageActionInstructionSchema = z.object({
  type: z.enum(["reply", "quote", "comment", "like", "pin"]),
  messageId: z.preprocess(stringishOrUndefined, z.string().optional()),
  payload: z.preprocess(recordOrEmpty, z.record(z.string(), z.unknown()).default({}))
});

function nodeEnvelope<T extends z.ZodType>(result: T) {
  const envelope = z.object({
    status: z.preprocess(normalizeNodeStatusInput, z.enum(["completed", "needs_user", "needs_tool", "failed"]).default("completed")),
    result,
    runMemoryPatch: z.preprocess(recordOrEmpty, z.record(z.string(), z.unknown()).default({})),
    edgeSummary: z.preprocess(stringishOrUndefined, z.string().optional()),
    uiMessages: z.preprocess(stringArrayish, z.array(z.string()).default([])),
    messageActions: z.preprocess(normalizeMessageActionsInput, z.array(messageActionInstructionSchema).default([])),
    nextNode: z.preprocess(stringishOrUndefined, z.string().optional()),
    error: z.preprocess(stringishOrUndefined, z.string().optional())
  });
  return z.preprocess((value) => {
    const record = asRecord(value);
    if (!record || (record.result !== undefined && record.result !== null)) return value;
    const fallbackResult = asRecord(record.validation) ?? asRecord(record.output) ?? record;
    return { ...record, result: fallbackResult };
  }, envelope);
}

const understandResultSchema = z.object({
  clearEnough: z.preprocess(booleanishOrUndefined, z.boolean().default(true)),
  runGoal: z.preprocess(stringishOrUndefined, z.string().min(1).default("本轮用户请求")),
  minimumScope: z.preprocess(stringishOrUndefined, z.string().min(1).default("本轮最小可执行范围")),
  clarificationQuestion: z.preprocess(stringishOrUndefined, z.string().optional()),
  directAnswer: z.preprocess(stringishOrUndefined, z.string().optional()),
  shouldDecompose: z.preprocess(booleanishOrUndefined, z.boolean().default(true)),
  candidateAgents: z.preprocess(stringArrayish, z.array(z.string()).default([])),
  toolRequests: z.preprocess(normalizeToolRequestsInput, z.array(toolRequestSchema).default([]))
});
const understandNodeSchema = nodeEnvelope(understandResultSchema);

const assignmentSchema = z.object({
  workItemId: z.preprocess(stringishOrUndefined, z.string().optional()),
  agentId: z.preprocess(stringishOrUndefined, z.string().min(1).default("agent-universal")),
  task: z.preprocess(stringishOrUndefined, z.string().min(1).default("完成本轮分配任务")),
  expectedOutput: z.preprocess(stringishOrUndefined, z.string().min(1).default("可供 Orchestrator 校验的结果")),
  schedulingLevel: z.preprocess(numberishOrUndefined, z.number().int().positive().optional()),
  level: z.preprocess(numberishOrUndefined, z.number().int().positive().optional()),
  dependsOn: z.preprocess(stringArrayish, z.array(z.string()).default([])),
  acceptanceCriteria: z.preprocess((value) => stringishOrUndefined(stringListToText(value)), z.string().optional())
});
const dependencyGraphSchema = z.preprocess((value) => {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const record = asRecord(item);
    const from = typeof record?.from === "string" ? record.from.trim() : "";
    const to = typeof record?.to === "string" ? record.to.trim() : "";
    return from && to ? [{ from, to }] : [];
  });
}, z.array(z.object({
  from: z.string(),
  to: z.string()
})));

const decomposeResultSchema = z.object({
  planVersion: z.preprocess(numberishOrUndefined, z.number().int().positive().default(1)),
  coordinationMessage: z.preprocess(stringishOrUndefined, z.string().min(1).default("已完成本轮任务拆解。")),
  assignments: z.preprocess(normalizeAssignmentListInput, z.array(assignmentSchema).default([])),
  dependencyGraph: dependencyGraphSchema.default([]),
  parallelGroups: z.preprocess(normalizeParallelGroupsInput, z.array(z.array(z.string())).default([])),
  stopAfterThisRound: z.preprocess(booleanishOrUndefined, z.boolean().default(true))
});
const decomposeNodeSchema = nodeEnvelope(decomposeResultSchema);

const validateNextStepValues = ["continue", "retry_assignment", "retry_decompose", "ask_user", "integrate"] as const;
const validateResultSchema = z.object({
  passed: z.preprocess(booleanishOrUndefined, z.boolean().optional()),
  publicMessage: z.preprocess(stringishOrUndefined, z.string().min(1).default("审阅已完成。")),
  reason: z.preprocess(stringishOrUndefined, z.string().min(1).default("模型未提供详细原因。")),
  nextStep: z.preprocess(normalizeValidateNextStepInput, z.enum(validateNextStepValues).default("continue")),
  likeMessage: z.preprocess(booleanishOrUndefined, z.boolean().default(false)),
  pinMessage: z.preprocess(booleanishOrUndefined, z.boolean().default(false)),
  clarificationQuestion: z.preprocess(stringishOrUndefined, z.string().optional())
}).transform((result) => ({
  ...result,
  passed: result.passed ?? !["retry_assignment", "retry_decompose", "ask_user"].includes(result.nextStep)
}));
export const validateNodeSchema = nodeEnvelope(validateResultSchema);

const inFlightDispositionSchema = z.object({
  scope: z.preprocess(stringishOrUndefined, z.enum(["current", "new"]).default("current")),
  action: z.preprocess(stringishOrUndefined, z.enum(["continue", "cancel", "restart"]).optional()),
  modifier: z.preprocess(stringishOrUndefined, z.enum(["additive", "corrective"]).optional()),
  reason: z.preprocess(stringishOrUndefined, z.string().min(1).default("模型未提供明确原因。")),
  mergedGoal: z.preprocess(stringishOrUndefined, z.string().optional())
}).transform((value) => {
  if (value.scope === "new") return { scope: "new" as const, reason: value.reason, ...(value.mergedGoal ? { mergedGoal: value.mergedGoal } : {}) };
  const action = value.action ?? "continue";
  return {
    scope: "current" as const,
    action,
    ...(action === "continue" ? { modifier: value.modifier ?? "additive" } : {}),
    reason: value.reason,
    ...(value.mergedGoal ? { mergedGoal: value.mergedGoal } : {})
  };
});
type InFlightDisposition = z.infer<typeof inFlightDispositionSchema>;

const integrateResultSchema = z.object({
  publicMessage: z.preprocess(stringishOrUndefined, z.string().min(1).default("本轮已完成。")),
  runBrief: z.preprocess(stringishOrUndefined, z.string().min(1).default("本轮已完成。")),
  openQuestions: z.preprocess(stringArrayish, z.array(z.string()).default([]))
});
const integrateNodeSchema = nodeEnvelope(integrateResultSchema);

const summaryResultSchema = z.object({
  runBrief: z.preprocess(stringishOrUndefined, z.string().min(1).default("本轮已完成。")),
  memoryCandidate: z.preprocess(recordOrEmpty, z.record(z.string(), z.unknown()).default({})),
  nextStepSuggestion: z.preprocess(stringishOrUndefined, z.string().optional())
});
const summaryNodeSchema = nodeEnvelope(summaryResultSchema);

type UnderstandNodeOutput = z.infer<typeof understandNodeSchema>;
type DecomposeNodeOutput = z.infer<typeof decomposeNodeSchema>;
type ValidateNodeOutput = z.infer<typeof validateNodeSchema>;
type IntegrateNodeOutput = z.infer<typeof integrateNodeSchema>;
type SummaryNodeOutput = z.infer<typeof summaryNodeSchema>;
type Assignment = z.infer<typeof assignmentSchema> & { workItemId: string; status?: string; outputMessageId?: string; validation?: unknown; lastValidation?: unknown };

type RuntimeWorkingMemory = ReturnType<typeof createInitialRun> & {
  triggerMessageId?: string;
  runMeta?: Record<string, unknown>;
  understanding?: z.infer<typeof understandResultSchema>;
  workItems?: Assignment[];
  edgeHistory?: Array<Record<string, unknown>>;
  agentRuns?: Array<Record<string, unknown>>;
  toolRuns?: RuntimeToolResult[];
  uiInteractions?: Array<Record<string, unknown>>;
  outputs?: Array<Record<string, unknown>>;
  blockers?: Array<Record<string, unknown>>;
  lastIntegrate?: z.infer<typeof integrateResultSchema>;
};

interface RuntimeExecutionOptions {
  signal?: AbortSignal;
  emitFailureMessage?: boolean;
  throwOnRuntimeError?: boolean;
  resumeExistingRun?: boolean;
}

type CodeAgentReplyOptions = RuntimeExecutionOptions;
type RuntimeMentionTarget = {
  mention: string;
  id: string;
  displayName: string;
  kind: "agent" | "all";
  agentType: RuntimeAgentIdentity["type"] | "orchestrator";
  provider?: string | null | undefined;
};
type RuntimeRouteDecision =
  | { mode: "none"; triggerReason: "no_mention"; explicitMentionedAgents: RuntimeMentionTarget[]; ignoredMentions: string[]; warnings: string[] }
  | { mode: "orchestrator"; triggerReason: "explicit_orchestrator" | "all_mention" | "multi_agent_mention" | "code_agent_conflict"; explicitMentionedAgents: RuntimeMentionTarget[]; ignoredMentions: string[]; warnings: string[] }
  | { mode: "direct_code_agent"; triggerReason: "single_code_agent_mention" | "direct_code_agent_chat"; targetAgentId: string; explicitMentionedAgents: RuntimeMentionTarget[]; ignoredMentions: string[]; warnings: string[] }
  | { mode: "direct_agent"; triggerReason: "single_agent_mention" | "direct_agent_chat"; targetAgentId: string; explicitMentionedAgents: RuntimeMentionTarget[]; ignoredMentions: string[]; warnings: string[] };

type SteerAction = "MERGE_CONTINUE" | "REDECOMPOSE" | "ADD_WORK_ITEM" | "FOLD_VALIDATION" | "DEGRADE_TO_NEW";
type InFlightMention = { id: string; seq: number; text: string; createdAt: string };
type NodeState = { pendingCount: number; runningCount: number; completedCount: number; awaitingValidationCount: number };

class RuntimeJobDeferredError extends Error {
  constructor(readonly delayMs = 1_500, message = "Runtime job deferred while an active Orchestrator run reaches a safe boundary") {
    super(message);
    this.name = "RuntimeJobDeferredError";
  }
}

@Injectable()
export class RuntimeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RuntimeService.name);
  private readonly workerId = `runtime-worker-${nanoid(8)}`;
  private workerTimer: ReturnType<typeof setInterval> | undefined;
  private readonly activeJobAbortControllers = new Map<string, AbortController>();
  private draining = false;
  private workerStarted = false;
  private activeJobCount = 0;

  constructor(
    @Inject(PrismaService)
    private readonly prisma: PrismaService,
    @Inject(RealtimeService)
    private readonly realtime: RealtimeService,
    @Inject(LlmService)
    private readonly llm: LlmService,
    @Optional()
    @Inject(CodeAgentAdapterService)
    private readonly codeAgentAdapter?: Pick<CodeAgentAdapterService, "runCodeTask">,
    @Optional()
    @Inject(CodeAgentBackendRegistry)
    private readonly codeAgentBackendRegistry?: Pick<CodeAgentBackendRegistry, "resolve">,
    @Optional()
    @Inject(RuntimeConfigService)
    private readonly runtimeConfig?: Pick<RuntimeConfigService, "getEffectiveConfig">,
    @Optional()
    @Inject(ObservabilityService)
    private readonly observability?: ObservabilityService,
    @Optional()
    @Inject(ContextManagerService)
    private contextManager?: ContextManagerService,
    @Optional()
    @Inject(MemoryManagerService)
    private memoryManager?: MemoryManagerService,
    @Optional()
    @Inject(ToolRuntimeService)
    private toolRuntime?: ToolRuntimeService,
    @Optional()
    @Inject(AgentRuntimeService)
    private agentRuntime?: AgentRuntimeService,
    @Optional()
    @Inject(ConfigService)
    private readonly config: ConfigService = new ConfigService(),
    @Optional()
    @Inject(UiAgentRuntimeService)
    private uiAgentRuntime?: UiAgentRuntimeService,
    @Optional()
    @Inject(ExcalidrawRenderService)
    private excalidrawRenderer?: ExcalidrawRenderService,
    @Optional()
    @Inject(KnowledgeService)
    private knowledgeService?: KnowledgeService,
    @Optional()
    @Inject(DeploymentsService)
    private deployments?: DeploymentsService
  ) {}

  async onModuleInit() {
    if (!this.config.shouldRunRuntimeWorker) return;
    await this.startWorker();
  }

  async startWorker() {
    if (this.workerStarted) return;
    this.workerStarted = true;
    await this.recoverExpiredRuntimeState();
    this.logger.log(`Runtime worker started in ${this.config.runtimeWorkerMode} mode`);
    this.workerTimer = setInterval(() => {
      void this.drainQueue();
    }, RUNTIME_JOB_POLL_MS);
    void this.drainQueue();
  }

  onModuleDestroy() {
    if (this.workerTimer) clearInterval(this.workerTimer);
    this.workerTimer = undefined;
    this.workerStarted = false;
    for (const abortController of this.activeJobAbortControllers.values()) {
      abortController.abort();
    }
  }

  async enqueueMessage(message: ChatMessage) {
    const existing = await this.findExistingMessageJob(message.id);
    if (existing) return toRuntimeJobSummary(existing);
    const route = await this.resolveRuntimeRoute(message.conversationId, message.mentions ?? []);
    if (route.mode === "none") {
      return toRuntimeJobSummary({
        id: `runtime-job-noop-${message.id}`,
        status: "completed",
        targetType: "message",
        targetId: message.id
      });
    }
    try {
      await this.createImmediateBusyNoticeIfNeeded(message);
      const job = await this.prisma.runtimeJob.create({
        data: {
          id: `runtime-job-${nanoid(10)}`,
          kind: "message",
          status: "queued",
          targetType: "message",
          targetId: message.id,
          payload: { message } as unknown as Prisma.InputJsonValue,
          maxAttempts: 3
        }
      });
      if (this.config.shouldRunRuntimeWorker) void this.drainQueue();
      return toRuntimeJobSummary(job);
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      const job = await this.findExistingMessageJob(message.id);
      if (!job) throw error;
      return toRuntimeJobSummary(job);
    }
  }

  async acknowledgeMentionedAgents(message: ChatMessage) {
    if (message.sender.type !== "user") return [];
    if (!await this.isProjectConversation(message.conversationId)) return [];
    if (stringArrayish(message.mentions).length === 0) return [];
    const route = await this.resolveRuntimeRoute(message.conversationId, message.mentions ?? []);
    const targets = route.mode === "orchestrator"
      ? [{ mention: route.triggerReason, agent: await this.resolveAgentIdentityById("agent-orchestrator") }]
      : route.mode === "direct_agent" || route.mode === "direct_code_agent"
        ? [{ mention: route.triggerReason, agent: await this.resolveAgentIdentityById(route.targetAgentId) }]
        : [];
    const acknowledgements: ChatMessage[] = [];
    for (const target of targets) {
      if (!target.agent) continue;
      acknowledgements.push(await this.createAgentMessage(
        message.conversationId,
        [createMarkdownBlock(`block-${nanoid(8)}`, acknowledgementReplyFor(message.id, target.agent.id))],
        target.agent,
        "sent",
        {
          kind: "agent_acknowledgement",
          triggerMessageId: message.id,
          triggerMention: target.mention
        }
      ));
    }
    return acknowledgements;
  }

  async cancelJob(jobId: string) {
    const job = await this.prisma.runtimeJob.update({
      where: { id: jobId },
      data: { cancelRequested: true }
    });
    this.activeJobAbortControllers.get(job.id)?.abort();
    if (job.status === "queued" || job.status === "retrying") {
      await this.markJobCancelled(job.id);
      return this.prisma.runtimeJob.findUniqueOrThrow({ where: { id: job.id } });
    }
    return job;
  }

  async getJob(jobId: string) {
    return this.prisma.runtimeJob.findFirst({ where: { id: jobId, deletedAt: null } });
  }

  private async findExistingMessageJob(messageId: string) {
    return this.prisma.runtimeJob.findFirst({
      where: {
        kind: "message",
        targetType: "message",
        targetId: messageId,
        deletedAt: null
      }
    });
  }

  async handleMessage(message: ChatMessage, options: RuntimeExecutionOptions = {}) {
    try {
      await this.dispatchMessage(message, options);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (options.emitFailureMessage !== false) await this.createRuntimeFailureMessage(message, errorMessage);
      await this.observability?.system({
        level: "error",
        scope: "runtime.handle_message",
        message: "Runtime message handling failed",
        payload: { conversationId: message.conversationId, messageId: message.id, error: errorMessage }
      });
      if (options.throwOnRuntimeError) throw error;
    }
  }

  async getRuns(conversationId?: string) {
    const rows = await this.prisma.orchestratorRun.findMany({
      where: { deletedAt: null, ...(conversationId ? { conversationId } : {}) },
      orderBy: { startedAt: "desc" }
    });
    return rows.map((row) => row.workingMemory as unknown as RuntimeWorkingMemory);
  }

  async getRun(runId: string) {
    const row = await this.prisma.orchestratorRun.findFirst({ where: { id: runId, deletedAt: null } });
    return row?.workingMemory as unknown as RuntimeWorkingMemory | undefined;
  }

  async enqueueRunRetry(runId: string) {
    const row = await this.prisma.orchestratorRun.findFirst({ where: { id: runId, deletedAt: null } });
    if (!row) throw new Error("Orchestrator run not found");
    const run = row.workingMemory as unknown as RuntimeWorkingMemory;
    if (run.status !== "failed") throw new Error("Only failed orchestrator runs can be retried from current node");
    const triggerMessageId = readRunTriggerMessageId(run);
    if (!triggerMessageId) throw new Error("Failed run has no trigger message to replay");
    const retryFromNode = run.currentNode;
    const resumed = prepareRunForResume(run, { resetRunningWithoutOutput: true });
    resumed.runMeta = {
      ...(resumed.runMeta ?? {}),
      retryRequestedAt: new Date().toISOString(),
      retryFromNode
    };
    await this.recoverDanglingAgentRunsForRetry(run.id);
    await this.updateRun(resumed, { status: "running", waitingOn: null });
    const job = await this.prisma.runtimeJob.create({
      data: {
        id: `runtime-job-${nanoid(10)}`,
        kind: "orchestrator_run_retry",
        status: "queued",
        targetType: "orchestrator_run",
        targetId: `${runId}:${nanoid(8)}`,
        payload: { runId, triggerMessageId } as unknown as Prisma.InputJsonValue,
        maxAttempts: 1
      }
    });
    if (this.config.shouldRunRuntimeWorker) void this.drainQueue();
    return { run: resumed, runtimeJob: toRuntimeJobSummary(job) };
  }

  private async recoverDanglingAgentRunsForRetry(runId: string) {
    await this.prisma.agentRun.updateMany({
      where: { runId, status: "running", deletedAt: null },
      data: {
        status: "failed",
        output: { error: "Recovered dangling running AgentRun before retrying the orchestrator run." } as Prisma.InputJsonValue,
        completedAt: new Date()
      }
    });
  }

  private async drainQueue() {
    if (this.draining) return;
    this.draining = true;
    try {
      await this.recoverExpiredRuntimeState();
      const concurrency = Math.max(1, this.config.runtimeWorkerConcurrency);
      while (this.activeJobCount < concurrency) {
        const job = await this.claimNextJob();
        if (!job) break;
        this.activeJobCount += 1;
        void this.processJob(job)
          .catch((error) => {
            this.logger.error(`Runtime job ${job.id} crashed outside normal handler`, error instanceof Error ? error.stack : String(error));
          })
          .finally(() => {
            this.activeJobCount = Math.max(0, this.activeJobCount - 1);
            void this.drainQueue();
          });
      }
    } finally {
      this.draining = false;
    }
  }

  private async recoverExpiredRuntimeState() {
    await this.recoverStaleCodeTaskRuns();
    await this.recoverExpiredJobs();
  }

  private async recoverExpiredJobs() {
    const now = new Date();
    await this.recoverCancelledRuntimeJobs(now);
    await this.prisma.runtimeJob.updateMany({
      where: {
        status: "running",
        leaseExpiresAt: { lt: now },
        cancelRequested: false,
        deletedAt: null
      },
      data: {
        status: "retrying",
        availableAt: now,
        leaseOwner: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
        error: "Recovered expired runtime lease"
      }
    });
  }

  private async recoverCancelledRuntimeJobs(now: Date) {
    const cancelledJobs = await this.prisma.runtimeJob.findMany({
      where: {
        cancelRequested: true,
        deletedAt: null,
        OR: [
          { status: { in: ["queued", "retrying"] } },
          { status: "running", leaseExpiresAt: { lt: now } }
        ]
      },
      orderBy: { createdAt: "asc" }
    });
    for (const job of cancelledJobs) {
      await this.markJobCancelled(job.id);
    }
  }

  private async recoverStaleCodeTaskRuns() {
    const now = new Date();
    const expiredRuns = await this.prisma.codeTaskRun.findMany({
      where: {
        status: { in: ["running", "cancelling"] },
        leaseExpiresAt: { lt: now },
        deletedAt: null
      },
      select: { worktreePath: true }
    });
    const staleWorktreePaths = [...new Set(expiredRuns.map((run) => run.worktreePath).filter(Boolean))];
    if (staleWorktreePaths.length) {
      await this.prisma.runtimeLock.deleteMany({
        where: {
          resourceType: "workspace",
          resourceId: { in: staleWorktreePaths },
          heartbeatAt: { lt: new Date(now.getTime() - CODE_TASK_RUN_LEASE_MS) }
        }
      });
    }
    await this.prisma.codeTaskRun.updateMany({
      where: {
        status: { in: ["running", "cancelling"] },
        leaseExpiresAt: { lt: now },
        deletedAt: null
      },
      data: {
        status: "stale",
        completedAt: now,
        leaseOwner: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
        statusMessage: "Recovered stale Code Agent execution after worker lease expired"
      }
    });
  }

  private async claimNextJob() {
    const now = new Date();
    const leaseExpiresAt = new Date(now.getTime() + RUNTIME_JOB_LEASE_MS);
    const staleRunning = await this.prisma.runtimeJob.findFirst({
      where: {
        status: "running",
        leaseExpiresAt: { lt: now },
        cancelRequested: false,
        deletedAt: null
      },
      orderBy: { createdAt: "asc" }
    });
    const queued = staleRunning ?? await this.prisma.runtimeJob.findFirst({
      where: {
        status: { in: ["queued", "retrying"] },
        availableAt: { lte: now },
        cancelRequested: false,
        deletedAt: null
      },
      orderBy: { createdAt: "asc" }
    });
    if (!queued) return null;
    const claimed = await this.prisma.runtimeJob.updateMany({
      where: {
        id: queued.id,
        cancelRequested: false,
        deletedAt: null,
        OR: [
          { status: { in: ["queued", "retrying"] } },
          { status: "running", leaseExpiresAt: { lt: now } }
        ]
      },
      data: {
        status: "running",
        attempts: { increment: 1 },
        leaseOwner: this.workerId,
        leaseExpiresAt,
        heartbeatAt: now,
        startedAt: queued.startedAt ?? now,
        error: null
      }
    });
    if (claimed.count !== 1) return null;
    return this.prisma.runtimeJob.findUnique({ where: { id: queued.id } });
  }

  private async processJob(job: NonNullable<Awaited<ReturnType<RuntimeService["claimNextJob"]>>>) {
    const abortController = new AbortController();
    const heartbeat = setInterval(() => {
      void this.prisma.runtimeJob.updateMany({
        where: { id: job.id, status: "running", leaseOwner: this.workerId, deletedAt: null },
        data: {
          heartbeatAt: new Date(),
          leaseExpiresAt: new Date(Date.now() + RUNTIME_JOB_LEASE_MS)
        }
      });
    }, RUNTIME_JOB_HEARTBEAT_MS);
    const cancelPoll = setInterval(() => {
      void this.abortIfJobCancellationRequested(job.id, abortController);
    }, RUNTIME_JOB_CANCEL_POLL_MS);
    try {
      if (job.cancelRequested) {
        await this.markJobCancelled(job.id);
        return;
      }
      this.activeJobAbortControllers.set(job.id, abortController);
      if (job.kind === "message") {
        const message = asRecord(job.payload)?.message as ChatMessage | undefined;
        if (!message?.id || !message.conversationId) throw new Error("Runtime message job payload is invalid");
        await this.dispatchMessage(message, {
          signal: abortController.signal,
          emitFailureMessage: false,
          throwOnRuntimeError: true,
          resumeExistingRun: true
        });
      } else if (job.kind === "orchestrator_run_retry") {
        const runId = stringishOrUndefined(asRecord(job.payload)?.runId);
        if (!runId) throw new Error("Runtime retry job payload is invalid");
        await this.dispatchRunRetry(runId, {
          signal: abortController.signal,
          emitFailureMessage: true,
          throwOnRuntimeError: true
        });
      } else if (job.kind === "agent_tool_approval_resume") {
        const toolRunId = stringishOrUndefined(asRecord(job.payload)?.toolRunId);
        if (!toolRunId) throw new Error("Runtime agent tool approval resume job payload is invalid");
        await this.resumeAgentToolApproval(toolRunId, {
          signal: abortController.signal,
          emitFailureMessage: true,
          throwOnRuntimeError: true,
          resumeExistingRun: true
        });
      } else {
        throw new Error(`Unsupported runtime job kind: ${job.kind}`);
      }
      if (abortController.signal.aborted || (await this.isJobCancellationRequested(job.id))) {
        await this.markJobCancelled(job.id);
        return;
      }
      await this.prisma.runtimeJob.update({
        where: { id: job.id },
        data: {
          status: "completed",
          completedAt: new Date(),
          leaseOwner: null,
          leaseExpiresAt: null,
          heartbeatAt: null,
          error: null
        }
      });
    } catch (error) {
      if (error instanceof RuntimeJobDeferredError) {
        await this.prisma.runtimeJob.update({
          where: { id: job.id },
          data: {
            status: "retrying",
            attempts: { decrement: 1 },
            availableAt: new Date(Date.now() + error.delayMs),
            leaseOwner: null,
            leaseExpiresAt: null,
            heartbeatAt: null,
            error: error.message
          }
        });
        return;
      }
      if (abortController.signal.aborted || (await this.isJobCancellationRequested(job.id))) {
        await this.markJobCancelled(job.id);
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      const attempts = job.attempts;
      const canRetry = attempts < job.maxAttempts;
      const runtimeMessage = asRecord(job.payload)?.message as ChatMessage | undefined;
      if (!canRetry && runtimeMessage?.conversationId) {
        await this.createRuntimeFailureMessage(runtimeMessage, message);
      }
      await this.prisma.runtimeJob.update({
        where: { id: job.id },
        data: {
          status: canRetry ? "retrying" : "failed",
          availableAt: canRetry ? new Date(Date.now() + retryDelayMs(attempts)) : new Date(),
          failedAt: canRetry ? null : new Date(),
          leaseOwner: null,
          leaseExpiresAt: null,
          heartbeatAt: null,
          error: message
        }
      });
    } finally {
      clearInterval(heartbeat);
      clearInterval(cancelPoll);
      this.activeJobAbortControllers.delete(job.id);
    }
  }

  private async resumeAgentToolApproval(toolRunId: string, options: RuntimeExecutionOptions = {}) {
    const { output, resumeState } = await this.agent().resumeApprovedToolRun(toolRunId);
    const outputMessage = await this.createAgentMessage(
      resumeState.conversationId,
      buildAgentOutputBlocks(output),
      resumeState.agent,
      output.status === "failed" ? "failed" : "sent",
      {
        kind: "agent_tool_approval_resumed",
        toolRunId,
        ...(resumeState.runId ? { runId: resumeState.runId } : {}),
        ...(resumeState.agentRunId ? { agentRunId: resumeState.agentRunId } : {})
      }
    );
    const waitingForToolApproval = isWaitingForAgentToolApprovalResult(output);
    if (resumeState.agentRunId) {
      await this.prisma.agentRun.updateMany({
        where: { id: resumeState.agentRunId, deletedAt: null },
        data: {
          status: output.status,
          output: output as unknown as Prisma.InputJsonValue,
          internalTraceRef: output.internalTraceRef ?? null,
          completedAt: waitingForToolApproval ? null : new Date()
        }
      });
      const eventName = waitingForToolApproval
        ? "agent_run.waiting_tool_approval"
        : output.status === "failed"
          ? "agent_run.failed"
          : "agent_run.completed";
      await this.realtime.emit("conversation", resumeState.conversationId, eventName, {
        agentRunId: resumeState.agentRunId,
        agentId: resumeState.agent.id,
        runId: resumeState.runId,
        resumedFromToolRunId: toolRunId
      });
    }
    if (resumeState.mode !== "assignment" || !resumeState.runId || !resumeState.agentRunId) return output;

    const assignment = assignmentFromResumeTask(resumeState.task);
    if (!waitingForToolApproval) {
      await this.appendAssignmentRunBrief({
        runId: resumeState.runId,
        conversationId: resumeState.conversationId,
        assignment,
        agent: resumeState.agent,
        ownerUserId: resumeState.ownerUserId,
        agentRunId: resumeState.agentRunId,
        outputMessageId: outputMessage.id,
        output
      });
    }

    const row = await this.prisma.orchestratorRun.findFirst({ where: { id: resumeState.runId, deletedAt: null } });
    if (!row) return output;
    let run = row.workingMemory as unknown as RuntimeWorkingMemory;
    const workItems = run.workItems ?? [];
    if (waitingForToolApproval) {
      run = {
        ...run,
        workItems: workItems.map((item) => item.workItemId === assignment.workItemId
          ? { ...item, status: "running", outputMessageId: outputMessage.id, validation: undefined }
          : item),
        agentRuns: [
          ...(run.agentRuns ?? []),
          {
            workItemId: assignment.workItemId,
            agentId: resumeState.agent.id,
            status: output.status,
            outputMessageId: outputMessage.id,
            agentRunId: resumeState.agentRunId,
            resumedFromToolRunId: toolRunId,
            waitingToolApproval: asRecord(output.memoryPatch)?.waitingToolApproval ?? null
          }
        ],
        runMeta: {
          ...(run.runMeta ?? {}),
          pendingAgentToolApproval: asRecord(output.memoryPatch)?.waitingToolApproval ?? null
        }
      };
      await this.updateRun(run, {
        status: "waiting_tool",
        waitingOn: {
          type: "tool_approval",
          workItemId: assignment.workItemId,
          agentId: resumeState.agent.id,
          agentRunId: resumeState.agentRunId,
          outputMessageId: outputMessage.id,
          approval: asRecord(output.memoryPatch)?.waitingToolApproval ?? null
        }
      });
      return output;
    }
    run = {
      ...run,
      status: "running",
      workItems: workItems.map((item) => item.workItemId === assignment.workItemId
        ? {
            ...item,
            status: output.status === "completed" ? "completed" : "failed",
            outputMessageId: outputMessage.id,
            validation: undefined
          }
        : item),
      agentRuns: [
        ...(run.agentRuns ?? []),
        {
          workItemId: assignment.workItemId,
          agentId: resumeState.agent.id,
          status: output.status,
          outputMessageId: outputMessage.id,
          agentRunId: resumeState.agentRunId,
          resumedFromToolRunId: toolRunId
        }
      ],
      runMeta: {
        ...(run.runMeta ?? {}),
        lastAgentToolApprovalResume: {
          at: new Date().toISOString(),
          toolRunId,
          agentRunId: resumeState.agentRunId,
          workItemId: assignment.workItemId,
          status: output.status
        }
      }
    };
    await this.updateRun(run, { status: "running", waitingOn: null });
    run = await this.transitionRun(run, "validate", "Agent 工具审批完成，回到 validate 校验执行结果。", {
      toolRunId,
      agentRunId: resumeState.agentRunId,
      outputMessageId: outputMessage.id,
      status: output.status
    });
    const triggerMessageId = readRunTriggerMessageId(run);
    if (!triggerMessageId) return output;
    const trigger = await this.prisma.message.findFirst({
      where: { id: triggerMessageId, conversationId: run.conversationId, deletedAt: null }
    });
    if (!trigger) return output;
    await this.startOrchestratorRun(toChatMessage(trigger), options);
    return output;
  }

  private async dispatchMessage(message: ChatMessage, options: RuntimeExecutionOptions = {}) {
    const route = await this.resolveRuntimeRoute(message.conversationId, message.mentions ?? []);
    await this.observability?.system({
      level: "info",
      scope: "runtime",
      message: "Runtime route decided",
      payload: { conversationId: message.conversationId, messageId: message.id, route }
    });
    if (route.mode === "orchestrator") {
      await this.startOrchestratorRun(message, options, route);
      return;
    }
    if (route.mode === "direct_code_agent") {
      if (await this.isAgentDirectConversation(message.conversationId) && isMentionOnlyUserText(message)) {
        await this.createDirectMentionOnlyNotice(message, this.codeAgentIdentity(route.targetAgentId));
        return;
      }
      await this.replyCodeAgent(message, route.targetAgentId, options);
      return;
    }
    if (route.mode === "direct_agent") {
      if (await this.isAgentDirectConversation(message.conversationId) && isMentionOnlyUserText(message)) {
        const agent = await this.resolveAgentIdentityById(route.targetAgentId);
        if (agent) await this.createDirectMentionOnlyNotice(message, agent);
        return;
      }
      await this.replyInternalAgent(message, route.targetAgentId);
    }
  }

  private async dispatchRunRetry(runId: string, options: RuntimeExecutionOptions = {}) {
    const row = await this.prisma.orchestratorRun.findFirst({ where: { id: runId, deletedAt: null } });
    const run = row?.workingMemory as unknown as RuntimeWorkingMemory | undefined;
    if (!run) throw new Error("Orchestrator run not found");
    const triggerMessageId = readRunTriggerMessageId(run);
    if (!triggerMessageId) throw new Error("Failed run has no trigger message to replay");
    const message = await this.prisma.message.findFirst({ where: { id: triggerMessageId, conversationId: run.conversationId, deletedAt: null } });
    if (!message) throw new Error("Original trigger message is not available");
    await this.startOrchestratorRun(toChatMessage(message), { ...options, resumeExistingRun: true });
  }

  private async resolveRuntimeRoute(conversationId: string, mentions: string[]): Promise<RuntimeRouteDecision> {
    if (!await this.isProjectConversation(conversationId)) {
      const directCodeAgentId = await this.resolveDirectCodeAgent(conversationId);
      if (directCodeAgentId) {
        return {
          mode: "direct_code_agent",
          triggerReason: "direct_code_agent_chat",
          targetAgentId: directCodeAgentId,
          explicitMentionedAgents: [],
          ignoredMentions: [],
          warnings: []
        };
      }
      const directInternalAgent = await this.resolveDirectInternalAgent(conversationId);
      if (directInternalAgent) {
        return {
          mode: "direct_agent",
          triggerReason: "direct_agent_chat",
          targetAgentId: directInternalAgent,
          explicitMentionedAgents: [],
          ignoredMentions: [],
          warnings: []
        };
      }
      return { mode: "none", triggerReason: "no_mention", explicitMentionedAgents: [], ignoredMentions: [], warnings: [] };
    }

    const normalizedMentions = uniqueStrings(mentions.map(normalizeMention).filter(Boolean));
    const hasAllMention = normalizedMentions.includes("all");
    const hasOrchestratorMention = normalizedMentions.some((mention) => mention === "orchestrator" || mention === "agent-orchestrator");
    const mentionedCodeAgentIds = new Set(normalizedMentions.map((mention) => CODE_AGENT_MENTION_TO_AGENT[mention]).filter(Boolean));
    const targets = await this.resolveAcknowledgementTargets(conversationId, normalizedMentions.filter((mention) => !ORCHESTRATOR_MENTIONS.has(mention)));
    const effectiveCodeAgentIds = new Set(targets.map((target) => target.agent.id).filter(isCodeAgentRequest));
    const explicitMentionedAgents = targets.map(({ mention, agent }) => ({
      mention,
      id: agent.id,
      displayName: agent.name,
      kind: "agent" as const,
      agentType: agent.type,
      provider: agent.provider
    }));
    const targetMentionSet = new Set(targets.map((target) => target.mention));
    const ignoredMentions = normalizedMentions.filter((mention) => !ORCHESTRATOR_MENTIONS.has(mention) && !targetMentionSet.has(mention));
    const warnings = ignoredMentions.map((mention) => `未识别或不可用的 @${mention}`);
    if (hasAllMention || hasOrchestratorMention) {
      return {
        mode: "orchestrator",
        triggerReason: hasAllMention ? "all_mention" : "explicit_orchestrator",
        explicitMentionedAgents,
        ignoredMentions,
        warnings
      };
    }
    if (mentionedCodeAgentIds.size > 1 || effectiveCodeAgentIds.size > 1) {
      return {
        mode: "orchestrator",
        triggerReason: "code_agent_conflict",
        explicitMentionedAgents,
        ignoredMentions,
        warnings: [...warnings, "同一项目第一版只能绑定一个 Code Agent，不能同时直接调用 Codex 和 OpenCode。"]
      };
    }
    const uniqueTargets = uniqueTargetsByAgentId(targets);
    if (uniqueTargets.length > 1) {
      return {
        mode: "orchestrator",
        triggerReason: "multi_agent_mention",
        explicitMentionedAgents,
        ignoredMentions,
        warnings
      };
    }
    if (uniqueTargets.length === 1) {
      const target = uniqueTargets[0]!;
      if (target.agent.type === "code") {
        return {
          mode: "direct_code_agent",
          triggerReason: "single_code_agent_mention",
          targetAgentId: target.agent.id,
          explicitMentionedAgents,
          ignoredMentions,
          warnings
        };
      }
      return {
        mode: "direct_agent",
        triggerReason: "single_agent_mention",
        targetAgentId: target.agent.id,
        explicitMentionedAgents,
        ignoredMentions,
        warnings
      };
    }
    return { mode: "none", triggerReason: "no_mention", explicitMentionedAgents: [], ignoredMentions, warnings };
  }

  private async isProjectConversation(conversationId: string) {
    const conversation = await this.prisma.conversation.findFirst({
      where: { id: conversationId, deletedAt: null },
      select: { type: true }
    });
    return conversation?.type === "project";
  }

  private async isAgentDirectConversation(conversationId: string) {
    const conversation = await this.prisma.conversation.findFirst({
      where: { id: conversationId, deletedAt: null },
      select: { type: true }
    });
    return conversation?.type === "agent_direct";
  }

  private async createDirectMentionOnlyNotice(message: ChatMessage, agent: RuntimeAgentIdentity) {
    await this.createAgentMessage(
      message.conversationId,
      [createMarkdownBlock(`block-${nanoid(8)}`, "这里会直接发送给当前 Agent，请输入要处理的内容。")],
      agent,
      "sent",
      {
        kind: "direct_mention_only_notice",
        triggerMessageId: message.id
      }
    );
  }

  private async routesMessageToOrchestrator(conversationId: string, mentions: unknown) {
    const route = await this.resolveRuntimeRoute(conversationId, stringArrayish(mentions));
    return route.mode === "orchestrator";
  }

  private async resolveAcknowledgementTargets(conversationId: string, mentions: string[]) {
    const targets: Array<{ mention: string; agent: RuntimeAgentIdentity }> = [];
    const seenAgentIds = new Set<string>();
    for (const rawMention of mentions) {
      const mention = normalizeMention(rawMention);
      const agent = await this.resolveMentionedAgentIdentity(conversationId, mention);
      if (!agent || seenAgentIds.has(agent.id)) continue;
      seenAgentIds.add(agent.id);
      targets.push({ mention, agent });
    }
    return targets;
  }

  private async resolveMentionedAgentIdentity(conversationId: string, mention: string): Promise<RuntimeAgentIdentity | undefined> {
    mention = normalizeMention(mention);
    if (mention === "orchestrator" || mention === "all") return this.resolveAgentIdentityById("agent-orchestrator");
    const isProject = await this.isProjectConversation(conversationId);
    if (isProject && isDeployMention(mention)) {
      return this.resolveAgentIdentityById(await this.resolveConversationCodeAgentId(conversationId) ?? "agent-codex");
    }
    const codeAgentId = CODE_AGENT_MENTION_TO_AGENT[mention];
    if (codeAgentId) {
      const conversationCodeAgentId = await this.resolveConversationCodeAgentId(conversationId);
      if (conversationCodeAgentId && conversationCodeAgentId !== codeAgentId) return undefined;
      return this.resolveAgentIdentityById(conversationCodeAgentId ?? codeAgentId);
    }
    if (isProject) return this.resolveMentionedConversationAgentByName(conversationId, mention);
    const internalAgentId = INTERNAL_MENTION_TO_AGENT[mention] ?? (mention.startsWith("agent-") ? mention : `agent-${mention}`);
    const directAgent = await this.resolveAgentIdentityById(internalAgentId);
    return directAgent ?? await this.resolveMentionedConversationAgentByName(conversationId, mention) ?? this.resolveMentionedRegisteredAgentByName(mention);
  }

  private async resolveMentionedConversationAgentByName(conversationId: string, mention: string): Promise<RuntimeAgentIdentity | undefined> {
    const members = await this.prisma.conversationMember.findMany({
      where: { conversationId, memberType: "agent", deletedAt: null },
      select: { memberId: true }
    });
    const identities: RuntimeAgentIdentity[] = [];
    for (const member of members) {
      const identity = await this.resolveAgentIdentityById(member.memberId);
      if (identity) identities.push(identity);
    }
    return resolveAgentIdentityByMentionLookup(identities, mention);
  }

  private async resolveMentionedRegisteredAgentByName(mention: string): Promise<RuntimeAgentIdentity | undefined> {
    const agents = await this.prisma.agent.findMany({ where: { deletedAt: null } });
    return resolveAgentIdentityByMentionLookup(agents.map((agent) => this.agentToIdentity(agent)), mention);
  }

  private async resolveAgentIdentityById(agentId: string): Promise<RuntimeAgentIdentity | undefined> {
    if (agentId === "agent-codex" || agentId === "agent-opencode") return this.codeAgentIdentity(agentId);
    const agent = await this.prisma.agent.findFirst({ where: { id: agentId, deletedAt: null } });
    if (agent) return this.agentToIdentity(agent);
    if (agentId === "agent-orchestrator") return { id: "agent-orchestrator", name: "Orchestrator", avatar: "/avatars/agents/agent-v2-01.png", role: "主协调", type: "internal" };
    return undefined;
  }

  private async createRuntimeFailureMessage(message: ChatMessage, errorMessage: string) {
    const agent = await this.resolveRuntimeFailureAgent(message).catch(() => undefined);
    await this.createAgentMessage(
      message.conversationId,
      [createMarkdownBlock(`block-${nanoid(8)}`, `Agent 后台执行失败：${errorMessage}`)],
      agent,
      "failed"
    );
  }

  private async resolveRuntimeFailureAgent(message: ChatMessage): Promise<RuntimeAgentIdentity | undefined> {
    const route = await this.resolveRuntimeRoute(message.conversationId, message.mentions ?? []);
    if (route.mode === "direct_code_agent") return this.codeAgentIdentity(route.targetAgentId);
    if (route.mode === "direct_agent") return this.resolveAgentIdentityById(route.targetAgentId);
    if (route.mode === "orchestrator") return this.resolveAgentIdentityById("agent-orchestrator");
    return undefined;
  }

  private async abortIfJobCancellationRequested(jobId: string, abortController: AbortController) {
    if (abortController.signal.aborted) return;
    if (await this.isJobCancellationRequested(jobId)) abortController.abort();
  }

  private async isJobCancellationRequested(jobId: string) {
    const job = await this.prisma.runtimeJob.findUnique({
      where: { id: jobId },
      select: { cancelRequested: true, deletedAt: true }
    });
    return Boolean(job?.cancelRequested || job?.deletedAt);
  }

  private async markJobCancelled(jobId: string) {
    const existing = await this.prisma.runtimeJob.findUnique({ where: { id: jobId } });
    if (!existing) return;
    const associatedRun = await this.findOrchestratorRunForJob(existing);
    const associatedWorkingMemory = associatedRun?.workingMemory as unknown as RuntimeWorkingMemory | undefined;
    if (associatedWorkingMemory?.status === "completed") {
      await this.prisma.runtimeJob.update({
        where: { id: jobId },
        data: {
          status: "completed",
          cancelRequested: false,
          completedAt: new Date(),
          leaseOwner: null,
          leaseExpiresAt: null,
          heartbeatAt: null,
          error: null
        }
      });
      return;
    }
    const job = await this.prisma.runtimeJob.update({
      where: { id: jobId },
      data: {
        status: "cancelled",
        completedAt: new Date(),
        leaseOwner: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
        error: "Cancelled by request"
      }
    });
    await this.cancelOrchestratorRunForJob(job);
  }

  private async cancelOrchestratorRunForJob(job: { payload: unknown }) {
    const message = this.messageFromJobPayload(job.payload);
    if (!message?.id || !message.conversationId) return;
    const run = await this.findOrchestratorRunForJob(job);
    if (!run) return;
    const workingMemory = run.workingMemory as unknown as RuntimeWorkingMemory;
    if (isTerminalRunStatus(workingMemory.status)) return;
    const now = new Date();
    const cancelled = {
      ...workingMemory,
      status: "cancelled" as const,
      completedAt: now.toISOString(),
      waitingOn: { type: "runtime_job", reason: "Cancelled by request" }
    };
    await this.prisma.orchestratorRun.update({
      where: { id: run.id },
      data: {
        status: "cancelled",
        completedAt: now,
        waitingOn: cancelled.waitingOn as Prisma.InputJsonValue,
        workingMemory: cancelled as unknown as Prisma.InputJsonValue
      }
    });
    await this.realtime.emit("run", run.id, "run.updated", { run: cancelled });
    await this.realtime.emit("conversation", message.conversationId, "run.updated", { run: cancelled });
  }

  private async findOrchestratorRunForJob(job: { payload: unknown }) {
    const message = this.messageFromJobPayload(job.payload);
    if (!message?.id || !message.conversationId) return null;
    return this.findExistingOrchestratorRunForTrigger(message.conversationId, message.id);
  }

  private messageFromJobPayload(payload: unknown) {
    return asRecord(asRecord(payload)?.message) as ChatMessage | null;
  }

  private async startOrchestratorRun(message: ChatMessage, options: RuntimeExecutionOptions = {}, routeDecision?: RuntimeRouteDecision) {
    const startState = await this.withRuntimeLock(
      `orchestrator-conversation:${message.conversationId}`,
      "orchestrator_conversation",
      message.conversationId,
      15_000,
      () => this.prepareOrchestratorRunStart(message, options, routeDecision)
    );
    if ("deferMessageJob" in startState && startState.deferMessageJob) {
      throw new RuntimeJobDeferredError(startState.deferMs);
    }
    if (!startState.shouldRun) return;
    let run = startState.run;
    if (startState.created) {
      void this.memory().refreshChatMemory(message.conversationId).catch(() => null);
      await this.observability?.audit({
        action: "orchestrator.run.start",
        targetType: "orchestrator_run",
        targetId: run.id,
        payload: { conversationId: message.conversationId, triggerMessageId: message.id }
      });
      await this.realtime.emit("conversation", message.conversationId, "run.started", { run });
      await this.realtime.emit("run", run.id, "run.started", { run });
    } else if (startState.resumed) {
      await this.observability?.audit({
        action: "orchestrator.run.resume",
        targetType: "orchestrator_run",
        targetId: run.id,
        payload: { conversationId: message.conversationId, triggerMessageId: message.id, currentNode: run.currentNode }
      });
      await this.realtime.emit("conversation", message.conversationId, "run.updated", { run, reason: "resumed" });
      await this.realtime.emit("run", run.id, "run.updated", { run, reason: "resumed" });
    }

    try {
      if (run.currentNode === "wake") {
        run = await this.transitionRun(run, "understand", "wake 节点收到主协调触发消息，进入需求理解。");
      }
      let guard = 0;
      while (run.status === "running" && guard < 16) {
        guard += 1;
        run = await this.absorbInFlightMentions(run, message, options);
        if (run.status !== "running") break;
        if (run.currentNode === "wake") {
          run = await this.transitionRun(run, "understand", "wake 节点收到主协调触发消息，进入需求理解。");
        } else if (run.currentNode === "understand") {
          run = await this.runUnderstandNode(run, message, options);
        } else if (run.currentNode === "tools") {
          run = await this.runToolsNode(run, message);
        } else if (run.currentNode === "decompose") {
          run = await this.runDecomposeNode(run, message, options);
        } else if (run.currentNode === "assignment") {
          run = await this.runAssignmentNode(run, message, options);
        } else if (run.currentNode === "validate") {
          run = await this.runValidateNode(run, message, options);
        } else if (run.currentNode === "integrate") {
          run = await this.runIntegrateNode(run, message, options);
        } else if (run.currentNode === "summary") {
          run = await this.runSummaryNode(run, message, options);
        } else if (run.currentNode === "memory_manage") {
          break;
        } else if (run.currentNode === "ui_query") {
          break;
        }
      }
      if (guard >= 16 && run.status === "running") {
        throw new Error("Orchestrator state machine exceeded max transition guard");
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      await this.updateRun(run, { status: "failed", waitingOn: { error: errorMessage } });
      if (options.emitFailureMessage !== false) {
        await this.createAgentMessage(message.conversationId, [createMarkdownBlock(`block-${nanoid(8)}`, `Orchestrator 执行失败：${errorMessage}`)], undefined, "failed");
      }
      await this.observability?.system({
        level: "error",
        scope: "orchestrator",
        message: "Orchestrator run failed",
        payload: { runId: run.id, conversationId: message.conversationId, error: errorMessage }
      });
      if (options.throwOnRuntimeError) throw error;
    }
  }

  private async prepareOrchestratorRunStart(message: ChatMessage, options: RuntimeExecutionOptions, routeDecision?: RuntimeRouteDecision) {
    const existing = await this.findExistingOrchestratorRunForTrigger(message.conversationId, message.id);
    if (existing) {
      const existingRun = existing.workingMemory as unknown as RuntimeWorkingMemory;
      if (existingRun.status === "completed" || isWaitingRunStatus(existingRun.status)) {
        return { run: existingRun, created: false, resumed: false, shouldRun: false };
      }
      if (!options.resumeExistingRun) {
        return { run: existingRun, created: false, resumed: false, shouldRun: false };
      }
      const resumed = prepareRunForResume(existingRun);
      await this.updateRun(resumed, { status: "running", waitingOn: null });
      return { run: resumed, created: false, resumed: true, shouldRun: true };
    }

    const active = await this.findLatestIncompleteOrchestratorRun(message.conversationId);
    if (active) {
      const activeRun = active.workingMemory as unknown as RuntimeWorkingMemory;
      if (isMessageDeferredForRun(activeRun, message.id)) {
        return { run: activeRun, created: false, resumed: false, shouldRun: false, deferMessageJob: options.resumeExistingRun, deferMs: 2_500 };
      }
      if (activeRun.status === "waiting_user") {
        const mention = await this.inFlightMentionFromChatMessage(message);
        const disposition = await this.classifyInFlightDisposition(activeRun, [mention], options);
        if (disposition.scope === "new") {
          await this.deferAsNewRun(activeRun, [mention], `本轮还在等待你的确认：${waitingUserQuestion(activeRun)}`);
          return { run: activeRun, created: false, resumed: false, shouldRun: false, deferMessageJob: options.resumeExistingRun, deferMs: 2_500 };
        }
        if (disposition.action === "cancel") {
          await this.cancelRunAtBoundary(activeRun, [mention], disposition.reason);
          return { run: activeRun, created: false, resumed: false, shouldRun: false };
        }
        if (disposition.action === "restart") {
          const restarted = await this.supersedeRunAtBoundary(activeRun, [mention], disposition.mergedGoal ?? mention.text, disposition.reason);
          return { run: restarted, created: true, resumed: false, shouldRun: true };
        }
        await this.emitDispositionAck(activeRun, disposition, [mention]);
        const continued = prepareWaitingUserContinuation(activeRun, message, disposition.mergedGoal);
        await this.updateRun(continued.run, { status: "running", waitingOn: null });
        const run = await this.transitionRun(
          continued.run,
          continued.returnNode,
          "用户已补充信息，回到中断节点继续本轮 Run。",
          { continuationMessageId: message.id, originalTriggerMessageId: activeRun.triggerMessageId }
        );
        return { run, created: false, resumed: true, shouldRun: true };
      }
      if (isBusyRunStatus(activeRun.status)) {
        await this.createOrchestratorBusyNotice(message, activeRun);
        return { run: activeRun, created: false, resumed: false, shouldRun: false, deferMessageJob: options.resumeExistingRun, deferMs: 2_500 };
      }
      await this.createOrchestratorBusyNotice(message, activeRun);
      return { run: activeRun, created: false, resumed: false, shouldRun: false };
    }

    const goal = extractMessageText(message);
    const triggerSeq = await this.readMessageSeq(message.id, message.conversationId);
    const route = routeDecision ?? await this.resolveRuntimeRoute(message.conversationId, message.mentions ?? []);
    const triggerContext = buildOrchestratorTriggerContext(message, route);
    const run: RuntimeWorkingMemory = {
      ...createInitialRun(`run-${nanoid(10)}`, message.conversationId, goal),
      triggerMessageId: message.id,
      runMeta: {
        triggerMessageId: message.id,
        createdAt: new Date().toISOString(),
        lastConsumedSeq: triggerSeq,
        triggerContext,
        explicitMentionedAgents: route.explicitMentionedAgents
      },
      edgeHistory: [],
      agentRuns: [],
      toolRuns: [],
      uiInteractions: [],
      outputs: [],
      blockers: []
    };
    await this.prisma.orchestratorRun.create({
      data: {
        id: run.id,
        conversationId: run.conversationId,
        status: run.status,
        currentNode: run.currentNode,
        workingMemory: run as unknown as Prisma.InputJsonValue
      }
    });
    return { run, created: true, resumed: false, shouldRun: true };
  }

  private async createOrchestratorBusyNotice(message: ChatMessage, activeRun: RuntimeWorkingMemory) {
    const recentOrchestratorMessages = await this.prisma.message.findMany({
      where: {
        conversationId: message.conversationId,
        senderType: "agent",
        senderId: "agent-orchestrator",
        deletedAt: null
      },
      orderBy: { createdAt: "desc" },
      take: 20
    });
    const existing = recentOrchestratorMessages.some((item) => {
      const metadata = item.metadata as { kind?: string; triggerMessageId?: string } | null;
      return metadata?.kind === "orchestrator_busy_notice" && metadata.triggerMessageId === message.id;
    });
    if (existing) return;
    await this.createAgentMessage(
      message.conversationId,
      [createMarkdownBlock(`block-${nanoid(8)}`, `已收到。当前 Run 正在 ${activeRun.currentNode} 节点推进，这条消息不会打断正在执行的子 Agent；我会在下一个安全边界判断是并入本轮，还是排队成新任务。`)],
      undefined,
      "sent",
      {
        kind: "orchestrator_busy_notice",
        triggerMessageId: message.id,
        activeRunId: activeRun.id,
        activeNode: activeRun.currentNode,
        activeStatus: activeRun.status
      }
    );
  }

  private async createImmediateBusyNoticeIfNeeded(message: ChatMessage) {
    if (message.sender.type !== "user" || !await this.routesMessageToOrchestrator(message.conversationId, message.mentions)) return;
    const active = await this.findLatestIncompleteOrchestratorRun(message.conversationId);
    const activeRun = active?.workingMemory as RuntimeWorkingMemory | undefined;
    if (!activeRun || !isBusyRunStatus(activeRun.status)) return;
    await this.createOrchestratorBusyNotice(message, activeRun);
  }

  private async readMessageSeq(messageId: string, conversationId: string) {
    const row = await this.prisma.message.findFirst({
      where: { id: messageId, conversationId, deletedAt: null },
      select: { seq: true }
    });
    return row?.seq ?? 0;
  }

  private async inFlightMentionFromChatMessage(message: ChatMessage): Promise<InFlightMention> {
    return {
      id: message.id,
      seq: await this.readMessageSeq(message.id, message.conversationId),
      text: extractMessageText(message),
      createdAt: message.createdAt
    };
  }

  private inFlightMentionFromMessageRow(message: Message): InFlightMention {
    return {
      id: message.id,
      seq: message.seq,
      text: extractStoredMessageText(message),
      createdAt: message.createdAt.toISOString()
    };
  }

  private async absorbInFlightMentions(run: RuntimeWorkingMemory, triggerMessage: ChatMessage, options: RuntimeExecutionOptions = {}): Promise<RuntimeWorkingMemory> {
    const runMeta = asRecord(run.runMeta) ?? {};
    const since = typeof runMeta.lastConsumedSeq === "number" ? runMeta.lastConsumedSeq : 0;
    const deferredIds = new Set(stringArrayish(runMeta.deferredMessageIds));
    const continuationIds = new Set(asArray(runMeta.continuations).flatMap((item) => {
      const messageId = stringishOrUndefined(asRecord(item)?.messageId);
      return messageId ? [messageId] : [];
    }));
    const incoming = await this.prisma.message.findMany({
      where: {
        conversationId: run.conversationId,
        senderType: "user",
        seq: { gt: since },
        deletedAt: null
      },
      orderBy: { seq: "asc" }
    });
    const mentions: InFlightMention[] = [];
    for (const message of incoming) {
      if (message.id === run.triggerMessageId) continue;
      if (deferredIds.has(message.id) || continuationIds.has(message.id)) continue;
      if (!await this.routesMessageToOrchestrator(message.conversationId, message.mentions as unknown)) continue;
      mentions.push(this.inFlightMentionFromMessageRow(message));
    }
    if (mentions.length === 0) return run;

    const disposition = await this.classifyInFlightDisposition(run, mentions, options);
    if (disposition.scope === "new") return this.deferAsNewRun(run, mentions);
    if (disposition.action === "cancel") return this.cancelRunAtBoundary(run, mentions, disposition.reason);
    if (disposition.action === "restart") return this.supersedeRunAtBoundary(run, mentions, disposition.mergedGoal ?? joinedMentionText(mentions), disposition.reason);

    await this.emitDispositionAck(run, disposition, mentions);
    const state = describeNodeState(run);
    const strategy = resolveSteerStrategy(run.currentNode, state, disposition.modifier ?? "additive");
    if (strategy === "DEGRADE_TO_NEW") return this.deferAsNewRun(run, mentions, "当前 Run 已进入收尾阶段，这条补充将作为新任务排队处理。");
    return this.applySteerAction(run, strategy, mentions, disposition.mergedGoal ?? joinedMentionText(mentions), triggerMessage);
  }

  private async classifyInFlightDisposition(run: RuntimeWorkingMemory, mentions: InFlightMention[], options: RuntimeExecutionOptions = {}): Promise<InFlightDisposition> {
    try {
      const latest = mentions[mentions.length - 1];
      const context = latest ? await this.context().buildNodeContext({
        conversationId: run.conversationId,
        triggerMessageId: latest.id,
        node: run.currentNode,
        run,
        currentEvent: {
          incomingMessages: mentions,
          nodeState: describeNodeState(run)
        }
      }) : undefined;
      return await this.llm.generateJson<InFlightDisposition>({
        callerType: "orchestrator_node",
        callerId: `${run.id}:in_flight_disposition:${latest?.id ?? nanoid(6)}`,
        schemaName: "orchestrator_in_flight_disposition",
        schema: inFlightDispositionSchema,
        systemPrompt: inFlightDispositionPrompt(),
        ...(options.signal ? { signal: options.signal } : {}),
        userPrompt: JSON.stringify({
          currentRun: {
            runId: run.id,
            goal: run.goal,
            status: run.status,
            currentNode: run.currentNode,
            nodeState: describeNodeState(run),
            understanding: run.understanding ?? null,
            workItems: run.workItems ?? [],
            recentOutputs: run.outputs ?? [],
            waitingOn: run.waitingOn ?? null
          },
          previousSchedulingAndResults: run.edgeHistory ?? [],
          incomingMessages: mentions,
          context
        }, null, 2)
      });
    } catch {
      return {
        scope: "current",
        action: "continue",
        modifier: "additive",
        reason: "无法稳定判断归属，按安全策略作为本轮补充处理。",
        mergedGoal: joinedMentionText(mentions)
      };
    }
  }

  private async emitDispositionAck(run: RuntimeWorkingMemory, disposition: InFlightDisposition, mentions: InFlightMention[], extraLine?: string) {
    const triggerMessageIds = mentions.map((item) => item.id);
    const recentOrchestratorMessages = await this.prisma.message.findMany({
      where: {
        conversationId: run.conversationId,
        senderType: "agent",
        senderId: "agent-orchestrator",
        deletedAt: null
      },
      orderBy: { createdAt: "desc" },
      take: 30
    });
    const existing = recentOrchestratorMessages.some((item) => {
      const metadata = item.metadata as { kind?: string; triggerMessageIds?: string[] } | null;
      return metadata?.kind === "orchestrator_steer_ack"
        && sameStringSet(metadata.triggerMessageIds ?? [], triggerMessageIds);
    });
    if (existing) return;
    await this.createAgentMessage(
      run.conversationId,
      [createMarkdownBlock(`block-${nanoid(8)}`, formatDispositionAck(disposition, extraLine))],
      undefined,
      "sent",
      {
        kind: "orchestrator_steer_ack",
        runId: run.id,
        triggerMessageIds,
        disposition
      }
    );
  }

  private async deferAsNewRun(run: RuntimeWorkingMemory, mentions: InFlightMention[], extraLine?: string) {
    const updated = appendRunMetaMessages(run, mentions, {
      lastConsumedSeq: maxMentionSeq(mentions),
      deferredMessageIds: uniqueStrings([...stringArrayish(run.runMeta?.deferredMessageIds), ...mentions.map((item) => item.id)])
    });
    await this.updateRun(updated);
    await this.emitDispositionAck(updated, { scope: "new", reason: "该消息更像独立的新需求。" }, mentions, extraLine);
    return updated;
  }

  private async cancelRunAtBoundary(run: RuntimeWorkingMemory, mentions: InFlightMention[], reason: string) {
    const now = new Date().toISOString();
    const next = appendContinuations(run, mentions, {
      disposition: { scope: "current", action: "cancel", reason },
      lastConsumedSeq: maxMentionSeq(mentions)
    });
    next.status = "cancelled";
    next.completedAt = now;
    next.waitingOn = { type: "cancelled", reason };
    await this.updateRun(next, { status: "cancelled", waitingOn: next.waitingOn });
    await this.emitDispositionAck(next, { scope: "current", action: "cancel", reason }, mentions);
    return next;
  }

  private async supersedeRunAtBoundary(run: RuntimeWorkingMemory, mentions: InFlightMention[], mergedGoal: string, reason: string) {
    const now = new Date().toISOString();
    const triggerMessageId = mentions[mentions.length - 1]?.id;
    const oldRun = appendContinuations(run, mentions, {
      disposition: { scope: "current", action: "restart", reason, mergedGoal },
      lastConsumedSeq: maxMentionSeq(mentions)
    });
    oldRun.status = "cancelled";
    oldRun.completedAt = now;
    const newRunMeta: Record<string, unknown> = {
      createdAt: now,
      lastConsumedSeq: maxMentionSeq(mentions),
      supersedes: run.id,
      handover: {
        previousGoal: run.goal,
        reason,
        completedOutputs: run.outputs ?? [],
        workspaceHint: "成品保留在当前项目工作区，新一轮应基于现状增量调整。"
      }
    };
    if (triggerMessageId) {
      newRunMeta.triggerMessageId = triggerMessageId;
    }
    const newRun: RuntimeWorkingMemory = {
      ...createInitialRun(`run-${nanoid(10)}`, run.conversationId, mergedGoal),
      ...(triggerMessageId ? { triggerMessageId } : {}),
      runMeta: newRunMeta,
      edgeHistory: [],
      agentRuns: [],
      toolRuns: [],
      uiInteractions: [],
      outputs: [],
      blockers: []
    };
    oldRun.runMeta = { ...(oldRun.runMeta ?? {}), supersededBy: newRun.id, supersededReason: reason, supersededAt: now };
    await this.updateRun(oldRun, { status: "cancelled", waitingOn: { type: "superseded", reason, supersededBy: newRun.id } });
    await this.prisma.orchestratorRun.create({
      data: {
        id: newRun.id,
        conversationId: newRun.conversationId,
        status: newRun.status,
        currentNode: newRun.currentNode,
        workingMemory: newRun as unknown as Prisma.InputJsonValue
      }
    });
    await this.emitDispositionAck(oldRun, { scope: "current", action: "restart", reason, mergedGoal }, mentions);
    return this.transitionRun(newRun, "understand", "旧 Run 已带交接终结，新 Run 进入需求理解。", newRun.runMeta?.handover);
  }

  private async applySteerAction(run: RuntimeWorkingMemory, strategy: SteerAction, mentions: InFlightMention[], mergedGoal: string, triggerMessage: ChatMessage) {
    const next = appendContinuations(run, mentions, {
      disposition: { scope: "current", action: "continue", reason: "已并入本轮。" },
      lastConsumedSeq: maxMentionSeq(mentions)
    });
    next.goal = mergeGoalText(next.goal, mergedGoal);
    next.runMeta = {
      ...(next.runMeta ?? {}),
      steeringNotes: [
        ...asArray(next.runMeta?.steeringNotes),
        { at: new Date().toISOString(), strategy, messageIds: mentions.map((item) => item.id), text: mergedGoal }
      ]
    };
    if (strategy === "MERGE_CONTINUE") {
      await this.updateRun(next);
      return next;
    }
    if (strategy === "ADD_WORK_ITEM") {
      next.workItems = [...(next.workItems ?? []), createSteeredWorkItem(next, mergedGoal)];
      await this.updateRun(next);
      return next;
    }
    if (strategy === "FOLD_VALIDATION") {
      next.runMeta = {
        ...(next.runMeta ?? {}),
        additionalValidationCriteria: [
          ...asArray(next.runMeta?.additionalValidationCriteria),
          { at: new Date().toISOString(), messageIds: mentions.map((item) => item.id), text: mergedGoal }
        ]
      };
      await this.updateRun(next);
      return next;
    }
    if (strategy === "REDECOMPOSE") {
      next.runMeta = {
        ...(next.runMeta ?? {}),
        redecomposeReason: mergedGoal,
        preserveCompletedWorkItems: (next.workItems ?? []).filter((item) => item.status === "completed" || item.status === "validated" || item.status === "running")
      };
      await this.updateRun(next);
      return next.currentNode === "decompose"
        ? next
        : this.transitionRun(next, "decompose", "运行中追加消息改变了本轮范围，回到 decompose 重新拆解未开始工作项。", { messageIds: mentions.map((item) => item.id), triggerMessageId: triggerMessage.id });
    }
    return next;
  }

  private async findLatestIncompleteOrchestratorRun(conversationId: string) {
    const rows = await this.prisma.orchestratorRun.findMany({
      where: {
        conversationId,
        deletedAt: null,
        status: { notIn: ["completed", "failed", "cancelled"] }
      },
      orderBy: { createdAt: "desc" },
      take: 10
    });
    return rows.find((row) => !isTerminalRunStatus((row.workingMemory as unknown as RuntimeWorkingMemory).status));
  }

  private async findExistingOrchestratorRunForTrigger(conversationId: string, triggerMessageId: string) {
    const rows = await this.prisma.orchestratorRun.findMany({
      where: { conversationId, deletedAt: null },
      orderBy: { createdAt: "desc" },
      take: 50
    });
    return rows.find((row) => {
      const memory = asRecord(row.workingMemory);
      const runMeta = asRecord(memory?.runMeta);
      return memory?.triggerMessageId === triggerMessageId
        || runMeta?.triggerMessageId === triggerMessageId
        || asArray(runMeta?.continuations).some((item) => asRecord(item)?.messageId === triggerMessageId);
    });
  }

  private async withRuntimeLock<T>(key: string, resourceType: string, resourceId: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
    const ownerId = `${this.workerId}:${nanoid(8)}`;
    const deadline = Date.now() + Math.max(ttlMs, 1_000);
    let acquired = false;
    while (!acquired) {
      const now = new Date();
      const expiresAt = new Date(now.getTime() + ttlMs);
      try {
        await this.prisma.runtimeLock.create({
          data: { key, ownerId, resourceType, resourceId, expiresAt, heartbeatAt: now }
        });
        acquired = true;
      } catch (error) {
        if (!isUniqueConstraintError(error)) throw error;
        const reclaimed = await this.prisma.runtimeLock.updateMany({
          where: { key, expiresAt: { lt: now } },
          data: { ownerId, resourceType, resourceId, expiresAt, heartbeatAt: now }
        });
        acquired = reclaimed.count === 1;
      }
      if (!acquired) {
        if (Date.now() >= deadline) throw new Error(`Runtime lock timeout: ${key}`);
        await sleep(50);
      }
    }
    try {
      return await fn();
    } finally {
      await this.prisma.runtimeLock.deleteMany({ where: { key, ownerId } });
    }
  }

  private async runUnderstandNode(run: RuntimeWorkingMemory, message: ChatMessage, options: RuntimeExecutionOptions = {}) {
    const context = await this.context().buildNodeContext({
      conversationId: run.conversationId,
      triggerMessageId: message.id,
      node: "understand",
      run
    });
    const output = await this.llm.generateJson<UnderstandNodeOutput>({
      callerType: "orchestrator_node",
      callerId: `${run.id}:understand`,
      schemaName: "orchestrator_understand",
      schema: understandNodeSchema,
      systemPrompt: understandPrompt(),
      ...(options.signal ? { signal: options.signal } : {}),
      userPrompt: JSON.stringify({ userMessage: extractMessageText(message), nodeContext: context }, null, 2)
    });
    run.understanding = output.result;
    this.applyRunMemoryPatch(run, output.runMemoryPatch);
    if (output.result.toolRequests.length > 0) {
      run.runMeta = { ...(run.runMeta ?? {}), pendingToolRequests: output.result.toolRequests };
      await this.updateRun(run);
      return this.transitionRun(run, "tools", output.edgeSummary ?? "understand 需要查询工具补充上下文。", output.result.toolRequests);
    }
    if (!output.result.clearEnough) {
      const question = output.result.clarificationQuestion ?? "我需要你再补充一下本轮任务的目标和边界。";
      const next = await this.transitionRun(run, "ui_query", output.edgeSummary ?? "understand 需要向用户追问。", { question });
      next.uiInteractions = [...(next.uiInteractions ?? []), { at: new Date().toISOString(), type: "ask_user", question }];
      await this.createAgentMessage(run.conversationId, [createMarkdownBlock(`block-${nanoid(8)}`, question)]);
      await this.updateRun(next, { status: "waiting_user", waitingOn: { type: "user", reason: question } });
      await this.realtime.emit("conversation", run.conversationId, "run.waiting_user", { run: next, question });
      return next;
    }
    if (!output.result.shouldDecompose) {
      const publicMessage = output.result.directAnswer ?? output.result.minimumScope ?? output.result.runGoal;
      run.runMeta = {
        ...(run.runMeta ?? {}),
        directValidationCandidate: {
          sourceNode: "understand",
          publicMessage,
          understanding: output.result,
          createdAt: new Date().toISOString()
        }
      };
      run.outputs = [...(run.outputs ?? []), { node: "understand", draftPublicMessage: publicMessage, direct: true }];
      await this.updateRun(run);
      return this.transitionRun(run, "validate", output.edgeSummary ?? "understand 判断无需子 Agent，进入直接校验。", { publicMessage });
    }
    return this.transitionRun(run, "decompose", output.edgeSummary ?? "需求已清楚，进入本轮最小执行范围拆解。", output.result);
  }

  private async runToolsNode(run: RuntimeWorkingMemory, message: ChatMessage) {
    const requests = asToolRequests((run.runMeta ?? {}).pendingToolRequests);
    const results: RuntimeToolResult[] = [];
    for (const request of requests) {
      results.push(await this.tools().execute({
        runId: run.id,
        conversationId: run.conversationId,
        callerType: "orchestrator",
        callerId: "agent-orchestrator",
        request
      }));
    }
    run.toolRuns = [...(run.toolRuns ?? []), ...results];
    run.runMeta = { ...(run.runMeta ?? {}), pendingToolRequests: [], latestToolResults: results };
    await this.updateRun(run);
    return this.transitionRun(run, "understand", "工具查询完成，回到 understand 消化结果。", results);
  }

  private async runDecomposeNode(run: RuntimeWorkingMemory, message: ChatMessage, options: RuntimeExecutionOptions = {}) {
    const context = await this.context().buildNodeContext({
      conversationId: run.conversationId,
      triggerMessageId: message.id,
      node: "decompose",
      run
    });
    const output = await this.llm.generateJson<DecomposeNodeOutput>({
      callerType: "orchestrator_node",
      callerId: `${run.id}:decompose`,
      schemaName: "orchestrator_decompose",
      schema: decomposeNodeSchema,
      systemPrompt: decomposePrompt(),
      ...(options.signal ? { signal: options.signal } : {}),
      userPrompt: JSON.stringify({ userMessage: extractMessageText(message), nodeContext: context }, null, 2)
    });
    this.applyRunMemoryPatch(run, output.runMemoryPatch);
    const normalizedAssignments = normalizeDecomposedAssignments(output.result.assignments);
    const constrainedAssignments = await this.constrainAssignmentsForConversation(run.conversationId, normalizedAssignments.workItems);
    const preservedWorkItems = asArray(run.runMeta?.preserveCompletedWorkItems)
      .flatMap((item) => asRecord(item) ? [item as Assignment] : []);
    run.workItems = mergePreservedWorkItems(preservedWorkItems, constrainedAssignments.workItems);
    if (preservedWorkItems.length > 0) {
      const runMeta = { ...(run.runMeta ?? {}) };
      delete runMeta.preserveCompletedWorkItems;
      run.runMeta = runMeta;
    }
    if (normalizedAssignments.omittedCoordinatorAssignments.length > 0) {
      run.runMeta = {
        ...(run.runMeta ?? {}),
        omittedCoordinatorAssignments: [
          ...asArray(run.runMeta?.omittedCoordinatorAssignments),
          ...normalizedAssignments.omittedCoordinatorAssignments
        ]
      };
    }
    if (normalizedAssignments.omittedReviewAssignments.length > 0) {
      run.runMeta = {
        ...(run.runMeta ?? {}),
        omittedReviewAssignments: [
          ...asArray(run.runMeta?.omittedReviewAssignments),
          ...normalizedAssignments.omittedReviewAssignments
        ]
      };
    }
    if (constrainedAssignments.omittedUnavailableAssignments.length > 0) {
      run.runMeta = {
        ...(run.runMeta ?? {}),
        omittedUnavailableAssignments: [
          ...asArray(run.runMeta?.omittedUnavailableAssignments),
          ...constrainedAssignments.omittedUnavailableAssignments
        ]
      };
    }
    if (constrainedAssignments.reroutedAssignments.length > 0) {
      run.runMeta = {
        ...(run.runMeta ?? {}),
        reroutedAssignments: [
          ...asArray(run.runMeta?.reroutedAssignments),
          ...constrainedAssignments.reroutedAssignments
        ]
      };
    }
    await this.updateRun(run);
    if (output.result.coordinationMessage) {
      const coordination = await this.buildAssignmentCoordinationMessage(run.conversationId, output.result.coordinationMessage, run.workItems);
      await this.createAgentMessage(
        run.conversationId,
        [createMarkdownBlock(`block-${nanoid(8)}`, coordination.text)],
        undefined,
        "sent",
        {
          kind: "assignment_coordination",
          runId: run.id,
          workItems: run.workItems.map((item) => ({
            workItemId: item.workItemId,
            agentId: item.agentId,
            task: item.task,
            schedulingLevel: assignmentSchedulingLevel(item),
            dependsOn: item.dependsOn
          }))
        },
        coordination.mentions
      );
    }
    if (run.workItems.length === 0) {
      return this.transitionRun(run, "integrate", output.edgeSummary ?? "decompose 判断本轮没有需要调用的子 Agent。", output.result);
    }
    return this.transitionRun(run, "assignment", output.edgeSummary ?? "decompose 已形成子 Agent 调度计划。", output.result);
  }

  private async runAssignmentNode(run: RuntimeWorkingMemory, message: ChatMessage, options: RuntimeExecutionOptions = {}) {
    const workItems: Assignment[] = [...(run.workItems ?? [])];
    const validated = new Set(workItems.filter((item) => item.status === "validated").map((item) => item.workItemId));
    const currentLevel = lowestUnvalidatedSchedulingLevel(workItems);
    if (currentLevel === undefined) {
      return this.transitionRun(run, "integrate", "所有工作项已经完成校验，进入汇总。", workItems);
    }
    const currentLevelRunning = workItems.filter((item) =>
      item.status === "running" && assignmentSchedulingLevel(item) === currentLevel
    );
    if (currentLevelRunning.length > 0) {
      const activeAssignments = [];
      const staleAssignments = [];
      for (const assignment of currentLevelRunning) {
        if (await this.hasActiveAgentRunForAssignment(run.id, assignment)) {
          activeAssignments.push(assignment);
        } else {
          staleAssignments.push(assignment);
        }
      }
      if (activeAssignments.length > 0) {
        run.waitingOn = {
          type: "agent",
          workItems: activeAssignments.map((item) => ({
            workItemId: item.workItemId,
            agentId: item.agentId,
            task: item.task
          })),
          reason: "assignment 已有子 Agent 正在执行，等待其完成。"
        };
        await this.updateRun(run, { waitingOn: run.waitingOn });
        throw new RuntimeJobDeferredError(5_000);
      }
      for (const assignment of staleAssignments) {
        assignment.status = "pending";
        assignment.validation = undefined;
      }
      run.workItems = workItems;
      await this.updateRun(run);
    }
    const currentLevelPending = workItems.filter((item) => item.status === "pending" && assignmentSchedulingLevel(item) === currentLevel);
    const currentLevelAwaitingValidation = completedAssignmentsAwaitingValidation(workItems)
      .some((item) => assignmentSchedulingLevel(item) === currentLevel);
    if (currentLevelPending.length === 0) {
      if (currentLevelAwaitingValidation) {
        return this.transitionRun(run, "validate", `等级 ${currentLevel} 的子 Agent 已返回，进入校验。`, workItems);
      }
      run.blockers = [...(run.blockers ?? []), { type: "scheduling_level_blocked", level: currentLevel, at: new Date().toISOString(), workItems }];
      return this.transitionRun(run, "decompose", "assignment 发现最低优先级工作项无法推进，回到 decompose 重新拆解。", workItems);
    }
    const currentBatch = currentLevelPending.filter((item) =>
      item.status === "pending" && item.dependsOn.every((dep) => validated.has(dep) || validated.has(agentDepToWorkItem(workItems, dep)))
    );
    if (currentBatch.length === 0) {
      run.blockers = [...(run.blockers ?? []), { type: "dependency_deadlock", level: currentLevel, at: new Date().toISOString(), workItems }];
      return this.transitionRun(run, "decompose", "assignment 发现依赖无法推进，回到 decompose 重新拆解。", workItems);
    }
    const agentMemoryOwnerUserId = await this.resolveAgentMemoryOwnerUserId(run.conversationId, message);
    for (const assignment of currentBatch) {
      assignment.status = "running";
      assignment.validation = undefined;
    }
    run.workItems = workItems;
    await this.updateRun(run);

    const executionResults = await Promise.all(currentBatch.map(async (assignment) => {
      const agent = await this.resolveAssignmentAgent(run.conversationId, assignment.agentId);
      await this.createAssignmentAcknowledgement(run, assignment, agent);
      const requesterUserId = message.sender.type === "user" ? message.sender.id : undefined;
      try {
        const result = await this.executeAssignment(
          run.id,
          run.conversationId,
          assignment,
          agent,
          this.buildAssignmentContext(run, assignment),
          agentMemoryOwnerUserId,
          options,
          requesterUserId
        );
        return { ok: true as const, assignment, agent, result };
      } catch (error) {
        return { ok: false as const, assignment, agent, error };
      }
    }));

    const failedResults = executionResults.filter((result) => !result.ok);
    if (failedResults.length > 0) {
      for (const failed of failedResults) {
        const errorMessage = failed.error instanceof Error ? failed.error.message : String(failed.error);
        failed.assignment.status = "pending";
        failed.assignment.validation = undefined;
        run.blockers = [...(run.blockers ?? []), {
          type: "assignment_execution_error",
          workItemId: failed.assignment.workItemId,
          agentId: failed.agent.id,
          at: new Date().toISOString(),
          error: errorMessage
        }];
      }
      run.workItems = workItems;
      await this.updateRun(run);
      const firstError = failedResults[0]?.error;
      throw firstError instanceof Error ? firstError : new Error(String(firstError));
    }

    let waitingForToolApproval: (typeof executionResults)[number] | undefined;
    for (const execution of executionResults) {
      if (!execution.ok) continue;
      const { assignment, agent, result } = execution;
      if (isWaitingForAgentToolApprovalResult(result)) {
        assignment.status = "running";
        assignment.outputMessageId = result.outputMessageId;
        waitingForToolApproval ??= execution;
      } else {
        assignment.status = result.status === "completed" ? "completed" : "failed";
        assignment.outputMessageId = result.outputMessageId;
      }
      run.agentRuns = [...(run.agentRuns ?? []), {
        workItemId: assignment.workItemId,
        agentId: agent.id,
        status: result.status,
        outputMessageId: result.outputMessageId,
        agentRunId: result.agentRunId,
        ...(isWaitingForAgentToolApprovalResult(result) ? { waitingToolApproval: asRecord(result.memoryPatch)?.waitingToolApproval ?? null } : {})
      }];
    }

    if (waitingForToolApproval?.ok) {
      const { assignment, agent, result } = waitingForToolApproval;
      run.runMeta = {
        ...(run.runMeta ?? {}),
        pendingAgentToolApproval: asRecord(result.memoryPatch)?.waitingToolApproval ?? null
      };
      run.workItems = workItems;
      await this.updateRun(run, {
        status: "waiting_tool",
        waitingOn: {
          type: "tool_approval",
          workItemId: assignment.workItemId,
          agentId: agent.id,
          agentRunId: result.agentRunId,
          outputMessageId: result.outputMessageId,
          approval: asRecord(result.memoryPatch)?.waitingToolApproval ?? null
        }
      });
      return run;
    }
    run.workItems = workItems;
    await this.updateRun(run);
    return this.transitionRun(run, "validate", `等级 ${currentLevel} 的子 Agent 已返回，进入校验。`, workItems);
  }

  private async createAssignmentAcknowledgement(run: RuntimeWorkingMemory, assignment: Assignment, agent: RuntimeAgentIdentity) {
    await this.withRuntimeLock(
      `assignment-acknowledgement:${run.id}:${assignment.workItemId}:${agent.id}`,
      "assignment_acknowledgement",
      `${run.id}:${assignment.workItemId}:${agent.id}`,
      5_000,
      async () => {
        const existing = await this.prisma.message.findMany({
          where: {
            conversationId: run.conversationId,
            senderId: agent.id,
            deletedAt: null,
            metadata: {
              path: ["kind"],
              equals: "assignment_acknowledgement"
            } as Prisma.JsonNullableFilter<"Message">
          },
          orderBy: { createdAt: "asc" }
        });
        if (existing.some((message) => isAssignmentAcknowledgement(message.metadata, run.id, assignment.workItemId, agent.id))) return;

        await this.createAgentMessage(
          run.conversationId,
          [createMarkdownBlock(`block-${nanoid(8)}`, `收到，我负责：${assignment.task}`)],
          agent,
          "sent",
          {
            kind: "assignment_acknowledgement",
            runId: run.id,
            workItemId: assignment.workItemId,
            agentId: agent.id,
            task: assignment.task
          }
        );
      }
    );
  }

  private async hasActiveAgentRunForAssignment(runId: string, assignment: Assignment) {
    const workItemId = assignment.workItemId;
    if (!workItemId) return false;
    const existing = await this.prisma.agentRun.findFirst({
      where: {
        runId,
        agentId: assignment.agentId,
        status: "running",
        deletedAt: null,
        input: {
          path: ["assignment", "workItemId"],
          equals: workItemId
        } as Prisma.JsonFilter<"AgentRun">
      },
      select: { id: true }
    });
    return Boolean(existing);
  }

  private async runValidateNode(run: RuntimeWorkingMemory, message: ChatMessage, options: RuntimeExecutionOptions = {}) {
    const completedAwaitingValidation = completedAssignmentsAwaitingValidation(run.workItems ?? []);
    const currentLevel = completedAwaitingValidation.length > 0
      ? Math.min(...completedAwaitingValidation.map(assignmentSchedulingLevel))
      : undefined;
    const pending = currentLevel === undefined
      ? []
      : completedAwaitingValidation.filter((item) => assignmentSchedulingLevel(item) === currentLevel);
    if (pending.length === 0) {
      const directCandidate = readDirectValidationCandidate(run);
      if (directCandidate) return this.runDirectValidateNode(run, message, directCandidate, options);
      if ((run.workItems ?? []).some((item) => item.status === "pending")) {
        return this.transitionRun(run, "assignment", "当前没有待校验输出，继续执行已满足依赖的后续工作项。", run.workItems);
      }
      return this.transitionRun(run, "integrate", "所有工作项已经完成校验，进入汇总。", run.workItems);
    }
    for (const assignment of pending) {
      const deploymentValidation = await this.tryValidateReadyDeploymentAssignment(run, assignment);
      if (deploymentValidation) {
        if (deploymentValidation.outputMessageId) assignment.outputMessageId = deploymentValidation.outputMessageId;
        assignment.validation = deploymentValidation.result;
        const resultRef = latestAssignmentResultRef(run, assignment) ?? {
          workItemId: assignment.workItemId,
          agentId: assignment.agentId,
          status: assignment.status,
          outputMessageId: assignment.outputMessageId
        };
        const reviewReference = deploymentValidation.outputMessageId
          ? await this.buildReviewReference(run.conversationId, deploymentValidation.outputMessageId)
          : undefined;
        const validationMessage = await this.createAgentMessage(
          run.conversationId,
          [createMarkdownBlock(`block-${nanoid(8)}`, deploymentValidation.result.publicMessage)],
          undefined,
          "sent",
          reviewReference ? { reference: reviewReference } : undefined
        );
        if (deploymentValidation.outputMessageId && reviewReference) {
          await this.applyValidationActions(deploymentValidation.outputMessageId, run.id, deploymentValidation.result, validationMessage.id);
        }
        await this.memory().updateAgentRunBriefQuality({
          conversationId: run.conversationId,
          agentId: assignment.agentId,
          ownerUserId: await this.resolveAgentMemoryOwnerUserId(run.conversationId, message),
          agentRunId: optionalString(asRecord(resultRef)?.agentRunId),
          outputMessageId: deploymentValidation.outputMessageId ?? optionalString(asRecord(resultRef)?.outputMessageId),
          workItemId: assignment.workItemId,
          validation: {
            passed: deploymentValidation.result.passed,
            nextStep: deploymentValidation.result.nextStep,
            reason: deploymentValidation.result.reason,
            publicMessage: deploymentValidation.result.publicMessage,
            likeMessage: deploymentValidation.result.likeMessage,
            pinMessage: deploymentValidation.result.pinMessage,
            reviewMessageId: validationMessage.id
          }
        });
        assignment.status = "validated";
        run.outputs = [...(run.outputs ?? []), {
          node: "validate",
          workItemId: assignment.workItemId,
          publicMessage: deploymentValidation.result.publicMessage,
          validation: deploymentValidation.result,
          deterministic: true
        }];
        await this.updateRun(run);
        continue;
      }
      const resultRef = latestAssignmentResultRef(run, assignment);
      const context = await this.context().buildNodeContext({
        conversationId: run.conversationId,
        triggerMessageId: message.id,
        node: "validate",
        run,
        currentEvent: { assignment, resultRef }
      });
      const output = await this.llm.generateJson<ValidateNodeOutput>({
        callerType: "orchestrator_node",
        callerId: `${run.id}:validate:${assignment.workItemId}`,
        schemaName: "orchestrator_validate_assignment",
        schema: validateNodeSchema,
        systemPrompt: validatePrompt(),
        ...(options.signal ? { signal: options.signal } : {}),
        userPrompt: JSON.stringify({ assignment, resultRef, nodeContext: context }, null, 2)
      });
      this.applyRunMemoryPatch(run, output.runMemoryPatch);
      assignment.validation = output.result;
      const reviewReference = resultRef?.outputMessageId
        ? await this.buildReviewReference(run.conversationId, String(resultRef.outputMessageId))
        : undefined;
      const validationMessage = await this.createAgentMessage(
        run.conversationId,
        [createMarkdownBlock(`block-${nanoid(8)}`, output.result.publicMessage)],
        undefined,
        "sent",
        reviewReference ? { reference: reviewReference } : undefined
      );
      if (resultRef?.outputMessageId && reviewReference) {
        await this.applyValidationActions(String(resultRef.outputMessageId), run.id, output.result, validationMessage.id);
      }
      await this.memory().updateAgentRunBriefQuality({
        conversationId: run.conversationId,
        agentId: assignment.agentId,
        ownerUserId: await this.resolveAgentMemoryOwnerUserId(run.conversationId, message),
        agentRunId: optionalString(asRecord(resultRef)?.agentRunId),
        outputMessageId: optionalString(asRecord(resultRef)?.outputMessageId),
        workItemId: assignment.workItemId,
        validation: {
          passed: output.result.passed,
          nextStep: output.result.nextStep,
          reason: output.result.reason,
          publicMessage: output.result.publicMessage,
          likeMessage: output.result.likeMessage,
          pinMessage: output.result.pinMessage,
          reviewMessageId: validationMessage.id
        }
      });
      if (!output.result.passed && output.result.nextStep === "ask_user") {
        const question = output.result.clarificationQuestion ?? output.result.publicMessage;
        const next = await this.transitionRun(run, "ui_query", output.edgeSummary ?? "validate 需要用户确认。", output.result);
        next.uiInteractions = [...(next.uiInteractions ?? []), { at: new Date().toISOString(), type: "ask_user", question }];
        await this.updateRun(next, { status: "waiting_user", waitingOn: { type: "user", reason: question } });
        return next;
      }
      if (!output.result.passed && output.result.nextStep === "retry_assignment") {
        assignment.status = "pending";
        assignment.lastValidation = output.result;
        assignment.validation = undefined;
        await this.updateRun(run);
        return this.transitionRun(run, "assignment", output.edgeSummary ?? "validate 要求当前工作项返工执行。", output.result);
      }
      if (!output.result.passed && output.result.nextStep === "retry_decompose") {
        await this.updateRun(run);
        return this.transitionRun(run, "decompose", output.edgeSummary ?? "validate 要求重新拆解任务范围。", output.result);
      }
      assignment.status = "validated";
      await this.updateRun(run);
    }
    if (completedAssignmentsAwaitingValidation(run.workItems ?? []).length > 0) {
      return this.transitionRun(run, "validate", "validate 已完成当前优先级批次校验，继续校验下一批已完成输出。", run.workItems);
    }
    if ((run.workItems ?? []).some((item) => item.status === "pending")) {
      return this.transitionRun(run, "assignment", "validate 已完成当前批次校验，继续执行已满足依赖的后续工作项。", run.workItems);
    }
    return this.transitionRun(run, "integrate", "validate 已完成所有工作项校验。", run.workItems);
  }

  private async tryValidateReadyDeploymentAssignment(run: RuntimeWorkingMemory, assignment: Assignment) {
    if (!isAssignmentDeploymentIntent(assignment)) return null;
    const runStartedAt = new Date(run.startedAt ?? Date.now());
    const deployment = await this.prisma.deployment.findFirst({
      where: {
        conversationId: run.conversationId,
        status: "ready",
        deletedAt: null,
        createdAt: { gte: runStartedAt }
      },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        status: true,
        previewUrl: true,
        outputPath: true,
        statusMessageId: true,
        logAssetId: true,
        readyAt: true
      }
    });
    if (!deployment?.previewUrl) return null;
    return {
      outputMessageId: deployment.statusMessageId ?? undefined,
      result: {
        passed: true,
        nextStep: "continue" as const,
        likeMessage: true,
        pinMessage: false,
        reason: `后端部署记录 ${deployment.id} 已 ready，预览地址为 ${deployment.previewUrl}。`,
        publicMessage: [
          "审阅通过。",
          "",
          `@deploy 静态预览已就绪：${deployment.previewUrl}`,
          deployment.outputPath ? `输出目录：${deployment.outputPath}` : undefined
        ].filter(Boolean).join("\n")
      }
    };
  }

  private async runDirectValidateNode(run: RuntimeWorkingMemory, message: ChatMessage, directCandidate: Record<string, unknown>, options: RuntimeExecutionOptions = {}) {
    const context = await this.context().buildNodeContext({
      conversationId: run.conversationId,
      triggerMessageId: message.id,
      node: "validate",
      run,
      currentEvent: { directCandidate }
    });
    const output = await this.llm.generateJson<ValidateNodeOutput>({
      callerType: "orchestrator_node",
      callerId: `${run.id}:validate:direct`,
      schemaName: "orchestrator_validate_direct",
      schema: validateNodeSchema,
      systemPrompt: directValidatePrompt(),
      ...(options.signal ? { signal: options.signal } : {}),
      userPrompt: JSON.stringify({ userMessage: extractMessageText(message), directCandidate, nodeContext: context }, null, 2)
    });
    this.applyRunMemoryPatch(run, output.runMemoryPatch);
    const runMeta = { ...(run.runMeta ?? {}) };
    delete runMeta.directValidationCandidate;
    run.runMeta = { ...runMeta, lastDirectValidation: output.result };
    run.outputs = [...(run.outputs ?? []), { node: "validate", publicMessage: output.result.publicMessage, validation: output.result, direct: true }];
    await this.createAgentMessage(
      run.conversationId,
      [createMarkdownBlock(`block-${nanoid(8)}`, output.result.publicMessage)],
      undefined,
      "sent",
      { kind: "direct_validation", runId: run.id, triggerMessageId: message.id }
    );
    await this.updateRun(run);
    if (!output.result.passed && output.result.nextStep === "ask_user") {
      const question = output.result.clarificationQuestion ?? output.result.publicMessage;
      const next = await this.transitionRun(run, "ui_query", output.edgeSummary ?? "validate 直接校验需要用户确认。", output.result);
      next.uiInteractions = [...(next.uiInteractions ?? []), { at: new Date().toISOString(), type: "ask_user", question }];
      await this.updateRun(next, { status: "waiting_user", waitingOn: { type: "user", reason: question } });
      return next;
    }
    if (!output.result.passed && (output.result.nextStep === "retry_assignment" || output.result.nextStep === "retry_decompose")) {
      return this.transitionRun(run, "decompose", output.edgeSummary ?? "validate 直接校验判断仍需拆解执行。", output.result);
    }
    return this.completeRunWithoutSummaryLlm(run, output.edgeSummary ?? "validate 已完成直接校验并输出汇报。", output.result);
  }

  private async runIntegrateNode(run: RuntimeWorkingMemory, message: ChatMessage, options: RuntimeExecutionOptions = {}) {
    const context = await this.context().buildNodeContext({
      conversationId: run.conversationId,
      triggerMessageId: message.id,
      node: "integrate",
      run
    });
    const output = await this.llm.generateJson<IntegrateNodeOutput>({
      callerType: "orchestrator_node",
      callerId: `${run.id}:integrate`,
      schemaName: "orchestrator_integrate",
      schema: integrateNodeSchema,
      systemPrompt: integratePrompt(),
      ...(options.signal ? { signal: options.signal } : {}),
      userPrompt: JSON.stringify({ userMessage: extractMessageText(message), nodeContext: context }, null, 2)
    });
    this.applyRunMemoryPatch(run, output.runMemoryPatch);
    run.lastIntegrate = output.result;
    run.outputs = [...(run.outputs ?? []), { node: "integrate", publicMessage: output.result.publicMessage, openQuestions: output.result.openQuestions }];
    await this.createAgentMessage(run.conversationId, [createMarkdownBlock(`block-${nanoid(8)}`, output.result.publicMessage)]);
    await this.updateRun(run);
    return this.transitionRun(run, "summary", output.edgeSummary ?? "integrate 已形成本轮汇总，进入简报。", output.result);
  }

  private async runSummaryNode(run: RuntimeWorkingMemory, message: ChatMessage, options: RuntimeExecutionOptions = {}) {
    if (isDirectValidationOnlyRun(run)) {
      return this.completeRunWithoutSummaryLlm(run, "直接回复已完成，跳过需要 LLM 的 summary 简报。", {
        direct: true,
        reason: "本轮没有子 Agent、工具调用或项目产物，不需要额外生成长期记忆简报。"
      });
    }
    const context = await this.context().buildNodeContext({
      conversationId: run.conversationId,
      triggerMessageId: message.id,
      node: "summary",
      run
    });
    const output = await this.llm.generateJson<SummaryNodeOutput>({
      callerType: "orchestrator_node",
      callerId: `${run.id}:summary`,
      schemaName: "orchestrator_summary",
      schema: summaryNodeSchema,
      systemPrompt: summaryPrompt(),
      ...(options.signal ? { signal: options.signal } : {}),
      userPrompt: JSON.stringify({ userMessage: extractMessageText(message), nodeContext: context, integrate: run.lastIntegrate }, null, 2)
    });
    const runBrief = output.result.runBrief || run.lastIntegrate?.runBrief || extractMessageText(message);
    await this.memory().applyRunSummary({
      conversationId: run.conversationId,
      runId: run.id,
      userGoal: run.goal,
      runBrief,
      ownerUserId: await this.resolveAgentMemoryOwnerUserId(run.conversationId, message),
      nodeSummary: output.result,
      outputs: run.outputs
    });
    const next = await this.transitionRun(run, "memory_manage", output.edgeSummary ?? "summary 简报已写入长期记忆。", output.result);
    await this.realtime.emit("conversation", run.conversationId, "run.completed", { run: next });
    await this.observability?.audit({
      action: "orchestrator.run.complete",
      targetType: "orchestrator_run",
      targetId: run.id,
      payload: { conversationId: run.conversationId, status: next.status }
    });
    return next;
  }

  private async completeRunWithoutSummaryLlm(run: RuntimeWorkingMemory, reason: string, payload?: unknown) {
    const next = await this.transitionRun(run, "memory_manage", reason, payload);
    await this.realtime.emit("conversation", run.conversationId, "run.completed", { run: next });
    await this.observability?.audit({
      action: "orchestrator.run.complete",
      targetType: "orchestrator_run",
      targetId: run.id,
      payload: { conversationId: run.conversationId, status: next.status, skippedSummaryLlm: true }
    });
    return next;
  }

  private async executeAssignment(
    runId: string,
    conversationId: string,
    assignment: Assignment,
    agent: RuntimeAgentIdentity,
    context: unknown,
    ownerUserId: string,
    options: RuntimeExecutionOptions = {},
    requesterUserId?: string | undefined
  ) {
    const agentRun = await this.prisma.agentRun.create({
      data: {
        id: `agent-run-${nanoid(10)}`,
        runId,
        agentId: agent.id,
        status: "running",
        input: { assignment, context } as Prisma.InputJsonValue
      }
    });
    await this.realtime.emit("conversation", conversationId, "agent_run.started", { agentRunId: agentRun.id, agentId: agent.id, runId });
    try {
      let codePrompt: string | undefined;
      const output = agent.type === "code"
        ? await (async () => {
            const requestedProvider = requestedCodeProviderForAgent(agent);
            const executionPlan = await this.resolveCodeAgentExecutionPlan(requestedProvider);
            const previousCodeSession = await this.readCompatibleCodeAgentSession(conversationId, agent.id, executionPlan.actualProvider).catch(() => ({}));
            const resumeSessionId = optionalString(asRecord(previousCodeSession)?.providerSessionId);
            codePrompt = await this.buildCodeAssignmentPromptForExecution(conversationId, assignment, context, { resumeSessionId });
            return this.executeCodePrompt(conversationId, agent, codePrompt, options);
          })()
        : agent.id === "agent-ui"
          ? await this.uiAgent().runAssignment({ runId, conversationId, assignment, agent, context, ownerUserId, agentRunId: agentRun.id, ...(options.signal ? { signal: options.signal } : {}) })
        : await this.agent().runAssignment({ runId, conversationId, assignment, agent, context, ownerUserId, agentRunId: agentRun.id, ...(options.signal ? { signal: options.signal } : {}) });
      const existingOutputMessageId = agent.type === "code" ? optionalString(asRecord(output.memoryPatch)?.codeOutputMessageId) : "";
      const outputMessage = existingOutputMessageId
        ? await this.getExistingOutputMessage(conversationId, existingOutputMessageId)
        : await this.createAgentMessage(conversationId, buildAgentOutputBlocks(output), agent);
      const waitingForToolApproval = isWaitingForAgentToolApprovalResult(output);
      if (agent.type === "code") {
        const actualProvider = codeProviderFromOutput(output, requestedCodeProviderForAgent(agent));
        await this.appendCodeAgentSession({
          conversationId,
          agentId: agent.id,
          provider: actualProvider,
          userText: codePrompt ?? buildCodeAssignmentPrompt(assignment),
          assistantMessageId: outputMessage.id,
          output
        });
      }
      await this.prisma.agentRun.update({
        where: { id: agentRun.id },
        data: {
          status: output.status,
          output: output as unknown as Prisma.InputJsonValue,
          internalTraceRef: output.internalTraceRef ?? null,
          completedAt: waitingForToolApproval ? null : new Date()
        }
      });
      if (!waitingForToolApproval) {
        await this.appendAssignmentRunBrief({
          runId,
          conversationId,
          assignment,
          agent,
          ownerUserId,
          agentRunId: agentRun.id,
          outputMessageId: outputMessage.id,
          output
        });
        if (agent.type === "code") {
          await this.maybeStartDeploymentAfterCodeAssignment({
            conversationId,
            userId: requesterUserId ?? ownerUserId,
            assignment,
            agent,
            output,
            runId
          });
        }
      }
      await this.realtime.emit(
        "conversation",
        conversationId,
        waitingForToolApproval ? "agent_run.waiting_tool_approval" : "agent_run.completed",
        { agentRunId: agentRun.id, agentId: agent.id, runId }
      );
      return { ...output, agentRunId: agentRun.id, outputMessageId: outputMessage.id };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      await this.prisma.agentRun.update({
        where: { id: agentRun.id },
        data: {
          status: "failed",
          output: { error: errorMessage } as Prisma.InputJsonValue,
          completedAt: new Date()
        }
      });
      await this.realtime.emit("conversation", conversationId, "agent_run.failed", { agentRunId: agentRun.id, agentId: agent.id, runId, error: errorMessage });
      throw error;
    }
  }

  private async appendAssignmentRunBrief(input: {
    runId: string;
    conversationId: string;
    assignment: Assignment;
    agent: RuntimeAgentIdentity;
    ownerUserId: string;
    agentRunId: string;
    outputMessageId: string;
    output: RuntimeAgentResult;
  }) {
    const conversation = await this.prisma.conversation.findFirst({
      where: { id: input.conversationId, deletedAt: null },
      select: { workspaceId: true }
    });
    const memoryPatch = asRecord(input.output.memoryPatch) ?? {};
    const codeExecutionBrief = asRecord(memoryPatch.codeExecutionBrief);
    await this.memory().appendAgentRunBrief({
      conversationId: input.conversationId,
      workspaceId: conversation?.workspaceId ?? null,
      scope: "conversation",
      runId: input.runId,
      agentRunId: input.agentRunId,
      agentId: input.agent.id,
      agentType: input.agent.type,
      ownerUserId: input.ownerUserId,
      triggerSource: "orchestrator_assignment",
      workItemId: input.assignment.workItemId,
      outputMessageId: input.outputMessageId,
      taskGoal: input.assignment.task,
      inputSummary: buildAssignmentInputSummary(input.assignment),
      processSummary: typeof codeExecutionBrief?.summary === "string" ? codeExecutionBrief.summary : input.output.resultSummary,
      resultSummary: input.output.resultSummary,
      status: input.output.status,
      createdAssets: buildAgentRunBriefAssets(input.output),
      usedTools: normalizeRuntimeList(memoryPatch.usedTools),
      usedSkills: normalizeRuntimeList(memoryPatch.usedSkills),
      verification: {
        status: "pending",
        acceptanceCriteria: input.assignment.acceptanceCriteria ?? "",
        expectedOutput: input.assignment.expectedOutput
      },
      risks: normalizeRuntimeList(memoryPatch.risks),
      openQuestions: input.output.status === "needs_clarification" ? [input.output.publicMessage] : normalizeRuntimeList(memoryPatch.openQuestions),
      qualitySignals: {
        outputMessageId: input.outputMessageId,
        validateStatus: "pending"
      },
      memoryCandidates: memoryPatch
    });
  }

  private async buildCodeAssignmentPromptForExecution(conversationId: string, assignment: Assignment, context: unknown, options: { resumeSessionId?: string | undefined } = {}) {
    if (options.resumeSessionId && assignment.lastValidation) {
      return buildCodeAssignmentRetryPrompt(assignment, assignment.lastValidation);
    }
    const dependencies = dependencyOutputRefsFromContext(context, assignment);
    if (dependencies.length === 0) return buildCodeAssignmentPrompt(assignment);
    const rows = await this.prisma.message.findMany({
      where: {
        conversationId,
        id: { in: dependencies.map((item) => item.outputMessageId) },
        deletedAt: null
      }
    });
    const byId = new Map(rows.map((message) => [message.id, message]));
    const summaries = dependencies.flatMap((dependency) => {
      const message = byId.get(dependency.outputMessageId);
      if (!message) return [];
      return [{
        ...dependency,
        senderName: message.senderName,
        text: extractStoredMessageText(message)
      }];
    });
    return buildCodeAssignmentPrompt(assignment, summaries);
  }

  private async executeCodePrompt(
    conversationId: string,
    agent: RuntimeAgentIdentity,
    prompt: string,
    options: RuntimeExecutionOptions = {}
  ): Promise<RuntimeAgentResult> {
    const { workspaceRoot, workspaceId } = await this.resolveWorkspaceRoot(conversationId);
    const codeWorkspaceRoot = await ensureWorkspaceCodeRoot(workspaceRoot);
    const startedAt = new Date().toISOString();
    const requestedProvider = requestedCodeProviderForAgent(agent);
    const executionPlan = await this.resolveCodeAgentExecutionPlan(requestedProvider);
    const provider = executionPlan.actualProvider;
    const codeTaskRunId = workspaceId ? `code-task-${nanoid(10)}` : undefined;
    const logInfo = workspaceId && codeTaskRunId ? await this.prepareCodeRunLog(workspaceId, codeTaskRunId, provider) : undefined;
    const liveMessage = await this.createAgentMessage(
      conversationId,
      buildCodeTaskLiveBlocks({
        codeTaskRunId: codeTaskRunId ?? `code-task-${nanoid(10)}`,
        title: `${agent.name} 正在思考`,
        status: "running",
        progress: 0.05,
        text: "正在思考中..."
      }),
      agent,
      "processing",
      {
        kind: "code_task",
        provider,
        ...(provider !== requestedProvider ? { requestedProvider } : {}),
        ...(codeTaskRunId ? { codeTaskRunId } : {})
      }
    );
    const leaseOwner = `${this.workerId}:code-task:${nanoid(8)}`;
    if (workspaceId && codeTaskRunId) {
      await this.prisma.codeTaskRun.create({
        data: {
          id: codeTaskRunId,
          workspaceId,
          status: "queued",
          branchName: "main",
          worktreePath: codeWorkspaceRoot,
          provider,
          providerSessionRef: `${conversationId}:${agent.id}`,
          ...(logInfo?.assetId ? { logAssetId: logInfo.assetId } : {}),
          ...(logInfo?.relativePath ? { logPath: logInfo.relativePath } : {}),
          statusMessage: "Code Agent is thinking"
        }
      });
      const now = new Date();
      await this.prisma.codeTaskRun.update({
        where: { id: codeTaskRunId },
        data: {
          status: "running",
          startedAt: now,
          leaseOwner,
          leaseExpiresAt: new Date(now.getTime() + CODE_TASK_RUN_LEASE_MS),
          heartbeatAt: now,
          statusMessage: "Code Agent is thinking"
        }
      });
    }
    const heartbeat = codeTaskRunId ? setInterval(() => {
      void this.prisma.codeTaskRun.updateMany({
        where: { id: codeTaskRunId, status: { in: ["running", "cancelling"] }, leaseOwner, deletedAt: null },
        data: {
          heartbeatAt: new Date(),
          leaseExpiresAt: new Date(Date.now() + CODE_TASK_RUN_LEASE_MS)
        }
      });
    }, CODE_TASK_RUN_HEARTBEAT_MS) : undefined;
    const markCancelling = () => {
      if (!codeTaskRunId) return;
      void this.prisma.codeTaskRun.updateMany({
        where: { id: codeTaskRunId, status: "running", leaseOwner, deletedAt: null },
        data: {
          status: "cancelling",
          cancelledAt: new Date(),
          statusMessage: "Cancellation requested"
        }
      });
    };
    options.signal?.addEventListener("abort", markCancelling, { once: true });
    const previousCodeSession = await this.readCompatibleCodeAgentSession(conversationId, agent.id, provider).catch(() => ({}));
    const resumeSessionId = optionalString(asRecord(previousCodeSession)?.providerSessionId);
    const liveUpdater = createCodeAgentLiveUpdater({
      flushMs: this.config.codeRunner.eventFlushMs,
      flush: async (state) => {
        await this.updateAgentMessageBlocks(
          liveMessage.id,
          buildCodeTaskLiveBlocks({
            codeTaskRunId: codeTaskRunId ?? liveMessage.id,
            title: `${agent.name} 正在思考`,
            status: state.blockStatus,
            progress: state.progress,
            text: state.text
          }),
          state.messageStatus
        );
      }
    });
    let result: CodeAgentTaskResult;
    try {
      const backend = executionPlan.backend;
      if (backend) {
        const protocolResult = await backend.run({
          workspaceRoot: codeWorkspaceRoot,
          prompt,
          ...(logInfo?.absolutePath ? { logFilePath: logInfo.absolutePath } : {}),
          ...(resumeSessionId ? { resumeSessionId } : {}),
          ...(options.signal ? { signal: options.signal } : {}),
          onEvent: async (event) => {
            await liveUpdater.push(event);
          }
        });
        await liveUpdater.flush();
        result = codeAgentTaskResultFromProtocol(protocolResult, requestedProvider, codeWorkspaceRoot);
      } else {
        if (!this.codeAgentAdapter) throw new Error("Code Agent Adapter is not registered");
        await this.updateAgentMessageBlocks(
          liveMessage.id,
          buildCodeTaskLiveBlocks({
            codeTaskRunId: codeTaskRunId ?? liveMessage.id,
            title: `${agent.name} 正在思考`,
            status: "running",
            progress: 0.2,
            text: "正在思考中..."
          }),
          "processing"
        );
        result = await this.codeAgentAdapter.runCodeTask({
          provider,
          workspaceRoot: codeWorkspaceRoot,
          prompt,
          ...(logInfo?.absolutePath ? { logFilePath: logInfo.absolutePath } : {}),
          ...(options.signal ? { signal: options.signal } : {})
        });
      }
    } catch (error) {
      if (heartbeat) clearInterval(heartbeat);
      options.signal?.removeEventListener("abort", markCancelling);
      const errorMessage = error instanceof Error ? error.message : String(error);
      await liveUpdater.flush().catch(() => undefined);
      if (codeTaskRunId) {
        await this.prisma.codeTaskRun.update({
          where: { id: codeTaskRunId },
          data: {
            status: "failed",
            completedAt: new Date(),
            leaseOwner: null,
            leaseExpiresAt: null,
            heartbeatAt: null,
            statusMessage: errorMessage
          }
        });
      }
      await this.updateAgentMessageBlocks(
        liveMessage.id,
        buildCodeTaskLiveBlocks({
          codeTaskRunId: codeTaskRunId ?? liveMessage.id,
          title: `${agent.name} 执行失败`,
          status: "failed",
          progress: 1,
          text: `Code Agent 执行失败：${errorMessage}`
        }),
        "failed"
      );
      throw error;
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      options.signal?.removeEventListener("abort", markCancelling);
    }
    const diffInfo = workspaceId && codeTaskRunId && result.diffText ? await this.prepareCodeRunDiff(workspaceId, codeTaskRunId, result.diffText, result.changedFiles ?? []) : undefined;
    const finalStatus = codeTaskRunStatusForResult(result);
    const reviewStatus = finalStatus === "completed" && diffInfo?.assetId && (result.changedFiles?.length ?? 0) > 0 ? "waiting_review" : finalStatus;
    if (codeTaskRunId) {
      await this.prisma.codeTaskRun.update({
        where: { id: codeTaskRunId },
        data: {
          status: reviewStatus,
          completedAt: new Date(),
          ...(finalStatus === "cancelled" ? { cancelledAt: new Date() } : {}),
          ...(diffInfo?.assetId ? { diffAssetId: diffInfo.assetId } : {}),
          provider: result.provider,
          leaseOwner: null,
          leaseExpiresAt: null,
          heartbeatAt: null,
          statusMessage: reviewStatus === "waiting_review" ? "Code Agent 变更等待群聊审阅" : codeTaskRunStatusMessage(result)
        }
      });
    }
    await this.observability?.system({
      level: result.exitCode === 0 ? "info" : "error",
      scope: `code-agent:${agent.id}`,
      message: result.exitCode === 0 ? "Code agent task completed" : "Code agent task failed",
	      payload: {
	        conversationId,
	        workspaceRoot: codeWorkspaceRoot,
	        projectWorkspaceRoot: workspaceRoot,
	        provider: result.provider,
        command: result.command,
        exitCode: result.exitCode,
        timedOut: Boolean(result.timedOut),
        cancelled: Boolean(result.cancelled),
        stdout: truncateForLog(result.stdout),
        stderr: truncateForLog(result.stderr)
      }
    });
    const completedAt = new Date().toISOString();
    const executionBrief = buildCodeExecutionBrief(agent, result, {
      ...(codeTaskRunId ? { codeTaskRunId } : {}),
      ...(logInfo?.assetId ? { logAssetId: logInfo.assetId } : {}),
      ...(diffInfo?.assetId ? { diffAssetId: diffInfo.assetId } : {}),
      ...(result.sessionId ? { sessionId: result.sessionId } : {}),
      startedAt,
      completedAt
    });
    const publicMessage = formatCodeAgentResult(agent.name, result);
    const finalBlocks = buildCodeTaskFinalBlocks({
      publicMessage,
      codeTaskRunId: codeTaskRunId ?? liveMessage.id,
      status: reviewStatus === "waiting_review" ? "waiting_review" : result.exitCode === 0 ? "completed" : "failed",
      summary: executionBrief.summary,
      diffAssetId: diffInfo?.assetId,
      changedFiles: result.changedFiles ?? [],
      diffText: result.diffText ?? ""
    });
    await this.updateAgentMessageBlocks(liveMessage.id, finalBlocks, result.exitCode === 0 ? "sent" : "failed");
    return {
      publicMessage,
      resultSummary: executionBrief.summary,
      status: result.exitCode === 0 ? "completed" : "failed",
      memoryPatch: {
        codeOutputMessageId: liveMessage.id,
        ...(codeTaskRunId ? { lastCodeTaskRunId: codeTaskRunId } : {}),
        ...(logInfo?.assetId ? { logAssetId: logInfo.assetId } : {}),
        ...(diffInfo?.assetId ? { diffAssetId: diffInfo.assetId } : {}),
        codeExecutionBrief: executionBrief
      }
    };
  }

  private async prepareCodeRunLog(workspaceId: string, codeTaskRunId: string, provider: CodeAgentTaskResult["provider"]) {
    const workspace = await this.prisma.workspace.findFirst({ where: { id: workspaceId, deletedAt: null } });
    if (!workspace) return undefined;
    const relativePath = `.agenthub/logs/${codeTaskRunId}.log`;
    const absolutePath = resolve(workspace.rootPath, relativePath);
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, "", "utf8");
    const asset = await this.prisma.workspaceAsset.create({
      data: {
        id: `asset-${nanoid(10)}`,
        workspaceId,
        kind: "log",
        name: `${codeTaskRunId}.log`,
        path: relativePath,
        mimeType: "text/plain",
        summary: `${provider} run live log`
      }
    });
    return { assetId: asset.id, relativePath, absolutePath };
  }

  private async prepareCodeRunDiff(workspaceId: string, codeTaskRunId: string, diffText: string, changedFiles: Array<{ path: string }>) {
    const workspace = await this.prisma.workspace.findFirst({ where: { id: workspaceId, deletedAt: null } });
    if (!workspace) return undefined;
    const relativePath = `.agenthub/diffs/${codeTaskRunId}.diff`;
    const absolutePath = resolve(workspace.rootPath, relativePath);
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, diffText, "utf8");
    const asset = await this.prisma.workspaceAsset.create({
      data: {
        id: `asset-${nanoid(10)}`,
        workspaceId,
        kind: "diff",
        name: `${codeTaskRunId}.diff`,
        path: relativePath,
        mimeType: "text/x-diff",
        summary: `Code Agent diff · ${changedFiles.length} files`
      }
    });
    await this.realtime.emit("workspace", workspaceId, "workspace.asset.created", { asset });
    return { assetId: asset.id, relativePath, absolutePath };
  }

  private buildAssignmentContext(run: RuntimeWorkingMemory, assignment: Assignment) {
    return {
      currentRun: run,
      currentAssignment: assignment,
      previousAgentOutputs: (run.agentRuns ?? []).map((item) => ({
        workItemId: item.workItemId,
        agentId: item.agentId,
        status: item.status,
        outputMessageId: item.outputMessageId
      })),
      availableInterfaces: {
        tools: executableRuntimeToolRegistry
      }
    };
  }

  private async resolveAgentMemoryOwnerUserId(conversationId: string, message: ChatMessage) {
    const conversation = await this.prisma.conversation.findFirst({
      where: { id: conversationId, deletedAt: null },
      select: { type: true }
    });
    if (conversation?.type === "project") return "project";
    if (message.sender.type === "user" && message.sender.id) return message.sender.id;
    const owner = await this.prisma.conversationMember.findFirst({
      where: {
        conversationId,
        memberType: "user",
        role: "owner",
        deletedAt: null
      },
      orderBy: { createdAt: "asc" }
    });
    return owner?.memberId ?? "project";
  }

  private async buildAssignmentCoordinationMessage(conversationId: string, fallbackMessage: string, workItems: Assignment[]) {
    if (workItems.length === 0) return { text: fallbackMessage, mentions: [] };
    const entries = await Promise.all(workItems.map(async (assignment, index) => {
      const agent = await this.resolveAssignmentAgent(conversationId, assignment.agentId);
      return {
        assignment,
        index,
        agent,
        mention: isAssignmentDeploymentIntent(assignment) ? "@deploy" : displayMentionForAgent(agent.id),
        mentionKey: isAssignmentDeploymentIntent(assignment) ? "deploy" : mentionKeyForAgent(agent.id)
      };
    }));
    const levels = uniqueNumbers(entries.map((entry) => assignmentSchedulingLevel(entry.assignment))).sort((a, b) => a - b);
    const lines = ["收到，已按优先级分配本轮任务："];
    for (const level of levels) {
      const group = entries
        .filter((entry) => assignmentSchedulingLevel(entry.assignment) === level)
        .sort((a, b) => a.index - b.index);
      const label = group.length > 1 ? `优先级 ${level}（按队列顺序执行）` : `优先级 ${level}`;
      const tasks = group.map((entry) => `${entry.mention} ${compactAssignmentTask(entry.assignment.task)}`).join("；");
      lines.push(`- ${label}：${tasks}`);
    }
    lines.push("", "执行规则：低优先级工作项全部校验通过后，再进入下一优先级。");
    return { text: lines.join("\n"), mentions: uniqueStrings(entries.map((entry) => entry.mentionKey)) };
  }

  private async resolveAssignmentAgent(conversationId: string, requestedAgentId: string): Promise<RuntimeAgentIdentity> {
    if (isOrchestratorAgentId(requestedAgentId)) {
      const universal = await this.prisma.agent.findFirst({ where: { id: "agent-universal", deletedAt: null } });
      return universal ? this.agentToIdentity(universal) : { id: "agent-universal", name: "Universal Agent", avatar: "/avatars/agents/agent-v2-02.png", role: "通用兜底", type: "internal" };
    }
    if (isCodeAgentRequest(requestedAgentId)) {
      return this.codeAgentIdentity(await this.resolveConversationCodeAgentId(conversationId) ?? normalizeCodeAgentId(requestedAgentId) ?? "agent-codex");
    }
    const agent = await this.prisma.agent.findFirst({ where: { id: requestedAgentId, deletedAt: null } });
    if (agent) return this.agentToIdentity(agent);
    const universal = await this.prisma.agent.findFirst({ where: { id: "agent-universal", deletedAt: null } });
    return universal ? this.agentToIdentity(universal) : { id: "agent-universal", name: "Universal Agent", avatar: "/avatars/agents/agent-v2-02.png", role: "通用兜底", type: "internal" };
  }

  private async constrainAssignmentsForConversation(conversationId: string, workItems: Assignment[]) {
    if (!await this.isProjectConversation(conversationId)) {
      return { workItems, omittedUnavailableAssignments: [], reroutedAssignments: [] };
    }
    const allowedAgentIds = await this.resolveProjectConversationAgentIds(conversationId);
    const conversationCodeAgentId = await this.resolveConversationCodeAgentId(conversationId);
    const universalAgentId = allowedAgentIds.has("agent-universal") ? "agent-universal" : undefined;
    const omittedUnavailableAssignments: Array<Record<string, unknown>> = [];
    const reroutedAssignments: Array<Record<string, unknown>> = [];
    const constrained = workItems.flatMap((item): Assignment[] => {
      const requestedAgentId = item.agentId;
      const requestedCodeAgentId = normalizeCodeAgentId(requestedAgentId);
      let agentId = requestedCodeAgentId ? (conversationCodeAgentId ?? requestedCodeAgentId) : requestedAgentId;
      const unavailable = !allowedAgentIds.has(agentId);
      if (unavailable) {
        if (!universalAgentId) {
          omittedUnavailableAssignments.push({ ...item, requestedAgentId, reason: "Agent is not a member of this project conversation" });
          return [];
        }
        reroutedAssignments.push({
          workItemId: item.workItemId,
          fromAgentId: requestedAgentId,
          toAgentId: universalAgentId,
          reason: "requested agent is not a member of this project conversation"
        });
        agentId = universalAgentId;
      }
      if (isCodeAgentRequest(agentId) && !isConcreteCodeImplementationAssignment(item) && universalAgentId) {
        reroutedAssignments.push({
          workItemId: item.workItemId,
          fromAgentId: agentId,
          toAgentId: universalAgentId,
          reason: "Code Agent is reserved for concrete code implementation, file editing, execution, and debugging"
        });
        agentId = universalAgentId;
      }
      return [{ ...item, agentId }];
    });
    return { workItems: constrained, omittedUnavailableAssignments, reroutedAssignments };
  }

  private async resolveProjectConversationAgentIds(conversationId: string) {
    const members = await this.prisma.conversationMember.findMany({
      where: { conversationId, memberType: "agent", deletedAt: null },
      select: { memberId: true }
    });
    return new Set(members.map((member) => member.memberId));
  }

  private agentToIdentity(agent: Agent): RuntimeAgentIdentity {
    return {
      id: agent.id,
      name: agent.name,
      avatar: agent.avatar ?? agent.name.slice(0, 2),
      role: agent.description,
      type: agent.type === "code" ? "code" : "internal",
      provider: agent.provider,
      capabilities: agent.capabilities
    };
  }

  private codeAgentIdentity(agentId: string): RuntimeAgentIdentity {
    if (agentId === "agent-opencode" || agentId === "opencode") return { id: "agent-opencode", name: "OpenCode", avatar: "/avatars/agents/agent-v2-06.png", role: "代码实现", type: "code", provider: "opencode" };
    return { id: "agent-codex", name: "Codex", avatar: "/avatars/agents/agent-v2-05.png", role: "代码实现", type: "code", provider: "codex" };
  }

  private async replyCodeAgent(message: ChatMessage, codeAgent?: string, options: CodeAgentReplyOptions = {}) {
    const agent = this.codeAgentIdentity(normalizeCodeAgentId(codeAgent ?? "") ?? await this.resolveConversationCodeAgentId(message.conversationId) ?? "agent-codex");
    const userPrompt = extractCodeInstructionText(message);
    const output = await this.executeCodePrompt(message.conversationId, agent, userPrompt, options);
    const existingOutputMessageId = optionalString(asRecord(output.memoryPatch)?.codeOutputMessageId);
    const outputMessage = existingOutputMessageId
      ? await this.getExistingOutputMessage(message.conversationId, existingOutputMessageId)
      : await this.createAgentMessage(message.conversationId, [createMarkdownBlock(`block-${nanoid(8)}`, output.publicMessage)], agent, output.status === "failed" ? "failed" : "sent");
    const actualProvider = codeProviderFromOutput(output, requestedCodeProviderForAgent(agent));
    await this.appendCodeAgentSession({
      conversationId: message.conversationId,
      agentId: agent.id,
      provider: actualProvider,
      userMessageId: message.id,
      userText: userPrompt,
      assistantMessageId: outputMessage.id,
      output
    });
    await this.appendDirectAgentRunBrief({
      conversationId: message.conversationId,
      agent,
      message,
      output,
      outputMessageId: outputMessage.id,
      taskGoal: userPrompt,
      triggerSource: "direct_code_agent_chat",
      agentType: "code"
    });
    await this.maybeStartDeploymentAfterCodeAgent(message, agent, output);
  }

  private async maybeStartDeploymentAfterCodeAgent(message: ChatMessage, agent: RuntimeAgentIdentity, output: RuntimeAgentResult) {
    if (!this.deployments) return;
    if (message.sender.type !== "user" || !message.sender.id) return;
    if (!await this.isProjectConversation(message.conversationId)) return;
    const instruction = extractCodeInstructionText(message);
    if (!isCodeAgentDeploymentIntent(instruction)) return;
    if (output.status !== "completed") {
      await this.createAgentMessage(
        message.conversationId,
        [createMarkdownBlock(`block-${nanoid(8)}`, `${agent.name} 还没有完成本次代码任务，因此不会自动启动部署。`)],
        agent,
        "failed",
        {
          kind: "code_agent_deployment_skipped",
          codeAgentId: agent.id,
          triggerMessageId: message.id,
          codeAgentStatus: output.status
        }
      );
      return;
    }
    try {
      await this.deployments.startStaticPreviewDeploymentFromRuntime({
        userId: message.sender.id,
        conversationId: message.conversationId,
        triggerMessageId: message.id,
        title: `${agent.name} 构建后的静态预览`
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      await this.createAgentMessage(
        message.conversationId,
        [createMarkdownBlock(`block-${nanoid(8)}`, `${agent.name} 已完成代码任务，但自动部署启动失败：${errorMessage}`)],
        agent,
        "failed",
        {
          kind: "code_agent_deployment_failed",
          codeAgentId: agent.id,
          triggerMessageId: message.id,
          error: errorMessage
        }
      );
    }
  }

  private async maybeStartDeploymentAfterCodeAssignment(input: {
    conversationId: string;
    userId: string;
    assignment: Assignment;
    agent: RuntimeAgentIdentity;
    output: RuntimeAgentResult;
    runId: string;
  }) {
    if (!this.deployments) return;
    if (!input.userId || input.userId === "project") return;
    if (!await this.isProjectConversation(input.conversationId)) return;
    if (!isAssignmentDeploymentIntent(input.assignment)) return;
    if (input.output.status !== "completed") return;
    try {
      await this.deployments.startStaticPreviewDeploymentFromRuntime({
        userId: input.userId,
        conversationId: input.conversationId,
        title: `${input.agent.name} 完成后的 @deploy 静态预览`
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      await this.createAgentMessage(
        input.conversationId,
        [createMarkdownBlock(`block-${nanoid(8)}`, `${input.agent.name} 已完成部署前置任务，但 @deploy 自动发布失败：${errorMessage}`)],
        input.agent,
        "failed",
        {
          kind: "assignment_deployment_failed",
          codeAgentId: input.agent.id,
          runId: input.runId,
          workItemId: input.assignment.workItemId,
          error: errorMessage
        }
      );
    }
  }

  private async replyInternalAgent(message: ChatMessage, agentId: string) {
    const agent = await this.prisma.agent.findFirst({ where: { id: agentId, deletedAt: null } });
    if (!agent) return;
    const output = agent.id === "agent-ui"
      ? await this.uiAgent().runDirect({ conversationId: message.conversationId, agent, userId: message.sender.id, triggerMessage: message })
      : await this.agent().runDirect({ conversationId: message.conversationId, agent, userId: message.sender.id, triggerMessage: message });
    const identity = this.agentToIdentity(agent);
    const outputMessage = await this.createAgentMessage(message.conversationId, buildAgentOutputBlocks(output), identity, output.status === "failed" ? "failed" : "sent");
    await this.appendDirectAgentRunBrief({
      conversationId: message.conversationId,
      agent: identity,
      message,
      output,
      outputMessageId: outputMessage.id,
      taskGoal: extractCodeInstructionText(message),
      triggerSource: agent.id === "agent-ui" ? "direct_ui_agent_chat" : "direct_agent_chat",
      agentType: agent.type
    });
  }

  private async appendDirectAgentRunBrief(input: {
    conversationId: string;
    agent: RuntimeAgentIdentity;
    message: ChatMessage;
    output: RuntimeAgentResult;
    outputMessageId: string;
    taskGoal: string;
    triggerSource: string;
    agentType: string;
  }) {
    const conversation = await this.prisma.conversation.findFirst({
      where: { id: input.conversationId, deletedAt: null },
      select: { workspaceId: true }
    });
    const ownerUserId = input.message.sender.type === "user" && input.message.sender.id
      ? input.message.sender.id
      : await this.resolveAgentMemoryOwnerUserId(input.conversationId, input.message);
    const memoryPatch = asRecord(input.output.memoryPatch) ?? {};
    const codeExecutionBrief = asRecord(memoryPatch.codeExecutionBrief);
    await this.memory().appendAgentRunBrief({
      conversationId: input.conversationId,
      workspaceId: conversation?.workspaceId ?? null,
      scope: "personal_direct",
      runId: `direct-run-${input.message.id}`,
      agentRunId: `direct-agent-run-${nanoid(10)}`,
      agentId: input.agent.id,
      agentType: input.agentType,
      ownerUserId,
      triggerSource: input.triggerSource,
      outputMessageId: input.outputMessageId,
      taskGoal: input.taskGoal,
      inputSummary: `用户消息：${input.taskGoal}`,
      processSummary: typeof codeExecutionBrief?.summary === "string" ? codeExecutionBrief.summary : input.output.resultSummary,
      resultSummary: input.output.resultSummary,
      status: input.output.status,
      createdAssets: buildAgentRunBriefAssets(input.output),
      usedTools: normalizeRuntimeList(memoryPatch.usedTools),
      usedSkills: normalizeRuntimeList(memoryPatch.usedSkills),
      verification: { status: "not_required", mode: "direct_chat" },
      risks: normalizeRuntimeList(memoryPatch.risks),
      openQuestions: input.output.status === "needs_clarification" ? [input.output.publicMessage] : normalizeRuntimeList(memoryPatch.openQuestions),
      qualitySignals: {
        outputMessageId: input.outputMessageId,
        validateStatus: "not_required"
      },
      memoryCandidates: memoryPatch
    });
  }

  private async resolveDirectCodeAgent(conversationId: string) {
    const conversation = await this.prisma.conversation.findFirst({ where: { id: conversationId, deletedAt: null } });
    if (conversation?.type !== "agent_direct") return undefined;
    return normalizeCodeAgentId(conversation.codeAgentId ?? "");
  }

  private async resolveConversationCodeAgentId(conversationId: string) {
    const conversation = await this.prisma.conversation.findFirst({
      where: { id: conversationId, deletedAt: null },
      select: { codeAgentId: true }
    });
    return normalizeCodeAgentId(conversation?.codeAgentId ?? "");
  }

  private async resolveDirectInternalAgent(conversationId: string) {
    const conversation = await this.prisma.conversation.findFirst({
      where: { id: conversationId, deletedAt: null },
      include: { members: { where: { memberType: "agent", deletedAt: null } } }
    });
    if (conversation?.type !== "agent_direct") return undefined;
    const agentId = conversation.members[0]?.memberId;
    if (!agentId || agentId === "agent-codex" || agentId === "agent-opencode") return undefined;
    return agentId;
  }

  private async resolveWorkspaceRoot(conversationId: string) {
    const conversation = await this.prisma.conversation.findFirst({
      where: { id: conversationId, deletedAt: null },
      include: { workspace: true }
    });
    if (conversation?.workspace?.rootPath) return { workspaceRoot: conversation.workspace.rootPath, workspaceId: conversation.workspace.id };
    const workspaceId = conversation?.workspaceId ?? `workspace-${conversationId}`;
    return { workspaceRoot: `${process.cwd()}/../workspaces/${workspaceId}`, workspaceId: conversation?.workspaceId ?? undefined };
  }

  private async readCodeAgentSession(conversationId: string, agentId: string) {
    const row = await this.prisma.agentConversation.upsert({
      where: { conversationId_agentId: { conversationId, agentId } },
      create: {
        id: `agent-conv-${nanoid(10)}`,
        conversationId,
        agentId,
        providerSession: {
          provider: agentId === "agent-opencode" ? "opencode" : "codex",
          lockedAgentId: agentId,
          providerSessionMode: "agenthub_managed",
          providerSessionId: null,
          cliLifecycle: "task_process",
          executions: [],
          turns: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        } as Prisma.InputJsonValue
      },
      update: {}
    });
    return asRecord(row.providerSession) ?? { turns: [] };
  }

  private async readCompatibleCodeAgentSession(conversationId: string, agentId: string, provider: CodeAgentTaskResult["provider"]) {
    const session = await this.readCodeAgentSession(conversationId, agentId);
    const record = asRecord(session) ?? {};
    const lifecycle = optionalString(record.cliLifecycle);
    const sessionProvider = optionalCodeProvider(record.provider);
    const sessionId = optionalString(record.providerSessionId);
    if (sessionId && lifecycle === "provider_session" && sessionProvider === provider) return record;
    return { ...record, providerSessionId: null };
  }

  private async appendCodeAgentSession(input: {
    conversationId: string;
    agentId: string;
    provider: string;
    userMessageId?: string | undefined;
    userText: string;
    assistantMessageId: string;
    output: RuntimeAgentResult;
  }) {
    const current = await this.readCodeAgentSession(input.conversationId, input.agentId);
    const turns = Array.isArray(current.turns) ? current.turns.filter(asRecord) : [];
    const memoryPatch = asRecord(input.output.memoryPatch);
    const executionBrief = asRecord(memoryPatch?.codeExecutionBrief);
    const codeTaskRunId = typeof memoryPatch?.lastCodeTaskRunId === "string" ? memoryPatch.lastCodeTaskRunId : undefined;
    const logAssetId = typeof memoryPatch?.logAssetId === "string" ? memoryPatch.logAssetId : undefined;
    const sessionId = typeof executionBrief?.sessionId === "string" ? executionBrief.sessionId : undefined;
    const execution = {
      ...(executionBrief ?? {}),
      id: codeTaskRunId ?? `code-exec-${nanoid(10)}`,
      agentId: input.agentId,
      provider: input.provider,
      ...(input.userMessageId ? { userMessageId: input.userMessageId } : {}),
      assistantMessageId: input.assistantMessageId,
      instruction: input.userText,
      ...(codeTaskRunId ? { codeTaskRunId } : {}),
      ...(logAssetId ? { logAssetId } : {}),
      completedAt: typeof executionBrief?.completedAt === "string" ? executionBrief.completedAt : new Date().toISOString()
    };
    const executions = Array.isArray(current.executions) ? current.executions.filter(asRecord) : [];
    const nextSession = {
      ...current,
      provider: input.provider,
      lockedAgentId: input.agentId,
      providerSessionMode: typeof current.providerSessionMode === "string" ? current.providerSessionMode : "agenthub_managed",
      providerSessionId: sessionId ?? (typeof current.providerSessionId === "string" ? current.providerSessionId : null),
      cliLifecycle: sessionId ? "provider_session" : "task_process",
      executions: [...executions, execution].slice(-40),
      turns: [
        ...turns,
        {
          role: "user",
          ...(input.userMessageId ? { messageId: input.userMessageId } : {}),
          text: input.userText,
          at: new Date().toISOString()
        },
        {
          role: "assistant",
          messageId: input.assistantMessageId,
          status: input.output.status,
          summary: input.output.resultSummary,
          ...(codeTaskRunId ? { codeTaskRunId } : {}),
          ...(logAssetId ? { logAssetId } : {}),
          at: new Date().toISOString()
        }
      ].slice(-20),
      updatedAt: new Date().toISOString()
    };
    await this.prisma.agentConversation.update({
      where: { conversationId_agentId: { conversationId: input.conversationId, agentId: input.agentId } },
      data: { providerSession: nextSession as Prisma.InputJsonValue }
    });
    await this.memory().appendCodeExecutionMemory({
      conversationId: input.conversationId,
      agentId: input.agentId,
      provider: input.provider,
      ...(input.userMessageId ? { userMessageId: input.userMessageId } : {}),
      assistantMessageId: input.assistantMessageId,
      instruction: input.userText,
      execution
    });
  }

  private async resolveCodeAgentExecutionPlan(requestedProvider: CodeAgentTaskResult["provider"]): Promise<{
    backend: CodeAgentBackend | null;
    actualProvider: CodeAgentTaskResult["provider"];
  }> {
    const runtimeConfig = await this.runtimeConfig?.getEffectiveConfig("code").catch(() => null);
    const backend = runtimeConfig ? this.codeAgentBackendRegistry?.resolve(requestedProvider, runtimeConfig) ?? null : null;
    return {
      backend,
      actualProvider: backend?.provider ?? requestedProvider
    };
  }

  private async createAgentMessage(
    conversationId: string,
    blocks: MessageBlock[],
    agent: RuntimeAgentIdentity = { id: "agent-orchestrator", name: "Orchestrator", avatar: "/avatars/agents/agent-v2-01.png", role: "主协调", type: "internal" },
    status: ChatMessage["status"] = "sent",
    metadata?: Record<string, unknown>,
    mentions: string[] = []
  ) {
    const message = await this.prisma.$transaction(async (tx) => {
      const seq = await this.nextMessageSeq(tx, conversationId);
      const created = await tx.message.create({
        data: {
          id: `msg-${nanoid(10)}`,
          conversationId,
          senderType: "agent",
          senderId: agent.id,
          senderName: agent.name,
          senderAvatar: agent.avatar,
          senderSubtitle: null,
          blocks: blocks as unknown as Prisma.InputJsonValue,
          mentions: uniqueStrings(mentions) as unknown as Prisma.InputJsonValue,
          ...(metadata ? { metadata: metadata as Prisma.InputJsonValue } : {}),
          seq,
          status
        }
      });
      await tx.conversation.update({
        where: { id: conversationId },
        data: { lastMessage: summarizeBlocks(blocks) }
      });
      await tx.conversationMember.updateMany({
        where: { conversationId, memberType: "user", deletedAt: null },
        data: { unreadCount: { increment: 1 } }
      });
      return created;
    });
    const chatMessage = toChatMessage(message);
    await this.realtime.emit("conversation", conversationId, "message.created", { message: chatMessage });
    const members = await this.prisma.conversationMember.findMany({
      where: { conversationId, memberType: "user", deletedAt: null },
      select: { memberId: true }
    });
    for (const member of members) {
      await this.realtime.emit("user", member.memberId, "conversation.updated", { conversationId, reason: "message_created" });
    }
    return chatMessage;
  }

  private async getExistingOutputMessage(conversationId: string, messageId: string) {
    const message = await this.prisma.message.findFirst({
      where: { id: messageId, conversationId, deletedAt: null }
    });
    if (!message) throw new Error(`Code Agent output message not found: ${messageId}`);
    return message;
  }

  private async updateAgentMessageBlocks(messageId: string, blocks: MessageBlock[], status?: ChatMessage["status"]) {
    const message = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.message.update({
        where: { id: messageId },
        data: {
          blocks: blocks as unknown as Prisma.InputJsonValue,
          ...(status ? { status } : {})
        }
      });
      await tx.conversation.update({
        where: { id: updated.conversationId },
        data: { lastMessage: summarizeBlocks(blocks) }
      });
      return updated;
    });
    const chatMessage = toChatMessage(message);
    await this.realtime.emit("conversation", message.conversationId, "message.updated", { message: chatMessage });
    return chatMessage;
  }

  private async nextMessageSeq(tx: Prisma.TransactionClient, conversationId: string) {
    const conversation = await tx.conversation.update({
      where: { id: conversationId },
      data: { messageSeq: { increment: 1 } },
      select: { messageSeq: true }
    });
    return conversation.messageSeq;
  }

  private async applyValidationActions(messageId: string, runId: string, validate: z.infer<typeof validateResultSchema>, reviewMessageId?: string) {
    const target = await this.prisma.message.findFirst({ where: { id: messageId, deletedAt: null } });
    if (!target) return;
    const actions: MessageAction[] = [];
    if (reviewMessageId) {
      actions.push(await this.createRuntimeMessageAction(target, "reply", {
        runId,
        replyMessageId: reviewMessageId,
        kind: "review",
        reason: validate.reason
      }));
    }
    if (validate.likeMessage) actions.push(await this.createRuntimeMessageAction(target, "like", { runId, reason: validate.reason }));
    if (validate.pinMessage) {
      const action = await this.createRuntimeMessageAction(target, "pin", { runId, reason: validate.reason });
      await this.memory().appendPinnedMessageMemory(target.conversationId, target, action);
      actions.push(action);
    }
    for (const action of actions) {
      await this.realtime.emit("conversation", target.conversationId, "message.action.created", {
        conversationId: target.conversationId,
        messageId: target.id,
        action: {
          id: action.id,
          messageId: action.messageId,
          actor: { type: "agent", id: "agent-orchestrator", name: "Orchestrator", avatar: "/avatars/agents/agent-v2-01.png" },
          type: action.type,
          payload: action.payload,
          createdAt: action.createdAt.toISOString()
        }
      });
    }
  }

  private async createRuntimeMessageAction(message: Message, type: "like" | "pin" | "reply", payload: Record<string, unknown>) {
    if (type === "like" || type === "pin") {
      const existing = await this.prisma.messageAction.findFirst({
        where: { messageId: message.id, actorType: "agent", actorId: "agent-orchestrator", type, deletedAt: null },
        orderBy: { createdAt: "desc" }
      });
      if (existing) return existing;
    }
    return this.prisma.messageAction.create({
      data: {
        id: `action-${nanoid(10)}`,
        messageId: message.id,
        actorType: "agent",
        actorId: "agent-orchestrator",
        type,
        payload: { ...payload, actorName: "Orchestrator", actorAvatar: "/avatars/agents/agent-v2-01.png" } as Prisma.InputJsonValue
      }
    });
  }

  private async buildMessageReference(conversationId: string, messageId: string, kind: ChatMessageReference["kind"]): Promise<ChatMessageReference> {
    const target = await this.prisma.message.findFirst({ where: { id: messageId, conversationId, deletedAt: null } });
    if (!target) return { messageId, senderName: "未知消息", summary: "引用的消息不可用", kind };
    return {
      messageId: target.id,
      senderName: target.senderName,
      senderAvatar: target.senderAvatar,
      summary: summarizeMessage(target),
      kind,
      createdAt: target.createdAt.toISOString()
    };
  }

  private async buildReviewReference(conversationId: string, messageId: string) {
    const target = await this.prisma.message.findFirst({
      where: { id: messageId, conversationId, deletedAt: null },
      select: { senderId: true }
    });
    if (target?.senderId === "agent-orchestrator") return undefined;
    return this.buildMessageReference(conversationId, messageId, "review");
  }

  private async transitionRun(run: RuntimeWorkingMemory, nextNode: OrchestratorNode, reason: string, payload?: unknown) {
    const previousNode = run.currentNode;
    const next = advanceRun(run, nextNode, reason) as RuntimeWorkingMemory;
    next.edgeHistory = [
      ...(run.edgeHistory ?? []),
      { at: new Date().toISOString(), source: previousNode, target: nextNode, reason, payload, chain: edgeChain(previousNode, nextNode) }
    ];
    await this.updateRun(next);
    const transition = { fromNode: previousNode, toNode: nextNode, reason, payload, run: next };
    await this.realtime.emit("run", run.id, "run.node.finished", { node: previousNode, nextNode, summary: reason, run: next });
    await this.realtime.emit("conversation", run.conversationId, "run.node.finished", { node: previousNode, nextNode, summary: reason, run: next });
    await this.realtime.emit("run", run.id, "run.transitioned", transition);
    await this.realtime.emit("conversation", run.conversationId, "run.transitioned", transition);
    if (next.status === "running") {
      await this.realtime.emit("run", run.id, "run.node.started", { node: nextNode, previousNode, run: next });
      await this.realtime.emit("conversation", run.conversationId, "run.node.started", { node: nextNode, previousNode, run: next });
    }
    return next;
  }

  private async updateRun(run: RuntimeWorkingMemory, override?: Partial<{ status: RuntimeWorkingMemory["status"]; waitingOn: unknown }>) {
    if (override?.status) run.status = override.status;
    const data: Prisma.OrchestratorRunUpdateInput = {
      status: run.status,
      currentNode: run.currentNode,
      completedAt: run.completedAt ? new Date(run.completedAt) : null,
      workingMemory: run as unknown as Prisma.InputJsonValue
    };
    if (override && "waitingOn" in override) data.waitingOn = override.waitingOn as Prisma.InputJsonValue;
    await this.prisma.orchestratorRun.update({ where: { id: run.id }, data });
    await this.realtime.emit("run", run.id, "run.updated", { run });
    await this.realtime.emit("conversation", run.conversationId, "run.updated", { run });
  }

  private applyRunMemoryPatch(run: RuntimeWorkingMemory, patch: Record<string, unknown>) {
    if (!patch || Object.keys(patch).length === 0) return;
    run.runMeta = { ...(run.runMeta ?? {}), ...patch };
  }

  private context() {
    this.contextManager ??= new ContextManagerService(this.prisma);
    return this.contextManager;
  }

  private memory() {
    this.memoryManager ??= new MemoryManagerService(this.prisma, this.llm);
    return this.memoryManager;
  }

  private tools() {
    if (!this.toolRuntime) {
      this.toolRuntime = new ToolRuntimeService(this.prisma, this.config, this.knowledgeService);
    }
    return this.toolRuntime;
  }

  private agent() {
    this.agentRuntime ??= new AgentRuntimeService(this.prisma, this.llm, this.context(), this.memory(), this.tools());
    return this.agentRuntime;
  }

  private uiAgent() {
    this.excalidrawRenderer ??= new ExcalidrawRenderService();
    this.uiAgentRuntime ??= new UiAgentRuntimeService(this.prisma, this.llm, this.context(), this.memory(), this.tools(), this.excalidrawRenderer, this.realtime);
    return this.uiAgentRuntime;
  }
}

function extractMessageText(message: ChatMessage) {
  return message.blocks.map((block) => (block.type === "markdown" ? block.payload.text : block.type)).join("\n").trim();
}

function isMentionOnlyUserText(message: ChatMessage) {
  if (message.sender.type !== "user") return false;
  if (message.blocks.some((block) => block.type !== "markdown")) return false;
  const text = extractMessageText(message);
  if (!/@[\p{L}\p{N}_-]+/u.test(text)) return false;
  return text.replace(/@[\p{L}\p{N}_-]+/gu, "").replace(/[\s，。,.!?！？、:：;；]+/gu, "").trim().length === 0;
}

function readRunTriggerMessageId(run: RuntimeWorkingMemory) {
  const runMeta = asRecord(run.runMeta);
  return stringishOrUndefined(run.triggerMessageId ?? runMeta?.triggerMessageId);
}

function extractCodeInstructionText(message: ChatMessage) {
  const text = extractMessageText(message);
  const withoutCodeMentions = text
    .replace(/(^|\s)@(codex|agent-codex|opencode|agent-opencode|deploy|deployment|agent-deploy|部署|发布)(?=$|\s|[，。,.!?])/giu, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
  if (!withoutCodeMentions && (message.mentions ?? []).some(isDeployMention)) return "部署当前项目";
  return withoutCodeMentions || text;
}

function isCodeAgentDeploymentIntent(text: string) {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return false;
  if (/不要部署|别部署|无需部署|不需要部署|先不部署|不要发布|别发布|无需发布|不需要发布|先不发布|do not deploy|don't deploy|no deploy/.test(normalized)) {
    return false;
  }
  if (/部署方案|发布方案|上线方案|部署教程|发布教程|部署文档|部署说明|怎么部署|如何部署|怎么发布|如何发布|能不能部署|能否部署|可以部署吗|可以发布吗/.test(normalized)) {
    return false;
  }
  return /帮我部署|帮我发布|开始部署|开始发布|执行部署|执行发布|直接部署|直接发布|部署一下|发布一下|上线一下|部署当前|发布当前|上线当前|部署项目|发布项目|上线项目|生成预览|预览部署|静态预览|deploy\b|publish\b|ship\b/.test(normalized);
}

interface CodeDependencySummary {
  workItemId: string;
  agentId: string;
  task: string;
  outputMessageId: string;
  senderName?: string;
  text: string;
}

function buildCodeAssignmentPrompt(assignment: Assignment, dependencies: CodeDependencySummary[] = []) {
  const sections = [
    assignment.task,
    "",
    `预期产出：${assignment.expectedOutput}`,
    "",
    "工作目录：当前 Code Agent 只在项目工作空间的 Code/ 子目录内运行；代码、依赖和验证命令都应基于该目录，不要写入 ../Doc。"
  ];
  if (isAssignmentDeploymentIntent(assignment)) {
    sections.push(
      "",
      "部署任务说明：你负责完成部署前检查、必要构建判断和可部署性确认；不要直接启动长驻 HTTP 服务，不要绑定端口。AgentHub 后端会在你返回完成结果后创建静态预览并生成部署状态卡片。"
    );
  }
  if (assignment.acceptanceCriteria) {
    sections.push("", `验收标准：${assignment.acceptanceCriteria}`);
  }
  if (dependencies.length > 0) {
    sections.push("", "上游已通过的设计/方案输出：");
    for (const dependency of dependencies) {
      sections.push(
        "",
        `- ${dependency.workItemId} / ${dependency.senderName ?? dependency.agentId}：${dependency.task}`,
        `  消息：${dependency.outputMessageId}`,
        limitCodeContext(dependency.text)
      );
    }
    sections.push("", "请严格以上游输出作为实现依据，不要重新扩大范围；如发现上游信息不足，只实现已明确的最小可运行版本并在简报中说明缺口。");
  }
  return sections.join("\n");
}

function buildCodeAssignmentRetryPrompt(assignment: Assignment, validation: unknown) {
  const result = asRecord(validation);
  const sections = [
    "这是同一 Code Agent 会话的返工指令。请基于当前工作区、上一轮实现和已有上下文继续修改，不要从头重做，也不要重复解释已完成内容。",
    "",
    `工作项：${assignment.workItemId}`,
    `任务：${assignment.task}`,
    `预期产出：${assignment.expectedOutput}`,
    "工作目录：当前 Code Agent 只在项目工作空间的 Code/ 子目录内运行；代码、依赖和验证命令都应基于该目录，不要写入 ../Doc。"
  ];
  if (isAssignmentDeploymentIntent(assignment)) {
    sections.push(
      "",
      "部署任务说明：你负责完成部署前检查、必要构建判断和可部署性确认；不要直接启动长驻 HTTP 服务，不要绑定端口。AgentHub 后端会在你返回完成结果后创建静态预览并生成部署状态卡片。"
    );
  }
  if (assignment.acceptanceCriteria) sections.push(`验收标准：${assignment.acceptanceCriteria}`);
  const publicMessage = stringishOrUndefined(result?.publicMessage);
  const reason = stringishOrUndefined(result?.reason);
  if (publicMessage || reason) {
    sections.push("", "上次校验未通过的反馈：");
    if (publicMessage) sections.push(publicMessage);
    if (reason && reason !== publicMessage) sections.push(reason);
  }
  sections.push(
    "",
    "本轮只做必要的增量修复。完成后请返回：",
    "- 本轮修改摘要",
    "- 关键文件路径",
    "- 已运行或建议运行的验证命令",
    "- 如果仍有缺口，明确说明缺口和原因"
  );
  return sections.join("\n");
}

function dependencyOutputRefsFromContext(context: unknown, assignment: Assignment) {
  const currentRun = asRecord(asRecord(context)?.currentRun);
  const workItems = asArray(currentRun?.workItems).flatMap((item) => {
    const record = asRecord(item);
    if (!record) return [];
    const workItemId = typeof record.workItemId === "string" ? record.workItemId : "";
    const agentId = typeof record.agentId === "string" ? record.agentId : "";
    const task = typeof record.task === "string" ? record.task : "";
    const outputMessageId = typeof record.outputMessageId === "string" ? record.outputMessageId : "";
    return workItemId && outputMessageId ? [{ workItemId, agentId, task, outputMessageId }] : [];
  });
  return assignment.dependsOn.flatMap((dep) => {
    const normalized = dep.trim();
    return workItems.filter((item) => item.workItemId === normalized || item.agentId === normalized);
  });
}

function extractStoredMessageText(message: Message) {
  const blocks = message.blocks as unknown as MessageBlock[];
  const text = blocks.map((block) => (block.type === "markdown" ? block.payload.text : block.type)).join("\n").trim();
  return text || summarizeMessage(message);
}

function limitCodeContext(text: string) {
  const normalized = text.trim();
  return normalized.length > 1800 ? `${normalized.slice(0, 1800)}...` : normalized;
}

function summarizeBlocks(blocks: MessageBlock[]) {
  const first = blocks[0];
  if (!first) return "新消息";
  if (first.type === "markdown") return first.payload.text.slice(0, 80);
  if (first.type === "agent_status") return first.payload.title;
  return `${first.type} 消息`;
}

function buildAssignmentInputSummary(assignment: Assignment) {
  return [
    `任务：${assignment.task}`,
    `预期产出：${assignment.expectedOutput}`,
    assignment.acceptanceCriteria ? `验收标准：${assignment.acceptanceCriteria}` : ""
  ].filter(Boolean).join("\n");
}

function buildAgentRunBriefAssets(output: RuntimeAgentResult) {
  const assets: Array<Record<string, unknown>> = [];
  for (const asset of output.createdAssets ?? []) {
    assets.push({
      assetId: asset.assetId,
      workspaceId: asset.workspaceId,
      name: asset.name,
      path: asset.path,
      mimeType: asset.mimeType,
      ...(asset.size !== undefined ? { size: asset.size } : {}),
      ...(asset.summary ? { summary: asset.summary } : {})
    });
  }
  const memoryPatch = asRecord(output.memoryPatch);
  const codeBrief = asRecord(memoryPatch?.codeExecutionBrief);
  const codeTaskRunId = optionalString(memoryPatch?.lastCodeTaskRunId) || optionalString(codeBrief?.codeTaskRunId);
  const logAssetId = optionalString(memoryPatch?.logAssetId) || optionalString(codeBrief?.logAssetId);
  const diffAssetId = optionalString(memoryPatch?.diffAssetId) || optionalString(codeBrief?.diffAssetId);
  if (logAssetId) {
    assets.push({
      assetId: logAssetId,
      kind: "log",
      codeTaskRunId,
      summary: "Code Agent 执行日志"
    });
  }
  if (diffAssetId) {
    assets.push({
      assetId: diffAssetId,
      kind: "diff",
      codeTaskRunId,
      summary: "Code Agent 代码变更 Diff",
      changedFiles: Array.isArray(codeBrief?.changedFiles) ? codeBrief.changedFiles : []
    });
  }
  const seen = new Set<string>();
  return assets.filter((asset) => {
    const key = typeof asset.assetId === "string" ? asset.assetId : JSON.stringify(asset);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeRuntimeList(value: unknown) {
  return Array.isArray(value) ? value : [];
}

function buildAgentOutputBlocks(output: RuntimeAgentResult): MessageBlock[] {
  const blocks: MessageBlock[] = [createMarkdownBlock(`block-${nanoid(8)}`, output.publicMessage)];
  for (const asset of output.createdAssets ?? []) {
    if (isInlineImageAsset(asset)) {
      blocks.push({
        blockId: `block-${nanoid(8)}`,
        schemaVersion: 1,
        type: "image",
        payload: {
          assetId: asset.assetId,
          alt: asset.summary || asset.name,
          thumbnailUrl: assetContentPath(asset.workspaceId, asset.assetId),
          previewUrl: assetContentPath(asset.workspaceId, asset.assetId)
        }
      });
      continue;
    }
    blocks.push({
      blockId: `block-${nanoid(8)}`,
      schemaVersion: 1,
      type: "file",
      payload: {
        assetId: asset.assetId,
        name: asset.name,
        path: asset.path,
        mimeType: asset.mimeType,
        ...(asset.size !== undefined ? { size: asset.size } : {}),
        ...(asset.summary ? { summary: asset.summary } : {})
      }
    });
  }
  return blocks;
}

function isInlineImageAsset(asset: NonNullable<RuntimeAgentResult["createdAssets"]>[number]) {
  return ["image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif"].includes(asset.mimeType.toLowerCase());
}

function assetContentPath(workspaceId: string, assetId: string) {
  return `/api/workspaces/${encodeURIComponent(workspaceId)}/assets/${encodeURIComponent(assetId)}/content`;
}

function buildCodeTaskLiveBlocks(input: {
  codeTaskRunId: string;
  title: string;
  status: Extract<MessageBlock, { type: "agent_status" }>["payload"]["status"];
  progress?: number | undefined;
  text: string;
}): MessageBlock[] {
  return [
    createMarkdownBlock(`block-${nanoid(8)}`, input.text),
    {
      blockId: `block-${nanoid(8)}`,
      schemaVersion: 1,
      type: "agent_status",
      payload: {
        subtype: "code_task",
        targetId: input.codeTaskRunId,
        title: input.title,
        status: input.status,
        summary: input.text,
        ...(typeof input.progress === "number" ? { progress: input.progress } : {})
      }
    }
  ];
}

function buildCodeTaskFinalBlocks(input: {
  publicMessage: string;
  codeTaskRunId: string;
  status: "completed" | "failed" | "waiting_review";
  summary: string;
  diffAssetId?: string | undefined;
  changedFiles: Array<{ path: string; additions: number; deletions: number }>;
  diffText: string;
}): MessageBlock[] {
  const blocks = buildCodeTaskLiveBlocks({
    codeTaskRunId: input.codeTaskRunId,
    title: input.status === "waiting_review" ? "Code Agent 等待审阅" : input.status === "completed" ? "Code Agent 执行完成" : "Code Agent 执行失败",
    status: input.status,
    progress: 1,
    text: input.publicMessage
  });
  if (input.diffAssetId && input.changedFiles.length > 0) {
    blocks.push({
      blockId: `block-${nanoid(8)}`,
      schemaVersion: 1,
      type: "diff",
      payload: {
        diffAssetId: input.diffAssetId,
        reviewProposalId: input.codeTaskRunId,
        reviewKind: "code_task",
        title: "Code Agent 变更 Diff",
        files: buildDiffBlockFiles(input.changedFiles, input.diffText),
        reviewState: "pending"
      }
    });
  }
  return blocks;
}

function acknowledgementReplyFor(messageId: string, agentId: string) {
  const seed = `${messageId}:${agentId}`;
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) >>> 0;
  }
  return AGENT_ACKNOWLEDGEMENT_REPLIES[hash % AGENT_ACKNOWLEDGEMENT_REPLIES.length] ?? AGENT_ACKNOWLEDGEMENT_REPLIES[0];
}

function codeAgentEventText(event: CodeAgentEvent) {
  if (event.type === "message_delta" || event.type === "message") return event.text || "Code Agent 正在生成回复...";
  if (event.type === "command_run") return `执行命令：${event.command}`;
  if (event.type === "file_edit") return `修改文件：${event.path}`;
  if (event.type === "status") return event.message || `Code Agent 状态：${event.status}`;
  if (event.type === "session_started") return "正在思考中...";
  return event.message;
}

function createCodeAgentLiveUpdater(input: {
  flushMs: number;
  flush: (state: {
    text: string;
    blockStatus: Extract<MessageBlock, { type: "agent_status" }>["payload"]["status"];
    messageStatus: ChatMessage["status"];
    progress?: number | undefined;
  }) => Promise<void>;
}) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending = Promise.resolve();
  let dirty = false;
  let transcript = "";
  let text = "正在思考中...";
  let blockStatus: Extract<MessageBlock, { type: "agent_status" }>["payload"]["status"] = "running";
  let messageStatus: ChatMessage["status"] = "processing";
  let progress: number | undefined;

  const renderState = () => ({
    text: (transcript || text).trim() || "正在思考中...",
    blockStatus,
    messageStatus,
    ...(typeof progress === "number" ? { progress } : {})
  });
  const flushNow = async () => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (!dirty) {
      await pending;
      return;
    }
    const state = renderState();
    dirty = false;
    pending = pending.then(() => input.flush(state));
    await pending;
  };
  const schedule = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      void flushNow();
    }, input.flushMs);
  };
  const apply = (event: CodeAgentEvent) => {
    dirty = true;
    if (event.type === "message_delta") {
      transcript += event.text;
    } else if (event.type === "message") {
      transcript = event.text;
    } else {
      text = codeAgentEventText(event);
    }
    if (event.type === "status") {
      blockStatus = codeAgentBlockStatus(event.status);
      progress = event.progress;
    } else if (event.type === "error") {
      blockStatus = "failed";
      messageStatus = "failed";
      progress = 1;
    }
  };
  return {
    async push(event: CodeAgentEvent) {
      apply(event);
      if (event.type === "error" || isTerminalCodeAgentStatus(event)) {
        await flushNow();
        return;
      }
      schedule();
    },
    flush: flushNow
  };
}

function isTerminalCodeAgentStatus(event: CodeAgentEvent) {
  return event.type === "status" && ["completed", "failed", "cancelled", "timed_out"].includes(event.status);
}

function codeAgentBlockStatus(status: Extract<CodeAgentEvent, { type: "status" }>["status"]): Extract<MessageBlock, { type: "agent_status" }>["payload"]["status"] {
  if (status === "completed") return "completed";
  if (status === "cancelled") return "cancelled";
  if (status === "failed" || status === "timed_out") return "failed";
  return "running";
}

function buildDiffBlockFiles(changedFiles: Array<{ path: string; additions: number; deletions: number }>, diffText: string) {
  const hunksByPath = parseUnifiedDiffHunks(diffText);
  return changedFiles.map((file) => ({
    path: file.path,
    additions: file.additions,
    deletions: file.deletions,
    expanded: false,
    hunks: hunksByPath.get(file.path) ?? []
  }));
}

function parseUnifiedDiffHunks(diffText: string) {
  const result = new Map<string, Array<{ header: string; lines: Array<{ kind: "context" | "add" | "delete"; oldLine?: number; newLine?: number; content: string }> }>>();
  let currentPath = "";
  let currentHunk: { header: string; lines: Array<{ kind: "context" | "add" | "delete"; oldLine?: number; newLine?: number; content: string }> } | undefined;
  let oldLine = 0;
  let newLine = 0;
  for (const line of diffText.split(/\r?\n/)) {
    const fileMatch = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (fileMatch) {
      currentPath = fileMatch[2] ?? fileMatch[1] ?? "";
      currentHunk = undefined;
      if (currentPath && !result.has(currentPath)) result.set(currentPath, []);
      continue;
    }
    const plusFile = /^\+\+\+ b\/(.+)$/.exec(line);
    if (plusFile) {
      currentPath = plusFile[1] ?? currentPath;
      if (currentPath && !result.has(currentPath)) result.set(currentPath, []);
      continue;
    }
    const hunkMatch = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
    if (hunkMatch && currentPath) {
      oldLine = Number(hunkMatch[1]);
      newLine = Number(hunkMatch[2]);
      currentHunk = { header: line, lines: [] };
      result.get(currentPath)?.push(currentHunk);
      continue;
    }
    if (!currentHunk) continue;
    if (line.startsWith("+") && !line.startsWith("+++")) {
      currentHunk.lines.push({ kind: "add", newLine, content: line.slice(1) });
      newLine += 1;
      continue;
    }
    if (line.startsWith("-") && !line.startsWith("---")) {
      currentHunk.lines.push({ kind: "delete", oldLine, content: line.slice(1) });
      oldLine += 1;
      continue;
    }
    currentHunk.lines.push({ kind: "context", oldLine, newLine, content: line.startsWith(" ") ? line.slice(1) : line });
    oldLine += 1;
    newLine += 1;
  }
  return result;
}

function summarizeMessage(message: Message) {
  const blocks = message.blocks as unknown as MessageBlock[];
  const summary = summarizeBlocks(blocks).replace(/\s+/g, " ").trim();
  return summary.length > 120 ? `${summary.slice(0, 120)}...` : summary;
}

function formatCodeAgentResult(agentName: string, result: CodeAgentTaskResult) {
  const ok = result.exitCode === 0;
  const reply = extractVisibleCodeAgentReply(result);
  if (ok && reply) return reply;
  if (ok) return `${agentName} 没有返回可展示的回复。`;
  return formatCodeAgentFailure(agentName, result);
}

function codeAgentTaskResultFromProtocol(result: CodeAgentRunResult, requestedProvider: "codex" | "opencode", workspaceRoot: string): CodeAgentTaskResult {
  return {
    provider: result.provider,
    ...(result.provider !== requestedProvider ? { requestedProvider } : {}),
    command: `protocol:${result.provider}`,
    cwd: workspaceRoot,
    exitCode: result.exitCode,
    stdout: result.finalMessage,
    stderr: result.exitCode === 0 ? "" : result.finalMessage,
    ...(result.sessionId ? { sessionId: result.sessionId } : {}),
    finalMessage: result.finalMessage,
    changedFiles: result.changedFiles,
    ...(result.diffText ? { diffText: result.diffText } : {}),
    timedOut: Boolean(result.timedOut),
    cancelled: Boolean(result.cancelled)
  };
}

function formatCodeAgentFailure(agentName: string, result: CodeAgentTaskResult) {
  const error = result.stderr.trim() || result.stdout.trim();
  if (!error) return `${agentName} 执行失败。`;
  return [`${agentName} 执行失败。`, "", "```text", limitChatOutput(error), "```"].join("\n");
}

function buildCodeExecutionBrief(
  agent: RuntimeAgentIdentity,
  result: CodeAgentTaskResult,
  ids: { codeTaskRunId?: string; logAssetId?: string; diffAssetId?: string; sessionId?: string; startedAt: string; completedAt: string }
) {
  const ok = result.exitCode === 0;
  const visibleReply = extractVisibleCodeAgentReply(result);
  const summarySource = ok ? visibleReply : result.stderr || result.stdout;
  return {
    kind: "code_execution_brief",
    agentId: agent.id,
    agentName: agent.name,
    provider: result.provider,
    ...(result.requestedProvider ? { requestedProvider: result.requestedProvider } : {}),
    status: ok ? "completed" : "failed",
    summary: summarizeCodeExecution(summarySource, result),
    exitCode: result.exitCode,
    timedOut: Boolean(result.timedOut),
    cancelled: Boolean(result.cancelled),
    ...(ids.codeTaskRunId ? { codeTaskRunId: ids.codeTaskRunId } : {}),
    ...(ids.logAssetId ? { logAssetId: ids.logAssetId } : {}),
    ...(ids.diffAssetId ? { diffAssetId: ids.diffAssetId } : {}),
    ...(ids.sessionId ? { sessionId: ids.sessionId } : {}),
    changedFiles: result.changedFiles ?? [],
    startedAt: ids.startedAt,
    completedAt: ids.completedAt
  };
}

function requestedCodeProviderForAgent(agent: RuntimeAgentIdentity): CodeAgentTaskResult["provider"] {
  if (agent.id === "agent-opencode" || agent.provider === "opencode") return "opencode";
  return "codex";
}

function codeProviderFromOutput(output: RuntimeAgentResult, fallback: CodeAgentTaskResult["provider"]): CodeAgentTaskResult["provider"] {
  const patch = asRecord(output.memoryPatch);
  const brief = asRecord(patch?.codeExecutionBrief);
  return optionalCodeProvider(brief?.provider) ?? fallback;
}

function optionalCodeProvider(value: unknown): CodeAgentTaskResult["provider"] | undefined {
  return value === "codex" || value === "opencode" ? value : undefined;
}

function codeTaskRunStatusForResult(result: CodeAgentTaskResult) {
  if (result.cancelled) return "cancelled";
  if (result.timedOut) return "timed_out";
  return result.exitCode === 0 ? "completed" : "failed";
}

function codeTaskRunStatusMessage(result: CodeAgentTaskResult) {
  if (result.cancelled) return "Code Agent execution cancelled";
  if (result.timedOut) return "Code Agent execution timed out";
  if (result.exitCode === 0) return "Code Agent execution completed";
  return `Code Agent execution failed with exit code ${result.exitCode ?? "unknown"}`;
}

function summarizeCodeExecution(output: string, result: CodeAgentTaskResult) {
  const text = output.replace(/\s+/g, " ").trim();
  if (text) return text.length > 240 ? `${text.slice(0, 240)}...` : text;
  if (result.timedOut) return "Code Agent 执行超时。";
  if (result.cancelled) return "Code Agent 执行已取消。";
  return result.exitCode === 0 ? "Code Agent 执行完成，无可见文本输出。" : "Code Agent 执行失败，无可见错误输出。";
}

function extractVisibleCodeAgentReply(result: CodeAgentTaskResult) {
  if (result.finalMessage) return result.finalMessage.trim();
  if (result.provider === "opencode") return extractOpenCodeJsonText(result.stdout);
  return result.stdout.trim();
}

function extractOpenCodeJsonText(stdout: string) {
  const textParts: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    const event = safeJsonParse(trimmed);
    if (!event || event.type !== "text") continue;
    const part = asRecord(event.part);
    const text = typeof part?.text === "string" ? part.text : "";
    if (text) textParts.push(text);
  }
  return textParts.join("").trim();
}

function asToolRequests(value: unknown): RuntimeToolRequest[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is RuntimeToolRequest => Boolean(asRecord(item)?.toolId));
}

function normalizeDecomposedAssignments(assignments: Array<z.infer<typeof assignmentSchema>>) {
  const omittedCoordinatorAssignments: Array<z.infer<typeof assignmentSchema>> = [];
  const omittedReviewAssignments: Array<z.infer<typeof assignmentSchema>> = [];
  const workItems: Assignment[] = [];
  const originalDependsOnByWorkItemId = new Map<string, string[]>();
  assignments.forEach((item, index) => {
    if (isOrchestratorAgentId(item.agentId)) {
      omittedCoordinatorAssignments.push(item);
      return;
    }
    if (isReviewAgentId(item.agentId)) {
      omittedReviewAssignments.push(item);
      return;
    }
    const workItemId = item.workItemId?.trim() || `item-${String(index + 1).padStart(2, "0")}`;
    const { level: _level, ...assignment } = item;
    originalDependsOnByWorkItemId.set(workItemId, item.dependsOn);
    workItems.push({
      ...assignment,
      agentId: normalizeAssignableAgentId(item.agentId),
      schedulingLevel: normalizeSchedulingLevel(item.schedulingLevel ?? item.level),
      dependsOn: [],
      workItemId,
      status: "pending"
    });
  });

  for (const item of workItems) {
    item.dependsOn = uniqueStrings(item.dependsOn.concat(
      normalizeDependsOn(workItems, originalDependsOnByWorkItemId.get(item.workItemId) ?? [])
    )).filter((dep) => dep !== item.workItemId);
  }

  return { workItems, omittedCoordinatorAssignments, omittedReviewAssignments };
}

function normalizeSchedulingLevel(level: number | undefined) {
  if (level && Number.isFinite(level) && level > 0) return Math.trunc(level);
  return 1;
}

function assignmentSchedulingLevel(assignment: Assignment) {
  return normalizeSchedulingLevel(assignment.schedulingLevel);
}

function lowestUnvalidatedSchedulingLevel(workItems: Assignment[]) {
  const levels = workItems
    .filter((item) => item.status !== "validated")
    .map(assignmentSchedulingLevel);
  return levels.length > 0 ? Math.min(...levels) : undefined;
}

function completedAssignmentsAwaitingValidation(workItems: Assignment[]) {
  return workItems.filter((item) =>
    (item.status === "completed" || (item.status === "failed" && Boolean(item.outputMessageId))) && !item.validation
  );
}

function readDirectValidationCandidate(run: RuntimeWorkingMemory) {
  const candidate = asRecord(run.runMeta?.directValidationCandidate);
  const publicMessage = stringishOrUndefined(candidate?.publicMessage);
  return publicMessage ? { ...candidate, publicMessage } : undefined;
}

function isDirectValidationOnlyRun(run: RuntimeWorkingMemory) {
  return (run.workItems ?? []).length === 0
    && (run.agentRuns ?? []).length === 0
    && (run.toolRuns ?? []).length === 0
    && (run.outputs ?? []).some((output) => Boolean(asRecord(output)?.direct));
}

function normalizeDependsOn(workItems: Assignment[], dependsOn: string[]) {
  return dependsOn.flatMap((dep) => {
    if (isOrchestratorAgentId(dep) || isReviewAgentId(dep)) return [];
    const normalized = normalizeAssignableAgentId(dep);
    const byWorkItem = workItems.find((item) => item.workItemId === normalized);
    if (byWorkItem) return [byWorkItem.workItemId];
    const byAgent = workItems.find((item) => item.agentId === normalized);
    return byAgent ? [byAgent.workItemId] : [];
  });
}

function latestAssignmentResultRef(run: RuntimeWorkingMemory, assignment: Assignment) {
  const refs = [...(run.agentRuns ?? [])].reverse();
  if (assignment.outputMessageId) {
    const byOutput = refs.find((item) => item.workItemId === assignment.workItemId && item.outputMessageId === assignment.outputMessageId);
    if (byOutput) return byOutput;
    return {
      workItemId: assignment.workItemId,
      agentId: assignment.agentId,
      status: assignment.status,
      outputMessageId: assignment.outputMessageId
    };
  }
  return refs.find((item) => item.workItemId === assignment.workItemId);
}

function assignmentFromResumeTask(value: unknown): Assignment {
  const parsed = assignmentSchema.safeParse(value);
  const record = asRecord(value);
  const workItemId = stringishOrUndefined(record?.workItemId) ?? `work-item-${nanoid(8)}`;
  if (!parsed.success) {
    return {
      workItemId,
      agentId: stringishOrUndefined(record?.agentId) ?? "agent-universal",
      task: stringishOrUndefined(record?.task) ?? "恢复已审批的 Agent 工具调用结果",
      expectedOutput: stringishOrUndefined(record?.expectedOutput) ?? "Agent 最终执行结果",
      dependsOn: [],
      status: stringishOrUndefined(record?.status) ?? "completed"
    };
  }
  return {
    ...parsed.data,
    workItemId,
    status: stringishOrUndefined(record?.status) ?? "completed"
  };
}

function isWaitingForAgentToolApprovalResult(result: RuntimeAgentResult) {
  return result.status === "needs_clarification" && Boolean(asRecord(result.memoryPatch)?.waitingToolApproval);
}

function prepareRunForResume(run: RuntimeWorkingMemory, options: { resetRunningWithoutOutput?: boolean } = {}): RuntimeWorkingMemory {
  const resumedAt = new Date().toISOString();
  const resumeCount = typeof run.runMeta?.resumeCount === "number" ? run.runMeta.resumeCount + 1 : 1;
  const resetRunningWithoutOutput = options.resetRunningWithoutOutput === true;
  return {
    ...run,
    status: "running",
    runMeta: { ...(run.runMeta ?? {}), resumedAt, resumeCount },
    workItems: (run.workItems ?? []).map((item) => {
      if (item.status !== "running") return item;
      if (!resetRunningWithoutOutput) return item;
      const hasResult = Boolean(item.outputMessageId);
      return hasResult ? { ...item, status: "completed" } : { ...item, status: "pending", validation: undefined };
    })
  };
}

function prepareWaitingUserContinuation(run: RuntimeWorkingMemory, message: ChatMessage, mergedGoal?: string): { run: RuntimeWorkingMemory; returnNode: OrchestratorNode } {
  const returnNode = resolveWaitingUserReturnNode(run);
  const text = extractMessageText(message);
  const continuedAt = new Date().toISOString();
  const continuation = {
    messageId: message.id,
    text,
    at: continuedAt,
    fromNode: run.currentNode,
    returnNode,
    originalTriggerMessageId: run.triggerMessageId
  };
  const next: RuntimeWorkingMemory = {
    ...run,
    status: "running",
    goal: mergedGoal ? mergeGoalText(run.goal, mergedGoal) : run.goal,
    runMeta: {
      ...(run.runMeta ?? {}),
      latestContinuationMessageId: message.id,
      continuations: [...asArray(run.runMeta?.continuations), continuation]
    },
    uiInteractions: [
      ...(run.uiInteractions ?? []),
      { at: continuedAt, type: "user_reply", messageId: message.id, text, returnNode }
    ]
  };
  if (returnNode === "validate") {
    next.workItems = (run.workItems ?? []).map((item) => {
      const validation = asRecord(item.validation);
      return validation?.nextStep === "ask_user" ? { ...item, validation: undefined } : item;
    });
  }
  return { run: next, returnNode };
}

function resolveWaitingUserReturnNode(run: RuntimeWorkingMemory): OrchestratorNode {
  const edge = [...(run.edgeHistory ?? [])].reverse().find((item) => item.target === "ui_query");
  const source = typeof edge?.source === "string" ? edge.source : undefined;
  return source && isOrchestratorNode(source) && source !== "ui_query" ? source : "understand";
}

function isOrchestratorNode(value: string): value is OrchestratorNode {
  return ORCHESTRATOR_NODE_IDS.has(value as OrchestratorNode);
}

function normalizeAssignableAgentId(agentId: string) {
  if (isDeployMention(agentId)) return "agent-codex";
  return isOrchestratorAgentId(agentId) ? "agent-universal" : agentId;
}

function normalizeCodeAgentId(agentId: string) {
  const normalized = agentId.trim().toLowerCase();
  if (normalized === "codex" || normalized === "agent-codex") return "agent-codex";
  if (normalized === "opencode" || normalized === "agent-opencode") return "agent-opencode";
  return undefined;
}

function isCodeAgentRequest(agentId: string) {
  const normalized = agentId.trim().toLowerCase();
  return normalized === "code" || normalized === "agent-code" || Boolean(normalizeCodeAgentId(normalized));
}

function isDeployMention(value: string) {
  return DEPLOY_MENTIONS.has(normalizeMention(value));
}

function isAssignmentDeploymentIntent(assignment: Assignment) {
  return isCodeAgentDeploymentIntent([
    assignment.agentId,
    assignment.task,
    assignment.expectedOutput,
    assignment.acceptanceCriteria ?? ""
  ].join("\n"));
}

function isConcreteCodeImplementationAssignment(assignment: Assignment) {
  const text = [
    assignment.task,
    assignment.expectedOutput,
    assignment.acceptanceCriteria ?? ""
  ].join("\n").toLowerCase();
  const planningSignals = [
    "技术调研",
    "调研",
    "技术选型",
    "选择最优",
    "确定方案",
    "搜索方案",
    "竞品",
    "需求分析",
    "产品设计",
    "ui 设计",
    "视觉设计",
    "规范",
    "总结",
    "文档方案"
  ];
  const codeSignals = [
    "code/",
    "代码",
    "编码",
    "实现",
    "修改",
    "修复",
    "创建文件",
    "编辑文件",
    "初始化项目",
    "脚手架",
    "配置本地开发环境",
    "dev server",
    "构建",
    "运行测试",
    "单元测试",
    "部署",
    "发布",
    "上线",
    "静态预览",
    "预览部署",
    "生成预览",
    "deploy",
    "deployment",
    "publish",
    "debug",
    "bug",
    "组件",
    "api",
    "接口",
    "数据库",
    "docker",
    "package",
    "typescript",
    "javascript",
    "react",
    "nest",
    "prisma",
    "sql",
    "html",
    "css"
  ];
  const hasPlanningSignal = planningSignals.some((signal) => text.includes(signal));
  const hasCodeSignal = codeSignals.some((signal) => text.includes(signal));
  if (!hasCodeSignal) return false;
  if (!hasPlanningSignal) return true;
  return /code\/|实现|修改|修复|创建文件|编辑文件|运行测试|部署|发布|上线|预览部署|静态预览|生成预览|deploy|publish|debug|bug/i.test(text);
}

function isOrchestratorAgentId(agentId: string) {
  const normalized = agentId.trim().toLowerCase();
  return normalized === "orchestrator" || normalized === "agent-orchestrator";
}

function isReviewAgentId(agentId: string) {
  const normalized = agentId.trim().toLowerCase();
  return normalized === "review" || normalized === "agent-review";
}

function isWaitingRunStatus(status: RuntimeWorkingMemory["status"]) {
  return status === "waiting_user" || status === "waiting_agent" || status === "waiting_tool";
}

function isBusyRunStatus(status: RuntimeWorkingMemory["status"]) {
  return status === "running" || status === "waiting_agent" || status === "waiting_tool";
}

function isTerminalRunStatus(status: RuntimeWorkingMemory["status"]) {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function normalizeMention(mention: string) {
  return mention.trim().replace(/^@/, "").toLowerCase();
}

function normalizeMentionLookup(mention: string) {
  return normalizeMention(mention).replace(/\s+/g, "");
}

function resolveAgentIdentityByMentionLookup(agents: RuntimeAgentIdentity[], mention: string) {
  const lookup = normalizeMentionLookup(mention);
  if (!lookup) return undefined;
  const exactMatches: RuntimeAgentIdentity[] = [];
  const prefixMatches: RuntimeAgentIdentity[] = [];
  for (const agent of agents) {
    const keys = uniqueStrings([
      normalizeMentionLookup(agent.id),
      normalizeMentionLookup(agent.id.replace(/^agent-/, "")),
      normalizeMentionLookup(agent.name)
    ]);
    if (keys.includes(lookup)) {
      exactMatches.push(agent);
      continue;
    }
    if (keys.some((key) => key.startsWith(lookup) || lookup.startsWith(key))) prefixMatches.push(agent);
  }
  const exact = uniqueAgentsById(exactMatches);
  if (exact.length === 1) return exact[0];
  const prefix = uniqueAgentsById(prefixMatches);
  if (prefix.length === 1) return prefix[0];
  return undefined;
}

function uniqueTargetsByAgentId(targets: Array<{ mention: string; agent: RuntimeAgentIdentity }>) {
  const seen = new Set<string>();
  const unique: Array<{ mention: string; agent: RuntimeAgentIdentity }> = [];
  for (const target of targets) {
    if (seen.has(target.agent.id)) continue;
    seen.add(target.agent.id);
    unique.push(target);
  }
  return unique;
}

function uniqueAgentsById(agents: RuntimeAgentIdentity[]) {
  const seen = new Set<string>();
  const unique: RuntimeAgentIdentity[] = [];
  for (const agent of agents) {
    if (seen.has(agent.id)) continue;
    seen.add(agent.id);
    unique.push(agent);
  }
  return unique;
}

function buildOrchestratorTriggerContext(message: ChatMessage, route: RuntimeRouteDecision) {
  return {
    triggerMessageId: message.id,
    triggerUserId: message.sender.id,
    triggerText: extractMessageText(message),
    triggerReason: route.triggerReason,
    routeMode: route.mode,
    explicitMentionedAgents: route.explicitMentionedAgents,
    ignoredMentions: route.ignoredMentions,
    routingWarnings: route.warnings
  };
}

function isMessageDeferredForRun(run: RuntimeWorkingMemory, messageId: string) {
  return stringArrayish(run.runMeta?.deferredMessageIds).includes(messageId);
}

function describeNodeState(run: RuntimeWorkingMemory): NodeState {
  const workItems = run.workItems ?? [];
  return {
    pendingCount: workItems.filter((item) => item.status === "pending").length,
    runningCount: workItems.filter((item) => item.status === "running").length,
    completedCount: workItems.filter((item) => item.status === "completed" || item.status === "validated").length,
    awaitingValidationCount: completedAssignmentsAwaitingValidation(workItems).length
  };
}

export function resolveSteerStrategy(node: OrchestratorNode, state: NodeState, modifier: "additive" | "corrective"): SteerAction {
  if (node === "integrate" || node === "summary" || node === "memory_manage") return "DEGRADE_TO_NEW";
  if (node === "understand" || node === "tools" || node === "wake" || node === "ui_query") return "MERGE_CONTINUE";
  if (node === "decompose") return "REDECOMPOSE";
  if (node === "assignment") return modifier === "additive" ? "ADD_WORK_ITEM" : "REDECOMPOSE";
  if (node === "validate") {
    if (state.pendingCount > 0) return modifier === "additive" ? "ADD_WORK_ITEM" : "REDECOMPOSE";
    return modifier === "additive" ? "FOLD_VALIDATION" : "REDECOMPOSE";
  }
  return "MERGE_CONTINUE";
}

function joinedMentionText(mentions: InFlightMention[]) {
  return mentions.map((item) => item.text).filter(Boolean).join("\n").trim();
}

function maxMentionSeq(mentions: InFlightMention[]) {
  return mentions.reduce((max, item) => Math.max(max, item.seq), 0);
}

function appendRunMetaMessages(run: RuntimeWorkingMemory, mentions: InFlightMention[], patch: Record<string, unknown>): RuntimeWorkingMemory {
  return {
    ...run,
    runMeta: {
      ...(run.runMeta ?? {}),
      latestInFlightMessageId: mentions[mentions.length - 1]?.id,
      ...patch
    }
  };
}

function appendContinuations(run: RuntimeWorkingMemory, mentions: InFlightMention[], options: { disposition: Record<string, unknown>; lastConsumedSeq: number }): RuntimeWorkingMemory {
  const continuedAt = new Date().toISOString();
  const continuations = mentions.map((mention) => ({
    messageId: mention.id,
    text: mention.text,
    seq: mention.seq,
    at: continuedAt,
    fromNode: run.currentNode,
    originalTriggerMessageId: run.triggerMessageId,
    disposition: options.disposition
  }));
  return {
    ...run,
    runMeta: {
      ...(run.runMeta ?? {}),
      latestContinuationMessageId: mentions[mentions.length - 1]?.id,
      lastConsumedSeq: options.lastConsumedSeq,
      continuations: [...asArray(run.runMeta?.continuations), ...continuations]
    }
  };
}

function createSteeredWorkItem(run: RuntimeWorkingMemory, task: string): Assignment {
  const level = lowestUnvalidatedSchedulingLevel(run.workItems ?? []) ?? 1;
  return {
    workItemId: `item-steer-${nanoid(6)}`,
    agentId: "agent-universal",
    task: task || "处理运行中追加的补充需求",
    expectedOutput: "可供 Orchestrator 校验的补充结果",
    schedulingLevel: level,
    dependsOn: [],
    status: "pending"
  };
}

function mergePreservedWorkItems(preserved: Assignment[], incoming: Assignment[]) {
  const used = new Set<string>();
  const result: Assignment[] = [];
  for (const item of preserved) {
    if (!item.workItemId || used.has(item.workItemId)) continue;
    used.add(item.workItemId);
    result.push(item);
  }
  for (const item of incoming) {
    if (used.has(item.workItemId)) continue;
    used.add(item.workItemId);
    result.push(item);
  }
  return result;
}

function mergeGoalText(goal: string, addition: string) {
  const trimmed = addition.trim();
  if (!trimmed || goal.includes(trimmed)) return goal;
  return `${goal}\n补充：${trimmed}`;
}

function formatDispositionAck(disposition: InFlightDisposition, extraLine?: string) {
  const prefix = disposition.scope === "new"
    ? "已识别为新任务，已排队等待当前 Run 结束后处理。"
    : disposition.action === "cancel"
      ? "已识别为本轮取消请求，本轮将在当前安全边界停止。"
      : disposition.action === "restart"
        ? "已识别为本轮方向推翻，会结束当前编排并带交接重开一轮。"
        : disposition.modifier === "corrective"
          ? "已识别为本轮纠正，会在安全边界重新规划未开始部分。"
          : "已识别为本轮补充，已纳入当前 Run。";
  return [prefix, `原因：${disposition.reason}`, extraLine].filter(Boolean).join("\n");
}

function sameStringSet(left: string[], right: string[]) {
  if (left.length !== right.length) return false;
  const set = new Set(left);
  return right.every((item) => set.has(item));
}

function waitingUserQuestion(run: RuntimeWorkingMemory) {
  const waiting = asRecord(run.waitingOn);
  const reason = stringishOrUndefined(waiting?.reason);
  if (reason) return reason;
  const edge = [...(run.edgeHistory ?? [])].reverse().find((item) => item.target === "ui_query");
  const payload = asRecord(edge?.payload);
  return stringishOrUndefined(payload?.question) ?? "当前 Run 的待确认问题";
}

function inFlightDispositionPrompt() {
  return [
    "你负责判断用户在一个正在推进的复杂软件项目任务中追加的 @orchestrator 消息应该如何处理。",
    "你会看到当前 Run 的目标、当前节点、工作项、之前的调度和执行记录，以及用户新追加的一条或多条消息。",
    "只判断归属和动作，不要直接执行任务。",
    "判断规则：",
    "1. 如果新消息明显是在补充或修正当前 Run，scope=current。",
    "2. 如果新消息是无关的新需求，scope=new。",
    "3. scope=current 时，如果只是补充要求，action=continue, modifier=additive。",
    "4. scope=current 时，如果是纠正当前要求但已完成产物不需要整体作废，action=continue, modifier=corrective。",
    "5. 只有当用户明确要求停掉本轮时，action=cancel。",
    "6. 只有当用户明确表示当前方向作废、已完成内容也要重做时，action=restart。",
    "7. 拿不准时选择 scope=current, action=continue, modifier=additive。",
    "输出 JSON，字段为 scope、action、modifier、reason、mergedGoal。"
  ].join("\n");
}

function agentDepToWorkItem(workItems: Assignment[], dep: string) {
  return workItems.find((item) => item.agentId === dep)?.workItemId ?? dep;
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

function uniqueNumbers(values: number[]) {
  return [...new Set(values.filter((value) => Number.isFinite(value)))];
}

function displayMentionForAgent(agentId: string) {
  switch (agentId) {
    case "agent-product":
      return "@Product";
    case "agent-ui":
      return "@UI";
    case "agent-codex":
      return "@Codex";
    case "agent-opencode":
      return "@OpenCode";
    case "agent-universal":
      return "@Universal";
    default:
      return `@${agentId.replace(/^agent-/, "")}`;
  }
}

function mentionKeyForAgent(agentId: string) {
  switch (agentId) {
    case "agent-product":
      return "product";
    case "agent-ui":
      return "ui";
    case "agent-codex":
      return "codex";
    case "agent-opencode":
      return "opencode";
    case "agent-universal":
      return "universal";
    default:
      return agentId.replace(/^agent-/, "");
  }
}

function compactAssignmentTask(task: string) {
  const normalized = task.replace(/\s+/g, " ").trim();
  return normalized.length > 72 ? `${normalized.slice(0, 72)}...` : normalized;
}

function asArray(value: unknown) {
  return Array.isArray(value) ? value : [];
}

function edgeChain(source: string, target: string) {
  if ((source === "decompose" && target === "assignment") || (source === "assignment" && target === "validate") || (source === "validate" && target === "decompose")) {
    return "assignment-validation";
  }
  return undefined;
}

function safeJsonParse(value: string) {
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function optionalString(value: unknown) {
  return typeof value === "string" ? value : "";
}

function recordOrEmpty(value: unknown) {
  return asRecord(value) ?? {};
}

function stringishOrUndefined(value: unknown) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

function stringArrayish(value: unknown) {
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      const text = stringishOrUndefined(item);
      return text ? [text] : [];
    });
  }
  const text = stringishOrUndefined(value);
  if (!text) return [];
  return text
    .split(/[\n,，;；]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function booleanishOrUndefined(value: unknown) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return undefined;
  if (["false", "0", "no", "n", "off", "否", "不", "不要", "无", "none", "skip", "failed", "fail", "reject", "rejected", "不通过", "未通过"].includes(normalized)) return false;
  if (["true", "1", "yes", "y", "on", "是", "要", "有", "ok", "okay", "pass", "passed", "approve", "approved", "通过"].includes(normalized)) return true;
  return undefined;
}

function normalizeNodeStatusInput(value: unknown) {
  const normalized = stringishOrUndefined(value)?.toLowerCase();
  if (!normalized) return undefined;
  if (["completed", "complete", "done", "success", "ok", "通过", "完成"].includes(normalized)) return "completed";
  if (["needs_user", "need_user", "ask_user", "clarify", "clarification", "追问", "需要用户"].includes(normalized)) return "needs_user";
  if (["needs_tool", "need_tool", "tool", "tools", "需要工具"].includes(normalized)) return "needs_tool";
  if (["failed", "fail", "error", "失败"].includes(normalized)) return "failed";
  return undefined;
}

function normalizeValidateNextStepInput(value: unknown) {
  const normalized = stringishOrUndefined(value)?.trim().toLowerCase();
  if (!normalized) return undefined;
  if ((validateNextStepValues as readonly string[]).includes(normalized)) return normalized;
  if (["integrate", "summary", "summarize", "final", "finish", "done", "汇总", "整合", "总结", "完成"].some((keyword) => normalized.includes(keyword))) return "integrate";
  if (["retry_decompose", "replan", "redecompose", "重新拆解", "重新规划", "重拆"].some((keyword) => normalized.includes(keyword))) return "retry_decompose";
  if (["retry_assignment", "retry", "redo", "revise", "rerun", "返工", "重做", "重新执行", "修改"].some((keyword) => normalized.includes(keyword))) return "retry_assignment";
  if (["ask_user", "clarify", "question", "user", "追问", "询问", "补充", "确认"].some((keyword) => normalized.includes(keyword))) return "ask_user";
  if (["continue", "next", "proceed", "pass", "passed", "approve", "approved", "ok", "通过", "继续", "下一步"].some((keyword) => normalized.includes(keyword))) return "continue";
  return undefined;
}

function normalizeToolRequestsInput(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const record = asRecord(item);
    const explicitToolId = stringishOrUndefined(record?.toolId ?? record?.id);
    const toolId = explicitToolId ?? stringishOrUndefined(record?.name);
    if (!toolId) return [];
    return [{
      toolId,
      reason: record?.reason,
      input: normalizeToolRequestInput(record, Boolean(explicitToolId))
    }];
  });
}

function normalizeToolRequestInput(record: Record<string, unknown> | null, hasExplicitToolId: boolean) {
  const nested = asRecord(record?.input) ?? asRecord(record?.args) ?? asRecord(record?.arguments) ?? asRecord(record?.parameters);
  if (nested) return nested;
  const input: Record<string, unknown> = {};
  for (const key of ["path", "filePath", "content", "summary", "query", "assetId", "mimeType", "knowledgeAssetId", "topK", "scoreThreshold", "url", "headers", "title", "nodes", "edges", "text"]) {
    if (record?.[key] !== undefined) input[key] = record[key];
  }
  if (hasExplicitToolId && record?.name !== undefined) input.name = record.name;
  return input;
}

function normalizeMessageActionsInput(value: unknown) {
  if (!Array.isArray(value)) return [];
  const actionTypes = new Set(["reply", "quote", "comment", "like", "pin"]);
  return value.flatMap((item) => {
    const record = asRecord(item);
    const type = stringishOrUndefined(record?.type)?.toLowerCase();
    if (!type || !actionTypes.has(type)) return [];
    return [{
      type,
      messageId: record?.messageId,
      payload: recordOrEmpty(record?.payload)
    }];
  });
}

function normalizeAssignmentListInput(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item, index) => {
    const record = asRecord(item);
    if (record) return [record];
    const task = stringishOrUndefined(item);
    return task ? [{ workItemId: `item-${String(index + 1).padStart(2, "0")}`, task }] : [];
  });
}

function normalizeParallelGroupsInput(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((group) => {
    const values = stringArrayish(group);
    return values.length > 0 ? [values] : [];
  });
}

function numberishOrUndefined(value: unknown) {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function stringListToText(value: unknown) {
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      .map((item) => item.trim())
      .join("；");
  }
  return value;
}

function isAssignmentAcknowledgement(metadata: unknown, runId: string, workItemId: string, agentId: string) {
  const record = asRecord(metadata);
  return record?.kind === "assignment_acknowledgement"
    && record.runId === runId
    && record.workItemId === workItemId
    && record.agentId === agentId;
}

function truncateForLog(value: string, maxLength = 8000) {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}\n...[truncated ${value.length - maxLength} chars]`;
}

function limitChatOutput(value: string, maxLength = 1200) {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}\n...[日志已截断，完整内容请查看后台监控]`;
}

function retryDelayMs(attempts: number) {
  return Math.min(30_000, 500 * 2 ** Math.max(0, attempts - 1));
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toRuntimeJobSummary(job: { id: string; status: string; targetType: string; targetId: string }) {
  return {
    id: job.id,
    status: job.status,
    targetType: job.targetType,
    targetId: job.targetId
  };
}

function isUniqueConstraintError(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

function understandPrompt() {
  return [
    "你是一名资深软件架构师，负责跟进一项长期复杂项目。",
    "你会收到用户本次 @ 主协调者的消息、长期记忆、Run 进度、之前调度记录、可用工具和可用 Agent。",
    "如果 nodeContext.runWorkingMemoryPack 或 runMeta.triggerContext 中包含 explicitMentionedAgents，说明用户在同一条消息中显式提到了多个候选 Agent；这些 Agent 是用户希望参与的候选成员，不是必须全部立即调用。",
    "遇到多 Agent @ 时，你要判断哪些候选 Agent 适合本轮、哪些应暂缓、是否需要先做需求/设计再进入代码实现，并把判断写入 candidateAgents 和 minimumScope。",
    "nodeContext.orchestratorMemoryPack 是主协调者对该用户的跨对话记忆；nodeContext.longTermMemoryPack 是当前项目会话记忆，二者要分开使用。",
    "你只负责理解本轮最小任务范围：判断信息是否足够、是否需要工具查询、是否需要追问用户、是否需要进入拆解。",
    "你必须先阅读之前调度记录，避免重复追问或重复查询。",
    "如果需要工具，只能请求 nodeContext.availableInterfaces.tools 中列出的工具 ID；不要臆造 ask_user、send_message 或命令类工具。",
    "如果用户只是查询、确认、状态判断或其他不需要子 Agent 协作的请求，可以 directAnswer 并 shouldDecompose=false；directAnswer 是待 validate 的回复草稿，系统会走 understand -> validate。",
    "directAnswer 和 clarificationQuestion 都是用户可见内容，语气要像真实团队负责人在群里交流：自然、简洁、有温度，但不要卖萌、不要过度拟人化、不要泄露内部字段。",
    "输出统一节点 JSON：status、result、runMemoryPatch、edgeSummary、uiMessages、messageActions、nextNode、error。",
    "result 字段包含 clearEnough、runGoal、minimumScope、clarificationQuestion、directAnswer、shouldDecompose、candidateAgents、toolRequests。"
  ].join("\n");
}

function decomposePrompt() {
  return [
    "你是一名软件项目负责人，负责把已经明确的本轮任务拆成最小可调度工作项。",
    "如果 nodeContext.orchestratorMemoryPack 记录了用户偏好的协作方式或持久约束，拆解时要遵守，但不要把跨对话记忆误当成当前项目已确认范围。",
    "本轮不要贪多，只推进 understand 给出的最小范围。",
    "可用 Agent 来自 nodeContext.availableInterfaces.agents。agent-code 表示当前项目选择的唯一 Code Agent。",
    "你只能把任务分配给 nodeContext.availableInterfaces.agents 中列出的 Agent；没有出现在列表里的 Agent 不属于本群聊，不能分配。",
    "Code Agent 只用于已经明确的代码落地：创建/修改 Code/ 文件、初始化脚手架、配置开发环境、运行构建测试、修复代码问题。",
    "部署、发布、上线、生成静态预览属于代码落地后的发布工作项；可以把这类工作分配给 agent-deploy 或当前项目 Code Agent，系统会实际使用当前项目唯一 Code Agent 执行，并在完成后调用后端 @deploy 部署服务生成状态卡片。",
    "技术调研、技术选型、搜索方案、需求分析、产品方案、UI 设计、文档整理等非代码实现任务，不要分配给 Code Agent；没有更合适 Agent 时交给 Universal Agent。",
    "如果一个任务同时包含调研/方案和代码实现，应先把调研/方案拆给非 Code Agent，待结果明确后再在后续轮次或依赖工作项中调用 Code Agent。",
    "如果 runMeta.triggerContext.explicitMentionedAgents 存在，优先在这些候选 Agent 中选择本轮真正需要的负责人；不适合本轮的候选 Agent 不要机械加入 assignments，但应在 coordinationMessage 中自然说明暂缓原因。",
    "禁止把 Orchestrator 或 agent-orchestrator 作为 assignments.agentId；主协调者只负责调度、校验和汇总，不执行子工作项。",
    "禁止把 Review Agent 或 agent-review 作为 assignments.agentId；审阅是主协调者 validate 节点职责，不作为子 Agent 调度。",
    "工作项必须有明确负责人、目标、预期产出、依赖和验收标准。",
    "每个工作项必须输出 schedulingLevel：由你根据任务语义决定先后顺序，低数字先执行，同数字且依赖满足时可并行；不要按 Agent 类型固定套顺序。",
    "如果某个工作项需要读取另一个工作项产出，必须在 dependsOn 中引用上游 workItemId；例如 Code Agent 需要产品和 UI 产出时，Code 工作项应显式 dependsOn 对应设计工作项。",
    "dependencyGraph 只能包含 {from:string,to:string} 边；没有可靠依赖边时输出空数组。",
    "coordinationMessage 只写一句简短分工说明；系统会根据 assignments 生成最终带 @ 的群聊分配公告。",
    "coordinationMessage 是用户可见的群聊消息，写得像一个人在安排团队协作：明确谁负责什么，语气自然，不要像日志或机器指令。",
    "输出统一节点 JSON，result 包含 planVersion、coordinationMessage、assignments、dependencyGraph、parallelGroups、stopAfterThisRound；每个 assignment 包含 workItemId、agentId、task、expectedOutput、schedulingLevel、dependsOn、acceptanceCriteria。"
  ].join("\n");
}

function validatePrompt() {
  return [
    "你是一名严格的技术审阅者，一次只校验一个 Agent 工作项。",
    "你会看到工作项目标、预期产出、Agent 输出引用、长期记忆、Run 进度和相关调度记录。",
    "审阅时可以参考 nodeContext.orchestratorMemoryPack 中的用户偏好和持久约束，但当前工作项验收标准优先。",
    "判断该输出是否满足验收标准；如果好，给出通过意见，可选择点赞或 Pin；如果不够好，说明返工方式。",
    "主协调者的审阅必须以群聊消息形式输出，并通过引用关联被校验消息。",
    "publicMessage 是用户可见的审阅回复，要像一个认真看过同事产出的负责人：先给结论，再说明原因和下一步；可以更有人味，但不要夸张。",
    "nextStep 只允许 continue、retry_assignment、retry_decompose、ask_user、integrate；likeMessage 和 pinMessage 必须是布尔值，可省略。",
    "输出统一节点 JSON，result 包含 passed、publicMessage、reason、nextStep、likeMessage、pinMessage、clarificationQuestion；无法判断的可省略，后端会使用默认值。"
  ].join("\n");
}

function directValidatePrompt() {
  return [
    "你是一名项目主协调者，负责校验无需子 Agent 执行的直接回复草稿。",
    "你会看到用户消息、understand 形成的直接回复草稿、长期记忆、Run 进度和相关上下文。",
    "判断这类请求是否确实不需要子 Agent：如果只是确认、简单判断、状态汇报或无需协作的答复，可以 passed=true，并把最终给用户看的汇报写进 publicMessage。",
    "publicMessage 是用户可见回复，要像主协调者本人在聊天里回复：直接、自然、清楚，不要像系统日志。",
    "如果发现仍需要子 Agent 协作或任务拆解，passed=false 且 nextStep=retry_decompose；如果需要用户补充，nextStep=ask_user。",
    "nextStep 只允许 continue、retry_assignment、retry_decompose、ask_user、integrate；likeMessage 和 pinMessage 必须是布尔值，可省略。",
    "输出统一节点 JSON，result 包含 passed、publicMessage、reason、nextStep、likeMessage、pinMessage、clarificationQuestion；无法判断的可省略，后端会使用默认值。"
  ].join("\n");
}

function integratePrompt() {
  return [
    "你是一名项目主协调者，负责把本轮所有 Agent 输出和校验结果整合成面向用户的群聊回复。",
    "输出风格可以参考 nodeContext.orchestratorMemoryPack 中的用户协作偏好；不要泄露内部记忆字段名。",
    "回复要像真实团队负责人：说明完成了什么、验证结果、风险、下一步建议。",
    "publicMessage 要有人在群聊里收尾的感觉：可以用“我已经看过/我建议/下一步我们可以...”这类自然表达，但保持专业克制。",
    "如果本轮只完成了阶段性内容，要明确停在自然确认点，不要一口气推进后续阶段。",
    "输出统一节点 JSON，result 包含 publicMessage、runBrief、openQuestions。"
  ].join("\n");
}

function summaryPrompt() {
  return [
    "你负责把本轮 Orchestrator Run 压缩成长期记忆候选。",
    "只保留已发生、已确认、对后续推进有帮助的信息。",
    "memoryCandidate 可包含跨对话主 Agent 应记住的用户偏好或协作约束，也可包含只属于当前项目的后续线索；后端记忆管理器会再次归类。",
    "输出统一节点 JSON，result 包含 runBrief、memoryCandidate、nextStepSuggestion。"
  ].join("\n");
}
