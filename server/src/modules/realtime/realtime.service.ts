import { Inject, Injectable, OnModuleDestroy } from "@nestjs/common";
import type { RuntimeEvent, RuntimeEventType, RuntimeScopeKind } from "@agenthub/shared";
import { Prisma } from "../../generated/prisma/client.js";
import { nanoid } from "nanoid";
import type { Server as HttpServer } from "node:http";
import type { IncomingMessage } from "node:http";
import { Client as PgClient } from "pg";
import { WebSocketServer, type WebSocket } from "ws";
import { hashSessionToken } from "../../common/auth-crypto.js";
import { ConfigService } from "../../common/config.service.js";
import { PrismaService } from "../../common/prisma.service.js";
import { getCookie, SESSION_COOKIE_NAME } from "../../common/session-auth.guard.js";

type ClientMessage =
  | {
      type: "subscribe";
      scopes: Array<{ scopeKind: RuntimeScopeKind; scopeId: string; lastSeq?: number }>;
    }
  | { type: "ping"; clientTime?: string };

interface RuntimeEventRef {
  eventId: string;
  scopeKind: RuntimeScopeKind;
  scopeId: string;
  seq: number;
}

const REALTIME_CHANNEL = "agenthub_runtime_events";
const PG_NOTIFY_PAYLOAD_LIMIT = 7000;
const PG_NOTIFY_RECONNECT_MS = 1_000;

@Injectable()
export class RealtimeService implements OnModuleDestroy {
  private server?: WebSocketServer;
  private readonly subscriptions = new Map<WebSocket, Set<string>>();
  private readonly socketUsers = new Map<WebSocket, string>();
  private readonly recentLiveEvents: RuntimeEvent[] = [];
  private readonly instanceId = `rt-${nanoid(8)}`;
  private pgListener: PgClient | undefined;
  private pgListenerReady: Promise<boolean> | undefined;
  private pgReconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private destroying = false;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ConfigService) private readonly config = new ConfigService()
  ) {}

  attach(httpServer: HttpServer) {
    if (this.server) return;
    this.server = new WebSocketServer({ server: httpServer, path: "/realtime" });
    void this.ensurePostgresNotifications();
    this.server.on("connection", (socket, request) => {
      this.subscriptions.set(socket, new Set());
      void this.authenticateSocket(socket, request);
      socket.on("message", (raw) => {
        void this.handleClientMessage(socket, raw.toString());
      });
      socket.on("close", () => {
        this.subscriptions.delete(socket);
        this.socketUsers.delete(socket);
      });
    });
  }

  async emit(scopeKind: RuntimeScopeKind, scopeId: string, type: RuntimeEventType, payload: Record<string, unknown>) {
    const now = new Date();
    const event = await this.prisma.$transaction(async (tx) => {
      const cursor = await tx.runtimeEventCursor.upsert({
        where: { scopeKind_scopeId: { scopeKind, scopeId } },
        create: { scopeKind, scopeId, seq: 1 },
        update: { seq: { increment: 1 } },
        select: { seq: true }
      });
      const row = await tx.runtimeEvent.create({
        data: {
          id: `event-${nanoid(10)}`,
          scopeKind,
          scopeId,
          seq: cursor.seq,
          type,
          actor: { type: "system", id: "system-runtime", name: "Runtime" } as unknown as Prisma.InputJsonValue,
          payload: payload as Prisma.InputJsonValue,
          traceId: `trace-${nanoid(10)}`,
          createdAt: now
        }
      });
      return toRuntimeEvent(row);
    });
    this.rememberRecent(event);
    await this.publishEvent(event);
    this.broadcast(event);
    return event;
  }

  async replay(scopeKind: RuntimeScopeKind, scopeId: string, afterSeq = 0) {
    return this.replayPersisted(scopeKind, scopeId, afterSeq);
  }

  async recentEvents(limit = 80) {
    const rows = await this.prisma.runtimeEvent.findMany({
      orderBy: { createdAt: "desc" },
      take: limit
    });
    return rows.map(toRuntimeEvent);
  }

  async waitForNotificationsReady(timeoutMs = 1_000) {
    if (!this.config.values.AGENTHUB_REALTIME_PG_NOTIFY) return false;
    const ready = this.ensurePostgresNotifications();
    return Promise.race([
      ready,
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs))
    ]);
  }

  private async authenticateSocket(socket: WebSocket, request: IncomingMessage) {
    try {
      const token = getCookie(request.headers.cookie, SESSION_COOKIE_NAME);
      if (!token) {
        socket.close(1008, "Missing session cookie");
        return;
      }
      const session = await this.prisma.session.findFirst({
        where: {
          tokenHash: hashSessionToken(token),
          deletedAt: null,
          expiresAt: { gt: new Date() }
        },
        include: { user: true }
      });
      if (!session?.user || session.user.deletedAt) {
        socket.close(1008, "Invalid session");
        return;
      }
      this.socketUsers.set(socket, session.userId);
      socket.send(JSON.stringify({ type: "connected", payload: { serverTime: new Date().toISOString(), userId: session.userId } }));
    } catch {
      socket.close(1008, "Invalid realtime request");
    }
  }

  private async handleClientMessage(socket: WebSocket, raw: string) {
    try {
      const userId = this.socketUsers.get(socket);
      if (!userId) {
        socket.send(JSON.stringify({ type: "error", error: "Realtime connection is not authenticated" }));
        return;
      }
      const message = JSON.parse(raw) as ClientMessage;
      if (message.type === "ping") {
        socket.send(JSON.stringify({ type: "pong", payload: { serverTime: new Date().toISOString(), clientTime: message.clientTime } }));
        return;
      }
      if (message.type !== "subscribe") return;
      const scopes = this.subscriptions.get(socket);
      if (!scopes) return;
      for (const scope of message.scopes) {
        const canSubscribe = await this.canSubscribe(userId, scope.scopeKind, scope.scopeId);
        if (!canSubscribe) {
          socket.send(JSON.stringify({ type: "error", error: `No access to ${scope.scopeKind}:${scope.scopeId}` }));
          continue;
        }
        scopes.add(this.scopeKey(scope.scopeKind, scope.scopeId));
        for (const event of await this.replayPersisted(scope.scopeKind, scope.scopeId, scope.lastSeq ?? 0)) {
          socket.send(JSON.stringify({ type: "event", event }));
        }
      }
    } catch {
      socket.send(JSON.stringify({ type: "error", error: "Invalid realtime message" }));
    }
  }

  private async canSubscribe(userId: string, scopeKind: RuntimeScopeKind, scopeId: string) {
    if (scopeKind === "user") return scopeId === userId;
    if (scopeKind === "conversation") return this.hasConversationAccess(userId, scopeId);
    if (scopeKind === "workspace") {
      const workspace = await this.prisma.workspace.findFirst({
        where: { id: scopeId, deletedAt: null },
        select: { conversationId: true }
      });
      return workspace ? this.hasConversationAccess(userId, workspace.conversationId) : false;
    }
    if (scopeKind === "run") {
      const run = await this.prisma.orchestratorRun.findFirst({
        where: { id: scopeId, deletedAt: null },
        select: { conversationId: true }
      });
      return run ? this.hasConversationAccess(userId, run.conversationId) : false;
    }
    if (scopeKind === "agent_run") {
      const agentRun = await this.prisma.agentRun.findFirst({
        where: { id: scopeId, deletedAt: null },
        select: { runId: true }
      });
      if (!agentRun?.runId) return false;
      const run = await this.prisma.orchestratorRun.findFirst({
        where: { id: agentRun.runId, deletedAt: null },
        select: { conversationId: true }
      });
      return run ? this.hasConversationAccess(userId, run.conversationId) : false;
    }
    return false;
  }

  private async hasConversationAccess(userId: string, conversationId: string) {
    const member = await this.prisma.conversationMember.findFirst({
      where: {
        conversationId,
        memberType: "user",
        memberId: userId,
        deletedAt: null,
        conversation: { deletedAt: null }
      },
      select: { id: true }
    });
    return Boolean(member);
  }

  private broadcast(event: RuntimeEvent) {
    const key = this.scopeKey(event.scopeKind, event.scopeId);
    for (const [socket, scopes] of this.subscriptions) {
      if (socket.readyState === socket.OPEN && scopes.has(key)) {
        socket.send(JSON.stringify({ type: "event", event }));
      }
    }
  }

  private scopeKey(scopeKind: RuntimeScopeKind, scopeId: string) {
    return `${scopeKind}:${scopeId}`;
  }

  private async replayPersisted(scopeKind: RuntimeScopeKind, scopeId: string, afterSeq = 0) {
    const rows = await this.prisma.runtimeEvent.findMany({
      where: { scopeKind, scopeId, seq: { gt: afterSeq } },
      orderBy: { seq: "asc" },
      take: 500
    });
    return rows.map(toRuntimeEvent);
  }

  private rememberRecent(event: RuntimeEvent) {
    this.recentLiveEvents.push(event);
    if (this.recentLiveEvents.length > 500) this.recentLiveEvents.splice(0, this.recentLiveEvents.length - 500);
  }

  private async publishEvent(event: RuntimeEvent) {
    if (!this.config.values.AGENTHUB_REALTIME_PG_NOTIFY) return;
    const fullPayload = JSON.stringify({ origin: this.instanceId, event });
    const payload = Buffer.byteLength(fullPayload, "utf8") <= PG_NOTIFY_PAYLOAD_LIMIT
      ? fullPayload
      : JSON.stringify({
          origin: this.instanceId,
          eventRef: {
            eventId: event.eventId,
            scopeKind: event.scopeKind,
            scopeId: event.scopeId,
            seq: event.seq
          } satisfies RuntimeEventRef
        });
    try {
      await this.prisma.$executeRaw(Prisma.sql`SELECT pg_notify(${REALTIME_CHANNEL}, ${payload})`);
    } catch {
      // The event is already persisted and locally broadcastable; notify failures must not fail business flows.
    }
  }

  private ensurePostgresNotifications() {
    if (!this.config.values.AGENTHUB_REALTIME_PG_NOTIFY) return Promise.resolve(false);
    if (this.pgListener) return Promise.resolve(true);
    if (this.pgListenerReady) return this.pgListenerReady;
    this.pgListenerReady = this.attachPostgresNotifications().finally(() => {
      this.pgListenerReady = undefined;
    });
    return this.pgListenerReady;
  }

  private async attachPostgresNotifications() {
    if (!this.config.values.AGENTHUB_REALTIME_PG_NOTIFY || this.pgListener) return Boolean(this.pgListener);
    const client = new PgClient({ connectionString: this.config.databaseUrl });
    this.pgListener = client;
    client.on("notification", (message) => {
      if (message.channel !== REALTIME_CHANNEL || !message.payload) return;
      try {
        const parsed = JSON.parse(message.payload) as { origin?: string; event?: RuntimeEvent; eventRef?: RuntimeEventRef };
        if (parsed.origin === this.instanceId) return;
        if (parsed.event) {
          this.rememberRecent(parsed.event);
          this.broadcast(parsed.event);
          return;
        }
        if (parsed.eventRef) void this.broadcastPersistedEvent(parsed.eventRef);
      } catch {
        // Ignore malformed notifications; persisted event replay remains authoritative.
      }
    });
    client.on("error", () => this.handlePostgresListenerDisconnect(client));
    client.on("end", () => this.handlePostgresListenerDisconnect(client));
    try {
      await client.connect();
      await client.query(`LISTEN ${REALTIME_CHANNEL}`);
      return true;
    } catch {
      this.pgListener = undefined;
      await client.end().catch(() => undefined);
      this.schedulePostgresReconnect();
      return false;
    }
  }

  async onModuleDestroy() {
    this.destroying = true;
    if (this.pgReconnectTimer) {
      clearTimeout(this.pgReconnectTimer);
      this.pgReconnectTimer = undefined;
    }
    if (this.pgListener) {
      await this.pgListener.end().catch(() => undefined);
      this.pgListener = undefined;
    }
    this.server?.close();
  }

  private handlePostgresListenerDisconnect(client: PgClient) {
    if (this.pgListener !== client) return;
    this.pgListener = undefined;
    this.schedulePostgresReconnect();
  }

  private schedulePostgresReconnect() {
    if (this.destroying || !this.server || !this.config.values.AGENTHUB_REALTIME_PG_NOTIFY || this.pgReconnectTimer) return;
    this.pgReconnectTimer = setTimeout(() => {
      this.pgReconnectTimer = undefined;
      void this.ensurePostgresNotifications();
    }, PG_NOTIFY_RECONNECT_MS);
  }

  private async broadcastPersistedEvent(ref: RuntimeEventRef) {
    const row = await this.prisma.runtimeEvent.findFirst({
      where: {
        id: ref.eventId,
        scopeKind: ref.scopeKind,
        scopeId: ref.scopeId,
        seq: ref.seq
      }
    });
    if (!row) return;
    const event = toRuntimeEvent(row);
    this.rememberRecent(event);
    this.broadcast(event);
  }
}

function toRuntimeEvent(row: {
  id: string;
  scopeKind: string;
  scopeId: string;
  seq: number;
  type: string;
  actor: Prisma.JsonValue;
  payload: Prisma.JsonValue;
  traceId: string;
  createdAt: Date;
}): RuntimeEvent {
  return {
    eventId: row.id,
    scopeKind: row.scopeKind as RuntimeScopeKind,
    scopeId: row.scopeId,
    seq: row.seq,
    type: row.type as RuntimeEventType,
    actor: row.actor as RuntimeEvent["actor"],
    payload: row.payload as RuntimeEvent["payload"],
    traceId: row.traceId,
    createdAt: row.createdAt.toISOString()
  };
}
