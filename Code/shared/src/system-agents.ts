import type { AgentDefinition } from "./domain";

export const hiddenSystemAgentIds = ["agent-orchestrator", "agent-universal"] as const;

export type HiddenSystemAgentId = (typeof hiddenSystemAgentIds)[number];

const hiddenSystemAgentIdSet = new Set<string>(hiddenSystemAgentIds);

export function isHiddenSystemAgentId(agentId: string | null | undefined): agentId is HiddenSystemAgentId {
  return typeof agentId === "string" && hiddenSystemAgentIdSet.has(agentId);
}

export function isUserVisibleAgent(agent: Pick<AgentDefinition, "id" | "type">) {
  return agent.type !== "orchestrator" && !isHiddenSystemAgentId(agent.id);
}
