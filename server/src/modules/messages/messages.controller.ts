import { BadRequestException, Body, Controller, Delete, Get, Inject, Param, Post, Query } from "@nestjs/common";
import type { AgentHubUser } from "@agenthub/shared";
import { z } from "zod";
import { CurrentUser } from "../../common/auth.decorators.js";
import { assertDangerousConfirmation, dangerousConfirmationSchema, messageTextSchema, parseBody, parseQuery } from "../../common/validation.js";
import { ConversationsService } from "../conversations/conversations.service.js";
import { RuntimeService } from "../runtime/runtime.service.js";
import { WorkspacesService } from "../workspaces/workspaces.service.js";
import { MessagesService } from "./messages.service.js";

const listMessagesQuerySchema = z.object({
  beforeSeq: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50)
});

const createMessageSchema = z.object({
  text: messageTextSchema,
  replyToMessageId: z.string().optional()
});

const createAssetMessageSchema = z.object({
  name: z.string().trim().min(1).max(240),
  mimeType: z.string().trim().min(1).max(160),
  contentBase64: z.string().min(1).max(8_000_000),
  text: z.string().max(4000).optional(),
  replyToMessageId: z.string().optional()
});

const beginAssetUploadSchema = z.object({
  name: z.string().trim().min(1).max(240),
  mimeType: z.string().trim().min(1).max(160).default("application/octet-stream"),
  size: z.coerce.number().int().positive()
});

const createAssetMessageFromUploadSchema = z.object({
  workspaceId: z.string().trim().min(1),
  assetId: z.string().trim().min(1),
  text: z.string().max(4000).optional(),
  replyToMessageId: z.string().optional()
});

const createAssetMessageFromUploadsSchema = z.object({
  attachments: z.array(
    z.object({
      workspaceId: z.string().trim().min(1),
      assetId: z.string().trim().min(1)
    })
  ).min(1).max(12),
  text: z.string().max(4000).optional(),
  replyToMessageId: z.string().optional()
});

const createMessageActionSchema = z.object({
  type: z.enum(["like", "pin", "comment", "reply", "quote"]),
  payload: z.record(z.string(), z.unknown()).optional()
});

@Controller("conversations/:conversationId/messages")
export class MessagesController {
  constructor(
    @Inject(MessagesService)
    private readonly messages: MessagesService,
    @Inject(RuntimeService)
    private readonly runtime: RuntimeService,
    @Inject(ConversationsService)
    private readonly conversations: ConversationsService,
    @Inject(WorkspacesService)
    private readonly workspaces: WorkspacesService
  ) {}

  @Get()
  async list(@Param("conversationId") conversationId: string, @CurrentUser() currentUser: AgentHubUser, @Query() query?: unknown) {
    await this.conversations.assertCanAccessConversation(currentUser, conversationId);
    const parsedQuery = parseQuery(listMessagesQuerySchema, query);
    const page = await this.messages.listMessages(conversationId, {
      limit: parsedQuery.limit,
      ...(parsedQuery.beforeSeq ? { beforeSeq: parsedQuery.beforeSeq } : {})
    });
    return page;
  }

  @Post("read")
  async read(@Param("conversationId") conversationId: string, @CurrentUser() currentUser: AgentHubUser) {
    await this.conversations.assertCanAccessConversation(currentUser, conversationId);
    return this.messages.markConversationRead(conversationId, currentUser.id);
  }

  @Post()
  async create(@Param("conversationId") conversationId: string, @Body() body: unknown, @CurrentUser() sender: AgentHubUser) {
    await this.conversations.assertCanAccessConversation(sender, conversationId);
    const input = parseBody(createMessageSchema, body);
    const message = await this.messages.createUserMessage({
      conversationId,
      text: input.text,
      sender,
      ...(input.replyToMessageId ? { replyToMessageId: input.replyToMessageId } : {})
    });
    const acknowledgements = await this.runtime.acknowledgeMentionedAgents(message);
    const runtimeJob = await this.runtime.enqueueMessage(message);
    return { message, acknowledgements, runtimeJob };
  }

  @Post("assets")
  async createAssetMessage(
    @Param("conversationId") conversationId: string,
    @Body() body: unknown,
    @CurrentUser() sender: AgentHubUser
  ) {
    await this.conversations.assertCanAccessConversation(sender, conversationId);
    const input = parseBody(createAssetMessageSchema, body);
    const content = Buffer.from(input.contentBase64, "base64");
    if (content.byteLength <= 0 || content.byteLength > 5_000_000) {
      throw new BadRequestException("附件大小必须在 1B 到 5MB 之间");
    }
    const message = await this.messages.createUserAssetMessage({
      conversationId,
      sender,
      file: { name: input.name, mimeType: input.mimeType, content },
      ...(input.text ? { text: input.text } : {}),
      ...(input.replyToMessageId ? { replyToMessageId: input.replyToMessageId } : {})
    });
    const acknowledgements = await this.runtime.acknowledgeMentionedAgents(message);
    const runtimeJob = await this.runtime.enqueueMessage(message);
    return { message, acknowledgements, runtimeJob };
  }

  @Post("asset-uploads")
  async beginAssetUpload(
    @Param("conversationId") conversationId: string,
    @Body() body: unknown,
    @CurrentUser() sender: AgentHubUser
  ) {
    await this.conversations.assertCanAccessConversation(sender, conversationId);
    const input = parseBody(beginAssetUploadSchema, body);
    return { upload: await this.workspaces.beginConversationUpload(sender, conversationId, input) };
  }

  @Post("assets/from-upload")
  async createAssetMessageFromUpload(
    @Param("conversationId") conversationId: string,
    @Body() body: unknown,
    @CurrentUser() sender: AgentHubUser
  ) {
    await this.conversations.assertCanAccessConversation(sender, conversationId);
    const input = parseBody(createAssetMessageFromUploadSchema, body);
    const message = await this.messages.createUserAssetMessageFromAsset({
      conversationId,
      sender,
      workspaceId: input.workspaceId,
      assetId: input.assetId,
      ...(input.text ? { text: input.text } : {}),
      ...(input.replyToMessageId ? { replyToMessageId: input.replyToMessageId } : {})
    });
    const acknowledgements = await this.runtime.acknowledgeMentionedAgents(message);
    const runtimeJob = await this.runtime.enqueueMessage(message);
    return { message, acknowledgements, runtimeJob };
  }

  @Post("assets/from-uploads")
  async createAssetMessageFromUploads(
    @Param("conversationId") conversationId: string,
    @Body() body: unknown,
    @CurrentUser() sender: AgentHubUser
  ) {
    await this.conversations.assertCanAccessConversation(sender, conversationId);
    const input = parseBody(createAssetMessageFromUploadsSchema, body);
    const message = await this.messages.createUserAssetMessageFromAssets({
      conversationId,
      sender,
      attachments: input.attachments,
      ...(input.text ? { text: input.text } : {}),
      ...(input.replyToMessageId ? { replyToMessageId: input.replyToMessageId } : {})
    });
    const acknowledgements = await this.runtime.acknowledgeMentionedAgents(message);
    const runtimeJob = await this.runtime.enqueueMessage(message);
    return { message, acknowledgements, runtimeJob };
  }

  @Post(":messageId/actions")
  async createAction(
    @Param("conversationId") conversationId: string,
    @Param("messageId") messageId: string,
    @Body() body: unknown,
    @CurrentUser() currentUser: AgentHubUser
  ) {
    await this.conversations.assertCanAccessConversation(currentUser, conversationId);
    const input = parseBody(createMessageActionSchema, body);
    const action = await this.messages.createMessageAction({
      conversationId,
      messageId,
      actor: { type: "user", id: currentUser.id, name: currentUser.name, avatar: currentUser.avatar },
      type: input.type,
      ...(input.payload ? { payload: input.payload } : {})
    });
    return { action };
  }

  @Delete(":messageId/actions/:actionId")
  async deleteAction(
    @Param("conversationId") conversationId: string,
    @Param("messageId") messageId: string,
    @Param("actionId") actionId: string,
    @CurrentUser() currentUser: AgentHubUser
  ) {
    await this.conversations.assertCanAccessConversation(currentUser, conversationId);
    return this.messages.deleteMessageAction({
      conversationId,
      messageId,
      actionId,
      actor: { type: "user", id: currentUser.id, name: currentUser.name, avatar: currentUser.avatar }
    });
  }

  @Delete()
  async clear(@Param("conversationId") conversationId: string, @CurrentUser() currentUser: AgentHubUser, @Body() body: unknown) {
    const input = parseBody(dangerousConfirmationSchema, body);
    const conversation = await this.conversations.assertCanManageConversation(currentUser, conversationId);
    assertDangerousConfirmation(input.confirm, conversation.title);
    return this.messages.clearMessages(conversationId, currentUser.id);
  }
}
