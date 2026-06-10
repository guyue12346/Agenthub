import { BadRequestException, Body, Controller, Delete, Get, Headers, Inject, Param, Patch, Post, Query, Res } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import type { AgentHubUser } from "@agenthub/shared";
import { z } from "zod";
import { CurrentUser } from "../../common/auth.decorators.js";
import { dangerousConfirmationSchema, parseBody, parseQuery } from "../../common/validation.js";
import { HUB_LOGO_COLORS, HUB_LOGO_KEYS } from "../../common/hub-appearance.js";
import { WorkspacesService } from "./workspaces.service.js";

const filePathQuerySchema = z.object({
  path: z.string().trim().min(1).max(1000)
});

const writeFileSchema = z.object({
  path: z.string().trim().min(1).max(1000),
  originalPath: z.string().trim().min(1).max(1000).optional(),
  content: z.string().max(2_000_000),
  lockToken: z.string().trim().min(1).max(200).optional(),
  expectedVersion: z.coerce.number().int().nonnegative().optional()
});

const fileLockSchema = z.object({
  path: z.string().trim().min(1).max(1000)
});

const releaseFileLockSchema = z.object({
  path: z.string().trim().min(1).max(1000),
  lockToken: z.string().trim().min(1).max(200)
});

const uploadAssetSchema = z.object({
  name: z.string().trim().min(1).max(240),
  mimeType: z.string().trim().min(1).max(120).default("application/octet-stream"),
  contentBase64: z.string().min(1).max(8_000_000)
});

const beginUploadSchema = z.object({
  name: z.string().trim().min(1).max(240),
  mimeType: z.string().trim().min(1).max(120).default("application/octet-stream"),
  size: z.coerce.number().int().positive()
});

const uploadChunkSchema = z.object({
  offset: z.coerce.number().int().min(0),
  contentBase64: z.string().min(1).max(1_400_000)
});

const rollbackAssetSchema = z.object({
  version: z.coerce.number().int().positive()
});

const versionParamSchema = z.coerce.number().int().positive();

const gitCommitSchema = z.object({
  message: z.string().trim().min(1).max(200)
});

const gitProposalSchema = z.object({
  title: z.string().trim().min(1).max(160).optional(),
  summary: z.string().trim().max(600).optional()
});

const gitRejectProposalSchema = z.object({
  reason: z.string().trim().min(1).max(1000)
});

const hubQuerySchema = z.object({
  scope: z.enum(["personal", "public", "subscribed", "fork", "published"]).default("personal")
});

const createHubTextAssetSchema = z.object({
  name: z.string().trim().min(1).max(120),
  summary: z.string().trim().max(500).optional(),
  content: z.string().trim().min(1).max(2_000_000),
  visibility: z.enum(["private", "public"]).default("private"),
  releaseVersion: z.string().trim().regex(/^v?\d+\.\d+\.\d+$/, "版本号格式应为 v0.0.1").optional(),
  logo: z.enum(HUB_LOGO_KEYS).default("sparkles"),
  logoColor: z.enum(HUB_LOGO_COLORS).default("#2563eb")
});

@Controller("workspaces")
export class WorkspacesController {
  constructor(@Inject(WorkspacesService) private readonly workspaces: WorkspacesService) {}

  @Get()
  async list(@CurrentUser() currentUser: AgentHubUser) {
    return { workspaces: await this.workspaces.listWorkspaces(currentUser) };
  }

  @Get("hub/:kind")
  async hubAssets(@CurrentUser() currentUser: AgentHubUser, @Param("kind") kind: "skill" | "knowledge", @Query() query: unknown) {
    if (kind !== "skill" && kind !== "knowledge") return { assets: [] };
    const input = parseQuery(hubQuerySchema, query);
    return { assets: await this.workspaces.listHubAssets(currentUser, kind, input.scope) };
  }

  @Post("hub/:kind")
  async createHubAsset(@CurrentUser() currentUser: AgentHubUser, @Param("kind") kind: "skill" | "knowledge", @Body() body: unknown) {
    if (kind !== "skill" && kind !== "knowledge") return { asset: null };
    const input = parseBody(createHubTextAssetSchema, body);
    return { asset: await this.workspaces.createHubTextAsset(currentUser, kind, input) };
  }

  @Patch("hub/:kind/:assetId")
  async updateHubAsset(
    @CurrentUser() currentUser: AgentHubUser,
    @Param("kind") kind: "skill" | "knowledge",
    @Param("assetId") assetId: string,
    @Body() body: unknown
  ) {
    if (kind !== "skill" && kind !== "knowledge") return { asset: null };
    const input = parseBody(createHubTextAssetSchema, body);
    return { asset: await this.workspaces.updateHubTextAsset(currentUser, kind, assetId, input) };
  }

  @Get("hub/:kind/:assetId")
  async editableHubAsset(
    @CurrentUser() currentUser: AgentHubUser,
    @Param("kind") kind: "skill" | "knowledge",
    @Param("assetId") assetId: string
  ) {
    if (kind !== "skill" && kind !== "knowledge") return { asset: null };
    return { asset: await this.workspaces.getEditableHubTextAsset(currentUser, kind, assetId) };
  }

  @Delete("hub/:kind/:assetId")
  async deleteHubAsset(
    @CurrentUser() currentUser: AgentHubUser,
    @Param("kind") kind: "skill" | "knowledge",
    @Param("assetId") assetId: string
  ) {
    if (kind !== "skill" && kind !== "knowledge") return { assetId };
    return this.workspaces.deleteHubTextAsset(currentUser, kind, assetId);
  }

  @Get(":workspaceId")
  async detail(@CurrentUser() currentUser: AgentHubUser, @Param("workspaceId") workspaceId: string) {
    return { workspace: toWorkspaceDetailView(await this.workspaces.getWorkspace(currentUser, workspaceId)) };
  }

  @Get(":workspaceId/git")
  async git(@CurrentUser() currentUser: AgentHubUser, @Param("workspaceId") workspaceId: string) {
    return { view: await this.workspaces.getWorkspaceGitView(currentUser, workspaceId) };
  }

  @Get(":workspaceId/git/diff")
  async gitFileDiff(@CurrentUser() currentUser: AgentHubUser, @Param("workspaceId") workspaceId: string, @Query() query: unknown) {
    const input = parseQuery(filePathQuerySchema, query);
    return { diff: await this.workspaces.getWorkspaceGitFileDiff(currentUser, workspaceId, input.path) };
  }

  @Post(":workspaceId/git/commit")
  async commitGitChanges(@CurrentUser() currentUser: AgentHubUser, @Param("workspaceId") workspaceId: string, @Body() body: unknown) {
    const input = parseBody(gitCommitSchema, body);
    return { view: await this.workspaces.commitGitChanges(currentUser, workspaceId, input) };
  }

  @Post(":workspaceId/git/proposals")
  async createGitProposal(@CurrentUser() currentUser: AgentHubUser, @Param("workspaceId") workspaceId: string, @Body() body: unknown) {
    const input = parseBody(gitProposalSchema, body);
    return { view: await this.workspaces.createGitReviewProposal(currentUser, workspaceId, input) };
  }

  @Post(":workspaceId/git/proposals/:proposalId/approve")
  async approveGitProposal(
    @CurrentUser() currentUser: AgentHubUser,
    @Param("workspaceId") workspaceId: string,
    @Param("proposalId") proposalId: string
  ) {
    return { view: await this.workspaces.approveGitReviewProposal(currentUser, workspaceId, proposalId) };
  }

  @Post(":workspaceId/git/proposals/:proposalId/reject")
  async rejectGitProposal(
    @CurrentUser() currentUser: AgentHubUser,
    @Param("workspaceId") workspaceId: string,
    @Param("proposalId") proposalId: string,
    @Body() body: unknown
  ) {
    const input = parseBody(gitRejectProposalSchema, body);
    return { view: await this.workspaces.rejectGitReviewProposal(currentUser, workspaceId, proposalId, input.reason) };
  }

  @Get(":workspaceId/assets")
  async assets(@CurrentUser() currentUser: AgentHubUser, @Param("workspaceId") workspaceId: string) {
    return { assets: await this.workspaces.listAssets(currentUser, workspaceId) };
  }

  @Post(":workspaceId/assets")
  async uploadAsset(@CurrentUser() currentUser: AgentHubUser, @Param("workspaceId") workspaceId: string, @Body() body: unknown) {
    const input = parseBody(uploadAssetSchema, body);
    const content = Buffer.from(input.contentBase64, "base64");
    return { asset: await this.workspaces.storeUploadedAsset(currentUser, workspaceId, { name: input.name, mimeType: input.mimeType, content }) };
  }

  @Post(":workspaceId/uploads")
  async beginUpload(@CurrentUser() currentUser: AgentHubUser, @Param("workspaceId") workspaceId: string, @Body() body: unknown) {
    const input = parseBody(beginUploadSchema, body);
    return { upload: await this.workspaces.beginUpload(currentUser, workspaceId, input) };
  }

  @Post(":workspaceId/uploads/:uploadId/chunks")
  async uploadChunk(
    @CurrentUser() currentUser: AgentHubUser,
    @Param("workspaceId") workspaceId: string,
    @Param("uploadId") uploadId: string,
    @Body() body: unknown
  ) {
    const input = parseBody(uploadChunkSchema, body);
    const content = Buffer.from(input.contentBase64, "base64");
    return { upload: await this.workspaces.appendUploadChunk(currentUser, workspaceId, uploadId, { offset: input.offset, content }) };
  }

  @Post(":workspaceId/uploads/:uploadId/complete")
  async completeUpload(
    @CurrentUser() currentUser: AgentHubUser,
    @Param("workspaceId") workspaceId: string,
    @Param("uploadId") uploadId: string
  ) {
    return { asset: await this.workspaces.completeUpload(currentUser, workspaceId, uploadId) };
  }

  @Delete(":workspaceId/uploads/:uploadId")
  async cancelUpload(
    @CurrentUser() currentUser: AgentHubUser,
    @Param("workspaceId") workspaceId: string,
    @Param("uploadId") uploadId: string
  ) {
    return this.workspaces.cancelUpload(currentUser, workspaceId, uploadId);
  }

  @Get(":workspaceId/assets/:assetId")
  async asset(
    @CurrentUser() currentUser: AgentHubUser,
    @Param("workspaceId") workspaceId: string,
    @Param("assetId") assetId: string
  ) {
    return { asset: await this.workspaces.getAsset(currentUser, workspaceId, assetId) };
  }

  @Get(":workspaceId/assets/:assetId/content")
  async assetContent(
    @CurrentUser() currentUser: AgentHubUser,
    @Param("workspaceId") workspaceId: string,
    @Param("assetId") assetId: string,
    @Headers("if-none-match") ifNoneMatch: string | undefined,
    @Res() reply: FastifyReply
  ) {
    const result = await this.workspaces.readAssetContent(currentUser, workspaceId, assetId);
    reply
      .type(result.mimeType)
      .header("Cache-Control", "private, max-age=0, must-revalidate")
      .header("Content-Disposition", `inline; filename="${encodeURIComponent(result.asset.name)}"`)
      .header("X-Content-Type-Options", "nosniff");
    if (result.etag) reply.header("ETag", result.etag);
    if (result.checksumSha256) reply.header("X-Checksum-SHA256", result.checksumSha256);
    if (result.etag && ifNoneMatchMatches(ifNoneMatch, result.etag)) return reply.status(304).send();
    return reply
      .header("Content-Length", result.size)
      .send(result.content);
  }

  @Get(":workspaceId/assets/:assetId/versions")
  async assetVersions(
    @CurrentUser() currentUser: AgentHubUser,
    @Param("workspaceId") workspaceId: string,
    @Param("assetId") assetId: string
  ) {
    return { versions: await this.workspaces.listAssetVersions(currentUser, workspaceId, assetId) };
  }

  @Get(":workspaceId/assets/:assetId/versions/:version/content")
  async assetVersionContent(
    @CurrentUser() currentUser: AgentHubUser,
    @Param("workspaceId") workspaceId: string,
    @Param("assetId") assetId: string,
    @Param("version") version: string,
    @Res() reply: FastifyReply
  ) {
    const versionNumber = parseVersionParam(version);
    const result = await this.workspaces.readAssetVersionContent(currentUser, workspaceId, assetId, versionNumber);
    reply
      .type(result.mimeType)
      .header("Cache-Control", "private, max-age=0, must-revalidate")
      .header("Content-Disposition", `inline; filename="${encodeURIComponent(result.name)}"`)
      .header("X-Content-Type-Options", "nosniff")
      .header("X-Checksum-SHA256", result.checksumSha256);
    return reply
      .header("Content-Length", result.size)
      .send(result.content);
  }

  @Get(":workspaceId/assets/:assetId/versions/:version")
  async assetVersion(
    @CurrentUser() currentUser: AgentHubUser,
    @Param("workspaceId") workspaceId: string,
    @Param("assetId") assetId: string,
    @Param("version") version: string
  ) {
    const versionNumber = parseVersionParam(version);
    return { version: await this.workspaces.readAssetVersion(currentUser, workspaceId, assetId, versionNumber) };
  }

  @Post(":workspaceId/assets/:assetId/rollback")
  async rollbackAsset(
    @CurrentUser() currentUser: AgentHubUser,
    @Param("workspaceId") workspaceId: string,
    @Param("assetId") assetId: string,
    @Body() body: unknown
  ) {
    const input = parseBody(rollbackAssetSchema, body);
    return { asset: await this.workspaces.rollbackAssetVersion(currentUser, workspaceId, assetId, input.version) };
  }

  @Delete(":workspaceId/assets/:assetId")
  async deleteAsset(
    @CurrentUser() currentUser: AgentHubUser,
    @Param("workspaceId") workspaceId: string,
    @Param("assetId") assetId: string,
    @Body() body: unknown
  ) {
    const input = parseBody(dangerousConfirmationSchema, body);
    return this.workspaces.deleteAsset(currentUser, workspaceId, assetId, input.confirm);
  }

  @Get(":workspaceId/tree")
  async tree(@CurrentUser() currentUser: AgentHubUser, @Param("workspaceId") workspaceId: string) {
    return { tree: await this.workspaces.listFileTree(currentUser, workspaceId) };
  }

  @Get(":workspaceId/files")
  async readFile(@CurrentUser() currentUser: AgentHubUser, @Param("workspaceId") workspaceId: string, @Query() query: unknown) {
    const input = parseQuery(filePathQuerySchema, query);
    return { file: await this.workspaces.readFile(currentUser, workspaceId, input.path) };
  }

  @Post(":workspaceId/files/lock")
  async acquireFileLock(@CurrentUser() currentUser: AgentHubUser, @Param("workspaceId") workspaceId: string, @Body() body: unknown) {
    const input = parseBody(fileLockSchema, body);
    return { lock: await this.workspaces.acquireFileLock(currentUser, workspaceId, input.path) };
  }

  @Delete(":workspaceId/files/lock")
  async releaseFileLock(@CurrentUser() currentUser: AgentHubUser, @Param("workspaceId") workspaceId: string, @Body() body: unknown) {
    const input = parseBody(releaseFileLockSchema, body);
    return { lock: await this.workspaces.releaseFileLock(currentUser, workspaceId, input.path, input.lockToken) };
  }

  @Post(":workspaceId/files")
  async writeFile(@CurrentUser() currentUser: AgentHubUser, @Param("workspaceId") workspaceId: string, @Body() body: unknown) {
    const input = parseBody(writeFileSchema, body);
    const options = {
      ...(input.originalPath ? { originalPath: input.originalPath } : {}),
      ...(input.lockToken ? { lockToken: input.lockToken } : {}),
      ...(input.expectedVersion !== undefined ? { expectedVersion: input.expectedVersion } : {}),
      requireLock: true
    };
    return {
      file: await this.workspaces.writeTextFile(currentUser, workspaceId, input.path, input.content, options)
    };
  }
}

function toWorkspaceDetailView(workspace: Awaited<ReturnType<WorkspacesService["getWorkspace"]>>) {
  const { rootPath: _rootPath, ...view } = workspace;
  return view;
}

function ifNoneMatchMatches(value: string | undefined, etag: string) {
  if (!value) return false;
  return value.split(",").map((item) => item.trim()).some((item) => item === "*" || item === etag || item === `W/${etag}`);
}

function parseVersionParam(version: string) {
  const parsed = versionParamSchema.safeParse(version);
  if (!parsed.success) throw new BadRequestException("Invalid asset version");
  return parsed.data;
}
