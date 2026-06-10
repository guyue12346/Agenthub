import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { AgentHubUser } from "@agenthub/shared";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { Prisma, type HubSubscription, type ToolDefinition, type Workspace, type WorkspaceAsset, type WorkspaceAssetVersion } from "../../generated/prisma/client.js";
import { PrismaService } from "../../common/prisma.service.js";
import { toolRegistry, type ToolDefinitionView } from "../tools/tool-registry.js";
import { WorkspacesService } from "../workspaces/workspaces.service.js";

type HubKind = "tool" | "skill" | "knowledge";
type HubOwnerFilter = { ownerType?: "user" | "team"; ownerId?: string };
type WorkspaceHubSource = Awaited<ReturnType<HubsService["resolveWorkspaceAssetSource"]>>;
type ForkedWorkspaceAsset = WorkspaceAsset & { workspace: Workspace; versions: WorkspaceAssetVersion[] };

@Injectable()
export class HubsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(WorkspacesService) private readonly workspaces: WorkspacesService
  ) {}

  async listSubscriptions(currentUser: AgentHubUser, kind?: HubKind, filter: HubOwnerFilter = {}) {
    const subscriptions = await this.prisma.hubSubscription.findMany({
      where: await this.visibleSubscriptionWhere(currentUser, kind, filter),
      orderBy: { updatedAt: "desc" }
    });
    return Promise.all(subscriptions.map((subscription) => this.toSubscriptionView(currentUser, subscription)));
  }

  async subscribe(currentUser: AgentHubUser, kind: HubKind, assetId: string, input: { ownerType?: "user" | "team"; ownerId?: string; config?: unknown } = {}) {
    const ownerType = input.ownerType ?? "user";
    const ownerId = input.ownerId ?? currentUser.id;
    await this.assertCanManageOwner(currentUser, ownerType, ownerId);
    const source = await this.resolveSource(currentUser, kind, assetId);
    this.assertNotOwnedHubSource(currentUser, source, "不能订阅自己发布的 Hub 资产");
    const subscriptionConfig = subscriptionConfigWithSnapshot(input.config, sourceSnapshot(kind, source));
    const subscription = await this.prisma.hubSubscription.upsert({
      where: { kind_assetId_ownerType_ownerId: { kind, assetId, ownerType, ownerId } },
      create: {
        id: `hub-sub-${kind}-${assetId}-${ownerType}-${ownerId}`,
        kind,
        assetId,
        ownerType,
        ownerId,
        sourceVersion: source.version,
        sourceFingerprint: source.fingerprint,
        installedVersion: source.version,
        status: "active",
        updateAvailable: false,
        config: subscriptionConfig
      },
      update: {
        sourceVersion: source.version,
        sourceFingerprint: source.fingerprint,
        installedVersion: source.version,
        status: "active",
        forkedAssetId: null,
        updateAvailable: false,
        conflictStatus: null,
        deletedAt: null,
        config: subscriptionConfig
      }
    });
    return { subscription: await this.toSubscriptionView(currentUser, subscription) };
  }

  async unsubscribe(currentUser: AgentHubUser, kind: HubKind, assetId: string, ownerType = "user", ownerId = currentUser.id) {
    await this.assertCanManageOwner(currentUser, ownerType, ownerId);
    const subscription = await this.prisma.hubSubscription.findFirst({
      where: { kind, assetId, ownerType, ownerId, deletedAt: null }
    });
    if (!subscription) throw new NotFoundException("Hub subscription not found");
    await this.prisma.hubSubscription.update({
      where: { id: subscription.id },
      data: { deletedAt: new Date(), status: "removed" }
    });
    return { subscriptionId: subscription.id, kind, assetId };
  }

  private async softDeleteForkedAssetInTx(tx: Prisma.TransactionClient, kind: HubKind, forkedAssetId: string, deletedAt: Date) {
    await tx.workspaceAsset.updateMany({
      where: { id: forkedAssetId, deletedAt: null },
      data: { deletedAt }
    });
    if (kind === "skill") {
      const skillIndexes = await tx.skillAsset.findMany({
        where: { sourceAssetId: forkedAssetId, deletedAt: null },
        select: { id: true }
      });
      await tx.skillAsset.updateMany({
        where: { sourceAssetId: forkedAssetId, deletedAt: null },
        data: { deletedAt }
      });
      await tx.skillVersion.updateMany({
        where: { skillAssetId: { in: skillIndexes.map((item) => item.id) }, deletedAt: null },
        data: { deletedAt }
      });
    }
    if (kind === "knowledge") {
      const knowledgeIndexes = await tx.knowledgeAsset.findMany({
        where: { sourceAssetId: forkedAssetId, deletedAt: null },
        select: { id: true }
      });
      await tx.knowledgeAsset.updateMany({
        where: { sourceAssetId: forkedAssetId, deletedAt: null },
        data: { deletedAt }
      });
      await tx.knowledgeVersion.updateMany({
        where: { knowledgeAssetId: { in: knowledgeIndexes.map((item) => item.id) }, deletedAt: null },
        data: { deletedAt }
      });
    }
  }

  async syncSubscription(currentUser: AgentHubUser, kind: HubKind, assetId: string, input: { ownerType?: "user" | "team"; ownerId?: string; confirmRiskChanges?: boolean } = {}) {
    const ownerType = input.ownerType ?? "user";
    const ownerId = input.ownerId ?? currentUser.id;
    await this.assertCanManageOwner(currentUser, ownerType, ownerId);
    const subscription = await this.prisma.hubSubscription.findFirst({
      where: { kind, assetId, ownerType, ownerId, deletedAt: null }
    });
    if (!subscription) throw new NotFoundException("Hub subscription not found");
    const source = await this.resolveSource(currentUser, kind, assetId);
    if (subscription.status === "forked") {
      if (kind === "tool" || !subscription.forkedAssetId) throw new BadRequestException("Forked Hub subscription is missing its forked asset");
      return this.syncForkedSubscription(currentUser, subscription, source as WorkspaceHubSource, input.confirmRiskChanges === true);
    }
    const governance = subscriptionUpdateGovernance(subscription, sourceSnapshot(kind, source));
    if (governance.blockingConflict && input.confirmRiskChanges !== true) {
      const blocked = await this.prisma.hubSubscription.update({
        where: { id: subscription.id },
        data: {
          updateAvailable: true,
          conflictStatus: governance.blockingConflict
        }
      });
      return { subscription: await this.toSubscriptionView(currentUser, blocked), governance };
    }
    const updated = await this.prisma.hubSubscription.update({
      where: { id: subscription.id },
      data: {
        sourceVersion: source.version,
        sourceFingerprint: source.fingerprint,
        installedVersion: source.version,
        updateAvailable: false,
        conflictStatus: null,
        status: "active",
          config: subscriptionConfigWithSnapshot(subscription.config, sourceSnapshot(kind, source))
      }
    });
    return { subscription: await this.toSubscriptionView(currentUser, updated), governance };
  }

  async fork(currentUser: AgentHubUser, kind: HubKind, assetId: string) {
    if (kind === "tool") throw new BadRequestException("ToolHub tools cannot be forked");
    const source = await this.resolveWorkspaceAssetSource(currentUser, kind, assetId);
    this.assertNotOwnedHubSource(currentUser, source, "不能 fork 自己发布的 Hub 资产");
    const sourcePath = resolve(source.workspace.rootPath, source.path);
    assertInside(source.workspace.rootPath, sourcePath);
    const content = await readFile(sourcePath);
    const targetWorkspaceId = await this.workspaces.ensurePersonalHubWorkspace(currentUser);
    const forked = await this.workspaces.storeUploadedAsset(currentUser, targetWorkspaceId, {
      name: source.name,
      mimeType: source.mimeType ?? "application/octet-stream",
      content
    });
    const forkedAsset = await this.prisma.workspaceAsset.update({
      where: { id: forked.id },
      data: {
        metadata: {
          ...(asRecord((await this.prisma.workspaceAsset.findUnique({ where: { id: forked.id }, select: { metadata: true } }))?.metadata) ?? {}),
          hubKind: kind,
          visibility: "private",
          forkedFromAssetId: source.id,
          sourceVersion: source.version,
          sourceFingerprint: source.fingerprint
        } as Prisma.InputJsonValue
      }
    });
    await this.workspaces.syncHubAssetIndexById(kind, forkedAsset.id);
    await this.prisma.hubSubscription.updateMany({
      where: { kind, assetId, ownerType: "user", ownerId: currentUser.id, status: "forked", deletedAt: null },
      data: { status: "removed", deletedAt: new Date(), forkedAssetId: null }
    });
    return { asset: forked };
  }

  async like(currentUser: AgentHubUser, kind: HubKind, assetId: string) {
    await this.resolveSource(currentUser, kind, assetId);
    const id = `hub-like-${createHash("sha256").update(`${kind}:${assetId}:${currentUser.id}`).digest("hex").slice(0, 24)}`;
    await this.prisma.$executeRaw`
      INSERT INTO "HubAssetLike" ("id", "kind", "assetId", "userId")
      VALUES (${id}, ${kind}, ${assetId}, ${currentUser.id})
      ON CONFLICT ("kind", "assetId", "userId") DO NOTHING
    `;
    return this.likeState(kind, assetId, currentUser.id);
  }

  async unlike(currentUser: AgentHubUser, kind: HubKind, assetId: string) {
    await this.resolveSource(currentUser, kind, assetId);
    await this.prisma.$executeRaw`
      DELETE FROM "HubAssetLike"
      WHERE "kind" = ${kind} AND "assetId" = ${assetId} AND "userId" = ${currentUser.id}
    `;
    return this.likeState(kind, assetId, currentUser.id);
  }

  private async likeState(kind: HubKind, assetId: string, userId: string) {
    const counts = await this.prisma.$queryRaw<Array<{ count: bigint | number }>>`
      SELECT COUNT(*) AS count
      FROM "HubAssetLike"
      WHERE "kind" = ${kind} AND "assetId" = ${assetId}
    `;
    const liked = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT "id"
      FROM "HubAssetLike"
      WHERE "kind" = ${kind} AND "assetId" = ${assetId} AND "userId" = ${userId}
      LIMIT 1
    `;
    return { kind, assetId, likeCount: Number(counts[0]?.count ?? 0), likedByMe: liked.length > 0 };
  }

  private assertNotOwnedHubSource(currentUser: AgentHubUser, source: { metadata?: unknown; tool?: ToolDefinitionView }, message: string) {
    const metadata = asRecord(source.metadata) ?? {};
    const ownerType = source.tool?.ownerType ?? normalizeOptionalString(metadata.ownerType);
    const ownerId = source.tool?.ownerId ?? normalizeOptionalString(metadata.ownerId) ?? normalizeOptionalString(metadata.ownerUserId);
    if (ownerType === "user" && ownerId === currentUser.id) {
      throw new BadRequestException(message);
    }
  }

  private async syncForkedSubscription(currentUser: AgentHubUser, subscription: HubSubscription, source: WorkspaceHubSource, confirmedRiskChanges: boolean) {
    const forked = await this.prisma.workspaceAsset.findFirst({
      where: { id: subscription.forkedAssetId ?? "", deletedAt: null },
      include: {
        workspace: true,
        versions: { orderBy: { version: "desc" }, take: 1 }
      }
    });
    if (!forked) throw new NotFoundException("Forked Hub asset not found");
    const forkedFingerprint = currentAssetFingerprint(forked);
    if (!fingerprintsEqual(forkedFingerprint, subscription.sourceFingerprint)) {
      const conflicted = await this.prisma.hubSubscription.update({
        where: { id: subscription.id },
        data: {
          updateAvailable: true,
          conflictStatus: "forked_local_changes"
        }
      });
      return { subscription: await this.toSubscriptionView(currentUser, conflicted) };
    }
    const governance = subscriptionUpdateGovernance(subscription, sourceSnapshot(subscription.kind as HubKind, source));
    if (governance.blockingConflict && !confirmedRiskChanges) {
      const blocked = await this.prisma.hubSubscription.update({
        where: { id: subscription.id },
        data: {
          updateAvailable: true,
          conflictStatus: governance.blockingConflict
        }
      });
      return { subscription: await this.toSubscriptionView(currentUser, blocked), governance };
    }

    await this.refreshForkedAssetFromSource(forked, source, subscription.kind as "skill" | "knowledge");
    const updated = await this.prisma.hubSubscription.update({
      where: { id: subscription.id },
      data: {
        sourceVersion: source.version,
        sourceFingerprint: source.fingerprint,
        installedVersion: source.version,
        updateAvailable: false,
        conflictStatus: null,
        config: subscriptionConfigWithSnapshot(subscription.config, sourceSnapshot(subscription.kind as HubKind, source))
      }
    });
    return { subscription: await this.toSubscriptionView(currentUser, updated), governance };
  }

  private async refreshForkedAssetFromSource(forked: ForkedWorkspaceAsset, source: WorkspaceHubSource, kind: "skill" | "knowledge") {
    const sourcePath = resolve(source.workspace.rootPath, source.path);
    const targetPath = resolve(forked.workspace.rootPath, forked.path);
    assertInside(source.workspace.rootPath, sourcePath);
    assertInside(forked.workspace.rootPath, targetPath);
    await mkdir(dirname(targetPath), { recursive: true });
    await copyFile(sourcePath, targetPath);
    const content = await readFile(targetPath);
    const targetStat = await stat(targetPath);
    const checksumSha256 = sha256(content);
    const version = (forked.versions[0]?.version ?? 0) + 1;
    const snapshotPath = `.versions/${forked.id}/v${version}-${basename(forked.path)}`;
    const snapshotAbsolutePath = resolve(forked.workspace.rootPath, snapshotPath);
    assertInside(forked.workspace.rootPath, snapshotAbsolutePath);
    await mkdir(dirname(snapshotAbsolutePath), { recursive: true });
    await copyFile(targetPath, snapshotAbsolutePath);
    await this.prisma.$transaction(async (tx) => {
      await tx.workspaceAssetVersion.create({
        data: {
          id: `asset-version-hub-${forked.id}-${version}`,
          assetId: forked.id,
          version,
          path: snapshotPath,
          size: targetStat.size,
          checksumSha256,
          createdByUserId: null,
          metadata: {
            source: "hub_sync",
            upstreamAssetId: source.id,
            upstreamVersion: source.version
          } as Prisma.InputJsonValue
        }
      });
      await tx.workspaceAsset.update({
        where: { id: forked.id },
        data: {
          mimeType: source.mimeType ?? forked.mimeType,
          size: targetStat.size,
          summary: source.summary,
          metadata: {
            ...(asRecord(forked.metadata) ?? {}),
            storage: "local",
            checksumSha256,
            etag: `"sha256-${checksumSha256}"`,
            latestVersion: version,
            sourceVersion: source.version,
            sourceFingerprint: source.fingerprint,
            syncedFromAssetId: source.id,
            syncedAt: new Date().toISOString()
          } as Prisma.InputJsonValue
        }
      });
    });
    await this.workspaces.syncHubAssetIndexById(kind, forked.id);
  }

  async applyToolLifecycle(currentUser: AgentHubUser, tools: ToolDefinitionView[]) {
    const subscriptions = await this.prisma.hubSubscription.findMany({
      where: {
        ...(await this.visibleSubscriptionWhere(currentUser, "tool")),
        kind: "tool",
        assetId: { in: tools.map((tool) => tool.id) },
        deletedAt: null
      }
    });
    const byAssetId = preferredSubscriptionByAsset(subscriptions, currentUser.id);
    return tools.map((tool) => {
      const source = toolSource(tool);
      const subscription = byAssetId.get(tool.id);
      const updateAvailable = subscription ? source.fingerprint !== subscription.sourceFingerprint : false;
      return {
        ...tool,
        subscribed: Boolean(subscription),
        subscriptionId: subscription?.id,
        installedVersion: subscription?.installedVersion,
        sourceVersion: source.version,
        updateAvailable,
        conflictStatus: subscription?.conflictStatus ?? undefined
      };
    });
  }

  private async toSubscriptionView(currentUser: AgentHubUser, subscription: HubSubscription) {
    const source = await this.resolveSource(currentUser, subscription.kind as HubKind, subscription.assetId).catch(() => null);
    const updateAvailable = source ? source.fingerprint !== subscription.sourceFingerprint || source.version > subscription.installedVersion : false;
    if (updateAvailable !== subscription.updateAvailable) {
      await this.prisma.hubSubscription.update({ where: { id: subscription.id }, data: { updateAvailable } });
    }
    return {
      id: subscription.id,
      kind: subscription.kind,
      assetId: subscription.assetId,
      ownerType: subscription.ownerType,
      ownerId: subscription.ownerId,
      status: subscription.status,
      sourceVersion: source?.version ?? subscription.sourceVersion,
      installedVersion: subscription.installedVersion,
      updateAvailable,
      conflictStatus: subscription.conflictStatus,
      forkedAssetId: subscription.forkedAssetId,
      updatedAt: subscription.updatedAt.toISOString(),
      createdAt: subscription.createdAt.toISOString()
    };
  }

  private async resolveSource(currentUser: AgentHubUser, kind: HubKind, assetId: string) {
    if (kind === "tool") {
      const dbTool = await this.prisma.toolDefinition.findFirst({ where: { id: assetId, deletedAt: null } });
      if (dbTool) {
        if (dbTool.visibility !== "public" && dbTool.ownerId !== currentUser.id && currentUser.role !== "admin") {
          throw new NotFoundException("Hub asset not found");
        }
        return toolSource(toolDefinitionToView(dbTool));
      }
      const tool = toolRegistry.find((item) => item.id === assetId);
      if (!tool) throw new NotFoundException("Hub asset not found");
      return toolSource(tool);
    }
    return this.resolveWorkspaceAssetSource(currentUser, kind, assetId);
  }

  private async resolveWorkspaceAssetSource(currentUser: AgentHubUser, kind: "skill" | "knowledge", assetId: string) {
    const resolvedAssetId = await this.resolveWorkspaceAssetIdFromHubIndex(kind, assetId);
    const asset = await this.prisma.workspaceAsset.findFirst({
      where: { id: resolvedAssetId, deletedAt: null },
      include: {
        workspace: {
          include: {
            conversation: {
              include: { members: { where: { memberType: "user", deletedAt: null } } }
            }
          }
        },
        versions: { orderBy: { version: "desc" }, take: 1 }
      }
    });
    if (!asset) throw new NotFoundException("Hub asset not found");
    const metadata = asRecord(asset.metadata);
    const publicAsset = metadata?.visibility === "public";
    const member = asset.workspace.conversation.members.some((item) => item.memberId === currentUser.id);
    if (!publicAsset && !member && currentUser.role !== "admin") throw new NotFoundException("Hub asset not found");
    if (kind === "skill" && metadata?.hubKind !== "skill" && !looksLikeSkill(asset.name, asset.path, asset.summary)) {
      throw new NotFoundException("Hub asset not found");
    }
    const hubIndex = await this.resolveHubIndex(kind, asset.id);
    if (!hubIndex) await this.workspaces.syncHubAssetIndexById(kind, asset.id);
    const indexed = hubIndex ?? await this.resolveHubIndex(kind, asset.id);
    const version = indexed?.currentVersion ?? (typeof metadata?.latestVersion === "number" ? metadata.latestVersion : asset.versions[0]?.version ?? 1);
    const fingerprint = indexed?.currentFingerprint ?? (typeof metadata?.etag === "string"
      ? metadata.etag
      : typeof metadata?.checksumSha256 === "string"
        ? metadata.checksumSha256
        : String(asset.updatedAt.getTime()));
    return { ...asset, version, fingerprint };
  }

  private async resolveWorkspaceAssetIdFromHubIndex(kind: "skill" | "knowledge", assetId: string) {
    if (kind === "skill") {
      const skill = await this.prisma.skillAsset.findFirst({
        where: { deletedAt: null, OR: [{ id: assetId }, { sourceAssetId: assetId }] },
        select: { sourceAssetId: true }
      });
      return skill?.sourceAssetId ?? assetId;
    }
    const knowledge = await this.prisma.knowledgeAsset.findFirst({
      where: { deletedAt: null, OR: [{ id: assetId }, { sourceAssetId: assetId }] },
      select: { sourceAssetId: true }
    });
    return knowledge?.sourceAssetId ?? assetId;
  }

  private async resolveHubIndex(kind: "skill" | "knowledge", sourceAssetId: string) {
    if (kind === "skill") {
      return this.prisma.skillAsset.findUnique({
        where: { sourceAssetId },
        select: { currentVersion: true, currentFingerprint: true }
      });
    }
    return this.prisma.knowledgeAsset.findUnique({
      where: { sourceAssetId },
      select: { currentVersion: true, currentFingerprint: true }
    });
  }

  private async assertCanManageOwner(currentUser: AgentHubUser, ownerType: string, ownerId: string) {
    if (ownerType === "user") {
      if (ownerId !== currentUser.id && currentUser.role !== "admin") throw new BadRequestException("Cannot manage another user's Hub subscription");
      return;
    }
    if (ownerType === "team") {
      if (currentUser.role === "admin") return;
      const membership = await this.prisma.teamMember.findFirst({ where: { teamId: ownerId, userId: currentUser.id, role: "owner", deletedAt: null } });
      if (!membership) throw new BadRequestException("Only team owners can manage team Hub subscriptions");
      return;
    }
    throw new BadRequestException("Unsupported Hub subscription owner type");
  }

  private async visibleSubscriptionWhere(currentUser: AgentHubUser, kind?: HubKind, filter: HubOwnerFilter = {}): Promise<Prisma.HubSubscriptionWhereInput> {
    const base: Prisma.HubSubscriptionWhereInput = { deletedAt: null, ...(kind ? { kind } : {}) };
    if (currentUser.role === "admin") {
      return {
        ...base,
        ...(filter.ownerType ? { ownerType: filter.ownerType } : {}),
        ...(filter.ownerId ? { ownerId: filter.ownerId } : {})
      };
    }
    if (filter.ownerType === "user") {
      const ownerId = filter.ownerId ?? currentUser.id;
      if (ownerId !== currentUser.id) throw new BadRequestException("Cannot view another user's Hub subscriptions");
      return { ...base, ownerType: "user", ownerId };
    }
    const teamIds = await this.accessibleTeamIds(currentUser.id);
    if (filter.ownerType === "team") {
      if (filter.ownerId && !teamIds.includes(filter.ownerId)) throw new BadRequestException("Cannot view this team's Hub subscriptions");
      return {
        ...base,
        ownerType: "team",
        ...(filter.ownerId ? { ownerId: filter.ownerId } : { ownerId: { in: teamIds } })
      };
    }
    const owners: Prisma.HubSubscriptionWhereInput[] = [
      { ownerType: "user", ownerId: currentUser.id },
      ...(teamIds.length > 0 ? [{ ownerType: "team", ownerId: { in: teamIds } }] : [])
    ];
    return {
      ...base,
      ...(filter.ownerId ? { ownerId: filter.ownerId } : {}),
      OR: owners
    };
  }

  private async accessibleTeamIds(userId: string) {
    const memberships = await this.prisma.teamMember.findMany({
      where: { userId, deletedAt: null, team: { deletedAt: null } },
      select: { teamId: true }
    });
    return memberships.map((membership) => membership.teamId);
  }
}

function preferredSubscriptionByAsset(subscriptions: HubSubscription[], currentUserId: string) {
  const byAssetId = new Map<string, HubSubscription>();
  for (const subscription of subscriptions) {
    const existing = byAssetId.get(subscription.assetId);
    if (!existing || isPreferredSubscription(subscription, existing, currentUserId)) {
      byAssetId.set(subscription.assetId, subscription);
    }
  }
  return byAssetId;
}

function isPreferredSubscription(candidate: HubSubscription, current: HubSubscription, currentUserId: string) {
  if (candidate.ownerType === "user" && candidate.ownerId === currentUserId && current.ownerType !== "user") return true;
  if (candidate.status === "forked" && current.status !== "forked") return true;
  return candidate.updatedAt > current.updatedAt;
}

function toolSource(tool: ToolDefinitionView) {
  const fingerprint = normalizeOptionalString(tool.sourceFingerprint) ?? createHash("sha256").update(JSON.stringify(tool)).digest("hex");
  return { version: typeof tool.sourceVersion === "number" ? tool.sourceVersion : 1, fingerprint, tool };
}

function sourceSnapshot(kind: HubKind, source: { version: number; fingerprint: string; metadata?: unknown; tool?: ToolDefinitionView }) {
  const metadata = asRecord(source.metadata) ?? {};
  const tool = source.tool;
  const permissions = normalizeStringList([
    ...readStringArrayFromRecord(metadata, ["permissions"]),
    ...readStringArrayFromRecord(metadata, ["requiredPermissions"]),
    ...readStringArrayFromRecord(metadata, ["scopes"]),
    ...(tool ? [`tool:${tool.id}`, `tool:${tool.category}:${tool.risk}`, ...normalizeStringList(tool.permissionScopes)] : [])
  ]);
  const capabilityIds = normalizeStringList([
    ...readStringArrayFromRecord(metadata, ["capabilities"]),
    ...readStringArrayFromRecord(metadata, ["capabilityIds"]),
    ...(tool?.runtimeToolId ? [tool.runtimeToolId] : [])
  ]);
  return {
    kind,
    version: source.version,
    fingerprint: source.fingerprint,
    permissions,
    risk: normalizeRisk(tool?.risk ?? normalizeOptionalString(metadata.risk)),
    inputSchemaFingerprint: fingerprintUnknown(metadata.inputSchema ?? metadata.schema ?? metadata.input ?? tool?.inputSchema),
    outputSchemaFingerprint: fingerprintUnknown(metadata.outputSchema ?? metadata.schema ?? metadata.output ?? tool?.outputSchema),
    capabilityIds
  };
}

function toolDefinitionToView(tool: ToolDefinition): ToolDefinitionView {
  return {
    id: tool.id,
    category: tool.category,
    name: tool.name,
    risk: normalizeRisk(tool.risk),
    description: tool.description,
    runtimeType: tool.runtimeType,
    source: tool.source,
    visibility: tool.visibility,
    ownerType: tool.ownerType,
    ownerId: tool.ownerId,
    runtimeToolId: tool.runtimeToolId,
    metadata: asRecord(tool.metadata) ?? {},
    executable: tool.executable,
    inputSchema: asRecord(tool.inputSchema) ?? {},
    outputSchema: asRecord(tool.outputSchema) ?? {},
    permissionScopes: normalizeStringList(tool.permissionScopes),
    requiresApproval: tool.requiresApproval,
    availableToAgentTypes: normalizeStringList(tool.availableToAgentTypes),
    timeoutPolicy: tool.timeoutPolicy,
    auditLevel: tool.auditLevel,
    sourceVersion: tool.currentVersion,
    sourceFingerprint: tool.currentFingerprint,
    updatedAt: tool.updatedAt.toISOString()
  };
}

function subscriptionConfigWithSnapshot(config: unknown, snapshot: ReturnType<typeof sourceSnapshot>) {
  const localConfig = asRecord(config) ?? {};
  const existingHub = asRecord(localConfig.__hub) ?? {};
  return {
    ...localConfig,
    __hub: {
      ...existingHub,
      installedSource: snapshot,
      installedAt: new Date().toISOString()
    }
  } as Prisma.InputJsonValue;
}

function subscriptionUpdateGovernance(subscription: HubSubscription, nextSnapshot: ReturnType<typeof sourceSnapshot>) {
  const currentConfig = asRecord(subscription.config);
  const hubConfig = asRecord(currentConfig?.__hub);
  const previous = asRecord(hubConfig?.installedSource);
  if (!previous) {
    return {
      requiresConfirmation: false,
      blockingConflict: null as string | null,
      changes: []
    };
  }
  const changes: Array<Record<string, unknown>> = [];
  const previousPermissions = normalizeStringList(previous.permissions);
  const nextPermissions = normalizeStringList(nextSnapshot.permissions);
  const addedPermissions = nextPermissions.filter((permission) => !previousPermissions.includes(permission));
  if (addedPermissions.length > 0) {
    changes.push({ type: "permission_added", permissions: addedPermissions });
  }

  const previousRisk = normalizeRisk(normalizeOptionalString(previous.risk));
  if (riskRank(nextSnapshot.risk) > riskRank(previousRisk)) {
    changes.push({ type: "risk_upgraded", from: previousRisk, to: nextSnapshot.risk });
  }

  const previousInputSchema = normalizeOptionalString(previous.inputSchemaFingerprint);
  const previousOutputSchema = normalizeOptionalString(previous.outputSchemaFingerprint);
  if (previousInputSchema && nextSnapshot.inputSchemaFingerprint && previousInputSchema !== nextSnapshot.inputSchemaFingerprint) {
    changes.push({ type: "input_schema_changed" });
  }
  if (previousOutputSchema && nextSnapshot.outputSchemaFingerprint && previousOutputSchema !== nextSnapshot.outputSchemaFingerprint) {
    changes.push({ type: "output_schema_changed" });
  }

  const previousCapabilities = normalizeStringList(previous.capabilityIds);
  const nextCapabilities = normalizeStringList(nextSnapshot.capabilityIds);
  const removedCapabilities = previousCapabilities.filter((capability) => !nextCapabilities.includes(capability));
  if (removedCapabilities.length > 0) {
    changes.push({ type: "capability_removed", capabilities: removedCapabilities });
  }

  const blockingConflict = changes.some((change) => change.type === "permission_added")
    ? "permission_changed"
    : changes.some((change) => change.type === "risk_upgraded")
      ? "risk_changed"
      : changes.some((change) => ["input_schema_changed", "output_schema_changed", "capability_removed"].includes(String(change.type)))
        ? "breaking_change"
        : null;

  return {
    requiresConfirmation: Boolean(blockingConflict),
    blockingConflict,
    changes
  };
}

function currentAssetFingerprint(asset: { metadata?: unknown; updatedAt: Date }) {
  const metadata = asRecord(asset.metadata);
  if (typeof metadata?.etag === "string") return metadata.etag;
  if (typeof metadata?.checksumSha256 === "string") return metadata.checksumSha256;
  return String(asset.updatedAt.getTime());
}

function fingerprintsEqual(left: string, right: string) {
  return normalizeFingerprint(left) === normalizeFingerprint(right);
}

function normalizeFingerprint(value: string) {
  const trimmed = value.trim().replace(/^W\//, "");
  if (trimmed.startsWith("\"sha256-") && trimmed.endsWith("\"")) return trimmed.slice(8, -1);
  if (trimmed.startsWith("\"") && trimmed.endsWith("\"")) return trimmed.slice(1, -1);
  return trimmed;
}

function sha256(content: Buffer) {
  return createHash("sha256").update(content).digest("hex");
}

function sanitizeConfig(config: unknown) {
  if (!config || typeof config !== "object" || Array.isArray(config)) return Prisma.JsonNull;
  return config as Prisma.InputJsonValue;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function normalizeOptionalString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizeStringList(value: unknown) {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean)));
}

function readStringArrayFromRecord(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    const normalized = normalizeStringList(value);
    if (normalized.length > 0) return normalized;
  }
  return [];
}

function normalizeRisk(value: unknown): "read" | "write" | "external" | "dangerous" {
  return value === "write" || value === "external" || value === "dangerous" ? value : "read";
}

function riskRank(value: "read" | "write" | "external" | "dangerous") {
  return { read: 0, write: 1, external: 2, dangerous: 3 }[value];
}

function fingerprintUnknown(value: unknown) {
  if (value === undefined || value === null) return null;
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function looksLikeSkill(name: string, path: string, summary: string | null) {
  const text = `${name} ${path} ${summary ?? ""}`.toLowerCase();
  return text.includes("skill") || text.includes("技能") || text.includes("协作规范");
}

function assertInside(basePath: string, targetPath: string) {
  const relativePath = relative(resolve(basePath), resolve(targetPath));
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) throw new NotFoundException("Hub asset path is outside the workspace root");
}
