export interface ToolDefinitionView {
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
  sourceVersion?: number;
  sourceFingerprint?: string;
  updatedAt?: string;
}

export const publicToolHubToolIds = new Set<string>([
  "api_fetch_json",
  "web_search",
  "diagram_draw",
  "mcp_fetch_markdown",
  "mcp_git_inspect",
  "mcp_workspace_snapshot"
]);

export const toolRegistry: ToolDefinitionView[] = [
  { id: "send_message", category: "message", name: "Send Message", risk: "write", description: "发送结构化消息" },
  { id: "quote_reply", category: "message", name: "Quote Reply", risk: "write", description: "引用回复消息" },
  { id: "comment_message", category: "message", name: "Comment Message", risk: "write", description: "评论消息" },
  { id: "pin_message", category: "message", name: "Pin Message", risk: "write", description: "Pin 关键消息" },
  { id: "like_message", category: "message", name: "Like Message", risk: "write", description: "点赞消息" },
  { id: "list_files", category: "workspace", name: "List Files", risk: "read", description: "列出工作空间文件" },
  { id: "read_file", category: "workspace", name: "Read File", risk: "read", description: "读取工作空间文件" },
  { id: "search_files", category: "workspace", name: "Search Files", risk: "read", description: "搜索工作空间文件" },
  { id: "write_file", category: "workspace", name: "Write File", risk: "write", description: "写入工作空间文本文件并创建资产记录" },
  { id: "create_asset", category: "asset", name: "Create Asset", risk: "write", description: "创建工作空间资产" },
  { id: "read_asset", category: "asset", name: "Read Asset", risk: "read", description: "读取资产摘要或内容" },
  { id: "summarize_asset", category: "asset", name: "Summarize Asset", risk: "read", description: "摘要文件资产" },
  { id: "create_task_branch", category: "git", name: "Create Task Branch", risk: "write", description: "创建代码任务分支" },
  { id: "get_diff", category: "git", name: "Get Diff", risk: "read", description: "读取任务 Diff" },
  { id: "merge_task_branch", category: "git", name: "Merge Task Branch", risk: "dangerous", description: "合并审核通过分支" },
  { id: "run_command", category: "command", name: "Run Command", risk: "dangerous", description: "通过 Runner 执行命令" },
  { id: "run_test", category: "command", name: "Run Test", risk: "external", description: "运行测试或构建" },
  { id: "start_preview", category: "browser", name: "Start Preview", risk: "external", description: "启动项目预览" },
  { id: "capture_screenshot", category: "browser", name: "Capture Screenshot", risk: "read", description: "捕获预览截图" },
  { id: "console_logs", category: "browser", name: "Console Logs", risk: "read", description: "读取预览控制台日志" },
  {
    id: "api_fetch_json",
    category: "api",
    name: "API Fetch JSON",
    risk: "external",
    description: "官方受控外部 API 读取工具，仅允许 HTTPS JSON/Text GET，并阻断内网与重定向。",
    runtimeType: "official_api",
    source: "builtin",
    visibility: "public",
    metadata: {
      provider: "agenthub-official",
      allowUserApi: false,
      networkPolicy: "https_only_no_redirect_private_ip_blocked"
    },
    permissionScopes: ["external:read", "api:fetch_json"],
    requiresApproval: false,
    availableToAgentTypes: ["orchestrator", "universal", "product", "review"],
    timeoutPolicy: "short",
    auditLevel: "full"
  },
  {
    id: "web_search",
    category: "api",
    name: "Web Search",
    risk: "external",
    description: "官方联网搜索工具，面向 Agent 提供公开网页搜索结果，返回标题、链接、来源域名和摘要。",
    runtimeType: "official_api",
    source: "builtin",
    visibility: "public",
    metadata: {
      provider: "agenthub-official",
      defaultProvider: "bing_via_jina",
      networkPolicy: "https_only_no_redirect_private_ip_blocked",
      followUpTool: "mcp_fetch_markdown"
    },
    permissionScopes: ["external:read", "api:web_search"],
    requiresApproval: false,
    availableToAgentTypes: ["orchestrator", "universal", "product", "ui", "review"],
    timeoutPolicy: "short",
    auditLevel: "full"
  },
  {
    id: "diagram_draw",
    category: "mcp",
    name: "Diagram Draw",
    risk: "write",
    description: "官方图表工具，根据节点和连线生成 SVG 与 Mermaid 文档资产，底层由后端受控渲染服务执行。",
    runtimeType: "official_mcp",
    source: "builtin",
    visibility: "public",
    metadata: {
      provider: "agenthub-official",
      mcpAdapter: "diagram.draw",
      outputDirectory: "Doc/diagrams"
    },
    permissionScopes: ["asset:write", "workspace:write", "mcp:diagram"],
    requiresApproval: false,
    availableToAgentTypes: ["orchestrator", "universal", "product", "ui", "review"],
    timeoutPolicy: "long",
    auditLevel: "full"
  },
  {
    id: "mcp_fetch_markdown",
    category: "mcp",
    name: "Fetch Markdown",
    risk: "external",
    description: "官方 Fetch MCP 适配器，抓取公开 HTTPS 网页，转换为 Markdown 摘要并写入工作空间 Doc/research。",
    runtimeType: "official_mcp",
    source: "builtin",
    visibility: "public",
    metadata: {
      provider: "agenthub-official",
      referenceServer: "@modelcontextprotocol/server-fetch",
      mcpAdapter: "fetch.markdown",
      outputDirectory: "Doc/research"
    },
    permissionScopes: ["external:read", "asset:write", "workspace:write", "mcp:fetch"],
    requiresApproval: false,
    availableToAgentTypes: ["orchestrator", "universal", "product", "ui", "review"],
    timeoutPolicy: "long",
    auditLevel: "full"
  },
  {
    id: "mcp_git_inspect",
    category: "mcp",
    name: "Git Inspect",
    risk: "read",
    description: "官方 Git MCP 适配器，读取工作空间 Code/ 仓库状态、Diff 摘要和最近提交，不执行写入操作。",
    runtimeType: "official_mcp",
    source: "builtin",
    visibility: "public",
    metadata: {
      provider: "agenthub-official",
      referenceServer: "mcp-server-git",
      mcpAdapter: "git.inspect",
      scope: "Code/"
    },
    permissionScopes: ["code:read", "git:read", "mcp:git"],
    requiresApproval: false,
    availableToAgentTypes: ["orchestrator", "universal", "product", "ui", "review", "code"],
    timeoutPolicy: "short",
    auditLevel: "full"
  },
  {
    id: "mcp_workspace_snapshot",
    category: "mcp",
    name: "Workspace Snapshot",
    risk: "write",
    description: "官方 Filesystem MCP 适配器，扫描工作空间 Doc/ 与 Code/ 结构并生成 Markdown 快照文档。",
    runtimeType: "official_mcp",
    source: "builtin",
    visibility: "public",
    metadata: {
      provider: "agenthub-official",
      referenceServer: "@modelcontextprotocol/server-filesystem",
      mcpAdapter: "filesystem.snapshot",
      outputDirectory: "Doc/reports"
    },
    permissionScopes: ["workspace:read", "asset:write", "mcp:filesystem"],
    requiresApproval: false,
    availableToAgentTypes: ["orchestrator", "universal", "product", "ui", "review"],
    timeoutPolicy: "long",
    auditLevel: "full"
  },
  { id: "call_agent", category: "agent", name: "Call Agent", risk: "write", description: "调用子 Agent" },
  { id: "get_agent_status", category: "agent", name: "Get Agent Status", risk: "read", description: "查询 AgentRun 状态" },
  { id: "cancel_agent_run", category: "agent", name: "Cancel Agent Run", risk: "dangerous", description: "取消 AgentRun" },
  { id: "ask_user", category: "user", name: "Ask User", risk: "write", description: "向用户追问" },
  { id: "request_approval", category: "user", name: "Request Approval", risk: "write", description: "请求用户确认高风险操作" },
  { id: "search_knowledge", category: "knowledge", name: "Search Knowledge", risk: "read", description: "在知识库中检索相关文档片段" }
];

export const executableRuntimeToolIds = [
  "list_files",
  "read_file",
  "search_files",
  "write_file",
  "create_asset",
  "read_asset",
  "search_knowledge",
  "api_fetch_json",
  "web_search",
  "diagram_draw",
  "mcp_fetch_markdown",
  "mcp_git_inspect",
  "mcp_workspace_snapshot"
] as const;

export const executableRuntimeToolRegistry = toolRegistry.filter((tool) =>
  (executableRuntimeToolIds as readonly string[]).includes(tool.id)
);
