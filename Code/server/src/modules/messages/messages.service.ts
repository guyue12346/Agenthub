import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import {
  createMarkdownBlock,
  type ActorType,
  type AgentHubUser,
  type ChatMessage,
  type ChatMessageAction,
  type ChatMessageReference,
  type MessageActionType,
  type MessageBlock
} from "@agenthub/shared";
import { nanoid } from "nanoid";
import { Prisma, type Message, type MessageAction } from "../../generated/prisma/client.js";
import { ObservabilityService } from "../../common/observability.service.js";
import { PrismaService } from "../../common/prisma.service.js";
import { RealtimeService } from "../realtime/realtime.service.js";
import { MemoryManagerService } from "../runtime/memory-manager.service.js";
import { WorkspacesService } from "../workspaces/workspaces.service.js";

type MessageWithActions = Message & { actions?: MessageAction[] };
type ActionActor = {
  type: ActorType;
  id: string;
  name?: string;
  avatar?: string;
};

@Injectable()
export class MessagesService {
  constructor(
    @Inject(PrismaService)
    private readonly prisma: PrismaService,
    @Inject(RealtimeService)
    private readonly realtime: RealtimeService,
    @Inject(ObservabilityService)
    private readonly observability: ObservabilityService,
    @Inject(WorkspacesService)
    private readonly workspaces: WorkspacesService,
    @Inject(MemoryManagerService)
    private readonly memoryManager?: MemoryManagerService
  ) {}

  async listMessages(conversationId: string, page?: { beforeSeq?: number; limit?: number }) {
    const limit = Math.min(Math.max(page?.limit ?? 50, 1), 100);
    const messages = await this.prisma.message.findMany({
      where: {
        conversationId,
        deletedAt: null,
        ...(page?.beforeSeq ? { seq: { lt: page.beforeSeq } } : {})
      },
      include: {
        actions: {
          where: { deletedAt: null },
          orderBy: { createdAt: "asc" }
        }
      },
      orderBy: { seq: "desc" },
      take: limit + 1
    });
    const hasMore = messages.length > limit;
    const pageRows = messages.slice(0, limit).reverse();
    const nextBeforeSeq = hasMore ? pageRows[0]?.seq : undefined;
    return {
      messages: pageRows.map(toChatMessage),
      pageInfo: {
        hasMore,
        nextBeforeSeq
      }
    };
  }

  async markConversationRead(conversationId: string, userId: string) {
    const latest = await this.prisma.message.findFirst({
      where: { conversationId, deletedAt: null },
      orderBy: { seq: "desc" },
      select: { seq: true }
    });
    const lastReadSeq = latest?.seq ?? 0;
    await this.prisma.conversationMember.updateMany({
      where: { conversationId, memberType: "user", memberId: userId, deletedAt: null },
      data: { unreadCount: 0, lastReadSeq }
    });
    await this.realtime.emit("user", userId, "conversation.read", { conversationId, lastReadSeq });
    await this.realtime.emit("user", userId, "conversation.updated", { conversationId, reason: "read" });
    return { conversationId, unreadCount: 0, lastReadSeq };
  }

  async createUserMessage(input: {
    conversationId: string;
    text: string;
    blocks?: MessageBlock[];
    sender: AgentHubUser;
    replyToMessageId?: string;
  }): Promise<ChatMessage> {
    const text = input.text.trim();
    const conversation = await this.prisma.conversation.findFirst({
      where: { id: input.conversationId, deletedAt: null },
      select: { type: true }
    });
    if (!conversation) throw new BadRequestException("会话不存在或已删除");
    const mentions = conversation.type === "project" ? extractMentions(text) : [];
    const blocks = input.blocks ?? [createMarkdownBlock(`block-${nanoid(8)}`, text)];
    const sender = input.sender;
    const reference = input.replyToMessageId
      ? await this.buildMessageReference(input.conversationId, input.replyToMessageId, "reply")
      : undefined;
    const { message, replyAction } = await this.prisma.$transaction(async (tx) => {
      const seq = await this.nextSeq(tx, input.conversationId);
      const created = await tx.message.create({
        data: {
          id: `msg-${nanoid(10)}`,
          conversationId: input.conversationId,
          senderType: "user",
          senderId: sender.id,
          senderName: sender.name,
          senderAvatar: sender.avatar,
          blocks: blocks as unknown as Prisma.InputJsonValue,
          mentions: mentions as unknown as Prisma.InputJsonValue,
          ...(reference ? { metadata: { reference } as unknown as Prisma.InputJsonValue } : {}),
          seq,
          status: "sent",
          userId: sender.id
        }
      });
      const replyAction = reference && input.replyToMessageId
        ? await tx.messageAction.create({
            data: {
              id: `action-${nanoid(10)}`,
              messageId: input.replyToMessageId,
              actorType: "user",
              actorId: sender.id,
              type: "reply",
              payload: {
                replyMessageId: created.id,
                actorName: sender.name,
                actorAvatar: sender.avatar,
                summary: summarizeBlocks(blocks)
              } as Prisma.InputJsonValue
            }
          })
        : null;
      await this.touchConversation(tx, input.conversationId, text);
      await this.applyUnreadForCreatedMessage(tx, input.conversationId, created.seq, sender.id);
      return { message: created, replyAction };
    });
    const chatMessage = toChatMessage(message);
    await this.observability?.audit({
      actorUserId: sender.id,
      action: "message.create",
      targetType: "message",
      targetId: message.id,
      payload: { conversationId: input.conversationId, mentions }
    });
    await this.realtime.emit("conversation", input.conversationId, "message.created", { message: chatMessage });
    if (replyAction) {
      await this.memoryManager?.updateAgentRunBriefMessageAction({
        conversationId: input.conversationId,
        messageId: input.replyToMessageId!,
        actionId: replyAction.id,
        actionType: "reply",
        actorId: sender.id,
        actorType: "user",
        payload: {
          replyMessageId: message.id,
          actorName: sender.name,
          actorAvatar: sender.avatar,
          summary: summarizeBlocks(blocks)
        }
      });
      await this.realtime.emit("conversation", input.conversationId, "message.action.created", {
        conversationId: input.conversationId,
        messageId: input.replyToMessageId,
        action: toChatMessageAction(replyAction)
      });
    }
    await this.emitConversationUpdatedToMembers(input.conversationId, "message_created");
    return chatMessage;
  }

  async createUserAssetMessage(input: {
    conversationId: string;
    sender: AgentHubUser;
    file: { name: string; mimeType: string; content: Buffer };
    text?: string;
    replyToMessageId?: string;
  }) {
    const workspaceId = await this.workspaces.ensureConversationWorkspace(input.sender, input.conversationId);
    const asset = await this.workspaces.storeUploadedAsset(input.sender, workspaceId, input.file);
    return this.createUserAssetMessageFromAsset({
      conversationId: input.conversationId,
      sender: input.sender,
      workspaceId,
      assetId: asset.id,
      ...(input.text ? { text: input.text } : {}),
      ...(input.replyToMessageId ? { replyToMessageId: input.replyToMessageId } : {})
    });
  }

  async createUserAssetMessageFromAsset(input: {
    conversationId: string;
    sender: AgentHubUser;
    workspaceId: string;
    assetId: string;
    text?: string;
    replyToMessageId?: string;
  }) {
    const conversation = await this.prisma.conversation.findFirst({
      where: { id: input.conversationId, workspaceId: input.workspaceId, deletedAt: null },
      select: { id: true }
    });
    if (!conversation) throw new BadRequestException("Upload workspace does not belong to this conversation");
    const asset = await this.workspaces.getAsset(input.sender, input.workspaceId, input.assetId);
    const caption = input.text?.trim();
    const blocks: MessageBlock[] = [];
    if (caption) blocks.push(createMarkdownBlock(`block-${nanoid(8)}`, caption));
    blocks.push(toAttachmentBlock(asset));
    return this.createUserMessage({
      conversationId: input.conversationId,
      sender: input.sender,
      text: caption || `上传了 ${asset.name}`,
      blocks,
      ...(input.replyToMessageId ? { replyToMessageId: input.replyToMessageId } : {})
    });
  }

  async createUserAssetMessageFromAssets(input: {
    conversationId: string;
    sender: AgentHubUser;
    attachments: Array<{ workspaceId: string; assetId: string }>;
    text?: string;
    replyToMessageId?: string;
  }) {
    if (input.attachments.length < 1) throw new BadRequestException("至少需要一个附件");
    if (input.attachments.length > 12) throw new BadRequestException("一次消息最多支持 12 个附件");
    const blocks: MessageBlock[] = [];
    const caption = input.text?.trim();
    if (caption) blocks.push(createMarkdownBlock(`block-${nanoid(8)}`, caption));

    const assets: Awaited<ReturnType<WorkspacesService["getAsset"]>>[] = [];
    for (const attachment of input.attachments) {
      const conversation = await this.prisma.conversation.findFirst({
        where: { id: input.conversationId, workspaceId: attachment.workspaceId, deletedAt: null },
        select: { id: true }
      });
      if (!conversation) throw new BadRequestException("Upload workspace does not belong to this conversation");
      const asset = await this.workspaces.getAsset(input.sender, attachment.workspaceId, attachment.assetId);
      assets.push(asset);
      blocks.push(toAttachmentBlock(asset));
    }

    return this.createUserMessage({
      conversationId: input.conversationId,
      sender: input.sender,
      text: caption || summarizeUploadedAssets(assets),
      blocks,
      ...(input.replyToMessageId ? { replyToMessageId: input.replyToMessageId } : {})
    });
  }

  async clearMessages(conversationId: string, actorUserId?: string) {
    const result = await this.prisma.$transaction(async (tx) => {
      const messages = await tx.message.findMany({
        where: { conversationId, deletedAt: null },
        select: { id: true }
      });
      const messageIds = messages.map((message) => message.id);
      const deletedAt = new Date();
      if (messageIds.length > 0) {
        await tx.messageAction.updateMany({ where: { messageId: { in: messageIds }, deletedAt: null }, data: { deletedAt } });
      }
      const deleted = await tx.message.updateMany({ where: { conversationId, deletedAt: null }, data: { deletedAt } });
      await tx.conversation.update({
        where: { id: conversationId },
        data: {
          lastMessage: "",
          unreadCount: 0
        }
      });
      await tx.conversationMember.updateMany({
        where: { conversationId, memberType: "user", deletedAt: null },
        data: { unreadCount: 0, lastReadSeq: 0 }
      });
      return deleted;
    });
    await this.appendConversationMemoryVersion(conversationId, (baseMemory) => ({
      ...baseMemory,
      chatMemory: {
        ...(asRecord(baseMemory.chatMemory) ?? {}),
        pinMessages: []
      }
    }));
    await this.observability?.audit({
      actorUserId,
      action: "message.clear",
      targetType: "conversation",
      targetId: conversationId,
      payload: { count: result.count }
    });
    await this.realtime.emit("conversation", conversationId, "messages.cleared", { conversationId, count: result.count });
    await this.emitConversationUpdatedToMembers(conversationId, "messages_cleared");
    return { count: result.count };
  }

  async createAgentMessage(input: {
    conversationId: string;
    agentId: string;
    agentName: string;
    avatar: string;
    subtitle?: string;
    blocks: MessageBlock[];
    status?: ChatMessage["status"];
    metadata?: Record<string, unknown>;
  }): Promise<ChatMessage> {
    const message = await this.prisma.$transaction(async (tx) => {
      const seq = await this.nextSeq(tx, input.conversationId);
      const created = await tx.message.create({
        data: {
          id: `msg-${nanoid(10)}`,
          conversationId: input.conversationId,
          senderType: "agent",
          senderId: input.agentId,
          senderName: input.agentName,
          senderAvatar: input.avatar,
          senderSubtitle: input.subtitle ?? null,
          blocks: input.blocks as unknown as Prisma.InputJsonValue,
          mentions: [] as unknown as Prisma.InputJsonValue,
          ...(input.metadata ? { metadata: input.metadata as Prisma.InputJsonValue } : {}),
          seq,
          status: input.status ?? "sent"
        }
      });
      await this.touchConversation(tx, input.conversationId, summarizeBlocks(input.blocks));
      await this.applyUnreadForCreatedMessage(tx, input.conversationId, created.seq);
      return created;
    });
    const chatMessage = toChatMessage(message);
    await this.observability?.audit({
      action: "message.create_agent",
      targetType: "message",
      targetId: message.id,
      payload: { conversationId: input.conversationId, agentId: input.agentId, status: message.status }
    });
    await this.realtime.emit("conversation", input.conversationId, "message.created", { message: chatMessage });
    await this.emitConversationUpdatedToMembers(input.conversationId, "message_created");
    return chatMessage;
  }

  async createMessageAction(input: {
    conversationId: string;
    messageId: string;
    actor: ActionActor;
    type: MessageActionType;
    payload?: Record<string, unknown>;
  }): Promise<ChatMessageAction> {
    const target = await this.prisma.message.findFirst({
      where: { id: input.messageId, conversationId: input.conversationId, deletedAt: null }
    });
    if (!target) throw new BadRequestException("消息不存在或不属于当前会话");

    if (input.type === "like" || input.type === "pin") {
      const existing = await this.prisma.messageAction.findFirst({
        where: {
          messageId: input.messageId,
          actorType: input.actor.type,
          actorId: input.actor.id,
          type: input.type,
          deletedAt: null
        },
        orderBy: { createdAt: "desc" }
      });
      if (existing) return toChatMessageAction(existing);
    }

    const action = await this.prisma.messageAction.create({
      data: {
        id: `action-${nanoid(10)}`,
        messageId: input.messageId,
        actorType: input.actor.type,
        actorId: input.actor.id,
        type: input.type,
        payload: {
          ...(input.payload ?? {}),
          actorName: input.actor.name,
          actorAvatar: input.actor.avatar
        } as Prisma.InputJsonValue
      }
    });

    if (input.type === "pin") await this.appendPinnedMessageMemory(input.conversationId, target, action);
    await this.memoryManager?.updateAgentRunBriefMessageAction({
      conversationId: input.conversationId,
      messageId: input.messageId,
      actionId: action.id,
      actionType: input.type,
      actorId: input.actor.id,
      actorType: input.actor.type,
      payload: {
        ...(input.payload ?? {}),
        actorName: input.actor.name,
        actorAvatar: input.actor.avatar
      }
    });

    const chatAction = toChatMessageAction(action);
    await this.observability?.audit({
      actorUserId: input.actor.type === "user" ? input.actor.id : undefined,
      action: `message.action.${input.type}`,
      targetType: "message",
      targetId: input.messageId,
      payload: { conversationId: input.conversationId, actionId: action.id }
    });
    await this.realtime.emit("conversation", input.conversationId, "message.action.created", {
      conversationId: input.conversationId,
      messageId: input.messageId,
      action: chatAction
    });
    return chatAction;
  }

  async deleteMessageAction(input: {
    conversationId: string;
    messageId: string;
    actionId: string;
    actor: ActionActor;
  }) {
    const action = await this.prisma.messageAction.findFirst({
      where: {
        id: input.actionId,
        messageId: input.messageId,
        deletedAt: null,
        message: {
          conversationId: input.conversationId,
          deletedAt: null
        }
      }
    });
    if (!action) throw new BadRequestException("消息动作不存在或不属于当前会话");
    if (input.actor.type !== "user" || action.actorId !== input.actor.id) {
      throw new BadRequestException("只能取消自己的消息动作");
    }
    const deletedAt = new Date();
    await this.prisma.messageAction.update({
      where: { id: action.id },
      data: { deletedAt }
    });
    if (action.type === "pin") await this.removePinnedMessageMemory(input.conversationId, action.id);
    await this.memoryManager?.updateAgentRunBriefMessageAction({
      conversationId: input.conversationId,
      messageId: input.messageId,
      actionId: action.id,
      actionType: action.type,
      actorId: action.actorId,
      actorType: action.actorType,
      deleted: true,
      payload: asRecord(action.payload) ?? {}
    });
    await this.observability?.audit({
      actorUserId: input.actor.type === "user" ? input.actor.id : undefined,
      action: `message.action.${action.type}.delete`,
      targetType: "message",
      targetId: input.messageId,
      payload: { conversationId: input.conversationId, actionId: action.id }
    });
    await this.realtime.emit("conversation", input.conversationId, "message.action.deleted", {
      conversationId: input.conversationId,
      messageId: input.messageId,
      actionId: action.id,
      type: action.type
    });
    return { actionId: action.id, messageId: input.messageId, type: action.type };
  }

  private async nextSeq(tx: Prisma.TransactionClient, conversationId: string) {
    const conversation = await tx.conversation.update({
      where: { id: conversationId },
      data: { messageSeq: { increment: 1 } },
      select: { messageSeq: true }
    });
    return conversation.messageSeq;
  }

  private async touchConversation(tx: Prisma.TransactionClient, conversationId: string, lastMessage: string) {
    await tx.conversation.update({
      where: { id: conversationId },
      data: { lastMessage }
    });
  }

  private async applyUnreadForCreatedMessage(
    tx: Prisma.TransactionClient,
    conversationId: string,
    messageSeq: number,
    senderUserId?: string
  ) {
    await tx.conversationMember.updateMany({
      where: {
        conversationId,
        memberType: "user",
        deletedAt: null,
        ...(senderUserId ? { memberId: { not: senderUserId } } : {})
      },
      data: { unreadCount: { increment: 1 } }
    });
    if (senderUserId) {
      await tx.conversationMember.updateMany({
        where: { conversationId, memberType: "user", memberId: senderUserId, deletedAt: null },
        data: { unreadCount: 0, lastReadSeq: messageSeq }
      });
    }
  }

  private async emitConversationUpdatedToMembers(conversationId: string, reason: "message_created" | "messages_cleared") {
    const members = await this.prisma.conversationMember.findMany({
      where: { conversationId, memberType: "user", deletedAt: null },
      select: { memberId: true }
    });
    for (const member of members) {
      await this.realtime.emit("user", member.memberId, "conversation.updated", { conversationId, reason });
    }
  }

  private async buildMessageReference(
    conversationId: string,
    messageId: string,
    kind: ChatMessageReference["kind"]
  ): Promise<ChatMessageReference> {
    const target = await this.prisma.message.findFirst({
      where: { id: messageId, conversationId, deletedAt: null }
    });
    if (!target) throw new BadRequestException("引用消息不存在");
    return {
      messageId: target.id,
      senderName: target.senderName,
      senderAvatar: target.senderAvatar,
      summary: summarizeMessageRow(target),
      kind,
      createdAt: target.createdAt.toISOString()
    };
  }

  private async appendPinnedMessageMemory(conversationId: string, message: Message, action: MessageAction) {
    const conversation = await this.prisma.conversation.findFirst({
      where: { id: conversationId, deletedAt: null },
      select: { type: true }
    });
    if (conversation?.type !== "project") return;

    const nextPin = {
      messageId: message.id,
      actionId: action.id,
      pinnedBy: action.actorId,
      pinnedByType: action.actorType,
      pinnedAt: action.createdAt.toISOString(),
      senderName: message.senderName,
      summary: summarizeMessageRow(message)
    };
    await this.appendConversationMemoryVersion(conversationId, (baseMemory) => {
      const chatMemory = asRecord(baseMemory.chatMemory) ?? {};
      const previousPins = Array.isArray(chatMemory.pinMessages) ? chatMemory.pinMessages.filter(asRecord) : [];
      const pinnedMessages = [
        ...previousPins.filter((pin) => pin.messageId !== message.id),
        nextPin
      ];
      return {
      ...baseMemory,
      chatMemory: {
        ...chatMemory,
        pinMessages: pinnedMessages
      }
      };
    });
  }

  private async removePinnedMessageMemory(conversationId: string, actionId: string) {
    await this.appendConversationMemoryVersion(conversationId, (baseMemory) => {
      const chatMemory = asRecord(baseMemory.chatMemory) ?? {};
      const previousPins = Array.isArray(chatMemory.pinMessages) ? chatMemory.pinMessages.filter(asRecord) : [];
      const pinnedMessages = previousPins.filter((pin) => pin.actionId !== actionId);
      return {
      ...baseMemory,
      chatMemory: {
        ...chatMemory,
        pinMessages: pinnedMessages
      }
      };
    });
  }

  private async appendConversationMemoryVersion(
    conversationId: string,
    buildMemory: (baseMemory: Record<string, unknown>) => Record<string, unknown>
  ) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const latestMemory = await this.prisma.conversationMemory.findFirst({
        where: { conversationId, deletedAt: null },
        orderBy: { version: "desc" }
      });
      if (!latestMemory) return;
      const baseMemory = asRecord(latestMemory.memory) ?? {};
      const version = latestMemory.version + 1;
      try {
        return await this.prisma.conversationMemory.create({
          data: {
            id: `memory-${nanoid(10)}`,
            conversationId,
            version,
            memory: buildMemory(baseMemory) as Prisma.InputJsonValue
          }
        });
      } catch (error) {
        if (!isUniqueConstraintError(error) || attempt >= 4) throw error;
      }
    }
  }
}

function isUniqueConstraintError(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

export function toChatMessage(message: MessageWithActions): ChatMessage {
  const sender: ChatMessage["sender"] = {
    type: message.senderType as ChatMessage["sender"]["type"],
    id: message.senderId,
    name: message.senderName,
    avatar: message.senderAvatar
  };
  if (message.senderSubtitle) sender.subtitle = message.senderSubtitle;
  const metadata = asRecord(message.metadata) ?? undefined;
  const reference = asReference(metadata?.reference);
  return {
    id: message.id,
    conversationId: message.conversationId,
    sender,
    blocks: message.blocks as unknown as MessageBlock[],
    mentions: Array.isArray(message.mentions) ? (message.mentions as string[]) : [],
    actions: message.actions?.map(toChatMessageAction) ?? [],
    ...(reference ? { reference } : {}),
    ...(metadata ? { metadata } : {}),
    createdAt: message.createdAt.toISOString(),
    status: message.status as ChatMessage["status"]
  };
}

export function toChatMessageAction(action: MessageAction): ChatMessageAction {
  const payload = asRecord(action.payload) ?? {};
  return {
    id: action.id,
    messageId: action.messageId,
    actor: {
      type: action.actorType as ActorType,
      id: action.actorId,
      ...(typeof payload.actorName === "string" ? { name: payload.actorName } : {}),
      ...(typeof payload.actorAvatar === "string" ? { avatar: payload.actorAvatar } : {})
    },
    type: action.type as MessageActionType,
    payload,
    createdAt: action.createdAt.toISOString()
  };
}

export function extractMentions(text: string) {
  return Array.from(new Set((text.match(/@[\p{L}\p{N}_-]+/gu) ?? []).map((mention) => mention.slice(1).toLowerCase())));
}

function summarizeBlocks(blocks: MessageBlock[]) {
  const first = blocks[0];
  if (!first) return "新消息";
  if (first.type === "markdown") return first.payload.text.slice(0, 80);
  if (first.type === "agent_status") return first.payload.title;
  return `${first.type} 消息`;
}

function summarizeMessageRow(message: Message) {
  const blocks = message.blocks as unknown as MessageBlock[];
  const summary = summarizeBlocksForMemory(blocks).replace(/\s+/g, " ").trim();
  return summary.length > 120 ? `${summary.slice(0, 120)}...` : summary;
}

function summarizeBlocksForMemory(blocks: MessageBlock[]) {
  return blocks.map((block) => {
    if (block.type === "markdown") return block.payload.text;
    if (block.type === "code") return `代码块 ${block.payload.filename ?? ""} ${block.payload.language}: ${block.payload.code}`;
    if (block.type === "image") return `图片附件 ${block.payload.assetId}${block.payload.alt ? ` ${block.payload.alt}` : ""}`;
    if (block.type === "file") {
      const filePath = block.payload.path ? ` ${block.payload.path}` : "";
      return `文件附件 ${block.payload.name}${filePath} ${block.payload.mimeType}${block.payload.summary ? ` ${block.payload.summary}` : ""}`;
    }
    if (block.type === "web_preview") return `网页预览 ${block.payload.title} ${block.payload.url} ${block.payload.status}`;
    if (block.type === "diff") {
      const additions = block.payload.files.reduce((sum, file) => sum + file.additions, 0);
      const deletions = block.payload.files.reduce((sum, file) => sum + file.deletions, 0);
      return `Diff ${block.payload.title} ${block.payload.files.length} files +${additions}/-${deletions}`;
    }
    if (block.type === "agent_status") return `Agent 状态 ${block.payload.title} ${block.payload.status}${block.payload.summary ? ` ${block.payload.summary}` : ""}`;
    if (block.type === "deploy_status") return `部署状态 ${block.payload.title} ${block.payload.status}${block.payload.detail ? ` ${block.payload.detail}` : ""}`;
    return "消息块";
  }).join("\n");
}

function toAttachmentBlock(asset: Awaited<ReturnType<WorkspacesService["getAsset"]>>): MessageBlock {
  if (asset.kind === "image") {
    return {
      blockId: `block-${nanoid(8)}`,
      schemaVersion: 1,
      type: "image",
      payload: {
        assetId: asset.id,
        alt: asset.name,
        thumbnailUrl: assetContentPath(asset.workspaceId, asset.id),
        previewUrl: assetContentPath(asset.workspaceId, asset.id)
      }
    };
  }
  return {
    blockId: `block-${nanoid(8)}`,
    schemaVersion: 1,
    type: "file",
    payload: {
      assetId: asset.id,
      name: asset.name,
      mimeType: asset.mimeType ?? "application/octet-stream",
      size: asset.size,
      summary: asset.summary
    }
  };
}

function summarizeUploadedAssets(assets: Array<Awaited<ReturnType<WorkspacesService["getAsset"]>>>) {
  if (assets.length === 1) return `上传了 ${assets[0]?.name ?? "附件"}`;
  return `上传了 ${assets.length} 个附件`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asReference(value: unknown): ChatMessageReference | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  if (typeof record.messageId !== "string" || typeof record.senderName !== "string" || typeof record.summary !== "string") {
    return undefined;
  }
  return {
    messageId: record.messageId,
    senderName: record.senderName,
    summary: record.summary,
    kind: record.kind === "quote" || record.kind === "review" ? record.kind : "reply",
    ...(typeof record.senderAvatar === "string" ? { senderAvatar: record.senderAvatar } : {}),
    ...(typeof record.createdAt === "string" ? { createdAt: record.createdAt } : {})
  };
}

function assetContentPath(workspaceId: string, assetId: string) {
  return `/api/workspaces/${encodeURIComponent(workspaceId)}/assets/${encodeURIComponent(assetId)}/content`;
}
