import type { AgentHubUser, ChatMessage, ConversationSummary, FriendConnection, WorkspaceAsset } from "./domain";
import { builtInAgents } from "./builtin-agents";
import { createMarkdownBlock } from "./message-blocks";

export { builtInAgents };

export const seedUsers: AgentHubUser[] = [
  {
    id: "guyue",
    publicId: "ah-7x4k2p9m",
    name: "古月",
    avatar: "/avatars/users/user-02.jpeg",
    role: "owner"
  },
  {
    id: "lin",
    publicId: "ah-5m8q1c3v",
    name: "林舟",
    avatar: "/avatars/users/user-01.jpg",
    role: "member"
  },
  {
    id: "chen",
    publicId: "ah-9r2t6n4b",
    name: "陈一",
    avatar: "/avatars/users/user-03.png",
    role: "member"
  },
  {
    id: "admin",
    publicId: "ah-0admin7z",
    name: "系统管理员",
    avatar: "/avatars/users/user-08.webp",
    role: "admin"
  }
];

export const seedUser = seedUsers[0]!;

export const seedFriendConnections: FriendConnection[] = [
  {
    id: "friend-guyue-lin",
    requesterId: "guyue",
    addresseeId: "lin",
    status: "accepted",
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24).toISOString(),
    updatedAt: new Date(Date.now() - 1000 * 60 * 60 * 24).toISOString()
  }
];

export const seedConversations: ConversationSummary[] = [
  {
    id: "conv-agenthub-main",
    type: "project",
    title: "AgentHub 项目群聊",
    avatar: "AH",
    workspaceId: "workspace-agenthub-main",
    codeAgentId: "agent-codex",
    lastMessage: "Orchestrator 已准备好协调第一轮任务。",
    lastActiveAt: new Date().toISOString(),
    unreadCount: 0,
    memberCount: 4
  },
  {
    id: "conv-codex-direct",
    type: "agent_direct",
    title: "Codex",
    avatar: "/avatars/agents/agent-v2-05.png",
    workspaceId: "workspace-codex-direct",
    codeAgentId: "agent-codex",
    lastMessage: "直接和 Codex 讨论代码任务。",
    lastActiveAt: new Date(Date.now() - 1000 * 60 * 20).toISOString(),
    unreadCount: 0,
    memberCount: 1
  }
];

export const seedAssets: WorkspaceAsset[] = [
  {
    id: "asset-message-engine-doc",
    workspaceId: "workspace-agenthub-main",
    kind: "doc",
    name: "消息渲染引擎设计.md",
    path: "/docs/message-engine.md",
    summary: "定义 markdown、code、file、image、web_preview、diff、agent_status、deploy_status 等消息块。",
    createdAt: new Date().toISOString()
  },
  {
    id: "asset-homepage-diff",
    workspaceId: "workspace-agenthub-main",
    kind: "diff",
    name: "homepage.diff",
    path: "/diffs/homepage.diff",
    summary: "首页改动 Diff，包含布局、消息卡片和状态面板。",
    createdAt: new Date().toISOString()
  }
];

export const seedMessages: ChatMessage[] = [
  {
    id: "msg-welcome",
    conversationId: "conv-agenthub-main",
    sender: {
      type: "agent",
      id: "agent-orchestrator",
      name: "Orchestrator",
      avatar: "/avatars/agents/agent-v2-01.png",
      subtitle: "Main Agent"
    },
    blocks: [
      createMarkdownBlock(
        "block-welcome",
        "欢迎进入 **AgentHub 项目群聊**。普通消息不会唤醒 Agent，输入 @orchestrator 可以启动主协调流程。"
      )
    ],
    mentions: [],
    createdAt: new Date().toISOString(),
    status: "sent"
  },
  {
    id: "msg-codex-welcome",
    conversationId: "conv-codex-direct",
    sender: {
      type: "agent",
      id: "agent-codex",
      name: "Codex",
      avatar: "/avatars/agents/agent-v2-05.png",
      subtitle: "Code Agent"
    },
    blocks: [
      createMarkdownBlock(
        "block-codex-welcome",
        "Codex 已连接。这里会直接把消息发送给当前 Code Agent，不需要额外输入 @codex。"
      )
    ],
    mentions: [],
    createdAt: new Date(Date.now() - 1000 * 60 * 20).toISOString(),
    status: "sent"
  }
];
