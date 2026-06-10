import { z } from "zod";

export const runtimeEventTypeSchema = z.enum([
  "message.created",
  "message.updated",
  "conversation.updated",
  "conversation.read",
  "messages.cleared",
  "message.action.created",
  "message.action.deleted",
  "workspace.asset.created",
  "workspace.file.changed",
  "workspace.preview.updated",
  "run.started",
  "run.updated",
  "run.node.started",
  "run.node.finished",
  "run.transitioned",
  "run.waiting_user",
  "run.completed",
  "run.failed",
  "agent_run.started",
  "agent_run.message",
  "agent_run.step.started",
  "agent_run.step.completed",
  "agent_run.step.failed",
  "agent_run.waiting_tool_approval",
  "agent_run.completed",
  "agent_run.failed",
  "tool_run.started",
  "tool_run.completed",
  "tool_run.failed"
]);

export type RuntimeEventType = z.infer<typeof runtimeEventTypeSchema>;

export const runtimeScopeKindSchema = z.enum(["conversation", "user", "workspace", "run", "agent_run"]);
export type RuntimeScopeKind = z.infer<typeof runtimeScopeKindSchema>;

export const runtimeEventSchema = z.object({
  eventId: z.string(),
  scopeKind: runtimeScopeKindSchema,
  scopeId: z.string(),
  seq: z.number().int().positive(),
  type: runtimeEventTypeSchema,
  actor: z.object({
    type: z.enum(["user", "agent", "system"]),
    id: z.string(),
    name: z.string()
  }),
  payload: z.record(z.string(), z.unknown()),
  traceId: z.string(),
  createdAt: z.string()
});

export type RuntimeEvent = z.infer<typeof runtimeEventSchema>;

export function eventKey(event: RuntimeEvent): string {
  return `${event.scopeKind}:${event.scopeId}:${event.seq}:${event.eventId}`;
}
