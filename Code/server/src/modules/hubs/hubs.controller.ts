import { Body, Controller, Delete, Get, Inject, Param, Post, Query } from "@nestjs/common";
import type { AgentHubUser } from "@agenthub/shared";
import { z } from "zod";
import { CurrentUser } from "../../common/auth.decorators.js";
import { cuidLikeSchema, parseBody, parseQuery } from "../../common/validation.js";
import { HubsService } from "./hubs.service.js";

const hubKindSchema = z.enum(["tool", "skill", "knowledge"]);

const hubSubscriptionQuerySchema = z.object({
  kind: hubKindSchema.optional(),
  ownerType: z.enum(["user", "team"]).optional(),
  ownerId: z.string().optional()
});

const hubSubscribeSchema = z.object({
  ownerType: z.enum(["user", "team"]).default("user"),
  ownerId: z.string().optional(),
  config: z.record(z.string(), z.unknown()).optional()
});

const hubOwnerSchema = z.object({
  ownerType: z.enum(["user", "team"]).default("user"),
  ownerId: z.string().optional(),
  confirmRiskChanges: z.boolean().optional()
});

const hubAssetParamSchema = z.object({
  kind: hubKindSchema,
  assetId: cuidLikeSchema
});

@Controller("hubs")
export class HubsController {
  constructor(@Inject(HubsService) private readonly hubs: HubsService) {}

  @Get("subscriptions")
  async subscriptions(@CurrentUser() currentUser: AgentHubUser, @Query() query: unknown) {
    const input = parseQuery(hubSubscriptionQuerySchema, query);
    return {
      subscriptions: await this.hubs.listSubscriptions(currentUser, input.kind, {
        ...(input.ownerType ? { ownerType: input.ownerType } : {}),
        ...(input.ownerId ? { ownerId: input.ownerId } : {})
      })
    };
  }

  @Post(":kind/:assetId/subscribe")
  async subscribe(
    @CurrentUser() currentUser: AgentHubUser,
    @Param("kind") kind: string,
    @Param("assetId") assetId: string,
    @Body() body: unknown
  ) {
    const params = parseBody(hubAssetParamSchema, { kind, assetId });
    const input = parseBody(hubSubscribeSchema, body);
    return this.hubs.subscribe(currentUser, params.kind, params.assetId, {
      ownerType: input.ownerType,
      ...(input.ownerId ? { ownerId: input.ownerId } : {}),
      ...(input.config ? { config: input.config } : {})
    });
  }

  @Delete(":kind/:assetId/subscribe")
  async unsubscribe(
    @CurrentUser() currentUser: AgentHubUser,
    @Param("kind") kind: string,
    @Param("assetId") assetId: string,
    @Query() query: unknown
  ) {
    const params = parseBody(hubAssetParamSchema, { kind, assetId });
    const input = parseQuery(hubSubscriptionQuerySchema, query);
    return this.hubs.unsubscribe(currentUser, params.kind, params.assetId, input.ownerType ?? "user", input.ownerId ?? currentUser.id);
  }

  @Post(":kind/:assetId/sync")
  async sync(
    @CurrentUser() currentUser: AgentHubUser,
    @Param("kind") kind: string,
    @Param("assetId") assetId: string,
    @Body() body: unknown
  ) {
    const params = parseBody(hubAssetParamSchema, { kind, assetId });
    const input = parseBody(hubOwnerSchema, body);
    return this.hubs.syncSubscription(currentUser, params.kind, params.assetId, {
      ownerType: input.ownerType,
      ...(input.ownerId ? { ownerId: input.ownerId } : {}),
      ...(input.confirmRiskChanges ? { confirmRiskChanges: input.confirmRiskChanges } : {})
    });
  }

  @Post(":kind/:assetId/fork")
  async fork(@CurrentUser() currentUser: AgentHubUser, @Param("kind") kind: string, @Param("assetId") assetId: string) {
    const params = parseBody(hubAssetParamSchema, { kind, assetId });
    return this.hubs.fork(currentUser, params.kind, params.assetId);
  }

  @Post(":kind/:assetId/like")
  async like(@CurrentUser() currentUser: AgentHubUser, @Param("kind") kind: string, @Param("assetId") assetId: string) {
    const params = parseBody(hubAssetParamSchema, { kind, assetId });
    return this.hubs.like(currentUser, params.kind, params.assetId);
  }

  @Delete(":kind/:assetId/like")
  async unlike(@CurrentUser() currentUser: AgentHubUser, @Param("kind") kind: string, @Param("assetId") assetId: string) {
    const params = parseBody(hubAssetParamSchema, { kind, assetId });
    return this.hubs.unlike(currentUser, params.kind, params.assetId);
  }
}
