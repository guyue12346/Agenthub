import { BadRequestException, Controller, Get, Inject, NotFoundException, Param, Post, Query } from "@nestjs/common";
import type { AgentHubUser } from "@agenthub/shared";
import { z } from "zod";
import { type RuntimeJob } from "../../generated/prisma/client.js";
import { CurrentUser } from "../../common/auth.decorators.js";
import { parseQuery } from "../../common/validation.js";
import { ConversationsService } from "../conversations/conversations.service.js";
import { RealtimeService } from "../realtime/realtime.service.js";
import { RuntimeService } from "./runtime.service.js";

const runsQuerySchema = z.object({
  conversationId: z.string().trim().min(1).optional()
});

const replayQuerySchema = z.object({
  afterSeq: z.coerce.number().int().min(0).default(0)
});

@Controller("runtime")
export class RuntimeController {
  constructor(
    @Inject(RuntimeService)
    private readonly runtime: RuntimeService,
    @Inject(RealtimeService)
    private readonly realtime: RealtimeService,
    @Inject(ConversationsService)
    private readonly conversations: ConversationsService
  ) {}

  @Get("runs")
  async listRuns(@CurrentUser() currentUser: AgentHubUser, @Query() query: unknown) {
    const normalizedQuery = typeof query === "string" ? { conversationId: query } : query;
    const { conversationId } = parseQuery(runsQuerySchema, normalizedQuery);
    if (conversationId) {
      await this.conversations.assertCanAccessConversation(currentUser, conversationId);
    } else if (currentUser.role !== "admin") {
      throw new BadRequestException("conversationId is required");
    }
    return { runs: await this.runtime.getRuns(conversationId) };
  }

  @Get("runs/:runId")
  async getRun(@CurrentUser() currentUser: AgentHubUser, @Param("runId") runId: string) {
    const run = await this.runtime.getRun(runId);
    if (run) await this.conversations.assertCanAccessConversation(currentUser, run.conversationId);
    return { run };
  }

  @Post("runs/:runId/retry")
  async retryRun(@CurrentUser() currentUser: AgentHubUser, @Param("runId") runId: string) {
    const run = await this.runtime.getRun(runId);
    if (!run) throw new NotFoundException("Runtime run not found");
    await this.conversations.assertCanAccessConversation(currentUser, run.conversationId);
    return this.runtime.enqueueRunRetry(runId);
  }

  @Post("jobs/:jobId/cancel")
  async cancelJob(@CurrentUser() currentUser: AgentHubUser, @Param("jobId") jobId: string) {
    const job = await this.runtime.getJob(jobId);
    if (!job) throw new NotFoundException("Runtime job not found");
    await this.assertCanCancelJob(currentUser, job);
    const cancelled = await this.runtime.cancelJob(job.id);
    return { runtimeJob: toRuntimeJobView(cancelled) };
  }

  @Get("events/:scopeKind/:scopeId")
  async replay(
    @CurrentUser() currentUser: AgentHubUser,
    @Param("scopeKind") scopeKind: "conversation" | "user" | "workspace" | "run" | "agent_run",
    @Param("scopeId") scopeId: string,
    @Query() query: unknown
  ) {
    if (scopeKind === "conversation") {
      await this.conversations.assertCanAccessConversation(currentUser, scopeId);
    } else if (scopeKind === "user") {
      if (scopeId !== currentUser.id) throw new BadRequestException("Cannot replay another user's runtime events");
    } else if (currentUser.role !== "admin") {
      throw new BadRequestException("Only admin can replay non-conversation runtime scopes");
    }
    const normalizedQuery = typeof query === "string" ? { afterSeq: query } : query;
    const { afterSeq } = parseQuery(replayQuerySchema, normalizedQuery);
    return { events: await this.realtime.replay(scopeKind, scopeId, afterSeq) };
  }

  private async assertCanCancelJob(currentUser: AgentHubUser, job: RuntimeJob) {
    const message = asRecord(asRecord(job.payload)?.message);
    const conversationId = typeof message?.conversationId === "string" ? message.conversationId : undefined;
    const sender = asRecord(message?.sender);
    if (!conversationId) {
      if (currentUser.role === "admin") return;
      throw new BadRequestException("Only admin can cancel runtime jobs without conversation context");
    }
    await this.conversations.assertCanAccessConversation(currentUser, conversationId);
    if (sender?.type === "user" && sender.id === currentUser.id) return;
    await this.conversations.assertCanManageConversation(currentUser, conversationId);
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function toRuntimeJobView(job: RuntimeJob) {
  return {
    id: job.id,
    kind: job.kind,
    status: job.status,
    targetType: job.targetType,
    targetId: job.targetId,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    cancelRequested: job.cancelRequested,
    error: job.error,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString()
  };
}
