import type { OrchestratorNode, OrchestratorRun } from "@agenthub/shared";
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
import "@xyflow/react/dist/style.css";

type GraphNodeId =
  | OrchestratorNode
  | "ui_query"
  | "ui_notification"
  | "ui_brief"
  | "context_manage"
  | "compact";

type Shape = "program" | "ui" | "llm" | "assignment";

interface GraphNodeData extends Record<string, unknown> {
  label: string;
  shape: Shape;
  status: "pending" | "running" | "completed" | "failed";
  summary?: string;
}

type StateNode = Node<GraphNodeData, "state">;

const graphNodes: Array<{
  id: GraphNodeId;
  label: string;
  shape: Shape;
  position: { x: number; y: number };
}> = [
  { id: "wake", label: "wake", shape: "program", position: { x: 390, y: 10 } },
  { id: "understand", label: "understand", shape: "llm", position: { x: 350, y: 110 } },
  { id: "ui_query", label: "ui query", shape: "ui", position: { x: 610, y: 105 } },
  { id: "tools", label: "Tools", shape: "program", position: { x: 620, y: 235 } },
  { id: "decompose", label: "decompose", shape: "llm", position: { x: 350, y: 310 } },
  { id: "assignment", label: "agents assignment", shape: "assignment", position: { x: 185, y: 455 } },
  { id: "ui_notification", label: "ui notification", shape: "ui", position: { x: 650, y: 495 } },
  { id: "validate", label: "validate", shape: "llm", position: { x: 350, y: 650 } },
  { id: "integrate", label: "integrate", shape: "llm", position: { x: 350, y: 820 } },
  { id: "ui_brief", label: "ui brief", shape: "ui", position: { x: 610, y: 815 } },
  { id: "summary", label: "summary", shape: "llm", position: { x: 165, y: 820 } },
  { id: "memory_manage", label: "memory manage", shape: "program", position: { x: -15, y: 820 } },
  { id: "context_manage", label: "context manage", shape: "program", position: { x: 0, y: 455 } },
  { id: "compact", label: "compact", shape: "llm", position: { x: 45, y: 560 } }
];

const graphEdges: Array<{
  id: string;
  source: GraphNodeId;
  target: GraphNodeId;
  label?: string;
  animated?: boolean;
  dashed?: boolean;
}> = [
  { id: "wake-understand", source: "wake", target: "understand", label: "1" },
  { id: "understand-ui-query", source: "understand", target: "ui_query", label: "2" },
  { id: "understand-tools", source: "understand", target: "tools", label: "3" },
  { id: "tools-understand", source: "tools", target: "understand", label: "3R", dashed: true },
  { id: "understand-decompose", source: "understand", target: "decompose", label: "4" },
  { id: "decompose-assignment", source: "decompose", target: "assignment", label: "5" },
  { id: "assignment-validate", source: "assignment", target: "validate", label: "6" },
  { id: "assignment-ui-notification", source: "assignment", target: "ui_notification", label: "7" },
  { id: "validate-decompose", source: "validate", target: "decompose", label: "8", dashed: true },
  { id: "validate-integrate", source: "validate", target: "integrate", label: "9" },
  { id: "understand-integrate", source: "understand", target: "integrate", label: "query direct", dashed: true },
  { id: "integrate-ui-brief", source: "integrate", target: "ui_brief" },
  { id: "integrate-summary", source: "integrate", target: "summary", label: "10" },
  { id: "summary-memory_manage", source: "summary", target: "memory_manage" },
  { id: "context-compact", source: "context_manage", target: "compact", label: "1-10", dashed: true }
];

export function OrchestratorGraph({ run }: { run: OrchestratorRun }) {
  const isIdleRun = run.id === "orchestrator-idle";
  const nodeStatus = new Map(run.nodes.map((node) => [node.id, node.status]));
  const nodeSummary = new Map(run.nodes.map((node) => [node.id, node.summary]));
  const runEdgeStatus = new Map(run.edges.map((edge) => [`${edge.source}-${edge.target}`, edge.status]));

  const nodes: StateNode[] = graphNodes.map((node) => ({
    id: node.id,
    type: "state",
    position: node.position,
    data: {
      label: node.label,
      shape: node.shape,
      status: nodeStatus.get(node.id as OrchestratorNode) ?? "pending",
      summary: nodeSummary.get(node.id as OrchestratorNode) ?? ""
    },
    draggable: false
  }));

  const edges: Edge[] = graphEdges.map((edge) => {
    const status = runEdgeStatus.get(edge.id) ?? "pending";
    return {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      label: edge.label,
      type: "smoothstep",
      animated: edge.animated || status === "active",
      markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
      className: `state-edge ${status}${edge.dashed ? " dashed" : ""}`,
      labelClassName: "state-edge-label"
    };
  });

  return (
    <>
      <div className="graph-card" aria-label="Orchestrator 状态机">
        <div className="graph-summary">
          <strong>{isIdleRun ? "idle" : run.status}</strong>
          <span>{isIdleRun ? "等待 @orchestrator 唤醒" : `当前节点：${run.currentNode}`}</span>
        </div>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={{ state: StateMachineNode }}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          fitView
          fitViewOptions={{ padding: 0.2 }}
          minZoom={0.35}
          maxZoom={1.4}
        >
          <Background color="#e2e8f0" gap={18} size={1} />
        </ReactFlow>
      </div>
      <RunDiagnostics run={run} />
    </>
  );
}

function RunDiagnostics({ run }: { run: OrchestratorRun }) {
  const workItems = asRecords(run.workItems);
  const toolRuns = asRecords(run.toolRuns);
  const pendingToolRequests = asRecords(run.runMeta?.pendingToolRequests);
  const agentRuns = asRecords(run.agentRuns);
  const edgeHistory = asRecords(run.edgeHistory);
  const blockers = asRecords(run.blockers);
  const outputs = asRecords(run.outputs);
  const failures = [
    ...toolRuns.filter((item) => item.status === "failed" || item.error),
    ...agentRuns.filter((item) => item.status === "failed" || asRecord(item.output)?.error),
    ...blockers
  ];
  return (
    <div className="run-diagnostics">
      <section className="run-diagnostic-section">
        <h3>队列</h3>
        <div className="run-diagnostic-stats">
          <Metric label="待执行" value={countStatus(workItems, "pending")} />
          <Metric label="运行中" value={countStatus(workItems, "running")} />
          <Metric label="已完成" value={countStatus(workItems, "completed") + countStatus(workItems, "validated")} />
          <Metric label="失败" value={countStatus(workItems, "failed")} />
        </div>
        {workItems.slice(0, 5).map((item) => (
          <DiagnosticRow
            key={String(item.workItemId ?? item.agentId ?? JSON.stringify(item).slice(0, 24))}
            title={String(item.title ?? item.agentId ?? item.workItemId ?? "work item")}
            meta={String(item.status ?? "pending")}
            detail={shortValue(item.objective ?? item.task ?? item)}
          />
        ))}
        {workItems.length === 0 ? <p className="muted">暂无子任务队列</p> : null}
      </section>
      <section className="run-diagnostic-section">
        <h3>锁 / 等待</h3>
        {run.waitingOn ? <DiagnosticRow title="waitingOn" meta={run.status} detail={shortValue(run.waitingOn)} /> : null}
        {blockers.map((blocker, index) => (
          <DiagnosticRow key={index} title={String(blocker.type ?? "blocker")} meta={String(blocker.at ?? "")} detail={shortValue(blocker)} />
        ))}
        {!run.waitingOn && blockers.length === 0 ? <p className="muted">暂无等待或阻塞</p> : null}
      </section>
      <section className="run-diagnostic-section">
        <h3>当前工具调用</h3>
        {pendingToolRequests.map((request, index) => (
          <DiagnosticRow key={`pending-${index}`} title={String(request.toolId ?? "pending tool")} meta="pending" detail={shortValue(request.reason ?? request.input ?? request)} />
        ))}
        {toolRuns.slice(-6).map((tool) => (
          <DiagnosticRow
            key={String(tool.toolRunId ?? tool.id ?? tool.toolId)}
            title={String(tool.toolId ?? "tool")}
            meta={String(tool.status ?? "unknown")}
            detail={shortValue(tool.error ?? tool.output ?? tool.input)}
          />
        ))}
        {pendingToolRequests.length === 0 && toolRuns.length === 0 ? <p className="muted">暂无工具调用</p> : null}
      </section>
      <section className="run-diagnostic-section">
        <h3>子 Agent 输出</h3>
        {agentRuns.slice(-6).map((agentRun) => (
          <DiagnosticRow
            key={String(agentRun.agentRunId ?? agentRun.id ?? agentRun.workItemId)}
            title={String(agentRun.agentId ?? agentRun.workItemId ?? "agent")}
            meta={String(agentRun.status ?? "unknown")}
            detail={shortValue(agentRun.resultSummary ?? agentRun.output ?? agentRun.outputMessageId)}
          />
        ))}
        {agentRuns.length === 0 ? <p className="muted">暂无子 Agent 输出</p> : null}
      </section>
      <section className="run-diagnostic-section">
        <h3>边历史</h3>
        {edgeHistory.slice(-8).map((edge, index) => (
          <DiagnosticRow
            key={`${edge.source ?? "edge"}-${edge.target ?? index}-${edge.at ?? index}`}
            title={`${String(edge.source ?? "?")} -> ${String(edge.target ?? "?")}`}
            meta={String(edge.chain ?? edge.at ?? "")}
            detail={shortValue(edge.reason ?? edge.payload)}
          />
        ))}
        {edgeHistory.length === 0 ? <p className="muted">暂无边历史</p> : null}
      </section>
      <section className="run-diagnostic-section">
        <h3>记忆注入摘要</h3>
        <DiagnosticRow title="runMeta" meta={run.currentNode} detail={memorySummary(run, outputs)} />
      </section>
      {failures.length > 0 ? (
        <section className="run-diagnostic-section">
          <h3>错误栈</h3>
          {failures.slice(-4).map((failure, index) => (
            <pre key={index} className="runtime-error">{shortValue(failure, 420)}</pre>
          ))}
        </section>
      ) : null}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function DiagnosticRow({ title, meta, detail }: { title: string; meta: string; detail: string }) {
  return (
    <div className="run-diagnostic-row">
      <strong>{title}</strong>
      <span>{meta}</span>
      <p>{detail}</p>
    </div>
  );
}

function StateMachineNode({ data }: NodeProps<StateNode>) {
  return (
    <div className={`state-node ${data.shape} ${data.status}`} title={data.summary}>
      <Handle type="target" position={Position.Top} className="state-handle" />
      <Handle type="target" position={Position.Left} className="state-handle" />
      <Handle type="source" position={Position.Right} className="state-handle" />
      <Handle type="source" position={Position.Bottom} className="state-handle" />
      {data.shape === "assignment" ? (
        <div className="assignment-node">
          <strong>{data.label}</strong>
          <div>
            <span>兜底执行</span>
            <span>Code Agent</span>
            <span>Agents</span>
            <small>Tools</small>
          </div>
        </div>
      ) : (
        <span>{data.label}</span>
      )}
    </div>
  );
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

function countStatus(items: Array<Record<string, unknown>>, status: string) {
  return items.filter((item) => item.status === status).length;
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

function memorySummary(run: OrchestratorRun, outputs: Array<Record<string, unknown>>) {
  const metaKeys = Object.keys(run.runMeta ?? {});
  const lastOutput = outputs.at(-1);
  const integrate = asRecord(run.lastIntegrate);
  const pieces = [
    metaKeys.length ? `runMeta: ${metaKeys.join(", ")}` : "runMeta: empty",
    integrate?.runBrief ? `brief: ${shortValue(integrate.runBrief, 80)}` : "",
    lastOutput?.publicMessage ? `last output: ${shortValue(lastOutput.publicMessage, 80)}` : ""
  ].filter(Boolean);
  return pieces.join(" · ");
}
