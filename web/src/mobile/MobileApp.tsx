import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bot,
  Box,
  ChevronLeft,
  ChevronRight,
  CopyPlus,
  Database,
  FileText,
  FolderOpen,
  GitFork,
  Heart,
  Home,
  LogOut,
  MessageCircle,
  PackagePlus,
  Plus,
  RefreshCw,
  Search,
  Send,
  Sparkles,
  UserRound,
  UsersRound,
  Wrench
} from "lucide-react";
import { FormEvent, MouseEvent, ReactNode, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { Navigate, NavLink, Route, Routes, useNavigate, useParams } from "react-router-dom";
import remarkGfm from "remark-gfm";
import {
  ORCHESTRATOR_EDGES,
  ORCHESTRATOR_NODES,
  type AgentDefinition,
  type ChatMessage,
  type MessageBlock,
  type OrchestratorRun,
  type WorkspaceAsset
} from "@agenthub/shared";
import { api, type AgentBuilderChatMessagePayload, type AgentBuilderChecklistItem, type AgentBuilderPayload, type AgentRuntimeStatus, type HubAssetScope, type HubKind, type ToolDefinition } from "../api/client";
import { queryKeys } from "../api/query-keys";
import { AssetRenderPreview, assetRenderEngineLabel } from "../components/AssetRenderEngine";
import { AvatarMark } from "../components/AvatarMark";
import { OrchestratorGraph } from "../components/OrchestratorGraph";
import { UiAgentGraph } from "../components/UiAgentGraph";
import { useRealtimeConversation } from "../features/messages/useRealtimeConversation";
import { useAuthStore } from "../store/auth-store";
import { useUiStore } from "../store/ui-store";

type MobileTab = "messages" | "workspaces" | "agents" | "hub" | "me";
type MobileHubKind = "agent" | "tool" | "skill" | "knowledge";
type MobileHubScope = "personal" | "public";
type MobileHubBucket = "personal" | "subscribed" | "fork" | "published";
type MobileReviewDecisionInput = {
  proposalId: string;
  decision: "approve" | "reject";
  reason?: string | undefined;
};

const tabs: Array<{ id: MobileTab; label: string; to: string; icon: typeof MessageCircle }> = [
  { id: "messages", label: "消息", to: "/mobile/messages", icon: MessageCircle },
  { id: "workspaces", label: "空间", to: "/mobile/workspaces", icon: FolderOpen },
  { id: "agents", label: "成员", to: "/mobile/agents", icon: UsersRound },
  { id: "hub", label: "Hub", to: "/mobile/hub", icon: Sparkles },
  { id: "me", label: "我的", to: "/mobile/me", icon: UserRound }
];

export function MobileApp() {
  return (
    <>
      <Routes>
        <Route path="/" element={<Navigate to="/mobile/messages" replace />} />
        <Route path="/messages" element={<MobileMessagesList />} />
        <Route path="/messages/:conversationId/orchestrator" element={<MobileOrchestratorStatus />} />
        <Route path="/messages/:conversationId/agents/:agentId" element={<MobileAgentRuntimeStatus />} />
        <Route path="/messages/:conversationId/assets/:assetId" element={<MobileMessageAssetPreview />} />
        <Route path="/messages/:conversationId/deployments/:deploymentId/preview" element={<MobileDeploymentPreview />} />
        <Route path="/messages/:conversationId" element={<MobileChatDetail />} />
        <Route path="/workspaces" element={<MobileWorkspaces />} />
        <Route path="/workspaces/:workspaceId/assets/:assetId" element={<MobileWorkspaceAssetPreview />} />
        <Route path="/workspaces/:workspaceId" element={<MobileWorkspaceDetail />} />
        <Route path="/agents" element={<MobileAgents />} />
        <Route path="/users/:userId" element={<MobileUserDetail />} />
        <Route path="/hub/agent/create" element={<MobileAgentBuilder />} />
        <Route path="/hub/:hubKind/:itemId" element={<MobileHubDetail />} />
        <Route path="/hub" element={<MobileHub />} />
        <Route path="/me" element={<MobileMe />} />
      </Routes>
      <MobileToast />
    </>
  );
}

function MobileToast() {
  const toast = useUiStore((state) => state.toast);
  const clearToast = useUiStore((state) => state.clearToast);
  useEffect(() => {
    if (!toast) return undefined;
    const timer = window.setTimeout(clearToast, 2_400);
    return () => window.clearTimeout(timer);
  }, [clearToast, toast]);
  if (!toast) return null;
  return (
    <button className={`mobile-toast ${toast.tone ?? "info"}`} type="button" onClick={clearToast}>
      {toast.message}
    </button>
  );
}

function MobileTabShell(props: { active: MobileTab; title: string; children: ReactNode; action?: ReactNode | undefined }) {
  return (
    <main className="mobile-app-shell">
      <section className="mobile-page-body">
        <header className="mobile-page-heading">
          <strong>{props.title}</strong>
          {props.action ? <div className="mobile-topbar-action">{props.action}</div> : null}
        </header>
        {props.children}
      </section>
      <nav className="mobile-bottom-tabs" aria-label="移动端导航">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          return (
            <NavLink key={tab.id} to={tab.to} className={({ isActive }) => (isActive || props.active === tab.id ? "active" : "")}>
              <Icon size={20} />
              <span>{tab.label}</span>
            </NavLink>
          );
        })}
      </nav>
    </main>
  );
}

function MobileDetailShell(props: {
  title: string;
  subtitle?: string | undefined;
  children: ReactNode;
  action?: ReactNode | undefined;
  mode?: "default" | "chat" | undefined;
}) {
  const navigate = useNavigate();
  return (
    <main className="mobile-app-shell mobile-detail-shell">
      <header className="mobile-detail-topbar">
        <button type="button" onClick={() => navigate(-1)} title="返回">
          <ChevronLeft size={22} />
        </button>
        <div>
          <strong>{props.title}</strong>
          {props.subtitle ? <small>{props.subtitle}</small> : null}
        </div>
        {props.action ? <div className="mobile-topbar-action">{props.action}</div> : <span />}
      </header>
      <section className={`mobile-detail-body ${props.mode === "chat" ? "mobile-detail-body-chat" : ""}`}>{props.children}</section>
    </main>
  );
}

function MobileMessagesList() {
  const user = useAuthStore((state) => state.user);
  const [search, setSearch] = useState("");
  const conversations = useQuery({
    queryKey: queryKeys.conversations(user!.id, search),
    queryFn: () => api.conversations({ search }),
    enabled: Boolean(user)
  });
  const visibleConversations = conversations.data?.conversations ?? [];

  return (
    <MobileTabShell active="messages" title="消息">
      <div className="mobile-search">
        <Search size={17} />
        <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索会话" />
      </div>
      <div className="mobile-list">
        {visibleConversations.map((conversation) => (
          <NavLink key={conversation.id} className="mobile-conversation-row" to={`/mobile/messages/${conversation.id}`}>
            <AvatarMark kind={conversation.type === "project" ? "conversation" : "agent"} value={conversation.avatar} label={conversation.title} variantKey={conversation.id} />
            <div>
              <strong>{conversation.title}</strong>
              <small>{conversation.lastMessage || "暂无消息"}</small>
            </div>
            <time>{formatShortTime(conversation.lastActiveAt)}</time>
            {conversation.unreadCount > 0 ? <em>{conversation.unreadCount}</em> : null}
          </NavLink>
        ))}
        {conversations.isLoading ? <MobileEmpty text="正在加载会话..." /> : null}
        {!conversations.isLoading && visibleConversations.length === 0 ? <MobileEmpty text="暂无会话" /> : null}
      </div>
    </MobileTabShell>
  );
}

function MobileChatDetail() {
  const user = useAuthStore((state) => state.user);
  const { conversationId = "" } = useParams();
  const [text, setText] = useState("");
  const queryClient = useQueryClient();
  const showToast = useUiStore((state) => state.showToast);
  const conversation = useQuery({
    queryKey: queryKeys.conversationDetail(user!.id, conversationId),
    queryFn: () => api.conversation(conversationId),
    enabled: Boolean(user && conversationId)
  });
  const messages = useQuery({
    queryKey: queryKeys.messages(user!.id, conversationId),
    queryFn: () => api.messages(conversationId, { limit: 80 }),
    enabled: Boolean(user && conversationId)
  });
  const send = useMutation({
    mutationFn: (content: string) => api.sendMessage(conversationId, content),
    onSuccess: async () => {
      setText("");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.messages(user!.id, conversationId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.conversations(user!.id) })
      ]);
    }
  });

  const title = conversation.data?.conversation.title ?? "会话";
  const workspaceId = conversation.data?.conversation.workspaceId;
  const reviewDecision = useMutation({
    mutationFn: async (input: MobileReviewDecisionInput) => {
      if (!workspaceId) throw new Error("当前会话没有工作空间，无法处理代码审阅");
      if (input.decision === "approve") return api.approveWorkspaceGitProposal(workspaceId, input.proposalId);
      return api.rejectWorkspaceGitProposal(workspaceId, input.proposalId, input.reason?.trim() || "需要继续修改");
    },
    onSuccess: async (_result, input) => {
      if (user && workspaceId) {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: queryKeys.workspaceGit(user.id, workspaceId) }),
          queryClient.invalidateQueries({ queryKey: queryKeys.workspaceTree(user.id, workspaceId) }),
          queryClient.invalidateQueries({ queryKey: queryKeys.assets(user.id, workspaceId) })
        ]);
      }
      if (user) {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: queryKeys.messages(user.id, conversationId) }),
          queryClient.invalidateQueries({ queryKey: queryKeys.conversationDetail(user.id, conversationId) }),
          queryClient.invalidateQueries({ queryKey: queryKeys.conversations(user.id) })
        ]);
      }
      showToast(input.decision === "approve" ? "代码审阅已通过" : "已打回修改意见", "success");
    },
    onError: (error) => {
      showToast(error instanceof Error ? error.message : "代码审阅操作失败", "warning");
    }
  });
  useRealtimeConversation(conversationId, conversation.data?.conversation.unreadCount ?? 0, conversation.data?.conversation.lastActiveAt ?? "");
  const sortedMessages = useMemo(
    () => [...(messages.data?.messages ?? [])].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()),
    [messages.data?.messages]
  );
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [conversationId, sortedMessages.length, sortedMessages.at(-1)?.id]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const content = text.trim();
    if (!content || send.isPending) return;
    send.mutate(content);
  };

  return (
    <MobileDetailShell title={title} mode="chat">
      <div className="mobile-chat-scroll">
        {sortedMessages.map((message) => (
          <MobileMessageBubble
            key={message.id}
            message={message}
            mine={message.sender.type === "user" && message.sender.id === user?.id}
            conversationId={conversationId}
            workspaceId={workspaceId}
            onReviewDecision={(input) => reviewDecision.mutate(input)}
            reviewBusyKey={reviewDecision.isPending ? reviewDecision.variables?.proposalId ?? null : null}
          />
        ))}
        {messages.isLoading ? <MobileEmpty text="正在加载消息..." /> : null}
        <div ref={bottomRef} aria-hidden="true" />
      </div>
      <form className="mobile-composer" onSubmit={submit}>
        <input value={text} onChange={(event) => setText(event.target.value)} placeholder={`发送给 ${title}`} />
        <button type="submit" disabled={!text.trim() || send.isPending} title="发送">
          <Send size={18} />
        </button>
      </form>
    </MobileDetailShell>
  );
}

function MobileMessageBubble({
  message,
  mine,
  conversationId,
  workspaceId,
  onReviewDecision,
  reviewBusyKey
}: {
  message: ChatMessage;
  mine: boolean;
  conversationId: string;
  workspaceId?: string | undefined;
  onReviewDecision?: ((input: MobileReviewDecisionInput) => void) | undefined;
  reviewBusyKey?: string | null | undefined;
}) {
  const navigate = useNavigate();
  const openSender = () => {
    if (message.sender.type === "agent") {
      const agentId = normalizeMessageSenderAgentId(message.sender.id);
      if (agentId === "agent-orchestrator") {
        navigate(`/mobile/messages/${conversationId}/orchestrator`);
        return;
      }
      if (agentId === "agent-ui") {
        navigate(`/mobile/messages/${conversationId}/agents/${agentId}`);
        return;
      }
      navigate(`/mobile/hub/agent/${agentId}`);
      return;
    }
    if (message.sender.type === "user") {
      navigate(`/mobile/users/${message.sender.id}`);
    }
  };
  return (
    <article className={`mobile-message ${mine ? "mine" : ""}`}>
      <AvatarMark
        kind={message.sender.type === "agent" ? "agent" : "user"}
        value={message.sender.avatar}
        label={message.sender.name}
        title={`查看 ${message.sender.name}`}
        {...(message.sender.type === "system" ? {} : { onClick: openSender })}
      />
      <div>
        <header>
          <strong>{message.sender.name}</strong>
          <time>{formatShortTime(message.createdAt)}</time>
        </header>
        <div className="mobile-message-card">
          {message.reference ? (
            <blockquote>
              {message.reference.senderName}: {message.reference.summary}
            </blockquote>
          ) : null}
          {message.blocks.map((block) => (
            <MobileMessageBlock
              key={block.blockId}
              block={block}
              conversationId={conversationId}
              workspaceId={workspaceId}
              siblingBlocks={message.blocks}
              onReviewDecision={onReviewDecision}
              reviewBusyKey={reviewBusyKey}
            />
          ))}
        </div>
      </div>
    </article>
  );
}

function MobileMessageBlock({
  block,
  conversationId,
  workspaceId,
  siblingBlocks,
  onReviewDecision,
  reviewBusyKey
}: {
  block: MessageBlock;
  conversationId: string;
  workspaceId?: string | undefined;
  siblingBlocks: MessageBlock[];
  onReviewDecision?: ((input: MobileReviewDecisionInput) => void) | undefined;
  reviewBusyKey?: string | null | undefined;
}) {
  if (block.type === "markdown") return <ReactMarkdown remarkPlugins={[remarkGfm]}>{block.payload.text}</ReactMarkdown>;
  if (block.type === "code") {
    return (
      <pre>
        {block.payload.filename ? <code className="mobile-code-file">{block.payload.filename}</code> : null}
        <code>{block.payload.code}</code>
      </pre>
    );
  }
  if (block.type === "file") {
    const engineLabel = assetRenderEngineLabel({
      name: block.payload.name,
      mimeType: block.payload.mimeType,
      size: block.payload.size
    });
    const content = (
      <>
        <FileText size={16} />
        <span>
          <strong>{block.payload.name}</strong>
          <small>{engineLabel} · 点击预览</small>
        </span>
        <ChevronRight size={15} />
      </>
    );
    return workspaceId ? (
      <NavLink className="mobile-artifact mobile-file-card" to={`/mobile/messages/${conversationId}/assets/${block.payload.assetId}`}>
        {content}
      </NavLink>
    ) : (
      <div className="mobile-artifact mobile-file-card">{content}</div>
    );
  }
  if (block.type === "image") {
    const imageSrc = block.payload.previewUrl ?? block.payload.thumbnailUrl;
    return imageSrc ? <img className="mobile-message-image" src={imageSrc} alt={block.payload.alt ?? "图片"} /> : <div className="mobile-artifact"><Box size={16} /> <span>图片</span></div>;
  }
  if (block.type === "web_preview") return <div className="mobile-artifact"><Home size={16} /> <span>{block.payload.title}</span></div>;
  if (block.type === "diff") {
    return (
      <MobileDiffBlock
        block={block}
        conversationId={conversationId}
        workspaceId={workspaceId}
        siblingBlocks={siblingBlocks}
        onReviewDecision={onReviewDecision}
        reviewBusyKey={reviewBusyKey}
      />
    );
  }
  if (block.type === "agent_status") {
    return (
      <div className="mobile-status-card">
        <Bot size={17} />
        <div>
          <strong>{block.payload.title}</strong>
          <small>{block.payload.summary || block.payload.status}</small>
        </div>
        <em>{statusLabel(block.payload.status)}</em>
      </div>
    );
  }
  if (block.type === "deploy_status") {
    const previewRoute = mobileDeploymentPreviewRoute(conversationId, block.payload);
    const content = (
      <>
        <Sparkles size={17} />
        <div>
          <strong>{block.payload.title}</strong>
          <small>{block.payload.detail || block.payload.previewUrl || block.payload.status}</small>
        </div>
        <em>{statusLabel(block.payload.status)}</em>
      </>
    );
    if (block.payload.status === "ready" && previewRoute) {
      return (
        <NavLink className="mobile-status-card deploy mobile-deploy-link" to={previewRoute}>
          {content}
        </NavLink>
      );
    }
    return (
      <div className="mobile-status-card deploy">
        {content}
      </div>
    );
  }
  return null;
}

function MobileDiffBlock({
  block,
  conversationId,
  workspaceId,
  siblingBlocks,
  onReviewDecision,
  reviewBusyKey
}: {
  block: Extract<MessageBlock, { type: "diff" }>;
  conversationId: string;
  workspaceId?: string | undefined;
  siblingBlocks: MessageBlock[];
  onReviewDecision?: ((input: MobileReviewDecisionInput) => void) | undefined;
  reviewBusyKey?: string | null | undefined;
}) {
  const additions = block.payload.files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = block.payload.files.reduce((sum, file) => sum + file.deletions, 0);
  const proposalId = block.payload.reviewProposalId ?? siblingBlocks.find(isMobileCodeTaskStatusBlock)?.payload.targetId;
  const canReview = Boolean(proposalId && onReviewDecision && block.payload.reviewState === "pending");
  const isBusy = Boolean(proposalId && reviewBusyKey === proposalId);
  const diffUrl = workspaceId ? `/mobile/messages/${conversationId}/assets/${block.payload.diffAssetId}` : undefined;
  const headerContent = (
    <>
      <div>
        <strong><GitFork size={15} /> {block.payload.title}</strong>
        <small>
          <span>+{additions}</span>
          <span>-{deletions}</span>
        </small>
      </div>
      <em className={`mobile-diff-state ${block.payload.reviewState}`}>{diffReviewStateLabel(block.payload.reviewState)}</em>
    </>
  );
  return (
    <section className="mobile-diff-card">
      {diffUrl ? (
        <NavLink className="mobile-diff-header mobile-diff-link" to={diffUrl}>
          {headerContent}
        </NavLink>
      ) : (
        <header className="mobile-diff-header">{headerContent}</header>
      )}
      {canReview && proposalId ? (
        <div className="mobile-diff-review-actions">
          <button type="button" className="approve" disabled={isBusy} onClick={() => onReviewDecision?.({ proposalId, decision: "approve" })}>
            通过
          </button>
          <button
            type="button"
            className="reject"
            disabled={isBusy}
            onClick={() => onReviewDecision?.({ proposalId, decision: "reject", reason: "需要继续修改" })}
          >
            不通过
          </button>
        </div>
      ) : null}
      <div className="mobile-diff-files">
        {block.payload.files.map((file) => (
          <NavLink key={file.path} className="mobile-diff-file-row" to={diffUrl ?? "#"} aria-disabled={!diffUrl}>
            <span>{file.path}</span>
            <b>
              +{file.additions} -{file.deletions}
            </b>
          </NavLink>
        ))}
      </div>
    </section>
  );
}

function isMobileCodeTaskStatusBlock(block: MessageBlock): block is Extract<MessageBlock, { type: "agent_status" }> {
  return block.type === "agent_status" && block.payload.subtype === "code_task";
}

function mobileDeploymentPreviewRoute(conversationId: string, payload: Extract<MessageBlock, { type: "deploy_status" }>["payload"]) {
  const deploymentId = payload.deploymentId ?? extractDeploymentIdFromPreviewUrl(payload.previewUrl);
  return deploymentId ? `/mobile/messages/${conversationId}/deployments/${encodeURIComponent(deploymentId)}/preview` : undefined;
}

function extractDeploymentIdFromPreviewUrl(previewUrl?: string | undefined) {
  if (!previewUrl) return undefined;
  const match = previewUrl.match(/\/api\/deployments\/([^/]+)\/preview\/?/);
  return match?.[1] ? decodeURIComponent(match[1]) : undefined;
}

function MobileDeploymentPreview() {
  const { deploymentId = "" } = useParams();
  const previewUrl = deploymentId ? `/api/deployments/${encodeURIComponent(deploymentId)}/preview/` : "";
  return (
    <MobileDetailShell title="静态预览" subtitle="AgentHub 网站">
      {previewUrl ? (
        <section className="mobile-deploy-preview">
          <iframe className="mobile-deploy-frame" title="AgentHub 网站静态预览" src={previewUrl} />
        </section>
      ) : (
        <MobileEmpty text="没有找到可打开的预览" />
      )}
    </MobileDetailShell>
  );
}

function MobileMessageAssetPreview() {
  const user = useAuthStore((state) => state.user);
  const { conversationId = "", assetId = "" } = useParams();
  const conversation = useQuery({
    queryKey: queryKeys.conversationDetail(user!.id, conversationId),
    queryFn: () => api.conversation(conversationId),
    enabled: Boolean(user && conversationId)
  });
  const workspaceId = conversation.data?.conversation.workspaceId;
  return (
    <MobileAssetPreviewPage
      workspaceId={workspaceId}
      assetId={assetId}
      title="文件预览"
      loading={conversation.isLoading}
    />
  );
}

function MobileOrchestratorStatus() {
  const user = useAuthStore((state) => state.user);
  const { conversationId = "" } = useParams();
  const conversation = useQuery({
    queryKey: queryKeys.conversationDetail(user!.id, conversationId),
    queryFn: () => api.conversation(conversationId),
    enabled: Boolean(user && conversationId)
  });
  const runs = useQuery({
    queryKey: queryKeys.runs(user!.id, conversationId),
    queryFn: () => api.runs(conversationId),
    enabled: Boolean(user && conversationId)
  });
  const run = latestOrchestratorRun(runs.data?.runs, conversationId);
  return (
    <MobileDetailShell title="Orchestrator" subtitle={conversation.data?.conversation.title ?? "主 Agent 状态机"}>
      {conversation.isLoading || runs.isLoading ? <MobileEmpty text="正在加载主 Agent 状态..." /> : null}
      <section className="mobile-runtime-panel">
        <OrchestratorGraph run={run} />
      </section>
    </MobileDetailShell>
  );
}

function MobileAgentRuntimeStatus() {
  const user = useAuthStore((state) => state.user);
  const { agentId = "" } = useParams();
  const normalizedAgentId = normalizeMessageSenderAgentId(agentId);
  const status = useQuery({
    queryKey: queryKeys.agentStatus(user!.id, normalizedAgentId),
    queryFn: () => api.agentStatus(normalizedAgentId),
    enabled: Boolean(user && normalizedAgentId)
  });
  const agent = status.data?.agent;
  return (
    <MobileDetailShell title={agent?.name ?? "Agent 状态"} subtitle={agent ? agentTypeLabel(agent.type) : "运行状态"}>
      {status.isLoading ? <MobileEmpty text="正在加载 Agent 状态..." /> : null}
      {!status.isLoading && !status.data ? <MobileEmpty text="Agent 状态加载失败" /> : null}
      {status.data ? (
        <section className="mobile-runtime-panel">
          <MobileAgentDetailCard agent={status.data.agent} />
          {isUiRuntimeAgent(status.data.agent) ? <UiAgentGraph status={status.data} /> : <MobileAgentRuntimeSummary status={status.data} />}
        </section>
      ) : null}
    </MobileDetailShell>
  );
}

function MobileWorkspaces() {
  const user = useAuthStore((state) => state.user);
  const userId = user?.id ?? "";
  const [scope, setScope] = useState<"all" | "personal" | "team">("all");
  const workspaces = useQuery({
    queryKey: queryKeys.workspaces(userId),
    queryFn: api.workspaces,
    enabled: Boolean(userId)
  });
  const workspaceList = workspaces.data?.workspaces ?? [];
  const filteredWorkspaces = workspaceList.filter((workspace) => scope === "all" || workspace.scope === scope);
  const personalCount = workspaceList.filter((workspace) => workspace.scope === "personal").length;
  const teamCount = workspaceList.filter((workspace) => workspace.scope === "team").length;
  const assetTotal = workspaceList.reduce((sum, workspace) => sum + workspace.assetCount, 0);

  return (
    <MobileTabShell active="workspaces" title="工作空间">
      <section className="mobile-workspace-summary">
        <WorkspaceLogo workspaceId="summary" scope="team" />
        <div>
          <strong>{workspaceList.length} 个项目空间</strong>
          <small>{teamCount} 个团队空间 · {personalCount} 个个人空间 · {assetTotal} 个产物</small>
        </div>
      </section>
      <div className="mobile-scope-switch compact" aria-label="工作空间范围">
        {[
          { id: "all", label: "全部" },
          { id: "team", label: "团队" },
          { id: "personal", label: "个人" }
        ].map((item) => (
          <button key={item.id} className={scope === item.id ? "active" : ""} type="button" onClick={() => setScope(item.id as "all" | "personal" | "team")}>
            {item.label}
          </button>
        ))}
      </div>
      <div className="mobile-card-list">
        {filteredWorkspaces.map((workspace) => (
          <NavLink className="mobile-workspace-card" key={workspace.id} to={`/mobile/workspaces/${workspace.id}`}>
            <WorkspaceLogo workspaceId={workspace.id} scope={workspace.scope} />
            <div>
              <strong>{workspace.name}</strong>
              <small>{workspace.scope === "team" ? `${workspace.memberCount} 人协作` : "个人项目"} · {workspace.assetCount} 个产物 · {formatDateLabel(workspace.updatedAt)}</small>
            </div>
            <ChevronRight className="mobile-row-arrow" size={15} />
          </NavLink>
        ))}
        {workspaces.isLoading ? <MobileEmpty text="正在加载工作空间..." /> : null}
        {!workspaces.isLoading && filteredWorkspaces.length === 0 ? <MobileEmpty text="当前分类下暂无工作空间" /> : null}
      </div>
    </MobileTabShell>
  );
}

function MobileWorkspaceDetail() {
  const user = useAuthStore((state) => state.user);
  const userId = user?.id ?? "";
  const { workspaceId = "" } = useParams();
  const workspaces = useQuery({
    queryKey: queryKeys.workspaces(userId),
    queryFn: api.workspaces,
    enabled: Boolean(userId)
  });
  const assets = useQuery({
    queryKey: queryKeys.assets(userId, workspaceId),
    queryFn: () => api.assets(workspaceId),
    enabled: Boolean(userId && workspaceId)
  });
  const workspace = (workspaces.data?.workspaces ?? []).find((item) => item.id === workspaceId);
  const assetList = assets.data?.assets ?? [];
  const assetGroups = groupBy(assetList, assetKindLabel);

  return (
    <MobileDetailShell title={workspace?.name ?? "工作空间"} subtitle={workspace ? (workspace.scope === "team" ? "团队项目空间" : "个人项目空间") : "项目空间"}>
      {workspace ? (
        <section className="mobile-workspace-hero">
          <WorkspaceLogo workspaceId={workspace.id} scope={workspace.scope} large />
          <div>
            <strong>{workspace.name}</strong>
            <small>{workspace.scope === "team" ? `${workspace.memberCount} 位成员` : "个人空间"} · {workspace.assetCount} 个产物</small>
          </div>
          <div className="mobile-workspace-stats">
            <span>{assetList.length}<small>文件</small></span>
            <span>{formatDateLabel(workspace.updatedAt)}<small>更新</small></span>
            <span>{workspace.codeAgentId ? "已绑定" : "未绑定"}<small>Code Agent</small></span>
          </div>
        </section>
      ) : null}
      {assetGroups.length ? (
        <div className="mobile-workspace-kind-grid">
          {assetGroups.map((group) => (
            <section key={group.name}>
              <strong>{group.items.length}</strong>
              <small>{group.name}</small>
            </section>
          ))}
        </div>
      ) : null}
      <div className="mobile-section-title">空间产物</div>
      <div className="mobile-hub-group-list">
        {assetGroups.map((group) => (
          <MobileHubGroup key={group.name} name={group.name} count={group.items.length}>
            {group.items.map((asset) => (
              <NavLink className="mobile-workspace-card" key={asset.id} to={`/mobile/workspaces/${workspaceId}/assets/${asset.id}`}>
                <AssetKindIcon kind={asset.kind} />
                <div>
                  <strong>{asset.name}</strong>
                  <small>{asset.summary || asset.path}</small>
                </div>
                <ChevronRight className="mobile-row-arrow" size={15} />
              </NavLink>
            ))}
          </MobileHubGroup>
        ))}
        {assets.isLoading ? <MobileEmpty text="正在加载产物..." /> : null}
        {!assets.isLoading && assetList.length === 0 ? <MobileEmpty text="暂无产物" /> : null}
      </div>
    </MobileDetailShell>
  );
}

function MobileWorkspaceAssetPreview() {
  const { workspaceId = "", assetId = "" } = useParams();
  return <MobileAssetPreviewPage workspaceId={workspaceId} assetId={assetId} title="产物预览" />;
}

function MobileAssetPreviewPage({
  workspaceId,
  assetId,
  title,
  loading
}: {
  workspaceId?: string | undefined;
  assetId: string;
  title: string;
  loading?: boolean | undefined;
}) {
  const user = useAuthStore((state) => state.user);
  const asset = useQuery({
    queryKey: queryKeys.asset(user!.id, workspaceId ?? "", assetId),
    queryFn: () => api.asset(workspaceId!, assetId),
    enabled: Boolean(user && workspaceId && assetId)
  });
  const file = asset.data?.asset;
  const assetUrl = file ? api.assetContentUrl(file.workspaceId, file.id) : undefined;
  return (
    <MobileDetailShell title={file?.name ?? title} subtitle={file ? assetPreviewMeta(file) : undefined}>
      {loading || asset.isLoading ? <MobileEmpty text="正在加载文件..." /> : null}
      {!loading && !asset.isLoading && !file ? <MobileEmpty text="没有找到可预览的文件" /> : null}
      {file ? (
        <section className="mobile-asset-preview">
          <header>
            <FileText size={18} />
            <div>
              <strong>{file.name}</strong>
              <small>{file.summary || file.path}</small>
            </div>
          </header>
          <AssetRenderPreview file={file} assetUrl={assetUrl} className="mobile-asset-render" />
        </section>
      ) : null}
    </MobileDetailShell>
  );
}

function MobileAgents() {
  const user = useAuthStore((state) => state.user);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const agents = useQuery({
    queryKey: queryKeys.agents(user!.id, "all", true),
    queryFn: () => api.agents(undefined, { includeSystem: true }),
    enabled: Boolean(user)
  });
  const friends = useQuery({
    queryKey: queryKeys.friends(user!.id),
    queryFn: api.friends,
    enabled: Boolean(user)
  });
  const openAgent = useMutation({
    mutationFn: api.openAgentConversation,
    onSuccess: async ({ conversation }) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.conversations(user!.id) });
      navigate(`/mobile/messages/${conversation.id}`);
    }
  });
  const openFriend = useMutation({
    mutationFn: api.openDirectConversation,
    onSuccess: async ({ conversation }) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.conversations(user!.id) });
      navigate(`/mobile/messages/${conversation.id}`);
    }
  });

  return (
    <MobileTabShell active="agents" title="成员">
      <div className="mobile-section-title">Agent</div>
      <div className="mobile-list">
        {(agents.data?.agents ?? []).map((agent) => (
          <button className="mobile-contact-row" key={agent.id} type="button" onClick={() => openAgent.mutate(agent.id)}>
            <AvatarMark kind="agent" value={agent.avatar} label={agent.name} />
            <div>
              <strong>{agent.name}</strong>
              <small>{agent.description}</small>
            </div>
          </button>
        ))}
      </div>
      <div className="mobile-section-title">好友</div>
      <div className="mobile-list">
        {(friends.data?.friends ?? []).map(({ user: friend }) => (
          <button className="mobile-contact-row" key={friend.id} type="button" onClick={() => openFriend.mutate(friend.id)}>
            <AvatarMark kind="user" value={friend.avatar} label={friend.name} />
            <div>
              <strong>{friend.name}</strong>
              <small>{friend.publicId}</small>
            </div>
          </button>
        ))}
      </div>
    </MobileTabShell>
  );
}

function MobileUserDetail() {
  const currentUser = useAuthStore((state) => state.user);
  const { userId = "" } = useParams();
  const user = useQuery({
    queryKey: currentUser ? ["user", currentUser.id, "mobile-user-detail", userId] as const : ["mobile-user-detail", userId] as const,
    queryFn: () => api.user(userId),
    enabled: Boolean(currentUser && userId)
  });
  const profile = user.data?.user;
  return (
    <MobileDetailShell title={profile?.name ?? "用户资料"} subtitle={profile?.publicId}>
      {user.isLoading ? <MobileEmpty text="正在加载用户资料..." /> : null}
      {!user.isLoading && !profile ? <MobileEmpty text="没有找到这个用户" /> : null}
      {profile ? (
        <section className="mobile-detail-card">
          <div className="mobile-detail-title">
            <AvatarMark kind="user" size="lg" value={profile.avatar} label={profile.name} />
            <div>
              <strong>{profile.name}</strong>
              <small>{profile.publicId}</small>
            </div>
          </div>
          <div className="mobile-chip-row">
            <span>{profile.role === "admin" ? "管理员" : profile.role === "owner" ? "所有者" : "成员"}</span>
            {profile.id === currentUser?.id ? <span>当前账号</span> : null}
          </div>
        </section>
      ) : null}
    </MobileDetailShell>
  );
}

function MobileHub() {
  const user = useAuthStore((state) => state.user);
  const userId = user?.id ?? "";
  const queryClient = useQueryClient();
  const [kind, setKind] = useState<MobileHubKind>("agent");
  const [scope, setScope] = useState<MobileHubScope>("personal");
  const [bucket, setBucket] = useState<MobileHubBucket>("personal");
  const effectiveAssetScope: HubAssetScope = kind === "skill" || kind === "knowledge"
    ? scope === "public" ? "public" : bucket
    : scope;
  const agents = useQuery({
    queryKey: queryKeys.agents(userId, scope, false),
    queryFn: () => api.agents(scope),
    enabled: Boolean(userId && kind === "agent")
  });
  const skills = useQuery({
    queryKey: queryKeys.hubAssets(userId, "skill", effectiveAssetScope),
    queryFn: () => api.hubAssets("skill", effectiveAssetScope),
    enabled: Boolean(userId && kind === "skill")
  });
  const knowledge = useQuery({
    queryKey: queryKeys.hubAssets(userId, "knowledge", effectiveAssetScope),
    queryFn: () => api.hubAssets("knowledge", effectiveAssetScope),
    enabled: Boolean(userId && kind === "knowledge")
  });
  const tools = useQuery({
    queryKey: queryKeys.tools(userId, scope),
    queryFn: () => api.tools(scope),
    enabled: Boolean(userId && kind === "tool")
  });
  const invalidateHub = async () => {
    if (!user) return;
    await queryClient.invalidateQueries({ queryKey: queryKeys.userRoot(user.id) });
  };
  const installAgent = useMutation({
    mutationFn: (agentId: string) => api.installAgent(agentId),
    onSuccess: invalidateHub
  });
  const syncAgentInstall = useMutation({
    mutationFn: (agentId: string) => api.syncAgentInstall(agentId, { confirmRiskChanges: true }),
    onSuccess: invalidateHub
  });
  const forkAgent = useMutation({
    mutationFn: (agentId: string) => api.forkAgent(agentId),
    onSuccess: async () => {
      setScope("personal");
      setBucket("fork");
      await invalidateHub();
    }
  });
  const publishAgent = useMutation({
    mutationFn: (agentId: string) => api.publishAgent(agentId),
    onSuccess: async () => {
      setBucket("published");
      await invalidateHub();
    }
  });
  const subscribeHubAsset = useMutation({
    mutationFn: ({ hubKind, assetId }: { hubKind: HubKind; assetId: string }) => api.subscribeHubAsset(hubKind, assetId),
    onSuccess: invalidateHub
  });
  const unsubscribeHubAsset = useMutation({
    mutationFn: ({ hubKind, assetId }: { hubKind: HubKind; assetId: string }) => api.unsubscribeHubAsset(hubKind, assetId),
    onSuccess: invalidateHub
  });
  const syncHubAsset = useMutation({
    mutationFn: ({ hubKind, assetId }: { hubKind: HubKind; assetId: string }) => api.syncHubAsset(hubKind, assetId, { confirmRiskChanges: true }),
    onSuccess: invalidateHub
  });
  const forkHubAsset = useMutation({
    mutationFn: ({ hubKind, assetId }: { hubKind: "skill" | "knowledge"; assetId: string }) => api.forkHubAsset(hubKind, assetId),
    onSuccess: async () => {
      setScope("personal");
      setBucket("fork");
      await invalidateHub();
    }
  });
  const toggleLike = useMutation({
    mutationFn: ({ hubKind, assetId, liked }: { hubKind: HubKind; assetId: string; liked: boolean }) =>
      liked ? api.unlikeHubAsset(hubKind, assetId) : api.likeHubAsset(hubKind, assetId),
    onSuccess: invalidateHub
  });
  const agentList = ((agents.data?.agents ?? []).filter((agent) => scope === "public" ? agent.custom || agent.installed : true));
  const displayedAgents = scope === "personal" ? agentList.filter((agent) => agentMatchesBucket(agent, bucket)) : agentList;
  const displayedTools = scope === "personal" ? (tools.data?.tools ?? []).filter((tool) => toolMatchesBucket(tool, bucket, userId)) : (tools.data?.tools ?? []);
  const displayedAssets = kind === "skill" ? (skills.data?.assets ?? []) : kind === "knowledge" ? (knowledge.data?.assets ?? []) : [];

  return (
    <MobileTabShell
      active="hub"
      title="Hub"
      action={kind === "agent" ? (
        <NavLink className="mobile-icon-action" to="/mobile/hub/agent/create" title="对话创建 Agent">
          <Plus size={18} />
        </NavLink>
      ) : null}
    >
      <div className="mobile-segment">
        {(["agent", "tool", "skill", "knowledge"] as const).map((item) => (
          <button
            key={item}
            className={kind === item ? "active" : ""}
            type="button"
            onClick={() => {
              setKind(item);
              if (item === "tool" && bucket === "fork") setBucket("personal");
            }}
          >
            {item === "agent" ? "Agent" : item === "tool" ? "Tool" : item === "skill" ? "Skill" : "Knowledge"}
          </button>
        ))}
      </div>
      <div className="mobile-scope-switch" aria-label="Hub 范围">
        <button className={scope === "personal" ? "active" : ""} type="button" onClick={() => setScope("personal")}>个人</button>
        <button className={scope === "public" ? "active" : ""} type="button" onClick={() => setScope("public")}>公共</button>
      </div>
      {scope === "personal" ? (
        <div className="mobile-filter-chips" aria-label="个人 Hub 分类">
          {mobileHubBucketOptions(kind).map((item) => (
            <button key={item.id} className={bucket === item.id ? "active" : ""} type="button" onClick={() => setBucket(item.id)}>
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
      {kind === "tool" ? (
        <div className="mobile-hub-group-list">
          {groupBy(displayedTools, (tool) => toolCategoryLabel(tool.category)).map((group) => (
            <MobileHubGroup key={group.name} name={group.name} count={group.items.length}>
              {group.items.map((tool) => (
                <NavLink className="mobile-workspace-card" key={tool.id} to={`/mobile/hub/tool/${tool.id}`}>
                  <span><Wrench size={18} /></span>
                  <div><strong>{tool.name}</strong><small>{toolLifecycleLabel(tool)} · {tool.description}</small></div>
                  <MobileHubToolActions
                    tool={tool}
                    scope={scope}
                    onSubscribe={() => subscribeHubAsset.mutate({ hubKind: "tool", assetId: tool.id })}
                    onUnsubscribe={() => unsubscribeHubAsset.mutate({ hubKind: "tool", assetId: tool.id })}
                    onSync={() => syncHubAsset.mutate({ hubKind: "tool", assetId: tool.id })}
                    onLike={() => toggleLike.mutate({ hubKind: "tool", assetId: tool.id, liked: isLiked(tool) })}
                  />
                  <ChevronRight className="mobile-row-arrow" size={15} />
                </NavLink>
              ))}
            </MobileHubGroup>
          ))}
          {tools.isLoading ? <MobileEmpty text="正在加载 ToolHub..." /> : null}
          {!tools.isLoading && displayedTools.length === 0 ? <MobileEmpty text={scope === "public" ? "暂无公共 Tool" : "当前分类下暂无 Tool"} /> : null}
        </div>
      ) : null}
      {kind === "agent" ? (
        <div className="mobile-hub-group-list">
          {scope === "personal" && bucket === "personal" ? (
            <NavLink className="mobile-create-agent-card" to="/mobile/hub/agent/create">
              <span><Bot size={20} /></span>
              <div>
                <strong>对话创建 Agent</strong>
                <small>通过聊天描述角色、工具、Skill、Knowledge 和权限。</small>
              </div>
              <ChevronRight size={15} />
            </NavLink>
          ) : null}
          {groupBy(displayedAgents, (agent) => agentTypeLabel(agent.type)).map((group) => (
            <MobileHubGroup key={group.name} name={group.name} count={group.items.length}>
              {group.items.map((agent) => (
                <NavLink className="mobile-workspace-card" key={agent.id} to={`/mobile/hub/agent/${agent.id}`}>
                  <AvatarMark kind="agent" value={agent.avatar} label={agent.name} />
                  <div><strong>{agent.name}</strong><small>{agentLifecycleLabel(agent)} · {agent.description}</small></div>
                  <MobileHubAgentActions
                    agent={agent}
                    scope={scope}
                    onInstall={() => installAgent.mutate(agent.id)}
                    onSync={() => syncAgentInstall.mutate(agent.id)}
                    onFork={() => forkAgent.mutate(agent.id)}
                    onPublish={() => publishAgent.mutate(agent.id)}
                  />
                  <ChevronRight className="mobile-row-arrow" size={15} />
                </NavLink>
              ))}
            </MobileHubGroup>
          ))}
          {agents.isLoading ? <MobileEmpty text="正在加载 AgentHub..." /> : null}
          {!agents.isLoading && displayedAgents.length === 0 ? <MobileEmpty text={scope === "public" ? "暂无公共 Agent" : "当前分类下暂无 Agent"} /> : null}
        </div>
      ) : null}
      {kind === "skill" || kind === "knowledge" ? (
        <div className="mobile-hub-group-list">
          {groupBy(displayedAssets, assetScopeLabel).map((group) => (
            <MobileHubGroup key={group.name} name={group.name} count={group.items.length}>
              {group.items.map((asset) => (
                <NavLink className="mobile-workspace-card" key={asset.id} to={`/mobile/hub/${kind}/${asset.id}`}>
                  <span>{kind === "skill" ? <Wrench size={18} /> : <Database size={18} />}</span>
                  <div><strong>{asset.name}</strong><small>{assetScopeLabel(asset)} · {asset.summary || asset.path}</small></div>
                  <MobileHubAssetActions
                    kind={kind}
                    asset={asset}
                    scope={scope}
                    onSubscribe={() => subscribeHubAsset.mutate({ hubKind: kind, assetId: asset.id })}
                    onUnsubscribe={() => unsubscribeHubAsset.mutate({ hubKind: kind, assetId: asset.id })}
                    onSync={() => syncHubAsset.mutate({ hubKind: kind, assetId: asset.id })}
                    onFork={() => forkHubAsset.mutate({ hubKind: kind, assetId: asset.id })}
                    onLike={() => toggleLike.mutate({ hubKind: kind, assetId: asset.id, liked: Boolean(asset.likedByMe) })}
                  />
                  <ChevronRight className="mobile-row-arrow" size={15} />
                </NavLink>
              ))}
            </MobileHubGroup>
          ))}
          {(kind === "skill" ? skills.isLoading : knowledge.isLoading) ? <MobileEmpty text={`正在加载 ${hubKindLabel(kind)}...`} /> : null}
          {!(kind === "skill" ? skills.isLoading : knowledge.isLoading) && displayedAssets.length === 0 ? <MobileEmpty text={scope === "public" ? `暂无公共 ${hubKindLabel(kind)}` : `当前分类下暂无 ${hubKindLabel(kind)}`} /> : null}
        </div>
      ) : null}
    </MobileTabShell>
  );
}

function MobileHubAgentActions({
  agent,
  scope,
  onInstall,
  onSync,
  onFork,
  onPublish
}: {
  agent: AgentDefinition;
  scope: MobileHubScope;
  onInstall: () => void;
  onSync: () => void;
  onFork: () => void;
  onPublish: () => void;
}) {
  return (
    <div className="mobile-hub-card-actions">
      {scope === "public" && !agent.installed ? <MobileCardAction icon={<PackagePlus size={13} />} label="订阅" onClick={onInstall} /> : null}
      {scope === "public" && agent.updateAvailable ? <MobileCardAction icon={<RefreshCw size={13} />} label="同步" onClick={onSync} /> : null}
      {agent.forkable ? <MobileCardAction icon={<GitFork size={13} />} label="Fork" onClick={onFork} /> : null}
      {scope === "personal" && agent.custom && agent.visibility !== "public" ? <MobileCardAction icon={<Sparkles size={13} />} label="公开" onClick={onPublish} /> : null}
    </div>
  );
}

function MobileHubToolActions({
  tool,
  scope,
  onSubscribe,
  onUnsubscribe,
  onSync,
  onLike
}: {
  tool: ToolDefinition;
  scope: MobileHubScope;
  onSubscribe: () => void;
  onUnsubscribe: () => void;
  onSync: () => void;
  onLike: () => void;
}) {
  return (
    <div className="mobile-hub-card-actions">
      {scope === "public" && !tool.subscribed ? <MobileCardAction icon={<PackagePlus size={13} />} label="订阅" onClick={onSubscribe} /> : null}
      {tool.subscribed ? <MobileCardAction icon={<RefreshCw size={13} />} label={tool.updateAvailable ? "同步" : "退订"} onClick={tool.updateAvailable ? onSync : onUnsubscribe} /> : null}
      {scope === "public" ? <MobileCardAction icon={<Heart size={13} />} label={`${likeCount(tool)}`} active={isLiked(tool)} onClick={onLike} /> : null}
    </div>
  );
}

function MobileHubAssetActions({
  kind,
  asset,
  scope,
  onSubscribe,
  onUnsubscribe,
  onSync,
  onFork,
  onLike
}: {
  kind: "skill" | "knowledge";
  asset: WorkspaceAsset;
  scope: MobileHubScope;
  onSubscribe: () => void;
  onUnsubscribe: () => void;
  onSync: () => void;
  onFork: () => void;
  onLike: () => void;
}) {
  return (
    <div className="mobile-hub-card-actions">
      {scope === "public" && !asset.subscribed ? <MobileCardAction icon={<PackagePlus size={13} />} label="订阅" onClick={onSubscribe} /> : null}
      {asset.subscribed ? <MobileCardAction icon={<RefreshCw size={13} />} label={asset.updateAvailable ? "同步" : "退订"} onClick={asset.updateAvailable ? onSync : onUnsubscribe} /> : null}
      {scope === "public" ? <MobileCardAction icon={<GitFork size={13} />} label="Fork" onClick={onFork} /> : null}
      {scope === "public" ? <MobileCardAction icon={<Heart size={13} />} label={`${asset.likeCount ?? 0}`} active={Boolean(asset.likedByMe)} onClick={onLike} /> : null}
      {scope === "personal" && kind === "skill" && asset.visibility === "public" ? <MobileCardAction icon={<CopyPlus size={13} />} label="已公开" disabled /> : null}
    </div>
  );
}

function MobileCardAction({
  icon,
  label,
  active,
  disabled,
  onClick
}: {
  icon: ReactNode;
  label: string;
  active?: boolean | undefined;
  disabled?: boolean | undefined;
  onClick?: (() => void) | undefined;
}) {
  return (
    <button
      className={active ? "mobile-card-action active" : "mobile-card-action"}
      type="button"
      disabled={disabled}
      onClick={(event) => {
        stopCardNavigation(event);
        if (!disabled) onClick?.();
      }}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

function stopCardNavigation(event: MouseEvent<HTMLButtonElement>) {
  event.preventDefault();
  event.stopPropagation();
}

function MobileAgentBuilder() {
  const user = useAuthStore((state) => state.user);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [input, setInput] = useState("");
  const [draft, setDraft] = useState<AgentBuilderPayload | null>(null);
  const [checklist, setChecklist] = useState<AgentBuilderChecklistItem[]>(createMobileAgentBuilderChecklist());
  const [messages, setMessages] = useState<AgentBuilderChatMessagePayload[]>([
    {
      role: "assistant",
      content: "告诉我你想创建什么 Agent。可以直接说明它负责什么任务、需要哪些 Tool/Skill/Knowledge、是否允许 Orchestrator 调用、输出格式和权限边界。"
    }
  ]);
  const builderChat = useMutation({
    mutationFn: (nextMessages: AgentBuilderChatMessagePayload[]) => api.agentBuilderChat({
      messages: nextMessages,
      currentDraft: draft ? { ...draft } : {},
      includePublicAssets: true
    }),
    onSuccess: (result) => {
      setDraft(result.draft);
      setChecklist(result.checklist);
      setMessages((current) => [...current, { role: "assistant", content: result.assistantMessage }]);
    },
    onError: (error) => {
      setMessages((current) => [
        ...current,
        { role: "assistant", content: `Agent Builder 调用失败：${error instanceof Error ? error.message : String(error)}` }
      ]);
    }
  });
  const createAgent = useMutation({
    mutationFn: (payload: AgentBuilderPayload) => api.createAgent(payload),
    onSuccess: async ({ agent }) => {
      if (user) await queryClient.invalidateQueries({ queryKey: queryKeys.userRoot(user.id) });
      navigate(`/mobile/hub/agent/${agent.id}`);
    }
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const text = input.trim();
    if (!text || builderChat.isPending) return;
    const nextMessages = [...messages, { role: "user" as const, content: text }];
    setMessages(nextMessages);
    setInput("");
    builderChat.mutate(nextMessages);
  };
  const readyToSave = Boolean(draft?.name?.trim() && draft.description?.trim());

  return (
    <MobileDetailShell title="对话创建 Agent" subtitle="Agent Builder">
      <section className="mobile-agent-builder">
        <div className="mobile-agent-builder-chat">
          {messages.map((message, index) => (
            <article key={`${message.role}-${index}`} className={message.role === "user" ? "mine" : ""}>
              <strong>{message.role === "user" ? "你" : "Agent Builder"}</strong>
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
            </article>
          ))}
          {builderChat.isPending ? <MobileEmpty text="正在生成 Agent 草案..." /> : null}
        </div>
        <form className="mobile-agent-builder-form" onSubmit={submit}>
          <input value={input} onChange={(event) => setInput(event.target.value)} placeholder="描述你要创建的 Agent..." />
          <button type="submit" disabled={!input.trim() || builderChat.isPending}><Send size={17} /></button>
        </form>
        <section className="mobile-agent-draft-card">
          <div className="mobile-detail-title">
            <AvatarMark kind="agent" value={draft?.avatar ?? "/avatars/agents/agent-v2-01.png"} label={draft?.name ?? "New Agent"} />
            <div>
              <strong>{draft?.name || "等待生成草案"}</strong>
              <small>{draft?.description || "草案生成后可以保存为真实 Agent"}</small>
            </div>
          </div>
          <div className="mobile-checklist">
            {checklist.map((item) => (
              <span key={item.id} className={item.status}>{item.label}</span>
            ))}
          </div>
          {draft ? (
            <div className="mobile-chip-row">
              <span>{draft.type ?? "universal"}</span>
              <span>{draft.visibility ?? "private"}</span>
              <span>{draft.runtime?.workflowTemplate ?? "tool_loop"}</span>
              {(draft.toolIds ?? []).length ? <span>{draft.toolIds?.length} Tools</span> : null}
              {(draft.skillAssetIds ?? []).length ? <span>{draft.skillAssetIds?.length} Skills</span> : null}
            </div>
          ) : null}
          <button
            className="mobile-primary-button"
            type="button"
            disabled={!readyToSave || !draft || createAgent.isPending}
            onClick={() => draft ? createAgent.mutate(draft) : undefined}
          >
            {createAgent.isPending ? "保存中..." : "保存 Agent"}
          </button>
          {createAgent.error ? <p className="mobile-form-error">{createAgent.error instanceof Error ? createAgent.error.message : String(createAgent.error)}</p> : null}
        </section>
      </section>
    </MobileDetailShell>
  );
}

function MobileHubGroup({ name, count, children }: { name: string; count: number; children: ReactNode }) {
  return (
    <section className="mobile-hub-group">
      <div className="mobile-section-title">
        <span>{name}</span>
        <em>{count}</em>
      </div>
      <div className="mobile-card-list">{children}</div>
    </section>
  );
}

function MobileHubDetail() {
  const user = useAuthStore((state) => state.user);
  const { hubKind = "agent", itemId = "" } = useParams();
  const kind = parseHubKind(hubKind);
  const normalizedAgentId = kind === "agent" ? normalizeMessageSenderAgentId(itemId) : itemId;
  const isOrchestratorHubAgent = kind === "agent" && normalizedAgentId === "agent-orchestrator";
  const agent = useQuery({
    queryKey: queryKeys.agent(user!.id, normalizedAgentId),
    queryFn: () => api.agent(normalizedAgentId),
    enabled: Boolean(user && itemId && kind === "agent" && !isOrchestratorHubAgent)
  });
  const agentStatus = useQuery({
    queryKey: queryKeys.agentStatus(user!.id, normalizedAgentId),
    queryFn: () => api.agentStatus(normalizedAgentId),
    enabled: Boolean(user && kind === "agent" && normalizedAgentId === "agent-ui")
  });
  const tools = useQuery({
    queryKey: queryKeys.tools(user!.id),
    queryFn: () => api.tools(),
    enabled: Boolean(user && itemId && kind === "tool")
  });
  const hubAsset = useQuery({
    queryKey: ["user", user!.id, "mobile-hub-asset", kind, itemId] as const,
    queryFn: () => api.editableHubAsset(kind === "knowledge" ? "knowledge" : "skill", itemId),
    enabled: Boolean(user && itemId && (kind === "skill" || kind === "knowledge"))
  });
  const selectedTool = tools.data?.tools.find((tool) => tool.id === itemId);
  const selectedAsset = hubAsset.data?.asset;
  const title = isOrchestratorHubAgent ? "Orchestrator" : kind === "agent"
    ? agent.data?.agent.name ?? "Agent"
    : kind === "tool"
      ? selectedTool?.name ?? "Tool"
      : selectedAsset?.name ?? (kind === "skill" ? "Skill" : "Knowledge");

  return (
    <MobileDetailShell title={title} subtitle={hubKindLabel(kind)}>
      {agent.isLoading || agentStatus.isLoading || tools.isLoading || hubAsset.isLoading ? <MobileEmpty text="正在加载详情..." /> : null}
      {isOrchestratorHubAgent ? <MobileAgentDetailCard agent={orchestratorAgentDefinition} /> : null}
      {kind === "agent" && agent.data?.agent ? <MobileAgentDetailCard agent={agent.data.agent} /> : null}
      {isOrchestratorHubAgent ? (
        <section className="mobile-runtime-panel">
          <OrchestratorGraph run={createIdleOrchestratorRun("hub-agent-orchestrator")} />
        </section>
      ) : null}
      {kind === "agent" && normalizedAgentId === "agent-ui" && agentStatus.data ? (
        <section className="mobile-runtime-panel">
          <UiAgentGraph status={agentStatus.data} />
        </section>
      ) : null}
      {kind === "tool" && selectedTool ? <MobileToolDetailCard tool={selectedTool} /> : null}
      {(kind === "skill" || kind === "knowledge") && selectedAsset ? <MobileHubAssetDetailCard asset={selectedAsset} /> : null}
      {!isOrchestratorHubAgent && !agent.isLoading && !agentStatus.isLoading && !tools.isLoading && !hubAsset.isLoading && !agent.data?.agent && !selectedTool && !selectedAsset ? (
        <MobileEmpty text="没有找到这个 Hub 对象" />
      ) : null}
    </MobileDetailShell>
  );
}

function MobileAgentDetailCard({ agent }: { agent: AgentDefinition }) {
  return (
    <section className="mobile-detail-card">
      <div className="mobile-detail-title">
        <AvatarMark kind="agent" value={agent.avatar} label={agent.name} />
        <div>
          <strong>{agent.name}</strong>
          <small>{agentTypeLabel(agent.type)} · {agent.status === "available" ? "可用" : statusLabel(agent.status)}</small>
        </div>
      </div>
      <p>{agent.description}</p>
      <div className="mobile-chip-row">
        {agent.provider ? <span>{agent.provider}</span> : null}
        {agent.visibility ? <span>{agent.visibility}</span> : null}
        {agent.custom ? <span>自建</span> : <span>内置</span>}
      </div>
      {agent.capabilities.length ? (
        <>
          <div className="mobile-section-title">能力标签</div>
          <div className="mobile-chip-row">{agent.capabilities.map((capability) => <span key={capability}>{capability}</span>)}</div>
        </>
      ) : null}
    </section>
  );
}

const orchestratorAgentDefinition: AgentDefinition = {
  id: "agent-orchestrator",
  name: "Orchestrator",
  avatar: "/avatars/agents/agent-v2-01.png",
  type: "orchestrator",
  provider: "internal",
  description: "主 Agent，负责理解任务、拆解调度、校验子 Agent 输出并汇总结果。",
  capabilities: ["intent", "decompose", "assignment", "validate", "memory"],
  status: "available",
  visibility: "public"
};

function MobileToolDetailCard({ tool }: { tool: ToolDefinition }) {
  return (
    <section className="mobile-detail-card">
      <div className="mobile-detail-title">
        <span><Wrench size={19} /></span>
        <div>
          <strong>{tool.name}</strong>
          <small>{toolCategoryLabel(tool.category)} · {tool.risk}</small>
        </div>
      </div>
      <p>{tool.description}</p>
      <div className="mobile-chip-row">
        {tool.runtimeType ? <span>{tool.runtimeType}</span> : null}
        {tool.runtimeToolId ? <span>{tool.runtimeToolId}</span> : null}
        {tool.requiresApproval ? <span>需要审批</span> : <span>直接调用</span>}
      </div>
      {tool.permissionScopes?.length ? (
        <>
          <div className="mobile-section-title">权限范围</div>
          <div className="mobile-chip-row">{tool.permissionScopes.map((scope) => <span key={scope}>{scope}</span>)}</div>
        </>
      ) : null}
    </section>
  );
}

function MobileHubAssetDetailCard({ asset }: { asset: WorkspaceAsset }) {
  const assetUrl = api.assetContentUrl(asset.workspaceId, asset.id);
  return (
    <section className="mobile-detail-card">
      <div className="mobile-detail-title">
        <span>{asset.kind === "doc" ? <FileText size={19} /> : <Database size={19} />}</span>
        <div>
          <strong>{asset.name}</strong>
          <small>{assetScopeLabel(asset)} · {assetPreviewMeta(asset)}</small>
        </div>
      </div>
      {asset.summary ? <p>{asset.summary}</p> : null}
      <div className="mobile-chip-row">
        {asset.releaseVersion ? <span>{asset.releaseVersion}</span> : null}
        {typeof asset.likeCount === "number" ? <span>{asset.likeCount} 赞</span> : null}
        {asset.updateAvailable ? <span>有更新</span> : null}
      </div>
      {asset.content ? (
        <>
          <div className="mobile-section-title">内容预览</div>
          <AssetRenderPreview file={asset} assetUrl={assetUrl} className="mobile-asset-render" />
        </>
      ) : null}
    </section>
  );
}

function MobileAgentRuntimeSummary({ status }: { status: AgentRuntimeStatus }) {
  return (
    <section className="mobile-detail-card">
      <div className="mobile-section-title">运行状态</div>
      <div className="mobile-chip-row">
        <span>排队 {status.queue.queued}</span>
        <span>运行中 {status.queue.running}</span>
        <span>待澄清 {status.queue.needsClarification}</span>
        <span>失败 {status.queue.failed}</span>
      </div>
      {status.recentAgentRuns.slice(0, 4).map((run) => (
        <div className="mobile-runtime-row" key={run.id}>
          <strong>{run.status}</strong>
          <small>{new Date(run.startedAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}</small>
        </div>
      ))}
    </section>
  );
}

function isUiRuntimeAgent(agent: AgentDefinition) {
  return agent.id === "agent-ui" || agent.type === "ui";
}

function parseHubKind(value: string): MobileHubKind {
  return value === "tool" || value === "skill" || value === "knowledge" ? value : "agent";
}

function mobileHubBucketOptions(kind: MobileHubKind): Array<{ id: MobileHubBucket; label: string }> {
  if (kind === "tool") {
    return [
      { id: "personal", label: "私有" },
      { id: "subscribed", label: "订阅" },
      { id: "published", label: "公开" }
    ];
  }
  return [
    { id: "personal", label: "私有" },
    { id: "subscribed", label: "订阅" },
    { id: "fork", label: "Fork" },
    { id: "published", label: "公开" }
  ];
}

function hubKindLabel(kind: MobileHubKind) {
  const labels: Record<MobileHubKind, string> = {
    agent: "AgentHub",
    tool: "ToolHub",
    skill: "SkillHub",
    knowledge: "KnowledgeHub"
  };
  return labels[kind];
}

function agentMatchesBucket(agent: AgentDefinition, bucket: MobileHubBucket) {
  if (bucket === "subscribed") return Boolean(agent.installed);
  if (bucket === "fork") return Boolean(agent.sourceAgentId);
  if (bucket === "published") return agent.visibility === "public" && !agent.installed;
  return !agent.installed && !agent.sourceAgentId && agent.visibility !== "public";
}

function toolMatchesBucket(tool: ToolDefinition, bucket: MobileHubBucket, userId?: string) {
  if (bucket === "subscribed") return Boolean(tool.subscribed);
  if (bucket === "fork") return tool.hubStatus === "forked";
  if (bucket === "published") return tool.visibility === "public" && tool.ownerType === "user" && tool.ownerId === userId;
  return tool.ownerType === "user" && tool.ownerId === userId && tool.visibility !== "public" && !tool.subscribed && tool.hubStatus !== "forked";
}

function agentLifecycleLabel(agent: AgentDefinition) {
  if (agent.installed) return agent.updateAvailable ? "订阅 · 有更新" : "订阅";
  if (agent.sourceAgentId) return "Fork";
  if (agent.visibility === "public") return "公开";
  if (agent.custom) return "私有";
  return "内置";
}

function toolLifecycleLabel(tool: ToolDefinition) {
  if (tool.hubStatus === "forked") return "Fork";
  if (tool.subscribed) return tool.updateAvailable ? "订阅 · 有更新" : "订阅";
  if (tool.visibility === "public") return "公开";
  if (tool.ownerType === "user") return "私有";
  return tool.source ?? "内置";
}

function likeCount(item: ToolDefinition | WorkspaceAsset) {
  const value = (item as { likeCount?: number }).likeCount;
  return typeof value === "number" ? value : 0;
}

function isLiked(item: ToolDefinition | WorkspaceAsset) {
  return Boolean((item as { likedByMe?: boolean }).likedByMe);
}

function createMobileAgentBuilderChecklist(): AgentBuilderChecklistItem[] {
  return [
    { id: "goal", label: "目标", status: "active" },
    { id: "role", label: "角色", status: "todo" },
    { id: "components", label: "组件", status: "todo" },
    { id: "permissions", label: "权限", status: "todo" },
    { id: "memory", label: "记忆", status: "todo" },
    { id: "naming", label: "命名", status: "todo" }
  ];
}

function WorkspaceLogo({ workspaceId, scope, large }: { workspaceId: string; scope: "personal" | "team"; large?: boolean | undefined }) {
  const tone = workspaceTone(workspaceId);
  const Icon = scope === "team" ? UsersRound : FolderOpen;
  return (
    <span className={`mobile-workspace-logo ${tone} ${large ? "large" : ""}`}>
      <Icon size={large ? 27 : 20} />
    </span>
  );
}

function workspaceTone(value: string) {
  const tones = ["blue", "green", "violet", "amber", "rose", "cyan"];
  let sum = 0;
  for (const char of value) sum += char.charCodeAt(0);
  return tones[sum % tones.length];
}

function AssetKindIcon({ kind }: { kind: WorkspaceAsset["kind"] }) {
  const Icon = kind === "image" ? Box : kind === "web" ? Home : kind === "diff" ? GitFork : kind === "log" ? Database : kind === "doc" ? FileText : FolderOpen;
  return <span><Icon size={18} /></span>;
}

function assetKindLabel(asset: WorkspaceAsset) {
  const labels: Record<WorkspaceAsset["kind"], string> = {
    file: "文件",
    image: "图片",
    web: "网页",
    diff: "代码 Diff",
    log: "运行日志",
    doc: "文档"
  };
  return labels[asset.kind] ?? "产物";
}

function formatDateLabel(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "未知";
  return date.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
}

function groupBy<T>(items: T[], getName: (item: T) => string) {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const name = getName(item);
    groups.set(name, [...(groups.get(name) ?? []), item]);
  }
  return Array.from(groups.entries()).map(([name, groupItems]) => ({ name, items: groupItems }));
}

function agentTypeLabel(type: AgentDefinition["type"]) {
  const labels: Record<AgentDefinition["type"], string> = {
    orchestrator: "主控编排",
    universal: "通用助理",
    product: "产品需求",
    ui: "UI 设计",
    review: "审阅校验",
    code: "代码开发"
  };
  return labels[type] ?? "其他 Agent";
}

function toolCategoryLabel(category?: string) {
  const value = (category ?? "other").toLowerCase();
  const labels: Record<string, string> = {
    workspace: "工作空间",
    code: "代码工具",
    file: "文件工具",
    knowledge: "知识检索",
    search: "搜索查询",
    network: "外部网络",
    approval: "审批安全",
    system: "系统运行",
    other: "其他工具"
  };
  return labels[value] ?? category ?? "其他工具";
}

function assetScopeLabel(asset: WorkspaceAsset) {
  if (asset.hubStatus === "forked") return "Fork";
  if (asset.subscribed) return asset.updateAvailable ? "订阅 · 有更新" : "订阅";
  if (asset.ownerType === "system") return "系统公开";
  if (asset.visibility === "public") return "公开资产";
  return "个人资产";
}

function assetPreviewMeta(asset: Pick<WorkspaceAsset, "kind" | "mimeType" | "size">) {
  const size = typeof asset.size === "number" ? compactSize(asset.size) : "";
  return [asset.mimeType || asset.kind, size].filter(Boolean).join(" · ");
}

function compactSize(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 102.4) / 10} KB`;
  return `${Math.round(size / 1024 / 102.4) / 10} MB`;
}

function latestOrchestratorRun(runs: OrchestratorRun[] | undefined, conversationId: string) {
  const latest = [...(runs ?? [])].sort((left, right) => {
    const leftTime = Date.parse(left.startedAt || left.completedAt || "");
    const rightTime = Date.parse(right.startedAt || right.completedAt || "");
    return rightTime - leftTime;
  })[0];
  return latest ?? createIdleOrchestratorRun(conversationId);
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

function MobileMe() {
  const user = useAuthStore((state) => state.user);
  const logoutStore = useAuthStore((state) => state.logout);
  const navigate = useNavigate();
  const logout = useMutation({
    mutationFn: api.logout,
    onSettled: () => {
      logoutStore();
      navigate("/mobile/login?agenthubMobile=1", { replace: true, state: { from: "/mobile/messages" } });
    }
  });

  return (
    <MobileTabShell active="me" title="我的">
      <section className="mobile-profile">
        <AvatarMark kind="user" value={user?.avatar ?? ""} label={user?.name ?? "用户"} />
        <div>
          <strong>{user?.name}</strong>
          <small>{user?.publicId}</small>
        </div>
      </section>
      <div className="mobile-card-list">
        <button className="mobile-settings-row danger" type="button" onClick={() => logout.mutate()}>
          <LogOut size={18} />
          <span>退出登录</span>
        </button>
      </div>
    </MobileTabShell>
  );
}

function MobileEmpty({ text }: { text: string }) {
  return <div className="mobile-empty">{text}</div>;
}

function formatShortTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

function statusLabel(status: string) {
  const labels: Record<string, string> = {
    queued: "排队",
    running: "运行中",
    waiting_user: "待确认",
    waiting_agent: "等待",
    waiting_tool: "工具",
    completed: "完成",
    failed: "失败",
    cancelled: "取消",
    waiting_review: "待审阅",
    revision_requested: "返工",
    merged: "已合并",
    building: "构建中",
    ready: "已就绪"
  };
  return labels[status] ?? status;
}

function diffReviewStateLabel(state: Extract<MessageBlock, { type: "diff" }>["payload"]["reviewState"]) {
  if (state === "approved") return "已通过";
  if (state === "changes_requested") return "需修改";
  return "待审阅";
}
