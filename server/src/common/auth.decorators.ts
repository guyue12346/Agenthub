import { createParamDecorator, ExecutionContext, SetMetadata } from "@nestjs/common";
import type { AgentHubUser, UserRole } from "@agenthub/shared";

export const IS_PUBLIC_KEY = "agenthub:is_public";
export const ROLES_KEY = "agenthub:roles";

export interface AuthenticatedRequest {
  headers: Record<string, string | string[] | undefined>;
  method?: string;
  url?: string;
  raw?: { url?: string };
  user?: AgentHubUser;
}

export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);

export const CurrentUser = createParamDecorator((_data: unknown, context: ExecutionContext) => {
  const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
  return request.user;
});
