import { Body, Controller, Delete, Get, Inject, NotFoundException, Param, Post, Put, Query } from "@nestjs/common";
import type { AgentHubUser } from "@agenthub/shared";
import { z } from "zod";
import { CurrentUser } from "../../common/auth.decorators.js";
import { parseBody, parseQuery } from "../../common/validation.js";
import { AgentsService } from "./agents.service.js";

const agentsQuerySchema = z.object({
  scope: z.enum(["personal", "public"]).optional(),
  includeSystem: z.coerce.boolean().optional()
});

const componentBindingsQuerySchema = z.object({
  componentKind: z.enum(["tool", "skill", "knowledge"]),
  componentAssetId: z.string().trim().min(1).max(128)
});

const installAgentSchema = z.object({
  ownerType: z.enum(["user", "team"]).default("user"),
  ownerId: z.string().optional(),
  config: z.record(z.string(), z.unknown()).optional()
});

const syncAgentInstallSchema = z.object({
  ownerType: z.enum(["user", "team"]).default("user"),
  ownerId: z.string().optional(),
  confirmRiskChanges: z.boolean().optional()
});

const modelConfigSchema = z.object({
  provider: z.string().trim().min(1).max(80).optional(),
  model: z.string().trim().min(1).max(120).optional(),
  temperature: z.number().min(0).max(2).optional(),
  reasoningEffort: z.enum(["none", "minimal", "low", "medium", "high", "xhigh"]).optional(),
  streaming: z.boolean().optional(),
  fallbackModel: z.string().trim().min(1).max(120).optional()
}).optional();

const runtimeConfigSchema = z.object({
  workflowTemplate: z.enum(["direct_answer", "tool_loop", "artifact_generation", "review", "human_approval"]).optional(),
  maxToolSteps: z.number().int().min(1).max(12).optional(),
  maxRunSeconds: z.number().int().min(30).max(1800).optional()
}).optional();

const collaborationConfigSchema = z.object({
  orchestratorCallable: z.boolean().optional(),
  dispatchTags: z.array(z.string().trim().min(1).max(60)).max(20).optional(),
  assignmentDescription: z.string().trim().max(1000).optional(),
  acknowledgeOnAssignment: z.boolean().optional()
}).optional();

const workspacePolicySchema = z.object({
  docRead: z.boolean().optional(),
  docWrite: z.boolean().optional(),
  codeRead: z.boolean().optional(),
  codeWrite: z.boolean().optional(),
  assetCreate: z.boolean().optional()
}).optional();

const permissionsConfigSchema = z.object({
  scopes: z.array(z.string().trim().min(1).max(80)).max(30).optional(),
  requireApprovalFor: z.array(z.string().trim().min(1).max(80)).max(30).optional()
}).optional();

const outputConfigSchema = z.object({
  defaultFormat: z.enum(["markdown", "json", "artifact"]).optional(),
  allowedBlocks: z.array(z.enum(["markdown", "code", "file", "image", "web_preview", "diff", "deploy_status", "agent_status"])).max(20).optional()
}).optional();

const publishingConfigSchema = z.object({
  license: z.string().trim().max(120).optional(),
  changelog: z.string().trim().max(1200).optional()
}).optional();

const agentBuilderSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().min(1).max(600),
  avatar: z.string().trim().max(300).optional(),
  type: z.enum(["universal", "product", "ui", "review"]).optional(),
  category: z.string().trim().min(1).max(60).optional(),
  capabilities: z.array(z.string().trim().min(1).max(60)).max(12).optional(),
  visibility: z.enum(["private", "public"]).optional(),
  rolePrompt: z.string().trim().max(8000).optional(),
  goals: z.array(z.string().trim().min(1).max(500)).max(20).optional(),
  behaviorRules: z.array(z.string().trim().min(1).max(500)).max(20).optional(),
  outputRules: z.array(z.string().trim().min(1).max(500)).max(20).optional(),
  refusalRules: z.array(z.string().trim().min(1).max(500)).max(20).optional(),
  skillAssetIds: z.array(z.string().trim().min(1).max(128)).max(20).optional(),
  toolIds: z.array(z.string().trim().min(1).max(80)).max(20).optional(),
  knowledgeAssetIds: z.array(z.string().trim().min(1).max(128)).max(20).optional(),
  knowledgeBindings: z.array(z.object({
    assetId: z.string().trim().min(1).max(128),
    retrievalMode: z.enum(["query", "rag"])
  })).max(20).optional(),
  model: modelConfigSchema,
  runtime: runtimeConfigSchema,
  collaboration: collaborationConfigSchema,
  workspace: workspacePolicySchema,
  memory: z.object({
    useConversationMemory: z.boolean().optional(),
    usePinnedMessages: z.boolean().optional(),
    usePersonalCrossConversationMemory: z.boolean().optional(),
    writeBackPolicy: z.enum(["none", "summary_only", "confirmed_only"]).optional()
  }).optional(),
  permissions: permissionsConfigSchema,
  output: outputConfigSchema,
  publishing: publishingConfigSchema,
  confirmHighRiskPublish: z.boolean().optional()
});

const partialAgentBuilderSchema = agentBuilderSchema.partial().refine((value) => Object.keys(value).length > 0, {
  message: "至少需要提供一个要更新的字段"
});

const agentTestSchema = z.object({
  message: z.string().trim().min(1).max(4000),
  writeMemory: z.boolean().optional(),
  includePromptPack: z.boolean().optional()
});

const agentBuilderDraftRequestSchema = z.object({
  message: z.string().trim().min(1).max(4000),
  includePublicAssets: z.boolean().optional()
});

const agentBuilderChatRequestSchema = z.object({
  messages: z.array(z.object({
    role: z.enum(["assistant", "user"]),
    content: z.string().trim().min(1).max(4000)
  })).min(1).max(30),
  currentDraft: z.record(z.string(), z.unknown()).optional(),
  includePublicAssets: z.boolean().optional()
});

const agentPublishSchema = z.object({
  confirmHighRiskPublish: z.boolean().optional(),
  publishing: publishingConfigSchema
});

const toolApprovalDecisionSchema = z.object({
  reason: z.string().trim().max(1000).optional()
});

@Controller("agents")
export class AgentsController {
  constructor(@Inject(AgentsService) private readonly agents: AgentsService) {}

  @Get()
  async list(@CurrentUser() currentUser: AgentHubUser, @Query() query: unknown) {
    const input = parseQuery(agentsQuerySchema, query);
    return { agents: await this.agents.listAgents(currentUser, input.scope, { includeSystem: input.includeSystem === true }) };
  }

  @Get("installations")
  async installations(@CurrentUser() currentUser: AgentHubUser) {
    return { installations: await this.agents.listInstallations(currentUser) };
  }

  @Get("component-bindings")
  async componentBindings(@CurrentUser() currentUser: AgentHubUser, @Query() query: unknown) {
    const input = parseQuery(componentBindingsQuerySchema, query);
    return this.agents.listAgentsUsingComponent(currentUser, input);
  }

  @Post("builder/draft")
  async draft(@CurrentUser() currentUser: AgentHubUser, @Body() body: unknown) {
    const input = parseBody(agentBuilderDraftRequestSchema, body);
    return this.agents.generateAgentDraft(currentUser, input);
  }

  @Post("builder/chat")
  async chat(@CurrentUser() currentUser: AgentHubUser, @Body() body: unknown) {
    const input = parseBody(agentBuilderChatRequestSchema, body);
    return this.agents.chatWithAgentBuilder(currentUser, input);
  }

  @Post()
  async create(@CurrentUser() currentUser: AgentHubUser, @Body() body: unknown) {
    const input = parseBody(agentBuilderSchema, body);
    return this.agents.createAgent(currentUser, input);
  }

  @Get(":id/config")
  async config(@CurrentUser() currentUser: AgentHubUser, @Param("id") id: string) {
    return this.agents.getAgentConfig(currentUser, id);
  }

  @Post(":id/test")
  async test(@CurrentUser() currentUser: AgentHubUser, @Param("id") id: string, @Body() body: unknown) {
    const input = parseBody(agentTestSchema, body);
    return this.agents.testAgent(currentUser, id, input);
  }

  @Put(":id")
  async update(@CurrentUser() currentUser: AgentHubUser, @Param("id") id: string, @Body() body: unknown) {
    const input = parseBody(partialAgentBuilderSchema, body);
    return this.agents.updateAgent(currentUser, id, input);
  }

  @Delete(":id")
  async delete(@CurrentUser() currentUser: AgentHubUser, @Param("id") id: string) {
    return this.agents.deleteAgent(currentUser, id);
  }

  @Post(":id/publish")
  async publish(@CurrentUser() currentUser: AgentHubUser, @Param("id") id: string, @Body() body: unknown = {}) {
    const input = parseBody(agentPublishSchema, body ?? {});
    return this.agents.publishAgent(currentUser, id, input);
  }

  @Post(":id/fork")
  async fork(@CurrentUser() currentUser: AgentHubUser, @Param("id") id: string) {
    return this.agents.forkAgent(currentUser, id);
  }

  @Post(":id/install")
  async install(@CurrentUser() currentUser: AgentHubUser, @Param("id") id: string, @Body() body: unknown) {
    const input = parseBody(installAgentSchema, body);
    return this.agents.installAgent(currentUser, id, {
      ownerType: input.ownerType,
      ...(input.ownerId ? { ownerId: input.ownerId } : {}),
      ...(input.config ? { config: input.config } : {})
    });
  }

  @Post(":id/install/sync")
  async syncInstall(@CurrentUser() currentUser: AgentHubUser, @Param("id") id: string, @Body() body: unknown = {}) {
    const input = parseBody(syncAgentInstallSchema, body ?? {});
    return this.agents.syncInstalledAgent(currentUser, id, {
      ownerType: input.ownerType,
      ...(input.ownerId ? { ownerId: input.ownerId } : {}),
      confirmRiskChanges: input.confirmRiskChanges === true
    });
  }

  @Delete(":id/install")
  async uninstall(@CurrentUser() currentUser: AgentHubUser, @Param("id") id: string, @Query() query: unknown) {
    const input = parseQuery(installAgentSchema.partial(), query);
    return this.agents.uninstallAgent(currentUser, id, input.ownerType ?? "user", input.ownerId ?? currentUser.id);
  }

  @Get(":id/status")
  async status(@CurrentUser() currentUser: AgentHubUser, @Param("id") id: string) {
    const status = await this.agents.getAgentStatus(currentUser, id);
    if (!status) throw new NotFoundException("Agent not found");
    return status;
  }

  @Post(":id/tool-runs/:toolRunId/approve")
  async approveToolRun(@CurrentUser() currentUser: AgentHubUser, @Param("id") id: string, @Param("toolRunId") toolRunId: string) {
    return this.agents.approveAgentToolRun(currentUser, id, toolRunId);
  }

  @Post(":id/tool-runs/:toolRunId/reject")
  async rejectToolRun(@CurrentUser() currentUser: AgentHubUser, @Param("id") id: string, @Param("toolRunId") toolRunId: string, @Body() body: unknown = {}) {
    const input = parseBody(toolApprovalDecisionSchema, body ?? {});
    return this.agents.rejectAgentToolRun(currentUser, id, toolRunId, input.reason);
  }

  @Get(":id")
  async detail(@CurrentUser() currentUser: AgentHubUser, @Param("id") id: string) {
    const agent = await this.agents.getAgent(currentUser, id);
    if (!agent) throw new NotFoundException("Agent not found");
    return { agent };
  }
}
