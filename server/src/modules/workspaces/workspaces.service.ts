import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { createMarkdownBlock, type AgentHubUser, type ChatMessage, type MessageBlock, type WorkspaceAsset } from "@agenthub/shared";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { appendFile, copyFile, mkdir, open, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { nanoid } from "nanoid";
import { PrismaService } from "../../common/prisma.service.js";
import { ConfigService } from "../../common/config.service.js";
import { assertDangerousConfirmation } from "../../common/validation.js";
import { isInsideAnyWorkspaceRootRealpath } from "../../common/workspace-roots.js";
import { WORKSPACE_CODE_DIR, ensureWorkspaceLayout } from "../../common/workspace-layout.js";
import { normalizeHubLogo, normalizeHubLogoColor } from "../../common/hub-appearance.js";
import { Prisma, type Message } from "../../generated/prisma/client.js";
import { RealtimeService } from "../realtime/realtime.service.js";

export interface WorkspaceTreeNode {
  name: string;
  path: string;
  type: "file" | "directory";
  size?: number;
  children?: WorkspaceTreeNode[];
}

type HubKind = "skill" | "knowledge";
type WorkspaceHubAssetRecord = Prisma.WorkspaceAssetGetPayload<{
  include: {
    workspace: {
      include: {
        conversation: {
          include: {
            members: true;
          };
        };
      };
    };
  };
}>;
type SkillHubAssetRecord = Prisma.SkillAssetGetPayload<{
  include: {
    versions: {
      where: { deletedAt: null };
      orderBy: { version: "desc" };
      take: 1;
    };
  };
}>;
type HubAssetScope = "personal" | "public" | "subscribed" | "fork" | "published";
type HubAssetLikeSummary = { likeCount: number; likedByMe: boolean };
type WriteWorkspaceFileOptions = {
  originalPath?: string;
  lockToken?: string;
  expectedVersion?: number;
  requireLock?: boolean;
};
type CodeContributor = {
  id: string | null;
  name: string;
  avatar: string | null;
  role: "user" | "agent" | "unknown";
  email: string | null;
  contributions: number;
  lastChangedAt: string | null;
};
type CodeFileContribution = {
  path: string;
  workspacePath: string;
  contributors: CodeContributor[];
  lastChangedAt: string | null;
};

const MAX_LEGACY_UPLOAD_BYTES = 5_000_000;
export const MAX_WORKSPACE_UPLOAD_BYTES = 50_000_000;
export const MAX_WORKSPACE_UPLOAD_CHUNK_BYTES = 1_000_000;
const MAX_TEXT_FILE_BYTES = 2_000_000;
const UPLOAD_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const FILE_LOCK_TTL_MS = 90 * 1000;
const UPLOAD_SCAN_HEADER_BYTES = 8;
const BLOCKED_UPLOAD_EXTENSIONS = new Set([".app", ".bat", ".cmd", ".com", ".dll", ".dmg", ".exe", ".jar", ".msi", ".pkg", ".scr", ".war"]);
const BLOCKED_UPLOAD_MIME_TYPES = new Set([
  "application/java-archive",
  "application/vnd.microsoft.portable-executable",
  "application/x-dosexec",
  "application/x-elf",
  "application/x-mach-binary",
  "application/x-msdownload"
]);
const DEFAULT_SKILL_RELEASE_VERSION = "v0.0.1";
const execFileAsync = promisify(execFile);

@Injectable()
export class WorkspacesService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(RealtimeService) private readonly realtime: RealtimeService,
    @Inject(ConfigService) private readonly config = new ConfigService()
  ) {}

  async listWorkspaces(currentUser: AgentHubUser) {
    const workspaces = await this.prisma.workspace.findMany({
      where: {
        deletedAt: null,
        conversation: {
          deletedAt: null,
          type: "project",
          NOT: [
            { id: { startsWith: "conv-hub-" } },
            { title: { contains: "Hub 资产库" } }
          ],
          members: {
            some: {
              memberType: "user",
              memberId: currentUser.id,
              deletedAt: null,
              archivedAt: null
            }
          }
        }
      },
      include: { conversation: { include: { members: { where: { memberType: "user", deletedAt: null } } } }, _count: { select: { assets: true } } },
      orderBy: { updatedAt: "desc" }
    });
    return workspaces.map((workspace) => ({
      id: workspace.id,
      conversationId: workspace.conversationId,
      name: workspace.name,
      codeAgentId: workspace.conversation.codeAgentId,
      scope: workspace.conversation.members.length > 1 ? "team" : "personal",
      memberCount: workspace.conversation.members.length,
      assetCount: workspace._count.assets,
      updatedAt: workspace.updatedAt.toISOString()
    }));
  }

  async getWorkspace(currentUser: AgentHubUser, workspaceId: string) {
    const workspace = await this.prisma.workspace.findFirst({
      where: {
        id: workspaceId,
        deletedAt: null,
        conversation: {
          deletedAt: null,
          members: {
            some: {
              memberType: "user",
              memberId: currentUser.id,
              deletedAt: null,
              archivedAt: null
            }
          }
        }
      },
      include: { conversation: true, _count: { select: { assets: true } } }
    });
    if (!workspace) throw new NotFoundException("Workspace not found");
    return {
      id: workspace.id,
      conversationId: workspace.conversationId,
      name: workspace.name,
      codeAgentId: workspace.conversation.codeAgentId,
      assetCount: workspace._count.assets,
      rootPath: workspace.rootPath,
      updatedAt: workspace.updatedAt.toISOString()
    };
  }

  async getWorkspaceGitView(currentUser: AgentHubUser, workspaceId: string) {
    const workspace = await this.getWorkspace(currentUser, workspaceId);
    await ensureWorkspaceLayout(workspace.rootPath);
    const codeRoot = await this.resolveFilePath(workspace.rootPath, WORKSPACE_CODE_DIR, true);
    const members = await this.prisma.conversationMember.findMany({
      where: { conversationId: workspace.conversationId, memberType: "user", deletedAt: null },
      orderBy: { createdAt: "asc" }
    });
    const users = await this.prisma.user.findMany({
      where: { id: { in: members.map((member) => member.memberId) }, deletedAt: null },
      select: { id: true, name: true, avatar: true }
    });
    const userById = new Map(users.map((user) => [user.id, user]));
    const realHumanMemberCount = members.length;
    const approvalPolicy = {
      realHumanMemberCount,
      requiresPeerReview: realHumanMemberCount > 1,
      autoApprovalReason: realHumanMemberCount <= 1 ? "群聊里只有一个真人，代码修改无需等待其他人同意。" : null
    };

    const git = await this.readGitSummary(codeRoot);
    const codeContribution = await this.collectCodeChangeContributors(workspaceId, codeRoot, git.files);
    const contributionByCodePath = new Map(codeContribution.files.map((item) => [item.path, item]));
    const gitView = {
      ...git,
      files: git.files.map((file) => {
        const contribution = contributionByCodePath.get(file.path);
        return {
          ...file,
          contributors: contribution?.contributors.map(toContributorView) ?? [],
          lastChangedAt: contribution?.lastChangedAt ?? null
        };
      }),
      pendingContributors: codeContribution.contributors.map(toContributorView),
      recentCommits: git.recentCommits.map((commit) => ({
        ...commit,
        contributors: hydrateCommitContributors(commit.contributors, userById).map(toContributorView)
      }))
    };
    const codeRuns = await this.prisma.codeTaskRun.findMany({
      where: { workspaceId, deletedAt: null },
      orderBy: { updatedAt: "desc" },
      take: 16
    });
    const diffAssetIds = codeRuns.flatMap((run) => (run.diffAssetId ? [run.diffAssetId] : []));
    const diffAssets = diffAssetIds.length
      ? await this.prisma.workspaceAsset.findMany({ where: { id: { in: diffAssetIds }, workspaceId, deletedAt: null } })
      : [];
    const diffAssetById = new Map(diffAssets.map((asset) => [asset.id, asset]));
    const manualProposalAssets = await this.prisma.workspaceAsset.findMany({
      where: { workspaceId, kind: "diff", deletedAt: null },
      orderBy: { updatedAt: "desc" },
      take: 24
    });
    const codeTaskDiffIds = new Set(diffAssetIds);
    const manualProposals = manualProposalAssets.flatMap((asset) => {
      if (codeTaskDiffIds.has(asset.id)) return [];
      const proposal = asRecord(asRecord(asset.metadata)?.proposal);
      if (!proposal) return [];
      const authorUserId = normalizeOptionalString(proposal.authorUserId);
      const author = authorUserId ? userById.get(authorUserId) : undefined;
      return [{
        id: normalizeOptionalString(proposal.id) ?? asset.id,
        kind: "manual" as const,
        title: normalizeOptionalString(proposal.title) ?? asset.summary ?? asset.name,
        status: normalizeOptionalString(proposal.status) ?? "waiting_review",
        authorType: "user" as const,
        authorId: authorUserId ?? null,
        authorName: author?.name ?? normalizeOptionalString(proposal.authorName) ?? "项目成员",
        contributors: normalizeContributorsFromMetadata(proposal.contributors, userById).map(toContributorView),
        branchName: normalizeOptionalString(proposal.branchName) ?? normalizeOptionalString(proposal.proposalBranch) ?? null,
        diffAssetId: asset.id,
        diffAssetName: asset.name,
        changedFileCount: toFiniteNumber(proposal.changedFileCount),
        isFromCurrentUser: authorUserId === currentUser.id,
        requiresPeerReview: approvalPolicy.requiresPeerReview,
        autoApproved: !approvalPolicy.requiresPeerReview,
        createdAt: asset.createdAt.toISOString(),
        updatedAt: asset.updatedAt.toISOString()
      }];
    });
    const codeTaskProposals = codeRuns.map((run) => {
      const diffAsset = run.diffAssetId ? diffAssetById.get(run.diffAssetId) : undefined;
      return {
        id: run.id,
        kind: "code_task" as const,
        title: run.statusMessage ?? `${displayCodeProvider(run.provider)} 代码任务`,
        status: run.status,
        authorType: "agent" as const,
        authorId: null,
        authorName: displayCodeProvider(run.provider),
        contributors: [{
          id: null,
          name: displayCodeProvider(run.provider),
          avatar: null,
          role: "agent" as const,
          contributions: 1,
          lastChangedAt: run.updatedAt.toISOString()
        }],
        branchName: run.branchName,
        diffAssetId: run.diffAssetId,
        diffAssetName: diffAsset?.name ?? null,
        changedFileCount: changedFileCountFromAsset(diffAsset),
        isFromCurrentUser: false,
        requiresPeerReview: approvalPolicy.requiresPeerReview,
        autoApproved: !approvalPolicy.requiresPeerReview && isReviewableCodeTaskStatus(run.status),
        createdAt: run.createdAt.toISOString(),
        updatedAt: run.updatedAt.toISOString()
      };
    });
    const otherMemberProposals = manualProposals.filter((proposal) => !proposal.isFromCurrentUser);
    return {
      workspace: {
        id: workspace.id,
        name: workspace.name,
        conversationId: workspace.conversationId,
        codeRoot: `${WORKSPACE_CODE_DIR}/`
      },
      approvalPolicy,
      members: members.map((member) => {
        const user = userById.get(member.memberId);
        return {
          id: member.memberId,
          name: user?.name ?? member.memberId,
          avatar: user?.avatar ?? null,
          role: member.role
        };
      }),
      git: gitView,
      proposals: [...manualProposals, ...codeTaskProposals].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)),
      otherMemberProposals
    };
  }

  async commitGitChanges(currentUser: AgentHubUser, workspaceId: string, input: { message: string }) {
    await this.assertCanMutateWorkspace(currentUser, workspaceId);
    const workspace = await this.getWorkspace(currentUser, workspaceId);
    await ensureWorkspaceLayout(workspace.rootPath);
    const codeRoot = await this.resolveFilePath(workspace.rootPath, WORKSPACE_CODE_DIR, true);
    await this.ensureCleanGitReady(codeRoot);
    const git = await this.readGitSummary(codeRoot);
    if (!git.files.length) throw new BadRequestException("No Code/ changes to commit");
    const codeContribution = await this.collectCodeChangeContributors(workspaceId, codeRoot, git.files);
    await runGit(codeRoot, ["add", "-A"], false);
    await runGit(codeRoot, [
      "-c",
      `user.name=${currentUser.name || currentUser.id}`,
      "-c",
      `user.email=${currentUser.id}@agenthub.local`,
      "commit",
      "-m",
      buildAgentHubCommitMessage(input.message, codeContribution.contributors, currentUser)
    ], false);
    return this.getWorkspaceGitView(currentUser, workspaceId);
  }

  async getWorkspaceGitFileDiff(currentUser: AgentHubUser, workspaceId: string, filePath: string) {
    await this.assertCanMutateWorkspace(currentUser, workspaceId);
    const workspace = await this.getWorkspace(currentUser, workspaceId);
    await ensureWorkspaceLayout(workspace.rootPath);
    const codeRoot = await this.resolveFilePath(workspace.rootPath, WORKSPACE_CODE_DIR, true);
    await this.ensureCleanGitReady(codeRoot);
    const git = await this.readGitSummary(codeRoot);
    const file = git.files.find((item) => item.path === filePath);
    if (!file) throw new NotFoundException("Git file change not found");
    const diff = await buildGitFileDiff(codeRoot, file);
    return {
      path: file.path,
      status: file.status,
      label: file.label,
      diff
    };
  }

  async createGitReviewProposal(currentUser: AgentHubUser, workspaceId: string, input: { title?: string | undefined; summary?: string | undefined }) {
    await this.assertCanMutateWorkspace(currentUser, workspaceId);
    const workspace = await this.getWorkspace(currentUser, workspaceId);
    await ensureWorkspaceLayout(workspace.rootPath);
    const codeRoot = await this.resolveFilePath(workspace.rootPath, WORKSPACE_CODE_DIR, true);
    await this.ensureCleanGitReady(codeRoot);
    const git = await this.readGitSummary(codeRoot);
    if (!git.files.length) throw new BadRequestException("No Code/ changes to review");
    const codeContribution = await this.collectCodeChangeContributors(workspaceId, codeRoot, git.files);
    const diffText = await buildReviewDiff(codeRoot, git.files);
    if (!diffText.trim()) throw new BadRequestException("No reviewable diff was generated");
    const proposalId = `proposal-${nanoid(10)}`;
    const title = input.title?.trim() || `审阅 ${git.files.length} 个 Code/ 变更`;
    const now = new Date().toISOString();
    const relativePath = `Doc/git-proposals/${new Date().toISOString().slice(0, 10)}-${proposalId}.diff`;
    const absolutePath = await this.resolveFilePath(workspace.rootPath, relativePath, true);
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, diffText, "utf8");
    const checksumSha256 = sha256Buffer(Buffer.from(diffText, "utf8"));
    const proposal = {
      id: proposalId,
      title,
      summary: input.summary?.trim() || `来自 ${currentUser.name || currentUser.id} 的 Code/ 修改审阅提议。`,
      status: "waiting_review",
      authorUserId: currentUser.id,
      authorName: currentUser.name || currentUser.id,
      contributors: codeContribution.contributors.map(toContributorView),
      fileContributions: codeContribution.files.map((file) => ({
        path: file.path,
        workspacePath: file.workspacePath,
        contributors: file.contributors.map(toContributorView),
        lastChangedAt: file.lastChangedAt
      })),
      branchName: git.branch ?? "main",
      changedFileCount: git.files.length,
      createdAt: now,
      updatedAt: now
    };
    const asset = await this.prisma.workspaceAsset.create({
      data: {
        id: proposalId,
        workspaceId,
        kind: "diff",
        name: `${title}.diff`,
        path: relativePath,
        mimeType: "text/x-diff",
        size: Buffer.byteLength(diffText, "utf8"),
        summary: proposal.summary,
        metadata: assetMetadata(checksumSha256, {
          source: "git_review_proposal",
          changedFileCount: git.files.length,
          proposal
        })
      }
    });
    await this.createAssetVersionSnapshot({
      workspaceRoot: workspace.rootPath,
      assetId: asset.id,
      sourceRelativePath: relativePath,
      size: Buffer.byteLength(diffText, "utf8"),
      checksumSha256,
      createdByUserId: currentUser.id,
      metadata: { source: "git_review_proposal", proposal }
    });
    await this.publishGitReviewProposalMessage(currentUser, workspace.conversationId, {
      proposalId,
      diffAssetId: asset.id,
      title,
      summary: proposal.summary,
      changedFileCount: git.files.length,
      contributors: codeContribution.contributors,
      diffPath: relativePath,
      changedFiles: git.files,
      diffText
    });
    return this.getWorkspaceGitView(currentUser, workspaceId);
  }

  async approveGitReviewProposal(currentUser: AgentHubUser, workspaceId: string, proposalId: string) {
    const manualProposal = await this.getMutableGitProposalOrNull(currentUser, workspaceId, proposalId);
    if (!manualProposal) return this.approveCodeTaskReviewProposal(currentUser, workspaceId, proposalId);
    const { workspace, asset, proposal } = manualProposal;
    if (proposal.authorUserId === currentUser.id) {
      const members = await this.prisma.conversationMember.count({
        where: { conversationId: workspace.conversationId, memberType: "user", deletedAt: null }
      });
      if (members > 1) throw new BadRequestException("A multi-user review proposal must be approved by another member");
    }
    const codeRoot = await this.resolveFilePath(workspace.rootPath, WORKSPACE_CODE_DIR, true);
    await this.ensureCleanGitReady(codeRoot);
    const git = await this.readGitSummary(codeRoot);
    if (git.files.length) {
      const metadataContributors = normalizeContributorsFromMetadata(proposal.contributors, new Map());
      const codeContribution = await this.collectCodeChangeContributors(workspace.id, codeRoot, git.files);
      const commitContributors = codeContribution.contributors.length ? codeContribution.contributors : metadataContributors;
      await runGit(codeRoot, ["add", "-A"], false);
      await runGit(codeRoot, [
        "-c",
        `user.name=${currentUser.name || currentUser.id}`,
        "-c",
        `user.email=${currentUser.id}@agenthub.local`,
        "commit",
        "-m",
        buildAgentHubCommitMessage(`review: ${proposal.title ?? asset.name}`, commitContributors, currentUser)
      ], false);
    }
    await this.updateGitProposalMetadata(asset.id, {
      ...proposal,
      status: "approved",
      reviewedByUserId: currentUser.id,
      reviewedByName: currentUser.name || currentUser.id,
      reviewedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
    await this.updateReviewProposalMessages(workspace.conversationId, proposalId, "approved", {
      reviewedByUserId: currentUser.id,
      reviewedByName: currentUser.name || currentUser.id
    });
    return this.getWorkspaceGitView(currentUser, workspaceId);
  }

  async rejectGitReviewProposal(currentUser: AgentHubUser, workspaceId: string, proposalId: string, reason: string) {
    const manualProposal = await this.getMutableGitProposalOrNull(currentUser, workspaceId, proposalId);
    if (!manualProposal) return this.rejectCodeTaskReviewProposal(currentUser, workspaceId, proposalId, reason);
    const { workspace, asset, proposal } = manualProposal;
    await this.updateGitProposalMetadata(asset.id, {
      ...proposal,
      status: "revision_requested",
      reviewReason: reason,
      reviewedByUserId: currentUser.id,
      reviewedByName: currentUser.name || currentUser.id,
      reviewedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
    await this.updateReviewProposalMessages(workspace.conversationId, proposalId, "changes_requested", {
      reviewReason: reason,
      reviewedByUserId: currentUser.id,
      reviewedByName: currentUser.name || currentUser.id
    });
    return this.getWorkspaceGitView(currentUser, workspaceId);
  }

  private async approveCodeTaskReviewProposal(currentUser: AgentHubUser, workspaceId: string, proposalId: string) {
    const workspace = await this.getWorkspace(currentUser, workspaceId);
    const run = await this.prisma.codeTaskRun.findFirst({
      where: { id: proposalId, workspaceId, deletedAt: null }
    });
    if (!run) throw new NotFoundException("Review proposal not found");
    if (run.status === "merged") throw new BadRequestException("Review proposal has already been approved");
    if (run.status === "cancelled" || run.status === "stale") throw new BadRequestException("Review proposal is no longer active");
    const codeRoot = await this.resolveFilePath(workspace.rootPath, WORKSPACE_CODE_DIR, true);
    await this.ensureCleanGitReady(codeRoot);
    const git = await this.readGitSummary(codeRoot);
    if (git.files.length) {
      const codeContribution = await this.collectCodeChangeContributors(workspace.id, codeRoot, git.files);
      await runGit(codeRoot, ["add", "-A"], false);
      await runGit(codeRoot, [
        "-c",
        `user.name=${currentUser.name || currentUser.id}`,
        "-c",
        `user.email=${currentUser.id}@agenthub.local`,
        "commit",
        "-m",
        buildAgentHubCommitMessage(`review: ${run.statusMessage ?? "Code Agent 代码变更"}`, codeContribution.contributors, currentUser)
      ], false);
    }
    await this.prisma.codeTaskRun.update({
      where: { id: run.id },
      data: {
        status: "merged",
        completedAt: new Date(),
        leaseOwner: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
        statusMessage: `已由 ${currentUser.name || currentUser.id} 审阅通过并提交 main`
      }
    });
    await this.updateReviewProposalMessages(workspace.conversationId, proposalId, "approved", {
      reviewedByUserId: currentUser.id,
      reviewedByName: currentUser.name || currentUser.id
    });
    return this.getWorkspaceGitView(currentUser, workspaceId);
  }

  private async rejectCodeTaskReviewProposal(currentUser: AgentHubUser, workspaceId: string, proposalId: string, reason: string) {
    const workspace = await this.getWorkspace(currentUser, workspaceId);
    const run = await this.prisma.codeTaskRun.findFirst({
      where: { id: proposalId, workspaceId, deletedAt: null }
    });
    if (!run) throw new NotFoundException("Review proposal not found");
    if (run.status === "merged") throw new BadRequestException("Review proposal has already been approved");
    await this.prisma.codeTaskRun.update({
      where: { id: run.id },
      data: {
        status: "revision_requested",
        statusMessage: `要求修改：${reason}`,
        leaseOwner: null,
        leaseExpiresAt: null,
        heartbeatAt: null
      }
    });
    await this.updateReviewProposalMessages(workspace.conversationId, proposalId, "changes_requested", {
      reviewReason: reason,
      reviewedByUserId: currentUser.id,
      reviewedByName: currentUser.name || currentUser.id
    });
    return this.getWorkspaceGitView(currentUser, workspaceId);
  }

  async ensureConversationWorkspace(currentUser: AgentHubUser, conversationId: string) {
    const conversation = await this.prisma.conversation.findFirst({
      where: {
        id: conversationId,
        deletedAt: null,
        members: {
          some: {
            memberType: "user",
            memberId: currentUser.id,
            deletedAt: null
          }
        }
      },
      include: { workspace: true }
    });
    if (!conversation) throw new NotFoundException("Conversation not found");
    if (conversation.workspaceId && conversation.workspace && !conversation.workspace.deletedAt) {
      await ensureWorkspaceLayout(conversation.workspace.rootPath);
      return conversation.workspaceId;
    }

    const workspaceId = `workspace-${nanoid(8)}`;
    const rootPath = resolve(this.config.workspacesRoot, workspaceId);
    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: {
        workspaceId,
        workspace: {
          create: {
            id: workspaceId,
            name: conversation.title,
            rootPath
          }
        }
      }
    });
    await ensureWorkspaceLayout(rootPath);
    return workspaceId;
  }

  async ensurePersonalHubWorkspace(currentUser: AgentHubUser) {
    const conversationId = `conv-hub-${currentUser.id}`;
    const workspaceId = `workspace-hub-${currentUser.id}`;
    const rootPath = resolve(this.config.workspacesRoot, workspaceId);
    await this.prisma.conversation.upsert({
      where: { id: conversationId },
      create: {
        id: conversationId,
        type: "project",
        title: "个人 Hub 资产库",
        avatar: "HB",
        workspaceId,
        lastMessage: "个人 Hub fork 和订阅资产会保存在这里。",
        unreadCount: 0,
        memberCount: 1,
        members: {
          create: [{ id: `member-hub-${currentUser.id}`, memberType: "user", memberId: currentUser.id, role: "owner" }]
        },
        workspace: {
          create: {
            id: workspaceId,
            name: "个人 Hub 资产库",
            rootPath
          }
        }
      },
      update: {
        deletedAt: null,
        workspaceId
      }
    });
    await this.prisma.conversationMember.upsert({
      where: { id: `member-hub-${currentUser.id}` },
      create: { id: `member-hub-${currentUser.id}`, conversationId, memberType: "user", memberId: currentUser.id, role: "owner" },
      update: { conversationId, memberType: "user", memberId: currentUser.id, role: "owner", deletedAt: null }
    });
    await this.prisma.workspace.upsert({
      where: { id: workspaceId },
      create: { id: workspaceId, conversationId, name: "个人 Hub 资产库", rootPath },
      update: { conversationId, name: "个人 Hub 资产库", rootPath, deletedAt: null }
    });
    await ensureWorkspaceLayout(rootPath);
    return workspaceId;
  }

  async beginConversationUpload(
    currentUser: AgentHubUser,
    conversationId: string,
    file: { name: string; mimeType: string; size: number }
  ) {
    const workspaceId = await this.ensureConversationWorkspace(currentUser, conversationId);
    return this.beginUpload(currentUser, workspaceId, file);
  }

  async listAssets(currentUser: AgentHubUser, workspaceId: string) {
    await this.getWorkspace(currentUser, workspaceId);
    const assets = await this.prisma.workspaceAsset.findMany({
      where: { workspaceId, deletedAt: null },
      include: {
        versions: {
          orderBy: { version: "desc" },
          take: 1
        }
      },
      orderBy: { createdAt: "desc" }
    });
    const creatorIds = [...new Set(assets.flatMap((asset) => {
      const userId = asset.versions[0]?.createdByUserId;
      return userId && userId !== "agent-runtime" ? [userId] : [];
    }))];
    const users = creatorIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: creatorIds }, deletedAt: null },
          select: { id: true, name: true }
        })
      : [];
    const userNameById = new Map(users.map((user) => [user.id, user.name]));
    return assets.map((asset): WorkspaceAsset => ({
      ...toWorkspaceAsset(asset, userNameById.get(asset.versions[0]?.createdByUserId ?? ""))
    }));
  }

  async listHubAssets(currentUser: AgentHubUser, kind: "skill" | "knowledge", scope: HubAssetScope) {
    if (kind === "skill") return this.listSkillHubAssets(currentUser, scope);
    const hubKind = "knowledge";
    const workspaceWhere: Prisma.WorkspaceWhereInput = {
      deletedAt: null,
      conversation: scope === "personal"
        ? {
            deletedAt: null,
            members: {
              some: {
                memberType: "user",
                memberId: currentUser.id,
                deletedAt: null
              }
            }
          }
        : { deletedAt: null }
    };
    const assetWhere: Prisma.WorkspaceAssetWhereInput = {
      deletedAt: null,
      workspace: workspaceWhere
    };
    if (kind === "knowledge") {
      assetWhere.kind = { in: ["doc", "file", "log"] };
    }
    const assets = await this.prisma.workspaceAsset.findMany({
      where: assetWhere,
      include: {
        workspace: {
          include: {
            conversation: {
              include: { members: { where: { memberType: "user", deletedAt: null } } }
            }
          }
        }
      },
      orderBy: { createdAt: "desc" },
      take: 200
    });
    const subscriptionOwners = await this.visibleHubSubscriptionOwners(currentUser);
    const filteredAssets = assets.filter((asset) => {
      if (scope === "public" && !isPublicAsset(asset.metadata)) return false;
      return !isSkillAsset(asset.name, asset.path, asset.summary, asset.metadata);
    });
    const hubSources = await Promise.all(filteredAssets.map((asset) => this.syncHubAssetIndex(hubKind, asset)));
    const sourceByAssetId = new Map(hubSources.flatMap((source) => source ? [[source.sourceAssetId, source] as const] : []));
    const subscriptions = await this.prisma.hubSubscription.findMany({
      where: {
        kind: hubKind,
        assetId: { in: filteredAssets.map((asset) => asset.id) },
        deletedAt: null,
        OR: subscriptionOwners
      }
    });
    const subscriptionByAssetId = preferredHubSubscriptionByAsset(subscriptions, currentUser.id);
    return filteredAssets
      .map((asset) => {
        const view = toWorkspaceAsset(asset);
        const scopeLabel = asset.workspace.conversation.members.length > 1 ? "团队" : "个人";
        const source = sourceByAssetId.get(asset.id) ?? currentAssetSource(asset);
        return {
          ...view,
          ...hubLifecycleFields(subscriptionByAssetId.get(asset.id), source),
          summary: view.summary || `${scopeLabel}工作空间 ${asset.workspace.name} 中的 ${asset.kind} 资产`
        };
      })
      .slice(0, 80);
  }

  private async listSkillHubAssets(currentUser: AgentHubUser, scope: HubAssetScope) {
    const subscriptionOwners = await this.visibleHubSubscriptionOwners(currentUser);
    const subscriptions = await this.prisma.hubSubscription.findMany({
      where: {
        kind: "skill",
        deletedAt: null,
        OR: subscriptionOwners
      }
    });
    const activeSubscriptionAssetIds = [...new Set(subscriptions.filter((subscription) => subscription.status === "active").map((subscription) => subscription.assetId))];
    const where: Prisma.SkillAssetWhereInput = {
      deletedAt: null,
      ...skillHubScopeWhere(currentUser.id, scope, activeSubscriptionAssetIds)
    };
    const skills = await this.prisma.skillAsset.findMany({
      where,
      include: { versions: { where: { deletedAt: null }, orderBy: { version: "desc" }, take: 1 } },
      orderBy: { updatedAt: "desc" },
      take: 200
    });
    const visibleSkills = skills.filter((skill) => !isStarterSkillIndex(skill) && skillMatchesHubScope(skill, scope, currentUser.id, activeSubscriptionAssetIds));
    const ownerNames = await this.loadOwnerNames(visibleSkills.map((skill) => ({ ownerType: skill.ownerType, ownerId: skill.ownerId })));
    const subscriptionByAssetId = preferredHubSubscriptionByAsset(subscriptions, currentUser.id);
    const likesByAssetId = await this.loadHubAssetLikeSummary("skill", visibleSkills.map((skill) => skill.id), currentUser.id);
    const result = visibleSkills.map((skill) => {
      const source = { version: skill.currentVersion, fingerprint: skill.currentFingerprint };
      const subscription = subscriptionByAssetId.get(skill.id) ?? subscriptionByAssetId.get(skill.sourceAssetId);
      return toSkillHubAsset(skill, ownerNames.get(ownerKey(skill.ownerType, skill.ownerId)), subscription, source, likesByAssetId.get(skill.id));
    });
    if (scope === "public") {
      return result.sort((left, right) => (right.likeCount ?? 0) - (left.likeCount ?? 0) || String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")));
    }
    return result;
  }

  private async loadHubAssetLikeSummary(kind: HubKind, assetIds: string[], currentUserId: string): Promise<Map<string, HubAssetLikeSummary>> {
    const ids = [...new Set(assetIds)].filter(Boolean);
    if (ids.length === 0) return new Map();
    const counts = await this.prisma.$queryRaw<Array<{ assetId: string; count: bigint | number }>>`
      SELECT "assetId", COUNT(*) AS count
      FROM "HubAssetLike"
      WHERE kind = ${kind} AND "assetId" IN (${Prisma.join(ids)})
      GROUP BY "assetId"
    `;
    const likedRows = await this.prisma.$queryRaw<Array<{ assetId: string }>>`
      SELECT "assetId"
      FROM "HubAssetLike"
      WHERE kind = ${kind} AND "userId" = ${currentUserId} AND "assetId" IN (${Prisma.join(ids)})
    `;
    const liked = new Set(likedRows.map((row) => row.assetId));
    const result = new Map<string, HubAssetLikeSummary>();
    for (const id of ids) result.set(id, { likeCount: 0, likedByMe: liked.has(id) });
    for (const row of counts) {
      result.set(row.assetId, { likeCount: Number(row.count), likedByMe: liked.has(row.assetId) });
    }
    return result;
  }

  async createHubTextAsset(
    currentUser: AgentHubUser,
    kind: "skill" | "knowledge",
    input: { name: string; content: string; summary?: string | undefined; visibility?: "private" | "public" | undefined; releaseVersion?: string | undefined; logo?: string | undefined; logoColor?: string | undefined }
  ) {
    const workspaceId = await this.ensurePersonalHubWorkspace(currentUser);
    const folder = kind === "skill" ? "skills" : "knowledge";
    const basenameWithoutExt = safeHubAssetBasename(input.name);
    const path = `${folder}/${new Date().toISOString().slice(0, 10)}-${nanoid(8)}-${basenameWithoutExt}.md`;
    const file = await this.writeTextFile(currentUser, workspaceId, path, input.content);
    const asset = await this.prisma.workspaceAsset.findFirst({
      where: { id: file.assetId, workspaceId, deletedAt: null }
    });
    if (!asset) throw new NotFoundException("Hub asset was not created");
    const updated = await this.prisma.workspaceAsset.update({
      where: { id: asset.id },
      data: {
        name: input.name.trim(),
        summary: normalizeOptionalString(input.summary) ?? asset.summary,
        metadata: {
          ...(asRecord(asset.metadata) ?? {}),
          hubKind: kind,
          visibility: input.visibility ?? "private",
          ownerType: "user",
          ownerId: currentUser.id,
          ownerUserId: currentUser.id,
          source: "hub_builder",
          logo: normalizeHubLogo(input.logo, kind === "skill" ? "sparkles" : "book"),
          logoColor: normalizeHubLogoColor(input.logoColor),
          ...(kind === "skill"
            ? { releaseVersion: normalizeReleaseVersion(input.releaseVersion) ?? DEFAULT_SKILL_RELEASE_VERSION }
            : {})
        } as Prisma.InputJsonValue
      }
    });
    await this.syncHubAssetIndex(kind, await this.loadHubAssetRecord(updated.id));
    if (kind === "skill") {
      const skill = await this.prisma.skillAsset.findUnique({
        where: { sourceAssetId: updated.id },
        include: { versions: { where: { deletedAt: null }, orderBy: { version: "desc" }, take: 1 } }
      });
      if (!skill) throw new NotFoundException("Skill asset index was not created");
      return toSkillHubAsset(skill, currentUser.name);
    }
    return toWorkspaceAsset(updated);
  }

  async getEditableHubTextAsset(currentUser: AgentHubUser, kind: "skill" | "knowledge", assetId: string) {
    const sourceAssetId = await this.resolveHubSourceAssetId(kind, assetId);
    const sourceAsset = await this.loadHubAssetRecord(sourceAssetId);
    const metadata = asRecord(sourceAsset.metadata) ?? {};
    const actualKind = normalizeHubKind(metadata.hubKind);
    if (actualKind && actualKind !== kind) throw new BadRequestException("Hub asset kind does not match");
    const owner = hubAssetOwner(sourceAsset);
    if (!(await this.canReadHubTextAsset(currentUser, kind, assetId, sourceAsset, owner))) {
      throw new BadRequestException("No permission to read this Hub asset");
    }
    const result = {
      ...toWorkspaceAsset(sourceAsset),
      mimeType: sourceAsset.mimeType ?? inferMimeType(sourceAsset.path),
      size: sourceAsset.size ?? undefined
    };
    if (!isTextMime(result.mimeType) || (sourceAsset.size ?? 0) > MAX_TEXT_FILE_BYTES) {
      return result;
    }
    const absolutePath = await this.resolveFilePath(sourceAsset.workspace.rootPath, sourceAsset.path);
    return { ...result, content: await readFile(absolutePath, "utf8") };
  }

  private async canReadHubTextAsset(
    currentUser: AgentHubUser,
    kind: "skill" | "knowledge",
    requestedAssetId: string,
    sourceAsset: WorkspaceHubAssetRecord,
    owner: { ownerType: string; ownerId: string }
  ) {
    if (currentUser.role === "admin") return true;
    if (owner.ownerType === "user" && owner.ownerId === currentUser.id) return true;
    if (isPublicAsset(sourceAsset.metadata)) return true;
    const subscriptionOwners = await this.visibleHubSubscriptionOwners(currentUser);
    const possibleAssetIds = new Set([requestedAssetId, sourceAsset.id]);
    if (kind === "skill") {
      const skill = await this.prisma.skillAsset.findFirst({
        where: { sourceAssetId: sourceAsset.id, deletedAt: null },
        select: { id: true }
      });
      if (skill) possibleAssetIds.add(skill.id);
    }
    if (kind === "knowledge") {
      const knowledge = await this.prisma.knowledgeAsset.findFirst({
        where: { sourceAssetId: sourceAsset.id, deletedAt: null },
        select: { id: true }
      });
      if (knowledge) possibleAssetIds.add(knowledge.id);
    }
    const subscription = await this.prisma.hubSubscription.findFirst({
      where: {
        kind,
        assetId: { in: [...possibleAssetIds] },
        status: { in: ["active", "forked"] },
        deletedAt: null,
        OR: subscriptionOwners
      },
      select: { id: true }
    });
    return Boolean(subscription);
  }

  async updateHubTextAsset(
    currentUser: AgentHubUser,
    kind: "skill" | "knowledge",
    assetId: string,
    input: { name: string; content: string; summary?: string | undefined; visibility?: "private" | "public" | undefined; releaseVersion?: string | undefined; logo?: string | undefined; logoColor?: string | undefined }
  ) {
    const sourceAssetId = await this.resolveHubSourceAssetId(kind, assetId);
    const sourceAsset = await this.loadHubAssetRecord(sourceAssetId);
    const metadata = asRecord(sourceAsset.metadata) ?? {};
    const actualKind = normalizeHubKind(metadata.hubKind);
    if (actualKind && actualKind !== kind) throw new BadRequestException("Hub asset kind does not match");
    const owner = hubAssetOwner(sourceAsset);
    if (owner.ownerType !== "user" || owner.ownerId !== currentUser.id) {
      throw new BadRequestException("Only the owner can edit this Hub asset");
    }

    await this.writeTextFile(currentUser, sourceAsset.workspaceId, sourceAsset.path, input.content);
    const assetAfterWrite = await this.prisma.workspaceAsset.findFirst({
      where: { id: sourceAsset.id, workspaceId: sourceAsset.workspaceId, deletedAt: null }
    });
    if (!assetAfterWrite) throw new NotFoundException("Hub asset was not updated");
    const updated = await this.prisma.workspaceAsset.update({
      where: { id: assetAfterWrite.id },
      data: {
        name: input.name.trim(),
        summary: normalizeOptionalString(input.summary) ?? summarizeText(input.content),
        metadata: {
          ...(asRecord(assetAfterWrite.metadata) ?? {}),
          hubKind: kind,
          visibility: input.visibility ?? normalizeOptionalString(metadata.visibility) ?? "private",
          ownerType: "user",
          ownerId: currentUser.id,
          ownerUserId: currentUser.id,
          source: normalizeOptionalString(metadata.source) ?? "hub_builder",
          logo: normalizeHubLogo(input.logo ?? metadata.logo, kind === "skill" ? "sparkles" : "book"),
          logoColor: normalizeHubLogoColor(input.logoColor ?? metadata.logoColor),
          ...(kind === "skill"
            ? { releaseVersion: normalizeReleaseVersion(input.releaseVersion) ?? normalizeReleaseVersion(metadata.releaseVersion) ?? DEFAULT_SKILL_RELEASE_VERSION }
            : {})
        } as Prisma.InputJsonValue
      }
    });
    await this.syncHubAssetIndex(kind, await this.loadHubAssetRecord(updated.id));
    if (kind === "skill") {
      const skill = await this.prisma.skillAsset.findUnique({
        where: { sourceAssetId: updated.id },
        include: { versions: { where: { deletedAt: null }, orderBy: { version: "desc" }, take: 1 } }
      });
      if (!skill) throw new NotFoundException("Skill asset index was not updated");
      return toSkillHubAsset(skill, currentUser.name);
    }
    return toWorkspaceAsset(updated);
  }

  async deleteHubTextAsset(currentUser: AgentHubUser, kind: "skill" | "knowledge", assetId: string) {
    const sourceAssetId = await this.resolveHubSourceAssetId(kind, assetId);
    const sourceAsset = await this.loadHubAssetRecord(sourceAssetId);
    const metadata = asRecord(sourceAsset.metadata) ?? {};
    const actualKind = normalizeHubKind(metadata.hubKind);
    if (actualKind && actualKind !== kind) throw new BadRequestException("Hub asset kind does not match");
    const owner = hubAssetOwner(sourceAsset);
    if (owner.ownerType !== "user" || owner.ownerId !== currentUser.id) {
      throw new BadRequestException("Only the owner can delete this Hub asset");
    }

    const deletedAt = new Date();
    await this.prisma.workspaceAsset.update({
      where: { id: sourceAsset.id },
      data: { deletedAt }
    });
    await this.markHubAssetIndexDeleted(sourceAsset.id);
    await this.prisma.hubSubscription.updateMany({
      where: { kind, forkedAssetId: sourceAsset.id, deletedAt: null },
      data: { status: "removed", deletedAt, forkedAssetId: null }
    });
    const absolutePath = await this.resolveFilePath(sourceAsset.workspace.rootPath, sourceAsset.path).catch(() => null);
    if (absolutePath) await rm(absolutePath, { force: true }).catch(() => undefined);
    return { assetId: sourceAsset.id, deletedAt: deletedAt.toISOString() };
  }

  private async loadOwnerNames(owners: Array<{ ownerType: string; ownerId: string | null | undefined }>) {
    const userIds = [...new Set(owners.flatMap((owner) => owner.ownerType === "user" && owner.ownerId ? [owner.ownerId] : []))];
    const users = userIds.length > 0
      ? await this.prisma.user.findMany({ where: { id: { in: userIds }, deletedAt: null }, select: { id: true, name: true } })
      : [];
    return new Map(users.map((user) => [ownerKey("user", user.id), user.name]));
  }

  private async ensureStarterSkillAssets(currentUser: AgentHubUser) {
    const workspaceId = await this.ensurePersonalHubWorkspace(currentUser);
    const starters = [
      {
        path: "skills/starter-personal-agent-writing.md",
        name: "个人长文档整理 Skill",
        summary: "让自建 Agent 在回答较长时先生成 Doc/ 文档，再在群聊里汇报路径和简报。",
        visibility: "private" as const,
        content: [
          "# 个人长文档整理 Skill",
          "",
          "当任务需要输出 PRD、技术方案、复盘、调研报告或规范文档时，优先整理为 Markdown 文档。",
          "",
          "规则：",
          "- 先给出 3-6 条任务简报。",
          "- 如果内容超过 800 字，使用已绑定写入工具写入 `Doc/` 下的 Markdown 文件。",
          "- 群聊消息只保留摘要、关键结论和文档相对路径。",
          "- 不要声称已经生成文件，除非工具返回了成功的 path 或 assetId。"
        ].join("\n")
      },
      {
        path: "skills/starter-public-agent-collaboration.md",
        name: "公共 Agent 协作 Skill",
        summary: "约束 Agent 在群聊中像团队成员一样回复、引用、补充和沉淀结论。",
        visibility: "public" as const,
        content: [
          "# 公共 Agent 协作 Skill",
          "",
          "用于 AgentHub 群聊协作场景，要求 Agent 像真实团队成员一样工作。",
          "",
          "规则：",
          "- 被 Orchestrator 分配任务后先简短确认收到。",
          "- 输出要区分：结论、依据、产物、下一步。",
          "- 审阅别的 Agent 结果时使用引用语气，明确指出通过、需要补充或需要返工。",
          "- 如果发现信息不足，直接说明需要用户补充的最小信息。"
        ].join("\n")
      }
    ];
    for (const starter of starters) {
      const existing = await this.prisma.workspaceAsset.findFirst({
        where: { workspaceId, path: starter.path, deletedAt: null }
      });
      if (existing) {
        if (asRecord(existing.metadata)?.hubKind === "skill") continue;
        await this.prisma.workspaceAsset.update({
          where: { id: existing.id },
          data: {
            name: starter.name,
            summary: starter.summary,
            metadata: {
              ...(asRecord(existing.metadata) ?? {}),
              hubKind: "skill",
              visibility: starter.visibility,
              ownerType: "user",
              ownerId: currentUser.id,
              ownerUserId: currentUser.id,
              source: "hub_starter",
              starter: true,
              currentVersion: "1.0.0"
            } as Prisma.InputJsonValue
          }
        });
        await this.syncHubAssetIndexById("skill", existing.id);
        continue;
      }
      const file = await this.writeTextFile(currentUser, workspaceId, starter.path, starter.content);
      const asset = await this.prisma.workspaceAsset.findFirst({
        where: { id: file.assetId, workspaceId, deletedAt: null }
      });
      if (!asset) continue;
      const updated = await this.prisma.workspaceAsset.update({
        where: { id: asset.id },
        data: {
          name: starter.name,
          summary: starter.summary,
          metadata: {
            ...(asRecord(asset.metadata) ?? {}),
            hubKind: "skill",
            visibility: starter.visibility,
            ownerType: "user",
            ownerId: currentUser.id,
            ownerUserId: currentUser.id,
            source: "hub_starter",
            starter: true,
            currentVersion: "1.0.0"
          } as Prisma.InputJsonValue
        }
      });
      await this.syncHubAssetIndex("skill", await this.loadHubAssetRecord(updated.id));
    }
  }

  private async resolveHubSourceAssetId(kind: HubKind, assetId: string) {
    if (kind === "skill") {
      const skill = await this.prisma.skillAsset.findFirst({
        where: { OR: [{ id: assetId }, { sourceAssetId: assetId }], deletedAt: null },
        select: { sourceAssetId: true }
      });
      if (skill) return skill.sourceAssetId;
    } else {
      const knowledge = await this.prisma.knowledgeAsset.findFirst({
        where: { OR: [{ id: assetId }, { sourceAssetId: assetId }], deletedAt: null },
        select: { sourceAssetId: true }
      });
      if (knowledge) return knowledge.sourceAssetId;
    }
    return assetId;
  }

  async syncHubAssetIndexById(kind: HubKind, assetId: string) {
    const asset = await this.prisma.workspaceAsset.findFirst({
      where: { id: assetId, deletedAt: null },
      include: {
        workspace: {
          include: {
            conversation: {
              include: { members: { where: { memberType: "user", deletedAt: null } } }
            }
          }
        }
      }
    });
    if (!asset) return null;
    return this.syncHubAssetIndex(kind, asset);
  }

  private async visibleHubSubscriptionOwners(currentUser: AgentHubUser): Promise<Prisma.HubSubscriptionWhereInput[]> {
    if (currentUser.role === "admin") return [{}];
    const memberships = await this.prisma.teamMember.findMany({
      where: { userId: currentUser.id, deletedAt: null, team: { deletedAt: null } },
      select: { teamId: true }
    });
    return [
      { ownerType: "user", ownerId: currentUser.id },
      ...(memberships.length > 0 ? [{ ownerType: "team", ownerId: { in: memberships.map((membership) => membership.teamId) } }] : [])
    ];
  }

  async getAsset(currentUser: AgentHubUser, workspaceId: string, assetId: string) {
    const workspace = await this.getWorkspace(currentUser, workspaceId);
    const asset = await this.prisma.workspaceAsset.findFirst({
      where: { id: assetId, workspaceId, deletedAt: null }
    });
    if (!asset) throw new NotFoundException("Workspace asset not found");
    const result = {
      ...toWorkspaceAsset(asset),
      mimeType: asset.mimeType ?? inferMimeType(asset.path),
      size: asset.size ?? undefined
    };
    if (isTextMime(result.mimeType) && (asset.size ?? 0) <= 2_000_000) {
      const absolutePath = await this.resolveFilePath(workspace.rootPath, asset.path);
      return { ...result, content: await readFile(absolutePath, "utf8") };
    }
    return result;
  }

  async readAssetContent(currentUser: AgentHubUser, workspaceId: string, assetId: string) {
    const workspace = await this.getWorkspace(currentUser, workspaceId);
    const asset = await this.prisma.workspaceAsset.findFirst({
      where: { id: assetId, workspaceId, deletedAt: null }
    });
    if (!asset) throw new NotFoundException("Workspace asset not found");
    const absolutePath = await this.resolveFilePath(workspace.rootPath, asset.path);
    const content = await readFile(absolutePath);
    const metadata = asRecord(asset.metadata) ?? {};
    const checksumSha256 = typeof metadata.checksumSha256 === "string" ? metadata.checksumSha256 : sha256Buffer(content);
    const etag = typeof metadata.etag === "string" ? metadata.etag : `"sha256-${checksumSha256}"`;
    return {
      asset: toWorkspaceAsset(asset),
      mimeType: asset.mimeType ?? inferMimeType(asset.path),
      size: asset.size ?? content.byteLength,
      etag,
      checksumSha256,
      content
    };
  }

  async listFileTree(currentUser: AgentHubUser, workspaceId: string) {
    const workspace = await this.getWorkspace(currentUser, workspaceId);
    const rootPath = await this.ensureWorkspaceRoot(workspace.rootPath);
    return readTree(rootPath, rootPath, 3);
  }

  async readFile(currentUser: AgentHubUser, workspaceId: string, filePath: string) {
    const workspace = await this.getWorkspace(currentUser, workspaceId);
    const absolutePath = await this.resolveFilePath(workspace.rootPath, filePath);
    const fileStat = await stat(absolutePath);
    if (!fileStat.isFile()) throw new NotFoundException("Workspace file not found");
    const relativePath = normalizeRelativePath(workspace.rootPath, absolutePath);
    const mimeType = inferMimeType(absolutePath);
    const asset = await this.prisma.workspaceAsset.findFirst({
      where: { workspaceId, path: relativePath, deletedAt: null },
      select: { id: true, kind: true, summary: true, metadata: true }
    });
    const previewableText = isTextPreviewMime(mimeType) && fileStat.size <= MAX_TEXT_FILE_BYTES;
    const metadata = asRecord(asset?.metadata);
    const latestVersion = typeof metadata?.latestVersion === "number" ? metadata.latestVersion : undefined;
    const content = previewableText ? await readFile(absolutePath, "utf8") : "";
    const lock = await this.currentFileLock(workspaceId, relativePath, currentUser.id);
    return {
      path: relativePath,
      name: basename(absolutePath),
      mimeType,
      size: fileStat.size,
      content,
      binary: !previewableText,
      previewableText,
      assetId: asset?.id ?? null,
      ...(asset?.kind ? { assetKind: asset.kind } : {}),
      ...(asset?.summary ? { assetSummary: asset.summary } : {}),
      ...(latestVersion ? { latestVersion } : {}),
      lock
    };
  }

  async acquireFileLock(currentUser: AgentHubUser, workspaceId: string, filePath: string) {
    await this.assertCanMutateWorkspace(currentUser, workspaceId);
    const workspace = await this.getWorkspace(currentUser, workspaceId);
    const absolutePath = await this.resolveFilePath(workspace.rootPath, filePath, true);
    const relativePath = normalizeRelativePath(workspace.rootPath, absolutePath);
    const expiresAt = new Date(Date.now() + FILE_LOCK_TTL_MS);
    const existing = await this.prisma.workspaceFileLock.findUnique({
      where: { workspaceId_path: { workspaceId, path: relativePath } }
    });
    if (existing && !existing.releasedAt && existing.expiresAt > new Date() && existing.lockedByUserId !== currentUser.id) {
      const owner = await this.prisma.user.findFirst({
        where: { id: existing.lockedByUserId, deletedAt: null },
        select: { name: true }
      });
      throw new ConflictException(`${owner?.name ?? "其他成员"} 正在编辑 ${relativePath}，请稍后再试`);
    }
    const lock = existing
      ? await this.prisma.workspaceFileLock.update({
          where: { id: existing.id },
          data: {
            lockedByUserId: currentUser.id,
            token: existing.lockedByUserId === currentUser.id && !existing.releasedAt && existing.expiresAt > new Date() ? existing.token : `file-lock-${nanoid(24)}`,
            expiresAt,
            releasedAt: null
          }
        })
      : await this.prisma.workspaceFileLock.create({
          data: {
            id: `file-lock-${nanoid(12)}`,
            workspaceId,
            path: relativePath,
            lockedByUserId: currentUser.id,
            token: `file-lock-${nanoid(24)}`,
            expiresAt
          }
        });
    return this.toFileLockView(lock, currentUser.id);
  }

  async releaseFileLock(currentUser: AgentHubUser, workspaceId: string, filePath: string, lockToken: string) {
    await this.assertCanMutateWorkspace(currentUser, workspaceId);
    const workspace = await this.getWorkspace(currentUser, workspaceId);
    const absolutePath = await this.resolveFilePath(workspace.rootPath, filePath, true);
    const relativePath = normalizeRelativePath(workspace.rootPath, absolutePath);
    const lock = await this.prisma.workspaceFileLock.findUnique({
      where: { workspaceId_path: { workspaceId, path: relativePath } }
    });
    if (!lock || lock.token !== lockToken || lock.lockedByUserId !== currentUser.id) {
      return { released: false, path: relativePath };
    }
    await this.prisma.workspaceFileLock.update({
      where: { id: lock.id },
      data: { releasedAt: new Date(), expiresAt: new Date() }
    });
    return { released: true, path: relativePath };
  }

  async writeTextFile(
    currentUser: AgentHubUser,
    workspaceId: string,
    filePath: string,
    content: string,
    originalPathOrOptions?: string | WriteWorkspaceFileOptions | undefined
  ) {
    await this.assertCanMutateWorkspace(currentUser, workspaceId);
    const options: WriteWorkspaceFileOptions = typeof originalPathOrOptions === "string"
      ? { originalPath: originalPathOrOptions }
      : originalPathOrOptions ?? {};
    const contentBytes = Buffer.byteLength(content, "utf8");
    if (contentBytes > MAX_TEXT_FILE_BYTES) throw new BadRequestException(`Text files cannot exceed ${formatBytes(MAX_TEXT_FILE_BYTES)}`);
    const workspace = await this.getWorkspace(currentUser, workspaceId);
    const absolutePath = await this.resolveFilePath(workspace.rootPath, filePath, true);
    const normalizedOriginalPath = options.originalPath?.trim();
    const requestedLockPath = normalizedOriginalPath || filePath.trim();
    const requestedLockAbsolutePath = await this.resolveFilePath(workspace.rootPath, requestedLockPath, true);
    const requestedLockRelativePath = normalizeRelativePath(workspace.rootPath, requestedLockAbsolutePath);
    if (options.requireLock) {
      await this.assertWritableFileLock(currentUser, workspaceId, requestedLockRelativePath, options.lockToken);
    }
    let renamedAsset: Awaited<ReturnType<typeof this.prisma.workspaceAsset.findFirst>> = null;
    if (normalizedOriginalPath && normalizedOriginalPath !== filePath.trim()) {
      const originalDirectory = parentDirectory(normalizedOriginalPath);
      const targetDirectory = parentDirectory(filePath.trim());
      if (originalDirectory !== targetDirectory) throw new BadRequestException("Only file name changes are allowed; directory changes are not supported here");
      const originalAbsolutePath = await this.resolveFilePath(workspace.rootPath, normalizedOriginalPath);
      const targetExists = await stat(absolutePath).catch(() => null);
      if (targetExists) throw new BadRequestException("A file with this name already exists in the current directory");
      await mkdir(dirname(absolutePath), { recursive: true });
      await rename(originalAbsolutePath, absolutePath);
      renamedAsset = await this.prisma.workspaceAsset.findFirst({
        where: { workspaceId, path: normalizeRelativePath(workspace.rootPath, originalAbsolutePath), deletedAt: null }
      });
    }
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content, "utf8");
    const fileStat = await stat(absolutePath);
    const relativePath = normalizeRelativePath(workspace.rootPath, absolutePath);
    const existing = await this.prisma.workspaceAsset.findFirst({
      where: { workspaceId, path: relativePath, deletedAt: null }
    }) ?? renamedAsset;
    this.assertExpectedFileVersion(existing?.metadata, options.expectedVersion);
    const checksumSha256 = sha256Buffer(Buffer.from(content, "utf8"));
    const existingMetadata = asRecord(existing?.metadata) ?? {};
    const baseAssetData = {
      kind: inferAssetKind(absolutePath),
      name: basename(absolutePath),
      path: relativePath,
      mimeType: inferMimeType(absolutePath),
      size: fileStat.size,
      summary: summarizeText(content),
      metadata: {
        ...existingMetadata,
        ...assetMetadataFields(checksumSha256)
      } as Prisma.InputJsonValue
    };
    const asset = existing
      ? await this.prisma.workspaceAsset.update({ where: { id: existing.id }, data: baseAssetData })
      : await this.prisma.workspaceAsset.create({ data: { id: `asset-${nanoid(10)}`, workspaceId, ...baseAssetData } });
    const action = renamedAsset ? "renamed" : existing ? "updated" : "created";
    const version = await this.createAssetVersionSnapshot({
      workspaceRoot: workspace.rootPath,
      assetId: asset.id,
      sourceRelativePath: relativePath,
      size: fileStat.size,
      checksumSha256,
      createdByUserId: currentUser.id,
      metadata: {
        source: "text_write",
        action,
        ...(renamedAsset && normalizedOriginalPath ? { previousPath: normalizedOriginalPath } : {})
      }
    });
    await this.appendWorkspaceFileChangeMemory({
      conversationId: workspace.conversationId,
      workspaceId,
      assetId: asset.id,
      path: relativePath,
      name: asset.name,
      mimeType: asset.mimeType ?? inferMimeType(absolutePath),
      size: asset.size ?? fileStat.size,
      version,
      checksumSha256,
      actorUserId: currentUser.id,
      action: action === "created" ? "created" : "updated",
      summary: summarizeText(content)
    });
    const hubKind = normalizeHubKind(existingMetadata.hubKind);
    if (hubKind) await this.syncHubAssetIndexById(hubKind, asset.id);
    if (options.lockToken) {
      await this.prisma.workspaceFileLock.updateMany({
        where: {
          workspaceId,
          token: options.lockToken,
          lockedByUserId: currentUser.id,
          releasedAt: null
        },
        data: {
          path: relativePath,
          expiresAt: new Date(Date.now() + FILE_LOCK_TTL_MS)
        }
      });
    }
    await this.realtime.emit("workspace", workspaceId, "workspace.file.changed", {
      workspaceId,
      conversationId: workspace.conversationId,
      assetId: asset.id,
      path: asset.path,
      ...(renamedAsset && normalizedOriginalPath ? { previousPath: normalizedOriginalPath } : {}),
      name: asset.name,
      mimeType: asset.mimeType ?? inferMimeType(absolutePath),
      size: asset.size ?? fileStat.size,
      version,
      checksumSha256,
      action,
      actorUserId: currentUser.id,
      actorName: currentUser.name,
      changedAt: new Date().toISOString()
    });
    return {
      path: asset.path,
      name: asset.name,
      mimeType: asset.mimeType,
      size: asset.size,
      assetId: asset.id
    };
  }

  async beginUpload(currentUser: AgentHubUser, workspaceId: string, file: { name: string; mimeType: string; size: number }) {
    await this.assertCanMutateWorkspace(currentUser, workspaceId);
    const workspace = await this.getWorkspace(currentUser, workspaceId);
    validateUploadSize(file.size, MAX_WORKSPACE_UPLOAD_BYTES);
    const safeName = sanitizeFileName(file.name);
    const uploadId = `upload-${nanoid(12)}`;
    const storagePath = `.uploads/${uploadId}.part`;
    const absolutePath = await this.resolveFilePath(workspace.rootPath, storagePath, true);
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, Buffer.alloc(0));
    const session = await this.prisma.workspaceUploadSession.create({
      data: {
        id: uploadId,
        workspaceId,
        createdByUserId: currentUser.id,
        name: safeName,
        mimeType: file.mimeType || inferMimeType(safeName),
        size: file.size,
        storagePath,
        status: "uploading",
        expiresAt: new Date(Date.now() + UPLOAD_SESSION_TTL_MS)
      }
    });
    return toUploadSession(session);
  }

  async appendUploadChunk(
    currentUser: AgentHubUser,
    workspaceId: string,
    uploadId: string,
    chunk: { offset: number; content: Buffer }
  ) {
    await this.assertCanMutateWorkspace(currentUser, workspaceId);
    const workspace = await this.getWorkspace(currentUser, workspaceId);
    const session = await this.getMutableUploadSession(currentUser, workspaceId, uploadId);
    if (chunk.content.byteLength <= 0) throw new BadRequestException("Upload chunk cannot be empty");
    if (chunk.content.byteLength > MAX_WORKSPACE_UPLOAD_CHUNK_BYTES) {
      throw new BadRequestException(`Upload chunk cannot exceed ${formatBytes(MAX_WORKSPACE_UPLOAD_CHUNK_BYTES)}`);
    }
    if (chunk.offset !== session.receivedBytes) {
      throw new BadRequestException(`Upload chunk offset mismatch: expected ${session.receivedBytes}`);
    }
    if (session.receivedBytes + chunk.content.byteLength > session.size) {
      throw new BadRequestException("Upload chunk exceeds declared file size");
    }
    const absolutePath = await this.resolveFilePath(workspace.rootPath, session.storagePath, true);
    await appendFile(absolutePath, chunk.content);
    const updated = await this.prisma.workspaceUploadSession.update({
      where: { id: session.id },
      data: { receivedBytes: { increment: chunk.content.byteLength } }
    });
    return toUploadSession(updated);
  }

  async completeUpload(currentUser: AgentHubUser, workspaceId: string, uploadId: string) {
    await this.assertCanMutateWorkspace(currentUser, workspaceId);
    const workspace = await this.getWorkspace(currentUser, workspaceId);
    const session = await this.getMutableUploadSession(currentUser, workspaceId, uploadId);
    if (session.receivedBytes !== session.size) throw new BadRequestException("Upload is incomplete");
    const tempPath = await this.resolveFilePath(workspace.rootPath, session.storagePath, true);
    const tempStat = await stat(tempPath);
    if (!tempStat.isFile() || tempStat.size !== session.size) throw new BadRequestException("Upload payload size does not match session");
    const scan = await this.scanPendingUploadOrReject(session.id, tempPath, {
      name: session.name,
      mimeType: session.mimeType
    });
    const checksumSha256 = await sha256File(tempPath);
    const assetId = `asset-${nanoid(10)}`;
    const finalPath = `uploads/${new Date().toISOString().slice(0, 10)}/${assetId}-${session.name}`;
    const absoluteFinalPath = await this.resolveFilePath(workspace.rootPath, finalPath, true);
    await mkdir(dirname(absoluteFinalPath), { recursive: true });
    await rename(tempPath, absoluteFinalPath);
    const asset = await this.prisma.$transaction(async (tx) => {
      const created = await tx.workspaceAsset.create({
        data: {
          id: assetId,
          workspaceId,
          kind: inferAssetKind(session.name),
          name: session.name,
          path: finalPath,
          mimeType: session.mimeType || inferMimeType(session.name),
          size: session.size,
          summary: summarizeUploadedAsset(session.name, session.mimeType, await readFile(absoluteFinalPath)),
          metadata: assetMetadata(checksumSha256, { uploadSessionId: session.id, scan })
        }
      });
      await tx.workspaceUploadSession.update({
        where: { id: session.id },
        data: { status: "completed", completedAt: new Date(), assetId: created.id }
      });
      return created;
    });
    await this.createAssetVersionSnapshot({
      workspaceRoot: workspace.rootPath,
      assetId: asset.id,
      sourceRelativePath: finalPath,
      size: session.size,
      checksumSha256,
      createdByUserId: currentUser.id,
      metadata: { source: "chunk_upload", uploadSessionId: session.id, scan }
    });
    return {
      ...toWorkspaceAsset(asset),
      mimeType: asset.mimeType ?? inferMimeType(asset.path),
      size: asset.size ?? undefined
    };
  }

  private async scanPendingUploadOrReject(uploadId: string, tempPath: string, input: { name: string; mimeType: string }) {
    try {
      return await scanUploadedFile({ ...input, path: tempPath });
    } catch (error) {
      await this.prisma.workspaceUploadSession.update({
        where: { id: uploadId },
        data: { status: "rejected", cancelledAt: new Date() }
      });
      await rm(tempPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async cancelUpload(currentUser: AgentHubUser, workspaceId: string, uploadId: string) {
    await this.assertCanMutateWorkspace(currentUser, workspaceId);
    const workspace = await this.getWorkspace(currentUser, workspaceId);
    const session = await this.getMutableUploadSession(currentUser, workspaceId, uploadId);
    await this.prisma.workspaceUploadSession.update({
      where: { id: session.id },
      data: { status: "cancelled", cancelledAt: new Date() }
    });
    const absolutePath = await this.resolveFilePath(workspace.rootPath, session.storagePath, true).catch(() => null);
    if (absolutePath) await rm(absolutePath, { force: true }).catch(() => undefined);
    return { uploadId };
  }

  async storeUploadedAsset(
    currentUser: AgentHubUser,
    workspaceId: string,
    file: { name: string; mimeType: string; content: Buffer }
  ) {
    await this.assertCanMutateWorkspace(currentUser, workspaceId);
    validateUploadSize(file.content.byteLength, MAX_LEGACY_UPLOAD_BYTES);
    const safeName = sanitizeFileName(file.name);
    const scan = scanUploadedBuffer({ name: safeName, mimeType: file.mimeType, content: file.content });
    const uploadPath = `uploads/${new Date().toISOString().slice(0, 10)}/${nanoid(10)}-${safeName}`;
    const absolutePath = await this.resolveFilePath((await this.getWorkspace(currentUser, workspaceId)).rootPath, uploadPath, true);
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, file.content);
    const checksumSha256 = sha256Buffer(file.content);
    const asset = await this.prisma.workspaceAsset.create({
      data: {
        id: `asset-${nanoid(10)}`,
        workspaceId,
        kind: inferAssetKind(safeName),
        name: safeName,
        path: uploadPath,
        mimeType: file.mimeType || inferMimeType(safeName),
        size: file.content.byteLength,
        summary: summarizeUploadedAsset(safeName, file.mimeType, file.content),
        metadata: assetMetadata(checksumSha256, { uploadMode: "legacy_base64", scan })
      }
    });
    await this.createAssetVersionSnapshot({
      workspaceRoot: (await this.getWorkspace(currentUser, workspaceId)).rootPath,
      assetId: asset.id,
      sourceRelativePath: uploadPath,
      size: file.content.byteLength,
      checksumSha256,
      createdByUserId: currentUser.id,
      metadata: { source: "legacy_base64_upload", scan }
    });
    return {
      ...toWorkspaceAsset(asset),
      mimeType: asset.mimeType ?? inferMimeType(asset.path),
      size: asset.size ?? undefined
    };
  }

  private async currentFileLock(workspaceId: string, relativePath: string, currentUserId: string) {
    const lock = await this.prisma.workspaceFileLock.findUnique({
      where: { workspaceId_path: { workspaceId, path: relativePath } }
    });
    if (!lock || lock.releasedAt || lock.expiresAt <= new Date()) return null;
    return this.toFileLockView(lock, currentUserId);
  }

  private async assertWritableFileLock(currentUser: AgentHubUser, workspaceId: string, relativePath: string, lockToken: string | undefined) {
    if (!lockToken) throw new ConflictException("编辑锁缺失，请重新进入编辑模式后保存");
    const lock = await this.prisma.workspaceFileLock.findUnique({
      where: { workspaceId_path: { workspaceId, path: relativePath } }
    });
    if (!lock || lock.releasedAt || lock.expiresAt <= new Date()) {
      throw new ConflictException("文件编辑锁已失效，请刷新文件后重新编辑");
    }
    if (lock.lockedByUserId !== currentUser.id || lock.token !== lockToken) {
      const owner = await this.prisma.user.findFirst({
        where: { id: lock.lockedByUserId, deletedAt: null },
        select: { name: true }
      });
      throw new ConflictException(`${owner?.name ?? "其他成员"} 正在编辑该文件，不能覆盖保存`);
    }
  }

  private assertExpectedFileVersion(metadata: Prisma.JsonValue | null | undefined, expectedVersion: number | undefined) {
    if (expectedVersion === undefined) return;
    const currentVersion = typeof asRecord(metadata)?.latestVersion === "number" ? asRecord(metadata)?.latestVersion as number : 0;
    if (currentVersion !== expectedVersion) {
      throw new ConflictException(`文件已被其他人更新：当前版本 v${currentVersion}，你的编辑基于 v${expectedVersion}。请刷新后重新合并修改。`);
    }
  }

  private async toFileLockView(
    lock: { id: string; path: string; lockedByUserId: string; token: string; expiresAt: Date; updatedAt: Date },
    currentUserId: string
  ) {
    const owner = await this.prisma.user.findFirst({
      where: { id: lock.lockedByUserId, deletedAt: null },
      select: { name: true }
    });
    return {
      id: lock.id,
      path: lock.path,
      lockedByUserId: lock.lockedByUserId,
      lockedByName: owner?.name ?? lock.lockedByUserId,
      token: lock.lockedByUserId === currentUserId ? lock.token : undefined,
      ownedByMe: lock.lockedByUserId === currentUserId,
      expiresAt: lock.expiresAt.toISOString(),
      updatedAt: lock.updatedAt.toISOString()
    };
  }

  async listAssetVersions(currentUser: AgentHubUser, workspaceId: string, assetId: string) {
    await this.getWorkspace(currentUser, workspaceId);
    const asset = await this.prisma.workspaceAsset.findFirst({ where: { id: assetId, workspaceId, deletedAt: null } });
    if (!asset) throw new NotFoundException("Workspace asset not found");
    const versions = await this.prisma.workspaceAssetVersion.findMany({
      where: { assetId },
      orderBy: { version: "desc" }
    });
    const userIds = [...new Set(versions.flatMap((version) => {
      const userId = version.createdByUserId;
      return userId && userId !== "agent-runtime" ? [userId] : [];
    }))];
    const users = userIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: userIds }, deletedAt: null },
          select: { id: true, name: true }
        })
      : [];
    const userNameById = new Map(users.map((user) => [user.id, user.name]));
    return versions.map((version) => ({
      id: version.id,
      assetId: version.assetId,
      version: version.version,
      size: version.size,
      checksumSha256: version.checksumSha256,
      createdByUserId: version.createdByUserId,
      createdByName: version.createdByUserId === "agent-runtime"
        ? "Agent Runtime"
        : userNameById.get(version.createdByUserId ?? "") ?? version.createdByUserId ?? "系统",
      createdAt: version.createdAt.toISOString(),
      source: normalizeOptionalString(asRecord(version.metadata)?.source) ?? "workspace_asset",
      sourceLabel: sourceLabel(normalizeOptionalString(asRecord(version.metadata)?.source) ?? "workspace_asset"),
      action: normalizeOptionalString(asRecord(version.metadata)?.action),
      previousPath: normalizeOptionalString(asRecord(version.metadata)?.previousPath),
      restoredFromVersion: toFiniteNumber(asRecord(version.metadata)?.restoredFromVersion)
    }));
  }

  async readAssetVersion(currentUser: AgentHubUser, workspaceId: string, assetId: string, versionNumber: number) {
    const workspace = await this.getWorkspace(currentUser, workspaceId);
    const { asset, version, content, mimeType, size } = await this.readAssetVersionPayload(workspace.rootPath, workspaceId, assetId, versionNumber);
    const previewableText = isTextPreviewMime(mimeType) && size <= MAX_TEXT_FILE_BYTES;
    return {
      id: version.id,
      assetId: version.assetId,
      version: version.version,
      path: asset.path,
      name: asset.name,
      mimeType,
      size,
      checksumSha256: version.checksumSha256,
      createdByUserId: version.createdByUserId,
      createdAt: version.createdAt.toISOString(),
      source: normalizeOptionalString(asRecord(version.metadata)?.source) ?? "workspace_asset",
      sourceLabel: sourceLabel(normalizeOptionalString(asRecord(version.metadata)?.source) ?? "workspace_asset"),
      action: normalizeOptionalString(asRecord(version.metadata)?.action),
      content: previewableText ? content.toString("utf8") : "",
      binary: !previewableText,
      previewableText
    };
  }

  async readAssetVersionContent(currentUser: AgentHubUser, workspaceId: string, assetId: string, versionNumber: number) {
    const workspace = await this.getWorkspace(currentUser, workspaceId);
    const { asset, version, content, mimeType, size } = await this.readAssetVersionPayload(workspace.rootPath, workspaceId, assetId, versionNumber);
    return {
      name: asset.name,
      mimeType,
      size,
      checksumSha256: version.checksumSha256,
      content
    };
  }

  async rollbackAssetVersion(currentUser: AgentHubUser, workspaceId: string, assetId: string, versionNumber: number) {
    await this.assertCanMutateWorkspace(currentUser, workspaceId);
    const workspace = await this.getWorkspace(currentUser, workspaceId);
    const asset = await this.prisma.workspaceAsset.findFirst({ where: { id: assetId, workspaceId, deletedAt: null } });
    if (!asset) throw new NotFoundException("Workspace asset not found");
    const version = await this.prisma.workspaceAssetVersion.findFirst({ where: { assetId, version: versionNumber } });
    if (!version) throw new NotFoundException("Workspace asset version not found");
    const sourcePath = await this.resolveFilePath(workspace.rootPath, version.path);
    const destinationPath = await this.resolveFilePath(workspace.rootPath, asset.path, true);
    await mkdir(dirname(destinationPath), { recursive: true });
    await copyFile(sourcePath, destinationPath);
    const checksumSha256 = await sha256File(destinationPath);
    const fileStat = await stat(destinationPath);
    const updated = await this.prisma.workspaceAsset.update({
      where: { id: asset.id },
      data: {
        size: fileStat.size,
        summary: isTextMime(asset.mimeType ?? inferMimeType(asset.path))
          ? summarizeText(await readFile(destinationPath, "utf8"))
          : asset.summary,
        metadata: assetMetadata(checksumSha256, { restoredFromVersion: version.version })
      }
    });
    await this.createAssetVersionSnapshot({
      workspaceRoot: workspace.rootPath,
      assetId: asset.id,
      sourceRelativePath: asset.path,
      size: fileStat.size,
      checksumSha256,
      createdByUserId: currentUser.id,
      metadata: { source: "rollback", action: "rollback", restoredFromVersion: version.version }
    });
    const hubKind = normalizeHubKind(asRecord(updated.metadata)?.hubKind);
    if (hubKind) await this.syncHubAssetIndexById(hubKind, updated.id);
    return {
      ...toWorkspaceAsset(updated),
      mimeType: updated.mimeType ?? inferMimeType(updated.path),
      size: updated.size ?? undefined
    };
  }

  private async readAssetVersionPayload(workspaceRoot: string, workspaceId: string, assetId: string, versionNumber: number) {
    const asset = await this.prisma.workspaceAsset.findFirst({ where: { id: assetId, workspaceId, deletedAt: null } });
    if (!asset) throw new NotFoundException("Workspace asset not found");
    const version = await this.prisma.workspaceAssetVersion.findFirst({ where: { assetId, version: versionNumber } });
    if (!version) throw new NotFoundException("Workspace asset version not found");
    const absolutePath = await this.resolveFilePath(workspaceRoot, version.path);
    const content = await readFile(absolutePath);
    return {
      asset,
      version,
      content,
      mimeType: asset.mimeType ?? inferMimeType(asset.path),
      size: content.byteLength
    };
  }

  async deleteAsset(currentUser: AgentHubUser, workspaceId: string, assetId: string, confirmation: string) {
    await this.assertCanMutateWorkspace(currentUser, workspaceId);
    const workspace = await this.getWorkspace(currentUser, workspaceId);
    const asset = await this.prisma.workspaceAsset.findFirst({
      where: { id: assetId, workspaceId, deletedAt: null }
    });
    if (!asset) throw new NotFoundException("Workspace asset not found");
    assertDangerousConfirmation(confirmation, asset.name);
    await this.prisma.workspaceAsset.update({
      where: { id: asset.id },
      data: { deletedAt: new Date() }
    });
    await this.markHubAssetIndexDeleted(asset.id);
    const absolutePath = await this.resolveFilePath(workspace.rootPath, asset.path).catch(() => null);
    if (absolutePath) await rm(absolutePath, { force: true }).catch(() => undefined);
    return { assetId };
  }

  private async getMutableUploadSession(currentUser: AgentHubUser, workspaceId: string, uploadId: string) {
    const session = await this.prisma.workspaceUploadSession.findFirst({
      where: { id: uploadId, workspaceId }
    });
    if (!session) throw new NotFoundException("Workspace upload session not found");
    if (session.createdByUserId !== currentUser.id && currentUser.role !== "admin") {
      throw new NotFoundException("Workspace upload session not found");
    }
    if (session.status !== "uploading") throw new BadRequestException(`Upload session is ${session.status}`);
    if (session.expiresAt < new Date()) {
      await this.prisma.workspaceUploadSession.update({
        where: { id: session.id },
        data: { status: "expired" }
      });
      throw new BadRequestException("Upload session has expired");
    }
    return session;
  }

  private async createAssetVersionSnapshot(input: {
    workspaceRoot: string;
    assetId: string;
    sourceRelativePath: string;
    size: number;
    checksumSha256: string;
    createdByUserId?: string;
    metadata?: Record<string, unknown>;
  }) {
    const latest = await this.prisma.workspaceAssetVersion.findFirst({
      where: { assetId: input.assetId },
      orderBy: { version: "desc" }
    });
    const asset = await this.prisma.workspaceAsset.findUnique({
      where: { id: input.assetId },
      select: { metadata: true }
    });
    const version = (latest?.version ?? 0) + 1;
    const sourcePath = await this.resolveFilePath(input.workspaceRoot, input.sourceRelativePath);
    const snapshotPath = `.versions/${input.assetId}/v${version}-${basename(input.sourceRelativePath)}`;
    const absoluteSnapshotPath = await this.resolveFilePath(input.workspaceRoot, snapshotPath, true);
    await mkdir(dirname(absoluteSnapshotPath), { recursive: true });
    await copyFile(sourcePath, absoluteSnapshotPath);
    await this.prisma.workspaceAssetVersion.create({
      data: {
        id: `asset-version-${nanoid(10)}`,
        assetId: input.assetId,
        version,
        path: snapshotPath,
        size: input.size,
        checksumSha256: input.checksumSha256,
        createdByUserId: input.createdByUserId ?? null,
        metadata: input.metadata as Prisma.InputJsonValue
      }
    });
    await this.prisma.workspaceAsset.update({
      where: { id: input.assetId },
      data: {
        metadata: {
          ...(asRecord(asset?.metadata) ?? {}),
          ...(input.metadata ?? {}),
          storage: "local",
          checksumSha256: input.checksumSha256,
          etag: `"sha256-${input.checksumSha256}"`,
          latestVersion: version
        } as Prisma.InputJsonValue
      }
    });
    await this.pruneAssetVersionSnapshots(input.workspaceRoot, input.assetId, 5);
    return version;
  }

  private async pruneAssetVersionSnapshots(workspaceRoot: string, assetId: string, keep: number) {
    const staleVersions = await this.prisma.workspaceAssetVersion.findMany({
      where: { assetId },
      orderBy: { version: "desc" },
      skip: keep
    });
    if (!staleVersions.length) return;
    await this.prisma.workspaceAssetVersion.deleteMany({
      where: { id: { in: staleVersions.map((version) => version.id) } }
    });
    await Promise.all(staleVersions.map(async (version) => {
      const absolutePath = await this.resolveFilePath(workspaceRoot, version.path, true).catch(() => null);
      if (absolutePath) await rm(absolutePath, { force: true }).catch(() => undefined);
    }));
  }

  private async appendWorkspaceFileChangeMemory(input: {
    conversationId: string;
    workspaceId: string;
    assetId: string;
    path: string;
    name: string;
    mimeType: string;
    size: number | null | undefined;
    version: number;
    checksumSha256: string;
    actorUserId: string;
    action: "created" | "updated";
    summary: string;
  }) {
    const changedAt = new Date().toISOString();
    const change = {
      id: `workspace-file-change-${nanoid(10)}`,
      conversationId: input.conversationId,
      workspaceId: input.workspaceId,
      assetId: input.assetId,
      path: input.path,
      name: input.name,
      mimeType: input.mimeType,
      size: input.size ?? 0,
      version: input.version,
      checksumSha256: input.checksumSha256,
      actorUserId: input.actorUserId,
      action: input.action,
      summary: input.summary,
      changedAt
    };
    await this.appendConversationMemoryVersion(input.conversationId, (baseMemory) => {
      const chatMemory = asRecord(baseMemory.chatMemory) ?? {};
      const previousChanges = Array.isArray(chatMemory.workspaceFileChanges)
        ? chatMemory.workspaceFileChanges.filter(asRecord)
        : [];
      return {
        ...baseMemory,
        chatMemory: {
          ...chatMemory,
          workspaceFileChanges: [change, ...previousChanges].slice(0, 80)
        }
      };
    });
  }

  private async appendConversationMemoryVersion(
    conversationId: string,
    buildMemory: (baseMemory: Record<string, unknown>) => Record<string, unknown>
  ) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const latestMemory = await this.prisma.conversationMemory.findFirst({
        where: { conversationId, deletedAt: null },
        orderBy: { version: "desc" }
      });
      const baseMemory = latestMemory
        ? asRecord(latestMemory.memory) ?? {}
        : await this.createFallbackConversationMemoryBase(conversationId);
      const version = (latestMemory?.version ?? 0) + 1;
      try {
        return await this.prisma.conversationMemory.create({
          data: {
            id: `memory-${nanoid(10)}`,
            conversationId,
            version,
            memory: buildMemory(baseMemory) as Prisma.InputJsonValue
          }
        });
      } catch (error) {
        if (!isUniqueConstraintError(error) || attempt >= 4) throw error;
      }
    }
  }

  private async createFallbackConversationMemoryBase(conversationId: string) {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { id: true, title: true, workspaceId: true }
    });
    return {
      projectCore: {
        title: conversation?.title ?? "",
        basicInfo: {
          conversationId,
          workspaceId: conversation?.workspaceId ?? null,
          name: conversation?.title ?? ""
        }
      },
      chatMemory: { pinMessages: [] }
    };
  }

  private async loadHubAssetRecord(assetId: string) {
    const asset = await this.prisma.workspaceAsset.findFirst({
      where: { id: assetId, deletedAt: null },
      include: {
        workspace: {
          include: {
            conversation: {
              include: { members: { where: { memberType: "user", deletedAt: null } } }
            }
          }
        }
      }
    });
    if (!asset) throw new NotFoundException("Hub asset not found");
    return asset;
  }

  private async syncHubAssetIndex(kind: HubKind, asset: WorkspaceHubAssetRecord) {
    const metadata = asRecord(asset.metadata) ?? {};
    if (kind === "skill" && !isSkillAsset(asset.name, asset.path, asset.summary, asset.metadata)) return null;
    if (kind === "knowledge" && isSkillAsset(asset.name, asset.path, asset.summary, asset.metadata)) return null;
    const owner = hubAssetOwner(asset);
    const visibility = normalizeOptionalString(metadata.visibility) === "public" ? "public" : "private";
    const source = currentAssetSource(asset);
    const sourceSpec = {
      sourceAssetId: asset.id,
      workspaceId: asset.workspaceId,
      path: asset.path,
      mimeType: asset.mimeType ?? inferMimeType(asset.path),
      size: asset.size ?? null,
      sourceAssetVersion: source.version,
      sourceFingerprint: source.fingerprint
    };
    const baseSpec = {
      kind,
      name: asset.name,
      description: asset.summary ?? "",
      visibility,
      owner,
      source: sourceSpec,
      metadata
    };
    const fingerprint = fingerprintHubAssetSpec(baseSpec);
    if (kind === "skill") {
      const existing = await this.prisma.skillAsset.findUnique({
        where: { sourceAssetId: asset.id },
        include: { versions: { orderBy: { version: "desc" }, take: 1 } }
      });
      const nextVersion = existing && existing.currentFingerprint !== fingerprint
        ? existing.currentVersion + 1
        : existing?.currentVersion ?? 1;
      const releaseVersion = nextSkillReleaseVersion(metadata.releaseVersion, existing, fingerprint);
      const spec = skillSpec(asset, baseSpec);
      const row = await this.prisma.skillAsset.upsert({
        where: { sourceAssetId: asset.id },
        create: {
          sourceAssetId: asset.id,
          ownerType: owner.ownerType,
          ownerId: owner.ownerId,
          name: asset.name,
          description: asset.summary ?? "",
          visibility,
          triggerSyntax: spec.triggerSyntax as Prisma.InputJsonValue,
          injectionMode: spec.injectionMode,
          targetAgentTypes: spec.targetAgentTypes as Prisma.InputJsonValue,
          requiredTools: spec.requiredTools as Prisma.InputJsonValue,
          outputRules: spec.outputRules as Prisma.InputJsonValue,
          safetyRules: spec.safetyRules as Prisma.InputJsonValue,
          currentVersion: nextVersion,
          releaseVersion,
          currentFingerprint: fingerprint,
          versions: {
            create: {
              version: nextVersion,
              releaseVersion,
              sourceAssetId: asset.id,
              sourceAssetVersion: source.version,
              spec: spec as Prisma.InputJsonValue,
              fingerprint
            }
          }
        },
        update: {
          ownerType: owner.ownerType,
          ownerId: owner.ownerId,
          name: asset.name,
          description: asset.summary ?? "",
          visibility,
          triggerSyntax: spec.triggerSyntax as Prisma.InputJsonValue,
          injectionMode: spec.injectionMode,
          targetAgentTypes: spec.targetAgentTypes as Prisma.InputJsonValue,
          requiredTools: spec.requiredTools as Prisma.InputJsonValue,
          outputRules: spec.outputRules as Prisma.InputJsonValue,
          safetyRules: spec.safetyRules as Prisma.InputJsonValue,
          currentVersion: nextVersion,
          releaseVersion,
          currentFingerprint: fingerprint,
          deletedAt: null
        }
      });
      await this.ensureSkillVersion(row.id, nextVersion, releaseVersion, asset.id, source.version, spec, fingerprint);
      return { sourceAssetId: asset.id, version: row.currentVersion, fingerprint: row.currentFingerprint };
    }
    const existing = await this.prisma.knowledgeAsset.findUnique({
      where: { sourceAssetId: asset.id },
      include: { versions: { orderBy: { version: "desc" }, take: 1 } }
    });
    const nextVersion = existing && existing.currentFingerprint !== fingerprint
      ? existing.currentVersion + 1
      : existing?.currentVersion ?? 1;
    const spec = knowledgeSpec(asset, baseSpec);
    const row = await this.prisma.knowledgeAsset.upsert({
      where: { sourceAssetId: asset.id },
      create: {
        sourceAssetId: asset.id,
        ownerType: owner.ownerType,
        ownerId: owner.ownerId,
        name: asset.name,
        description: asset.summary ?? "",
        visibility,
        sourceType: spec.sourceType,
        accessScope: spec.accessScope,
        summary: spec.summary,
        indexStatus: spec.indexStatus,
        fileCount: spec.fileCount,
        currentVersion: nextVersion,
        currentFingerprint: fingerprint,
        versions: {
          create: {
            version: nextVersion,
            sourceAssetId: asset.id,
            sourceAssetVersion: source.version,
            spec: spec as Prisma.InputJsonValue,
            fingerprint
          }
        }
      },
      update: {
        ownerType: owner.ownerType,
        ownerId: owner.ownerId,
        name: asset.name,
        description: asset.summary ?? "",
        visibility,
        sourceType: spec.sourceType,
        accessScope: spec.accessScope,
        summary: spec.summary,
        indexStatus: spec.indexStatus,
        fileCount: spec.fileCount,
        currentVersion: nextVersion,
        currentFingerprint: fingerprint,
        deletedAt: null
      }
    });
    await this.ensureKnowledgeVersion(row.id, nextVersion, asset.id, source.version, spec, fingerprint);
    return { sourceAssetId: asset.id, version: row.currentVersion, fingerprint: row.currentFingerprint };
  }

  private async ensureSkillVersion(skillAssetId: string, version: number, releaseVersion: string, sourceAssetId: string, sourceAssetVersion: number, spec: Record<string, unknown>, fingerprint: string) {
    await this.prisma.skillVersion.upsert({
      where: { skillAssetId_version: { skillAssetId, version } },
      create: {
        skillAssetId,
        version,
        releaseVersion,
        sourceAssetId,
        sourceAssetVersion,
        spec: spec as Prisma.InputJsonValue,
        fingerprint
      },
      update: {
        releaseVersion,
        sourceAssetId,
        sourceAssetVersion,
        spec: spec as Prisma.InputJsonValue,
        fingerprint,
        deletedAt: null
      }
    });
  }

  private async ensureKnowledgeVersion(knowledgeAssetId: string, version: number, sourceAssetId: string, sourceAssetVersion: number, spec: Record<string, unknown>, fingerprint: string) {
    await this.prisma.knowledgeVersion.upsert({
      where: { knowledgeAssetId_version: { knowledgeAssetId, version } },
      create: {
        knowledgeAssetId,
        version,
        sourceAssetId,
        sourceAssetVersion,
        spec: spec as Prisma.InputJsonValue,
        fingerprint
      },
      update: {
        sourceAssetId,
        sourceAssetVersion,
        spec: spec as Prisma.InputJsonValue,
        fingerprint,
        deletedAt: null
      }
    });
  }

  private async markHubAssetIndexDeleted(sourceAssetId: string) {
    const deletedAt = new Date();
    await this.prisma.skillAsset.updateMany({ where: { sourceAssetId, deletedAt: null }, data: { deletedAt } });
    await this.prisma.knowledgeAsset.updateMany({ where: { sourceAssetId, deletedAt: null }, data: { deletedAt } });
  }

  private async publishGitReviewProposalMessage(
    sender: AgentHubUser,
    conversationId: string,
    input: {
      proposalId: string;
      diffAssetId: string;
      title: string;
      summary: string;
      changedFileCount: number;
      contributors: CodeContributor[];
      diffPath: string;
      changedFiles: Array<{ path: string; additions?: number; deletions?: number }>;
      diffText: string;
    }
  ) {
    const contributorNames = input.contributors.length ? input.contributors.map((item) => item.name).join("、") : sender.name || sender.id;
    const text = [
      `提交了代码审阅：${input.title}`,
      "",
      input.summary,
      "",
      `- 变更文件：${input.changedFileCount} 个`,
      `- 贡献者：${contributorNames}`
    ].join("\n");
    const blocks: MessageBlock[] = [
      createMarkdownBlock(`block-${nanoid(8)}`, text),
      {
        blockId: `block-${nanoid(8)}`,
        schemaVersion: 1,
        type: "diff",
        payload: {
          diffAssetId: input.diffAssetId,
          reviewProposalId: input.proposalId,
          reviewKind: "manual",
          title: `审阅 Diff：${input.title}`,
          files: buildWorkspaceDiffBlockFiles(input.changedFiles, input.diffText),
          reviewState: "pending"
        }
      }
    ];
    const message = await this.prisma.$transaction(async (tx) => {
      const conversation = await tx.conversation.update({
        where: { id: conversationId },
        data: {
          messageSeq: { increment: 1 },
          lastMessage: `提交了代码审阅：${input.title}`
        },
        select: { messageSeq: true }
      });
      const created = await tx.message.create({
        data: {
          id: `msg-${nanoid(10)}`,
          conversationId,
          senderType: "user",
          senderId: sender.id,
          senderName: sender.name,
          senderAvatar: sender.avatar,
          blocks: blocks as unknown as Prisma.InputJsonValue,
          mentions: [] as unknown as Prisma.InputJsonValue,
          metadata: {
            gitReviewProposal: {
              id: input.proposalId,
              diffAssetId: input.diffAssetId,
              title: input.title,
              status: "pending",
              changedFileCount: input.changedFileCount,
              contributors: input.contributors.map(toContributorView),
              diffPath: input.diffPath
            }
          } as unknown as Prisma.InputJsonValue,
          seq: conversation.messageSeq,
          status: "sent",
          userId: sender.id
        }
      });
      await tx.conversationMember.updateMany({
        where: { conversationId, memberType: "user", deletedAt: null, memberId: { not: sender.id } },
        data: { unreadCount: { increment: 1 } }
      });
      await tx.conversationMember.updateMany({
        where: { conversationId, memberType: "user", memberId: sender.id, deletedAt: null },
        data: { unreadCount: 0, lastReadSeq: created.seq }
      });
      return created;
    });
    const chatMessage = toWorkspaceChatMessage(message);
    await this.realtime.emit("conversation", conversationId, "message.created", { message: chatMessage });
    await this.emitConversationUpdatedToMembers(conversationId, "message_created");
  }

  private async emitConversationUpdatedToMembers(conversationId: string, reason: "message_created") {
    const members = await this.prisma.conversationMember.findMany({
      where: { conversationId, memberType: "user", deletedAt: null },
      select: { memberId: true }
    });
    for (const member of members) {
      await this.realtime.emit("user", member.memberId, "conversation.updated", { conversationId, reason });
    }
  }

  private async collectCodeChangeContributors(workspaceId: string, codeRoot: string, files: Array<{ path: string }>) {
    const codePaths = [...new Set(files.map((file) => file.path).filter(Boolean))];
    if (!codePaths.length) return { contributors: [] as CodeContributor[], files: [] as CodeFileContribution[] };
    const workspacePaths = codePaths.map((path) => `${WORKSPACE_CODE_DIR}/${path.replace(/^\/+/, "")}`);
    const headDate = await runGit(codeRoot, ["log", "-1", "--format=%cI"], true);
    const parsedHeadDate = headDate && Number.isFinite(Date.parse(headDate)) ? new Date(headDate) : null;
    const assets = await this.prisma.workspaceAsset.findMany({
      where: { workspaceId, path: { in: workspacePaths }, deletedAt: null },
      include: {
        versions: {
          where: parsedHeadDate ? { createdAt: { gt: parsedHeadDate } } : {},
          orderBy: { createdAt: "asc" }
        }
      }
    });
    const contributorIds = [
      ...new Set(assets.flatMap((asset) => asset.versions.map((version) => version.createdByUserId).filter((id): id is string => Boolean(id))))
    ];
    const users = contributorIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: contributorIds }, deletedAt: null },
          select: { id: true, name: true, avatar: true }
        })
      : [];
    const userById = new Map(users.map((user) => [user.id, user]));
    const totalContributorMap = new Map<string, CodeContributor>();
    const fileContributions = assets.map((asset) => {
      const fileContributorMap = new Map<string, CodeContributor>();
      for (const version of asset.versions) {
        const contributor = contributorFromUserId(version.createdByUserId, version.createdAt.toISOString(), userById);
        if (!contributor) continue;
        mergeContributor(fileContributorMap, contributor);
        mergeContributor(totalContributorMap, contributor);
      }
      const contributors = sortContributors([...fileContributorMap.values()]);
      return {
        path: asset.path.replace(new RegExp(`^${WORKSPACE_CODE_DIR}/`), ""),
        workspacePath: asset.path,
        contributors,
        lastChangedAt: latestContributorChange(contributors)
      };
    });
    return {
      contributors: sortContributors([...totalContributorMap.values()]),
      files: fileContributions
    };
  }

  private async readGitSummary(codeRoot: string) {
    await mkdir(codeRoot, { recursive: true });
    const initialized = await this.ensureCodeGitRepo(codeRoot);
    if (!initialized.ok) {
      return {
        codeRoot: `${WORKSPACE_CODE_DIR}/`,
        repoInitialized: false,
        branch: null,
        headCommit: null,
        headMessage: null,
        dirty: false,
        files: [],
        recentCommits: [],
        error: initialized.error
      };
    }
    const [branch, headCommit, headMessage, statusOutput, logOutput] = await Promise.all([
      runGit(codeRoot, ["branch", "--show-current"], true),
      runGit(codeRoot, ["rev-parse", "--short", "HEAD"], true),
      runGit(codeRoot, ["log", "-1", "--pretty=%s"], true),
      runGit(codeRoot, ["status", "--porcelain=v1"], true),
      runGit(
        codeRoot,
        ["log", "-n", "8", "--pretty=format:%H%x1f%h%x1f%an%x1f%ae%x1f%ad%x1f%s%x1f%(trailers:key=Co-authored-by,valueonly,separator=%x1d)%x1e", "--date=iso-strict"],
        true
      )
    ]);
    const files = parseGitStatus(statusOutput);
    return {
      codeRoot: `${WORKSPACE_CODE_DIR}/`,
      repoInitialized: true,
      branch: branch || "main",
      headCommit: headCommit || null,
      headMessage: headMessage || null,
      dirty: files.length > 0,
      files,
      recentCommits: parseGitLog(logOutput)
    };
  }

  private async ensureCodeGitRepo(codeRoot: string): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      const gitPath = join(codeRoot, ".git");
      const existing = await stat(gitPath).catch(() => null);
      if (existing?.isDirectory()) return { ok: true };
      await runGit(codeRoot, ["init", "-b", "main"], false).catch(async () => {
        await runGit(codeRoot, ["init"], false);
        await runGit(codeRoot, ["checkout", "-B", "main"], true);
      });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private async ensureCleanGitReady(codeRoot: string) {
    const initialized = await this.ensureCodeGitRepo(codeRoot);
    if (!initialized.ok) throw new BadRequestException(initialized.error);
  }

  private async getMutableGitProposal(currentUser: AgentHubUser, workspaceId: string, proposalId: string) {
    const workspace = await this.getWorkspace(currentUser, workspaceId);
    const asset = await this.prisma.workspaceAsset.findFirst({
      where: { id: proposalId, workspaceId, kind: "diff", deletedAt: null }
    });
    if (!asset) throw new NotFoundException("Review proposal not found");
    const metadata = asRecord(asset.metadata) ?? {};
    const proposal = asRecord(metadata.proposal);
    if (!proposal) throw new BadRequestException("This diff asset is not a review proposal");
    const status = normalizeOptionalString(proposal.status) ?? "waiting_review";
    if (status === "approved") throw new BadRequestException("Review proposal has already been approved");
    if (status === "cancelled") throw new BadRequestException("Review proposal has been cancelled");
    return {
      workspace,
      asset,
      proposal: {
        ...proposal,
        id: normalizeOptionalString(proposal.id) ?? asset.id,
        title: normalizeOptionalString(proposal.title) ?? asset.name,
        status
      } as Record<string, unknown>
    };
  }

  private async getMutableGitProposalOrNull(currentUser: AgentHubUser, workspaceId: string, proposalId: string) {
    try {
      return await this.getMutableGitProposal(currentUser, workspaceId, proposalId);
    } catch (error) {
      if (error instanceof NotFoundException) return null;
      throw error;
    }
  }

  private async updateGitProposalMetadata(assetId: string, proposal: Record<string, unknown>) {
    const asset = await this.prisma.workspaceAsset.findUnique({ where: { id: assetId } });
    if (!asset) throw new NotFoundException("Review proposal not found");
    const metadata = asRecord(asset.metadata) ?? {};
    await this.prisma.workspaceAsset.update({
      where: { id: assetId },
      data: {
        summary: normalizeOptionalString(proposal.summary) ?? asset.summary,
        metadata: {
          ...metadata,
          proposal
        } as Prisma.InputJsonValue
      }
    });
  }

  private async updateReviewProposalMessages(
    conversationId: string,
    proposalId: string,
    reviewState: Extract<MessageBlock, { type: "diff" }>["payload"]["reviewState"],
    review: Record<string, unknown>
  ) {
    const messages = await this.prisma.message.findMany({
      where: { conversationId, deletedAt: null },
      orderBy: { createdAt: "desc" },
      take: 200
    });
    for (const message of messages) {
      const blocks = message.blocks as unknown as MessageBlock[];
      let changed = false;
      const nextBlocks = blocks.map((block) => {
        if (block.type === "diff" && block.payload.reviewProposalId === proposalId) {
          changed = true;
          return {
            ...block,
            payload: {
              ...block.payload,
              reviewState
            }
          };
        }
        if (block.type === "agent_status" && block.payload.subtype === "code_task" && block.payload.targetId === proposalId) {
          changed = true;
          const status = reviewState === "approved" ? "merged" : reviewState === "changes_requested" ? "revision_requested" : block.payload.status;
          const summary = reviewState === "approved" ? "主 Agent 已审阅通过，变更已合并。" : "主 Agent 已打回修改，等待 Code Agent 返工。";
          return {
            ...block,
            payload: {
              ...block.payload,
              status,
              summary
            }
          };
        }
        return block;
      });
      const metadata = asRecord(message.metadata) ?? {};
      const gitReviewProposal = asRecord(metadata.gitReviewProposal);
      const metadataProposalId = normalizeOptionalString(gitReviewProposal?.id);
      const nextMetadata =
        gitReviewProposal && metadataProposalId === proposalId
          ? {
              ...metadata,
              gitReviewProposal: {
                ...gitReviewProposal,
                status: reviewState,
                ...review,
                reviewedAt: new Date().toISOString()
              }
            }
          : metadata;
      const metadataChanged = nextMetadata !== metadata;
      if (!changed && !metadataChanged) continue;
      const updated = await this.prisma.message.update({
        where: { id: message.id },
        data: {
          blocks: nextBlocks as unknown as Prisma.InputJsonValue,
          ...(metadataChanged ? { metadata: nextMetadata as Prisma.InputJsonValue } : {})
        }
      });
      await this.realtime.emit("conversation", conversationId, "message.updated", { message: toWorkspaceChatMessage(updated) });
    }
  }

  private async ensureWorkspaceRoot(rootPath: string) {
    const absoluteRoot = resolve(rootPath);
    if (!(await isInsideAnyWorkspaceRootRealpath(this.config.workspacesRoot, absoluteRoot))) {
      throw new NotFoundException("Workspace path is outside the allowed root");
    }
    await mkdir(absoluteRoot, { recursive: true });
    const rootRealpath = await realpath(absoluteRoot);
    if (!(await isInsideAnyWorkspaceRootRealpath(this.config.workspacesRoot, rootRealpath))) {
      throw new NotFoundException("Workspace path is outside the allowed root");
    }
    return rootRealpath;
  }

  private async assertCanMutateWorkspace(currentUser: AgentHubUser, workspaceId: string) {
    if (currentUser.role === "admin") return;
    const workspace = await this.prisma.workspace.findFirst({
      where: {
        id: workspaceId,
        deletedAt: null,
        conversation: { deletedAt: null }
      },
      include: {
        conversation: {
          include: {
            members: {
              where: { memberType: "user", memberId: currentUser.id, deletedAt: null, archivedAt: null }
            },
            memories: {
              where: { deletedAt: null },
              orderBy: { version: "desc" },
              take: 1
            }
          }
        }
      }
    });
    const member = workspace?.conversation.members[0];
    const latestMemory = workspace?.conversation.memories[0]?.memory;
    const projectCore = asRecord(asRecord(latestMemory)?.projectCore);
    const workspaceAccess = projectCore?.workspaceAccess;
    const canMutate = Boolean(member && (
      member.role === "owner" ||
      workspace?.conversation.type === "direct" ||
      (workspace?.conversation.type === "project" && workspaceAccess === "project_members")
    ));
    if (!canMutate) throw new BadRequestException("Only the workspace owner or admin can modify files");
  }

  private async resolveFilePath(workspaceRoot: string, filePath: string, allowCreate = false) {
    const rootPath = await this.ensureWorkspaceRoot(workspaceRoot);
    if (isAbsolute(filePath)) throw new NotFoundException("Workspace file path must be relative");
    const absolutePath = resolve(rootPath, filePath);
    assertInsideBase(rootPath, absolutePath);
    if (allowCreate) return absolutePath;
    const resolved = await realpath(absolutePath);
    assertInsideBase(rootPath, resolved);
    return resolved;
  }
}

async function readTree(rootPath: string, currentPath: string, depth: number): Promise<WorkspaceTreeNode[]> {
  const entries = await readdir(currentPath, { withFileTypes: true }).catch(() => []);
  const nodes: WorkspaceTreeNode[] = [];
  for (const entry of entries.filter((item) => !item.name.startsWith(".")).sort((a, b) => a.name.localeCompare(b.name))) {
    const absolutePath = join(currentPath, entry.name);
    const itemStat = await stat(absolutePath).catch(() => null);
    const node: WorkspaceTreeNode = {
      name: entry.name,
      path: normalizeRelativePath(rootPath, absolutePath),
      type: entry.isDirectory() ? "directory" : "file"
    };
    if (itemStat?.isFile()) node.size = itemStat.size;
    if (entry.isDirectory() && depth > 0) node.children = await readTree(rootPath, absolutePath, depth - 1);
    nodes.push(node);
  }
  return nodes;
}

function assertInsideBase(basePath: string, targetPath: string) {
  const relativePath = relative(resolve(basePath), resolve(targetPath));
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new NotFoundException("Workspace path is outside the allowed root");
  }
}

function normalizeRelativePath(rootPath: string, absolutePath: string) {
  const value = relative(resolve(rootPath), resolve(absolutePath)).replaceAll("\\", "/");
  return value || ".";
}

function parentDirectory(path: string) {
  const normalized = path.trim().replace(/\/+$/, "");
  const index = normalized.lastIndexOf("/");
  return index >= 0 ? normalized.slice(0, index) : "";
}

async function runGit(cwd: string, args: string[], allowFailure: boolean) {
  try {
    const result = await execFileAsync("git", args, {
      cwd,
      maxBuffer: 4_000_000
    });
    return String(result.stdout ?? "").trim();
  } catch (error) {
    if (allowFailure) return "";
    const message = error instanceof Error ? error.message : String(error);
    throw new BadRequestException(`Git command failed: ${message}`);
  }
}

async function buildReviewDiff(codeRoot: string, files: Array<{ path: string; status: string }>) {
  const trackedDiff = await runGit(codeRoot, ["diff", "--no-ext-diff", "--"], true);
  const stagedDiff = await runGit(codeRoot, ["diff", "--cached", "--no-ext-diff", "--"], true);
  const untrackedDiffs: string[] = [];
  for (const file of files.filter((item) => item.status === "??")) {
    const absolutePath = resolve(codeRoot, file.path);
    assertInsideBase(codeRoot, absolutePath);
    const fileStat = await stat(absolutePath).catch(() => null);
    if (!fileStat?.isFile()) continue;
    if (fileStat.size > MAX_TEXT_FILE_BYTES) {
      untrackedDiffs.push(formatBinaryNewFileDiff(file.path, fileStat.size));
      continue;
    }
    const content = await readFile(absolutePath, "utf8").catch(() => null);
    if (content === null) {
      untrackedDiffs.push(formatBinaryNewFileDiff(file.path, fileStat.size));
      continue;
    }
    untrackedDiffs.push(formatTextNewFileDiff(file.path, content));
  }
  return [trackedDiff, stagedDiff, ...untrackedDiffs].filter((part) => part.trim()).join("\n\n");
}

async function buildGitFileDiff(codeRoot: string, file: { path: string; status: string }) {
  const normalizedPath = file.path.replace(/^\/+/, "");
  const absolutePath = resolve(codeRoot, normalizedPath);
  assertInsideBase(codeRoot, absolutePath);
  if (file.status === "??") {
    const fileStat = await stat(absolutePath).catch(() => null);
    if (!fileStat?.isFile()) return "";
    if (fileStat.size > MAX_TEXT_FILE_BYTES) return formatBinaryNewFileDiff(normalizedPath, fileStat.size);
    const content = await readFile(absolutePath, "utf8").catch(() => null);
    if (content === null) return formatBinaryNewFileDiff(normalizedPath, fileStat.size);
    return formatTextNewFileDiff(normalizedPath, content);
  }
  const stagedDiff = await runGit(codeRoot, ["diff", "--cached", "--no-ext-diff", "--", normalizedPath], true);
  const unstagedDiff = await runGit(codeRoot, ["diff", "--no-ext-diff", "--", normalizedPath], true);
  return [stagedDiff, unstagedDiff].filter((part) => part.trim()).join("\n\n");
}

function formatTextNewFileDiff(filePath: string, content: string) {
  const lines = content.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const escapedPath = escapeDiffPath(filePath);
  const body = lines.map((line) => `+${line}`).join("\n");
  return [
    `diff --git a/${escapedPath} b/${escapedPath}`,
    "new file mode 100644",
    "index 0000000..0000000",
    "--- /dev/null",
    `+++ b/${escapedPath}`,
    `@@ -0,0 +1,${Math.max(lines.length, 1)} @@`,
    body || "+"
  ].join("\n");
}

function formatBinaryNewFileDiff(filePath: string, size: number) {
  const escapedPath = escapeDiffPath(filePath);
  return [
    `diff --git a/${escapedPath} b/${escapedPath}`,
    "new file mode 100644",
    "index 0000000..0000000",
    "--- /dev/null",
    `+++ b/${escapedPath}`,
    `Binary file added (${formatBytes(size)})`
  ].join("\n");
}

function escapeDiffPath(filePath: string) {
  return filePath.replaceAll("\\", "/");
}

function normalizeCommitMessage(message: string) {
  return message
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200) || "update workspace code";
}

function buildAgentHubCommitMessage(message: string, contributors: CodeContributor[], currentUser: AgentHubUser) {
  const subject = normalizeCommitMessage(message);
  const coAuthors = uniqueContributors(contributors)
    .filter((contributor) => contributor.id && contributor.id !== currentUser.id)
    .map((contributor) => `Co-authored-by: ${contributor.name} <${contributor.email ?? `${contributor.id}@agenthub.local`}>`);
  return coAuthors.length ? [subject, "", ...coAuthors].join("\n") : subject;
}

function parseGitStatus(output: string) {
  return output
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const rawStatus = line.slice(0, 2);
      const path = line.slice(3).replace(/^"|"$/g, "");
      return {
        path,
        status: rawStatus.trim() || rawStatus,
        staged: rawStatus[0] !== " " && rawStatus[0] !== "?",
        unstaged: rawStatus[1] !== " " || rawStatus === "??",
        label: gitStatusLabel(rawStatus)
      };
    });
}

function parseGitLog(output: string) {
  if (!output.trim()) return [];
  return output.split("\u001e").flatMap((record) => {
    const line = record.trim();
    if (!line) return [];
    const [hash, shortHash, author, authorEmail, date, subject, coAuthorTrailer = ""] = line.split("\u001f");
    if (!hash || !shortHash) return [];
    const authorContributor = contributorFromNameAndEmail(author || "unknown", authorEmail || null, date || null);
    const trailerContributors = coAuthorTrailer
      .split("\u001d")
      .map((value) => parseCoAuthorTrailer(value, date || null))
      .filter((contributor): contributor is CodeContributor => Boolean(contributor));
    return [{
      hash,
      shortHash,
      author: author || "unknown",
      authorEmail: authorEmail || null,
      date: date || "",
      subject: subject || "(no message)",
      contributors: uniqueContributors([authorContributor, ...trailerContributors])
    }];
  });
}

function parseCoAuthorTrailer(value: string, changedAt: string | null) {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const match = trimmed.match(/^(.*)<([^>]+)>$/);
  if (!match) return contributorFromNameAndEmail(trimmed, null, changedAt);
  return contributorFromNameAndEmail(match[1]?.trim() || "unknown", match[2]?.trim() || null, changedAt);
}

function contributorFromNameAndEmail(name: string, email: string | null, changedAt: string | null): CodeContributor {
  const id = email?.endsWith("@agenthub.local") ? email.slice(0, -"@agenthub.local".length) : null;
  return {
    id,
    name: name || id || "unknown",
    avatar: null,
    role: id === "agent-runtime" ? "agent" : id ? "user" : "unknown",
    email,
    contributions: 1,
    lastChangedAt: changedAt
  };
}

function contributorFromUserId(
  userId: string | null | undefined,
  changedAt: string,
  userById: Map<string, { id: string; name: string; avatar: string | null }>
) {
  if (!userId) return null;
  const user = userById.get(userId);
  return {
    id: userId,
    name: user?.name ?? (userId === "agent-runtime" ? "Code Agent" : userId),
    avatar: user?.avatar ?? null,
    role: user ? "user" as const : userId === "agent-runtime" ? "agent" as const : "unknown" as const,
    email: `${userId}@agenthub.local`,
    contributions: 1,
    lastChangedAt: changedAt
  };
}

function mergeContributor(target: Map<string, CodeContributor>, contributor: CodeContributor) {
  const key = contributor.id ?? contributor.email ?? contributor.name;
  const existing = target.get(key);
  if (!existing) {
    target.set(key, { ...contributor });
    return;
  }
  existing.contributions += contributor.contributions;
  if (!existing.lastChangedAt || (contributor.lastChangedAt && Date.parse(contributor.lastChangedAt) > Date.parse(existing.lastChangedAt))) {
    existing.lastChangedAt = contributor.lastChangedAt;
  }
  if (!existing.avatar && contributor.avatar) existing.avatar = contributor.avatar;
}

function uniqueContributors(contributors: CodeContributor[]) {
  const map = new Map<string, CodeContributor>();
  for (const contributor of contributors) mergeContributor(map, contributor);
  return sortContributors([...map.values()]);
}

function sortContributors(contributors: CodeContributor[]) {
  return contributors.sort((a, b) => {
    const byTime = Date.parse(a.lastChangedAt ?? "") - Date.parse(b.lastChangedAt ?? "");
    if (Number.isFinite(byTime) && byTime !== 0) return byTime;
    return a.name.localeCompare(b.name);
  });
}

function latestContributorChange(contributors: CodeContributor[]) {
  return contributors.reduce<string | null>((latest, contributor) => {
    if (!contributor.lastChangedAt) return latest;
    if (!latest) return contributor.lastChangedAt;
    return Date.parse(contributor.lastChangedAt) > Date.parse(latest) ? contributor.lastChangedAt : latest;
  }, null);
}

function toContributorView(contributor: CodeContributor) {
  const { email: _email, ...view } = contributor;
  return view;
}

function normalizeContributorsFromMetadata(value: unknown, userById: Map<string, { id: string; name: string; avatar: string | null }>) {
  if (!Array.isArray(value)) return [];
  const contributors = value.flatMap((item) => {
    const record = asRecord(item);
    if (!record) return [];
    const id = normalizeOptionalString(record.id);
    const user = id ? userById.get(id) : undefined;
    return [{
      id: id ?? null,
      name: user?.name ?? normalizeOptionalString(record.name) ?? id ?? "unknown",
      avatar: user?.avatar ?? normalizeOptionalString(record.avatar) ?? null,
      role: normalizeContributorRole(record.role),
      email: id ? `${id}@agenthub.local` : null,
      contributions: toFiniteNumber(record.contributions) ?? 1,
      lastChangedAt: normalizeOptionalString(record.lastChangedAt) ?? null
    } satisfies CodeContributor];
  });
  return uniqueContributors(contributors);
}

function hydrateCommitContributors(
  contributors: CodeContributor[],
  userById: Map<string, { id: string; name: string; avatar: string | null }>
) {
  return uniqueContributors(contributors.map((contributor) => {
    if (!contributor.id) return contributor;
    const user = userById.get(contributor.id);
    return {
      ...contributor,
      name: user?.name ?? contributor.name,
      avatar: user?.avatar ?? contributor.avatar,
      role: user ? "user" : contributor.role
    };
  }));
}

function normalizeContributorRole(value: unknown): CodeContributor["role"] {
  return value === "user" || value === "agent" || value === "unknown" ? value : "unknown";
}

function gitStatusLabel(status: string) {
  if (status === "??") return "新增";
  if (status.includes("A")) return "新增";
  if (status.includes("D")) return "删除";
  if (status.includes("R")) return "重命名";
  if (status.includes("C")) return "复制";
  if (status.includes("M")) return "修改";
  if (status.includes("U")) return "冲突";
  return "变更";
}

function toFiniteNumber(value: unknown) {
  const numberValue = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(numberValue) ? numberValue : null;
}

function displayCodeProvider(provider: string | null) {
  if (!provider) return "Code Agent";
  if (provider === "codex") return "Codex";
  if (provider === "opencode") return "OpenCode";
  return provider;
}

function changedFileCountFromAsset(asset: { metadata: unknown; summary: string | null } | undefined) {
  if (!asset) return null;
  const metadataCount = toFiniteNumber(asRecord(asset.metadata)?.changedFileCount);
  if (metadataCount !== null) return metadataCount;
  const match = asset.summary?.match(/(\d+)\s*files?/i);
  return match ? Number(match[1]) : null;
}

function isReviewableCodeTaskStatus(status: string) {
  return ["completed", "waiting_review", "revision_requested"].includes(status);
}

function normalizeOptionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeReleaseVersion(value: unknown) {
  const text = normalizeOptionalString(value);
  if (!text) return undefined;
  const normalized = text.startsWith("v") ? text : `v${text}`;
  return /^v\d+\.\d+\.\d+$/.test(normalized) ? normalized : undefined;
}

function bumpPatchVersion(value: unknown) {
  const normalized = normalizeReleaseVersion(value) ?? DEFAULT_SKILL_RELEASE_VERSION;
  const match = normalized.match(/^v(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return DEFAULT_SKILL_RELEASE_VERSION;
  return `v${Number(match[1])}.${Number(match[2])}.${Number(match[3]) + 1}`;
}

function compareReleaseVersion(left: string | undefined, right: string | undefined) {
  const leftMatch = left?.match(/^v(\d+)\.(\d+)\.(\d+)$/);
  const rightMatch = right?.match(/^v(\d+)\.(\d+)\.(\d+)$/);
  if (!leftMatch || !rightMatch) return 0;
  for (let index = 1; index <= 3; index += 1) {
    const diff = Number(leftMatch[index]) - Number(rightMatch[index]);
    if (diff !== 0) return diff;
  }
  return 0;
}

function nextSkillReleaseVersion(metadataVersion: unknown, existing: { releaseVersion?: string | null; currentFingerprint: string } | null, nextFingerprint: string) {
  const explicitVersion = normalizeReleaseVersion(metadataVersion);
  if (!existing) return explicitVersion ?? DEFAULT_SKILL_RELEASE_VERSION;
  const existingVersion = normalizeReleaseVersion(existing.releaseVersion) ?? DEFAULT_SKILL_RELEASE_VERSION;
  if (existing.currentFingerprint === nextFingerprint) {
    return existingVersion;
  }
  return explicitVersion && compareReleaseVersion(explicitVersion, existingVersion) > 0
    ? explicitVersion
    : bumpPatchVersion(existingVersion);
}

function normalizeHubKind(value: unknown): HubKind | undefined {
  return value === "skill" || value === "knowledge" ? value : undefined;
}

function hubAssetOwner(asset: WorkspaceHubAssetRecord) {
  const metadata = asRecord(asset.metadata) ?? {};
  const explicitOwnerType = normalizeOptionalString(metadata.ownerType);
  const ownerType = explicitOwnerType === "team" || explicitOwnerType === "system" ? explicitOwnerType : "user";
  const ownerId =
    normalizeOptionalString(metadata.ownerId) ??
    normalizeOptionalString(metadata.ownerUserId) ??
    asset.workspace.conversation.members[0]?.memberId ??
    "system";
  return { ownerType, ownerId };
}

function fingerprintHubAssetSpec(value: unknown) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

function skillSpec(asset: WorkspaceHubAssetRecord, baseSpec: Record<string, unknown>) {
  const metadata = asRecord(asset.metadata) ?? {};
  return {
    ...baseSpec,
    triggerSyntax: asRecord(metadata.triggerSyntax) ?? {
      mode: "agent_decides",
      directSyntax: `#skill:${asset.id}`
    },
    injectionMode: normalizeOptionalString(metadata.injectionMode) ?? "agent_decides",
    targetAgentTypes: normalizeStringArray(metadata.targetAgentTypes, ["universal", "product", "ui", "review"]),
    requiredTools: normalizeStringArray(metadata.requiredTools ?? metadata.toolIds, []),
    outputRules: normalizeStringArray(metadata.outputRules, []),
    safetyRules: normalizeStringArray(metadata.safetyRules, [])
  };
}

function knowledgeSpec(asset: WorkspaceHubAssetRecord, baseSpec: Record<string, unknown>) {
  const metadata = asRecord(asset.metadata) ?? {};
  const visibility = normalizeOptionalString(metadata.visibility) === "public" ? "public" : "private";
  return {
    ...baseSpec,
    sourceType: normalizeOptionalString(metadata.sourceType) ?? "workspace_asset",
    accessScope: normalizeOptionalString(metadata.accessScope) ?? visibility,
    summary: asset.summary ?? "",
    indexStatus: normalizeOptionalString(metadata.indexStatus) ?? "metadata_ready",
    fileCount: typeof metadata.fileCount === "number" && Number.isFinite(metadata.fileCount) ? metadata.fileCount : 1,
    retrieval: asRecord(metadata.retrieval) ?? {
      mode: "metadata_and_file_read",
      detailToolRequired: true
    }
  };
}

function normalizeStringArray(value: unknown, fallback: string[]) {
  if (!Array.isArray(value)) return fallback;
  const normalized = Array.from(new Set(value.flatMap((item) => typeof item === "string" && item.trim() ? [item.trim()] : [])));
  return normalized.length > 0 ? normalized : fallback;
}

function safeHubAssetBasename(name: string) {
  return sanitizeFileName(name)
    .replace(/\.(md|txt|json)$/i, "")
    .replace(/\.+$/g, "")
    .slice(0, 80) || `asset-${Date.now()}`;
}

function inferAssetKind(filePath: string): WorkspaceAsset["kind"] {
  const ext = extname(filePath).toLowerCase();
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"].includes(ext)) return "image";
  if ([".html", ".htm"].includes(ext)) return "web";
  if ([".diff", ".patch"].includes(ext)) return "diff";
  if ([".md", ".txt", ".pdf", ".doc", ".docx", ".excalidraw"].includes(ext)) return "doc";
  return "file";
}

function inferMimeType(filePath: string) {
  const ext = extname(filePath).toLowerCase();
  const table: Record<string, string> = {
    ".md": "text/markdown",
    ".txt": "text/plain",
    ".json": "application/json",
    ".jsonl": "application/jsonl",
    ".excalidraw": "application/vnd.excalidraw+json",
    ".csv": "text/csv",
    ".log": "text/plain",
    ".yml": "text/yaml",
    ".yaml": "text/yaml",
    ".xml": "application/xml",
    ".ts": "text/typescript",
    ".tsx": "text/typescript",
    ".js": "text/javascript",
    ".jsx": "text/javascript",
    ".mjs": "text/javascript",
    ".cjs": "text/javascript",
    ".css": "text/css",
    ".scss": "text/x-scss",
    ".html": "text/html",
    ".htm": "text/html",
    ".py": "text/x-python",
    ".java": "text/x-java",
    ".go": "text/x-go",
    ".rs": "text/x-rust",
    ".sql": "text/x-sql",
    ".sh": "text/x-shellscript",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".pdf": "application/pdf",
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".diff": "text/x-diff",
    ".patch": "text/x-diff"
  };
  return table[ext] ?? "application/octet-stream";
}

function summarizeText(content: string) {
  return content.replace(/\s+/g, " ").trim().slice(0, 240);
}

function toWorkspaceAsset(asset: {
  id: string;
  workspaceId: string;
  kind: string;
  name: string;
  path: string;
  mimeType?: string | null;
  size?: number | null;
  summary: string | null;
  metadata?: unknown;
  createdAt: Date;
  updatedAt?: Date;
  versions?: Array<{
    createdByUserId?: string | null;
    createdAt: Date;
    metadata?: unknown;
  }>;
}, creatorName?: string): WorkspaceAsset {
  const metadata = asRecord(asset.metadata);
  const latestVersion = typeof metadata?.latestVersion === "number" ? metadata.latestVersion : undefined;
  const etag = typeof metadata?.etag === "string" ? metadata.etag : undefined;
  const forkedFromAssetId = normalizeOptionalString(metadata?.forkedFromAssetId);
  const logo = normalizeOptionalString(metadata?.logo);
  const logoColor = normalizeOptionalString(metadata?.logoColor);
  const provenance = buildAssetProvenance(asset, creatorName);
  const result: WorkspaceAsset = {
    id: asset.id,
    workspaceId: asset.workspaceId,
    kind: asset.kind as WorkspaceAsset["kind"],
    name: asset.name,
    path: asset.path,
    summary: asset.summary ?? "",
    ...(etag ? { etag } : {}),
    ...(latestVersion ? { latestVersion } : {}),
    ...(forkedFromAssetId ? { forkedFromAssetId } : {}),
    ...(logo ? { logo } : {}),
    ...(logoColor ? { logoColor } : {}),
    createdAt: asset.createdAt.toISOString(),
    ...(asset.updatedAt ? { updatedAt: asset.updatedAt.toISOString() } : {}),
    details: {
      provenance
    }
  };
  if (asset.mimeType) result.mimeType = asset.mimeType;
  if (asset.size !== null && asset.size !== undefined) result.size = asset.size;
  return result;
}

function buildAssetProvenance(asset: {
  kind: string;
  path: string;
  metadata?: unknown;
  createdAt: Date;
  versions?: Array<{
    createdByUserId?: string | null;
    createdAt: Date;
    metadata?: unknown;
  }>;
}, creatorName?: string) {
  const metadata = asRecord(asset.metadata) ?? {};
  const latestVersion = asset.versions?.[0];
  const versionMetadata = asRecord(latestVersion?.metadata) ?? {};
  const proposal = asRecord(metadata.proposal);
  const source = normalizeOptionalString(metadata.source) ?? normalizeOptionalString(versionMetadata.source) ?? inferAssetSource(asset.path, asset.kind);
  const producerId =
    normalizeOptionalString(proposal?.authorUserId) ??
    normalizeOptionalString(latestVersion?.createdByUserId) ??
    normalizeOptionalString(metadata.ownerId) ??
    normalizeOptionalString(metadata.ownerUserId) ??
    null;
  const producerName =
    normalizeOptionalString(proposal?.authorName) ??
    creatorName ??
    (producerId === "agent-runtime" ? "Agent Runtime" : undefined) ??
    (producerId ? producerId : "系统");
  const taskId =
    normalizeOptionalString(metadata.codeTaskRunId) ??
    normalizeOptionalString(metadata.runId) ??
    normalizeOptionalString(proposal?.id) ??
    inferTaskIdFromAssetPath(asset.path);
  const taskTitle =
    normalizeOptionalString(proposal?.title) ??
    normalizeOptionalString(metadata.taskTitle) ??
    normalizeOptionalString(metadata.statusMessage) ??
    sourceLabel(source);
  return {
    producerId,
    producerName,
    producedAt: asset.createdAt.toISOString(),
    taskId,
    taskTitle,
    source,
    sourceLabel: sourceLabel(source)
  };
}

function inferAssetSource(path: string, kind: string) {
  if (path.startsWith(".agenthub/diffs/")) return "code_agent_diff";
  if (path.startsWith(".agenthub/logs/")) return "code_agent_log";
  if (path.includes("/git-proposals/")) return "git_review_proposal";
  if (path.startsWith("uploads/")) return "upload";
  if (kind === "image") return "generated_image";
  return "workspace_asset";
}

function inferTaskIdFromAssetPath(path: string) {
  const match = path.match(/\.agenthub\/(?:diffs|logs)\/([^/.]+)/);
  return match?.[1];
}

function sourceLabel(source: string | undefined) {
  const labels: Record<string, string> = {
    text_write: "文件编辑",
    chunk_upload: "文件上传",
    legacy_base64_upload: "文件上传",
    upload: "文件上传",
    git_review_proposal: "代码审阅提议",
    code_agent_diff: "Code Agent Diff",
    code_agent_log: "Code Agent 日志",
    generated_image: "生成图片",
    diagram_draw: "图表生成",
    workspace_asset: "工作空间资产"
  };
  if (!source) return "工作空间资产";
  return labels[source] ?? source;
}

function toSkillHubAsset(
  skill: SkillHubAssetRecord,
  ownerName?: string,
  subscription?: Parameters<typeof hubLifecycleFields>[0],
  source = { version: skill.currentVersion, fingerprint: skill.currentFingerprint },
  likes: HubAssetLikeSummary = { likeCount: 0, likedByMe: false }
): WorkspaceAsset {
  const versionSpec = asRecord(skill.versions[0]?.spec);
  const metadata = asRecord(versionSpec?.metadata);
  const sourceSpec = asRecord(versionSpec?.source);
  const sourceSize = typeof sourceSpec?.size === "number" ? sourceSpec.size : undefined;
  const forkedFromAssetId = normalizeOptionalString(metadata?.forkedFromAssetId);
  const logo = normalizeHubLogo(metadata?.logo, "sparkles");
  const logoColor = normalizeHubLogoColor(metadata?.logoColor);
  return {
    id: skill.id,
    workspaceId: normalizeOptionalString(sourceSpec?.workspaceId) ?? "skillhub",
    kind: "doc",
    name: skill.name,
    path: normalizeOptionalString(sourceSpec?.path) ?? `skill://${skill.id}`,
    summary: skill.description,
    mimeType: normalizeOptionalString(sourceSpec?.mimeType) ?? "text/markdown",
    ...(sourceSize === undefined ? {} : { size: sourceSize }),
	    latestVersion: skill.currentVersion,
	    currentVersion: skill.currentVersion,
	    releaseVersion: skill.releaseVersion,
	    sourceVersion: skill.currentVersion,
    sourceAssetId: skill.sourceAssetId,
    likeCount: likes.likeCount,
    likedByMe: likes.likedByMe,
    logo,
    logoColor,
    ...(forkedFromAssetId ? { forkedFromAssetId } : {}),
    ownerType: skill.ownerType,
    ownerId: skill.ownerId,
    ownerName: ownerName ?? skill.ownerId,
    visibility: skill.visibility,
    createdAt: skill.createdAt.toISOString(),
    updatedAt: skill.updatedAt.toISOString(),
    details: {
      id: skill.id,
      sourceAssetId: skill.sourceAssetId,
      ownerType: skill.ownerType,
      ownerId: skill.ownerId,
      ownerName: ownerName ?? skill.ownerId,
      visibility: skill.visibility,
      injectionMode: skill.injectionMode,
      targetAgentTypes: skill.targetAgentTypes,
      requiredTools: skill.requiredTools,
      triggerSyntax: skill.triggerSyntax,
	      outputRules: skill.outputRules,
	      safetyRules: skill.safetyRules,
	      currentVersion: skill.currentVersion,
	      releaseVersion: skill.releaseVersion,
	      currentFingerprint: skill.currentFingerprint,
      ...(forkedFromAssetId ? { forkedFromAssetId } : {}),
      createdAt: skill.createdAt.toISOString(),
      updatedAt: skill.updatedAt.toISOString()
    },
    ...hubLifecycleFields(subscription, source)
  };
}

function skillHubScopeWhere(currentUserId: string, scope: HubAssetScope, activeSubscriptionAssetIds: string[]): Prisma.SkillAssetWhereInput {
  if (scope === "public") return { visibility: "public", NOT: { ownerType: "user", ownerId: currentUserId } };
  if (scope === "published") return { ownerType: "user", ownerId: currentUserId, visibility: "public" };
  if (scope === "subscribed") {
    return activeSubscriptionAssetIds.length > 0
      ? {
          OR: [
            { id: { in: activeSubscriptionAssetIds } },
            { sourceAssetId: { in: activeSubscriptionAssetIds } }
          ]
        }
      : { id: "__none__" };
  }
  if (scope === "personal") {
    return {
      OR: [
        { ownerType: "user", ownerId: currentUserId },
        ...(activeSubscriptionAssetIds.length > 0
          ? [
              { id: { in: activeSubscriptionAssetIds } },
              { sourceAssetId: { in: activeSubscriptionAssetIds } }
            ]
          : [])
      ]
    };
  }
  return { ownerType: "user", ownerId: currentUserId };
}

function skillMatchesHubScope(skill: SkillHubAssetRecord, scope: HubAssetScope, currentUserId: string, activeSubscriptionAssetIds: string[]) {
  const forked = isForkedSkillIndex(skill);
  const subscribed = activeSubscriptionAssetIds.includes(skill.id) || activeSubscriptionAssetIds.includes(skill.sourceAssetId);
  if (scope === "personal") return (skill.ownerType === "user" && skill.ownerId === currentUserId) || subscribed;
  if (scope === "published") return skill.ownerType === "user" && skill.ownerId === currentUserId && skill.visibility === "public";
  if (scope === "fork") return skill.ownerType === "user" && skill.ownerId === currentUserId && forked;
  if (scope === "subscribed") return subscribed && !(skill.ownerType === "user" && skill.ownerId === currentUserId);
  if (scope === "public") return skill.visibility === "public" && !(skill.ownerType === "user" && skill.ownerId === currentUserId);
  return true;
}

function isForkedSkillIndex(skill: SkillHubAssetRecord) {
  const spec = asRecord(skill.versions[0]?.spec);
  const metadata = asRecord(spec?.metadata);
  return Boolean(normalizeOptionalString(metadata?.forkedFromAssetId));
}

function isStarterSkillIndex(skill: SkillHubAssetRecord) {
  const spec = asRecord(skill.versions[0]?.spec);
  const metadata = asRecord(spec?.metadata);
  return metadata?.starter === true || metadata?.source === "hub_starter";
}

function toUploadSession(session: {
  id: string;
  workspaceId: string;
  name: string;
  mimeType: string;
  size: number;
  receivedBytes: number;
  status: string;
  expiresAt: Date;
}) {
  return {
    uploadId: session.id,
    workspaceId: session.workspaceId,
    name: session.name,
    mimeType: session.mimeType,
    size: session.size,
    receivedBytes: session.receivedBytes,
    status: session.status,
    chunkSize: MAX_WORKSPACE_UPLOAD_CHUNK_BYTES,
    maxSize: MAX_WORKSPACE_UPLOAD_BYTES,
    expiresAt: session.expiresAt.toISOString()
  };
}

function preferredHubSubscriptionByAsset<T extends { assetId: string; ownerType: string; ownerId: string; status: string; updatedAt: Date }>(subscriptions: T[], currentUserId: string) {
  const byAssetId = new Map<string, T>();
  for (const subscription of subscriptions) {
    const existing = byAssetId.get(subscription.assetId);
    if (!existing || isPreferredHubSubscription(subscription, existing, currentUserId)) {
      byAssetId.set(subscription.assetId, subscription);
    }
  }
  return byAssetId;
}

function ownerKey(ownerType: string, ownerId: string | null | undefined) {
  return `${ownerType}:${ownerId ?? ""}`;
}

function isPreferredHubSubscription<T extends { ownerType: string; ownerId: string; status: string; updatedAt: Date }>(candidate: T, current: T, currentUserId: string) {
  if (candidate.ownerType === "user" && candidate.ownerId === currentUserId && current.ownerType !== "user") return true;
  if (candidate.status === "forked" && current.status !== "forked") return true;
  return candidate.updatedAt > current.updatedAt;
}

function hubLifecycleFields(subscription: {
  id: string;
  status: string;
  sourceFingerprint: string;
  installedVersion: number;
  updateAvailable: boolean;
  conflictStatus: string | null;
  forkedAssetId: string | null;
} | undefined, source?: { version: number; fingerprint: string }) {
  if (!subscription) return {};
  const updateAvailable = source
    ? source.fingerprint !== subscription.sourceFingerprint || source.version > subscription.installedVersion
    : subscription.updateAvailable;
  return {
    subscribed: subscription.status === "active",
    subscriptionId: subscription.id,
    hubStatus: subscription.status,
    updateAvailable,
    ...(subscription.conflictStatus ? { conflictStatus: subscription.conflictStatus } : {}),
    ...(subscription.forkedAssetId ? { forkedAssetId: subscription.forkedAssetId } : {})
  };
}

function currentAssetSource(asset: { metadata?: unknown; updatedAt: Date }) {
  const metadata = asRecord(asset.metadata);
  const version = typeof metadata?.latestVersion === "number" ? metadata.latestVersion : 1;
  const fingerprint = typeof metadata?.etag === "string"
    ? metadata.etag
    : typeof metadata?.checksumSha256 === "string"
      ? metadata.checksumSha256
      : String(asset.updatedAt.getTime());
  return { version, fingerprint };
}

function isPublicAsset(metadata: unknown) {
  return Boolean(metadata && typeof metadata === "object" && "visibility" in metadata && (metadata as { visibility?: unknown }).visibility === "public");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function toWorkspaceChatMessage(message: Message): ChatMessage {
  const metadata = asRecord(message.metadata) ?? undefined;
  return {
    id: message.id,
    conversationId: message.conversationId,
    sender: {
      type: message.senderType as ChatMessage["sender"]["type"],
      id: message.senderId,
      name: message.senderName,
      avatar: message.senderAvatar,
      ...(message.senderSubtitle ? { subtitle: message.senderSubtitle } : {})
    },
    blocks: message.blocks as unknown as ChatMessage["blocks"],
    mentions: Array.isArray(message.mentions) ? (message.mentions as string[]) : [],
    actions: [],
    ...(metadata ? { metadata } : {}),
    createdAt: message.createdAt.toISOString(),
    status: message.status as ChatMessage["status"]
  };
}

function buildWorkspaceDiffBlockFiles(changedFiles: Array<{ path: string; additions?: number; deletions?: number }>, diffText: string) {
  const hunksByPath = parseWorkspaceUnifiedDiffHunks(diffText);
  const paths = changedFiles.length ? changedFiles.map((file) => file.path) : Array.from(hunksByPath.keys());
  return paths.map((path) => {
    const hunks = hunksByPath.get(path) ?? [];
    const counted = countDiffLines(hunks);
    const original = changedFiles.find((file) => file.path === path);
    return {
      path,
      additions: typeof original?.additions === "number" ? original.additions : counted.additions,
      deletions: typeof original?.deletions === "number" ? original.deletions : counted.deletions,
      expanded: false,
      hunks
    };
  });
}

function parseWorkspaceUnifiedDiffHunks(diffText: string) {
  const result = new Map<string, Array<{ header: string; lines: Array<{ kind: "context" | "add" | "delete"; oldLine?: number; newLine?: number; content: string }> }>>();
  let currentPath = "";
  let currentHunk: { header: string; lines: Array<{ kind: "context" | "add" | "delete"; oldLine?: number; newLine?: number; content: string }> } | undefined;
  let oldLine = 0;
  let newLine = 0;
  for (const line of diffText.split(/\r?\n/)) {
    const fileMatch = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (fileMatch) {
      currentPath = fileMatch[2] ?? fileMatch[1] ?? "";
      currentHunk = undefined;
      if (currentPath && !result.has(currentPath)) result.set(currentPath, []);
      continue;
    }
    const plusFile = /^\+\+\+ b\/(.+)$/.exec(line);
    if (plusFile) {
      currentPath = plusFile[1] ?? currentPath;
      if (currentPath && !result.has(currentPath)) result.set(currentPath, []);
      continue;
    }
    const hunkMatch = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
    if (hunkMatch && currentPath) {
      oldLine = Number(hunkMatch[1]);
      newLine = Number(hunkMatch[2]);
      currentHunk = { header: line, lines: [] };
      result.get(currentPath)?.push(currentHunk);
      continue;
    }
    if (!currentHunk) continue;
    if (line.startsWith("+") && !line.startsWith("+++")) {
      currentHunk.lines.push({ kind: "add", newLine, content: line.slice(1) });
      newLine += 1;
      continue;
    }
    if (line.startsWith("-") && !line.startsWith("---")) {
      currentHunk.lines.push({ kind: "delete", oldLine, content: line.slice(1) });
      oldLine += 1;
      continue;
    }
    currentHunk.lines.push({ kind: "context", oldLine, newLine, content: line.startsWith(" ") ? line.slice(1) : line });
    oldLine += 1;
    newLine += 1;
  }
  return result;
}

function countDiffLines(hunks: Array<{ lines: Array<{ kind: "context" | "add" | "delete" }> }>) {
  return hunks.reduce(
    (count, hunk) => {
      for (const line of hunk.lines) {
        if (line.kind === "add") count.additions += 1;
        if (line.kind === "delete") count.deletions += 1;
      }
      return count;
    },
    { additions: 0, deletions: 0 }
  );
}

function isSkillAsset(name: string, path: string, summary: string | null, metadata: unknown) {
  if (metadata && typeof metadata === "object" && "hubKind" in metadata && (metadata as { hubKind?: unknown }).hubKind === "skill") return true;
  const text = `${name} ${path} ${summary ?? ""}`.toLowerCase();
  return text.includes("skill") || text.includes("技能") || text.includes("协作规范");
}

function isTextMime(mimeType: string) {
  return mimeType.startsWith("text/") || [
    "application/json",
    "application/jsonl",
    "application/javascript",
    "application/xml",
    "application/vnd.excalidraw+json"
  ].includes(mimeType);
}

function isTextPreviewMime(mimeType: string) {
  return isTextMime(mimeType) || mimeType === "image/svg+xml";
}

function isUniqueConstraintError(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

function sanitizeFileName(name: string) {
  const base = basename(name).replace(/[^\w.\-\u4e00-\u9fa5]/g, "_").slice(0, 120);
  return base || `upload-${Date.now()}`;
}

function summarizeUploadedAsset(name: string, mimeType: string, content: Buffer) {
  if (isTextMime(mimeType)) return summarizeText(content.toString("utf8"));
  const normalizedMime = mimeType || inferMimeType(name);
  const lowerName = name.toLowerCase();
  const size = `${Math.max(1, Math.round(content.byteLength / 1024))} KB`;
  if (normalizedMime.startsWith("image/")) return `图片附件 ${name} · ${normalizedMime} · ${size} · 需要视觉模型或人工预览确认图像细节`;
  if (normalizedMime === "application/pdf" || lowerName.endsWith(".pdf")) return `PDF 文档 ${name} · ${size} · 已记录元信息，正文需专用 PDF 摘要器提取`;
  if (normalizedMime.includes("word") || lowerName.endsWith(".doc") || lowerName.endsWith(".docx")) {
    return `Word 文档 ${name} · ${size} · 已记录元信息，正文需专用 Word 摘要器提取`;
  }
  if (normalizedMime === "text/x-diff" || lowerName.endsWith(".diff") || lowerName.endsWith(".patch")) return `Diff/Patch 文件 ${name} · ${size}`;
  if (normalizedMime === "text/html" || lowerName.endsWith(".html") || lowerName.endsWith(".htm")) return `网页/HTML 资产 ${name} · ${size}`;
  return `二进制文件 ${name} · ${normalizedMime || "application/octet-stream"} · ${size}`;
}

function scanUploadedBuffer(input: { name: string; mimeType: string; content: Buffer }) {
  return scanUploadPolicy({ name: input.name, mimeType: input.mimeType, header: input.content.subarray(0, UPLOAD_SCAN_HEADER_BYTES) });
}

async function scanUploadedFile(input: { name: string; mimeType: string; path: string }) {
  return scanUploadPolicy({ name: input.name, mimeType: input.mimeType, header: await readFileHeader(input.path, UPLOAD_SCAN_HEADER_BYTES) });
}

function scanUploadPolicy(input: { name: string; mimeType: string; header: Buffer }) {
  const findings: string[] = [];
  const ext = extname(input.name).toLowerCase();
  const mimeType = input.mimeType.toLowerCase();
  if (BLOCKED_UPLOAD_EXTENSIONS.has(ext)) findings.push(`blocked-extension:${ext}`);
  if (BLOCKED_UPLOAD_MIME_TYPES.has(mimeType)) findings.push(`blocked-mime:${mimeType}`);
  if (hasMagic(input.header, [0x4d, 0x5a])) findings.push("blocked-magic:pe");
  if (hasMagic(input.header, [0x7f, 0x45, 0x4c, 0x46])) findings.push("blocked-magic:elf");
  if (
    hasMagic(input.header, [0xfe, 0xed, 0xfa, 0xce]) ||
    hasMagic(input.header, [0xce, 0xfa, 0xed, 0xfe]) ||
    hasMagic(input.header, [0xfe, 0xed, 0xfa, 0xcf]) ||
    hasMagic(input.header, [0xcf, 0xfa, 0xed, 0xfe])
  ) {
    findings.push("blocked-magic:macho");
  }
  if (findings.length > 0) {
    throw new BadRequestException(`Upload rejected by file safety policy: ${findings.join(", ")}`);
  }
  return {
    status: "passed",
    engine: "agenthub-upload-policy",
    scannedAt: new Date().toISOString(),
    findings
  };
}

async function readFileHeader(path: string, length: number) {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function hasMagic(header: Buffer, bytes: number[]) {
  return header.length >= bytes.length && bytes.every((byte, index) => header[index] === byte);
}

function validateUploadSize(size: number, maxBytes: number) {
  if (!Number.isInteger(size) || size <= 0) throw new BadRequestException("Upload size must be positive");
  if (size > maxBytes) throw new BadRequestException(`Upload cannot exceed ${formatBytes(maxBytes)}`);
}

function assetMetadata(checksumSha256: string, extra: Record<string, unknown> = {}) {
  return assetMetadataFields(checksumSha256, extra) as Prisma.InputJsonValue;
}

function assetMetadataFields(checksumSha256: string, extra: Record<string, unknown> = {}) {
  return {
    ...extra,
    storage: "local",
    checksumSha256,
    etag: `"sha256-${checksumSha256}"`,
    latestVersion: 1
  };
}

function sha256Buffer(content: Buffer) {
  return createHash("sha256").update(content).digest("hex");
}

function sha256File(path: string) {
  return new Promise<string>((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("error", reject);
    stream.on("data", (chunk: Buffer) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}
