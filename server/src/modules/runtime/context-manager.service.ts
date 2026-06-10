import { Inject, Injectable } from "@nestjs/common";
import type { ChatMessage, MessageBlock, OrchestratorNode, OrchestratorRun } from "@agenthub/shared";
import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { PrismaService } from "../../common/prisma.service.js";
import { toChatMessage } from "../messages/messages.service.js";
import { executableRuntimeToolRegistry } from "../tools/tool-registry.js";

const SECTION_TOKEN_BUDGETS = {
  invocationContext: 350,
  orchestratorMemoryPack: 1_600,
  longTermMemoryPack: 2_200,
  codeExecutionMemory: 1_400,
  runWorkingMemoryPack: 2_600,
  trigger: 450,
  recentMessageDigests: 2_200,
  workspaceIndexSummary: 1_500,
  availableAgents: 2_800,
  availableTools: 900
} as const;

const WORKSPACE_FILE_INDEX_MAX_DEPTH = 3;
const WORKSPACE_FILE_INDEX_MAX_FILES = 80;
const WORKSPACE_FILE_INDEX_IGNORED_DIRS = new Set([".agenthub", ".git", ".uploads", ".versions", "node_modules"]);

interface BuildNodeContextInput {
  conversationId: string;
  triggerMessageId: string;
  node: OrchestratorNode;
  run: OrchestratorRun & {
    runMeta?: unknown;
    understanding?: unknown;
    workItems?: unknown;
    edgeHistory?: unknown;
    agentRuns?: unknown;
    toolRuns?: unknown;
    uiInteractions?: unknown;
    outputs?: unknown;
    blockers?: unknown;
  };
  currentEvent?: Record<string, unknown>;
}

interface BuildDirectAgentContextInput {
  conversationId: string;
  agentId: string;
  userId: string;
  triggerMessage: ChatMessage;
}

interface BuildAgentMemoryPackInput {
  conversationId: string;
  agentId: string;
  userId: string;
}

@Injectable()
export class ContextManagerService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async buildNodeContext(input: BuildNodeContextInput) {
    const [conversation, recentRows, memoryRow, assets, agents, triggerRow] = await Promise.all([
      this.prisma.conversation.findFirst({
        where: { id: input.conversationId, deletedAt: null },
        include: {
          workspace: true,
          members: { where: { deletedAt: null } }
        }
      }),
      this.prisma.message.findMany({
        where: { conversationId: input.conversationId, deletedAt: null },
        include: { actions: { where: { deletedAt: null }, orderBy: { createdAt: "asc" } } },
        orderBy: { seq: "desc" },
        take: 30
      }),
      this.prisma.conversationMemory.findFirst({
        where: { conversationId: input.conversationId, deletedAt: null },
        orderBy: { version: "desc" }
      }),
      this.prisma.workspaceAsset.findMany({
        where: { workspace: { conversationId: input.conversationId }, deletedAt: null },
        orderBy: { updatedAt: "desc" },
        take: 50
      }),
      this.prisma.agent.findMany({
        where: { deletedAt: null, status: "available" },
        orderBy: { createdAt: "asc" }
      }),
      this.prisma.message.findFirst({
        where: { id: input.triggerMessageId, conversationId: input.conversationId, deletedAt: null },
        select: { senderType: true, senderId: true }
      })
    ]);
    const recentMessages = recentRows.reverse().map(toChatMessage);
    const assetById = new Map(assets.map((asset) => [asset.id, asset]));
    const recentMessageDigests = recentMessages.map((message) => summarizeChatMessageForContext(message, assetById));
    const memory = normalizeConversationMemory(memoryRow?.memory, conversation, recentMessageDigests);
    const { codeExecutionMemory, ...longTermMemoryPack } = memory;
    const ownerUserId = resolveContextOwnerUserId(conversation, triggerRow);
    const orchestratorMemory = await this.buildAgentMemoryPack({
      conversationId: input.conversationId,
      agentId: "agent-orchestrator",
      userId: ownerUserId
    });
    const orchestratorMemoryPack = {
      agentId: "agent-orchestrator",
      ownerUserId,
      ...orchestratorMemory
    };
    const invocationContext = this.buildInvocationContext(input.run, input.node, input.currentEvent);
    const workspaceFileIndex = await buildWorkspaceFileIndex(conversation?.workspace?.rootPath);
    const runWorkingMemoryPack = {
      runId: input.run.id,
      currentNode: input.node,
      goal: input.run.goal,
      status: input.run.status,
      runMeta: input.run.runMeta ?? {},
      understanding: input.run.understanding ?? null,
      workItems: input.run.workItems ?? [],
      agentRuns: input.run.agentRuns ?? [],
      toolRuns: input.run.toolRuns ?? [],
      uiInteractions: input.run.uiInteractions ?? [],
      outputs: input.run.outputs ?? [],
      blockers: input.run.blockers ?? [],
      relatedEdgeHistory: selectRelatedEdgeHistory(input.run.edgeHistory, input.node)
    };
    const trigger = {
      messageId: input.triggerMessageId,
      currentEvent: input.currentEvent ?? null
    };
    const workspaceIndexSummary = {
      workspace: conversation?.workspace
        ? {
            id: conversation.workspace.id,
            rootPath: conversation.workspace.rootPath,
            gitRepoPath: conversation.workspace.gitRepoPath
          }
        : null,
      fileTree: workspaceFileIndex,
      assets: assets.map(toWorkspaceAssetDigest)
    };
    const assignableAgents = agents.filter((agent) =>
      agent.type !== "orchestrator" &&
      agent.type !== "review" &&
      isAgentAvailableInConversation(conversation, agent.id)
    );
    const agentDispatchMemoryViews = await this.buildAgentDispatchMemoryViews(input.conversationId, ownerUserId, assignableAgents);
    const availableAgents = assignableAgents.map((agent) => ({
      id: agent.id,
      name: agent.name,
      type: agent.type,
      provider: agent.provider,
      description: agent.description,
      capabilities: agent.capabilities,
      dispatchMemoryView: agentDispatchMemoryViews.get(agent.id) ?? normalizeAgentDispatchMemoryView(agent.id, null, [])
    }));
    const availableTools = executableRuntimeToolRegistry;
    const budgeted = budgetContextSections({
      invocationContext,
      orchestratorMemoryPack,
      longTermMemoryPack,
      codeExecutionMemory,
      runWorkingMemoryPack,
      trigger,
      recentMessageDigests,
      workspaceIndexSummary,
      availableAgents,
      availableTools
    });
    return {
      node: input.node,
      contextBudget: budgeted.report,
      invocationContext: budgeted.sections.invocationContext,
      orchestratorMemoryPack: budgeted.sections.orchestratorMemoryPack,
      longTermMemoryPack: budgeted.sections.longTermMemoryPack,
      codeExecutionMemory: budgeted.sections.codeExecutionMemory,
      runWorkingMemoryPack: budgeted.sections.runWorkingMemoryPack,
      trigger: budgeted.sections.trigger,
      recentMessageDigests: budgeted.sections.recentMessageDigests,
      workspaceIndexSummary: budgeted.sections.workspaceIndexSummary,
      availableInterfaces: {
        agents: budgeted.sections.availableAgents,
        tools: budgeted.sections.availableTools,
        messageActions: ["reply", "quote", "comment", "like", "pin"],
        agentSelectionPolicy: "Only assign agents listed in this conversation's availableInterfaces.agents. Do not assign global agents that are not members of this conversation."
      }
    };
  }

  async buildDirectAgentContext(input: BuildDirectAgentContextInput) {
    const [nodeContext, agentMemoryPack] = await Promise.all([
      this.buildNodeContext({
        conversationId: input.conversationId,
        triggerMessageId: input.triggerMessage.id,
        node: "assignment",
        run: {
          id: `direct-${input.conversationId}`,
          conversationId: input.conversationId,
          goal: extractMessageText(input.triggerMessage),
          status: "running",
          currentNode: "assignment",
          startedAt: new Date().toISOString(),
          nodes: [],
          edges: [],
          edgeHistory: []
        }
      }),
      this.buildAgentMemoryPack(input)
    ]);
    return {
      ...nodeContext,
      directAgent: {
        agentId: input.agentId,
        userId: input.userId,
        triggerMessage: input.triggerMessage,
        ...agentMemoryPack
      }
    };
  }

  async buildAgentMemoryPack(input: BuildAgentMemoryPackInput) {
    const conversation = await this.prisma.conversation.findFirst({
      where: { id: input.conversationId, deletedAt: null },
      select: { type: true }
    });
    const includePersonalCrossConversation = conversation?.type !== "project";
    const memoryScopes = includePersonalCrossConversation
      ? [
          { scope: "personal_cross_conversation" as const, conversationId: null },
          { conversationId: input.conversationId }
        ]
      : [{ conversationId: input.conversationId }];
    const agentMemories = await this.prisma.agentMemory.findMany({
      where: {
        agentId: input.agentId,
        ownerUserId: input.userId,
        deletedAt: null,
        OR: memoryScopes
      },
      orderBy: { updatedAt: "desc" }
    });
    return {
      personalAgentMemory: includePersonalCrossConversation
        ? agentMemories.find((memory) => memory.scope === "personal_cross_conversation")?.memory ?? null
        : null,
      conversationAgentMemory: agentMemories.find((memory) => memory.conversationId === input.conversationId)?.memory ?? null,
      dispatchMemoryView: normalizeAgentDispatchMemoryView(
        input.agentId,
        asRecord(agentMemories.find((memory) => memory.conversationId === input.conversationId)?.memory),
        []
      )
    };
  }

  private async buildAgentDispatchMemoryViews(
    conversationId: string,
    ownerUserId: string,
    agents: Array<{ id: string }>
  ) {
    const agentIds = agents.map((agent) => agent.id);
    if (agentIds.length === 0) return new Map<string, unknown>();
    const [memories, runningRuns] = await Promise.all([
      this.prisma.agentMemory.findMany({
        where: {
          agentId: { in: agentIds },
          ownerUserId,
          scope: "conversation",
          conversationId,
          deletedAt: null
        },
        orderBy: { updatedAt: "desc" }
      }),
      this.prisma.agentRun.findMany({
        where: {
          agentId: { in: agentIds },
          status: "running",
          deletedAt: null,
          run: {
            conversationId,
            deletedAt: null
          }
        },
        select: {
          id: true,
          agentId: true,
          startedAt: true
        }
      })
    ]);
    const memoryByAgent = new Map<string, Record<string, unknown>>();
    for (const memory of memories) {
      if (!memoryByAgent.has(memory.agentId)) memoryByAgent.set(memory.agentId, asRecord(memory.memory) ?? {});
    }
    const runningByAgent = new Map<string, Array<{ id: string; startedAt: Date }>>();
    for (const run of runningRuns) {
      runningByAgent.set(run.agentId, [...(runningByAgent.get(run.agentId) ?? []), { id: run.id, startedAt: run.startedAt }]);
    }
    return new Map(agentIds.map((agentId) => [
      agentId,
      normalizeAgentDispatchMemoryView(agentId, memoryByAgent.get(agentId) ?? null, runningByAgent.get(agentId) ?? [])
    ]));
  }

  private buildInvocationContext(run: { edgeHistory?: unknown }, node: OrchestratorNode, currentEvent?: Record<string, unknown>) {
    const edges = Array.isArray(run.edgeHistory) ? run.edgeHistory as Array<Record<string, unknown>> : [];
    const latestIncoming = [...edges].reverse().find((edge) => edge.target === node);
    return {
      invokedNode: node,
      invokedBy: latestIncoming?.source ?? "runtime",
      reason: latestIncoming?.reason ?? "runtime scheduled this node",
      currentEvent: currentEvent ?? null
    };
  }
}

function normalizeConversationMemory(
  value: unknown,
  conversation: { id: string; title: string; type: string; workspaceId: string | null; codeAgentId?: string | null } | null,
  recentMessages: unknown[]
) {
  const base = asRecord(value) ?? {};
  const chatMemory = asRecord(base.chatMemory) ?? {};
  return {
    meta: {
      conversationId: conversation?.id ?? "",
      workspaceId: conversation?.workspaceId ?? null,
      version: typeof base.version === "number" ? base.version : 1,
      updatedAt: typeof base.updatedAt === "string" ? base.updatedAt : new Date().toISOString()
    },
    projectCore: {
      basicInfo: {
        conversationId: conversation?.id ?? "",
        workspaceId: conversation?.workspaceId ?? null,
        name: conversation?.title ?? ""
      },
      ...(asRecord(base.projectCore) ?? {})
    },
    chatMemory: {
      earlyCompressed: chatMemory.earlyCompressed ?? "",
      recentMessages,
      pinMessages: Array.isArray(chatMemory.pinMessages) ? chatMemory.pinMessages : base.pinnedMessages ?? [],
      messageFileIndex: Array.isArray(chatMemory.messageFileIndex) ? chatMemory.messageFileIndex : [],
      workspaceFileChanges: Array.isArray(chatMemory.workspaceFileChanges) ? chatMemory.workspaceFileChanges : []
    },
    taskBriefs: Array.isArray(base.taskBriefs) ? base.taskBriefs : [],
    codeExecutionMemory: normalizeCodeExecutionMemory(base.codeExecutionMemory, conversation),
    preferences: asRecord(base.preferences) ?? {},
    openQuestions: Array.isArray(base.openQuestions) ? base.openQuestions : []
  };
}

function normalizeCodeExecutionMemory(value: unknown, conversation: { codeAgentId?: string | null } | null) {
  const base = asRecord(value) ?? {};
  return {
    kind: "code_history_execution_records",
    lockedCodeAgentId: typeof base.lockedCodeAgentId === "string" ? base.lockedCodeAgentId : conversation?.codeAgentId ?? null,
    provider: typeof base.provider === "string" ? base.provider : null,
    latestSummary: typeof base.latestSummary === "string" ? base.latestSummary : "",
    executions: Array.isArray(base.executions) ? base.executions.slice(-40) : [],
    updatedAt: typeof base.updatedAt === "string" ? base.updatedAt : null
  };
}

function normalizeAgentDispatchMemoryView(
  agentId: string,
  memory: Record<string, unknown> | null,
  runningRuns: Array<{ id: string; startedAt: Date }>
) {
  const view = asRecord(memory?.dispatchMemoryView) ?? {};
  const recentBriefs = recordList(view.recentBriefs).length > 0
    ? recordList(view.recentBriefs).slice(-6)
    : recordList(memory?.recentRunBriefs).slice(-6).map(toDispatchBriefDigest);
  const currentOpenLoops = recordList(view.currentOpenLoops).slice(-8);
  const lastSuccessfulTasks = recordList(view.lastSuccessfulTasks).slice(-8);
  const lastFailedTasks = recordList(view.lastFailedTasks).slice(-8);
  return {
    agentId,
    recentBriefs,
    currentOpenLoops,
    lastSuccessfulTasks,
    lastFailedTasks,
    qualitySummary: asRecord(view.qualitySummary) ?? {
      totalRecentRuns: recentBriefs.length,
      passedRecentRuns: lastSuccessfulTasks.length,
      failedRecentRuns: lastFailedTasks.length,
      openLoops: currentOpenLoops.length,
      updatedAt: typeof memory?.updatedAt === "string" ? memory.updatedAt : null
    },
    memoryDigest: typeof view.memoryDigest === "string" ? view.memoryDigest : "",
    busyState: {
      running: runningRuns.length > 0,
      runningCount: runningRuns.length,
      runningAgentRunIds: runningRuns.map((run) => run.id),
      oldestStartedAt: runningRuns.map((run) => run.startedAt.toISOString()).sort()[0] ?? null
    },
    updatedAt: typeof view.updatedAt === "string" ? view.updatedAt : typeof memory?.updatedAt === "string" ? memory.updatedAt : null
  };
}

function recordList(value: unknown) {
  return (Array.isArray(value) ? value : [])
    .map(asRecord)
    .filter((item): item is Record<string, unknown> => Boolean(item));
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

function budgetContextSections(input: {
  invocationContext: unknown;
  orchestratorMemoryPack: unknown;
  longTermMemoryPack: unknown;
  codeExecutionMemory: unknown;
  runWorkingMemoryPack: unknown;
  trigger: unknown;
  recentMessageDigests: unknown;
  workspaceIndexSummary: unknown;
  availableAgents: unknown;
  availableTools: unknown;
}) {
  const sections = {
    invocationContext: budgetSection(input.invocationContext, SECTION_TOKEN_BUDGETS.invocationContext),
    orchestratorMemoryPack: budgetSection(input.orchestratorMemoryPack, SECTION_TOKEN_BUDGETS.orchestratorMemoryPack),
    longTermMemoryPack: budgetSection(input.longTermMemoryPack, SECTION_TOKEN_BUDGETS.longTermMemoryPack),
    codeExecutionMemory: budgetSection(input.codeExecutionMemory, SECTION_TOKEN_BUDGETS.codeExecutionMemory),
    runWorkingMemoryPack: budgetSection(input.runWorkingMemoryPack, SECTION_TOKEN_BUDGETS.runWorkingMemoryPack),
    trigger: budgetSection(input.trigger, SECTION_TOKEN_BUDGETS.trigger),
    recentMessageDigests: budgetSection(input.recentMessageDigests, SECTION_TOKEN_BUDGETS.recentMessageDigests),
    workspaceIndexSummary: budgetSection(input.workspaceIndexSummary, SECTION_TOKEN_BUDGETS.workspaceIndexSummary),
    availableAgents: budgetSection(input.availableAgents, SECTION_TOKEN_BUDGETS.availableAgents),
    availableTools: budgetSection(input.availableTools, SECTION_TOKEN_BUDGETS.availableTools)
  };
  const reportSections = Object.fromEntries(Object.entries(sections).map(([key, section]) => [key, section.report]));
  return {
    sections: Object.fromEntries(Object.entries(sections).map(([key, section]) => [key, section.value])) as {
      [K in keyof typeof sections]: (typeof sections)[K]["value"];
    },
    report: {
      totalBudgetTokens: Object.values(SECTION_TOKEN_BUDGETS).reduce((sum, value) => sum + value, 0),
      totalEstimatedTokens: Object.values(sections).reduce((sum, section) => sum + section.report.estimatedTokens, 0),
      sections: reportSections
    }
  };
}

function resolveContextOwnerUserId(
  conversation: { type?: string; members?: Array<{ memberType: string; memberId: string; role: string; deletedAt?: Date | null }> } | null,
  triggerRow: { senderType: string; senderId: string } | null
) {
  if (conversation?.type === "project") return "project";
  if (triggerRow?.senderType === "user" && triggerRow.senderId) return triggerRow.senderId;
  const owner = conversation?.members?.find((member) => member.memberType === "user" && member.role === "owner" && !member.deletedAt);
  return owner?.memberId ?? "project";
}

function isAgentAvailableInConversation(
  conversation: { type?: string; members?: Array<{ memberType: string; memberId: string; deletedAt?: Date | null }> } | null,
  agentId: string
) {
  if (conversation?.type !== "project") return true;
  return Boolean(conversation.members?.some((member) =>
    member.memberType === "agent" &&
    member.memberId === agentId &&
    !member.deletedAt
  ));
}

function budgetSection(value: unknown, budgetTokens: number) {
  let trimmed = trimToBudget(value, budgetTokens);
  if (estimateTokens(trimmed.value) > budgetTokens) {
    trimmed = trimToBudget(trimmed.value, Math.max(8, budgetTokens - 96));
  }
  let sectionValue = trimmed.value;
  if (estimateTokens(sectionValue) > budgetTokens) sectionValue = "[section truncated to token budget]";
  const estimatedTokens = estimateTokens(sectionValue);
  return {
    value: sectionValue,
    report: {
      budgetTokens,
      estimatedTokens,
      truncated: trimmed.truncated || estimatedTokens > budgetTokens
    }
  };
}

function trimToBudget(value: unknown, budgetTokens: number): { value: unknown; truncated: boolean } {
  if (estimateTokens(value) <= budgetTokens) return { value, truncated: false };
  if (budgetTokens <= 8) return { value: "[truncated]", truncated: true };
  if (typeof value === "string") return { value: truncateString(value, budgetTokens), truncated: true };
  if (Array.isArray(value)) return trimArrayToBudget(value, budgetTokens);
  const record = asRecord(value);
  if (!record) return { value: String(value).slice(0, budgetTokens * 4), truncated: true };
  const entries = Object.entries(record);
  const result: Record<string, unknown> = {};
  let truncated = false;
  for (let index = 0; index < entries.length; index += 1) {
    const [key, entryValue] = entries[index]!;
    const remainingKeys = entries.length - index;
    const used = estimateTokens(result);
    const remainingBudget = budgetTokens - used;
    if (remainingBudget <= 12) {
      result[key] = "[truncated]";
      truncated = true;
      continue;
    }
    const fieldBudget = Math.max(24, Math.floor(remainingBudget / remainingKeys));
    const trimmed = trimToBudget(entryValue, fieldBudget);
    result[key] = trimmed.value;
    truncated ||= trimmed.truncated;
  }
  return estimateTokens(result) <= budgetTokens ? { value: result, truncated: true } : trimToBudget(JSON.stringify(result), budgetTokens);
}

function trimArrayToBudget(values: unknown[], budgetTokens: number) {
  const result: unknown[] = [];
  let truncated = false;
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const remainingBudget = budgetTokens - estimateTokens(result);
    if (remainingBudget <= 12) {
      truncated = true;
      break;
    }
    const item = trimToBudget(values[index], remainingBudget);
    const next = [item.value, ...result];
    if (estimateTokens(next) > budgetTokens) {
      truncated = true;
      break;
    }
    result.unshift(item.value);
    truncated ||= item.truncated;
  }
  return { value: result, truncated: truncated || result.length < values.length };
}

function estimateTokens(value: unknown) {
  return Math.ceil(JSON.stringify(value ?? null).length / 4);
}

function truncateString(value: string, budgetTokens: number) {
  const maxChars = Math.max(0, budgetTokens * 4 - 32);
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}...[truncated]`;
}

async function buildWorkspaceFileIndex(rootPath?: string | null) {
  if (!rootPath) return { scanned: false, reason: "no_workspace" };
  const workspaceRoot = rootPath;
  const files: Array<{ path: string; size: number }> = [];
  const directories: string[] = [];
  let truncated = false;

  async function walk(directoryPath: string, depth: number): Promise<void> {
    if (files.length >= WORKSPACE_FILE_INDEX_MAX_FILES) {
      truncated = true;
      return;
    }
    let entries: Dirent<string>[];
    try {
      entries = await readdir(directoryPath, { withFileTypes: true });
    } catch {
      truncated = true;
      return;
    }
    entries.sort((left, right) => compareWorkspaceEntriesForScan(workspaceRoot, directoryPath, left, right));
    for (const entry of entries) {
      if (entry.name === ".DS_Store") continue;
      const absolutePath = join(directoryPath, entry.name);
      const relativePath = normalizeWorkspaceIndexPath(workspaceRoot, absolutePath);
      if (entry.isDirectory()) {
        if (WORKSPACE_FILE_INDEX_IGNORED_DIRS.has(entry.name)) continue;
        directories.push(relativePath);
        if (depth < WORKSPACE_FILE_INDEX_MAX_DEPTH) await walk(absolutePath, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const fileStat = await stat(absolutePath).catch(() => null);
      if (!fileStat?.isFile()) continue;
      files.push({ path: relativePath, size: fileStat.size });
      if (files.length >= WORKSPACE_FILE_INDEX_MAX_FILES) {
        truncated = true;
        break;
      }
    }
  }

  const rootStat = await stat(workspaceRoot).catch(() => null);
  if (!rootStat?.isDirectory()) return { scanned: false, reason: "workspace_root_missing", files: [], directories: [] };
  await walk(workspaceRoot, 1);
  files.sort(compareWorkspaceFilesForContext);
  return {
    scanned: true,
    depth: WORKSPACE_FILE_INDEX_MAX_DEPTH,
    ignoredDirectories: Array.from(WORKSPACE_FILE_INDEX_IGNORED_DIRS).sort(),
    directories: directories.slice(0, 40),
    files,
    truncated: truncated || directories.length > 40
  };
}

function normalizeWorkspaceIndexPath(rootPath: string, absolutePath: string) {
  return relative(rootPath, absolutePath).split("\\").join("/");
}

function compareWorkspaceFilesForContext(left: { path: string }, right: { path: string }) {
  const leftPriority = workspaceFileContextPriority(left.path);
  const rightPriority = workspaceFileContextPriority(right.path);
  if (leftPriority !== rightPriority) return rightPriority - leftPriority;
  return left.path.localeCompare(right.path);
}

function compareWorkspaceEntriesForScan(rootPath: string, directoryPath: string, left: Dirent<string>, right: Dirent<string>) {
  const leftPath = normalizeWorkspaceIndexPath(rootPath, join(directoryPath, left.name));
  const rightPath = normalizeWorkspaceIndexPath(rootPath, join(directoryPath, right.name));
  const leftPriority = workspaceEntryScanPriority(left, leftPath);
  const rightPriority = workspaceEntryScanPriority(right, rightPath);
  if (leftPriority !== rightPriority) return leftPriority - rightPriority;
  return left.name.localeCompare(right.name);
}

function workspaceEntryScanPriority(entry: Dirent<string>, entryPath: string) {
  if (entry.isFile()) return workspaceFileContextPriority(entryPath);
  const normalized = entryPath.toLowerCase();
  if (isPrimaryCodeDirectory(normalized)) return 0;
  if (isLowPriorityWorkspacePath(normalized)) return 3;
  return 1;
}

function workspaceFileContextPriority(filePath: string) {
  const normalized = filePath.toLowerCase();
  if (
    normalized.endsWith(".html") ||
    normalized.endsWith(".css") ||
    normalized.endsWith(".js") ||
    normalized.endsWith(".ts") ||
    normalized.endsWith(".tsx") ||
    normalized.endsWith(".jsx") ||
    normalized.endsWith(".json")
  ) {
    return 0;
  }
  if (isLowPriorityWorkspacePath(normalized)) return 3;
  return 1;
}

function isPrimaryCodeDirectory(path: string) {
  return /(^|\/)(app|components|css|js|pages|src)(\/|$)/.test(path);
}

function isLowPriorityWorkspacePath(path: string) {
  return path.startsWith("uploads/") || path.startsWith("docs/") || path.startsWith("skills/");
}

function summarizeChatMessageForContext(
  message: ChatMessage,
  assetById: Map<string, { id: string; kind: string; name: string; path: string; mimeType: string | null; size: number | null; summary: string | null }>
) {
  const textParts: string[] = [];
  const attachments: unknown[] = [];
  for (const block of message.blocks) {
    const summary = summarizeBlockForContext(block, assetById);
    if (summary.text) textParts.push(summary.text);
    if (summary.attachment) attachments.push(summary.attachment);
  }
  return {
    id: message.id,
    sender: {
      type: message.sender.type,
      id: message.sender.id,
      name: message.sender.name
    },
    createdAt: message.createdAt,
    text: textParts.join("\n").trim(),
    attachments,
    mentions: message.mentions ?? []
  };
}

function summarizeBlockForContext(
  block: MessageBlock,
  assetById: Map<string, { id: string; kind: string; name: string; path: string; mimeType: string | null; size: number | null; summary: string | null }>
) {
  if (block.type === "markdown") return { text: block.payload.text };
  if (block.type === "code") {
    return {
      text: `代码块 ${block.payload.filename ?? ""} ${block.payload.language}: ${summarizeText(block.payload.code, 600)}`
    };
  }
  if (block.type === "image") {
    const asset = assetById.get(block.payload.assetId);
    return {
      attachment: {
        type: "image",
        assetId: block.payload.assetId,
        alt: block.payload.alt ?? "",
        digest: asset ? toWorkspaceAssetDigest(asset) : { modality: "image", summary: "图片附件，未找到资产元数据", extractionStatus: "metadata_missing" }
      }
    };
  }
  if (block.type === "file") {
    const asset = assetById.get(block.payload.assetId);
    return {
	      attachment: {
	        type: "file",
	        assetId: block.payload.assetId,
	        name: block.payload.name,
	        path: block.payload.path ?? asset?.path,
	        mimeType: block.payload.mimeType,
	        size: block.payload.size,
	        summary: block.payload.summary ?? "",
	        digest: asset ? toWorkspaceAssetDigest(asset) : fileDigest(block.payload.name, block.payload.mimeType, block.payload.size, block.payload.summary)
	      }
    };
  }
  if (block.type === "web_preview") {
    return {
      attachment: {
        type: "web_preview",
        assetId: block.payload.assetId,
        title: block.payload.title,
        url: block.payload.url,
        status: block.payload.status,
        screenshotAssetId: block.payload.screenshotAssetId,
        extractionStatus: block.payload.status === "ready" ? "metadata_ready" : block.payload.status
      }
    };
  }
  if (block.type === "diff") {
    const additions = block.payload.files.reduce((sum, file) => sum + file.additions, 0);
    const deletions = block.payload.files.reduce((sum, file) => sum + file.deletions, 0);
    return {
      attachment: {
        type: "diff",
        assetId: block.payload.diffAssetId,
        title: block.payload.title,
        reviewState: block.payload.reviewState,
        fileCount: block.payload.files.length,
        additions,
        deletions,
        files: block.payload.files.slice(0, 20).map((file) => ({
          path: file.path,
          additions: file.additions,
          deletions: file.deletions,
          hunkCount: file.hunks.length
        })),
        extractionStatus: "diff_stats_ready"
      }
    };
  }
  if (block.type === "agent_status") {
    return { text: `Agent 状态：${block.payload.title} ${block.payload.status}${block.payload.summary ? `，${block.payload.summary}` : ""}` };
  }
  if (block.type === "deploy_status") {
    return { text: `部署状态：${block.payload.title} ${block.payload.status}${block.payload.detail ? `，${block.payload.detail}` : ""}` };
  }
  return { text: "消息块" };
}

function toWorkspaceAssetDigest(asset: { id: string; kind: string; name: string; path: string; mimeType: string | null; size: number | null; summary: string | null }) {
  return {
    id: asset.id,
    kind: asset.kind,
    modality: assetModality(asset),
    name: asset.name,
    path: asset.path,
    mimeType: asset.mimeType ?? "application/octet-stream",
    size: asset.size ?? undefined,
    summary: asset.summary ?? "",
    extractionStatus: assetExtractionStatus(asset)
  };
}

function fileDigest(name: string, mimeType: string, size?: number, summary?: string) {
  return {
    modality: assetModality({ kind: "file", name, mimeType, summary: summary ?? null }),
    name,
    mimeType,
    size,
    summary: summary ?? "",
    extractionStatus: extractionStatusForMime(mimeType)
  };
}

function assetModality(asset: { kind: string; name: string; mimeType: string | null; summary: string | null }) {
  const mimeType = (asset.mimeType ?? "").toLowerCase();
  const name = asset.name.toLowerCase();
  if (asset.kind === "image" || mimeType.startsWith("image/")) return "image";
  if (asset.kind === "web" || mimeType === "text/html") return "web";
  if (asset.kind === "diff" || mimeType.includes("diff") || name.endsWith(".patch")) return "diff";
  if (mimeType === "application/pdf" || name.endsWith(".pdf")) return "pdf";
  if (mimeType.includes("word") || name.endsWith(".doc") || name.endsWith(".docx")) return "word";
  if (asset.kind === "doc") return "document";
  if (mimeType.startsWith("text/") || mimeType.includes("json")) return "text";
  return "binary";
}

function assetExtractionStatus(asset: { kind: string; name: string; mimeType: string | null; summary: string | null }) {
  return extractionStatusForMime(asset.mimeType ?? "", asset.kind, asset.name, asset.summary ?? "");
}

function extractionStatusForMime(mimeType: string, kind = "file", name = "", summary = "") {
  const modality = assetModality({ kind, name, mimeType, summary });
  if (["text", "diff", "web"].includes(modality) && summary) return "summary_ready";
  if (["pdf", "word", "image"].includes(modality)) return summary ? "metadata_summary_ready" : "metadata_only";
  return summary ? "summary_ready" : "metadata_only";
}

function summarizeText(value: string, limit: number) {
  return value.replace(/\s+/g, " ").trim().slice(0, limit);
}

function selectRelatedEdgeHistory(value: unknown, node: OrchestratorNode) {
  if (!Array.isArray(value)) return [];
  return value.filter((edge) => {
    const item = asRecord(edge);
    if (!item) return false;
    return item.source === node || item.target === node || item.chain === "assignment-validation";
  });
}

function extractMessageText(message: ChatMessage) {
  return message.blocks.map((block) => (block.type === "markdown" ? block.payload.text : block.type)).join("\n").trim();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}
