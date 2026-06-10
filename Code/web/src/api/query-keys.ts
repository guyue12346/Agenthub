export const queryKeys = {
  authMe: ["auth-me"] as const,
  adminAuthMe: ["admin-auth-me"] as const,
  userRoot: (userId: string) => ["user", userId] as const,
  users: (userId: string) => ["user", userId, "users"] as const,
  conversationRoot: (userId: string) => ["user", userId, "conversations"] as const,
  conversations: (userId: string, search?: string, archived = false) =>
    ["user", userId, "conversations", archived ? "archived" : "active", search?.trim() || "all"] as const,
  conversationDetail: (userId: string, conversationId: string) => ["user", userId, "conversation-detail", conversationId] as const,
  conversationMemory: (userId: string, conversationId: string) => ["user", userId, "conversation-memory", conversationId] as const,
  messages: (userId: string, conversationId: string) => ["user", userId, "messages", conversationId] as const,
  runs: (userId: string, conversationId: string) => ["user", userId, "runs", conversationId] as const,
  agents: (userId: string, scope?: "personal" | "public" | "all", includeSystem = false) =>
    ["user", userId, "agents", scope ?? "all", includeSystem ? "with-system" : "user-visible"] as const,
  agentInstallations: (userId: string) => ["user", userId, "agent-installations"] as const,
  agent: (userId: string, agentId: string) => ["user", userId, "agent", agentId] as const,
  agentStatus: (userId: string, agentId: string) => ["user", userId, "agent-status", agentId] as const,
  tools: (userId: string, scope?: "personal" | "public") => ["user", userId, "tools", scope ?? "all"] as const,
  hubSubscriptions: (userId: string, kind?: "tool" | "skill" | "knowledge") => ["user", userId, "hub-subscriptions", kind ?? "all"] as const,
  friends: (userId: string) => ["user", userId, "friends"] as const,
  workspaces: (userId: string) => ["user", userId, "workspaces"] as const,
  workspace: (userId: string, workspaceId: string) => ["user", userId, "workspace", workspaceId] as const,
  workspaceTree: (userId: string, workspaceId: string) => ["user", userId, "workspace-tree", workspaceId] as const,
  workspaceGit: (userId: string, workspaceId: string) => ["user", userId, "workspace-git", workspaceId] as const,
  workspaceGitDiff: (userId: string, workspaceId: string, path: string) => ["user", userId, "workspace-git-diff", workspaceId, path] as const,
  workspaceFile: (userId: string, workspaceId: string, path: string) => ["user", userId, "workspace-file", workspaceId, path] as const,
  assets: (userId: string, workspaceId: string) => ["user", userId, "assets", workspaceId] as const,
  asset: (userId: string, workspaceId: string, assetId: string) => ["user", userId, "asset", workspaceId, assetId] as const,
  assetVersions: (userId: string, workspaceId: string, assetId: string) => ["user", userId, "asset-versions", workspaceId, assetId] as const,
  assetVersion: (userId: string, workspaceId: string, assetId: string, version: number) =>
    ["user", userId, "asset-version", workspaceId, assetId, version] as const,
  hubAssets: (userId: string, kind: "skill" | "knowledge", scope: "personal" | "public" | "subscribed" | "fork" | "published") =>
    ["user", userId, "hub-assets", kind, scope] as const,
  adminMonitor: (params: Record<string, unknown>) => ["admin-monitor", params] as const,
  adminRuntimeConfig: ["admin-runtime-config"] as const
};
