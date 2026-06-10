import { getSavedApiBase } from "../config/backend-endpoint";
import type {
  AgentDefinition,
  AgentHubUser,
  ChatMessage,
  ConversationDetail,
  ConversationMemoryView,
  ConversationSummary,
  FriendConnection,
  MessageActionType,
  OrchestratorRun,
  RuntimeEvent,
  RuntimeScopeKind,
  WorkspaceAsset
} from "@agenthub/shared";

const CSRF_COOKIE_NAME = "agenthub_csrf";
export const CSRF_HEADER_NAME = "X-AgentHub-CSRF";

export interface RuntimeConfigView {
  id: string;
  name: string;
  isActive: boolean;
  isChatActive: boolean;
  isCodeActive: boolean;
  source: "database" | "environment";
  provider: string;
  baseUrl: string;
  model: string;
  reasoningEffort: string;
  wireApi: "responses" | "chat_completions";
  codexModel: string;
  codexReasoningEffort: string;
  openCodeModel: string;
  openCodeReasoningEffort: string;
  apiKeyConfigured: boolean;
  apiKeyLast4: string | null;
  apiKeySource: "database" | "environment" | "missing";
  updatedByUserId: string | null;
  updatedAt: string | null;
}

export interface RuntimeConfigProfileView {
  id: string;
  name: string;
  provider: string;
  baseUrl: string;
  model: string;
  reasoningEffort: string;
  wireApi: "responses" | "chat_completions";
  codexModel: string;
  codexReasoningEffort: string;
  openCodeModel: string;
  openCodeReasoningEffort: string;
  apiKeyConfigured: boolean;
  apiKeyLast4: string | null;
  apiKeySource: "database" | "environment" | "missing";
  isActive: boolean;
  isChatActive: boolean;
  isCodeActive: boolean;
  updatedAt: string | null;
}

export interface RuntimeConfigUpdate {
  id?: string;
  name?: string;
  provider?: string;
  baseUrl?: string;
  apiKey?: string;
  clearApiKey?: boolean;
  model?: string;
  reasoningEffort?: string;
  wireApi?: "responses" | "chat_completions";
  codexModel?: string;
  codexReasoningEffort?: string;
  openCodeModel?: string;
  openCodeReasoningEffort?: string;
  makeActiveFor?: "chat" | "code" | "both";
  makeActive?: boolean;
}

export interface RuntimeConfigTestResult {
  target: "api_key" | "codex" | "opencode";
  ok: boolean;
  latencyMs: number;
  model: string;
  message: string;
}

export interface AdminAccessInfo {
  detectedAt: string;
  request: {
    host: string | null;
    forwardedHost: string | null;
    protocol: string;
  };
  webOrigin: string;
  apiPort: number;
  webPort: number;
  interfaceAddresses: Array<{
    name: string;
    address: string;
    family: string;
    mac: string;
  }>;
  urls: Array<{
    key: string;
    host: string;
    label: string;
    url: string;
    kind: string;
  }>;
}

export interface WorkspaceTreeNode {
  name: string;
  path: string;
  type: "file" | "directory";
  size?: number;
  children?: WorkspaceTreeNode[];
}

export interface WorkspaceFileView {
  path: string;
  name: string;
  mimeType: string;
  size: number;
  content: string;
  binary?: boolean;
  previewableText?: boolean;
  assetId?: string | null;
  assetKind?: WorkspaceAsset["kind"];
  assetSummary?: string;
  latestVersion?: number;
  lock?: WorkspaceFileLockView | null;
}

export interface WorkspaceFileLockView {
  id: string;
  path: string;
  lockedByUserId: string;
  lockedByName: string;
  token?: string;
  ownedByMe: boolean;
  expiresAt: string;
  updatedAt: string;
}

export interface WorkspaceGitView {
  workspace: {
    id: string;
    name: string;
    conversationId: string;
    codeRoot: string;
  };
  approvalPolicy: {
    realHumanMemberCount: number;
    requiresPeerReview: boolean;
    autoApprovalReason: string | null;
  };
  members: Array<{
    id: string;
    name: string;
    avatar: string | null;
    role: string;
  }>;
  git: {
    codeRoot: string;
    repoInitialized: boolean;
    branch: string | null;
    headCommit: string | null;
    headMessage: string | null;
    dirty: boolean;
    error?: string;
    files: Array<{
      path: string;
      status: string;
      staged: boolean;
      unstaged: boolean;
      label: string;
      contributors: WorkspaceCodeContributor[];
      lastChangedAt: string | null;
    }>;
    pendingContributors: WorkspaceCodeContributor[];
    recentCommits: Array<{
      hash: string;
      shortHash: string;
      author: string;
      authorEmail: string | null;
      date: string;
      subject: string;
      contributors: WorkspaceCodeContributor[];
    }>;
  };
  proposals: WorkspaceCodeProposalView[];
  otherMemberProposals: WorkspaceCodeProposalView[];
}

export interface WorkspaceGitFileDiffView {
  path: string;
  status: string;
  label: string;
  diff: string;
}

export interface WorkspaceCodeContributor {
  id: string | null;
  name: string;
  avatar: string | null;
  role: "user" | "agent" | "unknown";
  contributions: number;
  lastChangedAt: string | null;
}

export interface WorkspaceCodeProposalView {
  id: string;
  kind: "manual" | "code_task";
  title: string;
  status: string;
  authorType: "user" | "agent";
  authorId: string | null;
  authorName: string;
  contributors: WorkspaceCodeContributor[];
  branchName: string | null;
  diffAssetId?: string | null;
  diffAssetName?: string | null;
  changedFileCount: number | null;
  isFromCurrentUser: boolean;
  requiresPeerReview: boolean;
  autoApproved: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceUploadSession {
  uploadId: string;
  workspaceId: string;
  name: string;
  mimeType: string;
  size: number;
  receivedBytes: number;
  status: string;
  chunkSize: number;
  maxSize: number;
  expiresAt: string;
}

export interface WorkspaceAssetVersion {
  id: string;
  assetId: string;
  version: number;
  size: number;
  checksumSha256: string;
  createdByUserId?: string;
  createdByName?: string;
  createdAt: string;
  source?: string;
  sourceLabel?: string;
  action?: string;
  previousPath?: string;
  restoredFromVersion?: number | null;
}

export interface WorkspaceAssetVersionContent {
  id: string;
  assetId: string;
  version: number;
  path: string;
  name: string;
  mimeType: string;
  size: number;
  checksumSha256: string;
  createdByUserId?: string | null;
  createdAt: string;
  source?: string;
  sourceLabel?: string;
  action?: string;
  content: string;
  binary: boolean;
  previewableText: boolean;
}

export interface MonitorPaginationParams {
  usersPage?: number;
  usersPageSize?: number;
  conversationsPage?: number;
  conversationsPageSize?: number;
  logsPage?: number;
  logsPageSize?: number;
  eventsPage?: number;
  eventsPageSize?: number;
  runsPage?: number;
  runsPageSize?: number;
  logSource?: "system" | "runtime" | "llm" | "audit";
  logLevel?: string;
  search?: string;
}

export interface AgentRuntimeStatus {
  agent: AgentDefinition;
  queue: {
    queued: number;
    running: number;
    needsClarification: number;
    failed: number;
  };
  locks: Array<{
    runId: string;
    conversationId: string;
    status: string;
    currentNode: string;
    waitingOn?: unknown;
    blockers?: unknown;
  }>;
  currentToolRuns: Array<{
    id: string;
    runId: string | null;
    toolId: string;
    status: string;
    input: unknown;
    output?: unknown;
    error?: string | null;
    createdAt: string;
  }>;
  recentAgentRuns: Array<{
    id: string;
    runId: string | null;
    conversationId: string | null;
    status: string;
    input: unknown;
    output: unknown;
    internalTraceRef: string | null;
    startedAt: string;
    completedAt: string | null;
    stepEvents?: Array<{
      type: string;
      seq: number;
      payload: unknown;
      createdAt: string;
    }>;
  }>;
}

export interface RuntimeJobView {
  id: string;
  kind: string;
  status: string;
  targetType: string;
  targetId: string;
  attempts: number;
  maxAttempts: number;
  cancelRequested: boolean;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export type HubKind = "tool" | "skill" | "knowledge";
export type HubAssetScope = "personal" | "public" | "subscribed" | "fork" | "published";

export interface HubLifecycleView {
  subscribed?: boolean;
  subscriptionId?: string;
  sourceVersion?: number;
  installedVersion?: number;
  hubStatus?: "active" | "forked" | "paused" | "removed";
  updateAvailable?: boolean;
  conflictStatus?: string | null;
  forkedAssetId?: string | null;
}

export interface ToolDefinition extends HubLifecycleView {
  id: string;
  category: string;
  name: string;
  risk: "read" | "write" | "external" | "dangerous";
  description: string;
  runtimeType?: string;
  source?: string;
  visibility?: string;
  ownerType?: string;
  ownerId?: string | null;
  runtimeToolId?: string | null;
  metadata?: Record<string, unknown>;
  executable?: boolean;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  permissionScopes?: string[];
  requiresApproval?: boolean;
  availableToAgentTypes?: string[];
  timeoutPolicy?: string;
  auditLevel?: string;
}

export type ExecutableRuntimeToolId =
  | "list_files"
  | "read_file"
  | "search_files"
  | "write_file"
  | "create_asset"
  | "read_asset"
  | "search_knowledge"
  | "api_fetch_json"
  | "web_search"
  | "diagram_draw";

export interface CreatePersonalToolPayload {
  name: string;
  description: string;
  runtimeType?: "builtin_alias" | "function";
  runtimeToolId?: ExecutableRuntimeToolId;
  category?: string;
  risk?: "read" | "write" | "external";
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  permissionScopes?: string[];
  availableToAgentTypes?: string[];
  functionSource?: string;
  functionLanguage?: "javascript";
  functionTimeoutMs?: number;
  functionMemoryMb?: number;
  functionOutputBytes?: number;
}

export interface AgentBuilderPayload {
  name: string;
  description: string;
  avatar?: string;
  type?: "universal" | "product" | "ui" | "review";
  category?: string;
  capabilities?: string[];
  visibility?: "private" | "public";
  rolePrompt?: string;
  goals?: string[];
  behaviorRules?: string[];
  outputRules?: string[];
  refusalRules?: string[];
  skillAssetIds?: string[];
  toolIds?: string[];
  knowledgeAssetIds?: string[];
  knowledgeBindings?: Array<{
    assetId: string;
    retrievalMode: "query" | "rag";
  }>;
  model?: {
    provider?: string;
    model?: string;
    temperature?: number;
    reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
    streaming?: boolean;
    fallbackModel?: string;
  };
  runtime?: {
    workflowTemplate?: "direct_answer" | "tool_loop" | "artifact_generation" | "review" | "human_approval";
    maxToolSteps?: number;
    maxRunSeconds?: number;
  };
  collaboration?: {
    orchestratorCallable?: boolean;
    dispatchTags?: string[];
    assignmentDescription?: string;
    acknowledgeOnAssignment?: boolean;
  };
  workspace?: {
    docRead?: boolean;
    docWrite?: boolean;
    codeRead?: boolean;
    codeWrite?: boolean;
    assetCreate?: boolean;
  };
  memory?: {
    useConversationMemory?: boolean;
    usePinnedMessages?: boolean;
    usePersonalCrossConversationMemory?: boolean;
    writeBackPolicy?: "none" | "summary_only" | "confirmed_only";
  };
  permissions?: {
    scopes?: string[];
    requireApprovalFor?: string[];
  };
  output?: {
    defaultFormat?: "markdown" | "json" | "artifact";
    allowedBlocks?: string[];
  };
  publishing?: {
    license?: string;
    changelog?: string;
  };
  confirmHighRiskPublish?: boolean;
}

export interface AgentConfigView {
  agent: AgentDefinition;
  config: unknown;
  version?: string | null;
}

export interface AgentBuilderDraftRequest {
  message: string;
  includePublicAssets?: boolean;
}

export interface AgentBuilderChatMessagePayload {
  role: "assistant" | "user";
  content: string;
}

export interface AgentBuilderChatRequest {
  messages: AgentBuilderChatMessagePayload[];
  currentDraft?: Record<string, unknown>;
  includePublicAssets?: boolean;
}

export interface AgentBuilderRecommendedAsset {
  assetId: string;
  name: string;
  summary: string;
  path: string;
  visibility: "private" | "public";
  workspaceId: string;
  reason?: string;
}

export interface AgentBuilderChecklistItem {
  id: "goal" | "role" | "components" | "permissions" | "memory" | "naming";
  label: string;
  status: "todo" | "active" | "done";
}

export interface AgentBuilderDraftView {
  draft: AgentBuilderPayload;
  rationale: string;
  recommendedBindings: {
    skills: AgentBuilderRecommendedAsset[];
    tools: Array<ToolDefinition & { reason?: string }>;
    knowledge: AgentBuilderRecommendedAsset[];
  };
  safetyNotes: string[];
  promptPack?: unknown;
}

export interface AgentBuilderChatView extends AgentBuilderDraftView {
  assistantMessage: string;
  checklist: AgentBuilderChecklistItem[];
  readyToSave: boolean;
}

export interface AgentSandboxTestView {
  agent: AgentDefinition;
  version?: string | null;
  sandbox: {
    mode: "dry_run";
    message: string;
    model: unknown;
    runtime: unknown;
    skills: unknown[];
    tools: unknown[];
    knowledge: unknown[];
    collaboration: unknown;
    workspace: unknown;
    memory: unknown;
    permissions: unknown;
    output: unknown;
    promptPack?: unknown;
    contextSummary: unknown;
    executionPlan: unknown;
    toolCallLog: unknown[];
    outputBlocks: unknown[];
    memoryCandidate: unknown | null;
    riskWarnings: string[];
  };
}

export interface HubTextAssetPayload {
  name: string;
  summary?: string;
  content: string;
  visibility?: "private" | "public";
  releaseVersion?: string;
  logo?: string;
  logoColor?: string;
}

export interface KnowledgeAsset {
  id: string;
  name: string;
  description: string;
  visibility: "private" | "public";
  preset: "standard" | "precise" | "broad";
  indexStatus: string;
  fileCount: number;
  ownerType: string;
  ownerId: string;
  isOwner?: boolean;
  isSubscribed?: boolean;
  ownerName?: string;
  personalKind?: "Personal" | "Subscribed" | "Fork" | "Public";
  likeCount: number;
  likedByMe: boolean;
  logo?: string;
  logoColor?: string;
  metadata?: Record<string, unknown>;
  forkedFromId?: string | null;
  lineageRootId?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeDocument {
  id: string;
  path: string;
  title: string;
  mimeType: string;
  createdAt: string;
}

export interface KnowledgeSearchResult {
  chunkId: string;
  documentId: string;
  content: string;
  score: number;
  metadata: {
    path: string;
    title: string;
    chunkIndex: number;
  };
}

export interface CreateKnowledgePayload {
  name: string;
  description?: string;
  preset?: "standard" | "precise" | "broad";
  visibility?: "private" | "public";
  logo?: string;
  logoColor?: string;
}

export interface IndexDocumentPayload {
  name: string;
  contentBase64: string;
  mimeType?: string;
}

export interface HubSubscription {
  id: string;
  kind: HubKind;
  assetId: string;
  ownerType: "user" | "team";
  ownerId: string;
  status: "active" | "forked" | "paused" | "removed";
  sourceVersion: number;
  installedVersion: number;
  updateAvailable: boolean;
  conflictStatus?: string | null;
  forkedAssetId?: string | null;
  updatedAt: string;
  createdAt: string;
}

function clearSession() {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  const isMobile = url.pathname.startsWith("/mobile") || url.searchParams.get("agenthubMobile") === "1";
  const loginPath = isMobile ? "/mobile/login" : "/login";
  if (!url.pathname.startsWith(loginPath)) {
    const next = new URL(loginPath, window.location.origin);
    if (isMobile) {
      next.searchParams.set("agenthubMobile", "1");
      next.searchParams.set("from", `${url.pathname}${url.search}`);
    }
    window.location.assign(`${next.pathname}${next.search}`);
  }
}

function clearAdminSession() {
  if (typeof window === "undefined") return;
  if (!window.location.pathname.startsWith("/admin/login")) {
    window.location.assign("/admin/login");
  }
}

async function request<T>(
  path: string,
  init?: RequestInit,
  options?: { onAuthFailure?: () => void; authFailureStatuses?: number[] }
): Promise<T> {
  const hasJsonBody = typeof init?.body === "string";
  const method = (init?.method ?? "GET").toUpperCase();
  const csrfToken = isUnsafeMethod(method) ? readCookie(CSRF_COOKIE_NAME) : undefined;
  const response = await fetch(`${getSavedApiBase()}${path}`, {
    ...init,
    credentials: "include",
    headers: {
      ...(hasJsonBody ? { "Content-Type": "application/json" } : {}),
      ...headersToRecord(init?.headers),
      ...(csrfToken ? { [CSRF_HEADER_NAME]: csrfToken } : {})
    }
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const message = typeof body?.message === "string" ? body.message : Array.isArray(body?.message) ? body.message.join("；") : null;
    const authFailureStatuses = options?.authFailureStatuses ?? [401];
    if (authFailureStatuses.includes(response.status)) (options?.onAuthFailure ?? clearSession)();
    throw new Error(message ?? `Request failed ${response.status}`);
  }
  return (await response.json()) as T;
}

function isUnsafeMethod(method: string) {
  return method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
}

function readCookie(name: string) {
  if (typeof document === "undefined") return undefined;
  const prefix = `${name}=`;
  for (const part of document.cookie.split(";")) {
    const item = part.trim();
    if (!item.startsWith(prefix)) continue;
    return decodeURIComponent(item.slice(prefix.length));
  }
  return undefined;
}

function headersToRecord(headers: HeadersInit | undefined) {
  if (!headers) return {};
  if (headers instanceof Headers) {
    const record: Record<string, string> = {};
    headers.forEach((value, key) => {
      record[key] = value;
    });
    return record;
  }
  if (Array.isArray(headers)) return Object.fromEntries(headers);
  return headers;
}

export const api = {
  loginUsers: () => request<{ users: AgentHubUser[] }>("/auth/users"),
  me: () => request<{ user: AgentHubUser }>("/auth/me"),
  login: (username: string, password: string, clientType: "web" | "app" | "desktop" = "web") =>
    request<{ user: AgentHubUser; session: { kind: string; clientType: string; expiresAt: string } }>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password, clientType })
    }),
  adminLogin: (username: string, password: string, clientType: "web" | "app" | "desktop" = "web") =>
    request<{ user: AgentHubUser; session: { kind: string; clientType: string; expiresAt: string } }>("/auth/admin/login", {
      method: "POST",
      body: JSON.stringify({ username, password, clientType })
    }),
  adminMe: () =>
    request<{ user: AgentHubUser }>("/auth/admin/me", undefined, {
      onAuthFailure: clearAdminSession,
      authFailureStatuses: [401, 403]
    }),
  logout: () => request<{ ok: boolean }>("/auth/logout", { method: "POST" }, { authFailureStatuses: [] }),
  adminLogout: () =>
    request<{ ok: boolean }>("/auth/admin/logout", { method: "POST" }, {
      onAuthFailure: clearAdminSession,
      authFailureStatuses: []
    }),
  users: () => request<{ users: AgentHubUser[] }>("/users"),
  user: (userId: string) => request<{ user: AgentHubUser }>(`/users/${userId}`),
  updateUserProfile: (payload: { avatar?: string }) =>
    request<{ user: AgentHubUser }>("/users/me/profile", {
      method: "PATCH",
      body: JSON.stringify(payload)
    }),
  friends: () => request<{ friends: Array<{ connection: FriendConnection; user: AgentHubUser }> }>("/users/me/friends"),
  addFriend: (targetPublicId: string) =>
    request<{ connection: FriendConnection; user: AgentHubUser }>("/users/me/friends", {
      method: "POST",
      body: JSON.stringify({ targetPublicId })
    }),
  conversations: (options?: { search?: string; archived?: boolean }) => {
    const search = options?.search?.trim();
    const params: string[] = [];
    if (search) params.push(`search=${encodeURIComponent(search)}`);
    if (options?.archived) params.push("archived=true");
    const query = params.join("&");
    return request<{ conversations: ConversationSummary[] }>(`/conversations${query ? `?${query}` : ""}`);
  },
  conversation: (id: string) => request<{ conversation: ConversationDetail }>(`/conversations/${id}`),
  pinConversation: (id: string) =>
    request<{ conversation: ConversationSummary }>(`/conversations/${id}/pin`, {
      method: "POST"
    }),
  unpinConversation: (id: string) =>
    request<{ conversation: ConversationSummary }>(`/conversations/${id}/pin`, {
      method: "DELETE"
    }),
  archiveConversation: (id: string, options?: { clearMemory?: boolean }) =>
    request<{ conversation: ConversationSummary }>(`/conversations/${id}/archive`, {
      method: "POST",
      body: JSON.stringify(options ?? {})
    }),
  unarchiveConversation: (id: string) =>
    request<{ conversation: ConversationSummary }>(`/conversations/${id}/archive`, {
      method: "DELETE"
    }),
  conversationMemory: (id: string) => request<{ memory: ConversationMemoryView }>(`/conversations/${id}/memory`),
  createProjectConversation: (payload: {
    title: string;
    goal?: string;
    codeAgentId?: string;
    memberUserIds?: string[];
    memberAgentIds?: string[];
    workspaceAccess?: "owner_only" | "project_members";
    initialMemory?: string;
  }) =>
    request<{ conversation: ConversationSummary }>("/conversations", {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  openDirectConversation: (targetUserId: string) =>
    request<{ conversation: ConversationSummary }>("/conversations/direct", {
      method: "POST",
      body: JSON.stringify({ targetUserId })
    }),
  openAgentConversation: (agentId: string) =>
    request<{ conversation: ConversationSummary }>("/conversations/agent-direct", {
      method: "POST",
      body: JSON.stringify({ agentId })
    }),
  deleteConversation: (id: string, confirm: string) =>
    request<{ conversationId: string }>(`/conversations/${id}`, {
      method: "DELETE",
      body: JSON.stringify({ confirm })
    }),
  messages: (conversationId: string, options?: { beforeSeq?: number; limit?: number }) => {
    const params = new URLSearchParams();
    if (options?.beforeSeq) params.set("beforeSeq", String(options.beforeSeq));
    if (options?.limit) params.set("limit", String(options.limit));
    const query = params.toString();
    return request<{ messages: ChatMessage[]; pageInfo?: { hasMore: boolean; nextBeforeSeq?: number } }>(
      `/conversations/${conversationId}/messages${query ? `?${query}` : ""}`
    );
  },
  sendMessage: (conversationId: string, text: string, options?: { replyToMessageId?: string }) =>
    request<{ message: ChatMessage; acknowledgements: ChatMessage[]; runtimeJob: RuntimeJobView }>(`/conversations/${conversationId}/messages`, {
      method: "POST",
      body: JSON.stringify({ text, replyToMessageId: options?.replyToMessageId })
    }),
  sendAssetMessage: (
    conversationId: string,
    file: { name: string; mimeType: string; contentBase64: string },
    options?: { text?: string; replyToMessageId?: string; signal?: AbortSignal }
  ) =>
    request<{ message: ChatMessage; acknowledgements: ChatMessage[]; runtimeJob: RuntimeJobView }>(`/conversations/${conversationId}/messages/assets`, {
      method: "POST",
      ...(options?.signal ? { signal: options.signal } : {}),
      body: JSON.stringify({ ...file, text: options?.text, replyToMessageId: options?.replyToMessageId })
    }),
  beginConversationAssetUpload: (conversationId: string, file: { name: string; mimeType: string; size: number }) =>
    request<{ upload: WorkspaceUploadSession }>(`/conversations/${conversationId}/messages/asset-uploads`, {
      method: "POST",
      body: JSON.stringify(file)
    }),
  sendAssetMessageFromUpload: (
    conversationId: string,
    input: { workspaceId: string; assetId: string; text?: string; replyToMessageId?: string }
  ) =>
    request<{ message: ChatMessage; acknowledgements: ChatMessage[]; runtimeJob: RuntimeJobView }>(`/conversations/${conversationId}/messages/assets/from-upload`, {
      method: "POST",
      body: JSON.stringify(input)
    }),
  sendAssetMessageFromUploads: (
    conversationId: string,
    input: { attachments: Array<{ workspaceId: string; assetId: string }>; text?: string; replyToMessageId?: string }
  ) =>
    request<{ message: ChatMessage; acknowledgements: ChatMessage[]; runtimeJob: RuntimeJobView }>(`/conversations/${conversationId}/messages/assets/from-uploads`, {
      method: "POST",
      body: JSON.stringify(input)
    }),
  createMessageAction: (conversationId: string, messageId: string, type: MessageActionType, payload?: Record<string, unknown>) =>
    request<{ action: NonNullable<ChatMessage["actions"]>[number] }>(`/conversations/${conversationId}/messages/${messageId}/actions`, {
      method: "POST",
      body: JSON.stringify({ type, payload })
    }),
  deleteMessageAction: (conversationId: string, messageId: string, actionId: string) =>
    request<{ actionId: string; messageId: string; type: MessageActionType }>(
      `/conversations/${conversationId}/messages/${messageId}/actions/${actionId}`,
      {
        method: "DELETE"
      }
    ),
  clearMessages: (conversationId: string, confirm: string) =>
    request<{ count: number }>(`/conversations/${conversationId}/messages`, {
      method: "DELETE",
      body: JSON.stringify({ confirm })
    }),
  markMessagesRead: (conversationId: string) =>
    request<{ conversationId: string; unreadCount: number; lastReadSeq: number }>(`/conversations/${conversationId}/messages/read`, {
      method: "POST"
    }),
  agents: (scope?: "personal" | "public", options?: { includeSystem?: boolean }) => {
    const params = new URLSearchParams();
    if (scope) params.set("scope", scope);
    if (options?.includeSystem) params.set("includeSystem", "true");
    const query = params.toString();
    return request<{ agents: AgentDefinition[] }>(`/agents${query ? `?${query}` : ""}`);
  },
  agent: (agentId: string) => request<{ agent: AgentDefinition }>(`/agents/${agentId}`),
  agentConfig: (agentId: string) => request<AgentConfigView>(`/agents/${agentId}/config`),
  generateAgentDraft: (payload: AgentBuilderDraftRequest) =>
    request<AgentBuilderDraftView>("/agents/builder/draft", {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  agentBuilderChat: (payload: AgentBuilderChatRequest) =>
    request<AgentBuilderChatView>("/agents/builder/chat", {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  createAgent: (payload: AgentBuilderPayload) =>
    request<{ agent: AgentDefinition; config: unknown }>("/agents", {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  updateAgent: (agentId: string, payload: Partial<AgentBuilderPayload>) =>
    request<{ agent: AgentDefinition; config: unknown }>(`/agents/${agentId}`, {
      method: "PUT",
      body: JSON.stringify(payload)
    }),
  deleteAgent: (agentId: string) =>
    request<{ agentId: string; deletedAt: string }>(`/agents/${agentId}`, {
      method: "DELETE"
    }),
  testAgent: (agentId: string, payload: { message: string; writeMemory?: boolean; includePromptPack?: boolean }) =>
    request<AgentSandboxTestView>(`/agents/${agentId}/test`, {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  publishAgent: (agentId: string, options?: {
    confirmHighRiskPublish?: boolean;
    publishing?: AgentBuilderPayload["publishing"];
  }) =>
    request<{ agent: AgentDefinition }>(`/agents/${agentId}/publish`, {
      method: "POST",
      body: JSON.stringify(options ?? {})
    }),
  forkAgent: (agentId: string) =>
    request<{ agent: AgentDefinition; config: unknown }>(`/agents/${agentId}/fork`, {
      method: "POST"
    }),
  agentInstallations: () =>
    request<{
      installations: Array<{
        installation: { id: string; agentId: string; ownerType: string; ownerId: string; createdAt: string; updatedAt: string };
        agent: AgentDefinition;
      }>;
    }>("/agents/installations"),
  installAgent: (agentId: string) =>
    request<{ installation: { id: string; agentId: string; ownerType: string; ownerId: string }; agent: AgentDefinition }>(
      `/agents/${agentId}/install`,
      { method: "POST", body: JSON.stringify({ ownerType: "user" }) }
    ),
  syncAgentInstall: (agentId: string, options?: { confirmRiskChanges?: boolean }) =>
    request<{
      installation: { id: string; agentId: string; ownerType: string; ownerId: string; updateAvailable?: boolean; installedVersion?: string; sourceVersion?: string };
      agent: AgentDefinition;
      governance?: { requiresConfirmation: boolean; changes: Array<Record<string, unknown>> };
    }>(`/agents/${agentId}/install/sync`, {
      method: "POST",
      body: JSON.stringify({ ownerType: "user", ...(options ?? {}) })
    }),
  uninstallAgent: (agentId: string) =>
    request<{ installationId: string; agentId: string }>(`/agents/${agentId}/install`, {
      method: "DELETE"
    }),
  agentStatus: (agentId: string) => request<AgentRuntimeStatus>(`/agents/${agentId}/status`),
  approveAgentToolRun: (agentId: string, toolRunId: string) =>
    request<{ result: { toolRunId: string; toolId: string; status: string; output?: unknown; error?: string } }>(
      `/agents/${agentId}/tool-runs/${toolRunId}/approve`,
      { method: "POST" }
    ),
  rejectAgentToolRun: (agentId: string, toolRunId: string, reason?: string) =>
    request<{ result: { toolRunId: string; toolId: string; status: string; output?: unknown; error?: string } }>(
      `/agents/${agentId}/tool-runs/${toolRunId}/reject`,
      {
        method: "POST",
        body: JSON.stringify(reason ? { reason } : {})
      }
    ),
  workspaces: () =>
    request<{
      workspaces: Array<{
        id: string;
        conversationId: string;
        name: string;
        codeAgentId?: string | null;
        scope: "personal" | "team";
        memberCount: number;
        assetCount: number;
        updatedAt: string;
      }>;
    }>("/workspaces"),
  assets: (workspaceId: string) => request<{ assets: WorkspaceAsset[] }>(`/workspaces/${workspaceId}/assets`),
  workspaceGit: (workspaceId: string) =>
    request<{ view: WorkspaceGitView }>(`/workspaces/${encodeURIComponent(workspaceId)}/git`),
  workspaceGitDiff: (workspaceId: string, path: string) =>
    request<{ diff: WorkspaceGitFileDiffView }>(
      `/workspaces/${encodeURIComponent(workspaceId)}/git/diff?path=${encodeURIComponent(path)}`
    ),
  commitWorkspaceGit: (workspaceId: string, message: string) =>
    request<{ view: WorkspaceGitView }>(`/workspaces/${encodeURIComponent(workspaceId)}/git/commit`, {
      method: "POST",
      body: JSON.stringify({ message })
    }),
  createWorkspaceGitProposal: (workspaceId: string, payload: { title?: string; summary?: string }) =>
    request<{ view: WorkspaceGitView }>(`/workspaces/${encodeURIComponent(workspaceId)}/git/proposals`, {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  approveWorkspaceGitProposal: (workspaceId: string, proposalId: string) =>
    request<{ view: WorkspaceGitView }>(`/workspaces/${encodeURIComponent(workspaceId)}/git/proposals/${encodeURIComponent(proposalId)}/approve`, {
      method: "POST"
    }),
  rejectWorkspaceGitProposal: (workspaceId: string, proposalId: string, reason: string) =>
    request<{ view: WorkspaceGitView }>(`/workspaces/${encodeURIComponent(workspaceId)}/git/proposals/${encodeURIComponent(proposalId)}/reject`, {
      method: "POST",
      body: JSON.stringify({ reason })
    }),
  workspaceTree: (workspaceId: string) => request<{ tree: WorkspaceTreeNode[] }>(`/workspaces/${encodeURIComponent(workspaceId)}/tree`),
  workspaceFile: (workspaceId: string, path: string) =>
    request<{ file: WorkspaceFileView }>(
      `/workspaces/${encodeURIComponent(workspaceId)}/files?path=${encodeURIComponent(path)}`
    ),
  acquireWorkspaceFileLock: (workspaceId: string, path: string) =>
    request<{ lock: WorkspaceFileLockView }>(`/workspaces/${encodeURIComponent(workspaceId)}/files/lock`, {
      method: "POST",
      body: JSON.stringify({ path })
    }),
  releaseWorkspaceFileLock: (workspaceId: string, path: string, lockToken: string) =>
    request<{ lock: { released: boolean; path: string } }>(`/workspaces/${encodeURIComponent(workspaceId)}/files/lock`, {
      method: "DELETE",
      body: JSON.stringify({ path, lockToken })
    }),
  writeWorkspaceFile: (
    workspaceId: string,
    path: string,
    content: string,
    options?: { originalPath?: string; lockToken?: string; expectedVersion?: number }
  ) =>
    request<{ file: { path: string; name: string; mimeType?: string | null; size?: number | null; assetId: string } }>(
      `/workspaces/${encodeURIComponent(workspaceId)}/files`,
      {
        method: "POST",
        body: JSON.stringify({
          path,
          content,
          ...(options?.originalPath ? { originalPath: options.originalPath } : {}),
          ...(options?.lockToken ? { lockToken: options.lockToken } : {}),
          ...(options?.expectedVersion !== undefined ? { expectedVersion: options.expectedVersion } : {})
        })
      }
    ),
  uploadWorkspaceAsset: (workspaceId: string, file: { name: string; mimeType: string; contentBase64: string }, options?: { signal?: AbortSignal }) =>
    request<{ asset: WorkspaceAsset & { mimeType?: string; size?: number } }>(
      `/workspaces/${encodeURIComponent(workspaceId)}/assets`,
      {
        method: "POST",
        ...(options?.signal ? { signal: options.signal } : {}),
        body: JSON.stringify(file)
      }
    ),
  beginWorkspaceUpload: (workspaceId: string, file: { name: string; mimeType: string; size: number }) =>
    request<{ upload: WorkspaceUploadSession }>(`/workspaces/${encodeURIComponent(workspaceId)}/uploads`, {
      method: "POST",
      body: JSON.stringify(file)
    }),
  uploadWorkspaceChunk: (
    workspaceId: string,
    uploadId: string,
    chunk: { offset: number; contentBase64: string },
    options?: { signal?: AbortSignal }
  ) =>
    request<{ upload: WorkspaceUploadSession }>(
      `/workspaces/${encodeURIComponent(workspaceId)}/uploads/${encodeURIComponent(uploadId)}/chunks`,
      {
        method: "POST",
        ...(options?.signal ? { signal: options.signal } : {}),
        body: JSON.stringify(chunk)
      }
    ),
  completeWorkspaceUpload: (workspaceId: string, uploadId: string) =>
    request<{ asset: WorkspaceAsset & { mimeType?: string; size?: number } }>(
      `/workspaces/${encodeURIComponent(workspaceId)}/uploads/${encodeURIComponent(uploadId)}/complete`,
      { method: "POST" }
    ),
  cancelWorkspaceUpload: (workspaceId: string, uploadId: string) =>
    request<{ uploadId: string }>(`/workspaces/${encodeURIComponent(workspaceId)}/uploads/${encodeURIComponent(uploadId)}`, {
      method: "DELETE"
    }),
  asset: (workspaceId: string, assetId: string) =>
    request<{ asset: WorkspaceAsset & { mimeType?: string; size?: number; content?: string } }>(
      `/workspaces/${encodeURIComponent(workspaceId)}/assets/${encodeURIComponent(assetId)}`
    ),
  deleteAsset: (workspaceId: string, assetId: string, confirm: string) =>
    request<{ assetId: string }>(`/workspaces/${encodeURIComponent(workspaceId)}/assets/${encodeURIComponent(assetId)}`, {
      method: "DELETE",
      body: JSON.stringify({ confirm })
    }),
  assetVersions: (workspaceId: string, assetId: string) =>
    request<{ versions: WorkspaceAssetVersion[] }>(
      `/workspaces/${encodeURIComponent(workspaceId)}/assets/${encodeURIComponent(assetId)}/versions`
    ),
  assetVersion: (workspaceId: string, assetId: string, version: number) =>
    request<{ version: WorkspaceAssetVersionContent }>(
      `/workspaces/${encodeURIComponent(workspaceId)}/assets/${encodeURIComponent(assetId)}/versions/${encodeURIComponent(String(version))}`
    ),
  rollbackAsset: (workspaceId: string, assetId: string, version: number) =>
    request<{ asset: WorkspaceAsset }>(`/workspaces/${encodeURIComponent(workspaceId)}/assets/${encodeURIComponent(assetId)}/rollback`, {
      method: "POST",
      body: JSON.stringify({ version })
    }),
  assetContentUrl: (workspaceId: string, assetId: string) =>
    `${getSavedApiBase()}/workspaces/${encodeURIComponent(workspaceId)}/assets/${encodeURIComponent(assetId)}/content`,
  assetVersionContentUrl: (workspaceId: string, assetId: string, version: number) =>
    `${getSavedApiBase()}/workspaces/${encodeURIComponent(workspaceId)}/assets/${encodeURIComponent(assetId)}/versions/${encodeURIComponent(String(version))}/content`,
  runs: (conversationId: string) => request<{ runs: OrchestratorRun[] }>(`/runtime/runs?conversationId=${conversationId}`),
  retryRun: (runId: string) =>
    request<{ run: OrchestratorRun; runtimeJob: RuntimeJobView }>(`/runtime/runs/${encodeURIComponent(runId)}/retry`, {
      method: "POST"
    }),
  runtimeEvents: (scopeKind: RuntimeScopeKind, scopeId: string, afterSeq: number) =>
    request<{ events: RuntimeEvent[] }>(`/runtime/events/${scopeKind}/${scopeId}?afterSeq=${afterSeq}`),
  cancelRuntimeJob: (jobId: string) =>
    request<{ runtimeJob: RuntimeJobView }>(`/runtime/jobs/${encodeURIComponent(jobId)}/cancel`, {
      method: "POST"
    }),
  hubAssets: (kind: "skill" | "knowledge", scope: HubAssetScope) =>
    request<{ assets: WorkspaceAsset[] }>(`/workspaces/hub/${kind}?scope=${scope}`),
  createHubAsset: (kind: "skill" | "knowledge", payload: HubTextAssetPayload) =>
    request<{ asset: WorkspaceAsset }>(`/workspaces/hub/${kind}`, {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  updateHubAsset: (kind: "skill" | "knowledge", assetId: string, payload: HubTextAssetPayload) =>
    request<{ asset: WorkspaceAsset }>(`/workspaces/hub/${kind}/${encodeURIComponent(assetId)}`, {
      method: "PATCH",
      body: JSON.stringify(payload)
    }),
  editableHubAsset: (kind: "skill" | "knowledge", assetId: string) =>
    request<{ asset: WorkspaceAsset & { mimeType?: string; size?: number; content?: string } }>(
      `/workspaces/hub/${kind}/${encodeURIComponent(assetId)}`
    ),
  deleteHubAsset: (kind: "skill" | "knowledge", assetId: string) =>
    request<{ assetId: string; deletedAt: string }>(`/workspaces/hub/${kind}/${encodeURIComponent(assetId)}`, {
      method: "DELETE"
    }),
  // Knowledge Hub dedicated APIs
  knowledgeList: (filter: "all" | "mine" | "public" = "all") =>
    request<{ items: KnowledgeAsset[] }>(`/knowledge?filter=${filter}`),
  knowledgeCreate: (payload: CreateKnowledgePayload) =>
    request<KnowledgeAsset>("/knowledge", { method: "POST", body: JSON.stringify(payload) }),
  knowledgeGet: (id: string) =>
    request<KnowledgeAsset & { documents: KnowledgeDocument[]; presets: Record<string, unknown> }>(`/knowledge/${encodeURIComponent(id)}`),
  knowledgeUpdate: (id: string, payload: Partial<CreateKnowledgePayload>) =>
    request<KnowledgeAsset>(`/knowledge/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(payload) }),
  knowledgeDelete: (id: string) =>
    request<{ success: boolean }>(`/knowledge/${encodeURIComponent(id)}`, { method: "DELETE" }),
  knowledgeSubscribe: (id: string) =>
    request<{ subscribed: boolean }>(`/knowledge/${encodeURIComponent(id)}/subscribe`, { method: "POST" }),
  knowledgeUnsubscribe: (id: string) =>
    request<{ unsubscribed: boolean }>(`/knowledge/${encodeURIComponent(id)}/subscribe`, { method: "DELETE" }),
  knowledgeFork: (id: string) =>
    request<KnowledgeAsset>(`/knowledge/${encodeURIComponent(id)}/fork`, { method: "POST" }),
  knowledgeDocuments: (id: string) =>
    request<{ documents: KnowledgeDocument[] }>(`/knowledge/${encodeURIComponent(id)}/documents`),
  knowledgeIndexDocument: (id: string, payload: IndexDocumentPayload) =>
    request<unknown>(`/knowledge/${encodeURIComponent(id)}/documents`, { method: "POST", body: JSON.stringify(payload) }),
  knowledgeDeleteDocument: (knowledgeId: string, documentId: string) =>
    request<{ success: boolean }>(`/knowledge/${encodeURIComponent(knowledgeId)}/documents/${encodeURIComponent(documentId)}`, { method: "DELETE" }),
  knowledgeSearch: (id: string, query: string, topK?: number) =>
    request<{ results: KnowledgeSearchResult[] }>(`/knowledge/${encodeURIComponent(id)}/search`, {
      method: "POST",
      body: JSON.stringify({ query, ...(topK ? { topK } : {}) })
    }),
  createPersonalTool: (payload: CreatePersonalToolPayload) =>
    request<{ tool: ToolDefinition }>("/tools/personal", {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  deleteTool: (toolId: string) =>
    request<{ toolId: string; deletedAt: string }>(`/tools/${encodeURIComponent(toolId)}`, {
      method: "DELETE"
    }),
  hubSubscriptions: (kind?: HubKind) =>
    request<{ subscriptions: HubSubscription[] }>(`/hubs/subscriptions${kind ? `?kind=${kind}` : ""}`),
  subscribeHubAsset: (kind: HubKind, assetId: string) =>
    request<{ subscription: HubSubscription }>(`/hubs/${kind}/${encodeURIComponent(assetId)}/subscribe`, {
      method: "POST",
      body: JSON.stringify({ ownerType: "user" })
    }),
  unsubscribeHubAsset: (kind: HubKind, assetId: string) =>
    request<{ subscriptionId: string; kind: HubKind; assetId: string }>(`/hubs/${kind}/${encodeURIComponent(assetId)}/subscribe`, {
      method: "DELETE"
    }),
  syncHubAsset: (kind: HubKind, assetId: string, options?: { confirmRiskChanges?: boolean }) =>
    request<{ subscription: HubSubscription }>(`/hubs/${kind}/${encodeURIComponent(assetId)}/sync`, {
      method: "POST",
      body: JSON.stringify({ ownerType: "user", ...(options?.confirmRiskChanges ? { confirmRiskChanges: true } : {}) })
    }),
  forkHubAsset: (kind: Exclude<HubKind, "tool">, assetId: string) =>
    request<{ asset: WorkspaceAsset }>(`/hubs/${kind}/${encodeURIComponent(assetId)}/fork`, {
      method: "POST"
    }),
  likeHubAsset: (kind: HubKind, assetId: string) =>
    request<{ kind: HubKind; assetId: string; likeCount: number; likedByMe: boolean }>(`/hubs/${kind}/${encodeURIComponent(assetId)}/like`, {
      method: "POST"
    }),
  unlikeHubAsset: (kind: HubKind, assetId: string) =>
    request<{ kind: HubKind; assetId: string; likeCount: number; likedByMe: boolean }>(`/hubs/${kind}/${encodeURIComponent(assetId)}/like`, {
      method: "DELETE"
    }),
  adminMonitor: (params?: MonitorPaginationParams) =>
    request<{
      counters: Record<string, number>;
      database: { mode: string; prismaSchema: string; runtimePersistence: string };
      access: AdminAccessInfo;
      users: Array<AgentHubUser & { email: string; activeSessions: number; createdAt: string; updatedAt: string }>;
      conversations: Array<{
        id: string;
        title: string;
        avatar: string;
        workspaceId?: string | null;
        workspaceName?: string | null;
        codeAgentId?: string | null;
        memberCount: number;
        messageCount: number;
        runCount: number;
        lastMessage: string;
        updatedAt: string;
      }>;
      friendConnections: FriendConnection[];
      runs: OrchestratorRun[];
      events: RuntimeEvent[];
      logs: Array<{ id: string; source: string; level: string; scope: string; message: string; traceId: string | null; createdAt: string }>;
      pagination?: Record<string, { page: number; pageSize: number; total: number; hasMore: boolean }>;
    }>(`/admin/monitor${params ? `?${new URLSearchParams(toQueryParams(params)).toString()}` : ""}`, undefined, {
      onAuthFailure: clearAdminSession,
      authFailureStatuses: [401, 403]
    }),
  monitor: () =>
    request<{
      counters: Record<string, number>;
      database: { mode: string; prismaSchema: string; runtimePersistence: string };
      access: AdminAccessInfo;
      users: Array<AgentHubUser & { email: string; activeSessions: number; createdAt: string; updatedAt: string }>;
      conversations: Array<{
        id: string;
        title: string;
        avatar: string;
        workspaceId?: string | null;
        workspaceName?: string | null;
        codeAgentId?: string | null;
        memberCount: number;
        messageCount: number;
        runCount: number;
        lastMessage: string;
        updatedAt: string;
      }>;
      friendConnections: FriendConnection[];
      runs: OrchestratorRun[];
      events: RuntimeEvent[];
      logs: Array<{ id: string; source: string; level: string; scope: string; message: string; traceId: string | null; createdAt: string }>;
    }>("/admin/monitor", undefined, {
      onAuthFailure: clearAdminSession,
      authFailureStatuses: [401, 403]
    }),
  adminRuntimeConfig: () =>
    request<{
      config: RuntimeConfigView;
      chatConfig: RuntimeConfigView;
      codeConfig: RuntimeConfigView;
      configs: RuntimeConfigProfileView[];
      activeConfigId: string;
      chatConfigId: string;
      codeConfigId: string;
    }>("/admin/runtime-config", undefined, {
      onAuthFailure: clearAdminSession,
      authFailureStatuses: [401, 403]
    }),
  updateAdminRuntimeConfig: (payload: RuntimeConfigUpdate) =>
    request<{ config: RuntimeConfigView }>("/admin/runtime-config", {
      method: "PUT",
      body: JSON.stringify(payload)
    }, {
      onAuthFailure: clearAdminSession,
      authFailureStatuses: [401, 403]
    }),
  testAdminRuntimeConfig: (payload: RuntimeConfigUpdate & { target: RuntimeConfigTestResult["target"] }) =>
    request<{ result: RuntimeConfigTestResult }>("/admin/runtime-config/test", {
      method: "POST",
      body: JSON.stringify(payload)
    }, {
      onAuthFailure: clearAdminSession,
      authFailureStatuses: [401, 403]
    }),
  switchAdminRuntimeConfig: (id: string, scope: "chat" | "code" | "both" = "both") =>
    request<{
      config: RuntimeConfigView;
      chatConfig: RuntimeConfigView;
      codeConfig: RuntimeConfigView;
      configs: RuntimeConfigProfileView[];
      activeConfigId: string;
      chatConfigId: string;
      codeConfigId: string;
    }>("/admin/runtime-config/switch", {
      method: "POST",
      body: JSON.stringify({ id, scope })
    }, {
      onAuthFailure: clearAdminSession,
      authFailureStatuses: [401, 403]
    }),
  deleteAdminRuntimeConfig: (id: string) =>
    request<{
      config: RuntimeConfigView;
      chatConfig: RuntimeConfigView;
      codeConfig: RuntimeConfigView;
      configs: RuntimeConfigProfileView[];
      activeConfigId: string;
      chatConfigId: string;
      codeConfigId: string;
    }>(`/admin/runtime-config/${encodeURIComponent(id)}`, {
      method: "DELETE"
    }, {
      onAuthFailure: clearAdminSession,
      authFailureStatuses: [401, 403]
    }),
  tools: (scope?: "personal" | "public") =>
    request<{
      tools: ToolDefinition[];
    }>(`/tools${scope ? `?scope=${scope}` : ""}`)
};

function toQueryParams(params: MonitorPaginationParams) {
  const query: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") query[key] = String(value);
  }
  return query;
}
