import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { isUserVisibleAgent, type AgentDefinition, type AgentHubUser } from "@agenthub/shared";
import { ChevronDown, MessageCircle, Search, UserPlus, UsersRound } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../../api/client";
import { queryKeys } from "../../api/query-keys";
import { AvatarMark } from "../../components/AvatarMark";
import { useAuthStore } from "../../store/auth-store";
import { useUiStore } from "../../store/ui-store";

type ContactSelection =
  | { kind: "empty" }
  | { kind: "friend"; userId: string }
  | { kind: "agent"; agentId: string };

export function ContactsPage() {
  const queryClient = useQueryClient();
  const currentUser = useAuthStore((state) => state.user);
  const currentUserId = currentUser?.id ?? "";
  const agents = useQuery({ queryKey: currentUserId ? queryKeys.agents(currentUserId) : ["agents"], queryFn: () => api.agents(), enabled: Boolean(currentUser) });
  const friends = useQuery({ queryKey: currentUserId ? queryKeys.friends(currentUserId) : ["friends"], queryFn: api.friends, enabled: Boolean(currentUser) });
  const showToast = useUiStore((state) => state.showToast);
  const [selection, setSelection] = useState<ContactSelection>({ kind: "empty" });
  const [expanded, setExpanded] = useState({ friends: true, agents: true });
  const [friendPublicId, setFriendPublicId] = useState("");
  const navigate = useNavigate();

  const addFriend = useMutation({
    mutationFn: api.addFriend,
    onSuccess: ({ user }) => {
      showToast(`已添加 ${user.name}`, "success");
      setFriendPublicId("");
      setSelection({ kind: "friend", userId: user.id });
      if (currentUserId) void queryClient.invalidateQueries({ queryKey: queryKeys.friends(currentUserId) });
      if (currentUserId) void queryClient.invalidateQueries({ queryKey: queryKeys.users(currentUserId) });
    },
    onError: (error) => showToast(error instanceof Error ? error.message : "添加失败，请确认好友码是否存在", "warning")
  });
  const directChat = useMutation({
    mutationFn: api.openDirectConversation,
    onSuccess: ({ conversation }) => {
      if (currentUserId) void queryClient.invalidateQueries({ queryKey: queryKeys.conversationRoot(currentUserId) });
      navigate(`/messages/${conversation.id}`);
    },
    onError: (error) => showToast(error instanceof Error ? error.message : "无法打开好友聊天", "warning")
  });
  const agentChat = useMutation({
    mutationFn: api.openAgentConversation,
    onSuccess: ({ conversation }) => {
      if (currentUserId) void queryClient.invalidateQueries({ queryKey: queryKeys.conversationRoot(currentUserId) });
      navigate(`/messages/${conversation.id}`);
    },
    onError: (error) => showToast(error instanceof Error ? error.message : "无法打开 Agent 聊天", "warning")
  });

  const friendItems = friends.data?.friends ?? [];
  const visibleAgents = (agents.data?.agents ?? []).filter(isUserVisibleAgent);
  const selectedFriend =
    selection.kind === "friend" ? friendItems.find(({ user }) => user.id === selection.userId)?.user : undefined;
  const selectedAgent = selection.kind === "agent" ? visibleAgents.find((agent) => agent.id === selection.agentId) : undefined;

  return (
    <div className="contacts-layout">
      <aside className="list-panel contact-sidebar">
        <div className="module-title">
          <UsersRound size={22} />
          <h1>通讯录</h1>
        </div>
        <form
          className="contact-search"
          onSubmit={(event) => {
            event.preventDefault();
            if (friendPublicId.trim()) addFriend.mutate(friendPublicId.trim());
          }}
        >
          <Search size={16} />
          <input value={friendPublicId} onChange={(event) => setFriendPublicId(event.target.value)} placeholder="输入好友码加好友" />
          <button type="submit" title="添加好友" disabled={addFriend.isPending || !friendPublicId.trim()}>
            <UserPlus size={16} />
          </button>
        </form>

        <div className="contact-list">
          <ContactSection
            count={friendItems.length}
            open={expanded.friends}
            title="好友"
            onToggle={() => setExpanded((current) => ({ ...current, friends: !current.friends }))}
          >
            {friendItems.length ? (
              friendItems.map(({ connection, user }) => (
                <button
                  key={connection.id}
                  className={selection.kind === "friend" && selection.userId === user.id ? "contact-list-row active" : "contact-list-row"}
                  type="button"
                  onClick={() => setSelection({ kind: "friend", userId: user.id })}
                >
                  <AvatarMark className="conversation-avatar" kind="user" value={user.avatar} label={user.name} />
                  <span>
                    <strong>{user.name}</strong>
                    <small>{user.publicId}</small>
                  </span>
                </button>
              ))
            ) : (
              <p className="contact-empty">暂无好友</p>
            )}
          </ContactSection>

          <ContactSection
            count={visibleAgents.length}
            open={expanded.agents}
            title="Agent"
            onToggle={() => setExpanded((current) => ({ ...current, agents: !current.agents }))}
          >
            {visibleAgents.map((agent) => (
              <button
                key={agent.id}
                className={selection.kind === "agent" && selection.agentId === agent.id ? "contact-list-row active" : "contact-list-row"}
                type="button"
                onClick={() => setSelection({ kind: "agent", agentId: agent.id })}
              >
                  <AvatarMark className="conversation-avatar" kind="agent" value={agent.avatar} label={agent.name} />
                  <span>
                    <strong>{agent.name}</strong>
                    <small>{getAgentTypeLabel(agent)} · {agent.custom ? "自建" : "内置"}</small>
                  </span>
                </button>
              ))}
          </ContactSection>
        </div>
      </aside>

      <section className="contact-detail-panel">
        {selection.kind === "empty" ? <ContactEmptyDetail /> : null}
        {selectedFriend ? <FriendDetail user={selectedFriend} currentUser={currentUser} onChat={() => directChat.mutate(selectedFriend.id)} loading={directChat.isPending} /> : null}
        {selectedAgent ? (
          <AgentDetail
            agent={selectedAgent}
            onChat={() => agentChat.mutate(selectedAgent.id)}
            loading={agentChat.isPending}
          />
        ) : null}
      </section>
    </div>
  );
}

function ContactSection({
  title,
  count,
  open,
  onToggle,
  children
}: {
  title: string;
  count: number;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <section className="contact-section">
      <button className="contact-section-header" type="button" onClick={onToggle}>
        <span>{title}</span>
        <small>{count}</small>
        <ChevronDown className={open ? "open" : ""} size={16} />
      </button>
      {open ? <div className="contact-section-body">{children}</div> : null}
    </section>
  );
}

function ContactEmptyDetail() {
  return (
    <div className="contact-detail">
      <span className="contact-detail-avatar"><UsersRound size={32} /></span>
      <h2>选择联系人</h2>
      <p>从左侧好友或 Agent 列表中选择一个联系人，右侧会显示详情和可用操作。</p>
    </div>
  );
}

function FriendDetail({
  user,
  currentUser,
  onChat,
  loading
}: {
  user: AgentHubUser;
  currentUser: AgentHubUser | null;
  onChat: () => void;
  loading: boolean;
}) {
  return (
    <div className="contact-detail">
      <AvatarMark className="contact-detail-avatar text" kind="user" size="xl" value={user.avatar} label={user.name} />
      <h2>{user.name}</h2>
      <p>好友码：<code>{user.publicId}</code></p>
      <dl className="contact-meta-list">
        <div><dt>角色</dt><dd>{user.role}</dd></div>
        <div><dt>关系</dt><dd>{currentUser?.id === user.id ? "本人" : "好友"}</dd></div>
      </dl>
      <button className="primary-action" type="button" onClick={onChat} disabled={loading}>
        <MessageCircle size={18} /> 发消息
      </button>
    </div>
  );
}

function AgentDetail({ agent, onChat, loading }: { agent: AgentDefinition; onChat: () => void; loading: boolean }) {
  return (
    <div className="contact-detail">
      <AvatarMark className="contact-detail-avatar text" kind="agent" size="xl" value={agent.avatar} label={agent.name} />
      <h2>{agent.name}</h2>
      <p>{agent.description}</p>
      <div className="tag-row centered">
        {agent.capabilities.map((capability) => (
          <span key={capability}>{capability}</span>
        ))}
      </div>
      <dl className="contact-meta-list">
        <div><dt>类型</dt><dd>{getAgentTypeLabel(agent)}</dd></div>
        <div><dt>来源</dt><dd>{agent.custom ? "自建" : "内置"}</dd></div>
        <div><dt>Provider</dt><dd>{agent.provider ?? "internal"}</dd></div>
        <div><dt>状态</dt><dd>{agent.status}</dd></div>
      </dl>
      <button className="primary-action" type="button" onClick={onChat} disabled={loading}>
        <MessageCircle size={18} /> 发消息
      </button>
    </div>
  );
}

function getAgentTypeLabel(agent: AgentDefinition) {
  const labels: Record<AgentDefinition["type"], string> = {
    orchestrator: "主 Agent",
    universal: "通用 Agent",
    product: "产品 Agent",
    ui: "UI Agent",
    review: "审查 Agent",
    code: "Code Agent"
  };
  return labels[agent.type];
}
