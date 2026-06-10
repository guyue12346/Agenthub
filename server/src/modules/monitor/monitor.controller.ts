import { Controller, Get, Headers, Inject, Optional, Param, Query } from "@nestjs/common";
import { networkInterfaces } from "node:os";
import { z } from "zod";
import { Prisma, type LlmCallStatus, type SystemLogLevel } from "../../generated/prisma/client.js";
import { Roles } from "../../common/auth.decorators.js";
import { ConfigService } from "../../common/config.service.js";
import { parseQuery } from "../../common/validation.js";
import { PrismaService } from "../../common/prisma.service.js";
import { RealtimeService } from "../realtime/realtime.service.js";
import { toAgentHubUser } from "../users/users.service.js";

const monitorQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  usersPage: z.coerce.number().int().min(1).default(1),
  usersPageSize: z.coerce.number().int().min(1).max(100).default(50),
  conversationsPage: z.coerce.number().int().min(1).default(1),
  conversationsPageSize: z.coerce.number().int().min(1).max(100).default(50),
  logsPage: z.coerce.number().int().min(1).default(1),
  logsPageSize: z.coerce.number().int().min(1).max(200).default(80),
  eventsPage: z.coerce.number().int().min(1).default(1),
  eventsPageSize: z.coerce.number().int().min(1).max(200).default(80),
  runsPage: z.coerce.number().int().min(1).default(1),
  runsPageSize: z.coerce.number().int().min(1).max(100).default(40),
  logSource: z.enum(["system", "runtime", "llm", "audit"]).optional(),
  logLevel: z.string().trim().min(1).max(64).optional(),
  search: z.string().trim().min(1).max(200).optional()
});

@Roles("admin")
@Controller("admin/monitor")
export class MonitorController {
  constructor(
    @Inject(PrismaService)
    private readonly prisma: PrismaService,
    @Inject(RealtimeService)
    private readonly realtime: RealtimeService,
    @Optional()
    @Inject(ConfigService)
    private readonly config?: ConfigService
  ) {}

  @Get()
  async overview(
    @Query() query: unknown,
    @Headers("host") host?: string,
    @Headers("x-forwarded-host") forwardedHost?: string,
    @Headers("x-forwarded-proto") forwardedProto?: string
  ) {
    const filters = parseQuery(monitorQuerySchema, query);
    const config = this.config ?? new ConfigService();
    const logWindow = pageSkip(filters.logsPage, filters.logsPageSize) + filters.logsPageSize;
    const enabledLogSources: Array<"system" | "runtime" | "llm" | "audit"> = filters.logSource
      ? [filters.logSource]
      : ["system", "runtime", "llm", "audit"];
    const [
      users,
      admins,
      friendConnections,
      conversations,
      messages,
      agents,
      assets,
      runs,
      events,
      userRows,
      activeSessions,
      projectRows,
      connectionRows,
      runRows,
      eventRows,
      systemLogs,
      runtimeLogs,
      llmLogs,
      auditLogs,
      systemLogCount,
      runtimeLogCount,
      llmLogCount,
      auditLogCount
    ] = await Promise.all([
      this.prisma.user.count({ where: { deletedAt: null } }),
      this.prisma.user.count({ where: { role: "admin", deletedAt: null } }),
      this.prisma.friendConnection.count({ where: { deletedAt: null } }),
      this.prisma.conversation.count({ where: { deletedAt: null } }),
      this.prisma.message.count({ where: { deletedAt: null } }),
      this.prisma.agent.count({ where: { deletedAt: null } }),
      this.prisma.workspaceAsset.count({ where: { deletedAt: null } }),
      this.prisma.orchestratorRun.count({ where: { deletedAt: null } }),
      this.prisma.runtimeEvent.count(),
      this.prisma.user.findMany({
        where: { deletedAt: null },
        orderBy: { createdAt: "asc" },
        skip: pageSkip(filters.usersPage, filters.usersPageSize),
        take: filters.usersPageSize
      }),
      this.prisma.session.groupBy({
        by: ["userId"],
        where: { deletedAt: null, expiresAt: { gt: new Date() } },
        _count: { _all: true }
      }),
      this.prisma.conversation.findMany({
        where: { type: "project", deletedAt: null },
        include: {
          workspace: true,
          _count: {
            select: {
              members: true,
              messages: true,
              runs: true
            }
          }
        },
        orderBy: { updatedAt: "desc" },
        skip: pageSkip(filters.conversationsPage, filters.conversationsPageSize),
        take: filters.conversationsPageSize
      }),
      this.prisma.friendConnection.findMany({ where: { deletedAt: null }, orderBy: { updatedAt: "desc" } }),
      this.prisma.orchestratorRun.findMany({
        where: { deletedAt: null },
        orderBy: { startedAt: "desc" },
        skip: pageSkip(filters.runsPage, filters.runsPageSize),
        take: filters.runsPageSize
      }),
      this.prisma.runtimeEvent.findMany({
        orderBy: { createdAt: "desc" },
        skip: pageSkip(filters.eventsPage, filters.eventsPageSize),
        take: filters.eventsPageSize
      }),
      filters.logSource && filters.logSource !== "system"
        ? Promise.resolve([])
        : this.prisma.systemLog.findMany({
            where: buildSystemLogWhere(filters),
            orderBy: { createdAt: "desc" },
            take: logWindow
          }),
      filters.logSource && filters.logSource !== "runtime"
        ? Promise.resolve([])
        : this.prisma.runtimeEvent.findMany({
            where: buildRuntimeEventWhere(filters),
            orderBy: { createdAt: "desc" },
            take: logWindow
          }),
      filters.logSource && filters.logSource !== "llm"
        ? Promise.resolve([])
        : this.prisma.llmCallLog.findMany({
            where: buildLlmLogWhere(filters),
            orderBy: { createdAt: "desc" },
            take: logWindow
          }),
      filters.logSource && filters.logSource !== "audit"
        ? Promise.resolve([])
        : this.prisma.auditLog.findMany({
            where: buildAuditLogWhere(filters),
            orderBy: { createdAt: "desc" },
            take: logWindow
          }),
      enabledLogSources.includes("system") ? this.prisma.systemLog.count({ where: buildSystemLogWhere(filters) }) : Promise.resolve(0),
      enabledLogSources.includes("runtime") ? this.prisma.runtimeEvent.count({ where: buildRuntimeEventWhere(filters) }) : Promise.resolve(0),
      enabledLogSources.includes("llm") ? this.prisma.llmCallLog.count({ where: buildLlmLogWhere(filters) }) : Promise.resolve(0),
      enabledLogSources.includes("audit") ? this.prisma.auditLog.count({ where: buildAuditLogWhere(filters) }) : Promise.resolve(0)
    ]);
    const activeSessionCountByUserId = new Map(activeSessions.map((session) => [session.userId, session._count._all]));
    const logs = [
      ...systemLogs.map((log) => ({
        id: log.id,
        source: "system",
        level: log.level,
        scope: log.scope,
        message: log.message,
        traceId: log.traceId,
        createdAt: log.createdAt.toISOString()
      })),
      ...runtimeLogs.map((event) => ({
        id: event.id,
        source: "runtime",
        level: "event",
        scope: `${event.scopeKind}:${event.scopeId}`,
        message: event.type,
        traceId: event.traceId,
        createdAt: event.createdAt.toISOString()
      })),
      ...llmLogs.map((log) => ({
        id: log.id,
        source: "llm",
        level: log.status,
        scope: `${log.callerType}:${log.callerId}`,
        message: `${log.provider} / ${log.model}`,
        traceId: null,
        createdAt: log.createdAt.toISOString()
      })),
      ...auditLogs.map((log) => ({
        id: log.id,
        source: "audit",
        level: "audit",
        scope: `${log.targetType}:${log.targetId}`,
        message: log.action,
        traceId: null,
        createdAt: log.createdAt.toISOString()
      }))
    ].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(pageSkip(filters.logsPage, filters.logsPageSize), pageSkip(filters.logsPage, filters.logsPageSize) + filters.logsPageSize);
    const logCount = systemLogCount + runtimeLogCount + llmLogCount + auditLogCount;
    return {
      counters: {
        users,
        admins,
        friendConnections,
        conversations,
        messages,
        agents,
        assets,
        runs,
        events
      },
      database: {
        mode: this.prisma.mode,
        prismaSchema: "server/prisma/schema.prisma",
        runtimePersistence: "postgresql"
      },
      access: buildAccessInfo({
        host,
        forwardedHost,
        forwardedProto,
        webOrigin: config.webOrigin,
        apiPort: config.port
      }),
      users: userRows.map((user) => ({
        ...toAgentHubUser(user),
        email: user.email,
        activeSessions: activeSessionCountByUserId.get(user.id) ?? 0,
        createdAt: user.createdAt.toISOString(),
        updatedAt: user.updatedAt.toISOString()
      })),
      conversations: projectRows.map((conversation) => ({
        id: conversation.id,
        title: conversation.title,
        avatar: conversation.avatar ?? "AH",
        workspaceId: conversation.workspaceId,
        workspaceName: conversation.workspace?.name ?? null,
        codeAgentId: conversation.codeAgentId,
        memberCount: conversation._count.members,
        messageCount: conversation._count.messages,
        runCount: conversation._count.runs,
        lastMessage: conversation.lastMessage,
        updatedAt: conversation.updatedAt.toISOString()
      })),
      friendConnections: connectionRows.map((connection) => ({
        ...connection,
        createdAt: connection.createdAt.toISOString(),
        updatedAt: connection.updatedAt.toISOString()
      })),
      runs: runRows.map((run) => run.workingMemory),
      events: eventRows.map((event) => ({
        id: event.id,
        eventId: event.id,
        scopeKind: event.scopeKind,
        scopeId: event.scopeId,
        seq: event.seq,
        type: event.type,
        actor: event.actor,
        payload: event.payload,
        traceId: event.traceId,
        createdAt: event.createdAt.toISOString()
      })),
      logs,
      pagination: {
        users: pageMeta(filters.usersPage, filters.usersPageSize, users),
        conversations: pageMeta(filters.conversationsPage, filters.conversationsPageSize, conversations),
        runs: pageMeta(filters.runsPage, filters.runsPageSize, runs),
        events: pageMeta(filters.eventsPage, filters.eventsPageSize, events),
        logs: pageMeta(filters.logsPage, filters.logsPageSize, logCount)
      }
    };
  }

  @Get("runs/:runId")
  async runDetail(@Param("runId") runId: string) {
    const run = await this.prisma.orchestratorRun.findFirst({
      where: { id: runId, deletedAt: null },
      include: {
        agentRuns: { where: { deletedAt: null }, orderBy: { startedAt: "asc" } },
        toolRuns: { where: { deletedAt: null }, orderBy: { createdAt: "asc" } }
      }
    });
    return { run };
  }

  @Get("conversations/:conversationId")
  async conversationDetail(@Param("conversationId") conversationId: string) {
    const [conversation, members, messages, events, runs] = await Promise.all([
      this.prisma.conversation.findFirst({ where: { id: conversationId, deletedAt: null }, include: { workspace: true } }),
      this.prisma.conversationMember.findMany({ where: { conversationId, deletedAt: null }, orderBy: { createdAt: "asc" } }),
      this.prisma.message.findMany({ where: { conversationId, deletedAt: null }, orderBy: { seq: "desc" }, take: 100 }),
      this.prisma.runtimeEvent.findMany({ where: { scopeKind: "conversation", scopeId: conversationId }, orderBy: { seq: "desc" }, take: 100 }),
      this.prisma.orchestratorRun.findMany({ where: { conversationId, deletedAt: null }, orderBy: { startedAt: "desc" }, take: 20 })
    ]);
    return { conversation, members, messages, events, runs };
  }
}

type MonitorFilters = z.infer<typeof monitorQuerySchema>;

interface AccessInfoInput {
  host?: string | undefined;
  forwardedHost?: string | undefined;
  forwardedProto?: string | undefined;
  webOrigin: string;
  apiPort: number;
}

function pageSkip(page: number, pageSize: number) {
  return (page - 1) * pageSize;
}

function pageMeta(page: number, pageSize: number, total: number) {
  return {
    page,
    pageSize,
    total,
    hasMore: page * pageSize < total
  };
}

function buildAccessInfo(input: AccessInfoInput) {
  const detectedAt = new Date().toISOString();
  const webOrigin = normalizeOrigin(input.webOrigin);
  const webPort = Number(new URL(webOrigin).port || (new URL(webOrigin).protocol === "https:" ? 443 : 80));
  const requestHost = stripPort(input.forwardedHost ?? input.host ?? "");
  const requestProtocol = input.forwardedProto?.split(",")[0]?.trim() || "http";
  const interfaceAddresses = collectInterfaceAddresses();
  const hostCandidates = dedupe([
    requestHost,
    ...interfaceAddresses.map((item) => item.address)
  ].filter(Boolean));
  const urls = hostCandidates.flatMap((address) => buildUrlsForHost(address, requestProtocol, webPort, input.apiPort));
  return {
    detectedAt,
    request: {
      host: input.host ?? null,
      forwardedHost: input.forwardedHost ?? null,
      protocol: requestProtocol
    },
    webOrigin,
    apiPort: input.apiPort,
    webPort,
    interfaceAddresses,
    urls
  };
}

function collectInterfaceAddresses() {
  return Object.entries(networkInterfaces()).flatMap(([name, addresses]) =>
    (addresses ?? [])
      .filter((address) => address.family === "IPv4" && !address.internal && isUserFacingInterface(name))
      .map((address) => ({
        name,
        address: address.address,
        family: address.family,
        mac: address.mac
      }))
  );
}

function isUserFacingInterface(name: string) {
  return !/^(utun|bridge|awdl|llw|gif|stf|anpi|ap|vboxnet|vmnet)/i.test(name);
}

function buildUrlsForHost(host: string, protocol: string, webPort: number, apiPort: number) {
  const webBase = `${protocol}://${host}:${webPort}`;
  const apiBase = `${protocol}://${host}:${apiPort}`;
  return [
    { key: `${host}:workbench`, host, label: "工作台", url: webBase, kind: "web" },
    { key: `${host}:admin`, host, label: "后台监控", url: `${webBase}/admin/monitor`, kind: "admin" },
    { key: `${host}:health`, host, label: "后端健康检查", url: `${apiBase}/api/health`, kind: "api" },
    { key: `${host}:realtime`, host, label: "实时通信 WebSocket", url: `${protocol === "https" ? "wss" : "ws"}://${host}:${apiPort}/realtime`, kind: "realtime" }
  ];
}

function normalizeOrigin(origin: string) {
  try {
    const parsed = new URL(origin);
    return parsed.origin;
  } catch {
    return "http://127.0.0.1:5173";
  }
}

function stripPort(host: string) {
  if (!host) return "";
  if (host.startsWith("[")) return host.slice(1, host.indexOf("]"));
  return host.split(":")[0] ?? "";
}

function dedupe(values: string[]) {
  return Array.from(new Set(values));
}

function contains(value: string) {
  return { contains: value, mode: "insensitive" as const };
}

function buildSystemLogWhere(filters: MonitorFilters): Prisma.SystemLogWhereInput {
  const where: Prisma.SystemLogWhereInput = {};
  if (filters.logLevel && isSystemLogLevel(filters.logLevel)) where.level = filters.logLevel;
  if (filters.search) {
    where.OR = [
      { message: contains(filters.search) },
      { scope: contains(filters.search) },
      { traceId: contains(filters.search) }
    ];
  }
  return where;
}

function buildRuntimeEventWhere(filters: MonitorFilters): Prisma.RuntimeEventWhereInput {
  const where: Prisma.RuntimeEventWhereInput = {};
  if (filters.logLevel) where.type = filters.logLevel;
  if (filters.search) {
    where.OR = [
      { type: contains(filters.search) },
      { scopeId: contains(filters.search) },
      { traceId: contains(filters.search) }
    ];
  }
  return where;
}

function buildLlmLogWhere(filters: MonitorFilters): Prisma.LlmCallLogWhereInput {
  const where: Prisma.LlmCallLogWhereInput = {};
  if (filters.logLevel && isLlmCallStatus(filters.logLevel)) where.status = filters.logLevel;
  if (filters.search) {
    where.OR = [
      { provider: contains(filters.search) },
      { model: contains(filters.search) },
      { callerType: contains(filters.search) },
      { callerId: contains(filters.search) },
      { error: contains(filters.search) }
    ];
  }
  return where;
}

function buildAuditLogWhere(filters: MonitorFilters): Prisma.AuditLogWhereInput {
  const where: Prisma.AuditLogWhereInput = {};
  if (filters.search) {
    where.OR = [
      { action: contains(filters.search) },
      { targetType: contains(filters.search) },
      { targetId: contains(filters.search) },
      { actorUserId: contains(filters.search) }
    ];
  }
  return where;
}

function isSystemLogLevel(value: string): value is SystemLogLevel {
  return ["debug", "info", "warn", "error"].includes(value);
}

function isLlmCallStatus(value: string): value is LlmCallStatus {
  return ["started", "completed", "failed"].includes(value);
}
