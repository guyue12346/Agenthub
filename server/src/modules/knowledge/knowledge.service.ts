import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { AgentHubUser } from "@agenthub/shared";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, relative, resolve } from "node:path";
import { nanoid } from "nanoid";
import { Prisma } from "../../generated/prisma/client.js";
import { PrismaService } from "../../common/prisma.service.js";
import { KnowledgeIndexService } from "../../common/knowledge-index.service.js";
import { ConfigService } from "../../common/config.service.js";
import { WorkspacesService } from "../workspaces/workspaces.service.js";
import { DocumentExtractionService } from "./document-extraction.service.js";
import { normalizeHubLogo, normalizeHubLogoColor } from "../../common/hub-appearance.js";

export const KNOWLEDGE_PRESETS = {
  standard: {
    label: "标准（推荐）",
    description: "适合大多数文档，句子分割 + 512 token 块",
    chunkingStrategy: "sentence" as const,
    chunkingSize: 512,
    chunkingOverlap: 50,
    topK: 5,
    scoreThreshold: 0.7
  },
  precise: {
    label: "精确",
    description: "较小块，更精准匹配，适合技术文档",
    chunkingStrategy: "sentence" as const,
    chunkingSize: 256,
    chunkingOverlap: 30,
    topK: 8,
    scoreThreshold: 0.75
  },
  broad: {
    label: "宽泛",
    description: "较大块，保留更多上下文，适合长文章",
    chunkingStrategy: "fixed_token" as const,
    chunkingSize: 1024,
    chunkingOverlap: 100,
    topK: 3,
    scoreThreshold: 0.65
  }
} as const;

export type KnowledgePreset = keyof typeof KNOWLEDGE_PRESETS;
export type KnowledgeListFilter = "all" | "mine" | "public";

export interface CreateKnowledgeInput {
  name: string;
  description?: string;
  preset?: KnowledgePreset;
  visibility?: "private" | "public";
  logo?: string;
  logoColor?: string;
}

export interface UpdateKnowledgeInput {
  name?: string | undefined;
  description?: string | undefined;
  preset?: KnowledgePreset | undefined;
  visibility?: "private" | "public" | undefined;
  logo?: string | undefined;
  logoColor?: string | undefined;
}

export interface IndexDocumentInput {
  name?: string | undefined;
  path?: string | undefined;
  title?: string | undefined;
  content?: string | undefined;
  contentBase64?: string | undefined;
  mimeType?: string | undefined;
  sourceAssetVersion?: number | undefined;
}

export interface SearchInput {
  query: string;
  topK?: number | undefined;
  scoreThreshold?: number | undefined;
  conversationId?: string | undefined;
  runId?: string | undefined;
  callerType?: string | undefined;
  callerId?: string | undefined;
}

type KnowledgeViewRecord = Prisma.KnowledgeAssetGetPayload<{
  include: { documents: { where: { deletedAt: null } } };
}>;

@Injectable()
export class KnowledgeService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(KnowledgeIndexService) private readonly indexService: KnowledgeIndexService,
    @Inject(ConfigService) private readonly config: ConfigService,
    @Inject(WorkspacesService) private readonly workspaces: WorkspacesService,
    @Inject(DocumentExtractionService) private readonly extractor: DocumentExtractionService
  ) {}

  async list(user: AgentHubUser, filter: KnowledgeListFilter = "all") {
    const subscriptions = await this.prisma.knowledgeSubscription.findMany({
      where: { ownerType: "user", ownerId: user.id, deletedAt: null },
      select: { knowledgeAssetId: true, createdAt: true }
    });
    const subscribedIds = new Set(subscriptions.map((subscription) => subscription.knowledgeAssetId));
    const where: Prisma.KnowledgeAssetWhereInput = {
      deletedAt: null,
      AND: [realKnowledgeAssetWhere()],
      ...(filter === "mine"
        ? {
            OR: [
              { ownerType: "user", ownerId: user.id },
              ...(subscribedIds.size > 0 ? [{ id: { in: [...subscribedIds] } }] : [])
            ]
          }
        : filter === "public"
          ? { visibility: "public", NOT: { ownerType: "user", ownerId: user.id } }
          : {
              OR: [
                { ownerType: "user", ownerId: user.id },
                { visibility: "public" },
                ...(subscribedIds.size > 0 ? [{ id: { in: [...subscribedIds] } }] : [])
              ]
            })
    };
    const assets = await this.prisma.knowledgeAsset.findMany({
      where,
      include: { documents: { where: { deletedAt: null } } },
      orderBy: { updatedAt: "desc" },
      take: 200
    });
    const ownerNames = await this.loadOwnerNames(assets);
    const likes = await this.loadLikeSummary(assets.map((asset) => asset.id), user.id);
    const views = assets.map((asset) => this.toView(
      asset,
      user,
      subscribedIds.has(asset.id),
      ownerNames.get(`${asset.ownerType}:${asset.ownerId}`),
      likes.get(asset.id)
    ));
    if (filter === "public") {
      return views.sort((left, right) => right.likeCount - left.likeCount || right.updatedAt.getTime() - left.updatedAt.getTime());
    }
    return views;
  }

  async get(user: AgentHubUser, id: string) {
    const asset = await this.findVisible(user, id, true);
    const subscription = await this.prisma.knowledgeSubscription.findFirst({
      where: { knowledgeAssetId: id, ownerType: "user", ownerId: user.id, deletedAt: null }
    });
    const ownerNames = await this.loadOwnerNames([asset]);
    const likes = await this.loadLikeSummary([asset.id], user.id);
    return {
      ...this.toView(
        asset,
        user,
        Boolean(subscription),
        ownerNames.get(`${asset.ownerType}:${asset.ownerId}`),
        likes.get(asset.id)
      ),
      documents: asset.documents,
      presets: KNOWLEDGE_PRESETS
    };
  }

  async create(user: AgentHubUser, input: CreateKnowledgeInput) {
    return this.createRecord(user, input, { sourceType: "manual" });
  }

  async update(user: AgentHubUser, id: string, input: UpdateKnowledgeInput) {
    const asset = await this.assertOwner(user, id);
    const preset = input.preset ?? normalizePreset(asset.preset);
    const presetConfig = KNOWLEDGE_PRESETS[preset];
    const metadata = asRecord(asset.metadata);
    const updated = await this.prisma.knowledgeAsset.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description, summary: input.description } : {}),
        ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
        ...(input.preset !== undefined ? { preset: input.preset } : {}),
        metadata: {
          ...metadata,
          preset,
          logo: normalizeHubLogo(input.logo ?? metadata.logo, "book"),
          logoColor: normalizeHubLogoColor(input.logoColor ?? metadata.logoColor),
          chunkingStrategy: presetConfig.chunkingStrategy,
          chunkingSize: presetConfig.chunkingSize,
          chunkingOverlap: presetConfig.chunkingOverlap,
          topK: presetConfig.topK,
          scoreThreshold: presetConfig.scoreThreshold
        } as Prisma.InputJsonValue
      }
    });
    await this.prisma.workspaceAsset.updateMany({
      where: { id: updated.sourceAssetId, deletedAt: null },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { summary: input.description } : {}),
        metadata: {
          hubKind: "knowledge",
          visibility: updated.visibility,
          ownerType: updated.ownerType,
          ownerId: updated.ownerId,
          knowledgeAssetId: updated.id,
          preset,
          logo: normalizeHubLogo(input.logo ?? metadata.logo, "book"),
          logoColor: normalizeHubLogoColor(input.logoColor ?? metadata.logoColor)
        } as Prisma.InputJsonValue
      }
    });
    return this.get(user, id);
  }

  async delete(user: AgentHubUser, id: string) {
    const asset = await this.assertOwner(user, id);
    const documents = await this.prisma.knowledgeDocument.findMany({
      where: { knowledgeAssetId: id, deletedAt: null },
      select: { sourceAssetId: true }
    });
    const deletedAt = new Date();
    await this.prisma.$transaction([
      this.prisma.knowledgeChunk.updateMany({ where: { knowledgeAssetId: id, deletedAt: null }, data: { deletedAt } }),
      this.prisma.knowledgeDocument.updateMany({ where: { knowledgeAssetId: id, deletedAt: null }, data: { deletedAt } }),
      this.prisma.knowledgeSubscription.updateMany({ where: { knowledgeAssetId: id, deletedAt: null }, data: { deletedAt } }),
      this.prisma.knowledgeVersion.updateMany({ where: { knowledgeAssetId: id, deletedAt: null }, data: { deletedAt } }),
      this.prisma.knowledgeAsset.update({ where: { id }, data: { deletedAt } }),
      this.prisma.workspaceAsset.updateMany({
        where: { id: { in: [asset.sourceAssetId, ...documents.map((document) => document.sourceAssetId)] }, deletedAt: null },
        data: { deletedAt }
      }),
      this.prisma.hubAssetLike.deleteMany({ where: { kind: "knowledge", assetId: id } })
    ]);
    return { success: true };
  }

  async subscribe(user: AgentHubUser, id: string) {
    const asset = await this.prisma.knowledgeAsset.findFirst({
      where: { id, visibility: "public", deletedAt: null }
    });
    if (!asset) throw new NotFoundException("Public knowledge base not found");
    if (asset.ownerType === "user" && asset.ownerId === user.id) {
      throw new BadRequestException("不能订阅自己发布的知识库");
    }
    await this.prisma.knowledgeSubscription.upsert({
      where: {
        knowledgeAssetId_ownerType_ownerId: {
          knowledgeAssetId: id,
          ownerType: "user",
          ownerId: user.id
        }
      },
      create: { knowledgeAssetId: id, ownerType: "user", ownerId: user.id, updatePolicy: "notify" },
      update: { deletedAt: null }
    });
    return { subscribed: true };
  }

  async unsubscribe(user: AgentHubUser, id: string) {
    const result = await this.prisma.knowledgeSubscription.updateMany({
      where: { knowledgeAssetId: id, ownerType: "user", ownerId: user.id, deletedAt: null },
      data: { deletedAt: new Date() }
    });
    if (result.count === 0) throw new NotFoundException("Subscription not found");
    return { unsubscribed: true };
  }

  async fork(user: AgentHubUser, id: string) {
    const source = await this.prisma.knowledgeAsset.findFirst({
      where: { id, visibility: "public", deletedAt: null },
      include: {
        documents: {
          where: { deletedAt: null },
          include: { chunks: { where: { deletedAt: null }, orderBy: { chunkIndex: "asc" } } }
        }
      }
    });
    if (!source) throw new NotFoundException("Public knowledge base not found");
    const forked = await this.createRecord(user, {
      name: `${source.name} (Fork)`,
      description: source.description,
      preset: normalizePreset(source.preset),
      visibility: "private",
      logo: normalizeHubLogo(asRecord(source.metadata).logo, "book"),
      logoColor: normalizeHubLogoColor(asRecord(source.metadata).logoColor)
    }, {
      sourceType: "fork",
      forkedFromId: source.id,
      lineageRootId: source.lineageRootId ?? source.id
    });

    for (const document of source.documents) {
      const sourceAsset = await this.prisma.workspaceAsset.findFirst({
        where: { id: document.sourceAssetId, deletedAt: null },
        include: { workspace: true }
      });
      if (!sourceAsset) continue;
      const absolutePath = resolve(sourceAsset.workspace.rootPath, sourceAsset.path);
      if (relative(sourceAsset.workspace.rootPath, absolutePath).startsWith("..")) continue;
      const content = await readFile(absolutePath);
      await this.uploadAndIndex(user, forked.id, {
        name: sourceAsset.name,
        mimeType: sourceAsset.mimeType ?? document.mimeType ?? "application/octet-stream",
        content
      });
    }
    return this.get(user, forked.id);
  }

  async indexDocument(user: AgentHubUser, knowledgeAssetId: string, input: IndexDocumentInput) {
    const name = input.name ?? basename(input.path ?? `${input.title ?? "document"}.txt`);
    const mimeType = input.mimeType ?? inferKnowledgeMimeType(name);
    const content = input.contentBase64
      ? Buffer.from(input.contentBase64, "base64")
      : Buffer.from(input.content ?? "", "utf8");
    if (content.byteLength === 0) throw new BadRequestException("上传文件不能为空");
    return this.uploadAndIndex(user, knowledgeAssetId, { name, mimeType, content });
  }

  async search(user: AgentHubUser, knowledgeAssetId: string, input: SearchInput) {
    if (!this.config.embedding) throw new BadRequestException("Embedding is not configured");
    const asset = await this.findVisible(user, knowledgeAssetId, false);
    const presetConfig = KNOWLEDGE_PRESETS[normalizePreset(asset.preset)];
    const results = await this.indexService.search({
      knowledgeAssetId,
      query: input.query,
      topK: input.topK ?? presetConfig.topK,
      scoreThreshold: input.scoreThreshold ?? presetConfig.scoreThreshold
    });
    if (results.length > 0) {
      await this.prisma.knowledgeRetrievalLog.createMany({
        data: results.map((result) => ({
          knowledgeAssetId,
          documentId: result.documentId,
          chunkId: result.chunkId,
          conversationId: input.conversationId ?? null,
          runId: input.runId ?? null,
          callerType: input.callerType ?? "user",
          callerId: input.callerId ?? user.id,
          query: input.query,
          score: result.score,
          sourceVersion: asset.currentVersion,
          metadata: { path: result.metadata.path, title: result.metadata.title } as Prisma.InputJsonValue
        }))
      });
    }
    return results;
  }

  async listDocuments(user: AgentHubUser, knowledgeAssetId: string) {
    await this.findVisible(user, knowledgeAssetId, false);
    return this.prisma.knowledgeDocument.findMany({
      where: { knowledgeAssetId, deletedAt: null },
      orderBy: { createdAt: "desc" }
    });
  }

  async deleteDocument(user: AgentHubUser, knowledgeAssetId: string, documentId: string) {
    await this.assertOwner(user, knowledgeAssetId);
    const document = await this.prisma.knowledgeDocument.findFirst({
      where: { id: documentId, knowledgeAssetId, deletedAt: null }
    });
    if (!document) throw new NotFoundException("Knowledge document not found");
    await this.indexService.deleteDocument(documentId);
    await this.prisma.workspaceAsset.updateMany({
      where: { id: document.sourceAssetId, deletedAt: null },
      data: { deletedAt: new Date() }
    });
    await this.refreshAssetIndexState(knowledgeAssetId);
  }

  async listSubscriptions(user: AgentHubUser) {
    const subscriptions = await this.prisma.knowledgeSubscription.findMany({
      where: { ownerType: "user", ownerId: user.id, deletedAt: null },
      include: { knowledge: true },
      orderBy: { updatedAt: "desc" }
    });
    return subscriptions
      .filter((subscription) => !subscription.knowledge.deletedAt)
      .map((subscription) => ({
        ...subscription.knowledge,
        subscriptionId: subscription.id,
        updatePolicy: subscription.updatePolicy
      }));
  }

  private async createRecord(
    user: AgentHubUser,
    input: CreateKnowledgeInput,
    lineage: { sourceType: "manual" | "fork"; forkedFromId?: string; lineageRootId?: string }
  ) {
    const preset = input.preset ?? "standard";
    const visibility = input.visibility ?? "private";
    const presetConfig = KNOWLEDGE_PRESETS[preset];
    const workspaceId = await this.workspaces.ensurePersonalHubWorkspace(user);
    const manifestPath = `knowledge/${new Date().toISOString().slice(0, 10)}-${nanoid(8)}-README.md`;
    const manifest = await this.workspaces.writeTextFile(
      user,
      workspaceId,
      manifestPath,
      knowledgeManifest(input.name, input.description ?? "", preset, visibility)
    );
    const logo = normalizeHubLogo(input.logo, "book");
    const logoColor = normalizeHubLogoColor(input.logoColor);
    const fingerprint = createHash("sha256")
      .update(`${input.name}:${input.description ?? ""}:${preset}:${visibility}:${logo}:${logoColor}`)
      .digest("hex");
    const asset = await this.prisma.knowledgeAsset.create({
      data: {
        sourceAssetId: manifest.assetId,
        ownerType: "user",
        ownerId: user.id,
        name: input.name,
        description: input.description ?? "",
        visibility,
        sourceType: lineage.sourceType,
        accessScope: visibility === "public" ? "public" : "owner",
        summary: input.description ?? "",
        indexStatus: "idle",
        fileCount: 0,
        currentVersion: 1,
        currentFingerprint: fingerprint,
        preset,
        ...(lineage.forkedFromId ? { forkedFromId: lineage.forkedFromId } : {}),
        ...(lineage.lineageRootId ? { lineageRootId: lineage.lineageRootId } : {}),
        metadata: {
          preset,
          logo,
          logoColor,
          chunkingStrategy: presetConfig.chunkingStrategy,
          chunkingSize: presetConfig.chunkingSize,
          chunkingOverlap: presetConfig.chunkingOverlap,
          topK: presetConfig.topK,
          scoreThreshold: presetConfig.scoreThreshold
        } as Prisma.InputJsonValue
      }
    });
    await this.prisma.workspaceAsset.update({
      where: { id: manifest.assetId },
      data: {
        name: input.name,
        summary: input.description ?? "",
        metadata: {
          hubKind: "knowledge",
          visibility,
          ownerType: "user",
          ownerId: user.id,
          ownerUserId: user.id,
          knowledgeAssetId: asset.id,
          preset,
          logo,
          logoColor,
          source: "knowledge_builder"
        } as Prisma.InputJsonValue
      }
    });
    return this.get(user, asset.id);
  }

  private async uploadAndIndex(
    user: AgentHubUser,
    knowledgeAssetId: string,
    file: { name: string; mimeType: string; content: Buffer }
  ) {
    if (!this.config.embedding) throw new BadRequestException("Embedding is not configured");
    const asset = await this.assertOwner(user, knowledgeAssetId);
    const text = await this.extractor.extract(file);
    const workspaceId = await this.workspaces.ensurePersonalHubWorkspace(user);
    const stored = await this.workspaces.storeUploadedAsset(user, workspaceId, file);
    const sourceAssetVersion = await this.latestWorkspaceAssetVersion(stored.id);
    await this.prisma.workspaceAsset.update({
      where: { id: stored.id },
      data: {
        summary: text.replace(/\s+/g, " ").slice(0, 240),
        metadata: {
          knowledgeAssetId,
          knowledgeDocument: true,
          ownerType: "user",
          ownerId: user.id,
          extractedCharacters: text.length,
          indexStatus: "indexing"
        } as Prisma.InputJsonValue
      }
    });
    await this.prisma.knowledgeAsset.update({ where: { id: knowledgeAssetId }, data: { indexStatus: "indexing" } });
    const presetConfig = KNOWLEDGE_PRESETS[normalizePreset(asset.preset)];
    try {
      const result = await this.indexService.indexDocument({
        knowledgeAssetId,
        sourceAssetId: stored.id,
        sourceAssetVersion,
        workspaceId,
        path: stored.path,
        title: file.name.replace(/\.[^/.]+$/, ""),
        content: text,
        mimeType: file.mimeType,
        checksumSha256: createHash("sha256").update(file.content).digest("hex"),
        chunking: {
          strategy: presetConfig.chunkingStrategy,
          size: presetConfig.chunkingSize,
          overlap: presetConfig.chunkingOverlap
        }
      });
      await this.prisma.workspaceAsset.update({
        where: { id: stored.id },
        data: {
          metadata: {
            knowledgeAssetId,
            knowledgeDocument: true,
            ownerType: "user",
            ownerId: user.id,
            extractedCharacters: text.length,
            chunkCount: result.chunkCount,
            indexStatus: "indexed"
          } as Prisma.InputJsonValue
        }
      });
      await this.refreshAssetIndexState(knowledgeAssetId);
      return { ...result, assetId: stored.id, path: stored.path, title: file.name };
    } catch (error) {
      await this.prisma.workspaceAsset.update({
        where: { id: stored.id },
        data: {
          metadata: {
            knowledgeAssetId,
            knowledgeDocument: true,
            ownerType: "user",
            ownerId: user.id,
            extractedCharacters: text.length,
            indexStatus: "error",
            error: error instanceof Error ? error.message : "Unknown indexing error"
          } as Prisma.InputJsonValue
        }
      });
      await this.prisma.knowledgeAsset.update({ where: { id: knowledgeAssetId }, data: { indexStatus: "error" } });
      throw error;
    }
  }

  private async refreshAssetIndexState(knowledgeAssetId: string) {
    const fileCount = await this.prisma.knowledgeDocument.count({
      where: { knowledgeAssetId, deletedAt: null }
    });
    await this.prisma.knowledgeAsset.update({
      where: { id: knowledgeAssetId },
      data: { fileCount, indexStatus: fileCount === 0 ? "idle" : "indexed" }
    });
  }

  private async latestWorkspaceAssetVersion(sourceAssetId: string) {
    const version = await this.prisma.workspaceAssetVersion.findFirst({
      where: { assetId: sourceAssetId },
      orderBy: { version: "desc" },
      select: { version: true }
    });
    return version?.version ?? 1;
  }

  private async findVisible(user: AgentHubUser, id: string, includeDocuments: true): Promise<KnowledgeViewRecord>;
  private async findVisible(user: AgentHubUser, id: string, includeDocuments: false): Promise<KnowledgeViewRecord>;
  private async findVisible(user: AgentHubUser, id: string, includeDocuments: boolean) {
    const asset = await this.prisma.knowledgeAsset.findFirst({
      where: {
        id,
        deletedAt: null,
        OR: [
          { ownerType: "user", ownerId: user.id },
          { visibility: "public" },
          {
            subscriptions: {
              some: { ownerType: "user", ownerId: user.id, deletedAt: null }
            }
          }
        ]
      },
      include: {
        documents: includeDocuments
          ? { where: { deletedAt: null }, orderBy: { createdAt: "desc" } }
          : { where: { id: "__not_loaded__" } }
      }
    });
    if (!asset) throw new NotFoundException("Knowledge base not found");
    return asset;
  }

  private async assertOwner(user: AgentHubUser, id: string) {
    const asset = await this.prisma.knowledgeAsset.findFirst({
      where: { id, ownerType: "user", ownerId: user.id, deletedAt: null }
    });
    if (!asset) throw new NotFoundException("Knowledge base not found or access denied");
    return asset;
  }

  private toView(
    asset: KnowledgeViewRecord,
    user: AgentHubUser,
    subscribed: boolean,
    ownerName?: string,
    likes: { likeCount: number; likedByMe: boolean } = { likeCount: 0, likedByMe: false }
  ) {
    const isOwner = asset.ownerType === "user" && asset.ownerId === user.id;
    const personalKind = isOwner
      ? asset.forkedFromId
        ? "Fork"
        : asset.visibility === "public"
          ? "Public"
          : "Personal"
      : subscribed
        ? "Subscribed"
        : "Public";
    return {
      ...asset,
      fileCount: asset.documents.length,
      isOwner,
      isSubscribed: subscribed,
      ownerName: ownerName ?? asset.ownerId,
      personalKind,
      likeCount: asset.visibility === "public" ? likes.likeCount : 0,
      likedByMe: asset.visibility === "public" && likes.likedByMe,
      logo: normalizeHubLogo(asRecord(asset.metadata).logo, "book"),
      logoColor: normalizeHubLogoColor(asRecord(asset.metadata).logoColor)
    };
  }

  private async loadOwnerNames(assets: Array<{ ownerType: string; ownerId: string }>) {
    const userIds = [...new Set(assets.flatMap((asset) => asset.ownerType === "user" ? [asset.ownerId] : []))];
    const users = userIds.length > 0
      ? await this.prisma.user.findMany({ where: { id: { in: userIds }, deletedAt: null }, select: { id: true, name: true } })
      : [];
    return new Map(users.map((user) => [`user:${user.id}`, user.name]));
  }

  private async loadLikeSummary(assetIds: string[], userId: string) {
    const ids = [...new Set(assetIds)];
    if (ids.length === 0) return new Map<string, { likeCount: number; likedByMe: boolean }>();
    const counts = await this.prisma.hubAssetLike.groupBy({
      by: ["assetId"],
      where: { kind: "knowledge", assetId: { in: ids } },
      _count: { _all: true }
    });
    const liked = await this.prisma.hubAssetLike.findMany({
      where: { kind: "knowledge", assetId: { in: ids }, userId },
      select: { assetId: true }
    });
    const likedIds = new Set(liked.map((item) => item.assetId));
    const result = new Map(ids.map((id) => [id, { likeCount: 0, likedByMe: likedIds.has(id) }]));
    for (const count of counts) {
      result.set(count.assetId, { likeCount: count._count._all, likedByMe: likedIds.has(count.assetId) });
    }
    return result;
  }
}

function normalizePreset(value: string): KnowledgePreset {
  return value in KNOWLEDGE_PRESETS ? value as KnowledgePreset : "standard";
}

function realKnowledgeAssetWhere(): Prisma.KnowledgeAssetWhereInput {
  return {
    OR: [
      { sourceType: { in: ["manual", "fork"] } },
      { documents: { some: { deletedAt: null } } }
    ]
  };
}

function knowledgeManifest(name: string, description: string, preset: KnowledgePreset, visibility: string) {
  return [
    `# ${name}`,
    "",
    description || "KnowledgeHub 知识库",
    "",
    `- 检索预设：${preset}`,
    `- 可见性：${visibility}`,
    "- 原始文件保存在当前用户的 Hub 工作空间中。",
    "- Agent 通过 search_knowledge 工具按知识库 ID 检索。"
  ].join("\n");
}

function inferKnowledgeMimeType(name: string) {
  const lower = name.toLowerCase();
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "text/markdown";
  if (lower.endsWith(".json")) return "application/json";
  if (lower.endsWith(".csv")) return "text/csv";
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "text/html";
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".docx")) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  return "text/plain";
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}
