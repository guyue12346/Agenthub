import { Inject, Injectable, Optional } from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";
import { PrismaService } from "../../common/prisma.service.js";

const WORKSPACE_LOCK_LEASE_MS = 15 * 60_000;
const WORKSPACE_LOCK_HEARTBEAT_MS = 15_000;
const WORKSPACE_LOCK_POLL_MS = 250;
const WORKSPACE_LOCK_TIMEOUT_MS = 15 * 60_000;

@Injectable()
export class CodeAgentWorkspaceLockService {
  private readonly workspaceLocks = new Map<string, Promise<unknown>>();
  private readonly lockOwnerId = `code-agent-${process.pid}-${randomUUID()}`;

  constructor(
    @Optional()
    @Inject(PrismaService)
    private readonly prisma?: PrismaService
  ) {}

  async withWorkspaceLock<T>(workspaceRoot: string, run: () => Promise<T>) {
    if (this.prisma) return this.withPersistentWorkspaceLock(workspaceRoot, run);
    return this.withInMemoryWorkspaceLock(workspaceRoot, run);
  }

  private async withInMemoryWorkspaceLock<T>(workspaceRoot: string, run: () => Promise<T>) {
    const lockKey = resolve(workspaceRoot);
    const previous = this.workspaceLocks.get(lockKey) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const current = new Promise<void>((resolveLock) => {
      release = resolveLock;
    });
    const lockPromise = previous.then(() => current);
    this.workspaceLocks.set(lockKey, lockPromise);
    await previous.catch(() => undefined);
    try {
      return await run();
    } finally {
      release();
      if (this.workspaceLocks.get(lockKey) === lockPromise) this.workspaceLocks.delete(lockKey);
    }
  }

  private async withPersistentWorkspaceLock<T>(workspaceRoot: string, run: () => Promise<T>) {
    const prisma = this.prisma!;
    const lockKey = await this.acquirePersistentWorkspaceLock(workspaceRoot);
    const heartbeat = setInterval(() => {
      void prisma.runtimeLock.updateMany({
        where: { key: lockKey, ownerId: this.lockOwnerId },
        data: {
          heartbeatAt: new Date(),
          expiresAt: new Date(Date.now() + WORKSPACE_LOCK_LEASE_MS)
        }
      });
    }, WORKSPACE_LOCK_HEARTBEAT_MS);
    try {
      return await run();
    } finally {
      clearInterval(heartbeat);
      await prisma.runtimeLock.deleteMany({ where: { key: lockKey, ownerId: this.lockOwnerId } });
    }
  }

  private async acquirePersistentWorkspaceLock(workspaceRoot: string) {
    const prisma = this.prisma!;
    const lockKey = workspaceLockKey(workspaceRoot);
    const startedAt = Date.now();
    for (;;) {
      const now = new Date();
      const expiresAt = new Date(now.getTime() + WORKSPACE_LOCK_LEASE_MS);
      try {
        await prisma.runtimeLock.create({
          data: {
            key: lockKey,
            ownerId: this.lockOwnerId,
            resourceType: "workspace",
            resourceId: workspaceRoot,
            expiresAt,
            heartbeatAt: now
          }
        });
        return lockKey;
      } catch (error) {
        if (!isUniqueConstraintError(error)) throw error;
      }
      const claimed = await prisma.runtimeLock.updateMany({
        where: {
          key: lockKey,
          OR: [
            { ownerId: this.lockOwnerId },
            { expiresAt: { lt: now } }
          ]
        },
        data: {
          ownerId: this.lockOwnerId,
          resourceType: "workspace",
          resourceId: workspaceRoot,
          expiresAt,
          heartbeatAt: now
        }
      });
      if (claimed.count === 1) return lockKey;
      if (Date.now() - startedAt > WORKSPACE_LOCK_TIMEOUT_MS) {
        throw new Error(`Timed out waiting for Code Agent workspace lock: ${workspaceRoot}`);
      }
      await delay(WORKSPACE_LOCK_POLL_MS);
    }
  }
}

export function workspaceLockKey(workspaceRoot: string) {
  return `workspace:${createHash("sha256").update(resolve(workspaceRoot)).digest("base64url").slice(0, 48)}`;
}

export function assertRelativePathIsInsideBase(baseRoot: string, workspaceRoot: string) {
  const pathFromBase = relative(baseRoot, workspaceRoot);
  if (pathFromBase.startsWith("..") || isAbsolute(pathFromBase)) {
    throw new Error(`Workspace root is outside AgentHub workspace root: ${workspaceRoot}`);
  }
}

function isUniqueConstraintError(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "P2002");
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
