import { CanActivate, ExecutionContext, ForbiddenException, Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { AgentHubUser } from "@agenthub/shared";
import { hashSessionToken } from "./auth-crypto.js";
import { IS_PUBLIC_KEY, ROLES_KEY, type AuthenticatedRequest } from "./auth.decorators.js";
import { ConfigService } from "./config.service.js";
import { PrismaService } from "./prisma.service.js";
import { toAgentHubUser } from "../modules/users/users.service.js";

export const SESSION_COOKIE_NAME = "agenthub_session";
export const ADMIN_SESSION_COOKIE_NAME = "agenthub_admin_session";
export const CSRF_COOKIE_NAME = "agenthub_csrf";
export const CSRF_HEADER_NAME = "x-agenthub-csrf";

@Injectable()
export class SessionAuthGuard implements CanActivate {
  constructor(
    @Inject(PrismaService)
    private readonly prisma: PrismaService,
    @Inject(Reflector)
    private readonly reflector: Reflector,
    @Inject(ConfigService)
    private readonly config: ConfigService
  ) {}

  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    this.assertTrustedOriginForMutation(request);

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass()
    ]);
    if (isPublic) return true;

    const requiresAdminSession = this.requiresAdminSession(context, request);
    const token = this.extractSessionToken(request, requiresAdminSession);
    if (!token) throw new UnauthorizedException(requiresAdminSession ? "Missing admin session cookie" : "Missing session cookie");
    this.assertCsrfForMutation(request);

    const session = await this.prisma.session.findFirst({
      where: {
        tokenHash: hashSessionToken(token),
        kind: requiresAdminSession ? "admin" : "user",
        deletedAt: null,
        expiresAt: { gt: new Date() }
      },
      include: { user: true }
    });
    if (!session?.user || session.user.deletedAt) throw new UnauthorizedException("Invalid session");

    const currentUser = toAgentHubUser(session.user);
    request.user = currentUser;
    this.assertRoles(context, currentUser);
    return true;
  }

  private extractSessionToken(request: AuthenticatedRequest, requiresAdminSession: boolean) {
    const cookieHeader = Array.isArray(request.headers.cookie) ? request.headers.cookie[0] : request.headers.cookie;
    const cookieToken = getCookie(cookieHeader, requiresAdminSession ? ADMIN_SESSION_COOKIE_NAME : SESSION_COOKIE_NAME);
    if (cookieToken) return cookieToken;
    return undefined;
  }

  private requiresAdminSession(context: ExecutionContext, request: AuthenticatedRequest) {
    const roles = this.reflector.getAllAndOverride<AgentHubUser["role"][]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass()
    ]);
    const url = request.url ?? request.raw?.url ?? "";
    return Boolean(roles?.includes("admin") || url.startsWith("/api/admin") || url.startsWith("/admin") || url.startsWith("/api/auth/admin") || url.startsWith("/auth/admin"));
  }

  private assertRoles(context: ExecutionContext, currentUser: AgentHubUser) {
    const roles = this.reflector.getAllAndOverride<AgentHubUser["role"][]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass()
    ]);
    if (roles?.length && !roles.includes(currentUser.role)) {
      throw new ForbiddenException("Insufficient role");
    }
  }

  private assertTrustedOriginForMutation(request: AuthenticatedRequest) {
    if (!isUnsafeMethod(request.method)) return;
    const candidateOrigin = headerValue(request.headers.origin) ?? refererOrigin(headerValue(request.headers.referer));
    if (!candidateOrigin) {
      if (this.config.nodeEnv === "production") throw new ForbiddenException("Missing request origin");
      return;
    }
    if (candidateOrigin === "null") throw new ForbiddenException("Untrusted request origin");
    if (!this.allowedOrigins(request).has(candidateOrigin)) throw new ForbiddenException("Untrusted request origin");
  }

  private assertCsrfForMutation(request: AuthenticatedRequest) {
    if (!isUnsafeMethod(request.method)) return;
    const cookieHeader = Array.isArray(request.headers.cookie) ? request.headers.cookie[0] : request.headers.cookie;
    const csrfCookie = getCookie(cookieHeader, CSRF_COOKIE_NAME);
    const csrfHeader = headerValue(request.headers[CSRF_HEADER_NAME]);
    if (!csrfCookie || !csrfHeader || csrfCookie !== csrfHeader) throw new ForbiddenException("Invalid CSRF token");
  }

  private allowedOrigins(request: AuthenticatedRequest) {
    const origins = new Set<string>(this.config.webOrigins);
    const host = headerValue(request.headers["x-forwarded-host"]) ?? headerValue(request.headers.host);
    if (host) {
      const protocol = headerValue(request.headers["x-forwarded-proto"]) ?? "http";
      origins.add(`${protocol.split(",")[0]?.trim() ?? "http"}://${host.split(",")[0]?.trim()}`);
    }
    return origins;
  }
}

export function getCookie(cookieHeader: string | undefined, name: string) {
  if (!cookieHeader) return undefined;
  const prefix = `${name}=`;
  for (const part of cookieHeader.split(";")) {
    const item = part.trim();
    if (!item.startsWith(prefix)) continue;
    return decodeURIComponent(item.slice(prefix.length));
  }
  return undefined;
}

function isUnsafeMethod(method: string | undefined) {
  const normalized = (method ?? "GET").toUpperCase();
  return normalized !== "GET" && normalized !== "HEAD" && normalized !== "OPTIONS";
}

function headerValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function refererOrigin(referer: string | undefined) {
  if (!referer) return undefined;
  try {
    return new URL(referer).origin;
  } catch {
    return undefined;
  }
}

function normalizeOrigin(value: string) {
  return new URL(value).origin;
}
