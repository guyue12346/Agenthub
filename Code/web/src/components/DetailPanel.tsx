import { BrainCircuit, ChevronDown, RotateCcw, X } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createInitialRun, type ConversationDetail, type ConversationMemberProfile, type OrchestratorRun, type WorkspaceAsset } from "@agenthub/shared";
import { useState, type ReactNode } from "react";
import { api, type AgentRuntimeStatus } from "../api/client";
import { queryKeys } from "../api/query-keys";
import { useAuthStore } from "../store/auth-store";
import { useUiStore } from "../store/ui-store";
import { AvatarMark } from "./AvatarMark";
import { OrchestratorGraph } from "./OrchestratorGraph";
import { AssetRenderPreview } from "./AssetRenderEngine";
import { UiAgentGraph } from "./UiAgentGraph";

export function DetailPanel() {
  const detail = useUiStore((state) => state.detail);
  const close = useUiStore((state) => state.closeDetail);
  const setDetail = useUiStore((state) => state.setDetail);
  const showToast = useUiStore((state) => state.showToast);
  const userId = useAuthStore((state) => state.user?.id);
  const queryClient = useQueryClient();
  const [runTab, setRunTab] = useState<"status" | "memory" | "logs">("status");
  const [agentTab, setAgentTab] = useState<"status" | "capabilities" | "logs">("status");
  const [runBrainOpen, setRunBrainOpen] = useState(false);
  const [agentBrainOpen, setAgentBrainOpen] = useState(false);
  const conversationDetailId = detail.kind === "conversation" ? detail.conversationId : "";
  const agentStatus = useQuery({
    queryKey: userId && detail.kind === "agent" ? queryKeys.agentStatus(userId, detail.agentId) : ["agent-status", detail.kind],
    queryFn: () => api.agentStatus(detail.kind === "agent" ? detail.agentId : ""),
    enabled: Boolean(userId && detail.kind === "agent")
  });
  const conversationDetail = useQuery({
    queryKey: userId && conversationDetailId ? queryKeys.conversationDetail(userId, conversationDetailId) : ["conversation-detail", conversationDetailId || "none"],
    queryFn: () => api.conversation(conversationDetailId),
    enabled: Boolean(userId && conversationDetailId)
  });
  const retryRun = useMutation({
    mutationFn: (runId: string) => api.retryRun(runId),
    onSuccess: ({ run }) => {
      setDetail({ kind: "run", run });
      if (userId) void queryClient.invalidateQueries({ queryKey: queryKeys.runs(userId, run.conversationId) });
      showToast("已从当前失败节点重新排队", "success");
    },
    onError: (error) => {
      showToast(error instanceof Error ? error.message : "重试 Run 失败", "warning");
    }
  });
  if (detail.kind === "none") return null;

  return (
    <aside className="detail-panel">
      <button className="icon-button detail-close" type="button" onClick={close} title="关闭详情">
        <X size={18} />
      </button>
      {detail.kind === "run" ? (
        <div className="run-detail-panel">
          {detail.run.status === "failed" ? (
            <button
              className="secondary-button compact run-retry-button"
              type="button"
              disabled={retryRun.isPending}
              onClick={() => retryRun.mutate(detail.run.id)}
            >
              <RotateCcw size={15} /> {retryRun.isPending ? "正在排队" : "从当前节点重试"}
            </button>
          ) : null}
          <InspectorTabs
            value={runTab}
            tabs={[
              { id: "status", label: "状态" },
              { id: "memory", label: "记忆" },
              { id: "logs", label: "日志" }
            ]}
            onChange={setRunTab}
          />
          {runTab === "status" ? (
            <div className="inspector-stack">
              <RunBasicStatusCard run={detail.run} />
              <BrainDisclosure
                title="Orchestrator 的脑袋"
                subtitle="展开查看主 Agent 当前脑内状态机和调度轨迹"
                open={runBrainOpen}
                onToggle={() => setRunBrainOpen((value) => !value)}
              >
                <OrchestratorGraph run={detail.run} />
              </BrainDisclosure>
            </div>
          ) : null}
          {runTab === "memory" ? <RunMemoryPanel run={detail.run} /> : null}
          {runTab === "logs" ? <RunLogPanel run={detail.run} /> : null}
        </div>
      ) : null}
      {detail.kind === "asset" ? (
        <>
          <InspectorHeader eyebrow="Workspace Asset" title={detail.asset.name} />
          <AssetPreview asset={detail.asset} />
        </>
      ) : null}
      {detail.kind === "conversation" ? (
        <>
          <InspectorHeader
            eyebrow={conversationDetail.data?.conversation.type === "project" ? "" : "Conversation"}
            title={conversationDetail.data?.conversation.title ?? "群聊资料"}
            subtitle={conversationDetail.data?.conversation.type === "project" ? undefined : "会话信息"}
          />
          {conversationDetail.isLoading ? (
            <p className="muted">正在加载群聊信息...</p>
          ) : conversationDetail.data?.conversation ? (
            <ConversationInfoPanel
              conversation={conversationDetail.data.conversation}
              onOpenMember={(member) => {
                if (member.type === "agent") {
                  setDetail({ kind: "agent", agentId: member.id });
                  return;
                }
                setDetail({ kind: "person", person: memberToPersonDetail(member) });
              }}
            />
          ) : (
            <p className="muted">群聊信息加载失败。</p>
          )}
        </>
      ) : null}
      {detail.kind === "person" ? (
        <>
          <InspectorHeader eyebrow={detail.person.type === "system" ? "System" : "User"} title={detail.person.name} subtitle={detail.person.subtitle} />
          <PersonInfoPanel person={detail.person} />
        </>
      ) : null}
      {detail.kind === "preview" ? (
        <>
          <InspectorHeader eyebrow="Web Preview" title={detail.title} />
          <iframe
            className="preview-frame"
            title={detail.title}
            src={detail.url}
            sandbox="allow-scripts allow-forms"
            referrerPolicy="no-referrer"
            loading="lazy"
          />
        </>
      ) : null}
      {detail.kind === "agent" ? (
        <>
          <InspectorHeader eyebrow="Agent Inspector" title={agentStatus.data?.agent?.name ?? "Agent 状态"} subtitle={agentStatus.data?.agent?.description} />
          <InspectorTabs
            value={agentTab}
            tabs={[
              { id: "status", label: "状态" },
              { id: "capabilities", label: "能力" },
              { id: "logs", label: "日志" }
            ]}
            onChange={setAgentTab}
          />
          {agentStatus.data?.agent ? (
            <div className="agent-detail-card">
              <AvatarMark kind="agent" size="lg" value={agentStatus.data.agent.avatar} label={agentStatus.data.agent.name} />
              {agentTab === "status" ? (
                <div className="inspector-stack">
                  <AgentBasicStatusCard status={agentStatus.data} />
                  {isStatefulAgent(agentStatus.data.agent) ? (
                    <BrainDisclosure
                      title={`${agentStatus.data.agent.name} 的脑袋`}
                      subtitle="展开查看这个 Agent 的状态机、最近思考轨迹和执行记录"
                      open={agentBrainOpen}
                      onToggle={() => setAgentBrainOpen((value) => !value)}
                    >
                      {isUiAgent(agentStatus.data.agent) ? (
                        <UiAgentGraph status={agentStatus.data} />
                      ) : isOrchestratorAgent(agentStatus.data.agent) ? (
                        <OrchestratorAgentBrain />
                      ) : (
                        <AgentRuntimePanel status={agentStatus.data} />
                      )}
                    </BrainDisclosure>
                  ) : null}
                </div>
              ) : null}
              {agentTab === "capabilities" ? (
                <div className="agent-capabilities">
                  {agentStatus.data.agent.capabilities.map((capability) => <span key={capability}>{capability}</span>)}
                </div>
              ) : null}
              {agentTab === "logs" ? <AgentRuntimePanel status={agentStatus.data} /> : null}
            </div>
          ) : (
            <p className="muted">{agentStatus.isLoading ? "正在加载 Agent 状态..." : "Agent 状态加载失败"}</p>
          )}
        </>
      ) : null}
    </aside>
  );
}

function isUiAgent(agent: AgentRuntimeStatus["agent"]) {
  return agent.id === "agent-ui" || agent.type === "ui";
}

function isOrchestratorAgent(agent: AgentRuntimeStatus["agent"]) {
  return agent.id === "agent-orchestrator" || agent.type === "orchestrator";
}

function isStatefulAgent(agent: AgentRuntimeStatus["agent"]) {
  return isOrchestratorAgent(agent) || isUiAgent(agent);
}

function RunBasicStatusCard({ run }: { run: OrchestratorRun }) {
  const workItems = arrayRecords(run.workItems);
  const activeCount = workItems.filter((item) => ["queued", "running", "pending"].includes(String(item.status ?? ""))).length;
  const completedCount = workItems.filter((item) => ["completed", "validated"].includes(String(item.status ?? ""))).length;
  return (
    <section className="basic-status-card">
      <div className="basic-status-topline">
        <strong>{run.status}</strong>
        <span>{run.id === "orchestrator-idle" ? "等待唤醒" : `当前在 ${run.currentNode}`}</span>
      </div>
      <dl>
        <div><dt>当前节点</dt><dd>{run.currentNode}</dd></div>
        <div><dt>工作项</dt><dd>{workItems.length}</dd></div>
        <div><dt>进行中</dt><dd>{activeCount}</dd></div>
        <div><dt>已完成</dt><dd>{completedCount}</dd></div>
      </dl>
      {run.waitingOn ? <p>正在等待：{compactUnknown(run.waitingOn)}</p> : null}
    </section>
  );
}

function AgentBasicStatusCard({ status }: { status: AgentRuntimeStatus }) {
  const agent = status.agent;
  const latestRun = status.recentAgentRuns[0];
  return (
    <section className="basic-status-card agent-basic-status-card">
      <div className="basic-status-topline">
        <strong>{agent.status}</strong>
        <span>{agentTypeLabel(agent.type)} · {agent.provider ?? "internal"}</span>
      </div>
      <dl>
        <div><dt>排队</dt><dd>{status.queue.queued}</dd></div>
        <div><dt>运行中</dt><dd>{status.queue.running}</dd></div>
        <div><dt>待澄清</dt><dd>{status.queue.needsClarification}</dd></div>
        <div><dt>失败</dt><dd>{status.queue.failed}</dd></div>
      </dl>
      <p>{latestRun ? `最近一次：${latestRun.status} · ${formatTime(latestRun.startedAt)}` : "最近还没有运行记录。"}</p>
    </section>
  );
}

function BrainDisclosure({
  title,
  subtitle,
  open,
  onToggle,
  children
}: {
  title: string;
  subtitle: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <section className={open ? "brain-disclosure open" : "brain-disclosure"}>
      <button className="brain-disclosure-trigger" type="button" onClick={onToggle} aria-expanded={open}>
        <span className="brain-disclosure-icon"><BrainCircuit size={18} /></span>
        <span>
          <strong>{title}</strong>
          <small>{subtitle}</small>
        </span>
        <ChevronDown className="brain-disclosure-chevron" size={18} />
      </button>
      {open ? <div className="brain-disclosure-body">{children}</div> : null}
    </section>
  );
}

function agentTypeLabel(type: string) {
  const labels: Record<string, string> = {
    orchestrator: "主 Agent",
    universal: "通用 Agent",
    product: "产品 Agent",
    ui: "UI Agent",
    review: "审阅 Agent",
    code: "Code Agent"
  };
  return labels[type] ?? type;
}

function arrayRecords(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const record = asRecord(item);
    return record ? [record] : [];
  });
}

function OrchestratorAgentBrain() {
  return <OrchestratorGraph run={createInitialRun("orchestrator-agent-idle", "agent-detail", "等待 @orchestrator 唤醒")} />;
}

function ConversationInfoPanel({
  conversation,
  onOpenMember
}: {
  conversation: ConversationDetail;
  onOpenMember: (member: ConversationMemberProfile) => void;
}) {
  const users = conversation.members.filter((member) => member.type === "user");
  const agents = conversation.members.filter((member) => member.type === "agent");

  return (
    <div className="conversation-info-panel">
      <section className="conversation-topic-card">
        <h3>项目主题</h3>
        <p>{conversation.type === "project" ? conversationProjectTopic(conversation) : "单聊会话没有项目主题。"}</p>
      </section>
      <section className="conversation-members-card">
        <div className="conversation-info-heading">
          <h3>群聊成员</h3>
        </div>
        <details className="conversation-member-group" open>
          <summary className="conversation-member-summary">
            <span>用户</span>
            <em>{users.length}</em>
          </summary>
          <div className="conversation-member-list">
            {users.length > 0 ? users.map((member) => (
              <button key={`${member.type}-${member.id}-${member.role}`} type="button" className="conversation-member-row" onClick={() => onOpenMember(member)}>
                <AvatarMark kind="user" value={member.avatar} label={member.name} />
                <span>
                  <strong>{member.name}</strong>
                  <small>{member.subtitle ?? memberRoleLabel(member.role)}</small>
                </span>
                <b>{memberRoleLabel(member.role)}</b>
              </button>
            )) : <p className="conversation-empty-member">暂无用户成员</p>}
          </div>
        </details>
        <details className="conversation-member-group" open>
          <summary className="conversation-member-summary">
            <span>Agent</span>
            <em>{agents.length}</em>
          </summary>
          <div className="conversation-member-list">
            {agents.length > 0 ? agents.map((member) => (
              <button key={`${member.type}-${member.id}-${member.role}`} type="button" className="conversation-member-row" onClick={() => onOpenMember(member)}>
                <AvatarMark kind="agent" value={member.avatar} label={member.name} />
                <span>
                  <strong>{member.name}</strong>
                  <small>{member.subtitle ?? memberRoleLabel(member.role)}</small>
                </span>
                <b>{memberRoleLabel(member.role)}</b>
              </button>
            )) : <p className="conversation-empty-member">暂无 Agent 成员</p>}
          </div>
        </details>
      </section>
    </div>
  );
}

function PersonInfoPanel({ person }: { person: { id: string; type: "user" | "system"; name: string; avatar: string; subtitle?: string } }) {
  return (
    <div className="person-info-panel">
      <AvatarMark kind="user" size="xl" value={person.avatar} label={person.name} />
      <dl>
        <div><dt>名称</dt><dd>{person.name}</dd></div>
        <div><dt>类型</dt><dd>{person.type === "system" ? "系统" : "用户"}</dd></div>
        <div><dt>ID</dt><dd>{person.id}</dd></div>
        {person.subtitle ? <div><dt>说明</dt><dd>{person.subtitle}</dd></div> : null}
      </dl>
    </div>
  );
}

function conversationProjectTopic(conversation: ConversationDetail) {
  const core = conversation.projectCore ?? {};
  return stringField(core.goal)
    || stringField(core.userGoal)
    || stringField(core.initialMemory)
    || conversation.lastMessage
    || "暂未填写项目主题。";
}

function stringField(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function memberRoleLabel(role: string) {
  const labels: Record<string, string> = {
    owner: "群主",
    member: "成员",
    orchestrator: "主 Agent",
    code: "Code Agent",
    product: "产品 Agent",
    ui: "UI Agent",
    review: "审阅 Agent",
    universal: "通用 Agent"
  };
  return labels[role] ?? role;
}

function memberToPersonDetail(member: ConversationMemberProfile) {
  return {
    id: member.id,
    type: member.type === "system" ? "system" as const : "user" as const,
    name: member.name,
    avatar: member.avatar,
    ...(member.subtitle ? { subtitle: member.subtitle } : {})
  };
}

function InspectorHeader({ eyebrow, title, subtitle }: { eyebrow: string; title: string; subtitle?: string | undefined }) {
  return (
    <header className="inspector-header">
      {eyebrow ? <div className="panel-eyebrow">{eyebrow}</div> : null}
      <h2>{title}</h2>
      {subtitle ? <p>{subtitle}</p> : null}
    </header>
  );
}

function InspectorTabs<T extends string>({
  value,
  tabs,
  onChange
}: {
  value: T;
  tabs: Array<{ id: T; label: string }>;
  onChange: (value: T) => void;
}) {
  return (
    <div className="inspector-tabs" role="tablist">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          className={value === tab.id ? "active" : ""}
          type="button"
          role="tab"
          aria-selected={value === tab.id}
          onClick={() => onChange(tab.id)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

function RunMemoryPanel({ run }: { run: { runMeta?: unknown; lastIntegrate?: unknown; outputs?: unknown; currentNode: string } }) {
  return (
    <div className="inspector-stack">
      <RuntimeSection title="本轮上下文">
        <pre className="asset-text-preview">{JSON.stringify(run.runMeta ?? {}, null, 2)}</pre>
      </RuntimeSection>
      <RuntimeSection title="汇总与输出">
        <pre className="asset-text-preview">{JSON.stringify({ currentNode: run.currentNode, lastIntegrate: run.lastIntegrate, outputs: run.outputs }, null, 2)}</pre>
      </RuntimeSection>
    </div>
  );
}

function RunLogPanel({ run }: { run: { nodes?: unknown; edges?: unknown; workItems?: unknown; edgeHistory?: unknown; blockers?: unknown } }) {
  return (
    <div className="inspector-stack">
      <RuntimeSection title="节点和边">
        <pre className="asset-text-preview">{JSON.stringify({ nodes: run.nodes, edges: run.edges }, null, 2)}</pre>
      </RuntimeSection>
      <RuntimeSection title="工作项和边历史">
        <pre className="asset-text-preview">{JSON.stringify({ workItems: run.workItems, edgeHistory: run.edgeHistory, blockers: run.blockers }, null, 2)}</pre>
      </RuntimeSection>
    </div>
  );
}

function AgentRuntimePanel({ status }: { status: AgentRuntimeStatus }) {
  const userId = useAuthStore((state) => state.user?.id);
  const queryClient = useQueryClient();
  const showToast = useUiStore((state) => state.showToast);
  const activeRuns = status.recentAgentRuns.filter((run) => ["queued", "running", "needs_clarification"].includes(run.status));
  const recentErrors = status.recentAgentRuns.filter((run) => run.status === "failed").slice(0, 3);
  const refreshStatus = () => {
    if (userId) void queryClient.invalidateQueries({ queryKey: queryKeys.agentStatus(userId, status.agent.id) });
  };
  const approveTool = useMutation({
    mutationFn: (toolRunId: string) => api.approveAgentToolRun(status.agent.id, toolRunId),
    onSuccess: ({ result }) => {
      refreshStatus();
      showToast(result.status === "completed" ? "工具调用已批准并执行" : `工具调用结果：${result.status}`, result.status === "failed" ? "warning" : "success");
    },
    onError: (error) => {
      showToast(error instanceof Error ? error.message : "批准工具调用失败", "warning");
    }
  });
  const rejectTool = useMutation({
    mutationFn: (input: { toolRunId: string; reason?: string }) => api.rejectAgentToolRun(status.agent.id, input.toolRunId, input.reason),
    onSuccess: () => {
      refreshStatus();
      showToast("已拒绝工具调用", "success");
    },
    onError: (error) => {
      showToast(error instanceof Error ? error.message : "拒绝工具调用失败", "warning");
    }
  });
  return (
    <div className="agent-runtime-panel">
      <div className="agent-runtime-grid">
        <StatCell label="排队" value={status.queue.queued} />
        <StatCell label="运行中" value={status.queue.running} />
        <StatCell label="待澄清" value={status.queue.needsClarification} />
        <StatCell label="失败" value={status.queue.failed} />
      </div>
      <RuntimeSection title="当前锁 / 等待">
        {status.locks.length ? status.locks.map((lock) => (
          <div key={lock.runId} className="runtime-row">
            <strong>{lock.currentNode}</strong>
            <span>{lock.status}</span>
            <small>{compactUnknown(lock.waitingOn ?? lock.blockers)}</small>
          </div>
        )) : <p className="muted">暂无运行锁或等待项</p>}
      </RuntimeSection>
      <RuntimeSection title="当前工具调用">
        {status.currentToolRuns.length ? status.currentToolRuns.map((tool) => {
          const approval = tool.status === "queued" ? pendingApprovalInfo(tool.input) : null;
          return (
            <div key={tool.id} className={approval ? "runtime-row runtime-row-approval" : "runtime-row"}>
              <strong>{tool.toolId}</strong>
              <span>{approval ? "待审批" : tool.status}</span>
              <small>{approval?.reason || formatTime(tool.createdAt)}</small>
              {approval ? (
                <div className="runtime-actions">
                  <button
                    className="primary-button compact"
                    type="button"
                    disabled={approveTool.isPending || rejectTool.isPending}
                    onClick={() => approveTool.mutate(tool.id)}
                  >
                    批准
                  </button>
                  <button
                    className="secondary-button compact"
                    type="button"
                    disabled={approveTool.isPending || rejectTool.isPending}
                    onClick={() => rejectTool.mutate({ toolRunId: tool.id })}
                  >
                    拒绝
                  </button>
                </div>
              ) : null}
            </div>
          );
        }) : <p className="muted">暂无进行中的工具调用</p>}
      </RuntimeSection>
      <RuntimeSection title="子 Agent 输出">
        {activeRuns.length ? activeRuns.map((run) => (
          <div key={run.id} className="runtime-row">
            <strong>{run.status}</strong>
            <span>{run.runId ?? "direct"}</span>
            <small>{compactUnknown(run.output ?? run.input)}</small>
          </div>
        )) : <p className="muted">暂无活跃子 Agent 输出</p>}
      </RuntimeSection>
      {recentErrors.length ? (
        <RuntimeSection title="最近错误">
          {recentErrors.map((run) => (
            <pre key={run.id} className="runtime-error">{compactUnknown(run.output)}</pre>
          ))}
        </RuntimeSection>
      ) : null}
    </div>
  );
}

function RuntimeSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="runtime-section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

function StatCell({ label, value }: { label: string; value: number }) {
  return (
    <div className="agent-runtime-stat">
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function compactUnknown(value: unknown) {
  if (value === null || value === undefined || value === "") return "无";
  if (typeof value === "string") return value.length > 120 ? `${value.slice(0, 120)}...` : value;
  try {
    const text = JSON.stringify(value);
    return text.length > 120 ? `${text.slice(0, 120)}...` : text;
  } catch {
    return String(value);
  }
}

function pendingApprovalInfo(value: unknown) {
  const record = asRecord(value);
  const approval = asRecord(record?.approval);
  if (approval?.status !== "pending") return null;
  const reason = typeof approval.reason === "string" ? approval.reason : "";
  return { reason };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function formatTime(value: string | null | undefined) {
  if (!value) return "";
  return new Date(value).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

type WorkspaceAssetWithPreview = WorkspaceAsset & { content?: string };

function AssetPreview({ asset }: { asset: WorkspaceAssetWithPreview }) {
  const contentUrl = api.assetContentUrl(asset.workspaceId, asset.id);
  return <AssetRenderPreview file={asset} assetUrl={contentUrl} />;
}
