import { Inject, Injectable } from "@nestjs/common";
import { Prisma } from "../generated/prisma/client.js";
import { PrismaService } from "./prisma.service.js";

interface AuditInput {
  actorUserId?: string | undefined;
  action: string;
  targetType: string;
  targetId: string;
  payload?: Record<string, unknown> | undefined;
}

interface SystemLogInput {
  level: "debug" | "info" | "warn" | "error";
  scope: string;
  message: string;
  payload?: Record<string, unknown> | undefined;
  traceId?: string | undefined;
}

interface LlmCallLogInput {
  provider: string;
  model: string;
  callerType: string;
  callerId: string;
  promptRef?: string | undefined;
  responseRef?: string | undefined;
  tokenUsage?: Record<string, unknown> | undefined;
  latencyMs?: number | undefined;
  status: "started" | "completed" | "failed";
  error?: string | undefined;
}

@Injectable()
export class ObservabilityService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async audit(input: AuditInput) {
    await this.safeWrite(() =>
      this.prisma.auditLog.create({
        data: {
          action: input.action,
          targetType: input.targetType,
          targetId: input.targetId,
          payload: (input.payload ?? {}) as Prisma.InputJsonValue,
          ...(input.actorUserId ? { user: { connect: { id: input.actorUserId } } } : {})
        }
      })
    );
  }

  async system(input: SystemLogInput) {
    await this.safeWrite(() =>
      this.prisma.systemLog.create({
        data: {
          level: input.level,
          scope: input.scope,
          message: input.message,
          payload: (input.payload ?? {}) as Prisma.InputJsonValue,
          traceId: input.traceId ?? null
        }
      })
    );
  }

  async llmCall(input: LlmCallLogInput) {
    await this.safeWrite(() =>
      this.prisma.llmCallLog.create({
        data: {
          provider: input.provider,
          model: input.model,
          callerType: input.callerType,
          callerId: input.callerId,
          promptRef: input.promptRef ?? null,
          responseRef: input.responseRef ?? null,
          tokenUsage: (input.tokenUsage ?? {}) as Prisma.InputJsonValue,
          latencyMs: input.latencyMs ?? null,
          status: input.status,
          error: input.error ?? null
        }
      })
    );
  }

  private async safeWrite(write: () => Promise<unknown>) {
    try {
      await write();
    } catch {
      // Observability must never break the user-facing business request.
    }
  }
}
