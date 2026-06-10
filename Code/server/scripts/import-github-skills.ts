import "dotenv/config";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "../src/generated/prisma/client.js";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");

const prisma = new PrismaClient({
  adapter: new PrismaPg(connectionString)
});

interface ImportedSkillSeed {
  userId: string;
  id: string;
  sourceAssetId: string;
  path: string;
  name: string;
  description: string;
  visibility: "private" | "public";
  sourceUrl: string;
  sourceRepo: string;
  sourceName: string;
  tags: string[];
  targetAgentTypes: string[];
  requiredTools: string[];
}

const importedSkills: ImportedSkillSeed[] = [
  {
    userId: "lin",
    id: "skill-lin-private-github-frontend-design",
    sourceAssetId: "asset-skill-lin-private-github-frontend-design",
    path: "skills/github-frontend-design.md",
    name: "前端界面设计 Skill",
    description: "来自 GitHub 高星官方 Skills 仓库，用于指导 Agent 产出更有设计质量的 Web 界面。",
    visibility: "private",
    sourceRepo: "anthropics/skills",
    sourceName: "frontend-design",
    sourceUrl: "https://raw.githubusercontent.com/anthropics/skills/main/skills/frontend-design/SKILL.md",
    tags: ["frontend", "design", "ui"],
    targetAgentTypes: ["ui", "universal", "product"],
    requiredTools: []
  },
  {
    userId: "lin",
    id: "skill-lin-public-github-webapp-testing",
    sourceAssetId: "asset-skill-lin-public-github-webapp-testing",
    path: "skills/github-webapp-testing.md",
    name: "Web 应用测试 Skill",
    description: "来自 GitHub 高星官方 Skills 仓库，用于指导 Agent 使用 Playwright 检查本地 Web 应用。",
    visibility: "public",
    sourceRepo: "anthropics/skills",
    sourceName: "webapp-testing",
    sourceUrl: "https://raw.githubusercontent.com/anthropics/skills/main/skills/webapp-testing/SKILL.md",
    tags: ["testing", "playwright", "web"],
    targetAgentTypes: ["review", "ui", "universal"],
    requiredTools: ["run_shell_command", "browser_preview"]
  },
  {
    userId: "chen",
    id: "skill-chen-private-github-skill-creator",
    sourceAssetId: "asset-skill-chen-private-github-skill-creator",
    path: "skills/github-skill-creator.md",
    name: "Skill 构建优化 Skill",
    description: "来自 GitHub 高星官方 Skills 仓库，用于指导 Agent 设计、评测和迭代新的 Skill。",
    visibility: "private",
    sourceRepo: "anthropics/skills",
    sourceName: "skill-creator",
    sourceUrl: "https://raw.githubusercontent.com/anthropics/skills/main/skills/skill-creator/SKILL.md",
    tags: ["skill", "evaluation", "prompt"],
    targetAgentTypes: ["universal", "product", "review"],
    requiredTools: []
  },
  {
    userId: "chen",
    id: "skill-chen-public-github-mcp-builder",
    sourceAssetId: "asset-skill-chen-public-github-mcp-builder",
    path: "skills/github-mcp-builder.md",
    name: "MCP 服务开发 Skill",
    description: "来自 GitHub 高星官方 Skills 仓库，用于指导 Agent 设计高质量 MCP Server 和工具接口。",
    visibility: "public",
    sourceRepo: "anthropics/skills",
    sourceName: "mcp-builder",
    sourceUrl: "https://raw.githubusercontent.com/anthropics/skills/main/skills/mcp-builder/SKILL.md",
    tags: ["mcp", "tool", "server"],
    targetAgentTypes: ["universal", "code", "product"],
    requiredTools: ["read_file", "write_file", "run_shell_command"]
  }
];

async function main() {
  for (const skill of importedSkills) {
    await importSkill(skill);
  }
  console.log(`Imported ${importedSkills.length} GitHub skills from anthropics/skills.`);
}

async function importSkill(skill: ImportedSkillSeed) {
  const user = await prisma.user.findFirst({
    where: { id: skill.userId, deletedAt: null },
    select: { id: true, name: true }
  });
  if (!user) throw new Error(`User ${skill.userId} does not exist`);

  const workspaceId = `workspace-hub-${skill.userId}`;
  const conversationId = `conv-hub-${skill.userId}`;
  const memberId = `member-hub-${skill.userId}`;
  const workspaceRoot = process.env.AGENTHUB_WORKSPACES_ROOT?.trim()
    ? resolve(process.env.AGENTHUB_WORKSPACES_ROOT)
    : resolve(process.cwd(), "..", "workspaces");
  const rootPath = join(workspaceRoot, workspaceId);
  await mkdir(join(rootPath, "skills"), { recursive: true });

  await prisma.conversation.upsert({
    where: { id: conversationId },
    create: {
      id: conversationId,
      type: "project",
      title: "个人 Hub 资产库",
      avatar: "HB",
      workspaceId,
      codeAgentId: null,
      lastMessage: "个人 Hub fork、订阅和自建资产会保存在这里。",
      memberCount: 1
    },
    update: {
      type: "project",
      title: "个人 Hub 资产库",
      avatar: "HB",
      workspaceId,
      lastMessage: "个人 Hub fork、订阅和自建资产会保存在这里。",
      memberCount: 1,
      deletedAt: null
    }
  });
  await prisma.conversationMember.upsert({
    where: { id: memberId },
    create: {
      id: memberId,
      conversationId,
      memberType: "user",
      memberId: skill.userId,
      role: "owner"
    },
    update: {
      memberType: "user",
      memberId: skill.userId,
      role: "owner",
      deletedAt: null
    }
  });
  await prisma.workspace.upsert({
    where: { id: workspaceId },
    create: {
      id: workspaceId,
      conversationId,
      name: "个人 Hub 资产库",
      rootPath
    },
    update: {
      conversationId,
      name: "个人 Hub 资产库",
      rootPath,
      deletedAt: null
    }
  });

  const remoteContent = await downloadText(skill.sourceUrl);
  const content = [
    `# ${skill.name}`,
    "",
    `> 来源：${skill.sourceRepo}/${skill.sourceName}`,
    `> 地址：${skill.sourceUrl}`,
    "",
    remoteContent.trim(),
    ""
  ].join("\n");
  const absolutePath = join(rootPath, skill.path);
  const buffer = Buffer.from(content, "utf8");
  const checksum = createHash("sha256").update(buffer).digest("hex");
  await writeFile(absolutePath, buffer);

  await prisma.workspaceAsset.upsert({
    where: { id: skill.sourceAssetId },
    create: {
      id: skill.sourceAssetId,
      workspaceId,
      kind: "doc",
      name: `${skill.name}.md`,
      path: skill.path,
      mimeType: "text/markdown",
      size: buffer.byteLength,
      summary: skill.description,
      metadata: assetMetadata(skill, checksum)
    },
    update: {
      workspaceId,
      kind: "doc",
      name: `${skill.name}.md`,
      path: skill.path,
      mimeType: "text/markdown",
      size: buffer.byteLength,
      summary: skill.description,
      metadata: assetMetadata(skill, checksum),
      deletedAt: null
    }
  });
  await prisma.workspaceAssetVersion.upsert({
    where: { assetId_version: { assetId: skill.sourceAssetId, version: 1 } },
    create: {
      id: `asset-version-${skill.sourceAssetId}-1`,
      assetId: skill.sourceAssetId,
      version: 1,
      path: skill.path,
      size: buffer.byteLength,
      checksumSha256: checksum,
      createdByUserId: skill.userId,
      metadata: {
        source: "github_import",
        sourceRepo: skill.sourceRepo,
        sourceUrl: skill.sourceUrl,
        visibility: skill.visibility
      } as Prisma.InputJsonValue
    },
    update: {
      path: skill.path,
      size: buffer.byteLength,
      checksumSha256: checksum,
      createdByUserId: skill.userId,
      metadata: {
        source: "github_import",
        sourceRepo: skill.sourceRepo,
        sourceUrl: skill.sourceUrl,
        visibility: skill.visibility
      } as Prisma.InputJsonValue
    }
  });

  const spec = {
    kind: "skill",
    name: skill.name,
    description: skill.description,
    visibility: skill.visibility,
    owner: {
      ownerType: "user",
      ownerId: skill.userId
    },
    source: {
      sourceAssetId: skill.sourceAssetId,
      sourceAssetVersion: 1,
      sourceType: "workspace_asset",
      storage: "workspace",
      workspaceId,
      path: skill.path,
      mimeType: "text/markdown",
      size: buffer.byteLength,
      sourceFingerprint: checksum,
      sourceRepo: skill.sourceRepo,
      sourceUrl: skill.sourceUrl
    },
    triggerSyntax: {
      mode: "agent_decides",
      directSyntax: `#skill:${skill.id}`,
      tags: skill.tags
    },
    injectionMode: "agent_decides",
    targetAgentTypes: skill.targetAgentTypes,
    requiredTools: skill.requiredTools,
    outputRules: [
      "按任务需要引用本 Skill 中的流程和检查清单。",
      "如果产出较长，优先生成工作空间内 Markdown 文档并在消息里提供路径。"
    ],
    safetyRules: [
      "不要泄露密钥、账号、Token 或个人隐私。",
      "公共 Skill 不应包含用户私有项目信息。"
    ],
    metadata: {
      source: "github_import",
      sourceRepo: skill.sourceRepo,
      sourceUrl: skill.sourceUrl,
      sourceName: skill.sourceName,
      ownerUserId: skill.userId,
      tags: skill.tags,
      releaseVersion: "v0.0.1"
    }
  };
  const fingerprint = fingerprintJson(spec);
  const row = await prisma.skillAsset.upsert({
    where: { sourceAssetId: skill.sourceAssetId },
    create: {
      id: skill.id,
      sourceAssetId: skill.sourceAssetId,
      ownerType: "user",
      ownerId: skill.userId,
      name: skill.name,
      description: skill.description,
      visibility: skill.visibility,
      triggerSyntax: spec.triggerSyntax as Prisma.InputJsonValue,
      injectionMode: spec.injectionMode,
      targetAgentTypes: spec.targetAgentTypes as Prisma.InputJsonValue,
      requiredTools: spec.requiredTools as Prisma.InputJsonValue,
      outputRules: spec.outputRules as Prisma.InputJsonValue,
      safetyRules: spec.safetyRules as Prisma.InputJsonValue,
      currentVersion: 1,
      releaseVersion: "v0.0.1",
      currentFingerprint: fingerprint
    },
    update: {
      ownerType: "user",
      ownerId: skill.userId,
      name: skill.name,
      description: skill.description,
      visibility: skill.visibility,
      triggerSyntax: spec.triggerSyntax as Prisma.InputJsonValue,
      injectionMode: spec.injectionMode,
      targetAgentTypes: spec.targetAgentTypes as Prisma.InputJsonValue,
      requiredTools: spec.requiredTools as Prisma.InputJsonValue,
      outputRules: spec.outputRules as Prisma.InputJsonValue,
      safetyRules: spec.safetyRules as Prisma.InputJsonValue,
      currentVersion: 1,
      releaseVersion: "v0.0.1",
      currentFingerprint: fingerprint,
      deletedAt: null
    }
  });
  await prisma.skillVersion.upsert({
    where: { skillAssetId_version: { skillAssetId: row.id, version: 1 } },
    create: {
      skillAssetId: row.id,
      version: 1,
      releaseVersion: "v0.0.1",
      sourceAssetId: skill.sourceAssetId,
      sourceAssetVersion: 1,
      spec: spec as Prisma.InputJsonValue,
      fingerprint
    },
    update: {
      releaseVersion: "v0.0.1",
      sourceAssetId: skill.sourceAssetId,
      sourceAssetVersion: 1,
      spec: spec as Prisma.InputJsonValue,
      fingerprint,
      deletedAt: null
    }
  });
}

function assetMetadata(skill: ImportedSkillSeed, checksum: string): Prisma.InputJsonValue {
  return {
    hubKind: "skill",
    visibility: skill.visibility,
    ownerType: "user",
    ownerId: skill.userId,
    ownerUserId: skill.userId,
    storage: "local",
    source: "github_import",
    sourceRepo: skill.sourceRepo,
    sourceUrl: skill.sourceUrl,
    sourceName: skill.sourceName,
    tags: skill.tags,
    releaseVersion: "v0.0.1",
    checksumSha256: checksum,
    etag: `"sha256-${checksum}"`,
    latestVersion: 1
  } as Prisma.InputJsonValue;
}

async function downloadText(url: string) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
  return response.text();
}

function fingerprintJson(value: unknown) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

await main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
