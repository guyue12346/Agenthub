import { Body, Controller, Get, Inject, Param, Post, Req, Res } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { AgentHubUser } from "@agenthub/shared";
import { z } from "zod";
import { CurrentUser } from "../../common/auth.decorators.js";
import { parseBody } from "../../common/validation.js";
import { DeploymentsService } from "./deployments.service.js";

const startStaticPreviewSchema = z.object({
  conversationId: z.string().trim().min(1).optional(),
  triggerMessageId: z.string().trim().min(1).optional(),
  title: z.string().trim().min(1).max(160).optional()
});

@Controller("deployments")
export class DeploymentsController {
  constructor(@Inject(DeploymentsService) private readonly deployments: DeploymentsService) {}

  @Post("workspaces/:workspaceId/static-preview")
  async startStaticPreview(
    @CurrentUser() currentUser: AgentHubUser,
    @Param("workspaceId") workspaceId: string,
    @Body() body: unknown
  ) {
    const input = parseBody(startStaticPreviewSchema, body);
    const request = {
      workspaceId,
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
      ...(input.triggerMessageId ? { triggerMessageId: input.triggerMessageId } : {}),
      ...(input.title ? { title: input.title } : {})
    };
    return {
      deployment: await this.deployments.startStaticPreviewDeployment(currentUser, request)
    };
  }

  @Get(":deploymentId")
  async detail(@CurrentUser() currentUser: AgentHubUser, @Param("deploymentId") deploymentId: string) {
    return { deployment: await this.deployments.getDeployment(currentUser, deploymentId) };
  }

  @Post(":deploymentId/stop")
  async stop(@CurrentUser() currentUser: AgentHubUser, @Param("deploymentId") deploymentId: string) {
    return { deployment: await this.deployments.stopDeployment(currentUser, deploymentId) };
  }

  @Get(":deploymentId/preview")
  async previewIndex(
    @CurrentUser() currentUser: AgentHubUser,
    @Param("deploymentId") deploymentId: string,
    @Res() reply: FastifyReply
  ) {
    return this.deployments.servePreviewFile(currentUser, deploymentId, "", reply);
  }

  @Get(":deploymentId/preview/*")
  async previewFile(
    @CurrentUser() currentUser: AgentHubUser,
    @Param("deploymentId") deploymentId: string,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply
  ) {
    const path = extractPreviewPath(request.url, deploymentId);
    return this.deployments.servePreviewFile(currentUser, deploymentId, path, reply);
  }
}

function extractPreviewPath(url: string | undefined, deploymentId: string) {
  const marker = `/deployments/${encodeURIComponent(deploymentId)}/preview/`;
  const raw = url ?? "";
  const index = raw.indexOf(marker);
  if (index < 0) return "";
  return decodeURIComponent(raw.slice(index + marker.length).split("?")[0] ?? "");
}
