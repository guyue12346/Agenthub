import type { MessageBlock } from "./message-blocks";

export type ConversationType = "direct" | "agent_direct" | "project";
export type ActorType = "user" | "agent" | "system";
export type UserRole = "owner" | "member" | "admin";
export type FriendStatus = "pending" | "accepted" | "blocked";

export interface AgentHubUser {
  id: string;
  publicId: string;
  name: string;
  avatar: string;
  role: UserRole;
}

export interface FriendConnection {
  id: string;
  requesterId: string;
  addresseeId: string;
  status: FriendStatus;
  createdAt: string;
  updatedAt: string;
}

export interface AgentDefinition {
  id: string;
  name: string;
  avatar: string;
  type: "orchestrator" | "universal" | "product" | "ui" | "review" | "code";
  provider?: "codex" | "opencode" | "internal";
  description: string;
  capabilities: string[];
  status: "available" | "running" | "missing_config" | "unavailable";
  visibility?: "private" | "team" | "public";
  custom?: boolean;
  sourceAgentId?: string;
  installed?: boolean;
  installationId?: string;
  installedAt?: string;
  installedVersion?: string;
  latestVersion?: string;
  updateAvailable?: boolean;
  forkable?: boolean;
  forkDisabledReason?: string;
}

export interface ConversationSummary {
  id: string;
  type: ConversationType;
  title: string;
  avatar: string;
  workspaceId?: string;
  codeAgentId?: string;
  lastMessage: string;
  lastActiveAt: string;
  pinnedAt?: string;
  archivedAt?: string;
  unreadCount: number;
  memberCount: number;
}

export interface ConversationMemberProfile {
  id: string;
  type: ActorType;
  role: string;
  name: string;
  avatar: string;
  subtitle?: string;
}

export interface ConversationDetail extends ConversationSummary {
  members: ConversationMemberProfile[];
  projectCore?: Record<string, unknown>;
}

export type MessageActionType = "like" | "pin" | "comment" | "reply" | "quote";

export interface ChatMessageAction {
  id: string;
  messageId: string;
  actor: {
    type: ActorType;
    id: string;
    name?: string;
    avatar?: string;
  };
  type: MessageActionType;
  payload?: Record<string, unknown>;
  createdAt: string;
}

export interface ChatMessageReference {
  messageId: string;
  senderName: string;
  senderAvatar?: string;
  summary: string;
  kind: "reply" | "quote" | "review";
  createdAt?: string;
}

export interface ChatMessage {
  id: string;
  conversationId: string;
  sender: {
    type: ActorType;
    id: string;
    name: string;
    avatar: string;
    subtitle?: string;
  };
  blocks: MessageBlock[];
  mentions?: string[];
  actions?: ChatMessageAction[];
  reference?: ChatMessageReference;
  metadata?: Record<string, unknown>;
  createdAt: string;
  status: "sent" | "processing" | "failed";
}

export interface WorkspaceAsset {
  id: string;
  workspaceId: string;
  kind: "file" | "image" | "web" | "diff" | "log" | "doc";
  name: string;
  path: string;
  summary: string;
  mimeType?: string;
  size?: number;
  content?: string;
  etag?: string;
  latestVersion?: number;
  subscribed?: boolean;
  subscriptionId?: string;
  hubStatus?: "active" | "forked" | "paused";
  updateAvailable?: boolean;
  conflictStatus?: string;
  forkedAssetId?: string;
  forkedFromAssetId?: string;
  createdAt: string;
  updatedAt?: string;
  ownerType?: "user" | "team" | "system" | string;
  ownerId?: string | null;
  ownerName?: string | null;
  visibility?: "private" | "public" | string;
  sourceAssetId?: string;
  currentVersion?: number;
  releaseVersion?: string;
  sourceVersion?: number;
  installedVersion?: number;
  likeCount?: number;
  likedByMe?: boolean;
  logo?: string;
  logoColor?: string;
  details?: Record<string, unknown>;
}

export interface PinnedMessageMemory {
  messageId: string;
  actionId: string;
  pinnedBy: string;
  pinnedByType: ActorType;
  pinnedAt: string;
  senderName: string;
  summary: string;
}

export interface ConversationMemoryView {
  version: number;
  updatedAt: string;
  projectCore: Record<string, unknown>;
  chatMemory: {
    pinMessages: PinnedMessageMemory[];
    earlyCompressed?: string;
    messageFileIndex?: unknown[];
    workspaceFileChanges?: unknown[];
  };
  taskBriefs?: unknown[];
  codeExecutionMemory?: Record<string, unknown>;
  preferences?: Record<string, unknown>;
  openQuestions?: unknown[];
}

export type OrchestratorNode =
  | "wake"
  | "understand"
  | "ui_query"
  | "tools"
  | "decompose"
  | "assignment"
  | "validate"
  | "integrate"
  | "summary"
  | "memory_manage";

export type OrchestratorRunStatus =
  | "queued"
  | "running"
  | "waiting_user"
  | "waiting_agent"
  | "waiting_tool"
  | "completed"
  | "failed"
  | "cancelled";

export interface OrchestratorRun {
  id: string;
  conversationId: string;
  status: OrchestratorRunStatus;
  currentNode: OrchestratorNode;
  goal: string;
  startedAt: string;
  completedAt?: string;
  nodes: Array<{
    id: OrchestratorNode;
    label: string;
    status: "pending" | "running" | "completed" | "failed";
    summary?: string;
  }>;
  edges: Array<{
    id: string;
    source: OrchestratorNode;
    target: OrchestratorNode;
    label: string;
    status: "pending" | "active" | "completed";
  }>;
  waitingOn?: any;
  runMeta?: Record<string, unknown>;
  understanding?: any;
  workItems?: any[];
  edgeHistory?: any[];
  agentRuns?: any[];
  toolRuns?: any[];
  uiInteractions?: any[];
  outputs?: any[];
  blockers?: any[];
  lastIntegrate?: any;
}
