import { z } from "zod";

const stringListSchema = z.preprocess((value) => {
  if (Array.isArray(value)) return value.map(readableString).filter(Boolean);
  if (typeof value === "string" && value.trim()) return value.split(/\n|；|;/).map((item) => item.trim()).filter(Boolean);
  const fallback = readableString(value);
  if (fallback) return [fallback];
  return [];
}, z.array(z.string()).default([]));

const uiAgentDesignCoreSchema = z.object({
  title: z.preprocess(stringishOrUndefined, z.string().min(1).default("UI 设计稿")),
  summary: z.preprocess(stringishOrUndefined, z.string().min(1).default("已生成界面设计草图。")),
  targetUsers: stringListSchema,
  designGoals: stringListSchema,
  screens: z.preprocess((value) => {
    if (!Array.isArray(value)) return [];
    return value;
  }, z.array(z.object({
    name: z.preprocess(stringishOrUndefined, z.string().min(1).default("主界面")),
    purpose: z.preprocess(stringishOrUndefined, z.string().min(1).default("承载核心用户流程")),
    layout: z.preprocess(stringishOrUndefined, z.string().min(1).default("响应式工作台布局")),
    sections: stringListSchema,
    interactions: stringListSchema
  })).default([])),
  visualStyle: z.object({
    tone: z.preprocess(stringishOrUndefined, z.string().default("清爽、专业、低干扰")),
    colors: stringListSchema,
    typography: z.preprocess(stringishOrUndefined, z.string().default("系统字体，清晰层级")),
    spacing: z.preprocess(stringishOrUndefined, z.string().default("紧凑但留有清晰分组"))
  }).default({
    tone: "清爽、专业、低干扰",
    colors: [],
    typography: "系统字体，清晰层级",
    spacing: "紧凑但留有清晰分组"
  }),
  acceptanceCriteria: stringListSchema,
  risks: stringListSchema,
  documentMarkdown: z.preprocess(stringishOrUndefined, z.string().optional())
});

export const uiAgentDesignCandidateSchema = uiAgentDesignCoreSchema.extend({
  id: z.preprocess(stringishOrUndefined, z.string().min(1).optional()),
  kind: z.preprocess(stringishOrUndefined, z.enum(["design", "implementation"]).default("design"))
});

export const uiAgentDesignSchema = uiAgentDesignCoreSchema.extend({
  variants: z.preprocess((value) => {
    if (!Array.isArray(value)) return [];
    return value;
  }, z.array(uiAgentDesignCandidateSchema).default([]))
});

export const uiAgentValidationSchema = z.object({
  targetId: z.preprocess(stringishOrUndefined, z.string().optional()),
  targetTitle: z.preprocess(stringishOrUndefined, z.string().optional()),
  passed: z.preprocess(booleanishOrUndefined, z.boolean().default(true)),
  score: z.preprocess(numberishOrUndefined, z.number().min(0).max(100).default(80)),
  findings: stringListSchema,
  revisionRequest: z.preprocess(stringishOrUndefined, z.string().optional()),
  publicMessage: z.preprocess(stringishOrUndefined, z.string().optional())
});

export type UiAgentDesign = z.infer<typeof uiAgentDesignSchema>;
export type UiAgentDesignCandidate = z.infer<typeof uiAgentDesignCandidateSchema>;
export type UiAgentValidation = z.infer<typeof uiAgentValidationSchema>;

function stringishOrUndefined(value: unknown) {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (value === null || value === undefined) return undefined;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  const fallback = readableString(value);
  if (fallback) return fallback;
  return undefined;
}

function readableString(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (!value || typeof value !== "object") return "";
  if (Array.isArray(value)) return value.map(readableString).filter(Boolean).join("，");
  const record = value as Record<string, unknown>;
  for (const key of ["title", "name", "label", "text", "value", "description", "summary", "purpose"]) {
    const text = readableString(record[key]);
    if (text) return text;
  }
  const pairs = Object.entries(record)
    .map(([key, item]) => {
      const text = readableString(item);
      return text ? `${key}: ${text}` : "";
    })
    .filter(Boolean);
  return pairs.join("；");
}

function booleanishOrUndefined(value: unknown) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "yes", "y", "1", "通过", "是"].includes(normalized)) return true;
    if (["false", "no", "n", "0", "不通过", "否"].includes(normalized)) return false;
  }
  return undefined;
}

function numberishOrUndefined(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}
