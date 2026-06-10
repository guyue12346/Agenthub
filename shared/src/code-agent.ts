import { z } from "zod";

export const codeAgentEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("session_started"),
    provider: z.enum(["codex", "opencode"]),
    sessionId: z.string(),
    at: z.string()
  }),
  z.object({
    type: z.literal("message_delta"),
    text: z.string(),
    at: z.string()
  }),
  z.object({
    type: z.literal("message"),
    text: z.string(),
    at: z.string()
  }),
  z.object({
    type: z.literal("command_run"),
    command: z.string(),
    status: z.enum(["started", "completed", "failed"]).default("completed"),
    at: z.string()
  }),
  z.object({
    type: z.literal("file_edit"),
    path: z.string(),
    additions: z.number().int().nonnegative().optional(),
    deletions: z.number().int().nonnegative().optional(),
    at: z.string()
  }),
  z.object({
    type: z.literal("status"),
    status: z.enum(["queued", "running", "completed", "failed", "cancelled", "timed_out"]),
    message: z.string().optional(),
    progress: z.number().min(0).max(1).optional(),
    at: z.string()
  }),
  z.object({
    type: z.literal("error"),
    message: z.string(),
    at: z.string()
  })
]);

export type CodeAgentEvent = z.infer<typeof codeAgentEventSchema>;

export const codeAgentChangedFileSchema = z.object({
  path: z.string(),
  additions: z.number().int().nonnegative().default(0),
  deletions: z.number().int().nonnegative().default(0)
});

export type CodeAgentChangedFile = z.infer<typeof codeAgentChangedFileSchema>;

export const codeAgentRunResultSchema = z.object({
  provider: z.enum(["codex", "opencode"]),
  requestedProvider: z.enum(["codex", "opencode"]).optional(),
  sessionId: z.string().optional(),
  finalMessage: z.string(),
  changedFiles: z.array(codeAgentChangedFileSchema).default([]),
  diffText: z.string().optional(),
  exitCode: z.number().int().nullable(),
  timedOut: z.boolean().optional(),
  cancelled: z.boolean().optional()
});

export type CodeAgentRunResult = z.infer<typeof codeAgentRunResultSchema>;
