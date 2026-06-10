import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import { nanoid } from "nanoid";
import { Prisma, type Message } from "../../generated/prisma/client.js";
import { PrismaService } from "../../common/prisma.service.js";
import { LlmService } from "./llm.service.js";

const chatCompressSchema = z.object({
  summary: z.string().min(1),
  decisions: z.array(z.string()).default([]),
  openQuestions: z.array(z.string()).default([]),
  fileRefs: z.array(z.object({
    messageId: z.string(),
    name: z.string(),
    summary: z.string()
  })).default([])
});

export const runSummarySchema = z.object({
  brief: z.string().min(1),
  projectCorePatch: z.record(z.string(), z.unknown()).default({}),
  decisionsAndConstraints: z.preprocess(coerceStringList, z.array(z.string()).default([])),
  preferencesPatch: z.record(z.string(), z.unknown()).default({}),
  orchestratorMemoryPatch: z.record(z.string(), z.unknown()).default({}),
  openQuestions: z.array(z.string()).default([])
});

interface ApplyRunSummaryInput {
  conversationId: string;
  runId: string;
  userGoal: string;
  runBrief: string;
  ownerUserId?: string | undefined;
  nodeSummary?: unknown;
  outputs?: unknown;
}

interface AppendCodeExecutionMemoryInput {
  conversationId: string;
  agentId: string;
  provider: string;
  userMessageId?: string | undefined;
  assistantMessageId?: string | undefined;
  instruction: string;
  execution: Record<string, unknown>;
}

type AgentMemoryScopeName = "personal_cross_conversation" | "personal_direct" | "conversation";
type AgentRunBriefMessageActionType = "like" | "pin" | "reply" | "quote" | "comment";

export interface AppendAgentRunBriefInput {
  conversationId: string;
  workspaceId?: string | null;
  scope?: AgentMemoryScopeName | undefined;
  runId: string;
  agentRunId: string;
  agentId: string;
  agentType: string;
  ownerUserId: string;
  triggerSource: string;
  workItemId?: string | undefined;
  outputMessageId?: string | undefined;
  taskGoal: string;
  inputSummary?: string | undefined;
  processSummary?: string | undefined;
  resultSummary: string;
  status: string;
  createdAssets?: unknown[] | undefined;
  usedTools?: unknown[] | undefined;
  usedSkills?: unknown[] | undefined;
  verification?: Record<string, unknown> | undefined;
  risks?: unknown[] | undefined;
  openQuestions?: unknown[] | undefined;
  qualitySignals?: Record<string, unknown> | undefined;
  memoryCandidates?: Record<string, unknown> | undefined;
}

export interface UpdateAgentRunBriefQualityInput {
  conversationId: string;
  scope?: AgentMemoryScopeName | undefined;
  agentId: string;
  ownerUserId: string;
  agentRunId?: string | undefined;
  outputMessageId?: string | undefined;
  workItemId?: string | undefined;
  validation: {
    passed: boolean;
    nextStep: string;
    reason: string;
    publicMessage: string;
    likeMessage: boolean;
    pinMessage: boolean;
    reviewMessageId?: string | undefined;
  };
}

export interface UpdateAgentRunBriefMessageActionInput {
  conversationId: string;
  messageId: string;
  actionId: string;
  actionType: AgentRunBriefMessageActionType;
  actorId: string;
  actorType: string;
  deleted?: boolean | undefined;
  payload?: Record<string, unknown> | undefined;
}

@Injectable()
export class MemoryManagerService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(LlmService) private readonly llm: LlmService
  ) {}

  async refreshChatMemory(conversationId: string) {
    const [conversation, latestMemory, recentRows, olderRows] = await Promise.all([
      this.prisma.conversation.findFirst({ where: { id: conversationId, deletedAt: null } }),
      this.getLatestMemory(conversationId),
      this.prisma.message.findMany({
        where: { conversationId, deletedAt: null },
        orderBy: { seq: "desc" },
        take: 30
      }),
      this.prisma.message.findMany({
        where: { conversationId, deletedAt: null },
        orderBy: { seq: "desc" },
        skip: 30,
        take: 60
      })
    ]);
    if (!conversation) return null;
    const base = normalizeMemory(latestMemory?.memory, conversation);
    let earlyCompressed = asRecord(base.chatMemory)?.earlyCompressed;
    let fileIndex: unknown[] = Array.isArray(asRecord(base.chatMemory)?.messageFileIndex) ? asRecord(base.chatMemory)!.messageFileIndex as unknown[] : [];
    if (olderRows.length > 0) {
      const compressed = await this.llm.generateJson<z.infer<typeof chatCompressSchema>>({
        callerType: "memory_manager",
        callerId: `${conversationId}:chat`,
        schemaName: "memory_chat_compress",
        schema: chatCompressSchema,
        systemPrompt: chatCompressPrompt(),
        userPrompt: JSON.stringify({ previousSummary: earlyCompressed ?? "", messages: olderRows.reverse().map(messageForMemory) }, null, 2)
      });
      earlyCompressed = compressed.summary;
      fileIndex = [...fileIndex.filter((item: unknown) => typeof item === "object"), ...compressed.fileRefs];
    }
    return this.createMemoryVersion(conversationId, latestMemory?.version, {
      ...base,
      chatMemory: {
        ...(asRecord(base.chatMemory) ?? {}),
        earlyCompressed: earlyCompressed ?? "",
        recentMessages: recentRows.reverse().map(messageForMemory),
        messageFileIndex: fileIndex
      }
    });
  }

  async applyRunSummary(input: ApplyRunSummaryInput) {
    const [conversation, latestMemory] = await Promise.all([
      this.prisma.conversation.findFirst({ where: { id: input.conversationId, deletedAt: null } }),
      this.getLatestMemory(input.conversationId)
    ]);
    if (!conversation) return null;
    const base = normalizeMemory(latestMemory?.memory, conversation);
    const summary = await this.llm.generateJson<z.infer<typeof runSummarySchema>>({
      callerType: "memory_manager",
      callerId: `${input.runId}:summary`,
      schemaName: "memory_run_summary",
      schema: runSummarySchema,
      systemPrompt: runSummaryPrompt(),
      userPrompt: JSON.stringify(input, null, 2)
    });
    const taskBriefs = Array.isArray(base.taskBriefs) ? base.taskBriefs : [];
    const projectCore = {
      ...(asRecord(base.projectCore) ?? {}),
      ...(summary.projectCorePatch ?? {})
    };
    const existingConstraints = Array.isArray(asRecord(projectCore)?.decisionsAndConstraints)
      ? asRecord(projectCore)!.decisionsAndConstraints as unknown[]
      : [];
    projectCore.decisionsAndConstraints = uniqueStrings([...existingConstraints, ...summary.decisionsAndConstraints]).slice(-80);
    await this.refreshChatMemory(input.conversationId);
    const refreshed = await this.getLatestMemory(input.conversationId);
    const refreshedBase = normalizeMemory(refreshed?.memory, conversation);
    const memoryVersion = await this.createMemoryVersion(input.conversationId, refreshed?.version ?? latestMemory?.version, {
      ...refreshedBase,
      projectCore,
      taskBriefs: [
        ...taskBriefs,
        {
          runId: input.runId,
          userGoal: input.userGoal,
          brief: summary.brief || input.runBrief,
          rawBrief: input.runBrief,
          createdAt: new Date().toISOString()
        }
      ].slice(-60),
      preferences: {
        ...(asRecord(base.preferences) ?? {}),
        ...(summary.preferencesPatch ?? {})
      },
      openQuestions: uniqueStrings([...(Array.isArray(base.openQuestions) ? base.openQuestions : []), ...summary.openQuestions]).slice(-80)
    });
    if (input.ownerUserId && conversation.type !== "project") {
      await this.writeAgentMemory({
        agentId: "agent-orchestrator",
        ownerUserId: input.ownerUserId,
        scope: "personal_cross_conversation",
        memoryPatch: {
          lastRunAt: new Date().toISOString(),
          lastConversationId: input.conversationId,
          lastRunId: input.runId,
          lastUserGoal: input.userGoal,
          lastRunBrief: summary.brief || input.runBrief,
          ...(summary.orchestratorMemoryPatch ?? {})
        }
      });
    }
    return memoryVersion;
  }

  async appendPinnedMessageMemory(conversationId: string, message: Message, action: { id: string; actorId: string; actorType: string; createdAt: Date }) {
    const conversation = await this.prisma.conversation.findFirst({ where: { id: conversationId, deletedAt: null } });
    if (!conversation || conversation.type !== "project") return null;
    const latestMemory = await this.getLatestMemory(conversationId);
    const base = normalizeMemory(latestMemory?.memory, conversation);
    const chatMemory = asRecord(base.chatMemory) ?? {};
    const previousPins = Array.isArray(chatMemory.pinMessages) ? chatMemory.pinMessages.filter(asRecord) : [];
    const pin = {
      messageId: message.id,
      actionId: action.id,
      pinnedBy: action.actorId,
      pinnedByType: action.actorType,
      pinnedAt: action.createdAt.toISOString(),
      senderName: message.senderName,
      summary: summarizeMessage(message)
    };
    return this.createMemoryVersion(conversationId, latestMemory?.version, {
      ...base,
      chatMemory: {
        ...chatMemory,
        pinMessages: [...previousPins.filter((item) => item.messageId !== message.id), pin]
      }
    });
  }

  async appendCodeExecutionMemory(input: AppendCodeExecutionMemoryInput) {
    const [conversation, latestMemory] = await Promise.all([
      this.prisma.conversation.findFirst({ where: { id: input.conversationId, deletedAt: null } }),
      this.getLatestMemory(input.conversationId)
    ]);
    if (!conversation) return null;
    const base = normalizeMemory(latestMemory?.memory, conversation);
    const codeMemory = normalizeCodeExecutionMemory(base.codeExecutionMemory, conversation);
    const execution = {
      id: typeof input.execution.id === "string" ? input.execution.id : `code-exec-${nanoid(10)}`,
      agentId: input.agentId,
      provider: input.provider,
      ...(input.userMessageId ? { userMessageId: input.userMessageId } : {}),
      ...(input.assistantMessageId ? { assistantMessageId: input.assistantMessageId } : {}),
      instruction: input.instruction.slice(0, 2_000),
      ...(typeof input.execution.status === "string" ? { status: input.execution.status } : {}),
      summary: typeof input.execution.summary === "string" ? input.execution.summary : "",
      ...(typeof input.execution.codeTaskRunId === "string" ? { codeTaskRunId: input.execution.codeTaskRunId } : {}),
      ...(typeof input.execution.logAssetId === "string" ? { logAssetId: input.execution.logAssetId } : {}),
      ...(typeof input.execution.diffAssetId === "string" ? { diffAssetId: input.execution.diffAssetId } : {}),
      ...(typeof input.execution.sessionId === "string" ? { sessionId: input.execution.sessionId } : {}),
      ...(Array.isArray(input.execution.changedFiles) ? { changedFiles: input.execution.changedFiles } : {}),
      ...(typeof input.execution.exitCode === "number" || input.execution.exitCode === null ? { exitCode: input.execution.exitCode } : {}),
      ...(typeof input.execution.timedOut === "boolean" ? { timedOut: input.execution.timedOut } : {}),
      ...(typeof input.execution.cancelled === "boolean" ? { cancelled: input.execution.cancelled } : {}),
      completedAt: typeof input.execution.completedAt === "string" ? input.execution.completedAt : new Date().toISOString()
    };
    return this.createMemoryVersion(input.conversationId, latestMemory?.version, {
      ...base,
      codeExecutionMemory: {
        ...codeMemory,
        lockedCodeAgentId: conversation.codeAgentId ?? input.agentId,
        provider: input.provider,
        latestSummary: typeof execution.summary === "string" ? execution.summary : "",
        executions: [...codeMemory.executions, execution].slice(-40),
        updatedAt: new Date().toISOString()
      }
    });
  }

  async writeAgentMemory(input: {
    agentId: string;
    ownerUserId: string;
    conversationId?: string;
    scope: "personal_cross_conversation" | "personal_direct" | "conversation";
    memoryPatch: Record<string, unknown>;
  }) {
    const existing = await this.prisma.agentMemory.findFirst({
      where: {
        agentId: input.agentId,
        ownerUserId: input.ownerUserId,
        scope: input.scope,
        conversationId: input.conversationId ?? null,
        deletedAt: null
      },
      orderBy: { updatedAt: "desc" }
    });
    const merged = {
      ...(asRecord(existing?.memory) ?? {}),
      ...input.memoryPatch,
      updatedAt: new Date().toISOString()
    };
    const row = existing
      ? await this.prisma.agentMemory.update({
        where: { id: existing.id },
        data: { memory: merged as Prisma.InputJsonValue }
      })
      : await this.prisma.agentMemory.create({
        data: {
          id: `agent-memory-${nanoid(10)}`,
          agentId: input.agentId,
          ownerUserId: input.ownerUserId,
          conversationId: input.conversationId ?? null,
          scope: input.scope,
          memory: merged as Prisma.InputJsonValue
        }
      });
    await this.createAgentMemoryVersion(row.id, row.memory);
    return row;
  }

  async appendAgentRunBrief(input: AppendAgentRunBriefInput) {
    const scope = input.scope ?? "conversation";
    const existing = await this.findAgentMemory(input.agentId, input.ownerUserId, scope, input.conversationId);
    const memory = asRecord(existing?.memory) ?? {};
    const now = new Date().toISOString();
    const brief = normalizeAgentRunBrief(input, now, scope);
    const previousBriefs = normalizeBriefList(memory.recentRunBriefs);
    const recentRunBriefs = upsertBrief(previousBriefs, brief).slice(-30);
    const nextMemory = {
      ...memory,
      lastProjectAssignmentAt: now,
      lastRunId: input.runId,
      lastAssignmentSummary: brief.resultSummary,
      recentRunBriefs,
      dispatchMemoryView: buildAgentDispatchMemoryView(input.agentId, recentRunBriefs, memory, now),
      updatedAt: now
    };
    return this.persistAgentMemory(existing?.id, {
      agentId: input.agentId,
      ownerUserId: input.ownerUserId,
      conversationId: input.conversationId,
      scope,
      memory: nextMemory
    });
  }

  async updateAgentRunBriefQuality(input: UpdateAgentRunBriefQualityInput) {
    const scope = input.scope ?? "conversation";
    const existing = await this.findAgentMemory(input.agentId, input.ownerUserId, scope, input.conversationId);
    const memory = asRecord(existing?.memory);
    if (!existing || !memory) return null;
    const previousBriefs = normalizeBriefList(memory.recentRunBriefs);
    const now = new Date().toISOString();
    let matched = false;
    const recentRunBriefs = previousBriefs.map((brief) => {
      if (!isMatchingBrief(brief, input)) return brief;
      matched = true;
      const previousQuality = asRecord(brief.qualitySignals) ?? {};
      const validation = {
        ...input.validation,
        reviewedAt: now
      };
      return {
        ...brief,
        verification: {
          ...(asRecord(brief.verification) ?? {}),
          passed: input.validation.passed,
          nextStep: input.validation.nextStep,
          reason: input.validation.reason,
          publicMessage: input.validation.publicMessage,
          reviewedAt: now
        },
        qualitySignals: {
          ...previousQuality,
          validation,
          validateStatus: input.validation.passed ? "passed" : input.validation.nextStep,
          liked: input.validation.likeMessage,
          pinned: input.validation.pinMessage,
          userReviewed: false,
          ...(input.validation.reviewMessageId ? { reviewMessageId: input.validation.reviewMessageId } : {})
        },
        updatedAt: now
      };
    });
    if (!matched) return existing;
    const nextMemory = {
      ...memory,
      recentRunBriefs,
      dispatchMemoryView: buildAgentDispatchMemoryView(input.agentId, recentRunBriefs, memory, now),
      updatedAt: now
    };
    return this.persistAgentMemory(existing.id, {
      agentId: input.agentId,
      ownerUserId: input.ownerUserId,
      conversationId: input.conversationId,
      scope,
      memory: nextMemory
    });
  }

  async updateAgentRunBriefMessageAction(input: UpdateAgentRunBriefMessageActionInput) {
    const target = await this.prisma.message.findFirst({
      where: { id: input.messageId, conversationId: input.conversationId, deletedAt: null },
      select: { id: true, senderType: true, senderId: true }
    });
    if (!target || target.senderType !== "agent") return { updated: 0 };
    const memories = await this.prisma.agentMemory.findMany({
      where: {
        agentId: target.senderId,
        conversationId: input.conversationId,
        scope: { in: ["conversation", "personal_direct"] },
        deletedAt: null
      },
      orderBy: { updatedAt: "desc" }
    });
    const now = new Date().toISOString();
    let updated = 0;
    for (const existing of memories) {
      const memory = asRecord(existing.memory);
      if (!memory) continue;
      let matched = false;
      const recentRunBriefs = normalizeBriefList(memory.recentRunBriefs).map((brief) => {
        if (brief.outputMessageId !== input.messageId) return brief;
        matched = true;
        const previousQuality = asRecord(brief.qualitySignals) ?? {};
        const nextQuality = applyMessageActionQualitySignal(previousQuality, input, now);
        const verification = asRecord(brief.verification) ?? {};
        return {
          ...brief,
          verification: input.actionType === "reply" || input.actionType === "quote" || input.actionType === "comment"
            ? {
                ...verification,
                userFeedbackActions: normalizeRecordList(nextQuality.messageActions)
                  .filter((action) => action.type === "reply" || action.type === "quote" || action.type === "comment")
                  .slice(-10)
              }
            : verification,
          qualitySignals: nextQuality,
          updatedAt: now
        };
      });
      if (!matched) continue;
      const nextMemory = {
        ...memory,
        recentRunBriefs,
        dispatchMemoryView: buildAgentDispatchMemoryView(target.senderId, recentRunBriefs, memory, now),
        updatedAt: now
      };
      await this.persistAgentMemory(existing.id, {
        agentId: existing.agentId,
        ownerUserId: existing.ownerUserId,
        conversationId: existing.conversationId,
        scope: existing.scope,
        memory: nextMemory
      });
      updated += 1;
    }
    return { updated };
  }

  private async findAgentMemory(agentId: string, ownerUserId: string, scope: AgentMemoryScopeName, conversationId?: string | null) {
    return this.prisma.agentMemory.findFirst({
      where: {
        agentId,
        ownerUserId,
        scope,
        conversationId: conversationId ?? null,
        deletedAt: null
      },
      orderBy: { updatedAt: "desc" }
    });
  }

  private async persistAgentMemory(existingId: string | undefined, input: {
    agentId: string;
    ownerUserId: string;
    conversationId?: string | null;
    scope: AgentMemoryScopeName;
    memory: Record<string, unknown>;
  }) {
    const row = existingId
      ? await this.prisma.agentMemory.update({
        where: { id: existingId },
        data: { memory: input.memory as Prisma.InputJsonValue }
      })
      : await this.prisma.agentMemory.create({
        data: {
          id: `agent-memory-${nanoid(10)}`,
          agentId: input.agentId,
          ownerUserId: input.ownerUserId,
          conversationId: input.conversationId ?? null,
          scope: input.scope,
          memory: input.memory as Prisma.InputJsonValue
        }
      });
    await this.createAgentMemoryVersion(row.id, row.memory);
    return row;
  }

  private async getLatestMemory(conversationId: string) {
    return this.prisma.conversationMemory.findFirst({
      where: { conversationId, deletedAt: null },
      orderBy: { version: "desc" }
    });
  }

  private async createMemoryVersion(conversationId: string, previousVersion: number | undefined, memory: Record<string, unknown>) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const latest = attempt === 0 && previousVersion !== undefined
        ? { version: previousVersion }
        : await this.getLatestMemory(conversationId);
      const version = (latest?.version ?? 0) + 1;
      const snapshot = {
        ...memory,
        version,
        updatedAt: new Date().toISOString()
      };
      try {
        const created = await this.prisma.conversationMemory.create({
          data: {
            id: `memory-${nanoid(10)}`,
            conversationId,
            version,
            memory: snapshot as Prisma.InputJsonValue
          }
        });
        await this.prisma.memoryVersion.create({
          data: {
            id: `memory-version-${nanoid(10)}`,
            targetType: "conversation",
            targetId: conversationId,
            version,
            snapshot: snapshot as Prisma.InputJsonValue
          }
        });
        return created;
      } catch (error) {
        if (!isUniqueConstraintError(error) || attempt >= 4) throw error;
      }
    }
    throw new Error("Unable to create conversation memory version after retries");
  }

  private async createAgentMemoryVersion(agentMemoryId: string, snapshot: unknown) {
    const latest = await this.prisma.memoryVersion.aggregate({
      where: { targetType: "agent", targetId: agentMemoryId },
      _max: { version: true }
    });
    await this.prisma.memoryVersion.create({
      data: {
        id: `memory-version-${nanoid(10)}`,
        targetType: "agent",
        targetId: agentMemoryId,
        version: (latest._max.version ?? 0) + 1,
        snapshot: snapshot as Prisma.InputJsonValue
      }
    });
  }
}

function isUniqueConstraintError(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

function normalizeMemory(value: unknown, conversation: { id: string; title: string; workspaceId: string | null; codeAgentId?: string | null }) {
  const base = asRecord(value) ?? {};
  return {
    projectCore: {
      basicInfo: {
        conversationId: conversation.id,
        workspaceId: conversation.workspaceId,
        name: conversation.title
      },
      ...(asRecord(base.projectCore) ?? {})
    },
    chatMemory: asRecord(base.chatMemory) ?? {
      earlyCompressed: "",
      recentMessages: [],
      pinMessages: [],
      messageFileIndex: []
    },
    taskBriefs: Array.isArray(base.taskBriefs) ? base.taskBriefs : [],
    codeExecutionMemory: normalizeCodeExecutionMemory(base.codeExecutionMemory, conversation),
    preferences: asRecord(base.preferences) ?? {},
    openQuestions: Array.isArray(base.openQuestions) ? base.openQuestions : []
  };
}

function normalizeCodeExecutionMemory(value: unknown, conversation: { codeAgentId?: string | null }) {
  const base = asRecord(value) ?? {};
  return {
    kind: "code_history_execution_records",
    lockedCodeAgentId: typeof base.lockedCodeAgentId === "string" ? base.lockedCodeAgentId : conversation.codeAgentId ?? null,
    provider: typeof base.provider === "string" ? base.provider : null,
    latestSummary: typeof base.latestSummary === "string" ? base.latestSummary : "",
    executions: Array.isArray(base.executions) ? base.executions.filter(asRecord).slice(-40) : [],
    updatedAt: typeof base.updatedAt === "string" ? base.updatedAt : null
  };
}

function messageForMemory(message: Message) {
  return {
    id: message.id,
    seq: message.seq,
    senderType: message.senderType,
    senderId: message.senderId,
    senderName: message.senderName,
    summary: summarizeMessage(message),
    createdAt: message.createdAt.toISOString()
  };
}

function summarizeMessage(message: Message) {
  const blocks = Array.isArray(message.blocks) ? message.blocks as Array<Record<string, unknown>> : [];
  const text = blocks.map((block) => {
    const payload = asRecord(block.payload);
    if (block.type === "markdown" && typeof payload?.text === "string") return payload.text;
    if (block.type === "code") return `代码块 ${stringValue(payload?.filename)} ${stringValue(payload?.language)}: ${stringValue(payload?.code)}`;
    if (block.type === "image") return `图片附件 ${stringValue(payload?.assetId)} ${stringValue(payload?.alt)}`;
    if (block.type === "file") {
      return `文件附件 ${stringValue(payload?.name)} ${stringValue(payload?.mimeType)} ${typeof payload?.size === "number" ? `${payload.size}B` : ""} ${stringValue(payload?.summary)}`;
    }
    if (block.type === "web_preview") return `网页预览 ${stringValue(payload?.title)} ${stringValue(payload?.url)} ${stringValue(payload?.status)}`;
    if (block.type === "diff") {
      const files = Array.isArray(payload?.files) ? payload.files as Array<Record<string, unknown>> : [];
      const additions = files.reduce((sum, file) => sum + (typeof file.additions === "number" ? file.additions : 0), 0);
      const deletions = files.reduce((sum, file) => sum + (typeof file.deletions === "number" ? file.deletions : 0), 0);
      return `Diff ${stringValue(payload?.title)} ${files.length} files +${additions}/-${deletions}`;
    }
    if (block.type === "agent_status") return `Agent 状态 ${stringValue(payload?.title)} ${stringValue(payload?.status)} ${stringValue(payload?.summary)}`;
    if (block.type === "deploy_status") return `部署状态 ${stringValue(payload?.title)} ${stringValue(payload?.status)} ${stringValue(payload?.detail)}`;
    return String(block.type ?? "message");
  }).join("\n").replace(/\s+/g, " ").trim();
  return text.slice(0, 300);
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : "";
}

function uniqueStrings(values: unknown[]) {
  return Array.from(new Set(coerceStringList(values)));
}

function normalizeAgentRunBrief(input: AppendAgentRunBriefInput, now: string, scope: AgentMemoryScopeName) {
  const memoryCandidates = asRecord(input.memoryCandidates) ?? {};
  return {
    briefId: `agent-brief-${nanoid(10)}`,
    briefType: agentRunBriefType(input, memoryCandidates),
    memoryScope: scope,
    agentRunId: input.agentRunId,
    runId: input.runId,
    agentId: input.agentId,
    agentType: input.agentType,
    conversationId: input.conversationId,
    workspaceId: input.workspaceId ?? null,
    triggerSource: input.triggerSource,
    ...(input.workItemId ? { workItemId: input.workItemId } : {}),
    ...(input.outputMessageId ? { outputMessageId: input.outputMessageId } : {}),
    taskGoal: input.taskGoal.slice(0, 2_000),
    inputSummary: (input.inputSummary ?? "").slice(0, 2_000),
    processSummary: (input.processSummary ?? "").slice(0, 2_000),
    resultSummary: input.resultSummary.slice(0, 2_000),
    status: input.status,
    createdAssets: normalizeRecordList(input.createdAssets).slice(-20),
    usedTools: normalizeRecordList(input.usedTools).slice(-20),
    usedSkills: normalizeRecordList(input.usedSkills).slice(-20),
    verification: input.verification ?? { status: "pending" },
    risks: coerceStringList(input.risks).slice(-20),
    openQuestions: coerceStringList(input.openQuestions).slice(-20),
    qualitySignals: {
      validateStatus: "pending",
      liked: false,
      pinned: false,
      userReviewed: false,
      ...(input.qualitySignals ?? {})
    },
    memoryCandidates,
    createdAt: now,
    updatedAt: now
  };
}

function agentRunBriefType(input: AppendAgentRunBriefInput, memoryCandidates: Record<string, unknown>) {
  if (input.agentType === "code" || asRecord(memoryCandidates.codeExecutionBrief)) return "CodeAgentRunBrief";
  if (input.agentId === "agent-ui" || memoryCandidates.lastUiDesignRunId || memoryCandidates.uiAgentRunBrief) return "UiAgentRunBrief";
  if (isBuiltInAgentId(input.agentId)) return "AgentRunBrief";
  return "CustomAgentRunBrief";
}

function isBuiltInAgentId(agentId: string) {
  return new Set([
    "agent-orchestrator",
    "agent-universal",
    "agent-product",
    "agent-ui",
    "agent-review",
    "agent-codex",
    "agent-opencode"
  ]).has(agentId);
}

function applyMessageActionQualitySignal(previousQuality: Record<string, unknown>, input: UpdateAgentRunBriefMessageActionInput, now: string) {
  const existingActions = normalizeRecordList(previousQuality.messageActions)
    .filter((action) => action.actionId !== input.actionId);
  const nextActions = input.deleted
    ? existingActions
    : [
        ...existingActions,
        {
          actionId: input.actionId,
          type: input.actionType,
          actorId: input.actorId,
          actorType: input.actorType,
          payload: input.payload ?? {},
          at: now
        }
      ].slice(-30);
  const nextQuality: Record<string, unknown> = {
    ...previousQuality,
    messageActions: nextActions,
    latestMessageActionAt: now
  };
  if (input.actionType === "like") nextQuality.liked = !input.deleted;
  if (input.actionType === "pin") nextQuality.pinned = !input.deleted;
  if (input.actionType === "reply" || input.actionType === "quote" || input.actionType === "comment") {
    nextQuality.userReviewed = nextActions.some((action) => action.type === "reply" || action.type === "quote" || action.type === "comment");
    nextQuality.feedbackActionCount = nextActions.filter((action) => action.type === "reply" || action.type === "quote" || action.type === "comment").length;
  }
  return nextQuality;
}

function normalizeBriefList(value: unknown) {
  return (Array.isArray(value) ? value : [])
    .map(asRecord)
    .filter((item): item is Record<string, unknown> => Boolean(item));
}

function normalizeRecordList(value: unknown) {
  return (Array.isArray(value) ? value : [])
    .map(asRecord)
    .filter((item): item is Record<string, unknown> => Boolean(item));
}

function upsertBrief(previousBriefs: Array<Record<string, unknown>>, brief: Record<string, unknown>) {
  const key = typeof brief.agentRunId === "string" ? brief.agentRunId : "";
  if (!key) return [...previousBriefs, brief];
  const replaced = previousBriefs.map((item) => item.agentRunId === key ? brief : item);
  return replaced.some((item) => item.agentRunId === key) ? replaced : [...previousBriefs, brief];
}

function isMatchingBrief(brief: Record<string, unknown>, input: UpdateAgentRunBriefQualityInput) {
  if (input.agentRunId && brief.agentRunId === input.agentRunId) return true;
  if (input.outputMessageId && brief.outputMessageId === input.outputMessageId) return true;
  if (input.workItemId && brief.workItemId === input.workItemId) return true;
  return false;
}

function buildAgentDispatchMemoryView(agentId: string, briefs: Array<Record<string, unknown>>, previousMemory: Record<string, unknown>, updatedAt: string) {
  const recentBriefs = briefs.slice(-8).map(toDispatchBriefDigest);
  const successfulBriefs = briefs.filter(isSuccessfulBrief).slice(-10);
  const failedBriefs = briefs.filter(isFailedBrief).slice(-10);
  const openLoops = briefs.filter(isOpenLoopBrief).slice(-10);
  const previousView = asRecord(previousMemory.dispatchMemoryView) ?? {};
  return {
    agentId,
    recentBriefs,
    currentOpenLoops: openLoops.map(toOpenLoopDigest),
    lastSuccessfulTasks: successfulBriefs.map(toTaskDigest),
    lastFailedTasks: failedBriefs.map(toTaskDigest),
    qualitySummary: {
      totalRecentRuns: briefs.length,
      passedRecentRuns: successfulBriefs.length,
      failedRecentRuns: failedBriefs.length,
      openLoops: openLoops.length,
      likedRecentMessages: briefs.filter((brief) => asRecord(brief.qualitySignals)?.liked === true).length,
      pinnedRecentMessages: briefs.filter((brief) => asRecord(brief.qualitySignals)?.pinned === true).length,
      lastStatus: typeof briefs.at(-1)?.status === "string" ? briefs.at(-1)?.status : null,
      updatedAt
    },
    memoryDigest: typeof previousView.memoryDigest === "string"
      ? previousView.memoryDigest
      : buildSimpleAgentMemoryDigest(successfulBriefs, failedBriefs, openLoops),
    updatedAt
  };
}

function toDispatchBriefDigest(brief: Record<string, unknown>) {
  return {
    agentRunId: brief.agentRunId,
    runId: brief.runId,
    workItemId: brief.workItemId,
    taskGoal: brief.taskGoal,
    resultSummary: brief.resultSummary,
    status: brief.status,
    verification: brief.verification,
    qualitySignals: brief.qualitySignals,
    createdAssets: brief.createdAssets,
    updatedAt: brief.updatedAt ?? brief.createdAt
  };
}

function toTaskDigest(brief: Record<string, unknown>) {
  return {
    agentRunId: brief.agentRunId,
    workItemId: brief.workItemId,
    taskGoal: brief.taskGoal,
    resultSummary: brief.resultSummary,
    status: brief.status,
    updatedAt: brief.updatedAt ?? brief.createdAt
  };
}

function toOpenLoopDigest(brief: Record<string, unknown>) {
  const verification = asRecord(brief.verification) ?? {};
  return {
    agentRunId: brief.agentRunId,
    workItemId: brief.workItemId,
    taskGoal: brief.taskGoal,
    reason: verification.reason ?? verification.publicMessage ?? brief.resultSummary,
    nextStep: verification.nextStep ?? asRecord(brief.qualitySignals)?.validateStatus ?? "needs_followup",
    updatedAt: brief.updatedAt ?? brief.createdAt
  };
}

function isSuccessfulBrief(brief: Record<string, unknown>) {
  const verification = asRecord(brief.verification);
  if (verification?.passed === true) return true;
  return brief.status === "completed" && asRecord(brief.qualitySignals)?.validateStatus !== "retry_assignment";
}

function isFailedBrief(brief: Record<string, unknown>) {
  const verification = asRecord(brief.verification);
  if (verification?.passed === false) return true;
  return brief.status === "failed";
}

function isOpenLoopBrief(brief: Record<string, unknown>) {
  const verification = asRecord(brief.verification);
  const nextStep = typeof verification?.nextStep === "string" ? verification.nextStep : asRecord(brief.qualitySignals)?.validateStatus;
  return brief.status === "needs_clarification" ||
    nextStep === "retry_assignment" ||
    nextStep === "retry_decompose" ||
    nextStep === "ask_user" ||
    coerceStringList(brief.openQuestions).length > 0;
}

function buildSimpleAgentMemoryDigest(successfulBriefs: Array<Record<string, unknown>>, failedBriefs: Array<Record<string, unknown>>, openLoops: Array<Record<string, unknown>>) {
  const parts = [
    successfulBriefs.at(-1)?.resultSummary ? `最近成功：${String(successfulBriefs.at(-1)?.resultSummary)}` : "",
    failedBriefs.at(-1)?.resultSummary ? `最近失败：${String(failedBriefs.at(-1)?.resultSummary)}` : "",
    openLoops.at(-1)?.taskGoal ? `待跟进：${String(openLoops.at(-1)?.taskGoal)}` : ""
  ].filter(Boolean);
  return parts.join("；");
}

function coerceStringList(value: unknown) {
  const values = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  return values.map(stringListItem).filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function stringListItem(value: unknown) {
  if (typeof value === "string") return value.trim();
  const record = asRecord(value);
  if (!record) return undefined;
  const preferred = ["decision", "constraint", "summary", "note", "title", "value", "text"];
  for (const key of preferred) {
    const item = record[key];
    if (typeof item === "string" && item.trim()) return item.trim();
  }
  const pairs = Object.entries(record)
    .filter(([, item]) => typeof item === "string" || typeof item === "number" || typeof item === "boolean")
    .map(([key, item]) => `${key}: ${String(item)}`);
  return pairs.length > 0 ? pairs.join("; ") : undefined;
}

function chatCompressPrompt() {
  return [
    "你负责压缩一个项目群聊的早期消息上下文。",
    "保留和项目目标、已确认决策、开放问题、文件附件、Agent 输出有关的信息。",
    "不要保存无意义闲聊；不要编造不存在的结论。",
    "输出 JSON：summary、decisions、openQuestions、fileRefs。"
  ].join("\n");
}

function runSummaryPrompt() {
  return [
    "你负责把一次 Orchestrator Run 的执行结果整理成长期记忆候选。",
    "只写已经发生和已经确认的内容；未确认内容放入 openQuestions。",
    "projectCorePatch 只能补充项目目标、范围、约束等，不要覆盖用户原始输入。",
    "orchestratorMemoryPatch 只写跨项目、跨对话仍有价值的用户偏好、协作方式、持久约束和主 Agent 应记住的经验；不要写只属于当前项目的一次性细节。",
    "输出 JSON：brief、projectCorePatch、decisionsAndConstraints、preferencesPatch、orchestratorMemoryPatch、openQuestions。"
  ].join("\n");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}
