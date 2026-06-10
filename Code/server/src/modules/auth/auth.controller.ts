import { Body, Controller, ForbiddenException, Get, Inject, UnauthorizedException, Post, Req, Res } from "@nestjs/common";
import { z } from "zod";
import { randomBytes, randomUUID } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { SessionClientType, SessionKind, type User } from "../../generated/prisma/client.js";
import { hashSessionToken, verifyPassword } from "../../common/auth-crypto.js";
import { CurrentUser, Public, Roles } from "../../common/auth.decorators.js";
import { ObservabilityService } from "../../common/observability.service.js";
import { PrismaService } from "../../common/prisma.service.js";
import { ADMIN_SESSION_COOKIE_NAME, CSRF_COOKIE_NAME, getCookie, SESSION_COOKIE_NAME } from "../../common/session-auth.guard.js";
import { parseBody } from "../../common/validation.js";
import { toAgentHubUser } from "../users/users.service.js";
import type { AgentHubUser } from "@agenthub/shared";

const loginSchema = z.object({
  username: z.string().trim().min(1).max(128),
  password: z.string().min(1).max(256),
  clientType: z.enum(["web", "app", "desktop"]).optional()
});

@Controller("auth")
export class AuthController {
  constructor(
    @Inject(PrismaService)
    private readonly prisma: PrismaService,
    @Inject(ObservabilityService)
    private readonly observability: ObservabilityService
  ) {}

  @Roles("admin")
  @Get("users")
  async users() {
    const users = await this.prisma.user.findMany({
      where: { deletedAt: null },
      orderBy: [{ role: "asc" }, { createdAt: "asc" }]
    });
    return { users: users.map(toAgentHubUser) };
  }

  @Get("me")
  async me(@CurrentUser() currentUser: AgentHubUser) {
    return { user: currentUser };
  }

  @Roles("admin")
  @Get("admin/me")
  async adminMe(@CurrentUser() currentUser: AgentHubUser) {
    return { user: currentUser };
  }

  @Public()
  @Post("login")
  async login(@Body() body: unknown, @Res({ passthrough: true }) reply: FastifyReply, @Req() request?: FastifyRequest) {
    const input = parseBody(loginSchema, body);
    const user = await this.verifyLogin(input);
    return this.createSessionForUser(user, "auth.login", SESSION_COOKIE_NAME, reply, {
      kind: "user",
      clientType: resolveSessionClientType(input.clientType, request),
      request
    });
  }

  @Public()
  @Post("admin/login")
  async adminLogin(@Body() body: unknown, @Res({ passthrough: true }) reply: FastifyReply, @Req() request?: FastifyRequest) {
    const input = parseBody(loginSchema, body);
    const user = await this.verifyLogin(input);
    if (user.role !== "admin") throw new ForbiddenException("后台仅允许管理员账号登录");
    return this.createSessionForUser(user, "auth.admin_login", ADMIN_SESSION_COOKIE_NAME, reply, {
      kind: "admin",
      clientType: resolveSessionClientType(input.clientType, request),
      request
    });
  }

  @Post("logout")
  async logout(@Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply, @CurrentUser() currentUser: AgentHubUser) {
    await this.revokeCookieSession(request, SESSION_COOKIE_NAME, currentUser.id, "auth.logout");
    clearSessionCookie(reply, SESSION_COOKIE_NAME);
    return { ok: true };
  }

  @Roles("admin")
  @Post("admin/logout")
  async adminLogout(@Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply, @CurrentUser() currentUser: AgentHubUser) {
    await this.revokeCookieSession(request, ADMIN_SESSION_COOKIE_NAME, currentUser.id, "auth.admin_logout");
    clearSessionCookie(reply, ADMIN_SESSION_COOKIE_NAME);
    return { ok: true };
  }

  private async verifyLogin(body: { username?: string; password?: string }) {
    const identifier = body.username?.trim();
    const password = body.password ?? "";
    if (!identifier || !password) throw new UnauthorizedException("请输入账号和密码");
    const user = await this.prisma.user.findFirst({
      where: {
        deletedAt: null,
        OR: [
          { id: identifier },
          { name: identifier },
          { email: identifier }
        ]
      }
    });
    if (!user || !verifyPassword(password, user.passwordHash)) throw new UnauthorizedException("账号或密码错误");
    return user;
  }

  private async createSessionForUser(
    user: User,
    action: string,
    cookieName: string,
    reply: FastifyReply,
    options: { kind: `${SessionKind}`; clientType: `${SessionClientType}`; request?: FastifyRequest | undefined }
  ) {
    const token = `agenthub-${randomUUID()}-${randomBytes(18).toString("base64url")}`;
    const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 7);
    await this.prisma.$transaction(async (tx) => {
      await tx.session.updateMany({
        where: {
          userId: user.id,
          kind: options.kind,
          clientType: options.clientType,
          deletedAt: null
        },
        data: { deletedAt: new Date() }
      });
      await tx.session.create({
        data: {
          userId: user.id,
          tokenHash: hashSessionToken(token),
          kind: options.kind,
          clientType: options.clientType,
          userAgent: (options.request ? requestHeader(options.request, "user-agent") : null) ?? null,
          ipAddress: options.request ? requestIp(options.request) : null,
          expiresAt
        }
      });
    });
    await this.observability?.audit({
      actorUserId: user.id,
      action,
      targetType: "user",
      targetId: user.id,
      payload: {
        sessionKind: options.kind,
        clientType: options.clientType,
        expiresAt: expiresAt.toISOString()
      }
    });
    setSessionCookie(reply, cookieName, token, expiresAt);
    return {
      user: toAgentHubUser(user),
      session: {
        kind: options.kind,
        clientType: options.clientType,
        expiresAt: expiresAt.toISOString()
      }
    };
  }

  private async revokeCookieSession(request: FastifyRequest, cookieName: string, userId: string, action: string) {
    const token = getCookie(request.headers.cookie, cookieName);
    if (token) {
      await this.prisma.session.updateMany({
        where: {
          userId,
          tokenHash: hashSessionToken(token),
          deletedAt: null
        },
        data: { deletedAt: new Date() }
      });
    }
    await this.observability?.audit({
      actorUserId: userId,
      action,
      targetType: "user",
      targetId: userId,
      payload: {}
    });
  }
}

function resolveSessionClientType(input: "web" | "app" | "desktop" | undefined, request?: FastifyRequest): `${SessionClientType}` {
  if (input) return input;
  const header = request ? requestHeader(request, "x-agenthub-client-type")?.toLowerCase() : undefined;
  if (header === "app" || header === "desktop" || header === "web") return header;
  const url = request ? request.url ?? request.raw.url ?? "" : "";
  if (url.includes("agenthubMobile=1")) return "app";
  return "web";
}

function requestHeader(request: FastifyRequest, name: string) {
  const value = request.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function requestIp(request: FastifyRequest) {
  const forwardedFor = requestHeader(request, "x-forwarded-for")?.split(",")[0]?.trim();
  return forwardedFor || request.ip || request.socket.remoteAddress || null;
}

function setSessionCookie(reply: FastifyReply, name: string, token: string, expiresAt: Date) {
  const maxAge = Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
  const csrfToken = `csrf-${randomUUID()}-${randomBytes(18).toString("base64url")}`;
  reply.header("Set-Cookie", [
    serializeCookie(name, token, { maxAge, expiresAt, httpOnly: true }),
    serializeCookie(CSRF_COOKIE_NAME, csrfToken, { maxAge, expiresAt, httpOnly: false })
  ]);
}

function clearSessionCookie(reply: FastifyReply, name: string) {
  reply.header("Set-Cookie", serializeCookie(name, "", { maxAge: 0, expiresAt: new Date(0), httpOnly: true }));
}

function serializeCookie(
  name: string,
  value: string,
  options: { maxAge: number; expiresAt: Date; httpOnly: boolean }
) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Max-Age=${options.maxAge}`,
    `Expires=${options.expiresAt.toUTCString()}`,
    "Path=/",
    "SameSite=Lax"
  ];
  if (options.httpOnly) parts.push("HttpOnly");
  if (process.env.NODE_ENV === "production") parts.push("Secure");
  return parts.join("; ");
}
