import { z } from "zod";

export const messageBlockTypeSchema = z.enum([
  "markdown",
  "code",
  "image",
  "file",
  "web_preview",
  "diff",
  "agent_status",
  "deploy_status"
]);

export type MessageBlockType = z.infer<typeof messageBlockTypeSchema>;

const baseBlockSchema = z.object({
  blockId: z.string().min(1),
  schemaVersion: z.literal(1)
});

export const markdownBlockSchema = baseBlockSchema.extend({
  type: z.literal("markdown"),
  payload: z.object({
    text: z.string()
  })
});

export const codeBlockSchema = baseBlockSchema.extend({
  type: z.literal("code"),
  payload: z.object({
    language: z.string().default("text"),
    filename: z.string().optional(),
    code: z.string()
  })
});

export const imageBlockSchema = baseBlockSchema.extend({
  type: z.literal("image"),
  payload: z.object({
    assetId: z.string(),
    alt: z.string().optional(),
    thumbnailUrl: z.string().optional(),
    previewUrl: z.string().optional()
  })
});

export const fileBlockSchema = baseBlockSchema.extend({
  type: z.literal("file"),
  payload: z.object({
    assetId: z.string(),
    name: z.string(),
    path: z.string().optional(),
    mimeType: z.string(),
    size: z.number().nonnegative().optional(),
    summary: z.string().optional()
  })
});

export const webPreviewBlockSchema = baseBlockSchema.extend({
  type: z.literal("web_preview"),
  payload: z.object({
    assetId: z.string().optional(),
    title: z.string(),
    url: z.string(),
    screenshotAssetId: z.string().optional(),
    status: z.enum(["starting", "ready", "failed"]).default("ready")
  })
});

export const diffBlockSchema = baseBlockSchema.extend({
  type: z.literal("diff"),
  payload: z.object({
    diffAssetId: z.string(),
    reviewProposalId: z.string().optional(),
    reviewKind: z.enum(["manual", "code_task"]).optional(),
    title: z.string(),
    files: z.array(
      z.object({
        path: z.string(),
        additions: z.number().int().nonnegative(),
        deletions: z.number().int().nonnegative(),
        expanded: z.boolean().default(false),
        hunks: z
          .array(
            z.object({
              header: z.string(),
              lines: z.array(
                z.object({
                  kind: z.enum(["context", "add", "delete"]),
                  oldLine: z.number().int().positive().optional(),
                  newLine: z.number().int().positive().optional(),
                  content: z.string()
                })
              )
            })
          )
          .default([])
      })
    ),
    reviewState: z.enum(["pending", "approved", "changes_requested"]).default("pending")
  })
});

export const agentStatusBlockSchema = baseBlockSchema.extend({
  type: z.literal("agent_status"),
  payload: z.object({
    subtype: z.enum(["agent_run", "code_task", "tool_run"]),
    targetId: z.string(),
    title: z.string(),
    status: z.enum([
      "queued",
      "running",
      "waiting_user",
      "waiting_agent",
      "waiting_tool",
      "completed",
      "failed",
      "cancelled",
      "waiting_review",
      "revision_requested",
      "merged"
    ]),
    summary: z.string().optional(),
    progress: z.number().min(0).max(1).optional()
  })
});

export const deployStatusBlockSchema = baseBlockSchema.extend({
  type: z.literal("deploy_status"),
  payload: z.object({
    deploymentId: z.string().optional(),
    target: z.enum(["static_preview", "source_package"]).optional(),
    status: z.enum(["queued", "building", "ready", "failed", "cancelled"]),
    title: z.string(),
    previewUrl: z.string().optional(),
    detail: z.string().optional(),
    logAssetId: z.string().optional(),
    artifactAssetId: z.string().optional(),
    error: z.string().optional()
  })
});

export const messageBlockSchema = z.discriminatedUnion("type", [
  markdownBlockSchema,
  codeBlockSchema,
  imageBlockSchema,
  fileBlockSchema,
  webPreviewBlockSchema,
  diffBlockSchema,
  agentStatusBlockSchema,
  deployStatusBlockSchema
]);

export const messageBlocksSchema = z.array(messageBlockSchema).min(1);

export type MessageBlock = z.infer<typeof messageBlockSchema>;

export function createMarkdownBlock(blockId: string, text: string): MessageBlock {
  return markdownBlockSchema.parse({
    blockId,
    schemaVersion: 1,
    type: "markdown",
    payload: { text }
  });
}

export function validateMessageBlocks(blocks: unknown): MessageBlock[] {
  return messageBlocksSchema.parse(blocks);
}
