import type { OrchestratorNode, OrchestratorRun } from "./domain";

export const ORCHESTRATOR_NODES: Array<{ id: OrchestratorNode; label: string }> = [
  { id: "wake", label: "Wake" },
  { id: "understand", label: "Understand" },
  { id: "ui_query", label: "UI Query" },
  { id: "tools", label: "Tools" },
  { id: "decompose", label: "Decompose" },
  { id: "assignment", label: "Assignment" },
  { id: "validate", label: "Validate" },
  { id: "integrate", label: "Integrate" },
  { id: "summary", label: "Summary" },
  { id: "memory_manage", label: "Memory" }
];

export const ORCHESTRATOR_EDGES = [
  ["wake", "understand", "1"],
  ["understand", "ui_query", "2"],
  ["ui_query", "understand", "2R"],
  ["understand", "tools", "3"],
  ["tools", "understand", "3R"],
  ["understand", "decompose", "4"],
  ["decompose", "assignment", "5"],
  ["assignment", "validate", "6"],
  ["validate", "assignment", "7R"],
  ["validate", "decompose", "8"],
  ["validate", "understand", "8R"],
  ["validate", "integrate", "9"],
  ["understand", "integrate", "direct"],
  ["integrate", "summary", "10"],
  ["summary", "memory_manage", "10M"]
] as const;

export function createInitialRun(id: string, conversationId: string, goal: string): OrchestratorRun {
  return {
    id,
    conversationId,
    status: "running",
    currentNode: "wake",
    goal,
    startedAt: new Date().toISOString(),
    nodes: ORCHESTRATOR_NODES.map((node) => ({
      ...node,
      status: node.id === "wake" ? "running" : "pending"
    })),
    edges: ORCHESTRATOR_EDGES.map(([source, target, label]) => ({
      id: `${source}-${target}`,
      source,
      target,
      label,
      status: "pending"
    }))
  };
}

export function advanceRun(run: OrchestratorRun, nextNode: OrchestratorNode, summary: string): OrchestratorRun {
  const previousNode = run.currentNode;
  const nextRun: OrchestratorRun = {
    ...run,
    currentNode: nextNode,
    status: nextNode === "memory_manage" ? "completed" : "running",
    nodes: run.nodes.map((node) => {
      if (node.id === previousNode) return { ...node, status: "completed", summary };
      if (node.id === nextNode) return { ...node, status: "running" };
      return node;
    }),
    edges: run.edges.map((edge) => {
      if (edge.source === previousNode && edge.target === nextNode) return { ...edge, status: "completed" };
      return edge;
    })
  };
  if (nextNode === "memory_manage") {
    nextRun.completedAt = new Date().toISOString();
  }
  return nextRun;
}
