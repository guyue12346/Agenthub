import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import { nanoid } from "nanoid";
import type { ChatMessage } from "@agenthub/shared";
import { Prisma, type Agent } from "../../generated/prisma/client.js";
import { PrismaService } from "../../common/prisma.service.js";
import { LlmService } from "./llm.service.js";
import { ContextManagerService } from "./context-manager.service.js";
import { MemoryManagerService } from "./memory-manager.service.js";
import { ToolRuntimeService, type RuntimeToolApprovalResume, type RuntimeToolRequest, type RuntimeToolResult } from "./tool-runtime.service.js";
import { executableRuntimeToolRegistry, publicToolHubToolIds, type ToolDefinitionView } from "../tools/tool-registry.js";

export interface RuntimeAgentIdentity {
  id: string;
  name: string;
  avatar: string;
  role: string;
  type: "internal" | "code";
  provider?: string | null;
  capabilities?: unknown;
}

export interface RuntimeAgentResult {
  publicMessage: string;
  resultSummary: string;
  status: "completed" | "needs_clarification" | "failed";
  internalTraceRef?: string;
  memoryPatch?: Record<string, unknown>;
  createdAssets?: RuntimeAgentCreatedAsset[];
}

export interface RuntimeAgentCreatedAsset {
  assetId: string;
  workspaceId: string;
  name: string;
  path: string;
  mimeType: string;
  size?: number;
  summary?: string;
}

export interface AgentToolApprovalResumeState extends RuntimeToolApprovalResume {
  schemaVersion: "agent-tool-approval-resume.v1";
  mode: "assignment" | "direct";
  runId?: string;
  agentRunId?: string;
  conversationId: string;
  agent: RuntimeAgentIdentity;
  task: unknown;
  context: unknown;
  ownerUserId: string;
  traceId: string;
  toolResults: RuntimeToolResult[];
  nextStepIndex: number;
  requestedToolId: string;
}

interface AgentRuntimeProfile {
  custom: boolean;
  runtime: {
    workflowTemplate: string;
    maxToolSteps: number;
    maxRunSeconds: number;
  };
  collaboration: {
    orchestratorCallable: boolean;
    dispatchTags: string[];
    assignmentDescription?: string;
    acknowledgeOnAssignment: boolean;
  };
  workspace: {
    docRead: boolean;
    docWrite: boolean;
    codeRead: boolean;
    codeWrite: boolean;
    assetCreate: boolean;
  };
  model: {
    provider?: string;
    model?: string;
    reasoningEffort?: string;
    streaming?: boolean;
    fallbackModel?: string;
  };
  prompt: {
    role?: string | undefined;
    goals: string[];
    behaviorRules: string[];
    outputRules: string[];
    refusalRules: string[];
  };
  skills: Array<{
    name: string;
    summary: string;
    path?: string;
    injectionMode?: string;
  }>;
  knowledge: Array<{
    knowledgeAssetId: string;
    name: string;
    summary: string;
    path?: string;
    retrievalMode: "query" | "rag";
    maxResults?: number;
  }>;
  tools: Array<{
    toolId: string;
    runtimeToolId?: string;
    name?: string;
    summary?: string;
    category?: string;
    risk?: string;
    runtimeType?: string;
    source?: string;
    metadata?: Record<string, unknown>;
    inputSchema?: Record<string, unknown>;
    outputSchema?: Record<string, unknown>;
    enabled: boolean;
  }>;
  permissions: {
    scopes: string[];
    requireApprovalFor: string[];
  };
  memory: Record<string, unknown>;
  output: Record<string, unknown>;
}

const toolRequestSchema = z.object({
  toolId: z.preprocess(stringishOrUndefined, z.string().min(1).max(160)),
  reason: z.preprocess(stringishOrUndefined, z.string().optional()),
  input: z.preprocess(recordOrEmpty, z.record(z.string(), z.unknown()).default({}))
});

const agentStepSchema = z.object({
  done: z.preprocess(booleanishOrUndefined, z.boolean().optional()),
  status: z.preprocess(normalizeAgentStatusInput, z.enum(["completed", "needs_clarification", "failed"]).default("completed")),
  publicMessage: z.preprocess(stringishOrUndefined, z.string().optional()),
  resultSummary: z.preprocess(stringishOrUndefined, z.string().optional()),
  toolRequests: z.preprocess(normalizeToolRequestsInput, z.array(toolRequestSchema).default([])),
  memoryPatch: z.preprocess(recordOrEmpty, z.record(z.string(), z.unknown()).default({}))
}).transform((step) => ({
  ...step,
  done: step.done ?? step.toolRequests.length === 0
}));

@Injectable()
export class AgentRuntimeService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(LlmService) private readonly llm: LlmService,
    @Inject(ContextManagerService) private readonly contextManager: ContextManagerService,
    @Inject(MemoryManagerService) private readonly memoryManager: MemoryManagerService,
    @Inject(ToolRuntimeService) private readonly toolRuntime: ToolRuntimeService
  ) {}

  async runAssignment(input: {
    runId: string;
    conversationId: string;
    assignment: Record<string, unknown>;
    agent: RuntimeAgentIdentity;
    context: unknown;
    ownerUserId: string;
    agentRunId?: string;
    signal?: AbortSignal;
  }): Promise<RuntimeAgentResult> {
    const agentMemoryPack = await this.contextManager.buildAgentMemoryPack({
      conversationId: input.conversationId,
      agentId: input.agent.id,
      userId: input.ownerUserId
    });
    const context = {
      ...(asRecord(input.context) ?? { assignmentContext: input.context }),
      assignmentAgent: {
        agentId: input.agent.id,
        ownerUserId: input.ownerUserId,
        ...agentMemoryPack
      }
    };
    const result = await this.runLoop({
      runId: input.runId,
      conversationId: input.conversationId,
      agent: input.agent,
      context,
      task: input.assignment,
      ownerUserId: input.ownerUserId,
      mode: "assignment",
      ...(input.agentRunId ? { agentRunId: input.agentRunId } : {}),
      ...(input.signal ? { signal: input.signal } : {})
    });
    if (!isRuntimeAgentWaitingForToolApproval(result)) {
      await this.memoryManager.writeAgentMemory({
        agentId: input.agent.id,
        ownerUserId: input.ownerUserId,
        conversationId: input.conversationId,
        scope: "conversation",
        memoryPatch: {
          lastProjectAssignmentAt: new Date().toISOString(),
          lastRunId: input.runId,
          lastAssignmentSummary: result.resultSummary,
          ...(result.memoryPatch ?? {}),
          updatedAt: new Date().toISOString()
        }
      });
    }
    return result;
  }

  async runDirect(input: {
    conversationId: string;
    agent: Agent;
    userId: string;
    triggerMessage: ChatMessage;
  }): Promise<RuntimeAgentResult> {
    const context = await this.contextManager.buildDirectAgentContext({
      conversationId: input.conversationId,
      agentId: input.agent.id,
      userId: input.userId,
      triggerMessage: input.triggerMessage
    });
    const result = await this.runLoop({
      conversationId: input.conversationId,
      agent: {
        id: input.agent.id,
        name: input.agent.name,
        avatar: input.agent.avatar ?? input.agent.name.slice(0, 2),
        role: input.agent.description,
        type: "internal",
        provider: input.agent.provider,
        capabilities: input.agent.capabilities
      },
      context,
      task: {
        userMessage: extractMessageText(input.triggerMessage),
        mode: "direct_agent_chat"
      },
      ownerUserId: input.userId,
      mode: "direct"
    });
    if (!isRuntimeAgentWaitingForToolApproval(result)) {
      const runtimeProfile = await this.loadAgentRuntimeProfile(input.agent.id, input.userId);
      const memoryPolicy = resolveDirectMemoryWritePolicy(runtimeProfile);
      if (memoryPolicy.writePersonalCrossConversation) {
        await this.memoryManager.writeAgentMemory({
          agentId: input.agent.id,
          ownerUserId: input.userId,
          scope: "personal_cross_conversation",
          memoryPatch: {
            lastDirectConversationAt: new Date().toISOString(),
            lastResultSummary: result.resultSummary,
            ...(result.memoryPatch ?? {})
          }
        });
      }
      if (memoryPolicy.writePersonalDirect) {
        await this.memoryManager.writeAgentMemory({
          agentId: input.agent.id,
          ownerUserId: input.userId,
          conversationId: input.conversationId,
          scope: "personal_direct",
          memoryPatch: {
            lastMessageSummary: result.resultSummary,
            updatedAt: new Date().toISOString()
          }
        });
      }
    }
    return result;
  }

  async resumeApprovedToolRun(toolRunId: string): Promise<{ output: RuntimeAgentResult; resumeState: AgentToolApprovalResumeState }> {
    const toolRun = await this.prisma.toolRun.findFirst({ where: { id: toolRunId, callerType: "agent", deletedAt: null } });
    if (!toolRun) throw new Error("tool run not found");
    if (toolRun.status === "queued" || toolRun.status === "running") throw new Error("tool run is not ready to resume");
    const resumeState = parseAgentToolApprovalResumeState(await this.toolRuntime.getApprovalResumeState(toolRunId));
    if (resumeState.agent.id !== toolRun.callerId) throw new Error("tool run resume state does not match caller agent");
    const approvedToolResult: RuntimeToolResult = {
      toolRunId: toolRun.id,
      toolId: toolRun.toolId,
      status: toolRun.status,
      ...(toolRun.output !== null && toolRun.output !== undefined ? { output: toolRun.output } : {}),
      ...(toolRun.error ? { error: toolRun.error } : {})
    };
    const output = await this.runLoop({
      conversationId: resumeState.conversationId,
      agent: resumeState.agent,
      context: resumeState.context,
      task: resumeState.task,
      ownerUserId: resumeState.ownerUserId,
      mode: resumeState.mode,
      traceId: resumeState.traceId,
      initialToolResults: [...resumeState.toolResults, approvedToolResult],
      startStepIndex: resumeState.nextStepIndex,
      ...(resumeState.runId ? { runId: resumeState.runId } : {}),
      ...(resumeState.agentRunId ? { agentRunId: resumeState.agentRunId } : {})
    });
    await this.writeResumeMemory(resumeState, output);
    return { output, resumeState };
  }

  private async runLoop(input: {
    runId?: string;
    conversationId: string;
    agent: RuntimeAgentIdentity;
    context: unknown;
    task: unknown;
    ownerUserId: string;
    mode: "assignment" | "direct";
    agentRunId?: string;
    traceId?: string;
    initialToolResults?: RuntimeToolResult[];
    startStepIndex?: number;
    signal?: AbortSignal;
  }) {
    const traceId = input.traceId ?? `agent-trace-${nanoid(10)}`;
    const runtimeProfile = await this.loadAgentRuntimeProfile(input.agent.id, input.ownerUserId);
    const availableTools = availableToolsForProfile(runtimeProfile);
    const allowedToolIds = new Set(availableTools.map((tool) => tool.id));
    const sanitizedContext = sanitizeAgentContext(input.context, availableTools);
    const ragKnowledge = runtimeProfile && (input.startStepIndex ?? 1) <= 1
      ? await this.prefetchRagKnowledge(input, runtimeProfile)
      : [];
    const agentContext = ragKnowledge.length > 0
      ? {
          ...(asRecord(sanitizedContext) ?? { providedContext: sanitizedContext }),
          ragKnowledge
        }
      : sanitizedContext;
    const maxToolSteps = runtimeProfile?.runtime.maxToolSteps ?? 4;
    const modelOverride = modelOverrideForProfile(runtimeProfile);
    const toolResults: RuntimeToolResult[] = [...(input.initialToolResults ?? [])];
    let lastStep: z.infer<typeof agentStepSchema> | undefined;
    const startStepIndex = Math.max(1, input.startStepIndex ?? 1);
    const finalStepLimit = Math.max(maxToolSteps, startStepIndex);
    for (let stepIndex = startStepIndex; stepIndex <= finalStepLimit; stepIndex += 1) {
      const step = await this.llm.generateJson<z.infer<typeof agentStepSchema>>({
        callerType: "child_agent",
        callerId: `${input.runId ?? "direct"}:${input.agent.id}:${stepIndex}`,
        schemaName: "agent_runtime_step",
        schema: agentStepSchema,
        systemPrompt: agentPrompt(input.agent, runtimeProfile, availableTools),
        ...(modelOverride ? { modelOverride } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
        userPrompt: JSON.stringify({
          task: input.task,
          context: agentContext,
          agentRuntimeConfig: runtimeProfile ? runtimeProfilePromptPayload(runtimeProfile) : undefined,
          availableInterfaces: {
            tools: availableTools
          },
          previousToolResults: toolResults,
          stepIndex
        }, null, 2)
      });
      lastStep = step;
      const normalizedToolRequests = normalizeToolRequestsInput(step.toolRequests) as RuntimeToolRequest[];
      const deniedToolRequests = normalizedToolRequests.filter((request) => !allowedToolIds.has(request.toolId));
      for (const request of deniedToolRequests) {
        toolResults.push({
          toolRunId: `tool-denied-${nanoid(8)}`,
          toolId: request.toolId,
          status: "failed",
          error: `Agent ${input.agent.name} is not authorized to use tool ${request.toolId}`
        });
      }
      const toolRequests = normalizedToolRequests.filter((request) => allowedToolIds.has(request.toolId));
      if (toolRequests.length > 0) {
        for (const request of toolRequests) {
          const toolInput = {
            ...(input.runId ? { runId: input.runId } : {}),
            conversationId: input.conversationId,
            callerType: "agent" as const,
            callerId: input.agent.id,
            request,
            ...(runtimeProfile?.workspace ? { workspacePolicy: runtimeProfile.workspace } : {})
          };
          const result = isToolApprovalRequired(request, runtimeProfile)
            ? await this.toolRuntime.queueApproval({
                ...toolInput,
                reason: request.reason ?? `${input.agent.name} 请求执行 ${request.toolId}`,
                resumeState: {
                  schemaVersion: "agent-tool-approval-resume.v1",
                  mode: input.mode,
                  ...(input.runId ? { runId: input.runId } : {}),
                  ...(input.agentRunId ? { agentRunId: input.agentRunId } : {}),
                  conversationId: input.conversationId,
                  agent: input.agent,
                  task: input.task,
                  context: agentContext,
                  ownerUserId: input.ownerUserId,
                  traceId,
                  toolResults,
                  nextStepIndex: stepIndex + 1,
                  requestedToolId: request.toolId
                }
              })
            : await this.toolRuntime.execute(toolInput);
          toolResults.push(result);
          if (result.status === "queued") {
            return {
              publicMessage: `${input.agent.name} 需要先获得批准才能执行 ${request.toolId}。请在右侧 Agent 状态面板审批后继续。`,
              resultSummary: `waiting for approval: ${request.toolId}`,
              status: "needs_clarification",
              internalTraceRef: traceId,
              memoryPatch: {
                ...step.memoryPatch,
                waitingToolApproval: {
                  toolRunId: result.toolRunId,
                  toolId: request.toolId,
                  conversationId: input.conversationId,
                  agentId: input.agent.id,
                  mode: input.mode,
                  ...(input.runId ? { runId: input.runId } : {}),
                  ...(input.agentRunId ? { agentRunId: input.agentRunId } : {})
                }
              }
            } satisfies RuntimeAgentResult;
          }
        }
        if (stepIndex < maxToolSteps) continue;
      }
      const createdAssets = collectCreatedAssets(toolResults);
      return {
        publicMessage: resolveAgentPublicMessage(step, input.agent.name),
        resultSummary: step.resultSummary ?? step.publicMessage ?? "completed",
        status: step.status,
        internalTraceRef: traceId,
        memoryPatch: step.memoryPatch,
        ...(createdAssets.length > 0 ? { createdAssets } : {})
      } satisfies RuntimeAgentResult;
    }
    const createdAssets = collectCreatedAssets(toolResults);
    return {
      publicMessage: lastStep?.publicMessage ?? `${input.agent.name} 已达到最大内部迭代次数，先返回当前结果。`,
      resultSummary: lastStep?.resultSummary ?? "agent loop stopped at max iterations",
      status: lastStep?.status ?? "needs_clarification",
      internalTraceRef: traceId,
      memoryPatch: lastStep?.memoryPatch ?? {},
      ...(createdAssets.length > 0 ? { createdAssets } : {})
    } satisfies RuntimeAgentResult;
  }

  private async prefetchRagKnowledge(
    input: {
      runId?: string;
      conversationId: string;
      agent: RuntimeAgentIdentity;
      task: unknown;
    },
    runtimeProfile: AgentRuntimeProfile
  ) {
    const bindings = runtimeProfile.knowledge.filter((binding) => binding.retrievalMode === "rag");
    if (bindings.length === 0) return [];
    const query = knowledgeQueryFromTask(input.task);
    const results = await Promise.all(bindings.map(async (binding) => {
      const result = await this.toolRuntime.execute({
        ...(input.runId ? { runId: input.runId } : {}),
        conversationId: input.conversationId,
        callerType: "agent",
        callerId: input.agent.id,
        request: {
          toolId: "search_knowledge",
          input: {
            knowledgeAssetId: binding.knowledgeAssetId,
            query,
            topK: binding.maxResults ?? 5,
            scoreThreshold: 0.55
          },
          reason: `RAG 强化：在 ${binding.name} 中检索本次任务所需上下文`
        },
        workspacePolicy: runtimeProfile.workspace
      });
      return {
        knowledgeAssetId: binding.knowledgeAssetId,
        name: binding.name,
        status: result.status,
        ...(result.status === "completed" ? { output: result.output } : { error: result.error ?? "知识检索失败" })
      };
    }));
    return results;
  }

  private async writeResumeMemory(resumeState: AgentToolApprovalResumeState, output: RuntimeAgentResult) {
    if (resumeState.mode === "direct") {
      const runtimeProfile = await this.loadAgentRuntimeProfile(resumeState.agent.id, resumeState.ownerUserId);
      const memoryPolicy = resolveDirectMemoryWritePolicy(runtimeProfile);
      if (memoryPolicy.writePersonalCrossConversation) {
        await this.memoryManager.writeAgentMemory({
          agentId: resumeState.agent.id,
          ownerUserId: resumeState.ownerUserId,
          scope: "personal_cross_conversation",
          memoryPatch: {
            lastDirectConversationAt: new Date().toISOString(),
            lastResultSummary: output.resultSummary,
            ...(output.memoryPatch ?? {})
          }
        });
      }
      if (memoryPolicy.writePersonalDirect) {
        await this.memoryManager.writeAgentMemory({
          agentId: resumeState.agent.id,
          ownerUserId: resumeState.ownerUserId,
          conversationId: resumeState.conversationId,
          scope: "personal_direct",
          memoryPatch: {
            lastMessageSummary: output.resultSummary,
            updatedAt: new Date().toISOString()
          }
        });
      }
      return;
    }
    await this.memoryManager.writeAgentMemory({
      agentId: resumeState.agent.id,
      ownerUserId: resumeState.ownerUserId,
      conversationId: resumeState.conversationId,
      scope: "conversation",
      memoryPatch: {
        lastProjectAssignmentAt: new Date().toISOString(),
        ...(resumeState.runId ? { lastRunId: resumeState.runId } : {}),
        lastAssignmentSummary: output.resultSummary,
        ...(output.memoryPatch ?? {}),
        updatedAt: new Date().toISOString()
      }
    });
  }

  private async loadAgentRuntimeProfile(agentId: string, ownerUserId?: string): Promise<AgentRuntimeProfile | undefined> {
    const latest = await this.prisma.agentVersion.findFirst({
      where: { agentId, deletedAt: null },
      orderBy: { createdAt: "desc" }
    });
    const config = asRecord(latest?.config);
    if (!config) return undefined;
    const profile = asRecord(config.profile);
    const prompt = asRecord(config.prompt);
    const runtime = asRecord(config.runtime);
    const collaboration = asRecord(config.collaboration);
    const workspace = asRecord(config.workspace);
    const model = asRecord(config.model);
    const custom = profile?.category === "custom";
    const assignmentDescription = stringishOrUndefined(collaboration?.assignmentDescription);
    const modelProvider = stringishOrUndefined(model?.provider);
    const modelName = stringishOrUndefined(model?.model);
    const reasoningEffort = stringishOrUndefined(model?.reasoningEffort);
    const fallbackModel = stringishOrUndefined(model?.fallbackModel);
    return {
      custom,
      runtime: {
        workflowTemplate: stringishOrUndefined(runtime?.workflowTemplate) ?? "tool_loop",
        maxToolSteps: clampInteger(runtime?.maxToolSteps, 4, 1, 12),
        maxRunSeconds: clampInteger(runtime?.maxRunSeconds, 180, 30, 1800)
      },
      collaboration: {
        orchestratorCallable: collaboration?.orchestratorCallable !== false,
        dispatchTags: normalizeStringArray(collaboration?.dispatchTags),
        ...(assignmentDescription ? { assignmentDescription } : {}),
        acknowledgeOnAssignment: collaboration?.acknowledgeOnAssignment !== false
      },
      workspace: {
        docRead: workspace?.docRead !== false,
        docWrite: workspace?.docWrite !== false,
        codeRead: workspace?.codeRead !== false,
        codeWrite: workspace?.codeWrite === true,
        assetCreate: workspace?.assetCreate !== false
      },
      model: {
        ...(modelProvider ? { provider: modelProvider } : {}),
        ...(modelName ? { model: modelName } : {}),
        ...(reasoningEffort ? { reasoningEffort } : {}),
        ...(typeof model?.streaming === "boolean" ? { streaming: model.streaming } : {}),
        ...(fallbackModel ? { fallbackModel } : {})
      },
      prompt: {
        role: stringishOrUndefined(prompt?.role),
        goals: normalizeStringArray(prompt?.goals),
        behaviorRules: normalizeStringArray(prompt?.behaviorRules),
        outputRules: normalizeStringArray(prompt?.outputRules),
        refusalRules: normalizeStringArray(prompt?.refusalRules)
      },
      skills: normalizeSkillBindings(config.skills),
      knowledge: normalizeKnowledgeBindings(config.knowledge),
      tools: await this.filterToolsForOwner(normalizeToolBindings(config.tools), ownerUserId),
      permissions: normalizePermissions(config.permissions),
      memory: recordOrEmpty(config.memory),
      output: recordOrEmpty(config.output)
    };
  }

  private async filterToolsForOwner(tools: AgentRuntimeProfile["tools"], ownerUserId?: string) {
    const guardedToolIds = tools
      .map((tool) => tool.toolId)
      .filter((toolId) => publicToolHubToolIds.has(toolId));
    if (guardedToolIds.length === 0 || !ownerUserId) return tools;
    const subscriptions = await this.prisma.hubSubscription.findMany({
      where: {
        kind: "tool",
        assetId: { in: guardedToolIds },
        ownerType: "user",
        ownerId: ownerUserId,
        status: { in: ["active", "forked"] },
        deletedAt: null
      },
      select: { assetId: true }
    });
    const installed = new Set(subscriptions.map((subscription) => subscription.assetId));
    return tools.filter((tool) => !publicToolHubToolIds.has(tool.toolId) || installed.has(tool.toolId));
  }
}

function agentPrompt(agent: RuntimeAgentIdentity, runtimeProfile: AgentRuntimeProfile | undefined, availableTools: ToolDefinitionView[]) {
  const lines = [
    `你是 ${agent.name}。`,
    `你的职责：${runtimeProfile?.prompt.role ?? agent.role}`,
    "你在一个真实项目协作群聊中工作，只负责完成分配给你的任务。",
    "你可以根据 availableInterfaces.tools 请求工具，但工具调用历史只用于你内部判断，最终不要把内部调用日志原样发给用户。",
    "只能请求 availableInterfaces.tools 中列出的工具 ID；不要臆造未列出的消息、命令、浏览器或审批工具。",
    "如果 previousToolResults 中已经有足够回答当前问题的 completed 工具结果，不要再次请求相同工具和相同查询，应直接基于已有结果输出最终答复。",
    "工作空间默认包含 Doc/ 和 Code/ 两个目录。你只能把自己生成的较长文档写入 Doc/ 目录，Code/ 由 Code Agent 使用。",
    "如果上下文中有 assignmentAgent 或 directAgent 的 personalAgentMemory / conversationAgentMemory，应把它作为已沉淀偏好、约束和历史经验使用。",
    "如果任务产出是较长的 PRD、设计文档、方案、规范或报告，优先用 write_file 或 create_asset 写入 Doc/*.md 或 Doc/子目录/*.md，再在 publicMessage 返回任务简报和文档相对路径。",
    "你的 publicMessage 不要重复粘贴长文档全文；文件写入成功后，消息系统会根据 assetId/path 自动追加可预览的文档卡片。",
    "只有工具返回成功的 assetId/path 后，才能声称已经创建、保存或生成文件；如果没有写入成功，就把关键正文直接写进 publicMessage。",
    "如果信息不足，可以返回 needs_clarification，并把需要用户补充的内容写进 publicMessage。",
    "输出 JSON：done、status、publicMessage、resultSummary、toolRequests、memoryPatch；done、toolRequests、memoryPatch 可省略，后端会使用默认值。"
  ];
  if (runtimeProfile?.prompt.goals.length) lines.push(`你的目标：${runtimeProfile.prompt.goals.join("；")}`);
  if (runtimeProfile?.prompt.behaviorRules.length) lines.push(`行为规则：${runtimeProfile.prompt.behaviorRules.join("；")}`);
  if (runtimeProfile?.prompt.outputRules.length) lines.push(`输出规则：${runtimeProfile.prompt.outputRules.join("；")}`);
  if (runtimeProfile?.prompt.refusalRules.length) lines.push(`拒绝或降级规则：${runtimeProfile.prompt.refusalRules.join("；")}`);
  if (runtimeProfile?.collaboration) {
    lines.push(`协作配置：可被 Orchestrator 调用=${runtimeProfile.collaboration.orchestratorCallable ? "是" : "否"}；分派标签=${runtimeProfile.collaboration.dispatchTags.join("、") || "无"}；被分派时${runtimeProfile.collaboration.acknowledgeOnAssignment ? "需要先简短确认收到" : "无需额外确认收到"}。`);
    if (runtimeProfile.collaboration.assignmentDescription) lines.push(`分派说明：${runtimeProfile.collaboration.assignmentDescription}`);
  }
  if (runtimeProfile?.workspace) {
    lines.push([
      "工作空间权限：",
      `Doc 读取=${runtimeProfile.workspace.docRead ? "允许" : "禁止"}`,
      `Doc 写入=${runtimeProfile.workspace.docWrite ? "允许" : "禁止"}`,
      `Code 读取=${runtimeProfile.workspace.codeRead ? "允许" : "禁止"}`,
      `Code 写入=${runtimeProfile.workspace.codeWrite ? "允许" : "禁止"}`,
      `Asset 创建=${runtimeProfile.workspace.assetCreate ? "允许" : "禁止"}`
    ].join("；"));
    if (!runtimeProfile.workspace.docWrite) lines.push("当前 Agent 未获得 Doc 写入权限，不能请求 write_file/create_asset 写入 Doc；长内容必须直接在 publicMessage 中简明输出。");
    if (!runtimeProfile.workspace.codeWrite) lines.push("当前 Agent 未获得 Code 写入权限，不能修改 Code/ 下代码；代码修改任务应交给唯一 Code Agent。");
  }
  if (runtimeProfile?.skills.length) {
    lines.push("你已绑定以下 Skills。你需要自行判断是否使用；如果用户明确要求使用某个 Skill，优先遵守。");
    runtimeProfile.skills.forEach((skill, index) => {
      lines.push(`${index + 1}. ${skill.name}：${skill.summary}${skill.path ? `（${skill.path}）` : ""}`);
    });
  }
  if (runtimeProfile?.knowledge.length) {
    lines.push("你已绑定以下知识资产。query 表示需要时主动调用 search_knowledge；rag 表示运行时已自动检索并把结果放入 context.ragKnowledge。");
    runtimeProfile.knowledge.forEach((item, index) => {
      lines.push(`${index + 1}. ${item.name}：knowledgeAssetId=${item.knowledgeAssetId}；模式=${item.retrievalMode}；${item.summary || "无摘要"}${item.path ? `（${item.path}）` : ""}`);
    });
    if (runtimeProfile.knowledge.some((item) => item.retrievalMode === "query")) {
      lines.push("当用户问题涉及 query 模式知识资产中的事实、规则或专有内容时，你必须先在 toolRequests 中真实调用 search_knowledge，再根据工具结果给出最终答复。");
      lines.push("调用 search_knowledge 时，必须使用上面对应的 knowledgeAssetId，并把当前问题写入 query。禁止只在 publicMessage 中声称“正在查询”却不发出工具请求。");
    }
  }
  if (runtimeProfile?.output) lines.push(`输出配置：${JSON.stringify(runtimeProfile.output)}`);
  if (runtimeProfile?.memory) lines.push(`记忆配置：${JSON.stringify(runtimeProfile.memory)}`);
  if (availableTools.length) {
    lines.push("本次允许使用的工具如下。调用 toolRequests 时必须使用 toolId；不要使用未列出的工具，也不要直接调用底层 runtimeToolId。");
    availableTools.forEach((tool, index) => {
      const metadata = asRecord(tool.metadata);
      const displayName = stringishOrUndefined(metadata?.displayName) ?? tool.name;
      const runtimeNote = tool.runtimeToolId && tool.runtimeToolId !== tool.id ? `；底层=${tool.runtimeToolId}` : "";
      const inputSchema = compactJsonForPrompt(tool.inputSchema, 900);
      lines.push(`${index + 1}. ${displayName}：toolId=${tool.id}${runtimeNote}；类型=${tool.runtimeType ?? "builtin"}；风险=${tool.risk}；说明=${tool.description}${inputSchema ? `；输入格式=${inputSchema}` : ""}`);
    });
  } else {
    lines.push("本次允许使用的工具：无");
  }
  return lines.join("\n");
}

function compactJsonForPrompt(value: unknown, maxLength: number) {
  if (!value) return "";
  try {
    const compact = JSON.stringify(value);
    if (!compact || compact === "{}") return "";
    return compact.length > maxLength ? `${compact.slice(0, maxLength)}...` : compact;
  } catch {
    return "";
  }
}

function availableToolsForProfile(profile: AgentRuntimeProfile | undefined) {
  if (!profile?.custom) return executableRuntimeToolRegistry;
  const runtimeById = new Map(executableRuntimeToolRegistry.map((tool) => [tool.id, tool]));
  const seen = new Set<string>();
  const tools: ToolDefinitionView[] = profile.tools.flatMap((binding) => {
    if (!binding.enabled) return [];
    const toolId = binding.toolId;
    const runtimeToolId = binding.runtimeToolId ?? toolId;
    if (seen.has(toolId) || !isToolAllowedByWorkspacePolicy(runtimeToolId, profile.workspace)) return [];
    const runtimeTool = runtimeById.get(runtimeToolId);
    const bindingMetadata = {
      ...(binding.metadata ?? {}),
      displayToolId: binding.toolId,
      ...(binding.name ? { displayName: binding.name } : {}),
      ...(binding.source ? { bindingSource: binding.source } : {})
    };
    const tool: ToolDefinitionView = runtimeTool ? {
      ...runtimeTool,
      id: toolId,
      runtimeToolId,
      runtimeType: binding.runtimeType ?? "builtin_alias",
      category: binding.category ?? runtimeTool.category,
      risk: normalizeToolRisk(binding.risk) ?? runtimeTool.risk,
      name: binding.name ?? runtimeTool.name,
      description: binding.summary ?? runtimeTool.description,
      metadata: {
        ...(asRecord(runtimeTool.metadata) ?? {}),
        ...bindingMetadata
      }
    } : {
      id: toolId,
      category: binding.category ?? "custom",
      name: binding.name ?? toolId,
      risk: normalizeToolRisk(binding.risk) ?? "read",
      description: binding.summary ?? "自定义 ToolHub 工具",
      runtimeType: binding.runtimeType ?? "function",
      source: binding.source ?? "user",
      visibility: "private",
      ownerType: "user",
      ...(binding.runtimeToolId ? { runtimeToolId: binding.runtimeToolId } : {}),
      metadata: bindingMetadata,
      executable: true,
      inputSchema: binding.inputSchema ?? {},
      outputSchema: binding.outputSchema ?? {},
      permissionScopes: [],
      requiresApproval: false,
      availableToAgentTypes: [],
      timeoutPolicy: "short",
      auditLevel: "full"
    };
    seen.add(toolId);
    return [tool];
  });
  if (profile.knowledge.some((binding) => binding.retrievalMode === "query") && !seen.has("search_knowledge")) {
    const searchTool = runtimeById.get("search_knowledge");
    if (searchTool && isToolAllowedByWorkspacePolicy("search_knowledge", profile.workspace)) {
      tools.push(searchTool);
    }
  }
  return tools;
}

function isToolAllowedByWorkspacePolicy(toolId: string, workspace: AgentRuntimeProfile["workspace"]) {
  if ((toolId === "list_files" || toolId === "search_files") && !workspace.docRead && !workspace.codeRead) return false;
  if ((toolId === "read_file" || toolId === "read_asset") && !workspace.docRead && !workspace.codeRead) return false;
  if (toolId === "write_file" && !workspace.docWrite) return false;
  if (toolId === "create_asset" && (!workspace.docWrite || !workspace.assetCreate)) return false;
  return true;
}

function runtimeProfilePromptPayload(profile: AgentRuntimeProfile) {
  return {
    runtime: profile.runtime,
    collaboration: profile.collaboration,
    workspace: profile.workspace,
    model: profile.model,
    prompt: profile.prompt,
    skills: profile.skills,
    knowledge: profile.knowledge,
    tools: profile.tools.filter((tool) => tool.enabled).map((tool) => ({
      toolId: tool.toolId,
      runtimeToolId: tool.runtimeToolId ?? tool.toolId,
      name: tool.name,
      category: tool.category,
      risk: tool.risk,
      runtimeType: tool.runtimeType,
      source: tool.source
    })),
    permissions: profile.permissions
  };
}

function modelOverrideForProfile(profile: AgentRuntimeProfile | undefined) {
  if (!profile?.custom) return undefined;
  const model = profile.model.model && profile.model.model !== "runtime_default" ? profile.model.model : undefined;
  const reasoningEffort = profile.model.reasoningEffort && profile.model.reasoningEffort !== "runtime_default" ? profile.model.reasoningEffort : undefined;
  if (!model && !reasoningEffort) return undefined;
  return {
    ...(model ? { model } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {})
  };
}

function resolveDirectMemoryWritePolicy(profile: AgentRuntimeProfile | undefined) {
  const memory = profile?.memory ?? {};
  const rawPolicy = stringishOrUndefined(memory.memoryPolicy ?? memory.scopePolicy ?? memory.policy)?.toLowerCase();
  const writeBackPolicy = stringishOrUndefined(memory.writeBackPolicy)?.toLowerCase();
  if (rawPolicy === "off" || rawPolicy === "none" || rawPolicy === "disabled") {
    return { writePersonalDirect: false, writePersonalCrossConversation: false };
  }
  if (writeBackPolicy === "off" || writeBackPolicy === "none" || writeBackPolicy === "disabled") {
    return { writePersonalDirect: false, writePersonalCrossConversation: false };
  }
  if (rawPolicy === "conversation_only" || rawPolicy === "direct_only") {
    return { writePersonalDirect: true, writePersonalCrossConversation: false };
  }
  if (rawPolicy === "personal_cross_conversation" || rawPolicy === "cross_conversation_only") {
    return { writePersonalDirect: false, writePersonalCrossConversation: true };
  }
  if (rawPolicy === "both" || rawPolicy === "all") {
    return { writePersonalDirect: true, writePersonalCrossConversation: true };
  }
  return {
    writePersonalDirect: memory.useConversationMemory !== false,
    writePersonalCrossConversation: memory.usePersonalCrossConversationMemory !== false
  };
}

function sanitizeAgentContext(context: unknown, availableTools: ToolDefinitionView[]) {
  const record = asRecord(context);
  if (!record) return context;
  const availableInterfaces = asRecord(record.availableInterfaces);
  if (!availableInterfaces) return context;
  return {
    ...record,
    availableInterfaces: {
      ...availableInterfaces,
      tools: availableTools
    }
  };
}

function normalizeStringArray(value: unknown) {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.flatMap((item) => {
    const text = stringishOrUndefined(item);
    return text ? [text] : [];
  })));
}

function normalizeSkillBindings(value: unknown): AgentRuntimeProfile["skills"] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const record = asRecord(item);
    if (!record || record.enabled === false) return [];
    const name = stringishOrUndefined(record.name);
    const summary = stringishOrUndefined(record.summary);
    if (!name && !summary) return [];
    const path = stringishOrUndefined(record.path);
    const injectionMode = stringishOrUndefined(record.injectionMode);
    return [{
      name: name ?? "Untitled Skill",
      summary: summary ?? "该 Skill 未提供摘要，请根据名称和路径谨慎使用。",
      ...(path ? { path } : {}),
      ...(injectionMode ? { injectionMode } : {})
    }];
  });
}

function normalizeKnowledgeBindings(value: unknown): AgentRuntimeProfile["knowledge"] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const record = asRecord(item);
    if (!record || record.enabled === false) return [];
    const knowledgeAssetId = stringishOrUndefined(record.knowledgeAssetId);
    const name = stringishOrUndefined(record.name);
    const summary = stringishOrUndefined(record.summary);
    if (!knowledgeAssetId || (!name && !summary)) return [];
    const path = stringishOrUndefined(record.path);
    const retrievalMode = stringishOrUndefined(record.retrievalMode);
    const maxResults = typeof record.maxResults === "number" && Number.isFinite(record.maxResults) ? Math.trunc(record.maxResults) : undefined;
    return [{
      knowledgeAssetId,
      name: name ?? "Untitled Knowledge",
      summary: summary ?? "该知识资产未提供摘要，需要时通过工具读取原文。",
      ...(path ? { path } : {}),
      retrievalMode: retrievalMode === "query" ? "query" : "rag",
      ...(maxResults ? { maxResults } : {})
    }];
  });
}

function knowledgeQueryFromTask(task: unknown) {
  if (typeof task === "string" && task.trim()) return task.trim().slice(0, 4000);
  const record = asRecord(task);
  const preferred = [
    record?.message,
    record?.content,
    record?.instruction,
    record?.goal,
    record?.title
  ].find((value) => typeof value === "string" && value.trim());
  if (typeof preferred === "string") return preferred.trim().slice(0, 4000);
  return JSON.stringify(task).slice(0, 4000);
}

function normalizeToolBindings(value: unknown): AgentRuntimeProfile["tools"] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap((item) => {
    const record = asRecord(item);
    const toolId = stringishOrUndefined(record?.toolId ?? record?.id);
    if (!toolId || seen.has(toolId)) return [];
    const runtimeToolId = stringishOrUndefined(record?.runtimeToolId) ?? toolId;
    seen.add(toolId);
    const name = stringishOrUndefined(record?.name);
    const summary = stringishOrUndefined(record?.summary ?? record?.description);
    const source = stringishOrUndefined(record?.source);
    const category = stringishOrUndefined(record?.category);
    const risk = stringishOrUndefined(record?.risk);
    const runtimeType = stringishOrUndefined(record?.runtimeType);
    const metadata = asRecord(record?.metadata);
    const inputSchema = asRecord(record?.inputSchema);
    const outputSchema = asRecord(record?.outputSchema);
    return [{
      toolId,
      ...(runtimeToolId ? { runtimeToolId } : {}),
      ...(name ? { name } : {}),
      ...(summary ? { summary } : {}),
      ...(category ? { category } : {}),
      ...(risk ? { risk } : {}),
      ...(runtimeType ? { runtimeType } : {}),
      ...(source ? { source } : {}),
      ...(metadata ? { metadata } : {}),
      ...(inputSchema ? { inputSchema } : {}),
      ...(outputSchema ? { outputSchema } : {}),
      enabled: record?.enabled !== false
    }];
  });
}

function normalizeToolRisk(value: unknown): ToolDefinitionView["risk"] | undefined {
  return value === "read" || value === "write" || value === "external" || value === "dangerous" ? value : undefined;
}

function normalizePermissions(value: unknown): AgentRuntimeProfile["permissions"] {
  const record = asRecord(value) ?? {};
  return {
    scopes: normalizeStringArray(record.scopes),
    requireApprovalFor: normalizeStringArray(record.requireApprovalFor)
  };
}

function isToolApprovalRequired(request: RuntimeToolRequest, profile: AgentRuntimeProfile | undefined) {
  const approvalRules = profile?.permissions.requireApprovalFor ?? [];
  if (!approvalRules.length) return false;
  const normalized = new Set(approvalRules.map((rule) => rule.trim().toLowerCase()).filter(Boolean));
  const toolId = request.toolId.toLowerCase();
  if (normalized.has(toolId) || normalized.has(`tool:${toolId}`)) return true;
  if ((toolId === "write_file" || toolId === "create_asset") && (normalized.has("write") || normalized.has("workspace:write"))) return true;
  if ((toolId === "read_file" || toolId === "read_asset" || toolId === "list_files" || toolId === "search_files") && (normalized.has("read") || normalized.has("workspace:read"))) return true;
  return false;
}

function extractMessageText(message: ChatMessage) {
  return message.blocks.map((block) => (block.type === "markdown" ? block.payload.text : block.type)).join("\n").trim();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
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

function booleanishOrUndefined(value: unknown) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return undefined;
  if (["false", "0", "no", "n", "off", "否", "不", "不要", "无", "none", "skip", "failed", "fail", "reject", "rejected", "不通过", "未通过"].includes(normalized)) return false;
  if (["true", "1", "yes", "y", "on", "是", "要", "有", "ok", "okay", "done", "complete", "completed", "pass", "passed", "approve", "approved", "通过"].includes(normalized)) return true;
  return undefined;
}

function clampInteger(value: unknown, fallback: number, min: number, max: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function normalizeAgentStatusInput(value: unknown) {
  const normalized = stringishOrUndefined(value)?.toLowerCase();
  if (!normalized) return undefined;
  if (["completed", "complete", "done", "success", "ok", "pass", "passed", "通过", "完成"].includes(normalized)) return "completed";
  if (["needs_clarification", "clarify", "question", "ask_user", "needs_user", "需要补充", "追问"].includes(normalized)) return "needs_clarification";
  if (["failed", "fail", "error", "失败"].includes(normalized)) return "failed";
  return undefined;
}

function parseAgentToolApprovalResumeState(value: unknown): AgentToolApprovalResumeState {
  const record = asRecord(value);
  const agent = asRecord(record?.agent);
  const conversationId = stringishOrUndefined(record?.conversationId);
  const ownerUserId = stringishOrUndefined(record?.ownerUserId);
  const traceId = stringishOrUndefined(record?.traceId);
  const requestedToolId = stringishOrUndefined(record?.requestedToolId);
  const mode = stringishOrUndefined(record?.mode);
  if (
    !record ||
    record.schemaVersion !== "agent-tool-approval-resume.v1" ||
    (mode !== "assignment" && mode !== "direct") ||
    !conversationId ||
    !ownerUserId ||
    !traceId ||
    !requestedToolId ||
    !agent
  ) {
    throw new Error("agent tool approval resume state is invalid");
  }
  const agentId = stringishOrUndefined(agent.id);
  const agentName = stringishOrUndefined(agent.name);
  if (!agentId || !agentName) throw new Error("agent tool approval resume state is missing agent identity");
  const agentType = agent.type === "code" ? "code" : "internal";
  const provider = stringishOrUndefined(agent.provider);
  const avatar = stringishOrUndefined(agent.avatar) ?? agentName.slice(0, 2);
  const role = stringishOrUndefined(agent.role) ?? "";
  const runId = stringishOrUndefined(record.runId);
  const agentRunId = stringishOrUndefined(record.agentRunId);
  return {
    schemaVersion: "agent-tool-approval-resume.v1",
    mode,
    ...(runId ? { runId } : {}),
    ...(agentRunId ? { agentRunId } : {}),
    conversationId,
    agent: {
      id: agentId,
      name: agentName,
      avatar,
      role,
      type: agentType,
      ...(provider ? { provider } : {}),
      ...(agent.capabilities !== undefined ? { capabilities: agent.capabilities } : {})
    },
    task: record.task,
    context: record.context,
    ownerUserId,
    traceId,
    toolResults: normalizeRuntimeToolResults(record.toolResults),
    nextStepIndex: clampInteger(record.nextStepIndex, 2, 1, 24),
    requestedToolId
  };
}

function normalizeRuntimeToolResults(value: unknown): RuntimeToolResult[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const record = asRecord(item);
    const toolRunId = stringishOrUndefined(record?.toolRunId);
    const toolId = stringishOrUndefined(record?.toolId);
    const status = stringishOrUndefined(record?.status);
    if (!toolRunId || !toolId || !["queued", "completed", "failed", "cancelled"].includes(status ?? "")) return [];
    const error = stringishOrUndefined(record?.error);
    return [{
      toolRunId,
      toolId,
      status: status as RuntimeToolResult["status"],
      ...(record?.output !== undefined ? { output: record.output } : {}),
      ...(error ? { error } : {})
    }];
  });
}

function isRuntimeAgentWaitingForToolApproval(result: RuntimeAgentResult) {
  return result.status === "needs_clarification" && Boolean(asRecord(result.memoryPatch)?.waitingToolApproval);
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

function collectCreatedAssets(toolResults: RuntimeToolResult[]): RuntimeAgentCreatedAsset[] {
  const byId = new Map<string, RuntimeAgentCreatedAsset>();
  for (const result of toolResults) {
    if (result.status !== "completed") continue;
    if (result.toolId !== "write_file" && result.toolId !== "create_asset") continue;
    const output = asRecord(result.output);
    const assetId = stringishOrUndefined(output?.assetId ?? output?.id);
    const workspaceId = stringishOrUndefined(output?.workspaceId);
    const name = stringishOrUndefined(output?.name);
    const path = stringishOrUndefined(output?.path);
    const mimeType = stringishOrUndefined(output?.mimeType);
    if (!assetId || !workspaceId || !name || !path || !mimeType) continue;
    const size = typeof output?.size === "number" && Number.isFinite(output.size) ? output.size : undefined;
    const summary = stringishOrUndefined(output?.summary);
    byId.set(assetId, {
      assetId,
      workspaceId,
      name,
      path,
      mimeType,
      ...(size !== undefined ? { size } : {}),
      ...(summary ? { summary } : {})
    });
  }
  return [...byId.values()];
}

function resolveAgentPublicMessage(step: z.infer<typeof agentStepSchema>, agentName: string) {
  const artifactBody = extractArtifactBody(step.memoryPatch);
  const message = step.publicMessage?.trim();
  if (artifactBody && (!message || isArtifactCompletionSummary(message))) return artifactBody;
  return message ?? step.resultSummary ?? `${agentName} 已完成任务。`;
}

function isArtifactCompletionSummary(message: string) {
  const normalized = message.replace(/\s+/g, " ").trim();
  if (!normalized) return true;
  if (normalized.length >= 800) return false;
  if (/^#{1,3}\s/m.test(message) || message.split(/\r?\n/).length >= 8) return false;
  return /(文档|PRD|prd|方案|规范|报告|设计稿|设计文档).*(已完成|完成|已输出|输出|已提交|提交|可直接进入)/i.test(normalized);
}

function extractArtifactBody(memoryPatch: Record<string, unknown>) {
  const candidates: Array<{ title?: string; content: string }> = [];
  const add = (value: unknown) => {
    const record = asRecord(value);
    const content = stringishOrUndefined(record?.content);
    if (!record || !content || content.length < 40) return;
    const title = stringishOrUndefined(record.title);
    candidates.push({ ...(title ? { title } : {}), content });
  };

  const patchRecord = asRecord(memoryPatch);
  const patches = Array.isArray(patchRecord?.patches) ? patchRecord.patches : [];
  for (const patch of patches) {
    const record = asRecord(patch);
    const path = stringishOrUndefined(record?.path)?.toLowerCase() ?? "";
    if (path.includes("artifact") || path.includes("document") || path.includes("doc")) add(record?.value);
  }
  add(patchRecord?.artifact);
  add(patchRecord?.document);

  const best = candidates.sort((a, b) => b.content.length - a.content.length)[0];
  if (!best) return undefined;
  if (best.title && !best.content.includes(best.title)) return `# ${best.title}\n\n${best.content}`;
  return best.content;
}
