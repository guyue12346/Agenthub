import {
  Background,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps
} from "@xyflow/react";
import type { AgentRuntimeStatus } from "../api/client";

type UiNodeId = "wake" | "design" | "normalize" | "validate" | "revise" | "render" | "publish" | "memory";
type NodeStatus = "pending" | "running" | "completed" | "failed";
type Shape = "program" | "llm" | "ui";
type EdgeStatus = "pending" | "active" | "completed";

interface UiGraphNodeData extends Record<string, unknown> {
  label: string;
  caption: string;
  shape: Shape;
  status: NodeStatus;
  summary?: string;
  index: string;
}

type UiGraphNode = Node<UiGraphNodeData, "uiState">;

const uiGraphNodes: Array<{
  id: UiNodeId;
  label: string;
  caption: string;
  shape: Shape;
  position: { x: number; y: number };
}> = [
  { id: "wake", label: "接收任务", caption: "assignment / direct", shape: "program", position: { x: 290, y: 20 } },
  { id: "design", label: "设计生成", caption: "LLM 生成候选稿", shape: "llm", position: { x: 290, y: 145 } },
  { id: "normalize", label: "结构规范化", caption: "schema + 候选拆分", shape: "program", position: { x: 290, y: 285 } },
  { id: "validate", label: "设计校验", caption: "逐候选审阅", shape: "llm", position: { x: 290, y: 425 } },
  { id: "revise", label: "返工迭代", caption: "最多重写一次", shape: "llm", position: { x: 20, y: 425 } },
  { id: "render", label: "导出画布", caption: "PNG / SVG / Excalidraw", shape: "program", position: { x: 290, y: 570 } },
  { id: "publish", label: "群聊发布", caption: "消息 + 产物引用", shape: "ui", position: { x: 290, y: 710 } },
  { id: "memory", label: "记忆写入", caption: "简报 + asset 索引", shape: "program", position: { x: 290, y: 850 } }
];

const uiGraphEdges: Array<{
  id: string;
  source: UiNodeId;
  target: UiNodeId;
  label?: string;
  dashed?: boolean;
}> = [
  { id: "wake-design", source: "wake", target: "design", label: "1" },
  { id: "design-normalize", source: "design", target: "normalize", label: "2" },
  { id: "normalize-validate", source: "normalize", target: "validate", label: "3" },
  { id: "validate-revise", source: "validate", target: "revise", label: "返工", dashed: true },
  { id: "revise-validate", source: "revise", target: "validate", label: "复审", dashed: true },
  { id: "validate-render", source: "validate", target: "render", label: "4" },
  { id: "render-publish", source: "render", target: "publish", label: "5" },
  { id: "publish-memory", source: "publish", target: "memory", label: "6" }
];

export function UiAgentGraph({ status }: { status: AgentRuntimeStatus }) {
  const latestRun = latestAgentRun(status);
  const graphState = buildGraphState(status, latestRun);
  const nodeStatus = graphState.nodes;
  const edgeStatus = graphState.edges;

  const nodes: UiGraphNode[] = uiGraphNodes.map((node, index) => ({
    id: node.id,
    type: "uiState",
    position: node.position,
      data: {
        label: node.label,
        caption: node.caption,
        shape: node.shape,
        status: nodeStatus[node.id] ?? "pending",
        summary: nodeSummary(node.id, latestRun),
        index: String(index + 1).padStart(2, "0")
      },
      draggable: false
  }));

  const edges: Edge[] = uiGraphEdges.map((edge) => {
    const edgeState = edgeStatus[edge.id] ?? "pending";
    return {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      label: edge.label,
      type: "smoothstep",
      animated: edgeState === "active",
      markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
      className: `state-edge ${edgeState}${edge.dashed ? " dashed" : ""}`,
      labelClassName: "state-edge-label"
    };
  });

  return (
    <div className="ui-agent-status">
      <div className="graph-card ui-agent-graph-card" aria-label="UI Agent 状态机">
        <div className="graph-summary">
          <strong>{graphState.label}</strong>
          <span>{graphState.description}</span>
        </div>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={{ uiState: UiStateNode }}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          fitView
          fitViewOptions={{ padding: 0.18 }}
          minZoom={0.35}
          maxZoom={1.4}
        >
          <Background color="#e2e8f0" gap={18} size={1} />
        </ReactFlow>
      </div>
      <UiAgentDiagnostics status={status} latestRun={latestRun} />
    </div>
  );
}

function UiStateNode({ data }: NodeProps<UiGraphNode>) {
  return (
    <div className={`state-node ui-agent-node ${data.shape} ${data.status}`} title={data.summary}>
      <Handle type="target" position={Position.Top} className="state-handle" />
      <Handle type="target" position={Position.Left} className="state-handle" />
      <Handle type="source" position={Position.Right} className="state-handle" />
      <Handle type="source" position={Position.Bottom} className="state-handle" />
      <small>{data.index}</small>
      <span>{data.label}</span>
      <em>{data.caption}</em>
    </div>
  );
}

function UiAgentDiagnostics({
  status,
  latestRun
}: {
  status: AgentRuntimeStatus;
  latestRun: AgentRuntimeStatus["recentAgentRuns"][number] | undefined;
}) {
  const output = asRecord(latestRun?.output);
  const memoryPatch = asRecord(output?.memoryPatch);
  const candidates = asRecords(memoryPatch?.lastUiDesignCandidates);
  const assets = asRecords(output?.createdAssets);
  const failures = status.recentAgentRuns.filter((run) => run.status === "failed").slice(0, 3);
  const steps = extractUiAgentSteps(latestRun);

  return (
    <div className="run-diagnostics">
      <section className="run-diagnostic-section">
        <h3>最近运行</h3>
        {latestRun ? (
          <div className="run-diagnostic-row">
            <strong>{latestRun.status}</strong>
            <span>{formatTime(latestRun.startedAt)}</span>
            <p>{shortValue(output?.resultSummary ?? output?.publicMessage ?? latestRun.input, 180)}</p>
          </div>
        ) : (
          <p className="muted">暂无 UI Agent 运行记录</p>
        )}
      </section>
      <section className="run-diagnostic-section">
        <h3>节点轨迹</h3>
        {steps.length ? steps.slice(-10).map((step) => (
          <div key={String(step.id ?? `${step.step}-${step.at}`)} className="run-diagnostic-row">
            <strong>{String(step.step ?? "step")}</strong>
            <span>{String(step.status ?? "")}</span>
            <p>{String(step.summary ?? "")}</p>
          </div>
        )) : <p className="muted">暂无节点级轨迹</p>}
      </section>
      <section className="run-diagnostic-section">
        <h3>候选设计</h3>
        {candidates.length ? candidates.map((candidate) => (
          <div key={String(candidate.id ?? candidate.title)} className="run-diagnostic-row">
            <strong>{String(candidate.title ?? candidate.id ?? "candidate")}</strong>
            <span>{candidate.passed ? "通过" : "需返工"}</span>
            <p>{shortValue({ score: candidate.score, attempts: candidate.attempts, artifacts: candidate.artifactPaths }, 180)}</p>
          </div>
        )) : <p className="muted">暂无候选设计摘要</p>}
      </section>
      <section className="run-diagnostic-section">
        <h3>生成产物</h3>
        {assets.length ? assets.slice(0, 6).map((asset) => (
          <div key={String(asset.assetId ?? asset.path)} className="run-diagnostic-row">
            <strong>{String(asset.name ?? asset.path ?? "asset")}</strong>
            <span>{String(asset.mimeType ?? "")}</span>
            <p>{String(asset.path ?? asset.summary ?? "")}</p>
          </div>
        )) : <p className="muted">暂无导出的图片或设计文件</p>}
      </section>
      {failures.length ? (
        <section className="run-diagnostic-section">
          <h3>最近错误</h3>
          {failures.map((run) => (
            <pre key={run.id} className="runtime-error">{shortValue(run.output, 420)}</pre>
          ))}
        </section>
      ) : null}
    </div>
  );
}

function buildGraphState(
  status: AgentRuntimeStatus,
  latestRun: AgentRuntimeStatus["recentAgentRuns"][number] | undefined
) {
  const baseNodes = Object.fromEntries(uiGraphNodes.map((node) => [node.id, "pending" as NodeStatus])) as Record<UiNodeId, NodeStatus>;
  const baseEdges = Object.fromEntries(uiGraphEdges.map((edge) => [edge.id, "pending" as EdgeStatus])) as Record<string, EdgeStatus>;
  const steps = extractUiAgentSteps(latestRun);

  if (!latestRun) {
    return {
      label: "idle",
      description: "等待用户 @UI Agent 或 Orchestrator 调度",
      nodes: baseNodes,
      edges: baseEdges
    };
  }

  if (steps.length > 0) {
    applyStepTrace(baseNodes, baseEdges, steps);
    const latestStep = steps[steps.length - 1];
    return {
      label: latestRun.status,
      description: latestStep
        ? `${String(latestStep.step)}：${String(latestStep.summary ?? latestStep.status ?? "")}`
        : `最近运行：${latestRun.internalTraceRef ?? latestRun.id}`,
      nodes: baseNodes,
      edges: baseEdges
    };
  }

  if (latestRun.status === "queued") {
    baseNodes.wake = "running";
    return {
      label: "queued",
      description: "任务已进入 UI Agent 队列",
      nodes: baseNodes,
      edges: baseEdges
    };
  }

  if (latestRun.status === "running") {
    baseNodes.wake = "completed";
    baseNodes.design = "running";
    baseEdges["wake-design"] = "active";
    return {
      label: "running",
      description: "正在生成或校验 UI 设计稿",
      nodes: baseNodes,
      edges: baseEdges
    };
  }

  if (latestRun.status === "failed") {
    completeUntil(baseNodes, baseEdges, "design");
    baseNodes.validate = "failed";
    baseEdges["design-validate"] = "active";
    return {
      label: "failed",
      description: "UI Agent 运行失败，查看下方错误",
      nodes: baseNodes,
      edges: baseEdges
    };
  }

  const output = asRecord(latestRun.output);
  const memoryPatch = asRecord(output?.memoryPatch);
  const candidates = asRecords(memoryPatch?.lastUiDesignCandidates);
  const hasRevision = candidates.some((candidate) => Number(candidate.attempts ?? 1) > 1);
  const allPassed = candidates.length > 0 && candidates.every((candidate) => candidate.passed !== false);

  completeUntil(baseNodes, baseEdges, "memory");
  if (hasRevision) {
    baseNodes.revise = "completed";
    baseEdges["validate-revise"] = "completed";
    baseEdges["revise-validate"] = "completed";
  }
  if (latestRun.status === "needs_clarification" || !allPassed) {
    baseNodes.validate = "failed";
    baseEdges["validate-render"] = "pending";
    baseNodes.render = "pending";
    baseNodes.publish = "completed";
    baseNodes.memory = "completed";
    return {
      label: "needs clarification",
      description: "设计已输出，但仍有候选项需要用户确认或返工",
      nodes: baseNodes,
      edges: baseEdges
    };
  }

  return {
    label: latestRun.status,
    description: `最近运行：${latestRun.internalTraceRef ?? latestRun.id}`,
    nodes: baseNodes,
    edges: baseEdges
  };
}

function completeUntil(
  nodes: Record<UiNodeId, NodeStatus>,
  edges: Record<string, EdgeStatus>,
  target: UiNodeId
) {
  const order: UiNodeId[] = ["wake", "design", "normalize", "validate", "render", "publish", "memory"];
  const edgeOrder = ["wake-design", "design-normalize", "normalize-validate", "validate-render", "render-publish", "publish-memory"];
  const endIndex = order.indexOf(target);
  order.slice(0, endIndex + 1).forEach((id) => {
    nodes[id] = "completed";
  });
  edgeOrder.slice(0, Math.max(endIndex, 0)).forEach((id) => {
    edges[id] = "completed";
  });
}

function latestAgentRun(status: AgentRuntimeStatus) {
  return [...status.recentAgentRuns].sort((a, b) => {
    const left = Date.parse(a.startedAt || a.completedAt || "");
    const right = Date.parse(b.startedAt || b.completedAt || "");
    return right - left;
  })[0];
}

function nodeSummary(nodeId: UiNodeId, latestRun: AgentRuntimeStatus["recentAgentRuns"][number] | undefined) {
  if (!latestRun) return "暂无运行记录";
  const output = asRecord(latestRun.output);
  const memoryPatch = asRecord(output?.memoryPatch);
  if (nodeId === "design") return shortValue(memoryPatch?.lastUiDesignCandidates ?? output?.resultSummary, 180);
  if (nodeId === "normalize") return "把 LLM 输出规范化为稳定候选列表，供逐项校验和渲染使用";
  if (nodeId === "validate") return `状态：${latestRun.status}`;
  if (nodeId === "render") return shortValue(memoryPatch?.lastUiArtifactPaths ?? output?.createdAssets, 180);
  if (nodeId === "publish") return shortValue(output?.publicMessage, 180);
  if (nodeId === "memory") return shortValue(memoryPatch, 180);
  return latestRun.internalTraceRef ?? latestRun.id;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asRecords(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const record = asRecord(item);
    return record ? [record] : [];
  });
}

function shortValue(value: unknown, limit = 150) {
  if (value === null || value === undefined || value === "") return "无";
  if (typeof value === "string") return value.length > limit ? `${value.slice(0, limit)}...` : value;
  try {
    const text = JSON.stringify(value);
    return text.length > limit ? `${text.slice(0, limit)}...` : text;
  } catch {
    const text = String(value);
    return text.length > limit ? `${text.slice(0, limit)}...` : text;
  }
}

function applyStepTrace(
  nodes: Record<UiNodeId, NodeStatus>,
  edges: Record<string, EdgeStatus>,
  steps: Array<Record<string, unknown>>
) {
  const lastByStep = new Map<UiNodeId, Record<string, unknown>>();
  for (const step of steps) {
    const id = normalizeUiNodeId(step.step);
    if (!id) continue;
    lastByStep.set(id, step);
  }
  for (const [id, step] of lastByStep) {
    const status = String(step.status ?? "");
    nodes[id] = status === "failed" ? "failed" : status === "running" ? "running" : "completed";
  }
  const mainOrder: UiNodeId[] = ["wake", "design", "normalize", "validate", "render", "publish", "memory"];
  const completedSteps = new Set([...lastByStep.entries()]
    .filter(([, step]) => step.status === "completed")
    .map(([id]) => id));
  for (let index = 0; index < mainOrder.length - 1; index += 1) {
    const source = mainOrder[index]!;
    const target = mainOrder[index + 1]!;
    const edgeId = `${source}-${target}`;
    if (completedSteps.has(source) && (completedSteps.has(target) || nodes[target] === "running" || nodes[target] === "failed")) {
      edges[edgeId] = nodes[target] === "running" ? "active" : "completed";
    }
  }
  if (lastByStep.has("revise")) {
    nodes.revise = nodes.revise === "pending" ? "completed" : nodes.revise;
    edges["validate-revise"] = "completed";
    edges["revise-validate"] = nodes.validate === "running" ? "active" : "completed";
  }
}

function normalizeUiNodeId(value: unknown): UiNodeId | undefined {
  if (typeof value !== "string") return undefined;
  return uiGraphNodes.some((node) => node.id === value) ? value as UiNodeId : undefined;
}

function extractUiAgentSteps(latestRun: AgentRuntimeStatus["recentAgentRuns"][number] | undefined) {
  const eventSteps = latestRun?.stepEvents?.flatMap((event) => {
    const step = asRecord(asRecord(event.payload)?.step);
    return step ? [step] : [];
  }) ?? [];
  if (eventSteps.length > 0) return eventSteps;
  const output = asRecord(latestRun?.output);
  const memoryPatch = asRecord(output?.memoryPatch);
  return asRecords(memoryPatch?.uiAgentSteps);
}

function formatTime(value: string | null | undefined) {
  if (!value) return "";
  return new Date(value).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}
