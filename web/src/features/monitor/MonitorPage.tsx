import { useEffect, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, ArrowLeft, CheckCircle2, Copy, Cpu, Database, FileClock, Globe2, KeyRound, LogOut, MessageSquareText, Network, Pencil, Plus, Power, RefreshCw, Save, ServerCog, ShieldAlert, SlidersHorizontal, Trash2, UsersRound, X } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { api, type AdminAccessInfo, type RuntimeConfigProfileView, type RuntimeConfigTestResult, type RuntimeConfigUpdate } from "../../api/client";
import { queryKeys } from "../../api/query-keys";
import { resetUserBoundary } from "../../app/session-boundary";
import { AvatarMark, BrandMark } from "../../components/AvatarMark";
import { RUNAPI_BASE_URL, RUNAPI_CATALOG_SOURCE, RUNAPI_CATALOG_UPDATED_AT, RUNAPI_GROUPS, RUNAPI_TEXT_MODEL_CATALOG, findRunApiModel, preferredRunApiWireApi } from "../../data/runapi-model-catalog";
import { useAdminAuthStore } from "../../store/admin-auth-store";

export function MonitorPage() {
  const queryClient = useQueryClient();
  const [pages, setPages] = useState({
    usersPage: 1,
    conversationsPage: 1,
    logsPage: 1,
    eventsPage: 1,
    runsPage: 1
  });
  const monitorParams = {
    ...pages,
    usersPageSize: 50,
    conversationsPageSize: 50,
    logsPageSize: 80,
    eventsPageSize: 80,
    runsPageSize: 40
  };
  const monitor = useQuery({ queryKey: queryKeys.adminMonitor(monitorParams), queryFn: () => api.adminMonitor(monitorParams), refetchInterval: 2500, retry: false });
  const currentUser = useAdminAuthStore((state) => state.user);
  const logout = useAdminAuthStore((state) => state.logout);
  const navigate = useNavigate();
  const counters = monitor.data?.counters ?? {};
  const users = monitor.data?.users ?? [];
  const conversations = monitor.data?.conversations ?? [];
  const logs = monitor.data?.logs ?? [];
  const runs = monitor.data?.runs ?? [];
  const events = monitor.data?.events ?? [];
  const access = monitor.data?.access;
  const statCards = [
    { key: "users", label: "账号", value: counters.users ?? 0, icon: UsersRound },
    { key: "conversations", label: "会话", value: counters.conversations ?? 0, icon: MessageSquareText },
    { key: "messages", label: "消息", value: counters.messages ?? 0, icon: FileClock },
    { key: "runs", label: "Run", value: counters.runs ?? 0, icon: ServerCog },
    { key: "events", label: "事件", value: counters.events ?? 0, icon: Activity },
    { key: "agents", label: "Agent", value: counters.agents ?? 0, icon: Database }
  ];

  return (
    <main className="admin-monitor-page">
      <header className="admin-topbar">
        <div className="admin-brand">
          <BrandMark />
          <div>
            <h1>后台监控中心</h1>
            <p>监控所有账号、项目群聊、运行状态、事件流和服务端日志。</p>
          </div>
        </div>
        <div className="admin-actions">
          <span className="admin-user-pill">
            <AvatarMark kind="user" size="sm" value={currentUser?.avatar ?? "AD"} label={currentUser?.name} />
            {currentUser?.name ?? "管理员"}
          </span>
          <button type="button" onClick={() => monitor.refetch()}>
            <RefreshCw size={16} /> 刷新
          </button>
          <button type="button" onClick={() => navigate("/messages")}>
            <ArrowLeft size={16} /> 返回工作台
          </button>
          <button type="button" onClick={() => {
            void api.adminLogout().finally(() => {
              resetUserBoundary(queryClient, currentUser?.id);
              logout();
              navigate("/admin/login", { replace: true });
            });
          }}>
            <LogOut size={16} /> 退出后台
          </button>
        </div>
      </header>

      {monitor.isError ? (
        <section className="admin-alert-panel">
          <ShieldAlert size={28} />
          <div>
            <h2>需要管理员账号</h2>
            <p>{monitor.error instanceof Error ? monitor.error.message : "当前账号没有后台监控权限，请使用管理员账号重新登录。"}</p>
          </div>
        </section>
      ) : null}

      <section className="admin-stat-grid" aria-label="全局统计">
        {statCards.map((card) => {
          const Icon = card.icon;
          return (
            <article key={card.key} className="admin-stat-card">
              <Icon size={18} />
              <span>{card.label}</span>
              <strong>{card.value}</strong>
            </article>
          );
        })}
      </section>

      <section className="admin-system-strip">
        <div>
          <span>数据库</span>
          <strong>{monitor.data?.database.mode ?? "unknown"}</strong>
        </div>
        <div>
          <span>持久化</span>
          <strong>{monitor.data?.database.runtimePersistence ?? "unknown"}</strong>
        </div>
        <div>
          <span>Schema</span>
          <strong>{monitor.data?.database.prismaSchema ?? "-"}</strong>
        </div>
      </section>

      <AccessInfoPanel access={access} />

      <RuntimeConfigPanel />

      <div className="admin-grid-two">
        <section className="admin-panel">
          <PanelTitle title="所有账号" subtitle={`${users.length} 个账号`} />
          <Pager
            pageInfo={monitor.data?.pagination?.users}
            onPage={(page) => setPages((current) => ({ ...current, usersPage: page }))}
          />
          <div className="admin-table">
            <div className="admin-table-head account">
              <span>账号</span>
              <span>角色</span>
              <span>活跃会话</span>
              <span>更新时间</span>
            </div>
            {users.map((user) => (
              <div key={user.id} className="admin-table-row account">
                <span className="admin-account-cell">
                  <AvatarMark kind="user" size="sm" value={user.avatar} label={user.name} />
                  <span>
                    <strong>{user.name}</strong>
                    <small>{user.id}</small>
                  </span>
                </span>
                <span>{user.role}</span>
                <span>{user.activeSessions}</span>
                <span>{formatTime(user.updatedAt)}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="admin-panel">
          <PanelTitle title="所有项目群聊" subtitle={`${conversations.length} 个项目群聊`} />
          <Pager
            pageInfo={monitor.data?.pagination?.conversations}
            onPage={(page) => setPages((current) => ({ ...current, conversationsPage: page }))}
          />
          <div className="admin-table">
            <div className="admin-table-head conversation">
              <span>群聊</span>
              <span>成员</span>
              <span>消息</span>
              <span>Run</span>
              <span>Code Agent</span>
            </div>
            {conversations.map((conversation) => (
              <div key={conversation.id} className="admin-table-row conversation">
                <span>
                  <strong>{conversation.title}</strong>
                  <small>{conversation.workspaceName ?? conversation.workspaceId ?? conversation.id}</small>
                </span>
                <span>{conversation.memberCount}</span>
                <span>{conversation.messageCount}</span>
                <span>{conversation.runCount}</span>
                <span>{conversation.codeAgentId ?? "-"}</span>
              </div>
            ))}
          </div>
        </section>
      </div>

      <section className="admin-panel">
        <PanelTitle title="所有服务端日志" subtitle={`${logs.length} 条日志，合并 system / runtime / llm / audit`} />
        <Pager
          pageInfo={monitor.data?.pagination?.logs}
          onPage={(page) => setPages((current) => ({ ...current, logsPage: page }))}
        />
        <div className="admin-log-table">
          <div className="admin-log-head">
            <span>时间</span>
            <span>来源</span>
            <span>级别</span>
            <span>范围</span>
            <span>内容</span>
            <span>Trace</span>
          </div>
          {logs.map((log) => (
            <div key={`${log.source}-${log.id}`} className="admin-log-row">
              <span>{formatTime(log.createdAt)}</span>
              <span className={`admin-log-source ${log.source}`}>{log.source}</span>
              <span>{log.level}</span>
              <span>{log.scope}</span>
              <strong>{log.message}</strong>
              <span>{log.traceId ?? "-"}</span>
            </div>
          ))}
        </div>
      </section>

      <div className="admin-grid-two bottom">
        <section className="admin-panel">
          <PanelTitle title="最近 Orchestrator Run" subtitle={`${runs.length} 条`} />
          <Pager
            pageInfo={monitor.data?.pagination?.runs}
            onPage={(page) => setPages((current) => ({ ...current, runsPage: page }))}
          />
          <div className="admin-compact-list">
            {runs.map((run) => (
              <article key={run.id}>
                <strong>{run.id}</strong>
                <span>{run.status} · {run.currentNode} · {run.conversationId}</span>
              </article>
            ))}
          </div>
        </section>
        <section className="admin-panel">
          <PanelTitle title="实时事件缓存" subtitle={`${events.length} 条`} />
          <Pager
            pageInfo={monitor.data?.pagination?.events}
            onPage={(page) => setPages((current) => ({ ...current, eventsPage: page }))}
          />
          <div className="admin-compact-list">
            {events.map((event) => (
              <article key={event.eventId}>
                <strong>{event.type}</strong>
                <span>{event.scopeKind}:{event.scopeId} · #{event.seq}</span>
              </article>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}

function AccessInfoPanel({ access }: { access: AdminAccessInfo | undefined }) {
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const copyUrl = async (key: string, url: string) => {
    await copyToClipboard(url);
    setCopiedKey(key);
    window.setTimeout(() => setCopiedKey((current) => (current === key ? null : current)), 1400);
  };
  const browserOrigin = typeof window === "undefined" ? "-" : window.location.origin;
  const currentPublicUrls = access?.urls ?? [];

  return (
    <section className="admin-panel access-info-panel">
      <PanelTitle
        title="访问地址检测"
        subtitle={`当前浏览器入口：${browserOrigin} · ${access ? formatTime(access.detectedAt) : "等待检测"}`}
      />
      <div className="access-info-layout">
        <div className="access-network-card">
          <div className="access-network-title">
            <Network size={18} />
            <strong>检测到的网卡地址</strong>
          </div>
          {access?.interfaceAddresses.length ? (
            <div className="access-ip-list">
              {access.interfaceAddresses.map((item) => (
                <span key={`${item.name}-${item.address}`}>
                  <strong>{item.address}</strong>
                  <small>{item.name}</small>
                </span>
              ))}
            </div>
          ) : (
            <p>暂未检测到可对外访问的 IPv4 网卡地址。</p>
          )}
          <small>
            请求 Host：{access?.request.forwardedHost ?? access?.request.host ?? "-"} · API 端口：{access?.apiPort ?? "-"}
          </small>
        </div>

        <div className="access-url-list">
          {currentPublicUrls.map((item) => (
            <button key={item.key} type="button" className="access-url-row" onClick={() => void copyUrl(item.key, item.url)}>
              <span className={`access-kind ${item.kind}`}>
                <Globe2 size={15} />
                {item.label}
              </span>
              <strong>{item.url}</strong>
              <em>
                <Copy size={14} />
                {copiedKey === item.key ? "已复制" : "复制"}
              </em>
            </button>
          ))}
          {!currentPublicUrls.length ? <p className="access-empty">正在等待后台返回访问地址。</p> : null}
        </div>
      </div>
    </section>
  );
}

type RuntimeConfigForm = Required<Omit<RuntimeConfigUpdate, "apiKey" | "clearApiKey" | "makeActive" | "makeActiveFor">>;
type RuntimeConfigFormSource = Pick<
  RuntimeConfigProfileView,
  "id" | "name" | "provider" | "baseUrl" | "model" | "reasoningEffort" | "wireApi" | "codexModel" | "codexReasoningEffort" | "openCodeModel" | "openCodeReasoningEffort"
>;
type RuntimeProviderPreset = Omit<RuntimeConfigForm, "id" | "name"> & {
  key: string;
  label: string;
  badge: string;
  keyPlaceholder: string;
  description?: string;
  runApiGroup?: string;
  modelCatalog?: "runapi";
};

const runApiKimiRuntimePreset: RuntimeProviderPreset = {
  key: "runapi-kimi-k2-6",
  label: "RunAPI · Kimi K2.6",
  badge: "RunAPI default",
  keyPlaceholder: "RunAPI sk-...",
  provider: "runapi",
  baseUrl: RUNAPI_BASE_URL,
  model: "kimi-k2.6",
  reasoningEffort: "high",
  wireApi: "chat_completions",
  codexModel: "gpt-5.3-codex",
  codexReasoningEffort: "high",
  openCodeModel: "runapi_openai/kimi-k2.6",
  openCodeReasoningEffort: "high",
  runApiGroup: "default",
  modelCatalog: "runapi",
  description: "Kimi 通过 RunAPI 的 OpenAI-compatible chat/completions 调用。"
};

const kimiRuntimePreset: RuntimeProviderPreset = {
  key: "kimi",
  label: "Kimi",
  badge: "Moonshot",
  keyPlaceholder: "sk-...",
  provider: "kimi",
  baseUrl: "https://api.moonshot.cn/v1",
  model: "kimi-k2.6",
  reasoningEffort: "high",
  wireApi: "chat_completions",
  codexModel: "kimi-k2.6",
  codexReasoningEffort: "high",
  openCodeModel: "kimi/kimi-k2.6",
  openCodeReasoningEffort: "high"
};

const runtimeProviderPresets: RuntimeProviderPreset[] = [
  runApiKimiRuntimePreset,
  {
    key: "runapi-deepseek-v4-pro",
    label: "RunAPI · DeepSeek V4 Pro",
    badge: "RunAPI default",
    keyPlaceholder: "RunAPI sk-...",
    provider: "runapi",
    baseUrl: RUNAPI_BASE_URL,
    model: "deepseek-v4-pro",
    reasoningEffort: "high",
    wireApi: "chat_completions",
    codexModel: "gpt-5.3-codex",
    codexReasoningEffort: "high",
    openCodeModel: "runapi_openai/deepseek-v4-pro",
    openCodeReasoningEffort: "high",
    runApiGroup: "default",
    modelCatalog: "runapi",
    description: "DeepSeek 通过 RunAPI default 分组调用。"
  },
  {
    key: "runapi-codex",
    label: "RunAPI · Codex",
    badge: "RunAPI codex",
    keyPlaceholder: "RunAPI codex sk-...",
    provider: "runapi",
    baseUrl: RUNAPI_BASE_URL,
    model: "gpt-5.3-codex",
    reasoningEffort: "high",
    wireApi: "responses",
    codexModel: "gpt-5.3-codex",
    codexReasoningEffort: "high",
    openCodeModel: "runapi_openai/gpt-5.3-codex",
    openCodeReasoningEffort: "high",
    runApiGroup: "codex",
    modelCatalog: "runapi",
    description: "给 Codex/写代码任务单独保存 codex 分组 Key。"
  },
  {
    key: "runapi-claude-sonnet",
    label: "RunAPI · Claude Sonnet",
    badge: "RunAPI claude",
    keyPlaceholder: "RunAPI claude sk-...",
    provider: "runapi",
    baseUrl: RUNAPI_BASE_URL,
    model: "claude-sonnet-4-6-thinking",
    reasoningEffort: "high",
    wireApi: "chat_completions",
    codexModel: "gpt-5.3-codex",
    codexReasoningEffort: "high",
    openCodeModel: "runapi_openai/claude-sonnet-4-6-thinking",
    openCodeReasoningEffort: "high",
    runApiGroup: "claude_normal",
    modelCatalog: "runapi",
    description: "Claude 分组 Key 可保存成独立档案，供审阅/长上下文任务切换。"
  },
  {
    key: "runapi-gemini-pro",
    label: "RunAPI · Gemini Pro",
    badge: "RunAPI discounts",
    keyPlaceholder: "RunAPI Gemini sk-...",
    provider: "runapi",
    baseUrl: RUNAPI_BASE_URL,
    model: "gemini-2.5-pro",
    reasoningEffort: "high",
    wireApi: "chat_completions",
    codexModel: "gpt-5.3-codex",
    codexReasoningEffort: "high",
    openCodeModel: "runapi_openai/gemini-2.5-pro",
    openCodeReasoningEffort: "high",
    runApiGroup: "discounts",
    modelCatalog: "runapi",
    description: "Gemini 可按 default/discounts/Plus 分组分别保存 Key。"
  },
  kimiRuntimePreset,
  {
    key: "deepseek",
    label: "DeepSeek",
    badge: "DeepSeek",
    keyPlaceholder: "sk-...",
    provider: "deepseek",
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-v4-pro",
    reasoningEffort: "high",
    wireApi: "chat_completions",
    codexModel: "deepseek-v4-pro",
    codexReasoningEffort: "high",
    openCodeModel: "deepseek/deepseek-v4-pro",
    openCodeReasoningEffort: "high"
  },
  {
    key: "runapi",
    label: "RunAPI",
    badge: "OpenAI compatible",
    keyPlaceholder: "sk-...",
    provider: "runapi",
    baseUrl: "https://runapi.co/v1",
    model: "gpt-5.5",
    reasoningEffort: "high",
    wireApi: "chat_completions",
    codexModel: "gpt-5.5",
    codexReasoningEffort: "high",
    openCodeModel: "runapi_openai/gpt-5.5",
    openCodeReasoningEffort: "high"
  },
  {
    key: "openai",
    label: "OpenAI",
    badge: "OpenAI",
    keyPlaceholder: "sk-...",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o",
    reasoningEffort: "high",
    wireApi: "responses",
    codexModel: "gpt-4o",
    codexReasoningEffort: "high",
    openCodeModel: "openai/gpt-4o",
    openCodeReasoningEffort: "high"
  }
];

const defaultRuntimeForm = runtimePresetToForm(runApiKimiRuntimePreset, "runapi-kimi-k2-6", "RunAPI default · Kimi K2.6");

function RuntimeConfigPanel() {
  const queryClient = useQueryClient();
  const runtimeConfig = useQuery({ queryKey: queryKeys.adminRuntimeConfig, queryFn: api.adminRuntimeConfig, retry: false });
  const [form, setForm] = useState<RuntimeConfigForm>(defaultRuntimeForm);
  const [apiKey, setApiKey] = useState("");
  const [clearApiKey, setClearApiKey] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [runApiGroup, setRunApiGroup] = useState("default");
  const [lastTestResult, setLastTestResult] = useState<RuntimeConfigTestResult | null>(null);
  const saveConfig = useMutation({
    mutationFn: api.updateAdminRuntimeConfig,
    onSuccess: async () => {
      setApiKey("");
      setClearApiKey(false);
      setIsCreating(false);
      setEditingId(null);
      setAdvancedOpen(false);
      await queryClient.invalidateQueries({ queryKey: queryKeys.adminRuntimeConfig });
      await queryClient.invalidateQueries({ queryKey: ["admin-monitor"] });
    }
  });
  const switchConfig = useMutation({
    mutationFn: ({ id, scope }: { id: string; scope: "chat" | "code" | "both" }) => api.switchAdminRuntimeConfig(id, scope),
    onSuccess: async () => {
      setApiKey("");
      setClearApiKey(false);
      await queryClient.invalidateQueries({ queryKey: queryKeys.adminRuntimeConfig });
      await queryClient.invalidateQueries({ queryKey: ["admin-monitor"] });
    }
  });
  const deleteConfig = useMutation({
    mutationFn: api.deleteAdminRuntimeConfig,
    onSuccess: async (payload) => {
      setForm(runtimeProfileToForm(payload.config));
      setApiKey("");
      setClearApiKey(false);
      setIsCreating(false);
      setEditingId(null);
      setAdvancedOpen(false);
      await queryClient.invalidateQueries({ queryKey: queryKeys.adminRuntimeConfig });
      await queryClient.invalidateQueries({ queryKey: ["admin-monitor"] });
    }
  });
  const testConfig = useMutation({
    mutationFn: api.testAdminRuntimeConfig,
    onSuccess: ({ result }) => setLastTestResult(result)
  });

  useEffect(() => {
    const config = runtimeConfig.data?.config;
    if (isCreating || editingId) return;
    if (!config) return;
    setForm(runtimeProfileToForm(config));
  }, [editingId, isCreating, runtimeConfig.data?.config]);

  const config = runtimeConfig.data?.config;
  const chatConfig = runtimeConfig.data?.chatConfig ?? config;
  const codeConfig = runtimeConfig.data?.codeConfig ?? config;
  const configs = runtimeConfig.data?.configs ?? [];
  const selectedProfile = configs.find((profile) => profile.id === form.id);
  const matchedPreset = findRuntimePreset(form);
  const selectedPreset = matchedPreset ?? findRuntimeProviderPreset(form) ?? runApiKimiRuntimePreset;
  const isRunApi = isRunApiConfig(form);
  const runApiModel = isRunApi ? findRunApiModel(form.model) : undefined;
  const activeRunApiGroup = RUNAPI_GROUPS.find((group) => group.key === runApiGroup);
  const updateField = <K extends keyof RuntimeConfigForm>(key: K, value: RuntimeConfigForm[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
  };
  const buildPayload = () => {
    const payload: RuntimeConfigUpdate = { ...form };
    if (apiKey.trim()) payload.apiKey = apiKey.trim();
    if (clearApiKey) payload.clearApiKey = true;
    return payload;
  };
  const startCreate = (preset: RuntimeProviderPreset = runApiKimiRuntimePreset) => {
    setForm(runtimePresetToForm(preset, makeRuntimeConfigId(preset.key), preset.label));
    setRunApiGroup(preset.runApiGroup ?? inferRunApiGroup(preset.label, preset.model));
    setApiKey("");
    setClearApiKey(false);
    setIsCreating(true);
    setEditingId(null);
    setAdvancedOpen(false);
    setLastTestResult(null);
  };
  const editProfile = (profile: RuntimeConfigProfileView) => {
    setForm(runtimeProfileToForm(profile));
    setRunApiGroup(inferRunApiGroup(profile.name, profile.model));
    setApiKey("");
    setClearApiKey(false);
    setIsCreating(false);
    setEditingId(profile.id);
    setAdvancedOpen(false);
    setLastTestResult(null);
  };
  const resetEditor = () => {
    setForm(config ? runtimeProfileToForm(config) : defaultRuntimeForm);
    setRunApiGroup(config ? inferRunApiGroup(config.name, config.model) : inferRunApiGroup(defaultRuntimeForm.name, defaultRuntimeForm.model));
    setApiKey("");
    setClearApiKey(false);
    setIsCreating(false);
    setEditingId(null);
    setAdvancedOpen(false);
    setLastTestResult(null);
  };
  const applyPreset = (presetKey: string) => {
    const preset = runtimeProviderPresets.find((item) => item.key === presetKey);
    if (!preset) return;
    const nextGroup = preset.runApiGroup ?? inferRunApiGroup(preset.label, preset.model);
    setRunApiGroup(nextGroup);
    setForm((current) => {
      const currentPreset = findRuntimePreset(current);
      const nextId = isCreating ? makeRuntimeConfigId(preset.key) : current.id;
      const presetName = preset.modelCatalog === "runapi" ? runApiProfileName(nextGroup, preset.model) : preset.label;
      const nextName = isCreating && shouldAutoNameRuntimeConfig(current.name, currentPreset) ? presetName : current.name;
      return runtimePresetToForm(preset, nextId, nextName);
    });
    setLastTestResult(null);
  };
  const applyRunApiModel = (modelId: string) => {
    const nextModelId = modelId.trim();
    const model = findRunApiModel(nextModelId);
    const nextGroup = model?.groups.includes(runApiGroup) ? runApiGroup : model?.groups[0] ?? runApiGroup;
    setRunApiGroup(nextGroup);
    setForm((current) => ({
      ...current,
      provider: "runapi",
      baseUrl: RUNAPI_BASE_URL,
      model: nextModelId,
      wireApi: preferredRunApiWireApi(nextModelId),
      codexModel: preferredRunApiCodexModel(nextModelId, current.codexModel),
      openCodeModel: `runapi_openai/${nextModelId}`,
      name: shouldAutoNameRuntimeConfig(current.name, findRuntimePreset(current)) ? runApiProfileName(nextGroup, nextModelId) : current.name
    }));
    setLastTestResult(null);
  };
  const updateRunApiGroup = (group: string) => {
    setRunApiGroup(group);
    setForm((current) => ({
      ...current,
      name: shouldAutoNameRuntimeConfig(current.name, findRuntimePreset(current)) ? runApiProfileName(group, current.model) : current.name
    }));
  };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    saveConfig.mutate(buildPayload());
  };
  const runConnectivityTest = (target: RuntimeConfigTestResult["target"]) => {
    setLastTestResult(null);
    testConfig.mutate({ ...buildPayload(), target });
  };
  const deleteProfile = (profile: RuntimeConfigProfileView) => {
    if (profile.isChatActive || profile.isCodeActive) return;
    if (window.confirm(`删除配置「${profile.name}」？`)) deleteConfig.mutate(profile.id);
  };
  const statusText = saveConfig.isError
    ? saveConfig.error instanceof Error ? saveConfig.error.message : "保存失败"
    : deleteConfig.isError
      ? deleteConfig.error instanceof Error ? deleteConfig.error.message : "删除失败"
      : saveConfig.isSuccess
        ? "配置已保存"
        : switchConfig.isError
          ? switchConfig.error instanceof Error ? switchConfig.error.message : "切换失败"
          : runtimeConfig.isLoading
            ? "正在读取配置"
            : "";
  const testStatusText = testConfig.isPending
    ? "正在测试连接..."
    : testConfig.isError
      ? testConfig.error instanceof Error ? testConfig.error.message : "连接测试失败"
      : lastTestResult
        ? `${lastTestResult.ok ? "通过" : "失败"} · ${lastTestResult.model} · ${lastTestResult.latencyMs}ms · ${lastTestResult.message}`
        : "可先测试当前表单配置";

  return (
    <section className="admin-panel runtime-config-panel">
      <PanelTitle title="模型与 API 配置" subtitle="选择 Provider，保存 API Key，再启用对应配置。RunAPI 可按分组保存多个 Key 档案并随时切换。" />
      <div className="runtime-config-shell">
        <div className="runtime-config-head">
          <div>
            <Cpu size={18} />
            <span>聊天配置</span>
            <strong>{chatConfig?.model ?? form.model}</strong>
            <small>{chatConfig?.name ?? form.name} · {chatConfig?.source === "database" ? "数据库配置" : "环境变量兜底"}</small>
          </div>
          <div>
            <Cpu size={18} />
            <span>代码配置</span>
            <strong>{codeConfig?.codexModel ?? form.codexModel}</strong>
            <small>{codeConfig?.name ?? form.name} · {codeConfig?.wireApi ?? form.wireApi}</small>
          </div>
          <div>
            <KeyRound size={18} />
            <span>API Key</span>
            <strong>{chatConfig?.apiKeyConfigured ? `聊天 · ${chatConfig.apiKeyLast4 ?? "****"}` : "聊天未配置"}</strong>
            <small>{codeConfig?.apiKeyConfigured ? `代码 · ${codeConfig.apiKeyLast4 ?? "****"}` : "代码未配置"}</small>
          </div>
        </div>

        <div className="runtime-provider-list">
          {configs.map((profile) => {
            const preset = findRuntimePreset(profile);
            return (
              <article key={profile.id} className={`runtime-provider-card${profile.isChatActive || profile.isCodeActive ? " active" : ""}`}>
                <button type="button" className="runtime-provider-main" onClick={() => editProfile(profile)}>
                  <span className="runtime-provider-icon"><KeyRound size={18} /></span>
                  <span className="runtime-provider-meta">
                    <strong>{profile.name}</strong>
                    <span>
                      <em>{preset?.label ?? (profile.provider === "runapi" ? "RunAPI" : profile.provider)}</em>
                      <code>{profile.apiKeyConfigured ? `${profile.apiKeySource} · ${profile.apiKeyLast4 ?? "****"}` : "未配置 Key"}</code>
                    </span>
                    <small>{profile.model} · {profile.baseUrl}</small>
                  </span>
                </button>
                <div className="runtime-provider-actions">
                  {profile.isChatActive ? <span className="runtime-active-badge"><MessageSquareText size={14} /> 聊天</span> : null}
                  {profile.isCodeActive ? <span className="runtime-active-badge code"><Cpu size={14} /> 代码</span> : null}
                  <button type="button" title="设为聊天配置" onClick={() => switchConfig.mutate({ id: profile.id, scope: "chat" })} disabled={profile.isChatActive || switchConfig.isPending}>
                    <MessageSquareText size={16} />
                  </button>
                  <button type="button" title="设为代码配置" onClick={() => switchConfig.mutate({ id: profile.id, scope: "code" })} disabled={profile.isCodeActive || switchConfig.isPending}>
                    <Power size={16} />
                  </button>
                  <button type="button" title="编辑配置" onClick={() => editProfile(profile)}>
                    <Pencil size={16} />
                  </button>
                  <button type="button" title="删除配置" onClick={() => deleteProfile(profile)} disabled={profile.isChatActive || profile.isCodeActive || deleteConfig.isPending}>
                    <Trash2 size={16} />
                  </button>
                </div>
              </article>
            );
          })}
          {!configs.length ? (
            <div className="runtime-provider-empty">
              <KeyRound size={18} />
              <span>暂无已保存配置</span>
            </div>
          ) : null}
        </div>

        <form className="runtime-config-form" onSubmit={submit}>
          <div className="runtime-editor-head">
            <div>
              {isCreating ? <Plus size={18} /> : <Pencil size={18} />}
              <strong>{isCreating ? "添加新配置" : editingId ? "编辑配置" : "当前配置"}</strong>
            </div>
            <button type="button" className="runtime-secondary-button" onClick={() => startCreate()}>
              <Plus size={16} /> 新增
            </button>
          </div>

          <div className="runtime-config-basic-grid">
            <label>
              <span>配置名称</span>
              <input value={form.name} placeholder={`${selectedPreset.label} 账号`} onChange={(event) => updateField("name", event.target.value)} />
            </label>
            <label>
              <span>Provider</span>
              <select value={matchedPreset?.key ?? (isRunApi ? "runapi-custom" : "custom")} onChange={(event) => applyPreset(event.target.value)}>
                {!matchedPreset ? <option value="custom">自定义</option> : null}
                {isRunApi && !matchedPreset ? <option value="runapi-custom">RunAPI 自定义</option> : null}
                {runtimeProviderPresets.map((preset) => (
                  <option key={preset.key} value={preset.key}>{preset.label}</option>
                ))}
              </select>
            </label>
            <label className="runtime-api-key-field">
              <span>API Key</span>
              <input
                type="password"
                value={apiKey}
                required={!selectedProfile?.apiKeyConfigured && !clearApiKey}
                placeholder={selectedProfile?.apiKeyConfigured ? "留空表示不修改当前 Key" : selectedPreset.keyPlaceholder}
                onChange={(event) => {
                  setApiKey(event.target.value);
                  if (event.target.value.trim()) setClearApiKey(false);
                }}
              />
            </label>
          </div>

          <div className="runtime-provider-preview">
            <span>{selectedPreset.badge}</span>
            <strong>{form.model}</strong>
            <code>{form.baseUrl}</code>
            {selectedPreset.description ? <small>{selectedPreset.description}</small> : null}
          </div>

          {isRunApi ? (
            <div className="runtime-runapi-box">
              <div className="runtime-runapi-head">
                <div>
                  <Globe2 size={16} />
                  <strong>RunAPI 模型目录</strong>
                  <span>{RUNAPI_TEXT_MODEL_CATALOG.length} 个文本模型 · {RUNAPI_CATALOG_UPDATED_AT}</span>
                </div>
                <a href={RUNAPI_CATALOG_SOURCE} target="_blank" rel="noreferrer">公开目录</a>
              </div>
              <div className="runtime-runapi-grid">
                <label>
                  <span>RunAPI 文本模型</span>
                  <input list="runapi-model-options" value={form.model} onChange={(event) => applyRunApiModel(event.target.value)} />
                  <datalist id="runapi-model-options">
                    {RUNAPI_TEXT_MODEL_CATALOG.map((model) => (
                      <option key={model.id} value={model.id} label={`${model.vendor} · ${model.groups.join("/")} · ${model.endpoints.join("/")}`} />
                    ))}
                  </datalist>
                </label>
                <label>
                  <span>Key 分组/用途</span>
                  <select value={runApiGroup} onChange={(event) => updateRunApiGroup(event.target.value)}>
                    {RUNAPI_GROUPS.map((group) => (
                      <option key={group.key} value={group.key}>{group.label} · {group.description}</option>
                    ))}
                  </select>
                </label>
                <div className="runtime-runapi-model-meta">
                  {runApiModel ? (
                    <>
                      <span>{runApiModel.vendor}</span>
                      <strong>{runApiModel.endpoints.join(" / ")}</strong>
                      <code>{runApiModel.groups.join(" / ")}</code>
                      <small>
                        输入倍率 {formatRunApiRatio(runApiModel.promptRatio)} · 输出倍率 {formatRunApiRatio(runApiModel.completionRatio)}
                        {activeRunApiGroup ? ` · 当前 Key 用途 ${activeRunApiGroup.label}` : ""}
                      </small>
                    </>
                  ) : (
                    <>
                      <span>未命中目录</span>
                      <strong>仍可保存并测试</strong>
                      <small>如果 RunAPI 后台已新增模型，可先手填模型 ID，再用测试按钮确认。</small>
                    </>
                  )}
                </div>
              </div>
            </div>
          ) : null}

          <button type="button" className="runtime-advanced-toggle" onClick={() => setAdvancedOpen((value) => !value)}>
            <SlidersHorizontal size={16} /> 高级设置
          </button>

          {advancedOpen ? (
            <div className="runtime-config-grid">
              <label>
                <span>Base URL</span>
                <input value={form.baseUrl} onChange={(event) => updateField("baseUrl", event.target.value)} />
              </label>
              <label>
                <span>主模型</span>
                <input value={form.model} onChange={(event) => updateField("model", event.target.value)} />
              </label>
              <label>
                <span>主模型推理强度</span>
                <select value={form.reasoningEffort} onChange={(event) => updateField("reasoningEffort", event.target.value)}>
                  <option value="high">high</option>
                  <option value="medium">medium</option>
                  <option value="low">low</option>
                </select>
              </label>
              <label>
                <span>Wire API</span>
                <select value={form.wireApi} onChange={(event) => updateField("wireApi", event.target.value as RuntimeConfigForm["wireApi"])}>
                  <option value="chat_completions">chat_completions</option>
                  <option value="responses">responses</option>
                </select>
              </label>
              <label>
                <span>Codex 模型</span>
                <input value={form.codexModel} onChange={(event) => updateField("codexModel", event.target.value)} />
              </label>
              <label>
                <span>Codex 推理强度</span>
                <select value={form.codexReasoningEffort} onChange={(event) => updateField("codexReasoningEffort", event.target.value)}>
                  <option value="high">high</option>
                  <option value="medium">medium</option>
                  <option value="low">low</option>
                </select>
              </label>
              <label>
                <span>OpenCode 模型</span>
                <input value={form.openCodeModel} onChange={(event) => updateField("openCodeModel", event.target.value)} />
              </label>
              <label>
                <span>OpenCode 推理强度</span>
                <select value={form.openCodeReasoningEffort} onChange={(event) => updateField("openCodeReasoningEffort", event.target.value)}>
                  <option value="high">high</option>
                  <option value="medium">medium</option>
                  <option value="low">low</option>
                </select>
              </label>
            </div>
          ) : null}

          {selectedProfile?.apiKeyConfigured ? (
            <label className="runtime-config-checkbox">
              <input type="checkbox" checked={clearApiKey} onChange={(event) => {
                setClearApiKey(event.target.checked);
                if (event.target.checked) setApiKey("");
              }} />
              清空当前配置的 API Key
            </label>
          ) : null}

          <div className="runtime-config-footer">
            <span className={saveConfig.isError || deleteConfig.isError ? "warning" : saveConfig.isSuccess ? "success" : ""}>{statusText}</span>
            <button type="button" className="runtime-secondary-button" onClick={resetEditor}>
              <X size={16} /> 取消
            </button>
            <button type="submit" disabled={saveConfig.isPending}>
              <Save size={16} /> {saveConfig.isPending ? "保存中" : isCreating ? "添加配置" : "保存配置"}
            </button>
          </div>

          <div className="runtime-config-tests">
            <button type="button" onClick={() => runConnectivityTest("api_key")} disabled={testConfig.isPending}>
              测试 API Key
            </button>
            <button type="button" onClick={() => runConnectivityTest("codex")} disabled={testConfig.isPending}>
              测试 Codex
            </button>
            <button type="button" onClick={() => runConnectivityTest("opencode")} disabled={testConfig.isPending}>
              测试 OpenCode
            </button>
            <span className={lastTestResult?.ok ? "success" : lastTestResult ? "warning" : ""}>
              {testStatusText}
            </span>
          </div>
        </form>
      </div>
    </section>
  );
}

function runtimePresetToForm(preset: RuntimeProviderPreset, id = makeRuntimeConfigId(preset.key), name = preset.label): RuntimeConfigForm {
  return {
    id,
    name,
    provider: preset.provider,
    baseUrl: preset.baseUrl,
    model: preset.model,
    reasoningEffort: preset.reasoningEffort,
    wireApi: preset.wireApi,
    codexModel: preset.codexModel,
    codexReasoningEffort: preset.codexReasoningEffort,
    openCodeModel: preset.openCodeModel,
    openCodeReasoningEffort: preset.openCodeReasoningEffort
  };
}

function runtimeProfileToForm(profile: RuntimeConfigFormSource): RuntimeConfigForm {
  return {
    id: profile.id,
    name: profile.name,
    provider: profile.provider,
    baseUrl: profile.baseUrl,
    model: profile.model,
    reasoningEffort: profile.reasoningEffort,
    wireApi: profile.wireApi,
    codexModel: profile.codexModel,
    codexReasoningEffort: profile.codexReasoningEffort,
    openCodeModel: profile.openCodeModel,
    openCodeReasoningEffort: profile.openCodeReasoningEffort
  };
}

function findRuntimePreset(config: Pick<RuntimeConfigForm, "provider" | "baseUrl" | "model">) {
  return runtimeProviderPresets.find((preset) => preset.provider === config.provider && preset.baseUrl === config.baseUrl && preset.model === config.model);
}

function findRuntimeProviderPreset(config: Pick<RuntimeConfigForm, "provider">) {
  return runtimeProviderPresets.find((preset) => preset.provider === config.provider);
}

function isRunApiConfig(config: Pick<RuntimeConfigForm, "provider" | "baseUrl">) {
  return config.provider === "runapi" || config.baseUrl === RUNAPI_BASE_URL;
}

function inferRunApiGroup(name: string, modelId: string) {
  const lowerName = name.toLowerCase();
  return RUNAPI_GROUPS.find((group) => lowerName.includes(group.key.toLowerCase()))?.key
    ?? findRunApiModel(modelId)?.groups[0]
    ?? "default";
}

function runApiProfileName(group: string, modelId: string) {
  return `RunAPI ${group} · ${modelId}`;
}

function shouldAutoNameRuntimeConfig(name: string, currentPreset?: RuntimeProviderPreset) {
  const trimmed = name.trim();
  return !trimmed || trimmed.startsWith("RunAPI ") || runtimeProviderPresets.some((preset) => preset.label === trimmed) || trimmed === currentPreset?.label;
}

function preferredRunApiCodexModel(modelId: string, currentCodexModel: string) {
  const model = findRunApiModel(modelId);
  if (model?.endpoints.includes("openai-response")) return modelId;
  if (findRunApiModel(currentCodexModel)?.endpoints.includes("openai-response")) return currentCodexModel;
  return "gpt-5.3-codex";
}

function formatRunApiRatio(value: number) {
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 6 }).format(value);
}

function makeRuntimeConfigId(providerKey: string) {
  return `${providerKey}-${Date.now().toString(36)}`;
}

function PanelTitle({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <header className="admin-panel-title">
      <h2>{title}</h2>
      <p>{subtitle}</p>
    </header>
  );
}

function Pager({
  pageInfo,
  onPage
}: {
  pageInfo: { page: number; pageSize: number; total: number; hasMore: boolean } | undefined;
  onPage: (page: number) => void;
}) {
  if (!pageInfo) return null;
  const start = pageInfo.total === 0 ? 0 : (pageInfo.page - 1) * pageInfo.pageSize + 1;
  const end = Math.min(pageInfo.page * pageInfo.pageSize, pageInfo.total);
  return (
    <div className="admin-pager">
      <span>{start}-{end} / {pageInfo.total}</span>
      <button type="button" disabled={pageInfo.page <= 1} onClick={() => onPage(pageInfo.page - 1)}>上一页</button>
      <button type="button" disabled={!pageInfo.hasMore} onClick={() => onPage(pageInfo.page + 1)}>下一页</button>
    </div>
  );
}

function formatTime(value?: string) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(new Date(value));
}

async function copyToClipboard(text: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
}
