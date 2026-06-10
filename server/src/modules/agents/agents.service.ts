import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException, Optional } from "@nestjs/common";
import { builtInAgents, hiddenSystemAgentIds, type AgentDefinition, type AgentHubUser } from "@agenthub/shared";
import { createHash } from "node:crypto";
import { nanoid } from "nanoid";
import { z } from "zod";
import { Prisma, type Agent, type AgentInstallation, type ToolDefinition } from "../../generated/prisma/client.js";
import { PrismaService } from "../../common/prisma.service.js";
import { LlmService } from "../runtime/llm.service.js";
import { ToolRuntimeService } from "../runtime/tool-runtime.service.js";
import { executableRuntimeToolIds, publicToolHubToolIds, toolRegistry, type ToolDefinitionView } from "../tools/tool-registry.js";
import { ToolsService } from "../tools/tools.service.js";

type AgentBuilderWorkspaceAssetRecord = Prisma.WorkspaceAssetGetPayload<{
  include: {
    workspace: {
      include: {
        conversation: {
          include: {
            members: true;
          };
        };
      };
    };
  };
}>;

export interface AgentBuilderInput {
  name: string;
  description: string;
  avatar?: string | undefined;
  type?: "universal" | "product" | "ui" | "review" | undefined;
  category?: string | undefined;
  capabilities?: string[] | undefined;
  visibility?: "private" | "public" | undefined;
  rolePrompt?: string | undefined;
  goals?: string[] | undefined;
  behaviorRules?: string[] | undefined;
  outputRules?: string[] | undefined;
  refusalRules?: string[] | undefined;
  skillAssetIds?: string[] | undefined;
  toolIds?: string[] | undefined;
  knowledgeAssetIds?: string[] | undefined;
  knowledgeBindings?: Array<{
    assetId: string;
    retrievalMode: "query" | "rag";
  }> | undefined;
  model?: {
    provider?: string | undefined;
    model?: string | undefined;
    temperature?: number | undefined;
    reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | undefined;
    streaming?: boolean | undefined;
    fallbackModel?: string | undefined;
  } | undefined;
  runtime?: {
    workflowTemplate?: "direct_answer" | "tool_loop" | "artifact_generation" | "review" | "human_approval" | undefined;
    maxToolSteps?: number | undefined;
    maxRunSeconds?: number | undefined;
  } | undefined;
  collaboration?: {
    orchestratorCallable?: boolean | undefined;
    dispatchTags?: string[] | undefined;
    assignmentDescription?: string | undefined;
    acknowledgeOnAssignment?: boolean | undefined;
  } | undefined;
  workspace?: {
    docRead?: boolean | undefined;
    docWrite?: boolean | undefined;
    codeRead?: boolean | undefined;
    codeWrite?: boolean | undefined;
    assetCreate?: boolean | undefined;
  } | undefined;
  memory?: {
    useConversationMemory?: boolean | undefined;
    usePinnedMessages?: boolean | undefined;
    usePersonalCrossConversationMemory?: boolean | undefined;
    writeBackPolicy?: "none" | "summary_only" | "confirmed_only" | undefined;
  } | undefined;
  permissions?: {
    scopes?: string[] | undefined;
    requireApprovalFor?: string[] | undefined;
  } | undefined;
  output?: {
    defaultFormat?: "markdown" | "json" | "artifact" | undefined;
    allowedBlocks?: string[] | undefined;
  } | undefined;
  publishing?: {
    license?: string | undefined;
    changelog?: string | undefined;
  } | undefined;
  confirmHighRiskPublish?: boolean | undefined;
}

export interface AgentBuilderPatchInput {
  name?: string | undefined;
  description?: string | undefined;
  avatar?: string | undefined;
  type?: AgentBuilderInput["type"] | undefined;
  category?: string | undefined;
  capabilities?: string[] | undefined;
  visibility?: "private" | "public" | undefined;
  rolePrompt?: string | undefined;
  goals?: string[] | undefined;
  behaviorRules?: string[] | undefined;
  outputRules?: string[] | undefined;
  refusalRules?: string[] | undefined;
  skillAssetIds?: string[] | undefined;
  toolIds?: string[] | undefined;
  knowledgeAssetIds?: string[] | undefined;
  knowledgeBindings?: AgentBuilderInput["knowledgeBindings"] | undefined;
  model?: AgentBuilderInput["model"] | undefined;
  runtime?: AgentBuilderInput["runtime"] | undefined;
  collaboration?: AgentBuilderInput["collaboration"] | undefined;
  workspace?: AgentBuilderInput["workspace"] | undefined;
  memory?: AgentBuilderInput["memory"] | undefined;
  permissions?: AgentBuilderInput["permissions"] | undefined;
  output?: AgentBuilderInput["output"] | undefined;
  publishing?: AgentBuilderInput["publishing"] | undefined;
  confirmHighRiskPublish?: boolean | undefined;
}

export interface AgentTestInput {
  message: string;
  writeMemory?: boolean | undefined;
  includePromptPack?: boolean | undefined;
}

export interface AgentBuilderDraftInput {
  message: string;
  includePublicAssets?: boolean | undefined;
}

export interface AgentBuilderChatInput {
  messages: Array<{
    role: "assistant" | "user";
    content: string;
  }>;
  currentDraft?: Record<string, unknown> | undefined;
  includePublicAssets?: boolean | undefined;
}

interface AgentBuilderAssetCandidate {
  assetId: string;
  sourceAssetId?: string;
  name: string;
  summary: string;
  path: string;
  visibility: "private" | "public";
  workspaceId: string;
}

interface AgentBuilderInventory {
  skills: AgentBuilderAssetCandidate[];
  knowledge: AgentBuilderAssetCandidate[];
  tools: ToolDefinitionView[];
}

const agentBuilderDraftSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().min(1).max(600),
  avatar: z.string().trim().max(300).optional(),
  type: z.enum(["universal", "product", "ui", "review"]).optional(),
  category: z.string().trim().min(1).max(60).optional(),
  capabilities: z.array(z.string().trim().min(1).max(60)).max(12).default([]),
  rolePrompt: z.string().trim().min(1).max(8000),
  goals: z.array(z.string().trim().min(1).max(500)).max(20).default([]),
  behaviorRules: z.array(z.string().trim().min(1).max(500)).max(20).default([]),
  outputRules: z.array(z.string().trim().min(1).max(500)).max(20).default([]),
  refusalRules: z.array(z.string().trim().min(1).max(500)).max(20).default([]),
  skillAssetIds: z.array(z.string().trim().min(1).max(128)).max(20).default([]),
  toolIds: z.array(z.string().trim().min(1).max(80)).max(20).default([]),
  knowledgeAssetIds: z.array(z.string().trim().min(1).max(128)).max(20).default([]),
  model: z.object({
    provider: z.string().trim().min(1).max(80).optional(),
    model: z.string().trim().min(1).max(120).optional(),
    temperature: z.number().min(0).max(2).optional(),
    reasoningEffort: z.enum(["none", "minimal", "low", "medium", "high", "xhigh"]).optional(),
    streaming: z.boolean().optional(),
    fallbackModel: z.string().trim().min(1).max(120).optional()
  }).optional(),
  runtime: z.object({
    workflowTemplate: z.enum(["direct_answer", "tool_loop", "artifact_generation", "review", "human_approval"]).optional(),
    maxToolSteps: z.number().int().min(1).max(12).optional(),
    maxRunSeconds: z.number().int().min(30).max(1800).optional()
  }).optional(),
  collaboration: z.object({
    orchestratorCallable: z.boolean().optional(),
    dispatchTags: z.array(z.string().trim().min(1).max(60)).max(20).optional(),
    assignmentDescription: z.string().trim().max(1000).optional(),
    acknowledgeOnAssignment: z.boolean().optional()
  }).optional(),
  workspace: z.object({
    docRead: z.boolean().optional(),
    docWrite: z.boolean().optional(),
    codeRead: z.boolean().optional(),
    codeWrite: z.boolean().optional(),
    assetCreate: z.boolean().optional()
  }).optional(),
  memory: z.object({
    useConversationMemory: z.boolean().optional(),
    usePinnedMessages: z.boolean().optional(),
    usePersonalCrossConversationMemory: z.boolean().optional(),
    writeBackPolicy: z.enum(["none", "summary_only", "confirmed_only"]).optional()
  }).optional(),
  permissions: z.object({
    scopes: z.array(z.string().trim().min(1).max(80)).max(30).optional(),
    requireApprovalFor: z.array(z.string().trim().min(1).max(80)).max(30).optional()
  }).optional(),
  output: z.object({
    defaultFormat: z.enum(["markdown", "json", "artifact"]).optional(),
    allowedBlocks: z.array(z.enum(["markdown", "code", "file", "image", "web_preview", "diff", "deploy_status", "agent_status"])).max(20).optional()
  }).optional(),
  rationale: z.string().trim().max(1200).optional(),
  recommendedBindings: z.object({
    skills: z.array(z.object({ assetId: z.string(), reason: z.string().optional() })).default([]),
    tools: z.array(z.object({ toolId: z.string(), reason: z.string().optional() })).default([]),
    knowledge: z.array(z.object({ assetId: z.string(), reason: z.string().optional() })).default([])
  }).optional(),
  safetyNotes: z.array(z.string().trim().min(1).max(300)).max(10).default([])
});

const agentBuilderChecklistFieldSchema = z.enum(["goal", "role", "components", "permissions", "memory", "naming"]);
const agentBuilderChecklistStatusSchema = z.enum(["todo", "active", "done"]);

const agentBuilderChatSchema = z.object({
  assistantMessage: z.string().trim().min(1).max(1800),
  draft: agentBuilderDraftSchema,
  checklist: z.array(z.object({
    id: agentBuilderChecklistFieldSchema,
    label: z.string().trim().min(1).max(40),
    status: agentBuilderChecklistStatusSchema
  })).min(1).max(6),
  readyToSave: z.boolean().default(false),
  rationale: z.string().trim().max(1200).optional(),
  safetyNotes: z.array(z.string().trim().min(1).max(300)).max(10).default([])
});

const builtInAgentIds = builtInAgents.map((agent) => agent.id);

@Injectable()
export class AgentsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Optional()
    @Inject(LlmService)
    private readonly llm?: Pick<LlmService, "generateJson">,
    @Optional()
    @Inject(ToolRuntimeService)
    private readonly toolRuntime?: ToolRuntimeService,
    @Optional()
    @Inject(ToolsService)
    private readonly toolsService?: ToolsService
  ) {}

  async listAgents(currentUser?: AgentHubUser, scope?: "personal" | "public", options: { includeSystem?: boolean } = {}) {
    const where = await this.visibleAgentWhere(currentUser, scope, options);
    const accessibleInstallationFilter = currentUser ? await this.accessibleInstallationFilter(currentUser.id) : undefined;
    const findArgs: Prisma.AgentFindManyArgs = {
      where,
      orderBy: { createdAt: "asc" },
      include: latestAgentDefinitionInclude()
    };
    if (accessibleInstallationFilter) {
      findArgs.include = {
        ...latestAgentDefinitionInclude(),
        installations: {
          where: accessibleInstallationFilter,
          take: 1
        }
      };
    }
    const agents = await this.prisma.agent.findMany(findArgs);
    return Promise.all(agents.map((agent) => this.toAgentDefinitionView(agent)));
  }

  async getAgent(currentUser: AgentHubUser, id: string) {
    const accessibleInstallationFilter = await this.accessibleInstallationFilter(currentUser.id);
    const agent = await this.prisma.agent.findFirst({
      where: {
        id,
        ...(await this.visibleAgentWhere(currentUser))
      },
      include: {
        ...latestAgentDefinitionInclude(),
        installations: {
          where: accessibleInstallationFilter,
          take: 1
        }
      }
    });
    return agent ? this.toAgentDefinitionView(agent) : undefined;
  }

  async getAgentConfig(currentUser: AgentHubUser, id: string) {
    const agent = await this.prisma.agent.findFirst({
      where: {
        id,
        ...(await this.visibleAgentWhere(currentUser))
      },
      include: latestAgentDefinitionInclude()
    });
    if (!agent) throw new NotFoundException("Agent not found");
    const version = await this.latestAgentVersion(id);
    return { agent: await this.toAgentDefinitionView(agent), config: version?.config ?? null, version: version?.version ?? null };
  }

  async listAgentsUsingComponent(currentUser: AgentHubUser, input: { componentKind: "tool" | "skill" | "knowledge"; componentAssetId: string }) {
    const bindings = await this.prisma.agentComponentBinding.findMany({
      where: {
        componentKind: input.componentKind,
        componentAssetId: input.componentAssetId,
        deletedAt: null,
        agent: await this.visibleAgentWhere(currentUser)
      },
      orderBy: [{ agentId: "asc" }, { order: "asc" }],
      include: {
        agent: {
          include: {
            ...latestAgentDefinitionInclude(),
            installations: {
              where: await this.accessibleInstallationFilter(currentUser.id),
              take: 1
            }
          }
        }
      }
    });
    return {
      bindings: bindings.map((binding) => ({
        id: binding.id,
        agentId: binding.agentId,
        agentVersionId: binding.agentVersionId,
        componentKind: binding.componentKind,
        componentAssetId: binding.componentAssetId,
        source: binding.source,
        versionPolicy: binding.versionPolicy,
        enabled: binding.enabled,
        order: binding.order,
        config: binding.config,
        agent: toAgentDefinition(binding.agent)
      }))
    };
  }

  async testAgent(currentUser: AgentHubUser, id: string, input: AgentTestInput) {
    const agent = await this.prisma.agent.findFirst({
      where: {
        id,
        ...(await this.visibleAgentWhere(currentUser))
      },
      include: latestAgentDefinitionInclude()
    });
    if (!agent) throw new NotFoundException("Agent not found");
    const latest = await this.latestAgentVersion(id);
    const config = asRecord(latest?.config) ?? {};
    const runtime = asRecord(config.runtime) ?? {};
    const collaboration = asRecord(config.collaboration) ?? {};
    const workspace = asRecord(config.workspace) ?? {};
    const model = asRecord(config.model) ?? {};
    const prompt = asRecord(config.prompt) ?? {};
    const memory = asRecord(config.memory) ?? {};
    const permissions = asRecord(config.permissions) ?? {};
    const output = asRecord(config.output) ?? {};
    const skills = normalizeRecordList(config.skills);
    const tools = normalizeRecordList(config.tools);
    const knowledge = normalizeRecordList(config.knowledge);
    const promptPack = {
      system: [
        `你正在测试 Agent：${agent.name}`,
        `角色：${readString(prompt, ["role"]) ?? agent.description}`,
        formatPromptList("目标", readStringArray(prompt, ["goals"])),
        formatPromptList("行为规则", readStringArray(prompt, ["behaviorRules"])),
        formatPromptList("输出规则", readStringArray(prompt, ["outputRules"])),
        formatPromptList("拒绝与降级规则", readStringArray(prompt, ["refusalRules"])),
        formatBindingList("可用 Skills", skills, "name", "summary"),
        formatBindingList("可用 Tools", tools, "toolId", "source"),
        formatBindingList("可用 Knowledge", knowledge, "name", "summary"),
        `协作配置：可被 Orchestrator 分派=${collaboration.orchestratorCallable !== false ? "是" : "否"}；分派标签=${normalizeStringList(collaboration.dispatchTags).join("、") || "custom"}；被分派确认=${collaboration.acknowledgeOnAssignment !== false ? "是" : "否"}`,
        `工作空间权限：Doc读=${workspace.docRead !== false ? "允许" : "禁止"}；Doc写=${workspace.docWrite !== false ? "允许" : "禁止"}；Code读=${workspace.codeRead !== false ? "允许" : "禁止"}；Code写=${workspace.codeWrite === true ? "允许" : "禁止"}；Asset创建=${workspace.assetCreate !== false ? "允许" : "禁止"}`,
        `权限范围：${normalizeStringList(permissions.scopes).join("、") || "message:read、message:write、workspace:read"}`,
        `输出协议：${normalizeOptionalString(output.defaultFormat) ?? "markdown"}；允许块：${normalizeStringList(output.allowedBlocks).join("、") || "markdown、file、image、web_preview、diff、agent_status"}`
      ].filter(Boolean).join("\n"),
      messages: [{ role: "user", content: input.message.trim() }]
    };
    const riskWarnings = sandboxRiskWarnings({ tools, permissions, memory, writeMemory: input.writeMemory === true });
    const modelView = buildSandboxModelView(model);
    const runtimeView = buildSandboxRuntimeView(runtime);
    const toolCallLog = buildSandboxToolCallLog(tools, permissions);
    const outputBlocks = buildSandboxOutputBlocks({
      output,
      message: input.message.trim(),
      skills,
      tools,
      knowledge
    });
    const memoryCandidate = buildSandboxMemoryCandidate({
      message: input.message.trim(),
      memory,
      writeMemory: input.writeMemory === true
    });
    await this.prisma.auditLog.create({
      data: {
        actorUserId: currentUser.id,
        action: "agent.config.tested",
        targetType: "agent",
        targetId: id,
        payload: {
          version: latest?.version ?? null,
          writeMemory: input.writeMemory === true,
          skillCount: skills.length,
          toolCount: tools.length,
          knowledgeCount: knowledge.length,
          riskWarnings
        } as Prisma.InputJsonValue
      }
    });
    return {
      agent: toAgentDefinition(agent),
      version: latest?.version ?? null,
      sandbox: {
        mode: "dry_run",
        message: input.message.trim(),
        model: modelView,
        runtime: runtimeView,
        skills,
        tools,
        knowledge,
        collaboration,
        workspace,
        memory,
        permissions,
        output,
        ...(input.includePromptPack === false ? {} : { promptPack }),
        contextSummary: {
          skillCount: skills.length,
          toolCount: tools.length,
          knowledgeCount: knowledge.length,
          memoryPolicy: {
            conversation: memory.useConversationMemory !== false,
            pinnedMessages: memory.usePinnedMessages !== false,
            personalCrossConversation: memory.usePersonalCrossConversationMemory !== false,
            writeBackPolicy: normalizeOptionalString(memory.writeBackPolicy) ?? "summary_only"
          },
          permissionScopes: normalizeStringList(permissions.scopes),
          collaboration: {
            orchestratorCallable: collaboration.orchestratorCallable !== false,
            dispatchTags: normalizeStringList(collaboration.dispatchTags),
            acknowledgeOnAssignment: collaboration.acknowledgeOnAssignment !== false
          },
          workspacePolicy: {
            docRead: workspace.docRead !== false,
            docWrite: workspace.docWrite !== false,
            codeRead: workspace.codeRead !== false,
            codeWrite: workspace.codeWrite === true,
            assetCreate: workspace.assetCreate !== false
          },
          riskWarnings
        },
        executionPlan: {
          kind: "sandbox_preview",
          workflowTemplate: runtimeView.workflowTemplate,
          maxToolSteps: runtimeView.maxToolSteps,
          willExecuteTools: false,
          willWriteConversationMemory: false,
          willWritePersonalMemory: false,
          note: "沙盒只构造正式运行前的上下文、工具计划、输出块和记忆候选；不会执行外部工具，也不会写入真实会话。"
        },
        toolCallLog,
        outputBlocks,
        memoryCandidate,
        riskWarnings
      }
    };
  }

  async generateAgentDraft(currentUser: AgentHubUser, input: AgentBuilderDraftInput) {
    const deterministicDemo = await this.tryRecordingAgentBuilderDraft(currentUser, input.message, input.includePublicAssets !== false);
    if (deterministicDemo) return deterministicDemo;
    if (!this.llm) throw new BadRequestException("Agent Builder LLM is not available");
    const inventory = await this.agentBuilderInventory(currentUser, input.includePublicAssets !== false);
    const systemPrompt = [
      "你是一名 AgentHub Agent Builder，负责把用户的自然语言需求转成可编辑的 Agent 配置草案。",
      "你必须输出严格 JSON，字段只使用给定 schema。",
      "你需要完成：生成 Agent Profile、角色提示词、目标、行为规则、输出规则、拒绝/降级规则，并从候选 Skills、Tools、Knowledge 中推荐绑定项。",
      "推荐绑定项只能使用用户可见候选清单中的 id；不要编造 skillAssetId、knowledgeAssetId 或 toolId。",
      "默认保持私有配置，不要推荐危险工具；需要写入或外部访问时必须在 permissions.requireApprovalFor 中加入确认项。",
      "如果用户描述不足，仍要生成一个保守可运行草案，并在 safetyNotes 中提示需要用户补充的边界。"
    ].join("\n");
    const llmDraft = await this.llm.generateJson<z.infer<typeof agentBuilderDraftSchema>>({
      callerType: "agent_builder",
      callerId: currentUser.id,
      schemaName: "agent_builder_draft",
      schema: agentBuilderDraftSchema,
      systemPrompt,
      userPrompt: JSON.stringify({
        userRequest: input.message.trim(),
        candidateInventory: inventory,
        defaultPolicies: {
          visibility: "private",
          model: { provider: "runtime_default", model: "runtime_default", reasoningEffort: "high", streaming: false },
          memory: {
            useConversationMemory: true,
            usePinnedMessages: true,
            usePersonalCrossConversationMemory: true,
            writeBackPolicy: "summary_only"
          },
          permissions: { scopes: ["message:read", "message:write", "workspace:read"], requireApprovalFor: [] },
          output: { defaultFormat: "markdown", allowedBlocks: ["markdown", "file", "image", "web_preview", "diff", "agent_status"] }
        }
      }, null, 2)
    });
    const draft = sanitizeGeneratedAgentDraft(input.message, llmDraft, inventory);
    await this.prisma.auditLog.create({
      data: {
        actorUserId: currentUser.id,
        action: "agent.builder.draft_generated",
        targetType: "agent_builder",
        targetId: currentUser.id,
        payload: {
          requestedLength: input.message.trim().length,
          skillCount: draft.skillAssetIds?.length ?? 0,
          toolCount: draft.toolIds?.length ?? 0,
          knowledgeCount: draft.knowledgeAssetIds?.length ?? 0
        } as Prisma.InputJsonValue
      }
    });
    return {
      draft,
      rationale: normalizeOptionalString(llmDraft.rationale) ?? "已根据用户描述生成 Agent 配置草案。",
      recommendedBindings: buildRecommendedBindingViews(llmDraft.recommendedBindings, inventory, draft),
      safetyNotes: normalizeStringList(llmDraft.safetyNotes),
      promptPack: {
        system: systemPrompt,
        user: {
          userRequest: input.message.trim(),
          candidateCounts: {
            skills: inventory.skills.length,
            tools: inventory.tools.length,
            knowledge: inventory.knowledge.length
          }
        }
      }
    };
  }

  async chatWithAgentBuilder(currentUser: AgentHubUser, input: AgentBuilderChatInput) {
    const deterministicDemo = await this.tryRecordingAgentBuilderChat(currentUser, input);
    if (deterministicDemo) return deterministicDemo;
    if (!this.llm) throw new BadRequestException("Agent Builder Chat LLM is not available");
    const inventory = await this.agentBuilderInventory(currentUser, input.includePublicAssets !== false);
    const messages = input.messages.slice(-24);
    const latestUserMessage = [...messages].reverse().find((message) => message.role === "user")?.content.trim() ?? "";
    const systemPrompt = [
      "你是一名专门用于 AgentHub 自建 Agent 的 Agent Builder 大模型。",
      "你和用户进行多轮对话，目标是把用户的自然语言设想逐步转成可保存、可编辑、可运行的 Agent 配置草案。",
      "你不是普通聊天助手。每一轮都必须同时完成三件事：1. 给用户一个自然、具体、可继续推进的回复；2. 根据已有信息维护一份完整 Agent 草案；3. 更新目标、角色、组件、权限、记忆、命名六项进度。",
      "如果信息不足，assistantMessage 应该只追问当前最关键的一到两个问题；不要机械复述字段名，也不要假装已经确认用户没有说过的内容。",
      "如果信息已经足够，assistantMessage 应该说明已经形成草案，并提示用户可以继续调整或切换到表单保存。",
      "推荐绑定项只能使用候选清单里的真实 id。不要编造 Skill、Tool、Knowledge，也不要推荐用户不可见资产。",
      "涉及联网、写文件、写代码、部署、外部 API 或高影响工具时，必须在 permissions.requireApprovalFor 中加入确认项，并在 safetyNotes 说明。",
      "默认配置保持 private；默认模型使用 runtime_default；默认输出为 Markdown；长内容或文件产物应允许 file/image 等消息块。",
      "输出必须是严格 JSON，字段必须匹配 schema。"
    ].join("\n");
    const llmResult = await this.llm.generateJson<z.infer<typeof agentBuilderChatSchema>>({
      callerType: "agent_builder_chat",
      callerId: currentUser.id,
      schemaName: "agent_builder_chat",
      schema: agentBuilderChatSchema,
      systemPrompt,
      userPrompt: JSON.stringify({
        chatMessages: messages,
        latestUserMessage,
        currentEditableDraft: input.currentDraft ?? {},
        candidateInventory: summarizeAgentBuilderInventory(inventory),
        requiredChecklist: agentBuilderChecklistDefaults,
        outputContract: {
          assistantMessage: "展示给用户的一段自然语言回复。",
          draft: "完整 Agent 配置草案。即使信息不足，也要给出保守可运行版本，并通过 assistantMessage 继续追问。",
          checklist: "六项固定进度。done 表示已有足够信息；active 表示当前正在追问；todo 表示仍未处理。",
          readyToSave: "当草案已经可保存且风险边界基本清楚时为 true。"
        }
      }, null, 2),
      modelOverride: { reasoningEffort: "high" }
    });
    const draft = sanitizeGeneratedAgentDraft(latestUserMessage, llmResult.draft, inventory);
    const checklist = normalizeAgentBuilderChecklist(llmResult.checklist);
    const safetyNotes = Array.from(new Set([
      ...normalizeStringList(llmResult.safetyNotes),
      ...normalizeStringList(llmResult.draft.safetyNotes)
    ]));
    await this.prisma.auditLog.create({
      data: {
        actorUserId: currentUser.id,
        action: "agent.builder.chat_turn",
        targetType: "agent_builder",
        targetId: currentUser.id,
        payload: {
          messageCount: messages.length,
          latestUserMessageLength: latestUserMessage.length,
          readyToSave: llmResult.readyToSave,
          completedChecklistCount: checklist.filter((item) => item.status === "done").length,
          skillCount: draft.skillAssetIds?.length ?? 0,
          toolCount: draft.toolIds?.length ?? 0,
          knowledgeCount: draft.knowledgeAssetIds?.length ?? 0
        } as Prisma.InputJsonValue
      }
    });
    return {
      assistantMessage: llmResult.assistantMessage,
      draft,
      checklist,
      readyToSave: llmResult.readyToSave,
      rationale: normalizeOptionalString(llmResult.rationale) ?? normalizeOptionalString(llmResult.draft.rationale) ?? "已根据本轮对话更新 Agent 草案。",
      recommendedBindings: buildRecommendedBindingViews(llmResult.draft.recommendedBindings, inventory, draft),
      safetyNotes,
      promptPack: {
        system: systemPrompt,
        user: {
          messageCount: messages.length,
          latestUserMessageLength: latestUserMessage.length,
          candidateCounts: {
            skills: inventory.skills.length,
            tools: inventory.tools.length,
            knowledge: inventory.knowledge.length
          }
        }
      }
    };
  }

  private async tryRecordingAgentBuilderDraft(currentUser: AgentHubUser, message: string, includePublicAssets: boolean) {
    if (!shouldUseRecordingAgentBuilderDemo(currentUser, [{ role: "user", content: message }])) return null;
    const inventory = await this.agentBuilderInventory(currentUser, includePublicAssets);
    const result = buildRecordingAgentBuilderTurn(1, inventory);
    await this.logRecordingAgentBuilderTurn(currentUser, {
      mode: "draft",
      turn: 1,
      readyToSave: result.readyToSave,
      messageCount: 1
    });
    return {
      draft: result.draft,
      rationale: result.rationale,
      recommendedBindings: result.recommendedBindings,
      safetyNotes: result.safetyNotes,
      promptPack: result.promptPack
    };
  }

  private async tryRecordingAgentBuilderChat(currentUser: AgentHubUser, input: AgentBuilderChatInput) {
    if (!shouldUseRecordingAgentBuilderDemo(currentUser, input.messages)) return null;
    const inventory = await this.agentBuilderInventory(currentUser, input.includePublicAssets !== false);
    const userTurnCount = input.messages.filter((message) => message.role === "user").length;
    const result = buildRecordingAgentBuilderTurn(userTurnCount, inventory);
    await this.logRecordingAgentBuilderTurn(currentUser, {
      mode: "chat",
      turn: userTurnCount,
      readyToSave: result.readyToSave,
      messageCount: input.messages.length
    });
    return result;
  }

  private async logRecordingAgentBuilderTurn(currentUser: AgentHubUser, input: { mode: "draft" | "chat"; turn: number; readyToSave: boolean; messageCount: number }) {
    await this.prisma.auditLog.create({
      data: {
        actorUserId: currentUser.id,
        action: "agent.builder.recording_demo_turn",
        targetType: "agent_builder",
        targetId: currentUser.id,
        payload: input as Prisma.InputJsonValue
      }
    }).catch(() => undefined);
  }

  private async agentBuilderInventory(currentUser: AgentHubUser, includePublicAssets: boolean): Promise<AgentBuilderInventory> {
    const accessFilters = await this.visibleHubAssetAccessFilters(currentUser);
    const skillRows = await this.prisma.skillAsset.findMany({
      where: {
        deletedAt: null,
        ...(includePublicAssets
          ? { OR: accessFilters }
          : { ownerType: "user", ownerId: currentUser.id })
      },
      orderBy: { updatedAt: "desc" },
      take: 40
    });
    const skillSources = await this.prisma.workspaceAsset.findMany({
      where: { id: { in: skillRows.map((asset) => asset.sourceAssetId) }, deletedAt: null },
      select: { id: true, workspaceId: true, path: true }
    });
    const skillSourceById = new Map(skillSources.map((asset) => [asset.id, asset]));
    const skills = skillRows.map((asset) => {
      const source = skillSourceById.get(asset.sourceAssetId);
      return {
        assetId: asset.id,
        sourceAssetId: asset.sourceAssetId,
        name: asset.name,
        summary: asset.description,
        path: source?.path ?? `skill://${asset.id}`,
        visibility: asset.visibility === "public" ? "public" as const : "private" as const,
        workspaceId: source?.workspaceId ?? ""
      };
    });
    const knowledgeRows = await this.prisma.knowledgeAsset.findMany({
      where: {
        deletedAt: null,
        OR: [
          { ownerType: "user", ownerId: currentUser.id },
          ...(includePublicAssets ? [{ visibility: "public" }] : []),
          {
            subscriptions: {
              some: { ownerType: "user", ownerId: currentUser.id, deletedAt: null }
            }
          }
        ]
      },
      orderBy: { updatedAt: "desc" },
      take: 40
    });
    const knowledgeSources = await this.prisma.workspaceAsset.findMany({
      where: { id: { in: knowledgeRows.map((asset) => asset.sourceAssetId) }, deletedAt: null },
      select: { id: true, workspaceId: true, path: true }
    });
    const knowledgeSourceById = new Map(knowledgeSources.map((asset) => [asset.id, asset]));
    const knowledge = knowledgeRows.map((asset) => {
      const source = knowledgeSourceById.get(asset.sourceAssetId);
      return {
        assetId: asset.id,
        sourceAssetId: asset.sourceAssetId,
        name: asset.name,
        summary: asset.summary || asset.description,
        path: source?.path ?? `knowledge://${asset.id}`,
        visibility: asset.visibility === "public" ? "public" as const : "private" as const,
        workspaceId: source?.workspaceId ?? ""
      };
    });
    return {
      skills,
      knowledge,
      tools: await this.loadBindableToolViews(currentUser)
    };
  }

  async createAgent(currentUser: AgentHubUser, input: AgentBuilderInput) {
    const now = new Date().toISOString();
    const agentId = await this.nextAgentId(input.name);
    const capabilities = normalizeStringList(input.capabilities).slice(0, 12);
    const visibility = input.visibility ?? "private";
    const agentType = normalizeAgentBuilderType(input.type);
    const agentVersionId = `agent-version-${agentId}-1`;
    const config = await this.buildAgentConfig(currentUser, agentId, input, {
      createdAt: now,
      copiedFrom: null,
      version: "1.0.0"
    });
    if (visibility === "public") await this.assertPublishableConfig(config, { confirmHighRisk: input.confirmHighRiskPublish === true });
    const agent = await this.prisma.$transaction(async (tx) => {
      const created = await tx.agent.create({
        data: {
          id: agentId,
          name: input.name.trim(),
          avatar: normalizeOptionalString(input.avatar) ?? "/avatars/agents/agent-v2-07.png",
          type: agentType,
          provider: "internal",
          description: input.description.trim(),
          capabilities: (capabilities.length > 0 ? capabilities : ["custom", "general"]) as unknown as Prisma.InputJsonValue,
          visibility,
          status: "available",
          versions: {
            create: {
              id: agentVersionId,
              version: "1.0.0",
              config: config as Prisma.InputJsonValue
            }
          },
          installations: {
            create: {
              id: `agent-install-${agentId}-user-${currentUser.id}`,
              ownerType: "user",
              ownerId: currentUser.id,
              config: {
                alias: agentId.replace(/^agent-/, ""),
                enabled: true,
                source: "created"
              } as Prisma.InputJsonValue
            }
          }
        }
      });
      await this.createAgentComponentBindings(tx, { agentId, agentVersionId, config });
      await tx.auditLog.create({
        data: {
          actorUserId: currentUser.id,
          action: "agent.create",
          targetType: "agent",
          targetId: agentId,
          payload: { visibility, skillCount: config.skills.length, toolCount: config.tools.length } as Prisma.InputJsonValue
        }
      });
      return created;
    });
    const installation = await this.currentUserInstallation(agent.id, currentUser.id);
    return { agent: toAgentDefinition({ ...agent, versions: [{ config }], ...(installation ? { installations: [installation] } : {}) }), config };
  }

  async updateAgent(currentUser: AgentHubUser, id: string, input: AgentBuilderPatchInput) {
    const agent = await this.prisma.agent.findFirst({ where: { id, deletedAt: null } });
    if (!agent) throw new NotFoundException("Agent not found");
    await this.assertCanEditAgent(currentUser, agent);
    const latest = await this.latestAgentVersion(id);
    const previousConfig = asRecord(latest?.config) ?? {};
    const mergedInput: AgentBuilderInput = {
      name: input.name ?? agent.name,
      description: input.description ?? agent.description,
      avatar: input.avatar ?? agent.avatar ?? undefined,
      type: input.type ?? normalizeAgentBuilderType(readString(previousConfig, ["profile", "agentType"]) ?? agent.type),
      category: input.category ?? readString(previousConfig, ["profile", "category"]) ?? "custom",
      capabilities: input.capabilities ?? (Array.isArray(agent.capabilities) ? agent.capabilities as string[] : []),
      visibility: input.visibility ?? agent.visibility as "private" | "public",
      rolePrompt: input.rolePrompt ?? readString(previousConfig, ["prompt", "role"]) ?? agent.description,
      goals: input.goals ?? readStringArray(previousConfig, ["prompt", "goals"]),
      behaviorRules: input.behaviorRules ?? readStringArray(previousConfig, ["prompt", "behaviorRules"]),
      outputRules: input.outputRules ?? readStringArray(previousConfig, ["prompt", "outputRules"]),
      refusalRules: input.refusalRules ?? readStringArray(previousConfig, ["prompt", "refusalRules"]),
      skillAssetIds: input.skillAssetIds ?? readBindingIds(previousConfig, "skills"),
      toolIds: input.toolIds ?? readBindingIds(previousConfig, "tools"),
      knowledgeAssetIds: input.knowledgeAssetIds ?? readBindingIds(previousConfig, "knowledge"),
      knowledgeBindings: input.knowledgeBindings
        ?? (input.knowledgeAssetIds
          ? input.knowledgeAssetIds.map((assetId) => ({ assetId, retrievalMode: "rag" as const }))
          : readKnowledgeBindings(previousConfig)),
      model: {
        ...asRecord(previousConfig.model),
        ...(input.model ?? {})
      },
      runtime: {
        ...asRecord(previousConfig.runtime),
        ...(input.runtime ?? {})
      },
      collaboration: {
        ...asRecord(previousConfig.collaboration),
        ...(input.collaboration ?? {})
      },
      workspace: {
        ...asRecord(previousConfig.workspace),
        ...(input.workspace ?? {})
      },
      memory: {
        ...asRecord(previousConfig.memory),
        ...(input.memory ?? {})
      },
      permissions: {
        ...asRecord(previousConfig.permissions),
        ...(input.permissions ?? {})
      },
      output: {
        ...asRecord(previousConfig.output),
        ...(input.output ?? {})
      },
      publishing: {
        ...asRecord(previousConfig.publishing),
        ...(input.publishing ?? {})
      }
    };
    const nextVersion = nextSemverPatch(latest?.version);
    const config = await this.buildAgentConfig(currentUser, id, mergedInput, {
      createdAt: readString(previousConfig, ["lineage", "createdAt"]) ?? new Date().toISOString(),
      copiedFrom: asRecord(previousConfig.lineage)?.copiedFrom ?? null,
      version: nextVersion
    });
    if ((mergedInput.visibility ?? agent.visibility) === "public") {
      await this.assertPublishableConfig(config, { confirmHighRisk: input.confirmHighRiskPublish === true });
    }
    const agentVersionId = `agent-version-${id}-${nanoid(8)}`;
    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.agent.update({
        where: { id },
        data: {
          name: mergedInput.name.trim(),
          avatar: normalizeOptionalString(mergedInput.avatar) ?? agent.avatar,
          type: normalizeAgentBuilderType(mergedInput.type),
          description: mergedInput.description.trim(),
          capabilities: normalizedCapabilitiesOrDefault(mergedInput.capabilities) as unknown as Prisma.InputJsonValue,
          visibility: mergedInput.visibility ?? agent.visibility,
          deletedAt: null
        }
      });
      await tx.agentVersion.create({
        data: {
          id: agentVersionId,
          agentId: id,
          version: nextVersion,
          config: config as Prisma.InputJsonValue
        }
      });
      await this.createAgentComponentBindings(tx, { agentId: id, agentVersionId, config });
      await tx.auditLog.create({
        data: {
          actorUserId: currentUser.id,
          action: "agent.update",
          targetType: "agent",
          targetId: id,
          payload: { version: nextVersion, visibility: mergedInput.visibility } as Prisma.InputJsonValue
        }
      });
      return row;
    });
    const installation = await this.currentUserInstallation(id, currentUser.id);
    return { agent: toAgentDefinition({ ...updated, versions: [{ config }], ...(installation ? { installations: [installation] } : {}) }), config };
  }

  async publishAgent(currentUser: AgentHubUser, id: string, input: {
    confirmHighRiskPublish?: boolean | undefined;
    publishing?: AgentBuilderInput["publishing"] | undefined;
  } = {}) {
    const agent = await this.prisma.agent.findFirst({ where: { id, deletedAt: null } });
    if (!agent) throw new NotFoundException("Agent not found");
    await this.assertCanEditAgent(currentUser, agent);
    const latest = await this.latestAgentVersion(id);
    const previousConfig = asRecord(latest?.config) ?? {};
    await this.assertPublishableConfig(previousConfig, { confirmHighRisk: input.confirmHighRiskPublish === true });
    const nextVersion = latest ? nextSemverPatch(latest.version) : "1.0.0";
    const updatedConfig = {
      ...previousConfig,
      publishing: {
        ...(asRecord(previousConfig.publishing) ?? {}),
        visibility: "public",
        ...(input.publishing?.license !== undefined ? { license: input.publishing.license.trim() } : {}),
        ...(input.publishing?.changelog !== undefined ? { changelog: input.publishing.changelog.trim() } : {})
      }
    };
    const agentVersionId = `agent-version-${id}-${nanoid(8)}`;
    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.agent.update({
        where: { id },
        data: { visibility: "public" }
      });
      if (latest) {
        await tx.agentVersion.create({
          data: {
            id: agentVersionId,
            agentId: id,
            version: nextVersion,
            config: updatedConfig as Prisma.InputJsonValue
          }
        });
        await this.createAgentComponentBindings(tx, { agentId: id, agentVersionId, config: updatedConfig });
      }
      return row;
    });
    await this.prisma.auditLog.create({
      data: {
        actorUserId: currentUser.id,
        action: "agent.publish",
        targetType: "agent",
        targetId: id,
        payload: { visibility: "public" } as Prisma.InputJsonValue
      }
    });
    return { agent: toAgentDefinition({ ...updated, versions: [{ version: nextVersion, config: updatedConfig as Prisma.JsonValue }] }) };
  }

  async forkAgent(currentUser: AgentHubUser, id: string) {
    const source = await this.prisma.agent.findFirst({ where: { id, deletedAt: null, visibility: "public" } });
    if (!source) throw new NotFoundException("Agent not found");
    const latest = await this.latestAgentVersion(id);
    const sourceConfig = asRecord(latest?.config) ?? {};
    const privateDependencies = await this.privateForkDependencyNames(sourceConfig);
    if (privateDependencies.length > 0) {
      throw new BadRequestException(`该 Agent 绑定了私有 Skill/Tool/Knowledge，只能订阅，不能 Fork：${privateDependencies.join("、")}`);
    }
    const forkName = `${source.name} 副本`;
    const forkInput: AgentBuilderInput = {
      name: forkName,
      description: source.description,
      avatar: source.avatar ?? undefined,
      type: normalizeAgentBuilderType(readString(sourceConfig, ["profile", "agentType"]) ?? source.type),
      category: readString(sourceConfig, ["profile", "category"]) ?? "custom",
      capabilities: Array.isArray(source.capabilities) ? source.capabilities as string[] : [],
      visibility: "private",
      rolePrompt: readString(sourceConfig, ["prompt", "role"]) ?? source.description,
      goals: readStringArray(sourceConfig, ["prompt", "goals"]),
      behaviorRules: readStringArray(sourceConfig, ["prompt", "behaviorRules"]),
      outputRules: readStringArray(sourceConfig, ["prompt", "outputRules"]),
      refusalRules: readStringArray(sourceConfig, ["prompt", "refusalRules"]),
      skillAssetIds: readBindingIds(sourceConfig, "skills"),
      toolIds: readBindingIds(sourceConfig, "tools"),
      knowledgeAssetIds: readBindingIds(sourceConfig, "knowledge"),
      knowledgeBindings: readKnowledgeBindings(sourceConfig),
      model: asRecord(sourceConfig.model) as AgentBuilderInput["model"],
      runtime: asRecord(sourceConfig.runtime) as AgentBuilderInput["runtime"],
      collaboration: asRecord(sourceConfig.collaboration) as AgentBuilderInput["collaboration"],
      workspace: asRecord(sourceConfig.workspace) as AgentBuilderInput["workspace"],
      memory: asRecord(sourceConfig.memory) as AgentBuilderInput["memory"],
      permissions: asRecord(sourceConfig.permissions) as AgentBuilderInput["permissions"],
      output: asRecord(sourceConfig.output) as AgentBuilderInput["output"],
      publishing: asRecord(sourceConfig.publishing) as AgentBuilderInput["publishing"]
    };
    const now = new Date().toISOString();
    const agentId = await this.nextAgentId(forkName);
    const agentVersionId = `agent-version-${agentId}-1`;
    const config = await this.buildAgentConfig(currentUser, agentId, forkInput, {
      createdAt: now,
      copiedFrom: {
        agentId: source.id,
        version: latest?.version ?? "1.0.0",
        copiedAt: now,
        copiedBy: currentUser.id
      },
      version: "1.0.0"
    });
    const fork = await this.prisma.$transaction(async (tx) => {
      const created = await tx.agent.create({
        data: {
          id: agentId,
          name: forkName,
          avatar: source.avatar,
          type: source.type,
          provider: source.provider,
          description: source.description,
          capabilities: source.capabilities as Prisma.InputJsonValue,
          visibility: "private",
          status: "available",
          versions: {
            create: {
              id: agentVersionId,
              version: "1.0.0",
              config: config as Prisma.InputJsonValue
            }
          },
          installations: {
            create: {
              id: `agent-install-${agentId}-user-${currentUser.id}`,
              ownerType: "user",
              ownerId: currentUser.id,
              config: { alias: agentId.replace(/^agent-/, ""), enabled: true, source: "forked" } as Prisma.InputJsonValue
            }
          }
        }
      });
      await this.createAgentComponentBindings(tx, { agentId, agentVersionId, config });
      await tx.auditLog.create({
        data: {
          actorUserId: currentUser.id,
          action: "agent.fork",
          targetType: "agent",
          targetId: agentId,
          payload: { sourceAgentId: id, sourceVersion: latest?.version ?? null } as Prisma.InputJsonValue
        }
      });
      return created;
    });
    const installation = await this.currentUserInstallation(agentId, currentUser.id);
    return { agent: toAgentDefinition({ ...fork, versions: [{ config }], ...(installation ? { installations: [installation] } : {}) }), config };
  }

  async installAgent(currentUser: AgentHubUser, agentId: string, input: { ownerType?: "user" | "team"; ownerId?: string; config?: unknown }) {
    const agent = await this.prisma.agent.findFirst({ where: { id: agentId, deletedAt: null } });
    if (!agent || (agent.visibility !== "public" && currentUser.role !== "admin")) throw new NotFoundException("Agent not found");
    const latest = await this.latestAgentVersion(agentId);
    const ownerType = input.ownerType ?? "user";
    const ownerId = input.ownerId ?? currentUser.id;
    await this.assertCanManageInstallationOwner(currentUser, ownerType, ownerId);
    const snapshot = agentSourceSnapshot(agent, latest ?? undefined);
    const config = agentInstallConfigWithSnapshot(input.config, snapshot);
    const installation = await this.prisma.$transaction(async (tx) => {
      const row = await tx.agentInstallation.upsert({
        where: { agentId_ownerType_ownerId: { agentId, ownerType, ownerId } },
        create: {
          id: `agent-install-${agentId}-${ownerType}-${ownerId}`,
          agentId,
          ownerType,
          ownerId,
          config
        },
        update: {
          config,
          deletedAt: null
        }
      });
      await this.upsertAgentHubSubscription(tx, {
        agentId,
        ownerType,
        ownerId,
        snapshot,
        config,
        updateAvailable: false,
        conflictStatus: null,
        status: "active"
      });
      return row;
    });
    return { installation: toAgentInstallationView(installation, agent, latest ?? undefined), agent: toAgentDefinition({ ...agent, ...(latest ? { versions: [latest] } : {}), installations: [installation] }) };
  }

  async syncInstalledAgent(
    currentUser: AgentHubUser,
    agentId: string,
    input: { ownerType?: "user" | "team"; ownerId?: string; confirmRiskChanges?: boolean } = {}
  ) {
    const agent = await this.prisma.agent.findFirst({ where: { id: agentId, deletedAt: null, visibility: "public" } });
    if (!agent) throw new NotFoundException("Agent not found");
    const latest = await this.latestAgentVersion(agentId);
    const ownerType = input.ownerType ?? "user";
    const ownerId = input.ownerId ?? currentUser.id;
    await this.assertCanManageInstallationOwner(currentUser, ownerType, ownerId);
    const installation = await this.prisma.agentInstallation.findFirst({
      where: { agentId, ownerType, ownerId, deletedAt: null }
    });
    if (!installation) throw new NotFoundException("Agent installation not found");
    const nextSnapshot = agentSourceSnapshot(agent, latest ?? undefined);
    const governance = agentInstallUpdateGovernance(installation, nextSnapshot);
    if (governance.requiresConfirmation && input.confirmRiskChanges !== true) {
      const previousSnapshot = installedAgentSource(installation.config) ?? nextSnapshot;
      const previousConfig = agentInstallConfigWithSnapshot(installation.config, previousSnapshot);
      await this.prisma.$transaction(async (tx) => {
        await this.upsertAgentHubSubscription(tx, {
          agentId,
          ownerType,
          ownerId,
          snapshot: previousSnapshot,
          config: previousConfig,
          updateAvailable: true,
          conflictStatus: agentInstallConflictStatus(governance),
          status: "active"
        });
      });
      throw new BadRequestException("Agent 更新涉及新增权限或工具，需要确认后同步");
    }
    const nextConfig = agentInstallConfigWithSnapshot(installation.config, nextSnapshot);
    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.agentInstallation.update({
        where: { id: installation.id },
        data: {
          config: nextConfig,
          deletedAt: null
        }
      });
      await this.upsertAgentHubSubscription(tx, {
        agentId,
        ownerType,
        ownerId,
        snapshot: nextSnapshot,
        config: nextConfig,
        updateAvailable: false,
        conflictStatus: null,
        status: "active"
      });
      return row;
    });
    await this.prisma.auditLog.create({
      data: {
        actorUserId: currentUser.id,
        action: "agent.install.sync",
        targetType: "agent",
        targetId: agentId,
        payload: { ownerType, ownerId, version: nextSnapshot.version, governance } as Prisma.InputJsonValue
      }
    });
    return {
      installation: toAgentInstallationView(updated, agent, latest ?? undefined),
      agent: toAgentDefinition({ ...agent, ...(latest ? { versions: [latest] } : {}), installations: [updated] }),
      governance
    };
  }

  async uninstallAgent(currentUser: AgentHubUser, agentId: string, ownerType = "user", ownerId = currentUser.id) {
    await this.assertCanManageInstallationOwner(currentUser, ownerType, ownerId);
    const installation = await this.prisma.agentInstallation.findFirst({
      where: { agentId, ownerType, ownerId, deletedAt: null }
    });
    if (!installation) throw new NotFoundException("Agent installation not found");
    const removedAt = new Date();
    await this.prisma.$transaction(async (tx) => {
      await tx.agentInstallation.update({
        where: { id: installation.id },
        data: { deletedAt: removedAt }
      });
      await tx.hubSubscription.updateMany({
        where: { kind: "agent", assetId: agentId, ownerType, ownerId, deletedAt: null },
        data: { deletedAt: removedAt, status: "removed", updateAvailable: false, conflictStatus: null }
      });
    });
    return { installationId: installation.id, agentId, ownerType, ownerId };
  }

  async deleteAgent(currentUser: AgentHubUser, id: string) {
    const agent = await this.prisma.agent.findFirst({
      where: { id, deletedAt: null },
      include: latestAgentDefinitionInclude()
    });
    if (!agent) throw new NotFoundException("Agent not found");
    if (!latestConfigMetadata(agent).custom && currentUser.role !== "admin") {
      throw new ForbiddenException("Only custom Agents can be deleted");
    }
    await this.assertCanEditAgent(currentUser, agent);
    const removedAt = new Date();
    await this.prisma.$transaction(async (tx) => {
      await tx.agent.update({
        where: { id },
        data: { deletedAt: removedAt }
      });
      await tx.agentInstallation.updateMany({
        where: { agentId: id, deletedAt: null },
        data: { deletedAt: removedAt }
      });
      await tx.agentComponentBinding.updateMany({
        where: { agentId: id, deletedAt: null },
        data: { deletedAt: removedAt }
      });
      await tx.hubSubscription.updateMany({
        where: { kind: "agent", assetId: id, deletedAt: null },
        data: { deletedAt: removedAt, status: "removed", updateAvailable: false, conflictStatus: null }
      });
      await tx.auditLog.create({
        data: {
          actorUserId: currentUser.id,
          action: "agent.delete",
          targetType: "agent",
          targetId: id,
          payload: { deletedAt: removedAt.toISOString() } as Prisma.InputJsonValue
        }
      });
    });
    return { agentId: id, deletedAt: removedAt.toISOString() };
  }

  async listInstallations(currentUser: AgentHubUser) {
    const where: Prisma.AgentInstallationWhereInput = currentUser.role === "admin"
      ? { deletedAt: null }
      : await this.accessibleInstallationFilter(currentUser.id);
    const installations = await this.prisma.agentInstallation.findMany({
      where,
      include: { agent: { include: latestAgentDefinitionInclude() } },
      orderBy: { updatedAt: "desc" }
    });
    return installations.map((installation) => ({
      installation: toAgentInstallationView(installation, installation.agent, installation.agent.versions?.[0]),
      agent: toAgentDefinition({ ...installation.agent, installations: [installation] })
    }));
  }

  async getAgentStatus(currentUser: AgentHubUser, id: string) {
    const agent = await this.prisma.agent.findFirst({ where: { id, ...(await this.visibleAgentWhere(currentUser)) } });
    if (!agent) return undefined;
    const [recentAgentRuns, activeAgentRuns, currentToolRuns] = await Promise.all([
      this.prisma.agentRun.findMany({
        where: { agentId: id, deletedAt: null },
        orderBy: { startedAt: "desc" },
        take: 10,
        include: { run: true }
      }),
      this.prisma.agentRun.findMany({
        where: { agentId: id, deletedAt: null, status: { in: ["queued", "running", "needs_clarification"] } },
        orderBy: { startedAt: "asc" },
        include: { run: true }
      }),
      this.prisma.toolRun.findMany({
        where: {
          deletedAt: null,
          callerType: "agent",
          callerId: id,
          status: { in: ["queued", "running"] }
        },
        orderBy: { createdAt: "desc" },
        take: 10
      })
    ]);
    const recentAgentRunIds = recentAgentRuns.map((run) => run.id);
    const stepEvents = recentAgentRunIds.length
      ? await this.prisma.runtimeEvent.findMany({
          where: {
            scopeKind: "agent_run",
            scopeId: { in: recentAgentRunIds },
            type: { in: ["agent_run.step.started", "agent_run.step.completed", "agent_run.step.failed"] }
          },
          orderBy: { createdAt: "asc" }
        })
      : [];
    const stepEventsByRunId = new Map<string, typeof stepEvents>();
    for (const event of stepEvents) {
      const list = stepEventsByRunId.get(event.scopeId) ?? [];
      list.push(event);
      stepEventsByRunId.set(event.scopeId, list);
    }
    const runIds = Array.from(new Set(activeAgentRuns.map((run) => run.runId).filter(Boolean) as string[]));
    const activeRuns = runIds.length
      ? await this.prisma.orchestratorRun.findMany({
          where: { id: { in: runIds }, deletedAt: null },
          orderBy: { startedAt: "desc" }
        })
      : [];
    const queue = {
      queued: recentAgentRuns.filter((run) => run.status === "queued").length,
      running: recentAgentRuns.filter((run) => run.status === "running").length,
      needsClarification: recentAgentRuns.filter((run) => run.status === "needs_clarification").length,
      failed: recentAgentRuns.filter((run) => run.status === "failed").length
    };
    return {
      agent: toAgentDefinition(agent),
      queue,
      locks: activeRuns.map((run) => ({
        runId: run.id,
        conversationId: run.conversationId,
        status: run.status,
        currentNode: run.currentNode,
        waitingOn: run.waitingOn,
        blockers: asRecord(run.workingMemory)?.blockers ?? []
      })),
      currentToolRuns: currentToolRuns.map((toolRun) => ({
        id: toolRun.id,
        runId: toolRun.runId,
        toolId: toolRun.toolId,
        status: toolRun.status,
        input: toolRun.input,
        output: toolRun.output,
        error: toolRun.error,
        createdAt: toolRun.createdAt.toISOString()
      })),
      recentAgentRuns: recentAgentRuns.map((run) => ({
        id: run.id,
        runId: run.runId,
        conversationId: run.run?.conversationId ?? null,
        status: run.status,
        input: run.input,
        output: run.output,
        internalTraceRef: run.internalTraceRef,
        startedAt: run.startedAt.toISOString(),
        completedAt: run.completedAt?.toISOString() ?? null,
        stepEvents: (stepEventsByRunId.get(run.id) ?? []).map((event) => ({
          type: event.type,
          seq: event.seq,
          payload: event.payload,
          createdAt: event.createdAt.toISOString()
        }))
      }))
    };
  }

  async approveAgentToolRun(currentUser: AgentHubUser, agentId: string, toolRunId: string) {
    const toolRun = await this.assertCanDecideAgentToolRun(currentUser, agentId, toolRunId);
    if (!this.toolRuntime) throw new BadRequestException("Tool runtime is not available");
    const result = await this.toolRuntime.approveQueuedToolRun(toolRun.id, currentUser.id);
    const runtimeJob = await this.enqueueAgentToolApprovalResumeJob(toolRun.id, toolRun.input);
    await this.prisma.auditLog.create({
      data: {
        actorUserId: currentUser.id,
        action: "agent.tool.approve",
        targetType: "tool_run",
        targetId: toolRun.id,
        payload: {
          agentId,
          toolId: toolRun.toolId,
          runId: toolRun.runId,
          resultStatus: result.status
        } as Prisma.InputJsonValue
      }
    });
    return { result, runtimeJob };
  }

  async rejectAgentToolRun(currentUser: AgentHubUser, agentId: string, toolRunId: string, reason?: string) {
    const toolRun = await this.assertCanDecideAgentToolRun(currentUser, agentId, toolRunId);
    if (!this.toolRuntime) throw new BadRequestException("Tool runtime is not available");
    const result = await this.toolRuntime.rejectQueuedToolRun(toolRun.id, currentUser.id, reason);
    const runtimeJob = await this.enqueueAgentToolApprovalResumeJob(toolRun.id, toolRun.input);
    await this.prisma.auditLog.create({
      data: {
        actorUserId: currentUser.id,
        action: "agent.tool.reject",
        targetType: "tool_run",
        targetId: toolRun.id,
        payload: {
          agentId,
          toolId: toolRun.toolId,
          runId: toolRun.runId,
          reason: reason ?? null
        } as Prisma.InputJsonValue
      }
    });
    return { result, runtimeJob };
  }

  private async enqueueAgentToolApprovalResumeJob(toolRunId: string, input: unknown) {
    if (!readQueuedApprovalResumeState(input)) return null;
    const now = new Date();
    const job = await this.prisma.runtimeJob.upsert({
      where: {
        kind_targetType_targetId: {
          kind: "agent_tool_approval_resume",
          targetType: "tool_run",
          targetId: toolRunId
        }
      },
      create: {
        id: `runtime-job-${nanoid(10)}`,
        kind: "agent_tool_approval_resume",
        status: "queued",
        targetType: "tool_run",
        targetId: toolRunId,
        payload: { toolRunId } as Prisma.InputJsonValue,
        maxAttempts: 1,
        availableAt: now
      },
      update: {
        status: "queued",
        payload: { toolRunId } as Prisma.InputJsonValue,
        attempts: 0,
        maxAttempts: 1,
        availableAt: now,
        leaseOwner: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
        cancelRequested: false,
        startedAt: null,
        completedAt: null,
        failedAt: null,
        error: null,
        deletedAt: null
      }
    });
    return {
      id: job.id,
      status: job.status,
      targetType: job.targetType,
      targetId: job.targetId
    };
  }

  private async assertCanManageInstallationOwner(currentUser: AgentHubUser, ownerType: string, ownerId: string) {
    if (ownerType === "user") {
      if (ownerId !== currentUser.id && currentUser.role !== "admin") throw new BadRequestException("Cannot manage another user's Agent installation");
      return;
    }
    if (ownerType === "team") {
      if (currentUser.role === "admin") return;
      const membership = await this.prisma.teamMember.findFirst({
        where: { teamId: ownerId, userId: currentUser.id, role: "owner", deletedAt: null }
      });
      if (!membership) throw new BadRequestException("Only team owners can manage team Agent installations");
      return;
    }
    throw new BadRequestException("Unsupported Agent installation owner type");
  }

  private async visibleAgentWhere(
    currentUser?: AgentHubUser,
    scope?: "personal" | "public",
    options: { includeSystem?: boolean } = {}
  ): Promise<Prisma.AgentWhereInput> {
    const base: Prisma.AgentWhereInput = { deletedAt: null };
    if (!options.includeSystem) {
      base.NOT = [
        { id: { in: [...hiddenSystemAgentIds] } },
        { type: "orchestrator" }
      ];
    }
    if (!currentUser || scope === "public") return { ...base, visibility: "public" };
    if (currentUser.role === "admin") return base;
    const installationFilter = await this.accessibleInstallationFilter(currentUser.id);
    if (scope === "personal") {
      return {
        ...base,
        OR: [
          { id: { in: builtInAgentIds } },
          { installations: { some: installationFilter } }
        ]
      };
    }
    return {
      ...base,
      OR: [
        { visibility: "public" },
        { installations: { some: installationFilter } }
      ]
    };
  }

  private async accessibleInstallationFilter(userId: string): Promise<Prisma.AgentInstallationWhereInput> {
    const teamIds = await this.prisma.teamMember.findMany({
      where: { userId, deletedAt: null, team: { deletedAt: null } },
      select: { teamId: true }
    });
    const owners: Prisma.AgentInstallationWhereInput[] = [
      { ownerType: "user", ownerId: userId },
      ...(teamIds.length > 0 ? [{ ownerType: "team", ownerId: { in: teamIds.map((team) => team.teamId) } }] : [])
    ];
    return { deletedAt: null, OR: owners };
  }

  private async latestAgentVersion(agentId: string) {
    return this.prisma.agentVersion.findFirst({
      where: { agentId, deletedAt: null },
      orderBy: { createdAt: "desc" }
    });
  }

  private async currentUserInstallation(agentId: string, userId: string) {
    return this.prisma.agentInstallation.findFirst({
      where: { agentId, ownerType: "user", ownerId: userId, deletedAt: null }
    });
  }

  private async createAgentComponentBindings(
    tx: Prisma.TransactionClient,
    input: {
      agentId: string;
      agentVersionId: string;
      config: Record<string, unknown>;
    }
  ) {
    const data = buildAgentComponentBindingRows(input);
    if (data.length === 0) return;
    await tx.agentComponentBinding.createMany({
      data,
      skipDuplicates: true
    });
  }

  private async upsertAgentHubSubscription(
    tx: Prisma.TransactionClient,
    input: {
      agentId: string;
      ownerType: string;
      ownerId: string;
      snapshot: AgentInstallSourceSnapshot;
      config: Prisma.InputJsonValue;
      updateAvailable: boolean;
      conflictStatus: string | null;
      status: string;
    }
  ) {
    const sourceVersion = agentHubVersionNumber(input.snapshot.version);
    const sourceFingerprint = input.snapshot.fingerprint ?? fingerprintUnknown(input.snapshot) ?? input.agentId;
    await tx.hubSubscription.upsert({
      where: {
        kind_assetId_ownerType_ownerId: {
          kind: "agent",
          assetId: input.agentId,
          ownerType: input.ownerType,
          ownerId: input.ownerId
        }
      },
      create: {
        id: `hub-sub-agent-${input.agentId}-${input.ownerType}-${input.ownerId}`,
        kind: "agent",
        assetId: input.agentId,
        ownerType: input.ownerType,
        ownerId: input.ownerId,
        sourceVersion,
        sourceFingerprint,
        installedVersion: sourceVersion,
        status: input.status,
        updateAvailable: input.updateAvailable,
        conflictStatus: input.conflictStatus,
        config: input.config
      },
      update: {
        sourceVersion,
        sourceFingerprint,
        installedVersion: sourceVersion,
        status: input.status,
        updateAvailable: input.updateAvailable,
        conflictStatus: input.conflictStatus,
        deletedAt: null,
        config: input.config
      }
    });
  }

  private async assertCanDecideAgentToolRun(currentUser: AgentHubUser, agentId: string, toolRunId: string) {
    const agent = await this.prisma.agent.findFirst({
      where: {
        id: agentId,
        ...(await this.visibleAgentWhere(currentUser))
      }
    });
    if (!agent) throw new NotFoundException("Agent not found");
    const toolRun = await this.prisma.toolRun.findFirst({
      where: {
        id: toolRunId,
        callerType: "agent",
        callerId: agentId,
        deletedAt: null
      }
    });
    if (!toolRun) throw new NotFoundException("Tool run not found");
    if (toolRun.status !== "queued") throw new BadRequestException("Tool run is not waiting for approval");
    if (currentUser.role === "admin") return toolRun;
    const conversationId = readQueuedApprovalConversationId(toolRun.input);
    if (!conversationId) throw new BadRequestException("Tool approval is missing conversation context");
    const membership = await this.prisma.conversationMember.findFirst({
      where: {
        conversationId,
        memberType: "user",
        memberId: currentUser.id,
        deletedAt: null
      }
    });
    if (!membership) throw new ForbiddenException("Cannot approve a tool run outside your conversation");
    return toolRun;
  }

  private async assertCanEditAgent(currentUser: AgentHubUser, agent: Agent) {
    if (currentUser.role === "admin") return;
    const latest = await this.latestAgentVersion(agent.id);
    const config = asRecord(latest?.config);
    const ownerUserId = readString(config, ["publishing", "ownerUserId"]);
    if (ownerUserId === currentUser.id) return;
    const installation = await this.currentUserInstallation(agent.id, currentUser.id);
    if (installation && agent.visibility === "private") return;
    throw new ForbiddenException("Cannot edit this Agent");
  }

  private async toAgentDefinitionView(agent: Agent & { installations?: AgentInstallation[]; versions?: Array<{ config: unknown; version?: string }> }) {
    const item = toAgentDefinition(agent);
    if (item.visibility !== "public") return item;
    const config = asRecord(agent.versions?.[0]?.config) ?? {};
    const privateDependencies = await this.privateForkDependencyNames(config);
    if (privateDependencies.length > 0) {
      item.forkable = false;
      item.forkDisabledReason = `绑定私有 Skill/Tool/Knowledge：${privateDependencies.join("、")}`;
    } else {
      item.forkable = true;
    }
    return item;
  }

  private async nextAgentId(name: string) {
    const slug = toAsciiSlug(name) || "custom";
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const id = `agent-${slug}-${nanoid(6).toLowerCase()}`;
      const existing = await this.prisma.agent.findUnique({ where: { id } });
      if (!existing) return id;
    }
    return `agent-custom-${nanoid(10).toLowerCase()}`;
  }

  private async buildAgentConfig(
    currentUser: AgentHubUser,
    agentId: string,
    input: AgentBuilderInput,
    meta: {
      createdAt: string;
      copiedFrom: Prisma.InputJsonValue | null;
      version: string;
    }
  ) {
    const skills = await this.resolveSkillBindings(currentUser, input.skillAssetIds ?? []);
    const requestedKnowledgeBindings = input.knowledgeBindings
      ?? (input.knowledgeAssetIds ?? []).map((assetId) => ({ assetId, retrievalMode: "rag" as const }));
    const knowledge = await this.resolveKnowledgeBindings(currentUser, requestedKnowledgeBindings);
    const tools = await this.resolveToolBindings(currentUser, input.toolIds ?? []);
    const runtimeInput = asRecord(input.runtime) ?? {};
    const collaborationInput = asRecord(input.collaboration) ?? {};
    const workspaceInput = asRecord(input.workspace) ?? {};
    const modelInput = asRecord(input.model) ?? {};
    const permissionInput = asRecord(input.permissions) ?? {};
    const outputInput = asRecord(input.output) ?? {};
    const publishingInput = asRecord(input.publishing) ?? {};
    const capabilities = normalizeStringList(input.capabilities).slice(0, 12);
    return {
      schemaVersion: "agent-config.v1",
      profile: {
        name: input.name.trim(),
        avatar: normalizeOptionalString(input.avatar) ?? "/avatars/agents/agent-v2-07.png",
        description: input.description.trim(),
        agentType: normalizeAgentBuilderType(input.type),
        category: normalizeOptionalString(input.category) ?? "custom",
        tags: capabilities,
        mentionAliases: [agentId.replace(/^agent-/, ""), input.name.trim()].filter(Boolean)
      },
      runtime: {
        kind: "internal_llm",
        workflowTemplate: normalizeEnumString(runtimeInput.workflowTemplate, ["direct_answer", "tool_loop", "artifact_generation", "review", "human_approval"], "tool_loop"),
        maxToolSteps: clampInteger(runtimeInput.maxToolSteps, 4, 1, 12),
        maxRunSeconds: clampInteger(runtimeInput.maxRunSeconds, 180, 30, 1800)
      },
      collaboration: {
        orchestratorCallable: collaborationInput.orchestratorCallable !== false,
        dispatchTags: normalizeStringList(collaborationInput.dispatchTags).length > 0
          ? normalizeStringList(collaborationInput.dispatchTags)
          : inferDispatchTags(input.type, input.category, capabilities),
        assignmentDescription: normalizeOptionalString(collaborationInput.assignmentDescription) ?? input.description.trim(),
        acknowledgeOnAssignment: collaborationInput.acknowledgeOnAssignment !== false
      },
      workspace: {
        docRead: workspaceInput.docRead !== false,
        docWrite: workspaceInput.docWrite !== false,
        codeRead: workspaceInput.codeRead !== false,
        codeWrite: workspaceInput.codeWrite === true,
        assetCreate: workspaceInput.assetCreate !== false
      },
      model: {
        provider: normalizeOptionalString(modelInput.provider) ?? "runtime_default",
        model: normalizeOptionalString(modelInput.model) ?? "runtime_default",
        ...(typeof modelInput.temperature === "number" ? { temperature: clampNumber(modelInput.temperature, 0, 2) } : {}),
        reasoningEffort: normalizeEnumString(modelInput.reasoningEffort, ["none", "minimal", "low", "medium", "high", "xhigh"], "high"),
        streaming: modelInput.streaming === true,
        ...(normalizeOptionalString(modelInput.fallbackModel) ? { fallbackModel: normalizeOptionalString(modelInput.fallbackModel) } : {})
      },
      prompt: {
        role: normalizeOptionalString(input.rolePrompt) ?? input.description.trim(),
        goals: normalizeStringList(input.goals).length > 0 ? normalizeStringList(input.goals) : [input.description.trim()],
        behaviorRules: normalizeStringList(input.behaviorRules),
        outputRules: normalizeStringList(input.outputRules),
        refusalRules: normalizeStringList(input.refusalRules)
      },
      capabilities,
      tools,
      skills,
      knowledge,
      memory: {
        useConversationMemory: input.memory?.useConversationMemory ?? true,
        usePinnedMessages: input.memory?.usePinnedMessages ?? true,
        usePersonalCrossConversationMemory: input.memory?.usePersonalCrossConversationMemory ?? true,
        writeBackPolicy: normalizeEnumString(input.memory?.writeBackPolicy, ["none", "summary_only", "confirmed_only"], "summary_only")
      },
      permissions: {
        scopes: normalizeStringList(permissionInput.scopes).length > 0
          ? normalizeStringList(permissionInput.scopes)
          : ["message:read", "message:write", "workspace:read"],
        requireApprovalFor: normalizeStringList(permissionInput.requireApprovalFor)
      },
      output: {
        defaultFormat: normalizeEnumString(outputInput.defaultFormat, ["markdown", "json", "artifact"], "markdown"),
        allowedBlocks: normalizeStringList(outputInput.allowedBlocks).length > 0
          ? normalizeStringList(outputInput.allowedBlocks)
          : ["markdown", "file", "image", "web_preview", "diff", "agent_status"]
      },
      publishing: {
        ownerUserId: currentUser.id,
        visibility: input.visibility ?? "private",
        version: meta.version,
        ...(normalizeOptionalString(publishingInput.license) ? { license: normalizeOptionalString(publishingInput.license) } : {}),
        ...(normalizeOptionalString(publishingInput.changelog) ? { changelog: normalizeOptionalString(publishingInput.changelog) } : {})
      },
      lineage: {
        createdAt: meta.createdAt,
        copiedFrom: meta.copiedFrom
      }
    };
  }

  private async resolveSkillBindings(currentUser: AgentHubUser, skillAssetIds: string[]) {
    const ids = normalizeStringList(skillAssetIds);
    if (ids.length === 0) return [];
    const accessFilters = await this.visibleHubAssetAccessFilters(currentUser);
    const indexed = await this.prisma.skillAsset.findMany({
      where: {
        deletedAt: null,
        AND: [
          { OR: [{ id: { in: ids } }, { sourceAssetId: { in: ids } }] },
          ...(accessFilters.length > 0 ? [{ OR: accessFilters }] : [])
        ]
      },
      include: { versions: { where: { deletedAt: null }, orderBy: { version: "desc" }, take: 1 } },
      orderBy: { updatedAt: "desc" }
    });
    const indexByInputId = new Map(indexed.flatMap((asset) => [
      [asset.id, asset] as const,
      [asset.sourceAssetId, asset] as const
    ]));
    const sourceAssetIds = [...new Set([...indexed.map((asset) => asset.sourceAssetId), ...ids])];
    const assets = await this.loadVisibleWorkspaceAssetsById(currentUser, sourceAssetIds, true);
    const byId = new Map(assets.map((asset) => [asset.id, asset]));
    const bindings = ids.flatMap((assetId, index) => {
      const hubIndex = indexByInputId.get(assetId);
      const sourceAssetId = hubIndex?.sourceAssetId ?? assetId;
      const asset = byId.get(sourceAssetId);
      if (!asset && !hubIndex) return [];
      if (!asset && hubIndex) {
        const spec = asRecord(hubIndex.versions[0]?.spec);
        const source = asRecord(spec?.source);
        const path = normalizeOptionalString(source?.path) ?? `skill://${hubIndex.id}`;
        return [{
          id: `skill-binding-${hubIndex.id}`,
          skillAssetId: hubIndex.id,
          name: hubIndex.name,
          summary: hubIndex.description,
          path,
          enabled: true,
          injectionMode: hubIndex.injectionMode ?? "agent_decides",
          priority: index + 1
        }];
      }
      return [{
        id: `skill-binding-${sourceAssetId}`,
        skillAssetId: sourceAssetId,
        name: hubIndex?.name ?? asset!.name,
        summary: hubIndex?.description ?? asset!.summary ?? "",
        path: asset!.path,
        enabled: true,
        injectionMode: hubIndex?.injectionMode ?? "agent_decides",
        priority: index + 1
      }];
    });
    if (bindings.length !== ids.length) throw new BadRequestException("Some Skill assets do not exist or are not accessible");
    return bindings;
  }

  private async resolveKnowledgeBindings(
    currentUser: AgentHubUser,
    requestedBindings: Array<{ assetId: string; retrievalMode: "query" | "rag" }>
  ) {
    const normalizedBindings = requestedBindings.reduce<Array<{ assetId: string; retrievalMode: "query" | "rag" }>>((result, binding) => {
      const assetId = normalizeOptionalString(binding.assetId);
      if (!assetId || result.some((item) => item.assetId === assetId)) return result;
      result.push({ assetId, retrievalMode: binding.retrievalMode === "query" ? "query" : "rag" });
      return result;
    }, []);
    const ids = normalizedBindings.map((binding) => binding.assetId);
    if (ids.length === 0) return [];
    const retrievalModeById = new Map(normalizedBindings.map((binding) => [binding.assetId, binding.retrievalMode]));
    const accessFilters = await this.visibleHubAssetAccessFilters(currentUser);
    const indexed = await this.prisma.knowledgeAsset.findMany({
      where: {
        deletedAt: null,
        AND: [
          { OR: [{ id: { in: ids } }, { sourceAssetId: { in: ids } }] },
          ...(accessFilters.length > 0 ? [{ OR: accessFilters }] : [])
        ]
      },
      orderBy: { updatedAt: "desc" }
    });
    const indexByInputId = new Map(indexed.flatMap((asset) => [
      [asset.id, asset] as const,
      [asset.sourceAssetId, asset] as const
    ]));
    const sourceAssetIds = [...new Set(indexed.map((asset) => asset.sourceAssetId))];
    const missingLegacyIds = ids.filter((id) => !indexByInputId.has(id));
    const assets = await this.loadVisibleWorkspaceAssetsById(
      currentUser,
      [...new Set([...sourceAssetIds, ...missingLegacyIds])],
      true
    );
    const byId = new Map(assets.map((asset) => [asset.id, asset]));
    const bindings = ids.flatMap((assetId, index) => {
      const hubIndex = indexByInputId.get(assetId);
      if (!hubIndex) {
        const legacyAsset = byId.get(assetId);
        if (!legacyAsset) return [];
        const metadata = asRecord(legacyAsset.metadata);
        return [{
          id: `knowledge-binding-${legacyAsset.id}`,
          knowledgeAssetId: legacyAsset.id,
          name: legacyAsset.name,
          summary: legacyAsset.summary ?? "",
          path: legacyAsset.path,
          enabled: true,
          retrievalMode: "workspace_asset",
          maxResults: 1,
          priority: index + 1,
          source: "legacy_workspace_asset",
          visibility: normalizeOptionalString(metadata?.visibility) ?? "private"
        }];
      }
      const sourceAssetId = hubIndex.sourceAssetId;
      const asset = byId.get(sourceAssetId);
      const metadata = asRecord(asset?.metadata);
      return [{
        id: `knowledge-binding-${hubIndex.id}`,
        knowledgeAssetId: hubIndex.id,
        name: hubIndex.name,
        summary: hubIndex.summary ?? asset?.summary ?? "",
        path: asset?.path ?? `knowledge://${hubIndex.id}`,
        enabled: true,
        retrievalMode: retrievalModeById.get(assetId) ?? "rag",
        maxResults: 5,
        priority: index + 1,
        source: hubIndex.sourceType ?? "workspace_asset",
        visibility: hubIndex.visibility ?? normalizeOptionalString(metadata?.visibility) ?? "private"
      }];
    });
    if (bindings.length !== ids.length) throw new BadRequestException("Some Knowledge assets do not exist or are not accessible");
    return bindings;
  }

  private async resolveToolBindings(currentUser: AgentHubUser, toolIds: string[]) {
    const ids = normalizeStringList(toolIds);
    if (ids.length === 0) return [];
    const installedPublicToolIds = await this.installedToolIds(currentUser);
    const dbTools = await this.prisma.toolDefinition.findMany({
      where: { id: { in: ids }, deletedAt: null }
    });
    const dbById = new Map(dbTools.map((tool) => [tool.id, tool]));
    const executableIds = executableRuntimeToolIds as readonly string[];
    const bindings = ids.map((toolId, index) => {
      const dbTool = dbById.get(toolId);
      const tool = dbTool ? toolDefinitionRecordToView(dbTool) : toolRegistry.find((item) => item.id === toolId);
      if (!tool) throw new BadRequestException(`Tool 不存在或不可访问：${toolId}`);
      if (dbTool && dbTool.visibility !== "public" && dbTool.ownerId !== currentUser.id && currentUser.role !== "admin") {
        throw new BadRequestException(`Tool 不存在或不可访问：${toolId}`);
      }
      if (requiresToolHubInstallation(tool) && currentUser.role !== "admin" && !installedPublicToolIds.has(tool.id)) {
        throw new BadRequestException(`Tool 未安装，不能绑定到 Agent：${tool.name}`);
      }
      const runtimeToolId = tool.runtimeToolId ?? (executableIds.includes(tool.id) ? tool.id : undefined);
      const executable = tool.executable === true || Boolean(runtimeToolId && executableIds.includes(runtimeToolId));
      const runtimeType = tool.runtimeType ?? (runtimeToolId ? "builtin_alias" : "function");
      if (!executable) {
        throw new BadRequestException(`Tool 不可直接执行，不能绑定到自建 Agent：${tool.name}`);
      }
      return {
        id: `tool-binding-${tool.id}`,
        toolId: tool.id,
        ...(runtimeToolId ? { runtimeToolId } : {}),
        name: tool.name,
        summary: tool.description,
        category: tool.category,
        risk: tool.risk,
        runtimeType,
        metadata: tool.metadata ?? {},
        inputSchema: tool.inputSchema ?? {},
        outputSchema: tool.outputSchema ?? {},
        enabled: true,
        order: index,
        source: tool.source ?? "builtin",
        visibility: tool.visibility ?? "public"
      };
    });
    if (bindings.length !== ids.length) throw new BadRequestException("Some Tools do not exist or are not accessible");
    return bindings;
  }

  private async loadBindableToolViews(currentUser: AgentHubUser) {
    if (this.toolsService) {
      const tools = await this.toolsService.listTools(currentUser, "personal");
      return tools.filter(isBindableToolView);
    }
    const installedPublicToolIds = await this.installedToolIds(currentUser);
    const where: Prisma.ToolDefinitionWhereInput = currentUser.role === "admin"
      ? { deletedAt: null, executable: true }
      : {
          deletedAt: null,
          executable: true,
          OR: [
            { ownerType: "user", ownerId: currentUser.id },
            ...(installedPublicToolIds.size > 0 ? [{ id: { in: [...installedPublicToolIds] } }] : [])
          ]
        };
    const dbTools = await this.prisma.toolDefinition.findMany({
      where,
      orderBy: [{ category: "asc" }, { name: "asc" }]
    });
    const views = dbTools.map(toolDefinitionRecordToView).filter(isBindableToolView);
    const byId = new Map(views.map((tool) => [tool.id, tool]));
    for (const tool of toolRegistry) {
      if (!isBindableToolView(tool)) continue;
      const isCoreRuntimeTool = ["read_file", "write_file"].includes(tool.id);
      const installedPublicTool = installedPublicToolIds.has(tool.id);
      if ((isCoreRuntimeTool || installedPublicTool || currentUser.role === "admin") && !byId.has(tool.id)) {
        byId.set(tool.id, tool);
      }
    }
    return [...byId.values()];
  }

  private async installedToolIds(currentUser: AgentHubUser) {
    if (currentUser.role === "admin") return new Set(publicToolHubToolIds);
    const memberships = await this.prisma.teamMember.findMany({
      where: { userId: currentUser.id, deletedAt: null, team: { deletedAt: null } },
      select: { teamId: true }
    });
    const ownerFilters: Prisma.HubSubscriptionWhereInput[] = [
      { ownerType: "user", ownerId: currentUser.id },
      ...(memberships.length > 0 ? [{ ownerType: "team", ownerId: { in: memberships.map((membership) => membership.teamId) } }] : [])
    ];
    const subscriptions = await this.prisma.hubSubscription.findMany({
      where: {
        kind: "tool",
        deletedAt: null,
        status: { in: ["active", "forked"] },
        OR: ownerFilters
      },
      select: { assetId: true }
    });
    return new Set(subscriptions.map((subscription) => subscription.assetId));
  }

  private async visibleHubAssetAccessFilters(currentUser: AgentHubUser) {
    if (currentUser.role === "admin") return [];
    const memberships = await this.prisma.teamMember.findMany({
      where: { userId: currentUser.id, deletedAt: null, team: { deletedAt: null } },
      select: { teamId: true }
    });
    return [
      { visibility: "public" },
      { ownerType: "system" },
      { ownerType: "user", ownerId: currentUser.id },
      ...(memberships.length > 0 ? [{ ownerType: "team", ownerId: { in: memberships.map((membership) => membership.teamId) } }] : [])
    ];
  }

  private async loadVisibleWorkspaceAssetsById(currentUser: AgentHubUser, assetIds: string[], includePublicAssets: boolean) {
    const ids = normalizeStringList(assetIds);
    if (ids.length === 0) return [] as AgentBuilderWorkspaceAssetRecord[];
    const assets = await this.prisma.workspaceAsset.findMany({
      where: { id: { in: ids }, deletedAt: null },
      include: {
        workspace: {
          include: {
            conversation: {
              include: { members: { where: { memberType: "user", deletedAt: null } } }
            }
          }
        }
      }
    });
    return assets.filter((asset) => isAgentBuilderAssetVisible(asset, currentUser, includePublicAssets));
  }

  private async assertPublishableConfig(config: Record<string, unknown>, options: { confirmHighRisk?: boolean } = {}) {
    const sensitivePromptHits = detectSensitivePromptValues(config);
    if (sensitivePromptHits.length > 0) {
      throw new BadRequestException(`公共 Agent Prompt 疑似包含密钥或敏感凭据：${sensitivePromptHits.join("、")}`);
    }
    const riskItems = collectPublicPublishRiskItems(config);
    if (riskItems.length > 0 && options.confirmHighRisk !== true) {
      throw new BadRequestException(`公共 Agent 包含高风险权限或工具，需要显式确认后发布：${riskItems.join("、")}`);
    }
  }

  private async privateForkDependencyNames(config: Record<string, unknown>) {
    const privateSkillNames = await this.privateHubIndexNames("skill", readBindingIds(config, "skills"));
    const privateKnowledgeNames = await this.privateHubIndexNames("knowledge", readBindingIds(config, "knowledge"));
    const privateToolNames = await this.privateToolNames(readBindingIds(config, "tools"));
    return [...privateSkillNames, ...privateKnowledgeNames, ...privateToolNames];
  }

  private async privateToolNames(ids: string[]) {
    const normalizedIds = normalizeStringList(ids).filter((toolId) => !toolRegistry.some((tool) => tool.id === toolId));
    if (normalizedIds.length === 0) return [];
    const tools = await this.prisma.toolDefinition.findMany({
      where: { id: { in: normalizedIds }, deletedAt: null },
      select: { id: true, name: true, visibility: true }
    });
    const toolsById = new Map(tools.map((tool) => [tool.id, tool]));
    return normalizedIds.flatMap((toolId) => {
      const tool = toolsById.get(toolId);
      if (!tool) return [`${toolId}(missing)`];
      return tool.visibility === "public" ? [] : [tool.name];
    });
  }

  private async privateHubIndexNames(kind: "skill" | "knowledge", ids: string[]) {
    const normalizedIds = normalizeStringList(ids);
    if (normalizedIds.length === 0) return [];
    const rows = kind === "skill"
      ? await this.prisma.skillAsset.findMany({
          where: {
            deletedAt: null,
            OR: [{ id: { in: normalizedIds } }, { sourceAssetId: { in: normalizedIds } }]
          },
          select: { id: true, sourceAssetId: true, name: true, visibility: true }
        })
      : await this.prisma.knowledgeAsset.findMany({
          where: {
            deletedAt: null,
            OR: [{ id: { in: normalizedIds } }, { sourceAssetId: { in: normalizedIds } }]
          },
          select: { id: true, sourceAssetId: true, name: true, visibility: true }
        });
    const byId = new Map(rows.flatMap((row) => [
      [row.id, row] as const,
      [row.sourceAssetId, row] as const
    ]));
    return normalizedIds.flatMap((assetId) => {
      const row = byId.get(assetId);
      if (!row) return [`${assetId}(missing)`];
      return row.visibility === "public" ? [] : [row.name];
    });
  }
}

function latestAgentDefinitionInclude() {
  return {
    versions: {
      where: { deletedAt: null },
      orderBy: { createdAt: "desc" as const },
      take: 1
    }
  };
}

function toAgentDefinition(agent: Agent & { installations?: AgentInstallation[]; versions?: Array<{ config: unknown; version?: string }> }): AgentDefinition {
  const installation = agent.installations?.[0];
  const latestVersion = agent.versions?.[0];
  const source = agentSourceSnapshot(agent, latestVersion);
  const installedSource = installation ? installedAgentSource(installation.config) : null;
  const item: AgentDefinition = {
    id: agent.id,
    name: agent.name,
    avatar: agent.avatar ?? agent.name.slice(0, 2),
    type: agent.type as AgentDefinition["type"],
    description: agent.description,
    capabilities: Array.isArray(agent.capabilities) ? (agent.capabilities as string[]) : [],
    status: agent.status as AgentDefinition["status"],
    visibility: agent.visibility as "private" | "team" | "public",
    ...(installation
      ? {
          installed: true,
          installationId: installation.id,
          installedAt: installation.updatedAt.toISOString(),
          ...(installedSource?.version ? { installedVersion: installedSource.version } : {}),
          ...(source?.version ? { latestVersion: source.version } : {}),
          ...(source && installedSource ? { updateAvailable: isAgentInstallUpdateAvailable(installedSource, source) } : {})
        }
      : {
          installed: false,
          ...(source?.version ? { latestVersion: source.version } : {})
        })
  };
  if (agent.provider) item.provider = agent.provider as NonNullable<AgentDefinition["provider"]>;
  const metadata = latestConfigMetadata(agent);
  if (metadata.custom) item.custom = true;
  if (metadata.sourceAgentId) item.sourceAgentId = metadata.sourceAgentId;
  return item;
}

function toAgentInstallationView(installation: AgentInstallation, agent?: Agent, latestVersion?: { config: unknown; version?: string }) {
  const source = agent ? agentSourceSnapshot(agent, latestVersion) : null;
  const installedSource = installedAgentSource(installation.config);
  return {
    id: installation.id,
    agentId: installation.agentId,
    ownerType: installation.ownerType,
    ownerId: installation.ownerId,
    config: installation.config,
    installedVersion: installedSource?.version,
    sourceVersion: source?.version ?? installedSource?.version,
    updateAvailable: source && installedSource ? isAgentInstallUpdateAvailable(installedSource, source) : false,
    createdAt: installation.createdAt.toISOString(),
    updatedAt: installation.updatedAt.toISOString()
  };
}

function sanitizeInstallConfig(config: unknown) {
  if (!config || typeof config !== "object" || Array.isArray(config)) return Prisma.JsonNull;
  return config as Prisma.InputJsonValue;
}

function sanitizeInstallConfigRecord(config: unknown) {
  const record = asRecord(config) ?? {};
  return { ...record };
}

function agentInstallConfigWithSnapshot(config: unknown, snapshot: AgentInstallSourceSnapshot) {
  const localConfig = sanitizeInstallConfigRecord(config);
  const existingHub = asRecord(localConfig.__hub) ?? {};
  return {
    ...localConfig,
    __hub: {
      ...existingHub,
      installedSource: snapshot,
      installedAt: new Date().toISOString()
    }
  } as unknown as Prisma.InputJsonValue;
}

interface AgentInstallSourceSnapshot {
  kind: "agent";
  agentId: string;
  version: string;
  fingerprint: string | null;
  permissions: string[];
  toolIds: string[];
  capabilityIds: string[];
  risk: "read" | "write" | "external" | "dangerous";
}

function agentSourceSnapshot(agent: Agent, latestVersion?: { config: unknown; version?: string }): AgentInstallSourceSnapshot {
  const fallbackConfig: Record<string, unknown> = {
    id: agent.id,
    name: agent.name,
    provider: agent.provider,
    description: agent.description,
    capabilities: agent.capabilities,
    visibility: agent.visibility
  };
  const config = asRecord(latestVersion?.config) ?? fallbackConfig;
  const permissions = asRecord(config.permissions) ?? {};
  const toolIds = readBindingIds(config, "tools");
  const toolRisks = toolIds.map((toolId) => normalizeRisk(toolRegistry.find((tool) => tool.id === toolId)?.risk));
  const permissionScopes = normalizeStringList([
    ...normalizeStringList(permissions.scopes),
    ...normalizeStringList(permissions.requireApprovalFor),
    ...toolIds.map((toolId) => `tool:${toolId}`)
  ]);
  const workspaceWriteRisk = permissionScopes.some((scope) => scope.includes("write") || scope.includes("delete")) ? "write" : "read";
  return {
    kind: "agent",
    agentId: agent.id,
    version: latestVersion?.version ?? "builtin",
    fingerprint: fingerprintUnknown(config),
    permissions: permissionScopes,
    toolIds,
    capabilityIds: Array.isArray(agent.capabilities) ? agent.capabilities as string[] : [],
    risk: maxRisk([workspaceWriteRisk, ...toolRisks])
  };
}

function installedAgentSource(config: unknown): AgentInstallSourceSnapshot | null {
  const record = asRecord(config);
  const hub = asRecord(record?.__hub);
  const source = asRecord(hub?.installedSource);
  if (!source || source.kind !== "agent") return null;
  const agentId = normalizeOptionalString(source.agentId);
  const version = normalizeOptionalString(source.version);
  if (!agentId || !version) return null;
  return {
    kind: "agent",
    agentId,
    version,
    fingerprint: typeof source.fingerprint === "string" ? source.fingerprint : null,
    permissions: normalizeStringList(source.permissions),
    toolIds: normalizeStringList(source.toolIds),
    capabilityIds: normalizeStringList(source.capabilityIds),
    risk: normalizeRisk(source.risk)
  };
}

function isAgentInstallUpdateAvailable(previous: AgentInstallSourceSnapshot, next: AgentInstallSourceSnapshot) {
  return previous.version !== next.version || previous.fingerprint !== next.fingerprint;
}

function agentInstallUpdateGovernance(installation: AgentInstallation, nextSnapshot: AgentInstallSourceSnapshot) {
  const previous = installedAgentSource(installation.config);
  if (!previous) return { requiresConfirmation: false, changes: [] as Array<Record<string, unknown>> };
  const changes: Array<Record<string, unknown>> = [];
  const addedPermissions = nextSnapshot.permissions.filter((permission) => !previous.permissions.includes(permission));
  const addedTools = nextSnapshot.toolIds.filter((toolId) => !previous.toolIds.includes(toolId));
  if (addedPermissions.length > 0) changes.push({ type: "permission_added", permissions: addedPermissions });
  if (addedTools.length > 0) changes.push({ type: "tool_added", toolIds: addedTools });
  if (riskRank(nextSnapshot.risk) > riskRank(previous.risk)) {
    changes.push({ type: "risk_upgraded", from: previous.risk, to: nextSnapshot.risk });
  }
  return { requiresConfirmation: changes.length > 0, changes };
}

function agentInstallConflictStatus(governance: { changes: Array<Record<string, unknown>> }) {
  if (governance.changes.some((change) => change.type === "risk_upgraded")) return "risk_upgraded";
  if (governance.changes.some((change) => change.type === "permission_added" || change.type === "tool_added")) return "permission_changed";
  return governance.changes.length > 0 ? "update_requires_confirmation" : null;
}

function agentHubVersionNumber(version: string) {
  if (version === "builtin") return 0;
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) return 0;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  return major * 1_000_000 + minor * 1_000 + patch;
}

function normalizeRisk(value: unknown): "read" | "write" | "external" | "dangerous" {
  return value === "write" || value === "external" || value === "dangerous" ? value : "read";
}

function riskRank(value: "read" | "write" | "external" | "dangerous") {
  return { read: 0, write: 1, external: 2, dangerous: 3 }[value];
}

function maxRisk(values: Array<"read" | "write" | "external" | "dangerous">) {
  return values.reduce((max, item) => riskRank(item) > riskRank(max) ? item : max, "read" as "read" | "write" | "external" | "dangerous");
}

function fingerprintUnknown(value: unknown) {
  if (value === undefined || value === null) return null;
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function normalizeOptionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeStringList(value: unknown) {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.flatMap((item) => typeof item === "string" && item.trim() ? [item.trim()] : [])));
}

function normalizeRecordList(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const record = asRecord(item);
    return record ? [record] : [];
  });
}

function normalizedCapabilitiesOrDefault(value: unknown) {
  const capabilities = normalizeStringList(value).slice(0, 12);
  return capabilities.length > 0 ? capabilities : ["custom", "general"];
}

function toAsciiSlug(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 36);
}

function nextSemverPatch(version?: string | null) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version ?? "");
  if (!match) return "1.0.1";
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

function readString(value: unknown, path: string[]) {
  let current: unknown = value;
  for (const segment of path) current = asRecord(current)?.[segment];
  return typeof current === "string" ? current : undefined;
}

function readQueuedApprovalConversationId(value: unknown) {
  return normalizeOptionalString(asRecord(asRecord(value)?.approval)?.conversationId);
}

function readQueuedApprovalResumeState(value: unknown) {
  const resumeState = asRecord(asRecord(asRecord(value)?.approval)?.resumeState);
  return resumeState?.schemaVersion === "agent-tool-approval-resume.v1" ? resumeState : null;
}

function readStringArray(value: unknown, path: string[]) {
  let current: unknown = value;
  for (const segment of path) current = asRecord(current)?.[segment];
  return normalizeStringList(current);
}

function readBindingIds(config: Record<string, unknown>, key: "skills" | "tools" | "knowledge") {
  const bindings = Array.isArray(config[key]) ? config[key] : [];
  return normalizeStringList(bindings.map((binding) => {
    const record = asRecord(binding);
    if (key === "skills") return record?.skillAssetId;
    if (key === "knowledge") return record?.knowledgeAssetId;
    return record?.toolId;
  }));
}

function readKnowledgeBindings(config: Record<string, unknown>): NonNullable<AgentBuilderInput["knowledgeBindings"]> {
  const bindings = Array.isArray(config.knowledge) ? config.knowledge : [];
  return bindings.flatMap((binding) => {
    const record = asRecord(binding);
    const assetId = normalizeOptionalString(record?.knowledgeAssetId);
    if (!assetId) return [];
    return [{
      assetId,
      retrievalMode: record?.retrievalMode === "query" ? "query" as const : "rag" as const
    }];
  });
}

type AgentComponentKind = "tool" | "skill" | "knowledge";

function buildAgentComponentBindingRows(input: {
  agentId: string;
  agentVersionId: string;
  config: Record<string, unknown>;
}): Prisma.AgentComponentBindingCreateManyInput[] {
  const seen = new Set<string>();
  const rows: Prisma.AgentComponentBindingCreateManyInput[] = [];
  const copied = asRecord(asRecord(input.config.lineage)?.copiedFrom) !== null;
  ([
    ["tools", "tool", "toolId"],
    ["skills", "skill", "skillAssetId"],
    ["knowledge", "knowledge", "knowledgeAssetId"]
  ] as Array<["tools" | "skills" | "knowledge", AgentComponentKind, string]>).forEach(([configKey, componentKind, assetKey]) => {
    normalizeRecordList(input.config[configKey]).forEach((binding, index) => {
      const componentAssetId = normalizeOptionalString(binding[assetKey]);
      if (!componentAssetId) return;
      const dedupeKey = `${input.agentVersionId}:${componentKind}:${componentAssetId}`;
      if (seen.has(dedupeKey)) return;
      seen.add(dedupeKey);
      rows.push({
        agentId: input.agentId,
        agentVersionId: input.agentVersionId,
        componentKind,
        componentAssetId,
        source: componentBindingSource(binding, copied),
        versionPolicy: componentBindingVersionPolicy(binding),
        enabled: binding.enabled !== false,
        order: componentBindingOrder(binding, index),
        config: binding as Prisma.InputJsonValue
      });
    });
  });
  return rows;
}

function componentBindingSource(binding: Record<string, unknown>, copied: boolean) {
  if (copied) return "copied";
  const source = normalizeOptionalString(binding.source);
  if (source === "personal" || source === "public_subscription" || source === "copied") return source;
  if (normalizeOptionalString(binding.visibility) === "public") return "public_subscription";
  return "personal";
}

function componentBindingVersionPolicy(binding: Record<string, unknown>) {
  const versionPolicy = normalizeOptionalString(binding.versionPolicy);
  return versionPolicy === "follow_subscription" ? "follow_subscription" : "pinned";
}

function componentBindingOrder(binding: Record<string, unknown>, index: number) {
  if (typeof binding.order === "number" && Number.isFinite(binding.order)) return Math.trunc(binding.order);
  if (typeof binding.priority === "number" && Number.isFinite(binding.priority)) return Math.trunc(binding.priority);
  return index + 1;
}

function formatPromptList(title: string, items: string[]) {
  if (items.length === 0) return "";
  return `${title}：${items.map((item) => `- ${item}`).join("；")}`;
}

function formatBindingList(title: string, items: Record<string, unknown>[], primaryKey: string, secondaryKey: string) {
  if (items.length === 0) return `${title}：无`;
  return `${title}：${items.map((item) => {
    const primary = normalizeOptionalString(item[primaryKey]) ?? normalizeOptionalString(item.id) ?? "unknown";
    const secondary = normalizeOptionalString(item[secondaryKey]);
    return secondary ? `${primary}(${secondary})` : primary;
  }).join("、")}`;
}

function buildSandboxModelView(model: Record<string, unknown>) {
  return {
    provider: normalizeOptionalString(model.provider) ?? "runtime_default",
    model: normalizeOptionalString(model.model) ?? "runtime_default",
    reasoningEffort: normalizeOptionalString(model.reasoningEffort) ?? "high",
    streaming: model.streaming === true,
    ...(typeof model.temperature === "number" ? { temperature: model.temperature } : {}),
    ...(normalizeOptionalString(model.fallbackModel) ? { fallbackModel: normalizeOptionalString(model.fallbackModel) } : {})
  };
}

function buildSandboxRuntimeView(runtime: Record<string, unknown>) {
  return {
    workflowTemplate: normalizeOptionalString(runtime.workflowTemplate) ?? "tool_loop",
    maxToolSteps: typeof runtime.maxToolSteps === "number" ? runtime.maxToolSteps : 4,
    maxRunSeconds: typeof runtime.maxRunSeconds === "number" ? runtime.maxRunSeconds : 180
  };
}

function buildSandboxToolCallLog(tools: Record<string, unknown>[], permissions: Record<string, unknown>) {
  const approvals = normalizeStringList(permissions.requireApprovalFor);
  const registryById = new Map(toolRegistry.map((tool) => [tool.id, tool]));
  return tools.map((tool, index) => {
    const toolId = normalizeOptionalString(tool.toolId) ?? normalizeOptionalString(tool.id) ?? "unknown";
    const definition = registryById.get(toolId);
    const approvalRequired = approvals.some((scope) =>
      scope === toolId
        || scope === `${definition?.category}:*`
        || scope === `${definition?.category}:${definition?.risk}`
        || scope === `tool:${toolId}`
    );
    return {
      step: index + 1,
      toolId,
      name: definition?.name ?? toolId,
      category: definition?.category ?? normalizeOptionalString(tool.source) ?? "custom",
      risk: definition?.risk ?? "unknown",
      status: "not_executed",
      dryRun: true,
      approvalRequired,
      inputPreview: {
        sourceMessage: "sandbox.message",
        reason: "沙盒只记录正式运行时可用工具，不执行外部副作用。"
      },
      outputPreview: null
    };
  });
}

function buildSandboxOutputBlocks(input: {
  output: Record<string, unknown>;
  message: string;
  skills: Record<string, unknown>[];
  tools: Record<string, unknown>[];
  knowledge: Record<string, unknown>[];
}) {
  const allowedBlocks = normalizeStringList(input.output.allowedBlocks);
  const blockSet = new Set(allowedBlocks.length > 0 ? allowedBlocks : ["markdown", "file", "image", "web_preview", "diff", "agent_status"]);
  const defaultFormat = normalizeOptionalString(input.output.defaultFormat) ?? "markdown";
  const blocks: Array<Record<string, unknown>> = [];

  if (blockSet.has("agent_status")) {
    blocks.push({
      type: "agent_status",
      status: "sandbox_preview",
      title: "Agent 沙盒预检",
      detail: "已完成上下文、工具、知识和权限注入预览。"
    });
  }

  if (defaultFormat === "json" && blockSet.has("code")) {
    blocks.push({
      type: "code",
      language: "json",
      title: "JSON 输出协议预览",
      content: {
        answer: "正式运行时由 Agent 根据测试消息生成。",
        sourceMessage: input.message,
        usedSkills: input.skills.map((skill) => normalizeOptionalString(skill.name) ?? normalizeOptionalString(skill.skillAssetId) ?? "skill"),
        availableTools: input.tools.map((tool) => normalizeOptionalString(tool.toolId) ?? normalizeOptionalString(tool.id) ?? "tool")
      }
    });
  } else if (defaultFormat === "artifact" && blockSet.has("file")) {
    blocks.push({
      type: "file",
      title: "产物输出协议预览",
      name: "sandbox-result.md",
      mimeType: "text/markdown",
      path: "sandbox://agent-test/sandbox-result.md",
      summary: "正式运行如果产生较长内容，将写入消息文件卡片或工作空间文档。"
    });
  } else if (blockSet.has("markdown")) {
    blocks.push({
      type: "markdown",
      content: [
        "沙盒已根据当前配置构造正式运行前的消息块预览。",
        `测试消息：${input.message}`,
        `可注入 Skills：${input.skills.length}`,
        `可用 Tools：${input.tools.length}`,
        `可用 Knowledge：${input.knowledge.length}`
      ].join("\n")
    });
  }

  if (blocks.length === 0) {
    blocks.push({
      type: "markdown",
      content: "当前输出协议未启用可预览块，正式运行仍会按 Agent 输出协议生成消息。"
    });
  }
  return blocks;
}

function buildSandboxMemoryCandidate(input: {
  message: string;
  memory: Record<string, unknown>;
  writeMemory: boolean;
}) {
  const writeBackPolicy = normalizeOptionalString(input.memory.writeBackPolicy) ?? "summary_only";
  if (!input.writeMemory || writeBackPolicy === "none") return null;
  return {
    status: "candidate_only",
    wouldPersist: false,
    writeBackPolicy,
    scopes: {
      conversation: input.memory.useConversationMemory !== false,
      pinnedMessages: input.memory.usePinnedMessages !== false,
      personalCrossConversation: input.memory.usePersonalCrossConversationMemory !== false
    },
    summary: `测试消息候选摘要：${input.message.slice(0, 160)}`,
    sourceRefs: [{ type: "sandbox_message", text: input.message.slice(0, 240) }],
    note: "测试沙盒只生成记忆候选；不写入真实会话或个人跨对话记忆。"
  };
}

function sandboxRiskWarnings(input: {
  tools: Record<string, unknown>[];
  permissions: Record<string, unknown>;
  memory: Record<string, unknown>;
  writeMemory: boolean;
}) {
  const scopes = normalizeStringList(input.permissions.scopes);
  const approval = normalizeStringList(input.permissions.requireApprovalFor);
  const warnings: string[] = [];
  if (scopes.some((scope) => /write|delete|deploy|external|danger/i.test(scope))) {
    warnings.push("当前 Agent 含写入、删除、部署或外部访问类权限，正式运行前应确认授权。");
  }
  const riskyTools = input.tools.filter((tool) => {
    const toolId = normalizeOptionalString(tool.toolId) ?? normalizeOptionalString(tool.id) ?? "";
    return /write|delete|deploy|shell|exec|http|browser/i.test(toolId);
  });
  if (riskyTools.length > 0) {
    warnings.push(`绑定了高影响工具：${riskyTools.map((tool) => normalizeOptionalString(tool.toolId) ?? normalizeOptionalString(tool.id) ?? "unknown").join("、")}。`);
  }
  if (approval.length > 0) {
    warnings.push(`以下能力需要运行前确认：${approval.join("、")}。`);
  }
  if (input.writeMemory && input.memory.writeBackPolicy !== "none") {
    warnings.push("本次测试请求包含记忆写回候选，但沙盒不会直接污染真实会话记忆。");
  }
  return warnings;
}

function sanitizeGeneratedAgentDraft(
  userMessage: string,
  llmDraft: z.infer<typeof agentBuilderDraftSchema>,
  inventory: AgentBuilderInventory
): AgentBuilderInput {
  const toolIds = new Set(inventory.tools.map((tool) => tool.id));
  const skillIds = new Set(inventory.skills.map((asset) => asset.assetId));
  const knowledgeIds = new Set(inventory.knowledge.flatMap((asset) => [
    asset.assetId,
    ...(asset.sourceAssetId ? [asset.sourceAssetId] : [])
  ]));
  const selectedTools = normalizeStringList([
    ...llmDraft.toolIds,
    ...(llmDraft.recommendedBindings?.tools ?? []).map((item) => item.toolId)
  ]).filter((toolId) => toolIds.has(toolId));
  const selectedSkillIds = normalizeStringList([
    ...llmDraft.skillAssetIds,
    ...(llmDraft.recommendedBindings?.skills ?? []).map((item) => item.assetId)
  ]).filter((assetId) => skillIds.has(assetId));
  const selectedKnowledgeIds = normalizeStringList([
    ...llmDraft.knowledgeAssetIds,
    ...(llmDraft.recommendedBindings?.knowledge ?? []).map((item) => item.assetId)
  ]).filter((assetId) => knowledgeIds.has(assetId));
  const category = normalizeOptionalString(llmDraft.category) ?? inferAgentCategory(userMessage, llmDraft.capabilities);
  const permissions = asRecord(llmDraft.permissions) ?? {};
  const defaultScopes = ["message:read", "message:write", "workspace:read"];
  const scopes = normalizeStringList(permissions.scopes);
  const requireApprovalFor = new Set(normalizeStringList(permissions.requireApprovalFor));
  for (const toolId of selectedTools) {
    const tool = inventory.tools.find((item) => item.id === toolId);
    if (!tool) continue;
    if (tool.risk === "write" || tool.risk === "external") requireApprovalFor.add(`tool:${toolId}`);
  }
  const runtime = asRecord(llmDraft.runtime) ?? {};
  const collaboration = asRecord(llmDraft.collaboration) ?? {};
  const workspace = asRecord(llmDraft.workspace) ?? {};
  const model = asRecord(llmDraft.model) ?? {};
  const memory = asRecord(llmDraft.memory) ?? {};
  const output = asRecord(llmDraft.output) ?? {};
  const name = normalizeOptionalString(llmDraft.name) ?? defaultAgentName(userMessage);
  const description = normalizeOptionalString(llmDraft.description) ?? userMessage.trim().slice(0, 240);
  return {
    name,
    description,
    avatar: normalizeOptionalString(llmDraft.avatar) ?? defaultAgentAvatar(category),
    type: normalizeAgentBuilderType(llmDraft.type ?? category),
    category,
    capabilities: normalizeStringList(llmDraft.capabilities).length > 0
      ? normalizeStringList(llmDraft.capabilities).slice(0, 12)
      : [category, "custom"],
    visibility: "private",
    rolePrompt: normalizeOptionalString(llmDraft.rolePrompt) ?? buildDefaultRolePrompt(name, description),
    goals: normalizeStringList(llmDraft.goals).length > 0 ? normalizeStringList(llmDraft.goals) : [description],
    behaviorRules: normalizeStringList(llmDraft.behaviorRules),
    outputRules: normalizeStringList(llmDraft.outputRules),
    refusalRules: normalizeStringList(llmDraft.refusalRules),
    skillAssetIds: selectedSkillIds,
    knowledgeAssetIds: selectedKnowledgeIds,
    toolIds: selectedTools,
    model: {
      provider: normalizeOptionalString(model.provider) ?? "runtime_default",
      model: normalizeOptionalString(model.model) ?? "runtime_default",
      ...(typeof model.temperature === "number" ? { temperature: clampNumber(model.temperature, 0, 2) } : {}),
      reasoningEffort: normalizeEnumString(model.reasoningEffort, ["none", "minimal", "low", "medium", "high", "xhigh"], "high"),
      streaming: model.streaming === true,
      ...(normalizeOptionalString(model.fallbackModel) ? { fallbackModel: normalizeOptionalString(model.fallbackModel) } : {})
    },
    runtime: {
      workflowTemplate: normalizeEnumString(runtime.workflowTemplate, ["direct_answer", "tool_loop", "artifact_generation", "review", "human_approval"], defaultWorkflowTemplate(category)),
      maxToolSteps: clampInteger(runtime.maxToolSteps, 4, 1, 12),
      maxRunSeconds: clampInteger(runtime.maxRunSeconds, 180, 30, 1800)
    },
    collaboration: {
      orchestratorCallable: collaboration.orchestratorCallable !== false,
      dispatchTags: normalizeStringList(collaboration.dispatchTags).length > 0
        ? normalizeStringList(collaboration.dispatchTags)
        : inferDispatchTags(llmDraft.type ?? category, category, llmDraft.capabilities),
      assignmentDescription: normalizeOptionalString(collaboration.assignmentDescription) ?? description,
      acknowledgeOnAssignment: collaboration.acknowledgeOnAssignment !== false
    },
    workspace: {
      docRead: workspace.docRead !== false,
      docWrite: workspace.docWrite !== false,
      codeRead: workspace.codeRead !== false,
      codeWrite: workspace.codeWrite === true,
      assetCreate: workspace.assetCreate !== false
    },
    memory: {
      useConversationMemory: memory.useConversationMemory !== false,
      usePinnedMessages: memory.usePinnedMessages !== false,
      usePersonalCrossConversationMemory: memory.usePersonalCrossConversationMemory !== false,
      writeBackPolicy: normalizeEnumString(memory.writeBackPolicy, ["none", "summary_only", "confirmed_only"], "summary_only")
    },
    permissions: {
      scopes: scopes.length > 0 ? scopes : defaultScopes,
      requireApprovalFor: [...requireApprovalFor]
    },
    output: {
      defaultFormat: normalizeEnumString(output.defaultFormat, ["markdown", "json", "artifact"], "markdown"),
      allowedBlocks: normalizeStringList(output.allowedBlocks).length > 0
        ? normalizeStringList(output.allowedBlocks)
        : ["markdown", "file", "image", "web_preview", "diff", "agent_status"]
    }
  };
}

function buildRecommendedBindingViews(
  recommendedBindings: z.infer<typeof agentBuilderDraftSchema>["recommendedBindings"],
  inventory: AgentBuilderInventory,
  draft: AgentBuilderInput
) {
  const skillById = new Map(inventory.skills.map((asset) => [asset.assetId, asset]));
  const knowledgeById = new Map(inventory.knowledge.flatMap((asset) => [
    [asset.assetId, asset] as const,
    ...(asset.sourceAssetId ? [[asset.sourceAssetId, asset] as const] : [])
  ]));
  const toolById = new Map(inventory.tools.map((tool) => [tool.id, tool]));
  const skillReasonById = reasonMap(recommendedBindings?.skills ?? [], "assetId");
  const knowledgeReasonById = reasonMap(recommendedBindings?.knowledge ?? [], "assetId");
  const toolReasonById = reasonMap(recommendedBindings?.tools ?? [], "toolId");
  return {
    skills: normalizeStringList(draft.skillAssetIds).flatMap((assetId) => {
      const asset = skillById.get(assetId);
      return asset ? [{
        ...asset,
        reason: skillReasonById.get(assetId) ?? "与用户描述的 Agent 能力匹配。"
      }] : [];
    }),
    tools: normalizeStringList(draft.toolIds).flatMap((toolId) => {
      const tool = toolById.get(toolId);
      return tool ? [{
        ...tool,
        reason: toolReasonById.get(toolId) ?? "满足该 Agent 的运行能力需求。"
      }] : [];
    }),
    knowledge: normalizeStringList(draft.knowledgeAssetIds).flatMap((assetId) => {
      const asset = knowledgeById.get(assetId);
      return asset ? [{
        ...asset,
        reason: knowledgeReasonById.get(assetId) ?? "可作为该 Agent 的知识来源。"
      }] : [];
    })
  };
}

function shouldUseRecordingAgentBuilderDemo(currentUser: AgentHubUser, messages: AgentBuilderChatInput["messages"]) {
  if (currentUser.id !== "guyue") return false;
  const raw = process.env.AGENTHUB_RECORDING_AGENT_BUILDER_DEMO?.trim().toLowerCase();
  if (raw === "false" || raw === "0" || raw === "off") return false;
  const firstUserMessage = messages.find((message) => message.role === "user")?.content ?? "";
  return /workspace\s*curator|工作空间|沉淀|知识库|素材整理|项目资料|复盘|产物/.test(firstUserMessage.toLowerCase());
}

function buildRecordingAgentBuilderTurn(turn: number, inventory: AgentBuilderInventory) {
  const draft = buildRecordingAgentBuilderDraft(turn, inventory);
  const recommendedBindings = buildRecommendedBindingViews(recordingAgentBuilderRecommendedBindings(draft), inventory, draft);
  const checklist = recordingAgentBuilderChecklist(turn);
  return {
    assistantMessage: recordingAgentBuilderAssistantMessage(turn, draft),
    draft,
    checklist,
    readyToSave: turn >= 3,
    rationale: turn >= 3
      ? "已完成目标、角色、组件、权限、记忆和命名配置，可以保存为 private Agent。"
      : "已根据当前对话先生成可编辑草案，等待补齐剩余边界。",
    recommendedBindings,
    safetyNotes: recordingAgentBuilderSafetyNotes(turn),
    promptPack: {
      system: "recording-demo-agent-builder",
      user: {
        turn,
        candidateCounts: {
          skills: inventory.skills.length,
          tools: inventory.tools.length,
          knowledge: inventory.knowledge.length
        }
      }
    }
  };
}

function buildRecordingAgentBuilderDraft(turn: number, inventory: AgentBuilderInventory): AgentBuilderInput {
  const skillIds = [
    findInventoryAssetId(inventory.skills, "长文档简报 Skill"),
    findInventoryAssetId(inventory.skills, "KnowledgeHub RAG 构建 Skill"),
    findInventoryAssetId(inventory.skills, "群聊协作回复 Skill")
  ].filter((assetId): assetId is string => Boolean(assetId));
  const knowledgeIds = [
    findInventoryAssetId(inventory.knowledge, "AgentHub 实现私有知识库"),
    findInventoryAssetId(inventory.knowledge, "多 Agent 协作公开知识库"),
    findInventoryAssetId(inventory.knowledge, "AgentHub 官方开发文档知识库")
  ].filter((assetId): assetId is string => Boolean(assetId));
  const toolIds = [
    findInventoryToolId(inventory.tools, "个人 Doc 读取工具"),
    findInventoryToolId(inventory.tools, "个人 Doc 写入工具"),
    findInventoryToolId(inventory.tools, "Web Search")
  ].filter((toolId): toolId is string => Boolean(toolId));
  const selectedSkills = turn >= 2 ? skillIds.slice(0, 3) : skillIds.slice(0, 1);
  const selectedKnowledge = turn >= 2 ? knowledgeIds.slice(0, 3) : knowledgeIds.slice(0, 1);
  const selectedTools = turn >= 2 ? toolIds.slice(0, 3) : toolIds.slice(0, 1);
  return {
    name: turn >= 3 ? "Workspace Curator Agent" : "Workspace Curator",
    description: "整理项目群聊、工作空间文件和知识库检索结果，沉淀可复用的 Workspace 文档与后续行动清单。",
    avatar: "/avatars/agents/agent-v2-06.png",
    type: "universal",
    category: "workspace-curation",
    capabilities: ["workspace-curation", "knowledge-rag", "summary", "documentation"],
    visibility: "private",
    rolePrompt: [
      "你是 AgentHub 的 Workspace Curator Agent，负责把项目推进过程中的消息、文件、知识库检索结果和关键决策整理成结构化 Workspace 产物。",
      "你的核心职责不是替用户泛泛聊天，而是把分散上下文转成可复用的项目资产：阶段总结、决策记录、风险清单、后续任务和可检索文档。",
      "当信息不足时，先提出最少必要问题；当信息足够时，直接沉淀到 Doc/ 或以 Markdown 摘要返回。"
    ].join("\n"),
    goals: [
      "读取项目上下文和用户指定资料，形成结构化摘要。",
      "基于绑定知识库检索 AgentHub 相关术语、流程和历史决策。",
      "把长内容写入 Workspace Doc/，并在回复中给出路径、结论和下一步。",
      "帮助 Orchestrator 在项目结束或阶段切换时沉淀可复用资产。"
    ],
    behaviorRules: [
      "先判断用户要沉淀的是阶段总结、决策记录、知识条目还是行动清单。",
      "涉及项目事实时优先使用绑定知识库和工作空间文件，不把猜测写成结论。",
      "输出前区分已确认事实、合理推断和待确认问题。",
      "默认保持克制，不主动扩大到代码修改、部署或外部抓取。"
    ],
    outputRules: [
      "短回复直接用 Markdown 给出结论、来源和下一步。",
      "长内容必须写入 Doc/，消息里只保留摘要、路径和需要用户确认的点。",
      "如果产生文档，标题使用清晰的项目阶段名称，例如 Doc/project-curation-summary.md。",
      "需要引用知识库时说明命中的知识库名称。"
    ],
    refusalRules: [
      "没有权限读取或写入工作空间时，说明缺少的权限并请求用户确认。",
      "知识库没有命中时，不伪造来源，改为列出缺失信息。",
      "用户要求覆盖或删除重要资产时，先请求确认。"
    ],
    skillAssetIds: selectedSkills,
    knowledgeAssetIds: selectedKnowledge,
    knowledgeBindings: selectedKnowledge.map((assetId) => ({ assetId, retrievalMode: "rag" as const })),
    toolIds: selectedTools,
    model: {
      provider: "runtime_default",
      model: "runtime_default",
      reasoningEffort: "high",
      streaming: false
    },
    runtime: {
      workflowTemplate: "tool_loop",
      maxToolSteps: turn >= 3 ? 6 : 4,
      maxRunSeconds: turn >= 3 ? 240 : 180
    },
    collaboration: {
      orchestratorCallable: true,
      dispatchTags: ["workspace", "curation", "knowledge", "summary"],
      assignmentDescription: "当项目群聊需要整理阶段产物、沉淀 Workspace 文档、汇总知识库检索结果或形成后续任务清单时分派给它。",
      acknowledgeOnAssignment: true
    },
    workspace: {
      docRead: true,
      docWrite: true,
      codeRead: turn >= 2,
      codeWrite: false,
      assetCreate: true
    },
    memory: {
      useConversationMemory: true,
      usePinnedMessages: true,
      usePersonalCrossConversationMemory: turn >= 3,
      writeBackPolicy: "confirmed_only"
    },
    permissions: {
      scopes: [
        "message:read",
        "message:write",
        "workspace:read",
        "workspace:write",
        "asset:read",
        "asset:write",
        "knowledge:search"
      ],
      requireApprovalFor: turn >= 2 ? ["workspace:write", "asset:write", "tool:web_search"] : ["workspace:write"]
    },
    output: {
      defaultFormat: "markdown",
      allowedBlocks: ["markdown", "file", "agent_status"]
    },
    publishing: {
      changelog: turn >= 3 ? "Initial private Workspace Curator Agent created from Agent Builder conversation." : ""
    }
  };
}

function recordingAgentBuilderRecommendedBindings(draft: AgentBuilderInput): NonNullable<z.infer<typeof agentBuilderDraftSchema>["recommendedBindings"]> {
  return {
    skills: normalizeStringList(draft.skillAssetIds).map((assetId) => ({
      assetId,
      reason: "约束长文档沉淀、知识库检索和项目协作回复格式。"
    })),
    tools: normalizeStringList(draft.toolIds).map((toolId) => ({
      toolId,
      reason: toolId === "web_search" ? "必要时补充公开资料，但需要审批。" : "读取或写入 Workspace Doc 产物。"
    })),
    knowledge: normalizeStringList(draft.knowledgeAssetIds).map((assetId) => ({
      assetId,
      reason: "提供 AgentHub 项目背景、协作流程和历史实现上下文。"
    }))
  };
}

function recordingAgentBuilderChecklist(turn: number) {
  const status = (index: number) => {
    if (turn >= 3) return "done" as const;
    if (turn === 2) return index <= 3 ? "done" as const : index === 4 ? "active" as const : "todo" as const;
    return index <= 1 ? "done" as const : index === 2 ? "active" as const : "todo" as const;
  };
  return agentBuilderChecklistDefaults.map((item, index) => ({
    ...item,
    status: status(index)
  }));
}

function recordingAgentBuilderAssistantMessage(turn: number, draft: AgentBuilderInput) {
  if (turn <= 1) {
    return [
      "我理解你的目标是创建一个负责 Workspace 沉淀的 Agent：它要读取项目上下文、结合知识库，把阶段结论整理成可复用文档。",
      "",
      "我先生成了一个保守草案：定位为 private 的 Workspace Curator，默认只开启工作空间读取和文档沉淀能力。",
      "",
      "还需要确认两点：它是否可以写入 Doc/ 目录？是否需要绑定 AgentHub 项目知识库做 RAG 检索？"
    ].join("\n");
  }
  if (turn === 2) {
    return [
      "收到。我已把草案更新为可执行版本，并绑定了当前可见的 Skill、Knowledge 和 Tool：",
      "",
      "- Skill：长文档简报、RAG 构建、群聊协作回复。",
      "- Knowledge：AgentHub 实现私有知识库、多 Agent 协作公开知识库、官方开发文档知识库。",
      "- Tool：个人 Doc 读取、个人 Doc 写入，另保留 Web Search 作为需要审批的补充检索。",
      "",
      "权限上我保持最小边界：允许读写 Workspace 文档和创建资产，不允许写 Code；写入文档和外部搜索都进入审批清单。最后请确认命名和记忆策略。"
    ].join("\n");
  }
  return [
    `已完成，草案现在可以保存为 \`${draft.name}\`。`,
    "",
    "最终配置是 private Agent，可被 Orchestrator 分派；它会优先读取会话记忆、Pin 消息和绑定知识库，只在用户确认后把阶段总结写回 Doc/。",
    "",
    "你可以切换到表单检查字段，或者直接保存 Agent。保存后它会成为 guyue 账号下真实可用的自建 Agent。"
  ].join("\n");
}

function recordingAgentBuilderSafetyNotes(turn: number) {
  if (turn <= 1) {
    return ["写入 Workspace 前需要确认目标目录和文档类型。"];
  }
  return [
    "Doc 写入和资产创建属于写操作，已加入审批清单。",
    "外部 Web Search 只作为补充检索使用，默认需要审批。",
    "Code 写入保持关闭，避免 Workspace Curator 越权修改代码。"
  ];
}

function findInventoryAssetId(assets: AgentBuilderAssetCandidate[], name: string) {
  return assets.find((asset) => asset.name === name)?.assetId
    ?? assets.find((asset) => asset.name.includes(name))?.assetId;
}

function findInventoryToolId(tools: ToolDefinitionView[], name: string) {
  return tools.find((tool) => tool.name === name)?.id
    ?? tools.find((tool) => tool.name.includes(name))?.id
    ?? tools.find((tool) => tool.id === name)?.id;
}

const agentBuilderChecklistDefaults: Array<{
  id: z.infer<typeof agentBuilderChecklistFieldSchema>;
  label: string;
}> = [
  { id: "goal", label: "目标" },
  { id: "role", label: "角色" },
  { id: "components", label: "组件" },
  { id: "permissions", label: "权限" },
  { id: "memory", label: "记忆" },
  { id: "naming", label: "命名" }
];

function normalizeAgentBuilderChecklist(items: z.infer<typeof agentBuilderChatSchema>["checklist"]) {
  const byId = new Map(items.map((item) => [item.id, item]));
  let hasActive = false;
  return agentBuilderChecklistDefaults.map((fallback) => {
    const item = byId.get(fallback.id);
    const status = item?.status ?? "todo";
    if (status === "active") hasActive = true;
    return {
      id: fallback.id,
      label: normalizeOptionalString(item?.label) ?? fallback.label,
      status
    };
  }).map((item, index, all) => {
    if (hasActive || item.status !== "todo") return item;
    const previousDone = all.slice(0, index).every((candidate) => candidate.status === "done");
    return previousDone ? { ...item, status: "active" as const } : item;
  });
}

function summarizeAgentBuilderInventory(inventory: AgentBuilderInventory) {
  return {
    skills: inventory.skills.map((asset) => ({
      id: asset.assetId,
      name: asset.name,
      summary: asset.summary,
      visibility: asset.visibility,
      path: asset.path
    })),
    knowledge: inventory.knowledge.map((asset) => ({
      id: asset.assetId,
      sourceAssetId: asset.sourceAssetId,
      name: asset.name,
      summary: asset.summary,
      visibility: asset.visibility,
      path: asset.path
    })),
    tools: inventory.tools.map((tool) => ({
      id: tool.id,
      name: tool.name,
      category: tool.category,
      runtimeType: tool.runtimeType,
      risk: tool.risk,
      description: tool.description,
      permissionScopes: tool.permissionScopes,
      requiresApproval: tool.requiresApproval
    }))
  };
}

function reasonMap(
  items: Array<{ assetId?: string | undefined; toolId?: string | undefined; reason?: string | undefined }>,
  key: "assetId" | "toolId"
) {
  return new Map(items.flatMap((item) => {
    const id = normalizeOptionalString(item[key]);
    return id ? [[id, normalizeOptionalString(item.reason) ?? ""] as const] : [];
  }));
}

function isAgentBuilderAssetVisible(asset: {
  metadata: unknown;
  workspaceId: string;
  workspace?: {
    conversation?: {
      members?: Array<{ memberId: string }>;
    } | null;
  } | null;
}, currentUser: AgentHubUser, includePublicAssets: boolean) {
  if (currentUser.role === "admin") return true;
  const metadata = asRecord(asset.metadata) ?? {};
  const visibility = normalizeOptionalString(metadata.visibility) ?? "private";
  if (includePublicAssets && visibility === "public") return true;
  if (normalizeOptionalString(metadata.ownerUserId) === currentUser.id) return true;
  if (normalizeOptionalString(metadata.ownerId) === currentUser.id) return true;
  return (asset.workspace?.conversation?.members ?? []).some((member) => member.memberId === currentUser.id);
}

function isAgentBuilderSkillAsset(asset: { name: string; path: string; summary: string | null; metadata: unknown }) {
  const metadata = asRecord(asset.metadata) ?? {};
  if (metadata.hubKind === "skill") return true;
  const text = `${asset.name}\n${asset.path}\n${asset.summary ?? ""}`.toLowerCase();
  return text.includes("skill") || text.includes("技能") || text.includes("协作规范") || asset.path.startsWith("skills/");
}

function isAgentBuilderKnowledgeAsset(asset: { name: string; path: string; kind: string; summary: string | null; metadata: unknown }) {
  const metadata = asRecord(asset.metadata) ?? {};
  if (metadata.hubKind === "knowledge") return true;
  if (metadata.knowledgeDocument === true || typeof metadata.knowledgeAssetId === "string") return true;
  if (isAgentBuilderSkillAsset(asset)) return false;
  return false;
}

function toAgentBuilderAssetCandidate(asset: {
  id: string;
  workspaceId: string;
  name: string;
  summary: string | null;
  path: string;
  metadata: unknown;
}): AgentBuilderAssetCandidate {
  const metadata = asRecord(asset.metadata) ?? {};
  const visibility = normalizeOptionalString(metadata.visibility) === "public" ? "public" : "private";
  return {
    assetId: asset.id,
    name: asset.name,
    summary: asset.summary ?? "",
    path: asset.path,
    visibility,
    workspaceId: asset.workspaceId
  };
}

function inferAgentCategory(userMessage: string, capabilities: unknown) {
  const text = `${userMessage} ${normalizeStringList(capabilities).join(" ")}`.toLowerCase();
  if (/ui|ux|界面|设计|视觉/.test(text)) return "ui";
  if (/review|审阅|检查|质量|验收/.test(text)) return "review";
  if (/product|需求|产品|prd/.test(text)) return "product";
  if (/code|代码|编程|开发/.test(text)) return "code";
  if (/knowledge|知识|资料|rag/.test(text)) return "knowledge";
  return "custom";
}

function defaultWorkflowTemplate(category: string): "direct_answer" | "tool_loop" | "artifact_generation" | "review" | "human_approval" {
  if (category === "ui") return "artifact_generation";
  if (category === "review") return "review";
  if (category === "product") return "tool_loop";
  return "tool_loop";
}

function normalizeAgentBuilderType(value: unknown): "universal" | "product" | "ui" | "review" {
  const normalized = normalizeOptionalString(value)?.toLowerCase() ?? "";
  if (normalized === "product" || /prd|requirement|需求|产品/.test(normalized)) return "product";
  if (normalized === "ui" || /design|ux|界面|视觉|交互/.test(normalized)) return "ui";
  if (normalized === "review" || /review|qa|test|审阅|测试|验收/.test(normalized)) return "review";
  return "universal";
}

function inferDispatchTags(type: unknown, category: unknown, capabilities: unknown) {
  const source = [
    normalizeAgentBuilderType(type),
    normalizeOptionalString(category),
    ...normalizeStringList(capabilities)
  ].filter(Boolean).join(" ").toLowerCase();
  const tags = new Set<string>(["custom"]);
  if (/ui|design|ux|视觉|交互/.test(source)) tags.add("ui");
  if (/product|prd|requirement|需求|产品/.test(source)) tags.add("product");
  if (/review|qa|test|审阅|测试|验收/.test(source)) tags.add("review");
  if (/research|knowledge|知识|检索/.test(source)) tags.add("research");
  if (/write|doc|document|文档|报告/.test(source)) tags.add("writing");
  return [...tags].slice(0, 8);
}

function defaultAgentAvatar(category: string) {
  if (category === "ui") return "/avatars/agents/agent-v2-04.png";
  if (category === "review") return "/avatars/agents/agent-v2-08.png";
  if (category === "product") return "/avatars/agents/agent-v2-03.png";
  if (category === "code") return "/avatars/agents/agent-v2-05.png";
  return "/avatars/agents/agent-v2-07.png";
}

function defaultAgentName(userMessage: string) {
  const text = userMessage.trim().replace(/\s+/g, " ").slice(0, 18);
  return text ? `${text} Agent` : "自建 Agent";
}

function buildDefaultRolePrompt(name: string, description: string) {
  return `你是 ${name}。你的职责是：${description}。请先理解上下文，再使用已绑定的 Skills、Knowledge 和 Tools 完成任务；遇到权限、信息不足或高风险操作时先说明原因并请求确认。`;
}

function toolDefinitionRecordToView(tool: ToolDefinition): ToolDefinitionView {
  return {
    id: tool.id,
    category: tool.category,
    name: tool.name,
    risk: tool.risk === "write" || tool.risk === "external" || tool.risk === "dangerous" ? tool.risk : "read",
    description: tool.description,
    runtimeType: tool.runtimeType,
    source: tool.source,
    visibility: tool.visibility,
    ownerType: tool.ownerType,
    ownerId: tool.ownerId,
    runtimeToolId: tool.runtimeToolId,
    metadata: asRecord(tool.metadata) ?? {},
    executable: tool.executable,
    inputSchema: asRecord(tool.inputSchema) ?? {},
    outputSchema: asRecord(tool.outputSchema) ?? {},
    permissionScopes: normalizeStringList(tool.permissionScopes),
    requiresApproval: tool.requiresApproval,
    availableToAgentTypes: normalizeStringList(tool.availableToAgentTypes),
    timeoutPolicy: tool.timeoutPolicy,
    auditLevel: tool.auditLevel,
    sourceVersion: tool.currentVersion,
    sourceFingerprint: tool.currentFingerprint,
    updatedAt: tool.updatedAt.toISOString()
  };
}

function requiresToolHubInstallation(tool: ToolDefinitionView) {
  return publicToolHubToolIds.has(tool.id);
}

function isBindableToolView(tool: ToolDefinitionView) {
  const runtimeToolId = tool.runtimeToolId ?? ((executableRuntimeToolIds as readonly string[]).includes(tool.id) ? tool.id : undefined);
  return tool.risk !== "dangerous"
    && (tool.executable === true || Boolean(runtimeToolId && (executableRuntimeToolIds as readonly string[]).includes(runtimeToolId)));
}

function collectPublicPublishRiskItems(config: Record<string, unknown>) {
  const permissions = asRecord(config.permissions) ?? {};
  const scopes = normalizeStringList(permissions.scopes);
  const riskyScopes = scopes.filter((scope) =>
    /^(workspace|asset|git|command|browser):(write|delete|deploy|external|danger|execute|run)$/i.test(scope)
      || /(^|:)(delete|deploy|external|danger|execute|run)$/i.test(scope)
  );
  const toolIds = readBindingIds(config, "tools");
  const toolsById = new Map(toolRegistry.map((tool) => [tool.id, tool]));
  const riskyTools = toolIds.flatMap((toolId) => {
    const tool = toolsById.get(toolId);
    if (!tool) return [`unknown_tool:${toolId}`];
    if (tool.risk === "dangerous" || tool.risk === "external") return [`tool:${tool.id}:${tool.risk}`];
    if (tool.risk === "write" && ["workspace", "asset", "git", "command", "browser"].includes(tool.category)) {
      return [`tool:${tool.id}:${tool.risk}`];
    }
    return [];
  });
  return Array.from(new Set([...riskyScopes.map((scope) => `permission:${scope}`), ...riskyTools]));
}

function detectSensitivePromptValues(config: Record<string, unknown>) {
  const prompt = asRecord(config.prompt) ?? {};
  const values = [
    normalizeOptionalString(prompt.role),
    ...normalizeStringList(prompt.goals),
    ...normalizeStringList(prompt.behaviorRules),
    ...normalizeStringList(prompt.outputRules),
    ...normalizeStringList(prompt.refusalRules)
  ].filter((value): value is string => typeof value === "string");
  const patterns: Array<[string, RegExp]> = [
    ["sk_key", /\bsk-[A-Za-z0-9_-]{12,}\b/],
    ["api_key_assignment", /\bapi[_\s-]?key\s*[:=]\s*[A-Za-z0-9._-]{8,}/i],
    ["secret_assignment", /\bsecret\s*[:=]\s*[A-Za-z0-9._-]{8,}/i],
    ["token_assignment", /\btoken\s*[:=]\s*[A-Za-z0-9._-]{12,}/i],
    ["bearer_token", /\bbearer\s+[A-Za-z0-9._-]{12,}/i],
    ["aws_access_key", /\bAKIA[0-9A-Z]{16}\b/],
    ["password_assignment", /\bpassword\s*[:=]\s*\S{8,}/i]
  ];
  const hits = new Set<string>();
  for (const value of values) {
    for (const [name, pattern] of patterns) {
      if (pattern.test(value)) hits.add(name);
    }
  }
  return [...hits];
}

function normalizeEnumString<const T extends readonly string[]>(value: unknown, allowed: T, fallback: T[number]): T[number] {
  const text = normalizeOptionalString(value);
  return text && allowed.includes(text) ? text : fallback;
}

function clampInteger(value: unknown, fallback: number, min: number, max: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function clampNumber(value: unknown, min: number, max: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function latestConfigMetadata(agent: Agent & { versions?: Array<{ config: unknown }> }) {
  const config = asRecord(agent.versions?.[0]?.config);
  const lineage = asRecord(config?.lineage);
  const copiedFrom = asRecord(lineage?.copiedFrom);
  return {
    custom: asRecord(config?.runtime)?.kind === "internal_llm",
    sourceAgentId: typeof copiedFrom?.agentId === "string" ? copiedFrom.agentId : undefined
  };
}
