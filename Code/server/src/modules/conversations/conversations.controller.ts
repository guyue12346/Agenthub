import { Body, Controller, Delete, Get, Inject, Param, Post, Query } from "@nestjs/common";
import type { AgentHubUser } from "@agenthub/shared";
import { CurrentUser } from "../../common/auth.decorators.js";
import { cuidLikeSchema, dangerousConfirmationSchema, parseBody, parseQuery } from "../../common/validation.js";
import { ConversationsService } from "./conversations.service.js";
import { z } from "zod";

const listConversationsQuerySchema = z.object({
  search: z.string().trim().max(200).optional(),
  archived: z.coerce.boolean().optional()
});

const createProjectSchema = z.object({
  title: z.string().trim().min(1).max(120),
  goal: z.string().trim().max(5000).optional(),
  codeAgentId: cuidLikeSchema.optional(),
  memberUserIds: z.array(cuidLikeSchema).max(20).default([]),
  memberAgentIds: z.array(cuidLikeSchema).max(20).default([]),
  workspaceAccess: z.enum(["owner_only", "project_members"]).default("project_members"),
  initialMemory: z.string().trim().max(5000).optional()
});

const directConversationSchema = z.object({
  targetUserId: cuidLikeSchema
});

const agentConversationSchema = z.object({
  agentId: cuidLikeSchema
});

const archiveConversationSchema = z.object({
  clearMemory: z.boolean().optional()
});

@Controller("conversations")
export class ConversationsController {
  constructor(@Inject(ConversationsService) private readonly conversations: ConversationsService) {}

  @Get()
  async list(@CurrentUser() currentUser: AgentHubUser, @Query() query?: unknown) {
    const input = parseQuery(listConversationsQuerySchema, query);
    return {
      conversations: await this.conversations.listConversations(currentUser, {
        ...(input.search ? { search: input.search } : {}),
        archived: input.archived ?? false
      })
    };
  }

  @Get(":id/memory")
  async memory(@CurrentUser() currentUser: AgentHubUser, @Param("id") id: string) {
    return { memory: await this.conversations.getConversationMemory(id, currentUser) };
  }

  @Get(":id")
  async detail(@CurrentUser() currentUser: AgentHubUser, @Param("id") id: string) {
    return { conversation: await this.conversations.getConversation(id, currentUser) };
  }

  @Delete(":id")
  async delete(@CurrentUser() currentUser: AgentHubUser, @Param("id") id: string, @Body() body: unknown) {
    const input = parseBody(dangerousConfirmationSchema, body);
    return this.conversations.deleteConversation(currentUser, id, input.confirm);
  }

  @Post(":id/pin")
  async pin(@CurrentUser() currentUser: AgentHubUser, @Param("id") id: string) {
    return { conversation: await this.conversations.setConversationPinned(currentUser, id, true) };
  }

  @Delete(":id/pin")
  async unpin(@CurrentUser() currentUser: AgentHubUser, @Param("id") id: string) {
    return { conversation: await this.conversations.setConversationPinned(currentUser, id, false) };
  }

  @Post(":id/archive")
  async archive(@CurrentUser() currentUser: AgentHubUser, @Param("id") id: string, @Body() body: unknown) {
    const input = parseBody(archiveConversationSchema, body ?? {});
    return { conversation: await this.conversations.setConversationArchived(currentUser, id, true, input.clearMemory ?? false) };
  }

  @Delete(":id/archive")
  async unarchive(@CurrentUser() currentUser: AgentHubUser, @Param("id") id: string) {
    return { conversation: await this.conversations.setConversationArchived(currentUser, id, false) };
  }

  @Post()
  async create(@CurrentUser() currentUser: AgentHubUser, @Body() body: unknown) {
    const input = parseBody(createProjectSchema, body);
    return {
      conversation: await this.conversations.createProject(currentUser, {
        title: input.title,
        ...(input.goal ? { goal: input.goal } : {}),
        ...(input.codeAgentId ? { codeAgentId: input.codeAgentId } : {}),
        memberUserIds: input.memberUserIds,
        memberAgentIds: input.memberAgentIds,
        workspaceAccess: input.workspaceAccess,
        ...(input.initialMemory ? { initialMemory: input.initialMemory } : {})
      })
    };
  }

  @Post("direct")
  async direct(@CurrentUser() currentUser: AgentHubUser, @Body() body: unknown) {
    const input = parseBody(directConversationSchema, body);
    return { conversation: await this.conversations.openDirectConversation(currentUser, input.targetUserId) };
  }

  @Post("agent-direct")
  async agentDirect(@CurrentUser() currentUser: AgentHubUser, @Body() body: unknown) {
    const input = parseBody(agentConversationSchema, body);
    return { conversation: await this.conversations.openAgentConversation(currentUser, input.agentId) };
  }
}
