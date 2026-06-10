import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { nanoid } from "nanoid";
import { realpath, rm } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { builtInAgents, createMarkdownBlock, type AgentHubUser, type ChatMessage, type ConversationDetail, type ConversationMemoryView, type ConversationMemberProfile, type ConversationSummary, type MessageBlock, type PinnedMessageMemory } from "@agenthub/shared";
import { Prisma, type Agent, type Conversation, type ConversationMember, type Message, type User } from "../../generated/prisma/client.js";
import { ConfigService } from "../../common/config.service.js";
import { ObservabilityService } from "../../common/observability.service.js";
import { PrismaService } from "../../common/prisma.service.js";
import { assertDangerousConfirmation } from "../../common/validation.js";
import { isChildPath, isInsideAnyWorkspaceRootRealpath, workspaceAllowedRoots } from "../../common/workspace-roots.js";
import { ensureWorkspaceLayout } from "../../common/workspace-layout.js";
import { RealtimeService } from "../realtime/realtime.service.js";

const builtInAgentIds = builtInAgents.map((agent) => agent.id);

@Injectable()
export class ConversationsService {
  constructor(
    @Inject(PrismaService)
    private readonly prisma: PrismaService,
    @Inject(ObservabilityService)
    private readonly observability: ObservabilityService,
    @Inject(RealtimeService)
    private readonly realtime: RealtimeService,
    @Inject(ConfigService)
    private readonly config = new ConfigService()
  ) {}

  async listConversations(currentUser: AgentHubUser, options: { search?: string; archived?: boolean } = {}) {
    const archived = options.archived ?? false;
    const conversations = await this.prisma.conversation.findMany({
      where: {
        deletedAt: null,
        members: {
          some: {
            memberType: "user",
            memberId: currentUser.id,
            deletedAt: null,
            archivedAt: archived ? { not: null } : null
          }
        }
      },
      include: {
        members: { where: { deletedAt: null } }
      },
      orderBy: { updatedAt: "desc" }
    });
    const summaries = await this.toConversationSummaries(conversations, currentUser);
    const query = options.search?.trim().toLowerCase();
    const filtered = query
      ? summaries.filter((conversation) =>
          [conversation.title, conversation.lastMessage, conversation.codeAgentId ?? "", conversation.type]
            .join(" ")
            .toLowerCase()
            .includes(query)
        )
      : summaries;
    return filtered.sort(compareConversationSummaries);
  }

  async getConversation(id: string, currentUser: AgentHubUser) {
    const conversation = await this.prisma.conversation.findFirst({
      where: { id, deletedAt: null },
      include: {
        members: { where: { deletedAt: null } }
      }
    });
    if (!conversation) throw new NotFoundException("Conversation not found");
    this.assertConversationAccess(currentUser, conversation);
    const summary = (await this.toConversationSummaries([conversation], currentUser))[0]!;
    const [memberProfiles, memory] = await Promise.all([
      this.toConversationMemberProfiles(conversation.members),
      this.prisma.conversationMemory.findFirst({
        where: { conversationId: id, deletedAt: null },
        orderBy: { version: "desc" }
      })
    ]);
    const memoryBase = asRecord(memory?.memory) ?? {};
    const detail: ConversationDetail = {
      ...summary,
      members: memberProfiles,
      projectCore: asRecord(memoryBase.projectCore) ?? {}
    };
    return detail;
  }

  async getConversationMemory(id: string, currentUser: AgentHubUser): Promise<ConversationMemoryView> {
    await this.assertCanAccessConversation(currentUser, id);
    const memory = await this.prisma.conversationMemory.findFirst({
      where: { conversationId: id, deletedAt: null },
      orderBy: { version: "desc" }
    });
    const base = asRecord(memory?.memory) ?? {};
    const chatMemory = asRecord(base.chatMemory) ?? {};
    return {
      version: memory?.version ?? 0,
      updatedAt: (memory?.updatedAt ?? new Date(0)).toISOString(),
      projectCore: asRecord(base.projectCore) ?? {},
      chatMemory: {
        pinMessages: normalizePinnedMessages(chatMemory.pinMessages),
        ...(typeof chatMemory.earlyCompressed === "string" ? { earlyCompressed: chatMemory.earlyCompressed } : {}),
        ...(Array.isArray(chatMemory.messageFileIndex) ? { messageFileIndex: chatMemory.messageFileIndex } : {}),
        ...(Array.isArray(chatMemory.workspaceFileChanges) ? { workspaceFileChanges: chatMemory.workspaceFileChanges } : {})
      },
      ...(Array.isArray(base.taskBriefs) ? { taskBriefs: base.taskBriefs } : {}),
      ...(asRecord(base.codeExecutionMemory) ? { codeExecutionMemory: asRecord(base.codeExecutionMemory)! } : {}),
      ...(asRecord(base.preferences) ? { preferences: asRecord(base.preferences)! } : {}),
      ...(Array.isArray(base.openQuestions) ? { openQuestions: base.openQuestions } : {})
    };
  }

  async assertCanAccessConversation(currentUser: AgentHubUser, conversationId: string) {
    const conversation = await this.prisma.conversation.findFirst({
      where: { id: conversationId, deletedAt: null },
      include: {
        members: { where: { deletedAt: null } }
      }
    });
    if (!conversation) throw new NotFoundException("Conversation not found");
    this.assertConversationAccess(currentUser, conversation);
    return conversation;
  }

  async assertCanManageConversation(currentUser: AgentHubUser, conversationId: string) {
    const conversation = await this.assertCanAccessConversation(currentUser, conversationId);
    const canManage = currentUser.role === "admin" || conversation.members.some(
      (member) => member.memberType === "user" && member.memberId === currentUser.id && member.role === "owner"
    );
    if (!canManage) throw new BadRequestException("Only the conversation owner or admin can perform this operation");
    return conversation;
  }

  async deleteConversation(currentUser: AgentHubUser, id: string, confirmation: string) {
    const conversation = await this.prisma.conversation.findFirst({
      where: { id, deletedAt: null },
      include: {
        members: { where: { deletedAt: null } },
        workspace: true
      }
    });
    if (!conversation) throw new NotFoundException("Conversation not found");
    this.assertConversationAccess(currentUser, conversation);
    const isOwner = conversation.members.some(
      (member) => member.memberType === "user" && member.memberId === currentUser.id && member.role === "owner"
    );
    if (!isOwner && currentUser.role !== "admin") throw new BadRequestException("Only the conversation owner can delete it");
    assertDangerousConfirmation(confirmation, conversation.title);
    const workspaceRootToDelete = conversation.workspace?.rootPath
      ? await this.assertWorkspaceDeleteTarget(conversation.workspace.rootPath)
      : null;
    await this.prisma.$transaction(async (tx) => {
      const deletedAt = new Date();
      const messages = await tx.message.findMany({
        where: { conversationId: id, deletedAt: null },
        select: { id: true }
      });
      const messageIds = messages.map((message) => message.id);
      if (messageIds.length > 0) {
        await tx.messageAction.updateMany({ where: { messageId: { in: messageIds }, deletedAt: null }, data: { deletedAt } });
        await tx.runtimeJob.updateMany({
          where: { targetType: "message", targetId: { in: messageIds }, deletedAt: null },
          data: cancelledRuntimeJobData(deletedAt)
        });
      }
      await tx.message.updateMany({ where: { conversationId: id, deletedAt: null }, data: { deletedAt } });

      const runs = await tx.orchestratorRun.findMany({
        where: { conversationId: id, deletedAt: null },
        select: { id: true }
      });
      const runIds = runs.map((run) => run.id);
      const agentRuns = runIds.length > 0
        ? await tx.agentRun.findMany({
            where: { runId: { in: runIds }, deletedAt: null },
            select: { id: true }
          })
        : [];
      const agentRunIds = agentRuns.map((run) => run.id);
      if (runIds.length > 0) {
        await tx.agentRun.updateMany({ where: { runId: { in: runIds }, deletedAt: null }, data: { deletedAt } });
        await tx.toolRun.updateMany({ where: { runId: { in: runIds }, deletedAt: null }, data: { deletedAt } });
        await tx.runtimeJob.updateMany({
          where: {
            targetType: "orchestrator_run",
            deletedAt: null,
            OR: [
              { targetId: { in: runIds } },
              ...runIds.map((runId) => ({ targetId: { startsWith: `${runId}:` } }))
            ]
          },
          data: cancelledRuntimeJobData(deletedAt)
        });
        await tx.runtimeLock.deleteMany({
          where: {
            OR: [
              { resourceId: id },
              { resourceId: { in: runIds } },
              ...(agentRunIds.length > 0 ? [{ resourceId: { in: agentRunIds } }] : [])
            ]
          }
        });
        await tx.runtimeEvent.deleteMany({
          where: {
            OR: [
              { scopeKind: "run", scopeId: { in: runIds } },
              ...(agentRunIds.length > 0 ? [{ scopeKind: "agent_run" as const, scopeId: { in: agentRunIds } }] : [])
            ]
          }
        });
        await tx.runtimeEventCursor.deleteMany({
          where: {
            OR: [
              { scopeKind: "run", scopeId: { in: runIds } },
              ...(agentRunIds.length > 0 ? [{ scopeKind: "agent_run" as const, scopeId: { in: agentRunIds } }] : [])
            ]
          }
        });
      }
      await tx.orchestratorRun.updateMany({ where: { conversationId: id, deletedAt: null }, data: { deletedAt } });

      await tx.agentConversation.updateMany({ where: { conversationId: id, deletedAt: null }, data: { deletedAt } });
      await tx.agentMemory.updateMany({ where: { conversationId: id, deletedAt: null }, data: { deletedAt } });
      await tx.conversationMemory.updateMany({ where: { conversationId: id, deletedAt: null }, data: { deletedAt } });
      await tx.memoryVersion.deleteMany({ where: { targetType: "conversation", targetId: id } });

      if (conversation.workspaceId) {
        const assets = await tx.workspaceAsset.findMany({
          where: { workspaceId: conversation.workspaceId },
          select: { id: true }
        });
        const assetIds = assets.map((asset) => asset.id);
        if (assetIds.length > 0) {
          await tx.workspaceAssetVersion.deleteMany({ where: { assetId: { in: assetIds } } });
        }
        await tx.workspaceUploadSession.deleteMany({ where: { workspaceId: conversation.workspaceId } });
        await tx.workspaceAsset.updateMany({ where: { workspaceId: conversation.workspaceId, deletedAt: null }, data: { deletedAt } });
        await tx.codeTaskRun.updateMany({ where: { workspaceId: conversation.workspaceId, deletedAt: null }, data: { deletedAt } });
        await tx.runtimeEvent.deleteMany({ where: { scopeKind: "workspace", scopeId: conversation.workspaceId } });
        await tx.runtimeEventCursor.deleteMany({ where: { scopeKind: "workspace", scopeId: conversation.workspaceId } });
        await tx.workspace.updateMany({ where: { id: conversation.workspaceId, deletedAt: null }, data: { deletedAt } });
      }

      await tx.runtimeJob.updateMany({
        where: { targetType: "conversation", targetId: id, deletedAt: null },
        data: cancelledRuntimeJobData(deletedAt)
      });
      await tx.runtimeLock.deleteMany({ where: { resourceId: id } });
      await tx.runtimeEvent.deleteMany({ where: { scopeKind: "conversation", scopeId: id } });
      await tx.runtimeEventCursor.deleteMany({ where: { scopeKind: "conversation", scopeId: id } });
      await tx.conversationMember.updateMany({ where: { conversationId: id, deletedAt: null }, data: { deletedAt } });
      await tx.conversation.update({ where: { id }, data: { deletedAt, unreadCount: 0, lastMessage: "" } });
    });
    if (workspaceRootToDelete) await rm(workspaceRootToDelete, { recursive: true, force: true });
    await this.observability?.audit({
      actorUserId: currentUser.id,
      action: "conversation.delete",
      targetType: "conversation",
      targetId: id,
      payload: { type: conversation.type, workspaceId: conversation.workspaceId }
    });
    return { conversationId: id };
  }

  async setConversationPinned(currentUser: AgentHubUser, id: string, pinned: boolean): Promise<ConversationSummary> {
    const conversation = await this.assertCanAccessConversation(currentUser, id);
    const member = this.currentUserConversationMember(currentUser, conversation);
    await this.prisma.conversationMember.update({
      where: { id: member.id },
      data: { pinnedAt: pinned ? new Date() : null }
    });
    const updatedConversation = await this.getConversationRecordForSummary(currentUser, id);
    await this.observability?.audit({
      actorUserId: currentUser.id,
      action: pinned ? "conversation.pin" : "conversation.unpin",
      targetType: "conversation",
      targetId: id
    });
    return (await this.toConversationSummaries([updatedConversation], currentUser))[0]!;
  }

  async setConversationArchived(
    currentUser: AgentHubUser,
    id: string,
    archived: boolean,
    clearMemory = false
  ): Promise<ConversationSummary> {
    const conversation = await this.assertCanAccessConversation(currentUser, id);
    const member = this.currentUserConversationMember(currentUser, conversation);
    await this.prisma.conversationMember.update({
      where: { id: member.id },
      data: archived ? { archivedAt: new Date(), pinnedAt: null, unreadCount: 0 } : { archivedAt: null }
    });
    if (archived && clearMemory) {
      await this.clearConversationShortTermMemory(conversation);
    }
    const updatedConversation = await this.getConversationRecordForSummary(currentUser, id);
    await this.observability?.audit({
      actorUserId: currentUser.id,
      action: archived ? "conversation.archive" : "conversation.unarchive",
      targetType: "conversation",
      targetId: id,
      payload: { clearMemory: archived ? clearMemory : false }
    });
    return (await this.toConversationSummaries([updatedConversation], currentUser))[0]!;
  }

  private async clearConversationShortTermMemory(conversation: Conversation & { workspaceId: string | null; codeAgentId: string | null }) {
    const latestMemory = await this.prisma.conversationMemory.findFirst({
      where: { conversationId: conversation.id, deletedAt: null },
      orderBy: { version: "desc" }
    });
    if (!latestMemory) return;

    const base = asRecord(latestMemory.memory) ?? {};
    const baseChatMemory = asRecord(base.chatMemory) ?? {};
    const preservedProjectCore = asRecord(base.projectCore) ?? {};
    const preservedCodeExecution = asRecord(base.codeExecutionMemory) ?? {};
    const preservedPreferences = asRecord(base.preferences) ?? {};
    const preservedOpenQuestions = Array.isArray(base.openQuestions) ? base.openQuestions : [];
    const preservedTaskBriefs = Array.isArray(base.taskBriefs) ? base.taskBriefs : [];
    const pinMessages = Array.isArray(baseChatMemory.pinMessages) ? baseChatMemory.pinMessages : [];

    const nextMemory = {
      ...base,
      projectCore: preservedProjectCore,
      taskBriefs: preservedTaskBriefs,
      codeExecutionMemory: preservedCodeExecution,
      preferences: preservedPreferences,
      openQuestions: preservedOpenQuestions,
      chatMemory: {
        ...baseChatMemory,
        pinMessages,
        earlyCompressed: "",
        recentMessages: [],
        messageFileIndex: [],
        workspaceFileChanges: []
      }
    };

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const latest = attempt === 0
        ? latestMemory
        : await this.prisma.conversationMemory.findFirst({
          where: { conversationId: conversation.id, deletedAt: null },
          orderBy: { version: "desc" }
        });
      const nextVersion = (latest?.version ?? 0) + 1;
      try {
        await this.prisma.conversationMemory.create({
          data: {
            id: `memory-${nanoid(10)}`,
            conversationId: conversation.id,
            version: nextVersion,
            memory: nextMemory as Prisma.InputJsonValue
          }
        });
        return;
      } catch (error) {
        if (!isUniqueConstraintError(error) || attempt >= 4) throw error;
      }
    }
  }

  private async assertWorkspaceDeleteTarget(rootPath: string) {
    const absolutePath = resolve(rootPath);
    if (await isInsideAnyWorkspaceRootRealpath(this.config.workspacesRoot, absolutePath)) return absolutePath;
    throw new BadRequestException("Workspace path is outside the allowed root");
  }

  async createProject(currentUser: AgentHubUser, input: {
    title: string;
    goal?: string;
    codeAgentId?: string;
    memberUserIds?: string[];
    memberAgentIds?: string[];
    workspaceAccess?: "owner_only" | "project_members";
    initialMemory?: string;
  }): Promise<ConversationSummary> {
    const workspaceId = `workspace-${nanoid(8)}`;
    const conversationId = `conv-${nanoid(8)}`;
    const projectTitle = input.title.trim() || "未命名项目";
    const projectGoal = input.goal?.trim() ?? "";
    const codeAgentId = input.codeAgentId ?? "agent-codex";
    const workspaceRoot = resolve(this.config.workspacesRoot, workspaceId);
    const codeAgent = await this.findProjectUsableAgent(currentUser, codeAgentId, { type: "code" });
    if (!codeAgent) throw new BadRequestException(`Code Agent ${codeAgentId} not found`);
    const memberUserIds = Array.from(new Set([currentUser.id, ...(input.memberUserIds ?? [])]));
    await this.assertCanInviteProjectMembers(currentUser, memberUserIds);
    const memberUsers = await this.prisma.user.findMany({
      where: { id: { in: memberUserIds }, deletedAt: null },
      select: { id: true }
    });
    const validMemberUserIds = new Set(memberUsers.map((user) => user.id));
    const missingMemberUserId = memberUserIds.find((id) => !validMemberUserIds.has(id));
    if (missingMemberUserId) throw new BadRequestException(`Project member ${missingMemberUserId} not found`);
    const mandatoryAgentIds = new Set(["agent-orchestrator", "agent-universal", codeAgentId]);
    const memberAgentIds = Array.from(new Set(input.memberAgentIds ?? [])).filter((agentId) => !mandatoryAgentIds.has(agentId));
    const memberAgents = [];
    for (const agentId of memberAgentIds) {
      const agent = await this.findProjectUsableAgent(currentUser, agentId);
      if (!agent) throw new BadRequestException(`Project Agent ${agentId} not found`);
      if (agent.type === "code") throw new BadRequestException("Project conversation can only include one Code Agent");
      if (agent.type === "orchestrator") throw new BadRequestException("Project conversation uses the built-in Orchestrator");
      memberAgents.push(agent);
    }
    const workspaceAccess = input.workspaceAccess ?? "project_members";
    const memberCreates = [
      ...memberUserIds.map((memberId) => ({
        id: `member-${nanoid(10)}`,
        memberType: "user" as const,
        memberId,
        role: memberId === currentUser.id ? "owner" as const : "member" as const
      })),
      { id: `member-${nanoid(10)}`, memberType: "agent" as const, memberId: "agent-orchestrator", role: "orchestrator" as const },
      { id: `member-${nanoid(10)}`, memberType: "agent" as const, memberId: "agent-universal", role: "universal" as const },
      { id: `member-${nanoid(10)}`, memberType: "agent" as const, memberId: codeAgentId, role: "code" as const },
      ...memberAgents.map((agent) => ({
        id: `member-${nanoid(10)}`,
        memberType: "agent" as const,
        memberId: agent.id,
        role: agent.type as "product" | "ui" | "review" | "universal"
      }))
    ];
    const openingBlocks = buildProjectOpeningBlocks({
      title: projectTitle
    });
    const openingSummary = summarizeOpeningBlocks(openingBlocks);
    const orchestrator = builtInAgents.find((agent) => agent.id === "agent-orchestrator")!;
    const { conversation, openingMessage } = await this.prisma.$transaction(async (tx) => {
      const createdConversation = await tx.conversation.create({
        data: {
          id: conversationId,
          type: "project",
          title: projectTitle,
          avatar: "AH",
          workspaceId,
          codeAgentId,
          lastMessage: openingSummary,
          unreadCount: 0,
          memberCount: memberCreates.length,
          messageSeq: 1,
          members: {
            create: memberCreates
          },
          workspace: {
            create: {
              id: workspaceId,
              name: projectTitle,
              rootPath: workspaceRoot
            }
          },
          memories: {
            create: {
              id: `memory-${nanoid(10)}`,
              version: 1,
              memory: {
                projectCore: {
                  title: projectTitle,
                  goal: projectGoal,
                  initialMemory: input.initialMemory?.trim() ?? "",
                  workspaceAccess,
                  codeAgentId,
                  memberUserIds,
                  memberAgentIds,
                  mandatoryAgentIds: ["agent-orchestrator", "agent-universal", codeAgentId]
                },
                chatMemory: { pinMessages: [] }
              } as Prisma.InputJsonValue
            }
          }
        }
      });
      const createdMessage = await tx.message.create({
        data: {
          id: `msg-${nanoid(10)}`,
          conversationId,
          senderType: "agent",
          senderId: orchestrator.id,
          senderName: orchestrator.name,
          senderAvatar: orchestrator.avatar,
          senderSubtitle: "主协调 Agent",
          blocks: openingBlocks as unknown as Prisma.InputJsonValue,
          mentions: ["product", "ui", "codex", "deploy"] as unknown as Prisma.InputJsonValue,
          metadata: {
            kind: "project_opening",
            autoCreated: true
          } as Prisma.InputJsonValue,
          seq: 1,
          status: "sent"
        }
      });
      await tx.conversationMember.updateMany({
        where: { conversationId, memberType: "user", deletedAt: null },
        data: { unreadCount: { increment: 1 } }
      });
      return { conversation: createdConversation, openingMessage: createdMessage };
    });
    await ensureWorkspaceLayout(workspaceRoot);
    await this.observability?.audit({
      actorUserId: currentUser.id,
      action: "conversation.create_project",
      targetType: "conversation",
      targetId: conversation.id,
      payload: { workspaceId, codeAgentId, memberUserIds, memberAgentIds, workspaceAccess, initialMemoryConfigured: Boolean(input.initialMemory?.trim()) }
    });
    await this.realtime.emit("conversation", conversationId, "message.created", { message: toOpeningChatMessage(openingMessage) });
    for (const memberId of memberUserIds) {
      await this.realtime.emit("user", memberId, "conversation.updated", { conversationId, reason: "project_created" });
    }
    return toConversationSummary(conversation);
  }

  async openAgentConversation(currentUser: AgentHubUser, agentId: string): Promise<ConversationSummary> {
    const agent = await this.findVisibleAgent(currentUser, agentId);
    if (!agent) throw new NotFoundException(`Agent ${agentId} not found`);

    const currentUserConversationIds = await this.prisma.conversationMember.findMany({
      where: {
        memberType: "user",
        memberId: currentUser.id,
        deletedAt: null,
        conversation: { type: "agent_direct", deletedAt: null }
      },
      select: { conversationId: true }
    });
    const existingMember = await this.prisma.conversationMember.findFirst({
      where: {
        conversationId: { in: currentUserConversationIds.map((member) => member.conversationId) },
        memberType: "agent",
        memberId: agentId,
        deletedAt: null
      },
      include: { conversation: { include: { members: { where: { deletedAt: null } }, workspace: true } } }
    });
    if (existingMember?.conversation) {
      if (agent.type === "code" && existingMember.conversation.workspace?.rootPath) {
        await ensureWorkspaceLayout(existingMember.conversation.workspace.rootPath);
      }
      await this.observability?.audit({
        actorUserId: currentUser.id,
        action: "conversation.open_agent_direct",
        targetType: "conversation",
        targetId: existingMember.conversation.id,
        payload: { agentId, reused: true }
      });
      return (await this.toConversationSummaries([existingMember.conversation], currentUser))[0]!;
    }

    const conversationId = `conv-agent-${nanoid(8)}`;
    const isCodeAgent = agent.type === "code";
    const workspaceId = isCodeAgent ? `workspace-${nanoid(8)}` : undefined;
    const workspaceRoot = workspaceId ? resolve(this.config.workspacesRoot, workspaceId) : undefined;
    const conversation = await this.prisma.conversation.create({
      data: {
        id: conversationId,
        type: "agent_direct",
        title: agent.name,
        avatar: agent.avatar ?? agent.name.slice(0, 2),
        ...(workspaceId ? { workspaceId } : {}),
        ...(isCodeAgent ? { codeAgentId: agent.id } : {}),
        lastMessage: `直接和 ${agent.name} 讨论任务。`,
        unreadCount: 0,
        memberCount: 2,
        members: {
          create: [
            { id: `member-${nanoid(10)}`, memberType: "user", memberId: currentUser.id, role: "owner" },
            { id: `member-${nanoid(10)}`, memberType: "agent", memberId: agent.id, role: agent.type }
          ]
        },
        ...(workspaceId
          ? {
              workspace: {
                create: {
                  id: workspaceId,
                  name: agent.name,
                  rootPath: workspaceRoot!
                }
              }
            }
          : {})
      },
      include: { members: { where: { deletedAt: null } } }
    });
    if (workspaceRoot) await ensureWorkspaceLayout(workspaceRoot);
    await this.observability?.audit({
      actorUserId: currentUser.id,
      action: "conversation.open_agent_direct",
      targetType: "conversation",
      targetId: conversation.id,
      payload: { agentId, workspaceId, reused: false }
    });
    return (await this.toConversationSummaries([conversation], currentUser))[0]!;
  }

  private async assertCanInviteProjectMembers(currentUser: AgentHubUser, memberUserIds: string[]) {
    if (currentUser.role === "admin") return;
    const requestedPeerIds = memberUserIds.filter((id) => id !== currentUser.id);
    if (requestedPeerIds.length === 0) return;
    const accepted = await this.prisma.friendConnection.findMany({
      where: {
        status: "accepted",
        deletedAt: null,
        OR: [
          { requesterId: currentUser.id, addresseeId: { in: requestedPeerIds } },
          { addresseeId: currentUser.id, requesterId: { in: requestedPeerIds } }
        ]
      },
      select: { requesterId: true, addresseeId: true }
    });
    const allowed = new Set(accepted.map((connection) =>
      connection.requesterId === currentUser.id ? connection.addresseeId : connection.requesterId
    ));
    const blocked = requestedPeerIds.find((id) => !allowed.has(id));
    if (blocked) throw new BadRequestException(`Project member ${blocked} is not an accepted contact`);
  }

  async openDirectConversation(currentUser: AgentHubUser, targetUserId: string): Promise<ConversationSummary> {
    if (currentUser.id === targetUserId) throw new BadRequestException("Cannot create direct conversation with yourself");
    const targetUser = await this.prisma.user.findFirst({ where: { id: targetUserId, deletedAt: null } });
    if (!targetUser) throw new NotFoundException(`User ${targetUserId} not found`);
    const connection = await this.prisma.friendConnection.findFirst({
      where: {
        status: "accepted",
        deletedAt: null,
        OR: [
          { requesterId: currentUser.id, addresseeId: targetUserId },
          { requesterId: targetUserId, addresseeId: currentUser.id }
        ]
      }
    });
    if (!connection) throw new BadRequestException("Can only start direct chat with an accepted friend");

    const currentUserConversationIds = await this.prisma.conversationMember.findMany({
      where: {
        memberType: "user",
        memberId: currentUser.id,
        deletedAt: null,
        conversation: { type: "direct", deletedAt: null }
      },
      select: { conversationId: true }
    });
    const existingMember = await this.prisma.conversationMember.findFirst({
      where: {
        conversationId: { in: currentUserConversationIds.map((member) => member.conversationId) },
        memberType: "user",
        memberId: targetUserId,
        deletedAt: null
      },
      include: { conversation: true }
    });
    if (existingMember?.conversation) {
      const existingConversation = await this.prisma.conversation.findFirst({
        where: { id: existingMember.conversation.id, deletedAt: null },
        include: { members: { where: { deletedAt: null } } }
      });
      await this.observability?.audit({
        actorUserId: currentUser.id,
        action: "conversation.open_direct",
        targetType: "conversation",
        targetId: existingMember.conversation.id,
        payload: { targetUserId, reused: true }
      });
      return (await this.toConversationSummaries([existingConversation ?? existingMember.conversation], currentUser))[0]!;
    }

    const conversation = await this.prisma.conversation.create({
      data: {
        id: `conv-direct-${nanoid(8)}`,
        type: "direct",
        title: targetUser.name,
        avatar: targetUser.avatar ?? targetUser.name.slice(0, 2),
        lastMessage: "你们已经是好友，可以开始聊天了。",
        unreadCount: 0,
        memberCount: 2,
        members: {
          create: [
            { id: `member-${nanoid(10)}`, memberType: "user", memberId: currentUser.id, role: "owner" },
            { id: `member-${nanoid(10)}`, memberType: "user", memberId: targetUserId, role: "member" }
          ]
        }
      }
    });
    await this.observability?.audit({
      actorUserId: currentUser.id,
      action: "conversation.open_direct",
      targetType: "conversation",
      targetId: conversation.id,
      payload: { targetUserId, reused: false }
    });
    return toConversationSummary(conversation);
  }

  private assertConversationAccess(currentUser: AgentHubUser, conversation: Conversation & { members?: ConversationMember[] }) {
    const isMember = conversation.members?.some(
      (member) => member.memberType === "user" && member.memberId === currentUser.id && !member.deletedAt
    );
    if (!isMember) throw new NotFoundException("Conversation not found");
  }

  private currentUserConversationMember(currentUser: AgentHubUser, conversation: Conversation & { members?: ConversationMember[] }) {
    const member = conversation.members?.find((item) => item.memberType === "user" && item.memberId === currentUser.id && !item.deletedAt);
    if (!member) throw new BadRequestException("Current user is not a conversation member");
    return member;
  }

  private async getConversationRecordForSummary(currentUser: AgentHubUser, id: string) {
    const conversation = await this.prisma.conversation.findFirst({
      where: { id, deletedAt: null },
      include: {
        members: { where: { deletedAt: null } }
      }
    });
    if (!conversation) throw new NotFoundException("Conversation not found");
    this.assertConversationAccess(currentUser, conversation);
    return conversation;
  }

  private async findVisibleAgent(currentUser: AgentHubUser, agentId: string, extra: Prisma.AgentWhereInput = {}) {
    const base: Prisma.AgentWhereInput = { id: agentId, deletedAt: null, ...extra };
    if (currentUser.role === "admin") return this.prisma.agent.findFirst({ where: base });
    const installationFilter = await this.visibleAgentInstallationFilter(currentUser.id);
    return this.prisma.agent.findFirst({
      where: {
        ...base,
        OR: [
          { visibility: "public" },
          { installations: { some: installationFilter } }
        ]
      }
    });
  }

  private async findProjectUsableAgent(currentUser: AgentHubUser, agentId: string, extra: Prisma.AgentWhereInput = {}) {
    const base: Prisma.AgentWhereInput = { id: agentId, deletedAt: null, ...extra };
    if (currentUser.role === "admin") return this.prisma.agent.findFirst({ where: base });
    const installationFilter = await this.visibleAgentInstallationFilter(currentUser.id);
    return this.prisma.agent.findFirst({
      where: {
        ...base,
        OR: [
          { id: { in: builtInAgentIds } },
          { installations: { some: installationFilter } }
        ]
      }
    });
  }

  private async visibleAgentInstallationFilter(userId: string): Promise<Prisma.AgentInstallationWhereInput> {
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

  private async toConversationSummaries(
    conversations: Array<Conversation & { members?: ConversationMember[] }>,
    currentUser: AgentHubUser
  ) {
    const otherUserIds = Array.from(
      new Set(
        conversations.flatMap((conversation) =>
          conversation.type === "direct"
            ? (conversation.members ?? [])
                .filter((member) => member.memberType === "user" && member.memberId !== currentUser.id)
                .map((member) => member.memberId)
            : []
        )
      )
    );
    const users = otherUserIds.length
      ? await this.prisma.user.findMany({ where: { id: { in: otherUserIds }, deletedAt: null } })
      : [];
    const userById = new Map(users.map((user) => [user.id, user]));
    const directAgentIds = Array.from(
      new Set(
        conversations.flatMap((conversation) => {
          if (conversation.type !== "agent_direct") return [];
          const memberAgentIds = (conversation.members ?? [])
            .filter((member) => member.memberType === "agent" && !member.deletedAt)
            .map((member) => member.memberId);
          return conversation.codeAgentId ? [...memberAgentIds, conversation.codeAgentId] : memberAgentIds;
        })
      )
    );
    const agents = directAgentIds.length
      ? await this.prisma.agent.findMany({ where: { id: { in: directAgentIds }, deletedAt: null } })
      : [];
    const agentById = new Map(agents.map((agent) => [agent.id, agent]));
    return conversations.map((conversation) => toConversationSummary(conversation, currentUser, userById, agentById));
  }

  private async toConversationMemberProfiles(members: ConversationMember[] = []): Promise<ConversationMemberProfile[]> {
    const activeMembers = members.filter((member) => !member.deletedAt);
    const userIds = activeMembers.filter((member) => member.memberType === "user").map((member) => member.memberId);
    const agentIds = activeMembers.filter((member) => member.memberType === "agent").map((member) => member.memberId);
    const [users, agents] = await Promise.all([
      userIds.length ? this.prisma.user.findMany({ where: { id: { in: userIds }, deletedAt: null } }) : [],
      agentIds.length ? this.prisma.agent.findMany({ where: { id: { in: agentIds }, deletedAt: null } }) : []
    ]);
    const userById = new Map(users.map((user) => [user.id, user]));
    const agentById = new Map(agents.map((agent) => [agent.id, agent]));
    return activeMembers.map((member) => {
      if (member.memberType === "user") {
        const user = userById.get(member.memberId);
        return {
          id: member.memberId,
          type: "user",
          role: member.role,
          name: user?.name ?? "未知用户",
          avatar: user?.avatar ?? user?.name.slice(0, 2) ?? "U",
          subtitle: user?.publicId ? `ID ${user.publicId}` : "用户"
        };
      }
      if (member.memberType === "agent") {
        const agent = agentById.get(member.memberId);
        return {
          id: member.memberId,
          type: "agent",
          role: member.role,
          name: agent?.name ?? member.memberId,
          avatar: agent?.avatar ?? agent?.name.slice(0, 2) ?? "AI",
          subtitle: agent ? `${agent.type} Agent` : "Agent"
        };
      }
      return {
        id: member.memberId,
        type: "system",
        role: member.role,
        name: "System",
        avatar: "S",
        subtitle: "系统成员"
      };
    });
  }
}

function buildProjectOpeningBlocks(input: { title: string }): MessageBlock[] {
  return [
    createMarkdownBlock(
      `block-project-opening-${nanoid(8)}`,
      `欢迎来到${input.title}，我是 Orchestrator-agent，负责在群聊中辅助意图理解、任务分配和项目推进。现在，我们从哪开始？`
    )
  ];
}

function summarizeOpeningBlocks(blocks: MessageBlock[]) {
  const first = blocks[0];
  if (first?.type === "markdown") return first.payload.text.slice(0, 80);
  return "主 Agent 已初始化项目群。";
}

function toOpeningChatMessage(message: Message): ChatMessage {
  const metadata = asRecord(message.metadata);
  return {
    id: message.id,
    conversationId: message.conversationId,
    sender: {
      type: "agent",
      id: message.senderId,
      name: message.senderName,
      avatar: message.senderAvatar,
      ...(message.senderSubtitle ? { subtitle: message.senderSubtitle } : {})
    },
    blocks: message.blocks as unknown as MessageBlock[],
    mentions: Array.isArray(message.mentions) ? (message.mentions as string[]) : [],
    actions: [],
    ...(metadata ? { metadata } : {}),
    createdAt: message.createdAt.toISOString(),
    status: message.status as ChatMessage["status"]
  };
}

function normalizePinnedMessages(value: unknown): PinnedMessageMemory[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const pin = asRecord(item);
    if (!pin) return [];
    const messageId = stringValue(pin.messageId);
    const actionId = stringValue(pin.actionId);
    if (!messageId || !actionId) return [];
    return [{
      messageId,
      actionId,
      pinnedBy: stringValue(pin.pinnedBy) || "unknown",
      pinnedByType: pin.pinnedByType === "agent" || pin.pinnedByType === "system" ? pin.pinnedByType : "user",
      pinnedAt: stringValue(pin.pinnedAt) || new Date(0).toISOString(),
      senderName: stringValue(pin.senderName) || "未知发送者",
      summary: stringValue(pin.summary) || "已 Pin 消息"
    }];
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : "";
}

function cancelledRuntimeJobData(deletedAt: Date) {
  return {
    status: "cancelled",
    cancelRequested: true,
    completedAt: deletedAt,
    error: "Conversation deleted",
    deletedAt
  };
}

function assertChildPath(basePath: string, targetPath: string) {
  if (!isChildPath(basePath, targetPath)) {
    throw new BadRequestException("Workspace path is outside the allowed root");
  }
}

function workspaceDeleteRoots(workspacesRoot: string) {
  return workspaceAllowedRoots(workspacesRoot);
}

function compareConversationSummaries(left: ConversationSummary, right: ConversationSummary) {
  const leftPinned = left.pinnedAt ? Date.parse(left.pinnedAt) : 0;
  const rightPinned = right.pinnedAt ? Date.parse(right.pinnedAt) : 0;
  if (leftPinned || rightPinned) return rightPinned - leftPinned;
  return Date.parse(right.lastActiveAt) - Date.parse(left.lastActiveAt);
}

function toConversationSummary(
  conversation: Conversation & { members?: ConversationMember[] },
  currentUser?: AgentHubUser,
  userById?: Map<string, User>,
  agentById?: Map<string, Agent>
): ConversationSummary {
  let title = conversation.title;
  let avatar = conversation.avatar ?? "AH";
  const currentUserMember = currentUser
    ? conversation.members?.find((member) => member.memberType === "user" && member.memberId === currentUser.id && !member.deletedAt)
    : undefined;
  if (conversation.type === "direct" && currentUser) {
    const otherMember = conversation.members?.find(
      (member) => member.memberType === "user" && member.memberId !== currentUser.id && !member.deletedAt
    );
    const otherUser = otherMember ? userById?.get(otherMember.memberId) : undefined;
    if (otherUser) {
      title = otherUser.name;
      avatar = otherUser.avatar ?? otherUser.name.slice(0, 2);
    }
  }
  if (conversation.type === "agent_direct") {
    const agentMember = conversation.members?.find((member) => member.memberType === "agent" && !member.deletedAt);
    const agentId = agentMember?.memberId ?? conversation.codeAgentId ?? undefined;
    const agent = agentId ? agentById?.get(agentId) : undefined;
    if (agent) {
      avatar = agent.avatar ?? agent.name.slice(0, 2);
    }
  }
  const summary: ConversationSummary = {
    id: conversation.id,
    type: conversation.type as ConversationSummary["type"],
    title,
    avatar,
    lastMessage: conversation.lastMessage,
    lastActiveAt: conversation.updatedAt.toISOString(),
    ...(currentUserMember?.pinnedAt ? { pinnedAt: currentUserMember.pinnedAt.toISOString() } : {}),
    ...(currentUserMember?.archivedAt ? { archivedAt: currentUserMember.archivedAt.toISOString() } : {}),
    unreadCount: currentUserMember?.unreadCount ?? conversation.unreadCount,
    memberCount: conversation.memberCount
  };
  if (conversation.workspaceId) summary.workspaceId = conversation.workspaceId;
  if (conversation.codeAgentId) summary.codeAgentId = conversation.codeAgentId;
  return summary;
}

function isUniqueConstraintError(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}
