import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { access, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { nanoid } from "nanoid";
import { createMarkdownBlock, type AgentHubUser, type MessageBlock } from "@agenthub/shared";
import { PrismaService } from "../../common/prisma.service.js";
import { ensureWorkspaceLayout, WORKSPACE_CODE_DIR, WORKSPACE_DOCS_DIR } from "../../common/workspace-layout.js";
import { Prisma } from "../../generated/prisma/client.js";
import { toChatMessage } from "../messages/messages.service.js";
import { RealtimeService } from "../realtime/realtime.service.js";
import { toAgentHubUser } from "../users/users.service.js";
import { WorkspacesService } from "../workspaces/workspaces.service.js";

const DEPLOY_AGENT = {
  id: "agent-deploy",
  name: "Deploy Agent",
  avatar: "/avatars/agents/agent-v2-07.png",
  subtitle: "部署 Agent"
};
const STATIC_PREVIEW_TARGET = "static_preview";
const DEPLOY_COMMAND_TIMEOUT_MS = 20 * 60_000;
const MAX_LOG_BYTES = 1_000_000;

type StaticPreviewInput = {
  workspaceId: string;
  conversationId?: string;
  triggerMessageId?: string;
  title?: string;
};
type BuildProfile = {
  kind: "node_static" | "plain_static";
  packageManager?: "npm" | "pnpm" | "yarn";
  installCommand?: string[];
  buildCommand?: string[];
  outputPath: string;
  notes: string[];
};

@Injectable()
export class DeploymentsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(RealtimeService) private readonly realtime: RealtimeService,
    @Inject(WorkspacesService) private readonly workspaces: WorkspacesService
  ) {}

  async startStaticPreviewDeployment(currentUser: AgentHubUser, input: StaticPreviewInput) {
    const workspace = await this.assertWorkspaceMember(currentUser, input.workspaceId, input.conversationId);
    await ensureWorkspaceLayout(workspace.rootPath);
    const deploymentId = `deploy-${nanoid(10)}`;
    const previewUrl = `/api/deployments/${encodeURIComponent(deploymentId)}/preview/`;
    const now = new Date();
    const deploymentTitle = input.title ?? "静态预览部署";
    const statusMessage = await this.createDeploymentMessage(workspace.conversationId, [
      createMarkdownBlock(`block-${nanoid(8)}`, `@deploy 已收到部署请求，开始准备静态预览。`),
      this.createDeployStatusBlock({
        deploymentId,
        status: "queued",
        title: deploymentTitle,
        detail: "部署任务已进入队列，正在检查 Code/ 工作区。",
        previewUrl
      }),
      this.createDeploymentWebPreviewBlock({
        title: deploymentTitle,
        url: previewUrl,
        status: "starting"
      })
    ], { deploymentId, triggerMessageId: input.triggerMessageId });
    const deployment = await this.prisma.deployment.create({
      data: {
        id: deploymentId,
        workspaceId: workspace.id,
        conversationId: workspace.conversationId,
        triggerMessageId: input.triggerMessageId ?? null,
        statusMessageId: statusMessage.id,
        requestedByUserId: currentUser.id,
        target: STATIC_PREVIEW_TARGET,
        status: "queued",
        sourceRef: {
          type: "workspace_code",
          root: WORKSPACE_CODE_DIR,
          requestedAt: now.toISOString()
        } as Prisma.InputJsonValue,
        previewUrl
      }
    });
    void this.runStaticPreviewDeployment(deployment.id).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      void this.failDeployment(deployment.id, message);
    });
    return this.toDeploymentView(deployment);
  }

  async startStaticPreviewDeploymentFromRuntime(input: {
    userId: string;
    conversationId: string;
    triggerMessageId?: string | undefined;
    title?: string | undefined;
  }) {
    const user = await this.prisma.user.findFirst({ where: { id: input.userId, deletedAt: null } });
    if (!user) throw new NotFoundException("User not found");
    const currentUser = toAgentHubUser(user);
    const conversation = await this.prisma.conversation.findFirst({
      where: { id: input.conversationId, type: "project", deletedAt: null },
      include: { workspace: true }
    });
    if (!conversation) throw new NotFoundException("Project conversation not found");
    const workspaceId = conversation.workspace?.id ?? await this.workspaces.ensureConversationWorkspace(currentUser, input.conversationId);
    return this.startStaticPreviewDeployment(currentUser, {
      workspaceId,
      conversationId: input.conversationId,
      ...(input.triggerMessageId ? { triggerMessageId: input.triggerMessageId } : {}),
      ...(input.title ? { title: input.title } : {})
    });
  }

  async getDeployment(currentUser: AgentHubUser, deploymentId: string) {
    const deployment = await this.assertDeploymentVisible(currentUser, deploymentId);
    return this.toDeploymentView(deployment);
  }

  async stopDeployment(currentUser: AgentHubUser, deploymentId: string) {
    const deployment = await this.assertDeploymentVisible(currentUser, deploymentId);
    if (deployment.status === "cancelled") return this.toDeploymentView(deployment);
    const updated = await this.prisma.deployment.update({
      where: { id: deployment.id },
      data: { status: "cancelled", stoppedAt: new Date() }
    });
    await this.updateDeploymentStatusMessage(updated.id, {
      status: "cancelled",
      detail: "预览已停止。"
    });
    return this.toDeploymentView(updated);
  }

  async servePreviewFile(currentUser: AgentHubUser, deploymentId: string, requestPath: string, reply: FastifyReply) {
    const deployment = await this.assertDeploymentVisible(currentUser, deploymentId);
    if (deployment.status !== "ready" || !deployment.outputPath) throw new NotFoundException("部署预览尚未就绪");
    const workspace = await this.prisma.workspace.findFirst({ where: { id: deployment.workspaceId, deletedAt: null } });
    if (!workspace) throw new NotFoundException("Workspace not found");
    const outputRoot = await realpath(resolve(workspace.rootPath, deployment.outputPath));
    const filePath = await this.resolvePreviewPath(outputRoot, requestPath);
    const content = await readFile(filePath);
    const mimeType = mimeTypeForPath(filePath);
    const body = mimeType === "text/html"
      ? rewriteHtmlForPreview(content.toString("utf8"), `/api/deployments/${encodeURIComponent(deployment.id)}/preview/`)
      : content;
    return reply
      .type(mimeType)
      .header("Cache-Control", "no-store")
      .header("X-Content-Type-Options", "nosniff")
      .send(body);
  }

  private async runStaticPreviewDeployment(deploymentId: string) {
    const deployment = await this.prisma.deployment.findUniqueOrThrow({ where: { id: deploymentId }, include: { workspace: true } });
    const logLines: string[] = [];
    await this.transitionDeployment(deploymentId, {
      status: "building",
      startedAt: new Date(),
      detail: "正在识别构建方式。"
    });
    const workspaceRoot = deployment.workspace.rootPath;
    await ensureWorkspaceLayout(workspaceRoot);
    const codeRoot = await realpath(resolve(workspaceRoot, WORKSPACE_CODE_DIR));
    const profile = await this.detectBuildProfile(codeRoot, logLines);
    await this.transitionDeployment(deploymentId, {
      status: "building",
      profile: profile as unknown as Prisma.InputJsonValue,
      buildCommand: profile.buildCommand?.join(" ") ?? null,
      detail: profile.buildCommand ? `正在执行 ${profile.buildCommand.join(" ")}` : "无需构建，使用静态文件直接预览。"
    });

    if (profile.installCommand) {
      await this.runControlledCommand(profile.installCommand[0]!, profile.installCommand.slice(1), codeRoot, logLines);
    }
    if (profile.buildCommand) {
      await this.runControlledCommand(profile.buildCommand[0]!, profile.buildCommand.slice(1), codeRoot, logLines);
    }

    const resolvedOutputPath = profile.buildCommand
      ? await firstExistingStaticOutput(codeRoot, ["dist", "build", "out", "."], false)
      : profile.outputPath;
    const outputAbs = await realpath(resolve(codeRoot, resolvedOutputPath));
    if (!outputAbs.startsWith(`${codeRoot}/`) && outputAbs !== codeRoot) throw new Error("部署输出目录越界");
    await ensureReadableFile(resolve(outputAbs, "index.html"));
    const outputPath = join(WORKSPACE_CODE_DIR, resolvedOutputPath).replaceAll("\\", "/");
    const logAsset = await this.writeDeploymentLogAsset(deployment.workspaceId, deployment.id, logLines);
    const updated = await this.prisma.deployment.update({
      where: { id: deployment.id },
      data: {
        status: "ready",
        outputPath,
        logAssetId: logAsset.id,
        readyAt: new Date(),
        error: null
      }
    });
    await this.updateDeploymentStatusMessage(deployment.id, {
      status: "ready",
      detail: `静态预览已就绪，输出目录：${outputPath}`,
      logAssetId: logAsset.id
    });
    await this.prisma.conversation.update({
      where: { id: updated.conversationId },
      data: { updatedAt: new Date(), lastMessage: "静态预览部署已就绪" }
    });
  }

  private async failDeployment(deploymentId: string, error: string) {
    const deployment = await this.prisma.deployment.findUnique({ where: { id: deploymentId } });
    if (!deployment) return;
    const logAsset = await this.writeDeploymentLogAsset(deployment.workspaceId, deployment.id, [`部署失败：${error}`]).catch(() => null);
    const updated = await this.prisma.deployment.update({
      where: { id: deployment.id },
      data: {
        status: "failed",
        error,
        ...(logAsset ? { logAssetId: logAsset.id } : {})
      }
    });
    await this.updateDeploymentStatusMessage(updated.id, {
      status: "failed",
      detail: "部署失败，查看日志定位原因。",
      ...(logAsset?.id ? { logAssetId: logAsset.id } : {}),
      error
    });
  }

  private async detectBuildProfile(codeRoot: string, logLines: string[]): Promise<BuildProfile> {
    const packageJsonPath = resolve(codeRoot, "package.json");
    const hasPackageJson = await fileExists(packageJsonPath);
    if (!hasPackageJson) {
      await ensureReadableFile(resolve(codeRoot, "index.html"));
      logLines.push("未发现 package.json，按普通静态站点托管 Code/index.html。");
      return { kind: "plain_static", outputPath: ".", notes: ["plain static site"] };
    }

    const pkg = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const packageManager = await this.detectPackageManager(codeRoot);
    const hasDependencies = Boolean(Object.keys(pkg.dependencies ?? {}).length || Object.keys(pkg.devDependencies ?? {}).length);
    const nodeModulesExists = await fileExists(resolve(codeRoot, "node_modules"));
    const installCommand = hasDependencies && !nodeModulesExists ? packageManagerInstallCommand(packageManager) : undefined;
    const buildCommand = pkg.scripts?.build ? packageManagerRunCommand(packageManager, "build") : undefined;
    const outputCandidates = buildCommand ? ["dist", "build", "out", "."] : [".", "dist", "build", "out"];
    const outputPath = await firstExistingStaticOutput(codeRoot, outputCandidates, Boolean(buildCommand));
    logLines.push(`识别到 Node 静态项目，包管理器：${packageManager}。`);
    if (installCommand) logLines.push(`准备安装依赖：${installCommand.join(" ")}`);
    if (buildCommand) logLines.push(`准备构建：${buildCommand.join(" ")}`);
    return {
      kind: "node_static",
      packageManager,
      ...(installCommand ? { installCommand } : {}),
      ...(buildCommand ? { buildCommand } : {}),
      outputPath,
      notes: ["node static site"]
    };
  }

  private async detectPackageManager(codeRoot: string): Promise<"npm" | "pnpm" | "yarn"> {
    if (await fileExists(resolve(codeRoot, "pnpm-lock.yaml"))) return "pnpm";
    if (await fileExists(resolve(codeRoot, "yarn.lock"))) return "yarn";
    return "npm";
  }

  private async runControlledCommand(command: string, args: string[], cwd: string, logLines: string[]) {
    const allowed = new Set(["npm", "pnpm", "yarn"]);
    if (!allowed.has(command)) throw new Error(`部署执行器不允许运行命令：${command}`);
    logLines.push(`$ ${command} ${args.join(" ")}`);
    await new Promise<void>((resolvePromise, reject) => {
      const child = spawn(command, args, {
        cwd,
        env: sanitizeEnv(process.env),
        stdio: ["ignore", "pipe", "pipe"]
      });
      let settled = false;
      const timeout = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error(`部署命令超时：${command} ${args.join(" ")}`));
      }, DEPLOY_COMMAND_TIMEOUT_MS);
      const onData = (chunk: Buffer) => {
        appendBoundedLog(logLines, chunk.toString("utf8"));
      };
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);
      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(error);
      });
      child.on("exit", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (code === 0) {
          resolvePromise();
          return;
        }
        reject(new Error(`部署命令失败：${command} ${args.join(" ")}，退出码 ${code ?? "unknown"}`));
      });
    });
  }

  private async writeDeploymentLogAsset(workspaceId: string, deploymentId: string, logLines: string[]) {
    const workspace = await this.prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } });
    const relativePath = join(WORKSPACE_DOCS_DIR, "deployments", deploymentId, "deploy.log").replaceAll("\\", "/");
    const absolutePath = resolve(workspace.rootPath, relativePath);
    await mkdir(dirname(absolutePath), { recursive: true });
    const content = trimLog(logLines.join("\n"));
    await writeFile(absolutePath, content || "部署执行未产生日志。\n", "utf8");
    const fileStat = await stat(absolutePath);
    const checksumSha256 = createHash("sha256").update(await readFile(absolutePath)).digest("hex");
    const assetId = `asset-${nanoid(10)}`;
    return this.prisma.workspaceAsset.create({
      data: {
        id: assetId,
        workspaceId,
        kind: "log",
        name: "deploy.log",
        path: relativePath,
        mimeType: "text/plain",
        size: fileStat.size,
        summary: `Deployment ${deploymentId} 执行日志`,
        metadata: { deploymentId, assetRole: "deployment_log" } as Prisma.InputJsonValue,
        versions: {
          create: {
            version: 1,
            path: relativePath,
            size: fileStat.size,
            checksumSha256,
            metadata: { deploymentId } as Prisma.InputJsonValue
          }
        }
      }
    });
  }

  private async createDeploymentMessage(conversationId: string, blocks: MessageBlock[], metadata: Record<string, unknown>) {
    const message = await this.prisma.$transaction(async (tx) => {
      const seq = await this.nextMessageSeq(tx, conversationId);
      const created = await tx.message.create({
        data: {
          id: `msg-${nanoid(10)}`,
          conversationId,
          senderType: "agent",
          senderId: DEPLOY_AGENT.id,
          senderName: DEPLOY_AGENT.name,
          senderAvatar: DEPLOY_AGENT.avatar,
          senderSubtitle: DEPLOY_AGENT.subtitle,
          blocks: blocks as unknown as Prisma.InputJsonValue,
          mentions: ["deploy"] as unknown as Prisma.InputJsonValue,
          metadata: { kind: "deployment_status", ...metadata } as Prisma.InputJsonValue,
          seq,
          status: "processing"
        }
      });
      await tx.conversation.update({
        where: { id: conversationId },
        data: { lastMessage: "部署任务已开始", updatedAt: new Date() }
      });
      await tx.conversationMember.updateMany({
        where: { conversationId, memberType: "user", deletedAt: null },
        data: { unreadCount: { increment: 1 } }
      });
      return created;
    });
    const chatMessage = toChatMessage(message);
    await this.realtime.emit("conversation", conversationId, "message.created", { message: chatMessage });
    await this.emitConversationUpdated(conversationId);
    return chatMessage;
  }

  private async updateDeploymentStatusMessage(
    deploymentId: string,
    patch: {
      status: "queued" | "building" | "ready" | "failed" | "cancelled";
      detail?: string;
      logAssetId?: string;
      artifactAssetId?: string;
      error?: string;
    }
  ) {
    const deployment = await this.prisma.deployment.findUnique({ where: { id: deploymentId } });
    if (!deployment?.statusMessageId) return;
    const message = await this.prisma.message.findUnique({ where: { id: deployment.statusMessageId } });
    if (!message) return;
    const previewStatus = deployStatusToWebPreviewStatus(patch.status);
    const previewUrl = deployment.previewUrl ?? undefined;
    const blocks = (message.blocks as unknown as MessageBlock[]).map((block) => {
      if (block.type === "web_preview") {
        return {
          ...block,
          payload: {
            ...block.payload,
            ...(previewUrl ? { url: previewUrl } : {}),
            status: previewStatus
          }
        } satisfies MessageBlock;
      }
      if (block.type !== "deploy_status") return block;
      return {
        ...block,
        payload: {
          ...block.payload,
          deploymentId,
          status: patch.status,
          detail: patch.detail ?? block.payload.detail,
          previewUrl: deployment.previewUrl ?? block.payload.previewUrl,
          ...(patch.logAssetId ? { logAssetId: patch.logAssetId } : {}),
          ...(patch.artifactAssetId ? { artifactAssetId: patch.artifactAssetId } : {}),
          ...(patch.error ? { error: patch.error } : { error: undefined })
        }
      } satisfies MessageBlock;
    });
    const updated = await this.prisma.message.update({
      where: { id: message.id },
      data: {
        blocks: blocks as unknown as Prisma.InputJsonValue,
        status: patch.status === "failed" ? "failed" : patch.status === "ready" || patch.status === "cancelled" ? "sent" : "processing"
      }
    });
    await this.realtime.emit("conversation", updated.conversationId, "message.updated", { message: toChatMessage(updated) });
    await this.emitConversationUpdated(updated.conversationId);
  }

  private createDeployStatusBlock(input: {
    deploymentId: string;
    status: "queued" | "building" | "ready" | "failed" | "cancelled";
    title: string;
    detail: string;
    previewUrl: string;
  }): MessageBlock {
    return {
      blockId: `block-${nanoid(8)}`,
      schemaVersion: 1,
      type: "deploy_status",
      payload: {
        deploymentId: input.deploymentId,
        target: STATIC_PREVIEW_TARGET,
        status: input.status,
        title: input.title,
        detail: input.detail,
        previewUrl: input.previewUrl
      }
    };
  }

  private createDeploymentWebPreviewBlock(input: {
    title: string;
    url: string;
    status: "starting" | "ready" | "failed";
  }): MessageBlock {
    return {
      blockId: `block-${nanoid(8)}`,
      schemaVersion: 1,
      type: "web_preview",
      payload: {
        title: input.title,
        url: input.url,
        status: input.status
      }
    };
  }

  private async transitionDeployment(
    deploymentId: string,
    patch: {
      status: "queued" | "building" | "ready" | "failed" | "cancelled";
      detail: string;
      startedAt?: Date;
      profile?: Prisma.InputJsonValue;
      buildCommand?: string | null;
    }
  ) {
    await this.prisma.deployment.update({
      where: { id: deploymentId },
      data: {
        status: patch.status,
        ...(patch.startedAt ? { startedAt: patch.startedAt } : {}),
        ...(patch.profile ? { profile: patch.profile } : {}),
        ...(patch.buildCommand !== undefined ? { buildCommand: patch.buildCommand } : {})
      }
    });
    await this.updateDeploymentStatusMessage(deploymentId, {
      status: patch.status,
      detail: patch.detail
    });
  }

  private async resolvePreviewPath(outputRoot: string, requestPath: string) {
    const normalized = requestPath.replaceAll("\\", "/").replace(/^\/+/, "");
    if (normalized.split("/").some((segment) => segment === "..")) throw new ForbiddenException("Invalid preview path");
    const candidate = resolve(outputRoot, normalized || "index.html");
    const candidateStat = await stat(candidate).catch(() => null);
    const resolved = candidateStat?.isDirectory() ? resolve(candidate, "index.html") : candidate;
    const real = await realpath(resolved).catch(() => realpath(resolve(outputRoot, "index.html")));
    if (!real.startsWith(`${outputRoot}/`) && real !== outputRoot) throw new ForbiddenException("Preview path is outside output root");
    return real;
  }

  private async assertWorkspaceMember(currentUser: AgentHubUser, workspaceId: string, conversationId?: string) {
    const workspace = await this.prisma.workspace.findFirst({
      where: {
        id: workspaceId,
        deletedAt: null,
        ...(conversationId ? { conversationId } : {}),
        conversation: {
          deletedAt: null,
          type: "project",
          members: {
            some: { memberType: "user", memberId: currentUser.id, deletedAt: null, archivedAt: null }
          }
        }
      }
    });
    if (!workspace) throw new NotFoundException("Workspace not found");
    return workspace;
  }

  private async assertDeploymentVisible(currentUser: AgentHubUser, deploymentId: string) {
    const deployment = await this.prisma.deployment.findFirst({
      where: {
        id: deploymentId,
        deletedAt: null,
        conversation: {
          deletedAt: null,
          members: {
            some: { memberType: "user", memberId: currentUser.id, deletedAt: null }
          }
        }
      }
    });
    if (!deployment) throw new NotFoundException("Deployment not found");
    return deployment;
  }

  private async nextMessageSeq(tx: Prisma.TransactionClient, conversationId: string) {
    const conversation = await tx.conversation.update({
      where: { id: conversationId },
      data: { messageSeq: { increment: 1 } },
      select: { messageSeq: true }
    });
    return conversation.messageSeq;
  }

  private async emitConversationUpdated(conversationId: string) {
    const members = await this.prisma.conversationMember.findMany({
      where: { conversationId, memberType: "user", deletedAt: null },
      select: { memberId: true }
    });
    for (const member of members) {
      await this.realtime.emit("user", member.memberId, "conversation.updated", { conversationId, reason: "deployment_updated" });
    }
  }

  private toDeploymentView(deployment: {
    id: string;
    workspaceId: string;
    conversationId: string;
    triggerMessageId: string | null;
    statusMessageId: string | null;
    requestedByUserId: string;
    target: string;
    status: string;
    sourceRef: unknown;
    profile: unknown;
    buildCommand: string | null;
    outputPath: string | null;
    previewUrl: string | null;
    logAssetId: string | null;
    artifactAssetId: string | null;
    error: string | null;
    createdAt: Date;
    updatedAt: Date;
    startedAt: Date | null;
    readyAt: Date | null;
    stoppedAt: Date | null;
  }) {
    return {
      id: deployment.id,
      workspaceId: deployment.workspaceId,
      conversationId: deployment.conversationId,
      triggerMessageId: deployment.triggerMessageId,
      statusMessageId: deployment.statusMessageId,
      requestedByUserId: deployment.requestedByUserId,
      target: deployment.target,
      status: deployment.status,
      sourceRef: deployment.sourceRef,
      profile: deployment.profile,
      buildCommand: deployment.buildCommand,
      outputPath: deployment.outputPath,
      previewUrl: deployment.previewUrl,
      logAssetId: deployment.logAssetId,
      artifactAssetId: deployment.artifactAssetId,
      error: deployment.error,
      createdAt: deployment.createdAt.toISOString(),
      updatedAt: deployment.updatedAt.toISOString(),
      startedAt: deployment.startedAt?.toISOString() ?? null,
      readyAt: deployment.readyAt?.toISOString() ?? null,
      stoppedAt: deployment.stoppedAt?.toISOString() ?? null
    };
  }
}

async function ensureReadableFile(filePath: string) {
  try {
    await access(filePath);
  } catch {
    throw new Error(`缺少可预览入口文件：${filePath}`);
  }
}

async function fileExists(filePath: string) {
  return access(filePath).then(() => true).catch(() => false);
}

function packageManagerInstallCommand(packageManager: "npm" | "pnpm" | "yarn") {
  if (packageManager === "pnpm") return ["pnpm", "install", "--frozen-lockfile"];
  if (packageManager === "yarn") return ["yarn", "install", "--frozen-lockfile"];
  return ["npm", "install", "--no-audit", "--no-fund"];
}

function packageManagerRunCommand(packageManager: "npm" | "pnpm" | "yarn", script: string) {
  if (packageManager === "pnpm") return ["pnpm", "run", script];
  if (packageManager === "yarn") return ["yarn", script];
  return ["npm", "run", script];
}

async function firstExistingStaticOutput(codeRoot: string, candidates: string[], deferUntilAfterBuild: boolean) {
  if (deferUntilAfterBuild) return candidates[0] ?? "dist";
  for (const candidate of candidates) {
    if (await fileExists(resolve(codeRoot, candidate, "index.html"))) return candidate;
  }
  return ".";
}

function sanitizeEnv(env: NodeJS.ProcessEnv) {
  const allowedKeys = ["PATH", "HOME", "USER", "TMPDIR", "LANG", "LC_ALL", "NODE_ENV"];
  const next: NodeJS.ProcessEnv = { NODE_ENV: "production" };
  for (const key of allowedKeys) {
    if (env[key]) next[key] = env[key];
  }
  return next;
}

function appendBoundedLog(logLines: string[], chunk: string) {
  logLines.push(...chunk.split(/\r?\n/).filter(Boolean));
  let total = logLines.join("\n").length;
  while (total > MAX_LOG_BYTES && logLines.length > 1) {
    total -= (logLines.shift()?.length ?? 0) + 1;
  }
}

function trimLog(log: string) {
  if (log.length <= MAX_LOG_BYTES) return log;
  return log.slice(log.length - MAX_LOG_BYTES);
}

function deployStatusToWebPreviewStatus(status: "queued" | "building" | "ready" | "failed" | "cancelled") {
  if (status === "ready") return "ready";
  if (status === "failed" || status === "cancelled") return "failed";
  return "starting";
}

function mimeTypeForPath(filePath: string) {
  const ext = extname(filePath).toLowerCase();
  if (ext === ".html" || ext === ".htm") return "text/html";
  if (ext === ".js" || ext === ".mjs") return "text/javascript";
  if (ext === ".css") return "text/css";
  if (ext === ".json") return "application/json";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  if (ext === ".ico") return "image/x-icon";
  if (ext === ".txt") return "text/plain";
  return "application/octet-stream";
}

function rewriteHtmlForPreview(html: string, previewBase: string) {
  return html
    .replace(/(src|href)="\/(?!\/)/g, `$1="${previewBase}`)
    .replace(/(src|href)='\/(?!\/)/g, `$1='${previewBase}`);
}
