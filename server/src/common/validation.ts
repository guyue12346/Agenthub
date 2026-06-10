import { BadRequestException } from "@nestjs/common";
import { z } from "zod";

export function parseBody<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  return parseSchema(schema, value);
}

export function parseQuery<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  return parseSchema(schema, value ?? {});
}

function parseSchema<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new BadRequestException(parsed.error.issues.map((issue) => `${issue.path.join(".") || "value"}: ${issue.message}`));
}

export const cuidLikeSchema = z.string().trim().min(1).max(128);
export const messageTextSchema = z.string().trim().min(1, "消息不能为空").max(20000, "消息不能超过 20000 字");
export const dangerousConfirmationSchema = z.object({
  confirm: z.string().trim().min(1).max(240)
});

export function assertDangerousConfirmation(actual: string, expected: string) {
  if (actual !== expected) throw new BadRequestException("危险操作确认内容不匹配");
}
