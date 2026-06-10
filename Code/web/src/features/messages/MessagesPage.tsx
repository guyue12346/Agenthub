import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams, NavLink, useNavigate } from "react-router-dom";
import { Archive, Pin, Plus, Search, Trash2, UsersRound, XCircle } from "lucide-react";
import {
  ORCHESTRATOR_EDGES,
  ORCHESTRATOR_NODES,
  createMarkdownBlock,
  type ChatMessage,
  type ConversationSummary,
  type OrchestratorRun,
  type PinnedMessageMemory
} from "@agenthub/shared";
import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { api } from "../../api/client";
import { queryKeys } from "../../api/query-keys";
import { AvatarMark } from "../../components/AvatarMark";
import { MessageRenderer, type ReviewDecisionInput } from "../../components/MessageRenderer";
import { useAuthStore } from "../../store/auth-store";
import { useUiStore } from "../../store/ui-store";
import { Composer } from "./Composer";
import { useRealtimeConversation } from "./useRealtimeConversation";
import { uploadFileInChunks, validateUploadFile } from "../../utils/upload";

type SendMessageInput = {
  text: string;
  replyToMessageId?: string;
  reference?: ChatMessage["reference"];
  attachments?: File[];
};

type CreateProjectInput = {
  title: string;
  goal?: string;
  codeAgentId?: string;
  memberUserIds: string[];
  memberAgentIds: string[];
  workspaceAccess: "owner_only" | "project_members";
  initialMemory?: string;
};

type MessageActionInput = {
  message: ChatMessage;
  type: "like" | "pin" | "comment";
  existingAction?: NonNullable<ChatMessage["actions"]>[number];
  payload?: Record<string, unknown>;
};

type ReviewDecisionMutationInput = ReviewDecisionInput;

type MessagesCache = {
  messages: ChatMessage[];
  pageInfo?: { hasMore: boolean; nextBeforeSeq?: number };
};

type ConversationContextMenu = {
  conversation: ConversationSummary;
  x: number;
  y: number;
};

function mergeConfirmedMessages(
  current: MessagesCache | undefined,
  message: ChatMessage,
  acknowledgements: ChatMessage[] = [],
  options: { replaceOptimistic?: boolean } = {}
): MessagesCache {
  if (!current) return { messages: [message, ...acknowledgements] };
  let replaced = false;
  const messages = current.messages.map((item) => {
    if (!options.replaceOptimistic || replaced || !item.id.startsWith("local-") || item.status !== "processing") return item;
    replaced = true;
    return message;
  });
  if (!replaced && !messages.some((item) => item.id === message.id)) messages.push(message);
  for (const acknowledgement of acknowledgements) {
    if (!messages.some((item) => item.id === acknowledgement.id)) messages.push(acknowledgement);
  }
  return { ...current, messages };
}

export function MessagesPage() {
  const { conversationId } = useParams();
  const queryClient = useQueryClient();
  const setDetail = useUiStore((state) => state.setDetail);
  const detail = useUiStore((state) => state.detail);
  const showToast = useUiStore((state) => state.showToast);
  const currentUser = useAuthStore((state) => state.user);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const navigate = useNavigate();
  const [conversationContextMenu, setConversationContextMenu] = useState<ConversationContextMenu | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ConversationSummary | null>(null);
  const [newProjectTitle, setNewProjectTitle] = useState("");
  const [newProjectGoal, setNewProjectGoal] = useState("");
  const [newProjectCodeAgentId, setNewProjectCodeAgentId] = useState("");
  const [newProjectMemberUserIds, setNewProjectMemberUserIds] = useState<string[]>([]);
  const [newProjectMemberAgentIds, setNewProjectMemberAgentIds] = useState<string[]>([]);
  const [newProjectWorkspaceAccess, setNewProjectWorkspaceAccess] = useState<"owner_only" | "project_members">("project_members");
  const [newProjectInitialMemory, setNewProjectInitialMemory] = useState("");
  const [conversationQuery, setConversationQuery] = useState("");
  const [showCreateProject, setShowCreateProject] = useState(false);
  const [replyTarget, setReplyTarget] = useState<ChatMessage | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const loadingOlderRef = useRef(false);

  const currentUserId = currentUser?.id ?? "";
  const normalizedConversationQuery = conversationQuery.trim();
  const conversationRootKey = currentUserId ? queryKeys.conversationRoot(currentUserId) : ["user", "anonymous", "conversations"] as const;
  const conversationsKey = currentUserId ? queryKeys.conversations(currentUserId) : ["user", "anonymous", "conversations", "all"] as const;
  const conversationSearchKey =
    currentUserId && normalizedConversationQuery
      ? queryKeys.conversations(currentUserId, normalizedConversationQuery)
      : conversationsKey;
  const messagesKey = currentUserId && conversationId ? queryKeys.messages(currentUserId, conversationId) : ["user", currentUserId, "messages", conversationId ?? ""] as const;
  const runsKey = currentUserId && conversationId ? queryKeys.runs(currentUserId, conversationId) : ["user", currentUserId, "runs", conversationId ?? ""] as const;
  const conversations = useQuery({ queryKey: conversationsKey, queryFn: () => api.conversations(), enabled: Boolean(currentUser) });
  const searchedConversations = useQuery({
    queryKey: conversationSearchKey,
    queryFn: () => api.conversations({ search: normalizedConversationQuery }),
    enabled: Boolean(currentUser && normalizedConversationQuery)
  });
  const resolvedConversationId = conversationId ?? conversations.data?.conversations[0]?.id ?? "";
  const resolvedMessagesKey = currentUserId ? queryKeys.messages(currentUserId, resolvedConversationId) : messagesKey;
  const resolvedRunsKey = currentUserId ? queryKeys.runs(currentUserId, resolvedConversationId) : runsKey;
  const memoryKey = currentUserId && resolvedConversationId ? queryKeys.conversationMemory(currentUserId, resolvedConversationId) : ["user", currentUserId, "conversation-memory", resolvedConversationId] as const;
  const activeConversation = conversations.data?.conversations.find((item) => item.id === resolvedConversationId);
  const localFilteredConversations = (conversations.data?.conversations ?? []).filter((conversation) => {
    if (!normalizedConversationQuery) return true;
    return [conversation.title, conversation.lastMessage, conversation.codeAgentId ?? "", conversation.type]
      .join(" ")
      .toLowerCase()
      .includes(normalizedConversationQuery.toLowerCase());
  });
  const visibleConversations = normalizedConversationQuery
    ? searchedConversations.data?.conversations ?? localFilteredConversations
    : conversations.data?.conversations ?? [];
  const conversationColorKeys = new Map(
    visibleConversations
      .filter((conversation) => conversation.type === "project")
      .map((conversation, index) => [conversation.id, `conversation-color-${(index % 13) + 1}`])
  );
  const activeConversationColorKey = activeConversation ? conversationColorKeys.get(activeConversation.id) ?? activeConversation.id : undefined;
  const conversationListReady = normalizedConversationQuery ? searchedConversations.isSuccess || conversations.isSuccess : conversations.isSuccess;
  const accessDenied = Boolean(conversationId) && conversations.isSuccess && !activeConversation;
  const emptyConversations = conversations.isSuccess && conversations.data.conversations.length === 0;
  useRealtimeConversation(activeConversation ? resolvedConversationId : "", activeConversation?.unreadCount ?? 0, activeConversation?.lastActiveAt ?? "");

  const messages = useQuery({
    queryKey: resolvedMessagesKey,
    queryFn: () => api.messages(resolvedConversationId),
    enabled: Boolean(currentUser && activeConversation)
  });
  const conversationMemory = useQuery({
    queryKey: memoryKey,
    queryFn: () => api.conversationMemory(resolvedConversationId),
    enabled: Boolean(currentUser && activeConversation?.type === "project")
  });
  const agents = useQuery({
    queryKey: currentUserId ? queryKeys.agents(currentUserId, "personal", true) : ["agents", "personal", "with-system"],
    queryFn: () => api.agents("personal", { includeSystem: true }),
    enabled: Boolean(currentUser)
  });
  const users = useQuery({ queryKey: currentUserId ? queryKeys.users(currentUserId) : ["users"], queryFn: api.users, enabled: Boolean(currentUser) });
  const codeAgents = (agents.data?.agents ?? []).filter((agent) => agent.type === "code");
  const selectedCodeAgent = codeAgents.find((agent) => agent.id === newProjectCodeAgentId) ?? codeAgents[0];
  const selectableProjectAgents = useMemo(
    () =>
      (agents.data?.agents ?? []).filter((agent) => {
        if (agent.id === "agent-orchestrator" || agent.id === "agent-universal") return false;
        if (agent.type === "orchestrator" || agent.type === "code") return false;
        return true;
      }),
    [agents.data?.agents]
  );
  const mentionAgents = useMemo(() => {
    if (activeConversation?.type !== "project") return [];
    const currentCodeAgentId = activeConversation.codeAgentId ?? "agent-codex";
    return (agents.data?.agents ?? []).filter((agent) => {
      if (agent.id === "agent-universal") return false;
      if (agent.id === "agent-orchestrator") return true;
      if (agent.type === "orchestrator") return false;
      if (agent.type === "code") return agent.id === currentCodeAgentId;
      return true;
    });
  }, [activeConversation?.codeAgentId, activeConversation?.type, agents.data?.agents]);
  const runs = useQuery({
    queryKey: resolvedRunsKey,
    queryFn: () => api.runs(resolvedConversationId),
    enabled: Boolean(currentUser && activeConversation)
  });
  const pinnedMessages = conversationMemory.data?.memory.chatMemory.pinMessages ?? [];

  const uploadConversationAttachments = async (files: File[]) => {
    const uploaded: Array<{ workspaceId: string; assetId: string }> = [];
    for (const file of files) {
      validateUploadFile(file, file.name, 50_000_000);
      const uploadResult = await uploadFileInChunks(file, {
        begin: (input) => api.beginConversationAssetUpload(resolvedConversationId, input).then((response) => response.upload),
        uploadChunk: (session, chunk) => api.uploadWorkspaceChunk(session.workspaceId, session.uploadId, chunk),
        complete: (session) => api.completeWorkspaceUpload(session.workspaceId, session.uploadId),
        cancel: (session) => api.cancelWorkspaceUpload(session.workspaceId, session.uploadId)
      });
      uploaded.push({ workspaceId: uploadResult.asset.workspaceId, assetId: uploadResult.asset.id });
    }
    return uploaded;
  };

  const schedulePostSendRefresh = () => {
    const refreshDelaysMs = [800, 2_500, 4_500, 7_000, 9_500, 12_000, 15_000, 18_000];
    for (const delayMs of refreshDelaysMs) {
      window.setTimeout(() => {
        void queryClient.invalidateQueries({ queryKey: resolvedMessagesKey });
        void queryClient.invalidateQueries({ queryKey: resolvedRunsKey });
        void queryClient.invalidateQueries({ queryKey: conversationRootKey });
      }, delayMs);
    }
  };

  const send = useMutation({
    mutationFn: async (input: SendMessageInput) => {
      const text = input.text.trim();
      const attachments = input.attachments?.length ? input.attachments : [];
      if (attachments.length === 0) {
        return api.sendMessage(
          resolvedConversationId,
          text,
          input.replyToMessageId ? { replyToMessageId: input.replyToMessageId } : undefined
        );
      }
      const uploadedAttachments = await uploadConversationAttachments(attachments);
      return api.sendAssetMessageFromUploads(
        resolvedConversationId,
        {
          attachments: uploadedAttachments,
          ...(text ? { text } : {}),
          ...(input.replyToMessageId ? { replyToMessageId: input.replyToMessageId } : {})
        }
      );
    },
    onMutate: async (input: SendMessageInput) => {
      const attachmentSummary =
        input.text.trim() ||
        (input.attachments?.length
          ? `发送了 ${input.attachments.length} 个附件：${input.attachments.map((item) => item.name).join(", ")}`
          : "");
      await queryClient.cancelQueries({ queryKey: resolvedMessagesKey });
      const previous = queryClient.getQueryData<typeof messages.data>(resolvedMessagesKey);
      const optimisticId = `local-${Date.now()}`;
      const optimisticMessage: ChatMessage = {
        id: optimisticId,
        conversationId: resolvedConversationId,
        sender: {
          type: "user",
          id: currentUser?.id ?? "current-user",
          name: currentUser?.name ?? "我",
          avatar: currentUser?.avatar ?? "ME"
        },
        blocks: [createMarkdownBlock(`block-${optimisticId}`, attachmentSummary || "发送消息")],
        mentions: [],
        actions: [],
        ...(input.reference ? { reference: input.reference } : {}),
        createdAt: new Date().toISOString(),
        status: "processing"
      };
      queryClient.setQueryData<typeof messages.data>(resolvedMessagesKey, (current) => ({
        ...(current ?? {}),
        messages: [...(current?.messages ?? []), optimisticMessage]
      }));
      return { previous, optimisticId };
    },
    onSuccess: ({ message, acknowledgements }) => {
      queryClient.setQueryData<typeof messages.data>(resolvedMessagesKey, (current) => {
        return mergeConfirmedMessages(current, message, acknowledgements, { replaceOptimistic: true });
      });
      schedulePostSendRefresh();
    },
    onError: (error, _input, context) => {
      if (context?.previous) queryClient.setQueryData(resolvedMessagesKey, context.previous);
      showToast(error instanceof Error ? error.message : "消息发送失败", "warning");
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: conversationRootKey });
    }
  });
  const messageAction = useMutation({
    mutationFn: async ({ message, type, existingAction, payload }: MessageActionInput) => {
      if (existingAction) {
        return {
          deleted: await api.deleteMessageAction(resolvedConversationId, message.id, existingAction.id)
        };
      }
      return {
        action: await api.createMessageAction(resolvedConversationId, message.id, type, payload)
      };
    },
    onSuccess: (result) => {
      queryClient.setQueryData<typeof messages.data>(resolvedMessagesKey, (current) => {
        if (!current) return current;
        return {
          ...current,
          messages: current.messages.map((message) => {
            const action = "action" in result ? result.action.action : undefined;
            const deleted = "deleted" in result ? result.deleted : undefined;
            const messageId = action?.messageId ?? deleted?.messageId;
            if (message.id !== messageId) return message;
            const actions = message.actions ?? [];
            if (deleted) return { ...message, actions: actions.filter((item) => item.id !== deleted.actionId) };
            if (!action || actions.some((item) => item.id === action.id)) return message;
            return { ...message, actions: [...actions, action] };
          })
        };
      });
      void queryClient.invalidateQueries({ queryKey: memoryKey });
      if ("deleted" in result) {
        showToast(result.deleted.type === "pin" ? "已从长期记忆 Pin 列表移除" : "已取消", "success");
        return;
      }
      const action = result.action.action;
      showToast(action.type === "pin" ? "已 Pin 到会话记忆" : action.type === "comment" ? "评论已添加" : "已点赞", "success");
    },
    onError: (error) => {
      showToast(error instanceof Error ? error.message : "操作失败", "warning");
    }
  });
  const reviewDecision = useMutation({
    mutationFn: async (input: ReviewDecisionMutationInput) => {
      const workspaceId = activeConversation?.workspaceId;
      if (!workspaceId) throw new Error("当前会话没有工作空间，无法处理代码审阅");
      if (input.decision === "approve") return api.approveWorkspaceGitProposal(workspaceId, input.proposalId);
      return api.rejectWorkspaceGitProposal(workspaceId, input.proposalId, input.reason?.trim() || "需要继续修改");
    },
    onSuccess: (_result, input) => {
      const workspaceId = activeConversation?.workspaceId;
      if (workspaceId && currentUserId) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.workspaceGit(currentUserId, workspaceId) });
        void queryClient.invalidateQueries({ queryKey: queryKeys.workspaceTree(currentUserId, workspaceId) });
        void queryClient.invalidateQueries({ queryKey: queryKeys.assets(currentUserId, workspaceId) });
      }
      void queryClient.invalidateQueries({ queryKey: resolvedMessagesKey });
      void queryClient.invalidateQueries({ queryKey: conversationRootKey });
      showToast(input.decision === "approve" ? "代码审阅已通过" : "已打回修改意见", "success");
    },
    onError: (error) => {
      showToast(error instanceof Error ? error.message : "代码审阅操作失败", "warning");
    }
  });
  const deleteConversation = useMutation({
    mutationFn: (input: { conversationId: string; title: string }) => {
      return api.deleteConversation(input.conversationId, input.title);
    },
    onSuccess: (_result, input) => {
      const deletedMessagesKey = currentUserId ? queryKeys.messages(currentUserId, input.conversationId) : resolvedMessagesKey;
      const deletedRunsKey = currentUserId ? queryKeys.runs(currentUserId, input.conversationId) : resolvedRunsKey;
      queryClient.removeQueries({ queryKey: deletedMessagesKey });
      queryClient.removeQueries({ queryKey: deletedRunsKey });
      const fallback = conversations.data?.conversations.find((item) => item.id !== input.conversationId);
      void queryClient.invalidateQueries({ queryKey: conversationRootKey });
      setDeleteTarget(null);
      setConversationContextMenu(null);
      showToast("会话全部内容已清空", "success");
      if (input.conversationId === resolvedConversationId) {
        navigate(fallback ? `/messages/${fallback.id}` : "/contacts", { replace: true });
      }
    },
    onError: (error) => {
      showToast(error instanceof Error ? error.message : "清空全部内容失败", "warning");
    }
  });
  const togglePinConversation = useMutation({
    mutationFn: (input: { conversation: ConversationSummary }) =>
      input.conversation.pinnedAt ? api.unpinConversation(input.conversation.id) : api.pinConversation(input.conversation.id),
    onSuccess: ({ conversation }) => {
      void queryClient.invalidateQueries({ queryKey: conversationRootKey });
      setConversationContextMenu(null);
      showToast(conversation.pinnedAt ? "会话已置顶" : "已取消置顶", "success");
    },
    onError: (error) => {
      showToast(error instanceof Error ? error.message : "置顶操作失败", "warning");
    }
  });
  const archiveConversation = useMutation({
    mutationFn: (input: { conversation: ConversationSummary }) =>
      api.archiveConversation(input.conversation.id, { clearMemory: true }),
    onSuccess: (_result, input) => {
      const fallback = conversations.data?.conversations.find((item) => item.id !== input.conversation.id);
      queryClient.setQueriesData<{ conversations: ConversationSummary[] }>({ queryKey: conversationRootKey }, (current) => {
        if (!current) return current;
        return { conversations: current.conversations.filter((conversation) => conversation.id !== input.conversation.id) };
      });
      void queryClient.invalidateQueries({ queryKey: conversationRootKey });
      setConversationContextMenu(null);
      showToast("会话已归档，可在设置中恢复", "success");
      if (input.conversation.id === resolvedConversationId) {
        navigate(fallback ? `/messages/${fallback.id}` : "/settings", { replace: true });
      }
    },
    onError: (error) => {
      showToast(error instanceof Error ? error.message : "归档失败", "warning");
    }
  });
  const createProject = useMutation({
    mutationFn: (input: CreateProjectInput) => api.createProjectConversation(input),
    onSuccess: async ({ conversation }) => {
      setNewProjectTitle("");
      setNewProjectGoal("");
      setNewProjectCodeAgentId("");
      setNewProjectMemberUserIds([]);
      setNewProjectMemberAgentIds([]);
      setNewProjectWorkspaceAccess("project_members");
      setNewProjectInitialMemory("");
      setShowCreateProject(false);
      queryClient.setQueryData<{ conversations: ConversationSummary[] }>(conversationsKey, (current) => {
        const previous = current?.conversations ?? [];
        return { conversations: [conversation, ...previous.filter((item) => item.id !== conversation.id)] };
      });
      await queryClient.invalidateQueries({ queryKey: conversationRootKey });
      navigate(`/messages/${conversation.id}`);
    },
    onError: (error) => {
      showToast(error instanceof Error ? error.message : "创建项目群聊失败", "warning");
    }
  });

  useEffect(() => {
    if (detail.kind !== "run") return;
    const latestRun = runs.data?.runs[0];
    if (!latestRun) return;
    const updatedRun = detail.run.id === "orchestrator-idle" ? latestRun : runs.data?.runs.find((run) => run.id === detail.run.id);
    if (updatedRun && updatedRun !== detail.run) {
      setDetail({ kind: "run", run: updatedRun });
    }
  }, [detail, runs.data?.runs, setDetail]);

  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    if (loadingOlderRef.current) return;
    if (typeof node.scrollTo === "function") node.scrollTo({ top: node.scrollHeight, behavior: "smooth" });
    else node.scrollTop = node.scrollHeight;
  }, [resolvedConversationId, messages.data?.messages.length]);

  useEffect(() => {
    setConversationContextMenu(null);
    setDeleteTarget(null);
    setReplyTarget(null);
  }, [resolvedConversationId]);

  useEffect(() => {
    if (!conversationContextMenu) return undefined;
    const closeMenu = () => setConversationContextMenu(null);
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeMenu();
    };
    window.addEventListener("click", closeMenu);
    window.addEventListener("resize", closeMenu);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("click", closeMenu);
      window.removeEventListener("resize", closeMenu);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [conversationContextMenu]);

  const loadOlderMessages = async () => {
    const pageInfo = messages.data?.pageInfo;
    if (!pageInfo?.hasMore || !pageInfo.nextBeforeSeq || loadingOlderRef.current) return;
    const node = scrollRef.current;
    const previousHeight = node?.scrollHeight ?? 0;
    const previousTop = node?.scrollTop ?? 0;
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    try {
      const olderPage = await api.messages(resolvedConversationId, { beforeSeq: pageInfo.nextBeforeSeq, limit: 50 });
      queryClient.setQueryData<typeof messages.data>(resolvedMessagesKey, (current) => {
        const currentMessages = current?.messages ?? [];
        const currentIds = new Set(currentMessages.map((message) => message.id));
        const olderMessages = olderPage.messages.filter((message) => !currentIds.has(message.id));
        const nextPage = {
          ...(current ?? {}),
          messages: [...olderMessages, ...currentMessages]
        };
        return olderPage.pageInfo ? { ...nextPage, pageInfo: olderPage.pageInfo } : nextPage;
      });
      requestAnimationFrame(() => {
        const nextNode = scrollRef.current;
        if (!nextNode) return;
        nextNode.scrollTop = nextNode.scrollHeight - previousHeight + previousTop;
      });
    } catch (error) {
      showToast(error instanceof Error ? error.message : "加载历史消息失败", "warning");
    } finally {
      loadingOlderRef.current = false;
      setLoadingOlder(false);
    }
  };

  const openConversationContextMenu = (event: MouseEvent, conversation: ConversationSummary) => {
    event.preventDefault();
    event.stopPropagation();
    setConversationContextMenu({
      conversation,
      x: Math.min(event.clientX, window.innerWidth - 220),
      y: Math.min(event.clientY, window.innerHeight - 96)
    });
  };

  return (
    <div className="messages-layout">
      <aside className="list-panel">
        <div className="module-title">
          <UsersRound size={22} />
          <h1>消息</h1>
        </div>
        <div className="search-create-row">
          <label className="search-box">
            <Search size={18} />
            <input
              value={conversationQuery}
              onChange={(event) => setConversationQuery(event.target.value)}
              placeholder="搜索会话"
            />
          </label>
          <button
            className="new-project-button"
            type="button"
            title="新建项目群聊"
            onClick={() => setShowCreateProject(true)}
          >
            <Plus size={16} />
          </button>
        </div>
        {showCreateProject ? (
          <div className="create-project-backdrop" role="presentation" onMouseDown={() => setShowCreateProject(false)}>
          <form
            className="create-project-panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="create-project-title"
            onMouseDown={(event) => event.stopPropagation()}
            onSubmit={(event) => {
              event.preventDefault();
              const title = newProjectTitle.trim();
              if (!title) return;
              const input: CreateProjectInput = {
                title,
                memberUserIds: newProjectMemberUserIds,
                memberAgentIds: newProjectMemberAgentIds,
                workspaceAccess: newProjectWorkspaceAccess
              };
              const goal = newProjectGoal.trim();
              const codeAgentId = (newProjectCodeAgentId || codeAgents[0]?.id || "agent-codex").trim();
              const initialMemory = newProjectInitialMemory.trim();
              if (goal) input.goal = goal;
              if (codeAgentId) input.codeAgentId = codeAgentId;
              if (initialMemory) input.initialMemory = initialMemory;
              createProject.mutate(input);
            }}
          >
            <header className="create-project-header">
              <div>
                <h3 id="create-project-title">新建项目群聊</h3>
                <p>选择成员、一个 Code Agent 和需要加入群聊协作的项目 Agent。</p>
              </div>
              <button className="icon-button" type="button" title="关闭" onClick={() => setShowCreateProject(false)}>
                <XCircle size={18} />
              </button>
            </header>
            <input
              autoFocus
              value={newProjectTitle}
              onChange={(event) => setNewProjectTitle(event.target.value)}
              placeholder="输入项目群聊名称"
            />
            <textarea
              value={newProjectGoal}
              onChange={(event) => setNewProjectGoal(event.target.value)}
              placeholder="项目目标"
            />
            <label>
              <span>Code Agent</span>
              <select value={newProjectCodeAgentId} onChange={(event) => setNewProjectCodeAgentId(event.target.value)}>
                {codeAgents.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name}
                  </option>
                ))}
                {codeAgents.length === 0 ? <option value="agent-codex">Codex</option> : null}
              </select>
            </label>
            <label>
              <span>工作空间权限</span>
              <select
                value={newProjectWorkspaceAccess}
                onChange={(event) => setNewProjectWorkspaceAccess(event.target.value as "owner_only" | "project_members")}
              >
                <option value="project_members">项目成员可访问</option>
                <option value="owner_only">仅创建者可管理</option>
              </select>
            </label>
            <div className="create-project-members">
              <span>成员</span>
              {(users.data?.users ?? [])
                .filter((user) => user.id !== currentUserId)
                .map((user) => {
                  const checked = newProjectMemberUserIds.includes(user.id);
                  return (
                    <label key={user.id}>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(event) => {
                          setNewProjectMemberUserIds((current) =>
                            event.target.checked ? [...current, user.id] : current.filter((id) => id !== user.id)
                          );
                        }}
                      />
                      <span>{user.name}</span>
                    </label>
                  );
                })}
            </div>
            <div className="create-project-members">
              <span>项目 Agent</span>
              {selectableProjectAgents.length > 0 ? (
                selectableProjectAgents.map((agent) => {
                  const checked = newProjectMemberAgentIds.includes(agent.id);
                  return (
                    <label key={agent.id}>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(event) => {
                          setNewProjectMemberAgentIds((current) =>
                            event.target.checked ? [...current, agent.id] : current.filter((id) => id !== agent.id)
                          );
                        }}
                      />
                      <span>{agent.name}</span>
                    </label>
                  );
                })
              ) : (
                <p className="create-project-required-agents">通讯录里暂无可加入的项目 Agent</p>
              )}
            </div>
            <textarea
              value={newProjectInitialMemory}
              onChange={(event) => setNewProjectInitialMemory(event.target.value)}
              placeholder="初始长期记忆"
            />
            <div className="create-project-actions">
              <button type="button" className="secondary-button compact" onClick={() => setShowCreateProject(false)}>
                取消
              </button>
              <button className="primary-button compact" type="submit" disabled={createProject.isPending || !newProjectTitle.trim()}>
                创建
              </button>
            </div>
          </form>
          </div>
        ) : null}
        <div className="conversation-list" aria-label="会话列表" onScroll={() => setConversationContextMenu(null)}>
          {visibleConversations.map((conversation) => (
            <NavLink
              key={conversation.id}
              to={`/messages/${conversation.id}`}
              className="conversation-item"
              onContextMenu={(event) => openConversationContextMenu(event, conversation)}
            >
              <AvatarMark
                className="conversation-avatar"
                kind="conversation"
                value={conversation.avatar}
                label={conversation.title}
                variantKey={conversation.type === "project" ? conversationColorKeys.get(conversation.id) : conversation.id}
              />
              <span>
                <strong>{conversation.title}</strong>
                <small>{conversation.lastMessage}</small>
              </span>
              <span className="conversation-meta">
                {conversation.pinnedAt ? <Pin className="conversation-pin" size={13} aria-label="已置顶" /> : null}
                <time>{new Date(conversation.lastActiveAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</time>
                {conversation.id !== resolvedConversationId && conversation.unreadCount > 0 ? (
                  <span className="unread-badge" aria-label={`${conversation.unreadCount} 条未读消息`}>
                    {conversation.unreadCount > 99 ? "99+" : conversation.unreadCount}
                  </span>
                ) : null}
              </span>
            </NavLink>
          ))}
          {conversationListReady && visibleConversations.length === 0 ? (
            <div className="conversation-empty">没有匹配的会话</div>
          ) : null}
        </div>
        {conversationContextMenu ? (
          <div
            className="conversation-context-menu"
            style={{ left: conversationContextMenu.x, top: conversationContextMenu.y }}
            role="menu"
            aria-label={`${conversationContextMenu.conversation.title} 操作`}
            onClick={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              role="menuitem"
              disabled={togglePinConversation.isPending}
              onClick={() => togglePinConversation.mutate({ conversation: conversationContextMenu.conversation })}
            >
              <Pin size={15} />
              <span>{conversationContextMenu.conversation.pinnedAt ? "取消置顶" : "置顶"}</span>
            </button>
            <button
              type="button"
              role="menuitem"
              disabled={archiveConversation.isPending}
              onClick={() => archiveConversation.mutate({ conversation: conversationContextMenu.conversation })}
            >
              <Archive size={15} />
              <span>归档</span>
            </button>
            <button
              type="button"
              role="menuitem"
              className="danger"
              onClick={() => {
                setDeleteTarget(conversationContextMenu.conversation);
                setConversationContextMenu(null);
              }}
            >
              <Trash2 size={15} />
              <span>清空全部内容</span>
            </button>
          </div>
        ) : null}
        {deleteTarget ? (
          <div className="danger-confirm-backdrop" role="presentation" onMouseDown={() => setDeleteTarget(null)}>
            <section
              className="danger-confirm-dialog"
              role="dialog"
              aria-modal="true"
              aria-labelledby="delete-conversation-title"
              onMouseDown={(event) => event.stopPropagation()}
            >
              <h3 id="delete-conversation-title">清空全部内容</h3>
              <p>
                将删除「{deleteTarget.title}」的聊天记录、运行记录、长期记忆、附件资产和工作空间文件，并从消息列表移除该会话。
              </p>
              <div className="danger-confirm-actions">
                <button type="button" className="secondary-button" onClick={() => setDeleteTarget(null)}>
                  取消
                </button>
                <button
                  type="button"
                  className="danger-button"
                  disabled={deleteConversation.isPending}
                  onClick={() => deleteConversation.mutate({ conversationId: deleteTarget.id, title: deleteTarget.title })}
                >
                  清空全部内容
                </button>
              </div>
            </section>
          </div>
        ) : null}
      </aside>
      <section className="chat-panel">
        <header className="chat-header">
          <AvatarMark
            className="conversation-avatar large"
            kind="conversation"
            size="lg"
            value={activeConversation?.avatar ?? "AH"}
            label={activeConversation?.title ?? "无法访问会话"}
            variantKey={activeConversationColorKey}
            title="查看群聊信息"
            onClick={() => {
              if (activeConversation) setDetail({ kind: "conversation", conversationId: activeConversation.id });
            }}
          />
          <div>
            <h2>{activeConversation?.title ?? "无法访问会话"}</h2>
          </div>
        </header>
        <div
          className="message-scroll"
          ref={scrollRef}
          onScroll={(event) => {
            if (event.currentTarget.scrollTop < 80) void loadOlderMessages();
          }}
        >
          {emptyConversations ? (
            <div className="empty-chat-state">
              <h3>还没有会话</h3>
              <p>从通讯录打开好友或 Agent 聊天，或通过项目创建入口新建项目群聊后，这里会显示真实聊天记录。</p>
            </div>
          ) : accessDenied ? (
            <div className="empty-chat-state">
              <h3>当前账号无权访问这个会话</h3>
              <p>请从左侧选择当前账号可见的聊天，或到通讯录打开好友 / Agent 聊天。</p>
            </div>
          ) : (
            <>
              {activeConversation?.type === "project" && pinnedMessages.length > 0 ? (
                <PinnedMemoryList version={conversationMemory.data?.memory.version ?? 0} pins={pinnedMessages} />
              ) : null}
              {messages.data?.pageInfo?.hasMore ? (
                <button className="load-older-button" type="button" disabled={loadingOlder} onClick={() => void loadOlderMessages()}>
                  {loadingOlder ? "正在加载..." : "加载更早消息"}
                </button>
              ) : null}
              {messages.data?.messages.map((message) => (
              <MessageRenderer
                key={message.id}
                message={message}
                currentUserId={currentUser?.id}
                workspaceId={activeConversation?.workspaceId}
                onOpenSender={(targetMessage) => {
                  if (targetMessage.sender.type === "user") {
                    setDetail({
                      kind: "person",
                      person: {
                        id: targetMessage.sender.id,
                        type: "user",
                        name: targetMessage.sender.name,
                        avatar: targetMessage.sender.avatar,
                        subtitle: "用户"
                      }
                    });
                    return;
                  }
                  if (targetMessage.sender.type === "system") {
                    setDetail({
                      kind: "person",
                      person: {
                        id: targetMessage.sender.id,
                        type: "system",
                        name: targetMessage.sender.name,
                        avatar: targetMessage.sender.avatar,
                        subtitle: "系统"
                      }
                    });
                    return;
                  }
                  if (targetMessage.sender.type !== "agent") return;
                  const agentId = normalizeMessageSenderAgentId(targetMessage.sender.id);
                  if (agentId === "agent-orchestrator") {
                    const statusRunId = targetMessage.blocks.find((block) => block.type === "agent_status")?.payload.targetId;
                    const run =
                      runs.data?.runs.find((item) => item.id === statusRunId) ??
                      runs.data?.runs[0] ??
                      createIdleOrchestratorRun(resolvedConversationId);
                    setDetail({ kind: "run", run });
                    return;
                  }
                  setDetail({ kind: "agent", agentId });
                }}
                onOpenAsset={async (assetId) => {
                  const workspaceId = activeConversation?.workspaceId;
                  if (!workspaceId) {
                    showToast("当前会话没有工作空间，无法预览附件", "warning");
                    return;
                  }
                  try {
                    const { asset } = await queryClient.fetchQuery({
                      queryKey: currentUserId ? queryKeys.asset(currentUserId, workspaceId, assetId) : ["asset", workspaceId, assetId],
                      queryFn: () => api.asset(workspaceId, assetId)
                    });
                    setDetail({ kind: "asset", asset });
                  } catch (error) {
                    showToast(error instanceof Error ? error.message : "资源加载失败", "warning");
                  }
                }}
                onOpenPreview={(title, url) => setDetail({ kind: "preview", title, url })}
                onReply={(targetMessage) => setReplyTarget(targetMessage)}
                onLike={(targetMessage, existingAction) => {
                  const input: MessageActionInput = { message: targetMessage, type: "like" };
                  if (existingAction) input.existingAction = existingAction;
                  messageAction.mutate(input);
                }}
                canPin={activeConversation?.type === "project"}
                onPin={(targetMessage, existingAction) => {
                  if (activeConversation?.type !== "project") return;
                  const input: MessageActionInput = { message: targetMessage, type: "pin" };
                  if (existingAction) input.existingAction = existingAction;
                  messageAction.mutate(input);
                }}
                onComment={(targetMessage, text) => messageAction.mutate({ message: targetMessage, type: "comment", payload: { text } })}
                onReviewDecision={(input) => reviewDecision.mutate(input)}
                reviewBusyKey={reviewDecision.isPending ? reviewDecision.variables?.proposalId ?? null : null}
              />
              ))}
            </>
          )}
        </div>
        <Composer
          agents={mentionAgents}
          conversationTitle={activeConversation?.title ?? "当前会话"}
          enableMentions={activeConversation?.type === "project"}
          replyTarget={replyTarget}
          onCancelReply={() => setReplyTarget(null)}
          onSend={(text, replyToMessageId, attachments) => {
            send.mutate({
              text,
              ...(replyToMessageId ? { replyToMessageId } : {}),
              ...(attachments?.length ? { attachments } : {}),
              ...(replyTarget
                ? {
                    reference: {
                      messageId: replyTarget.id,
                      senderName: replyTarget.sender.name,
                      senderAvatar: replyTarget.sender.avatar,
                      summary: summarizeMessage(replyTarget),
                      kind: "reply",
                      createdAt: replyTarget.createdAt
                    }
                  }
                : {})
            });
          }}
          disabled={send.isPending || accessDenied || !activeConversation}
        />
      </section>
    </div>
  );
}

function summarizeMessage(message: ChatMessage) {
  const text = message.blocks.map((block) => (block.type === "markdown" ? block.payload.text : `[${block.type}]`)).join(" ");
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > 100 ? `${clean.slice(0, 100)}...` : clean || "非文本消息";
}

function normalizeMessageSenderAgentId(agentId: string) {
  const aliases: Record<string, string> = {
    orchestrator: "agent-orchestrator",
    product: "agent-product",
    ui: "agent-ui",
    review: "agent-review",
    universal: "agent-universal",
    codex: "agent-codex",
    opencode: "agent-opencode"
  };
  return aliases[agentId] ?? agentId;
}

function createIdleOrchestratorRun(conversationId: string): OrchestratorRun {
  return {
    id: "orchestrator-idle",
    conversationId,
    status: "completed",
    currentNode: "wake",
    goal: "等待 @orchestrator 唤醒",
    startedAt: new Date().toISOString(),
    nodes: ORCHESTRATOR_NODES.map((node) => ({ ...node, status: "pending" })),
    edges: ORCHESTRATOR_EDGES.map(([source, target, label]) => ({
      id: `${source}-${target}`,
      source,
      target,
      label,
      status: "pending"
    })),
    runMeta: { kind: "idle", message: "当前会话还没有可展示的 Orchestrator Run；发送 @orchestrator 后才会创建真实运行记录。" }
  };
}

function PinnedMemoryList({ version, pins }: { version: number; pins: PinnedMessageMemory[] }) {
  return (
    <section className="pinned-memory-list" aria-label="长期记忆 Pin 列表">
      <header>
        <span><Pin size={15} /> 长期记忆 Pin</span>
        <small>v{version}</small>
      </header>
      {pins.map((pin) => (
        <article key={pin.actionId}>
          <strong>{pin.senderName}</strong>
          <p>{pin.summary}</p>
          <time>{new Date(pin.pinnedAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}</time>
        </article>
      ))}
    </section>
  );
}
