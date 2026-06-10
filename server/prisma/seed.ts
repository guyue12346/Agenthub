import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "../src/generated/prisma/client.js";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { hashPassword } from "../src/common/auth-crypto.js";
import { builtInAgents, type AgentHubUser } from "@agenthub/shared";
import { toolRegistry } from "../src/modules/tools/tool-registry.js";
import { completeBuiltinToolDefinition, fingerprintToolDefinition } from "../src/modules/tools/tools.service.js";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required for prisma seed");
if (process.env.NODE_ENV === "production" && process.env.AGENTHUB_ALLOW_DEV_SEED !== "true") {
  throw new Error("Refusing to run development seed in production. Use a production bootstrap script instead.");
}

const prisma = new PrismaClient({
  adapter: new PrismaPg(connectionString)
});

const bootstrapUsers: AgentHubUser[] = [
  { id: "admin", publicId: "ah-0admin7z", name: "系统管理员", avatar: "/avatars/users/user-08.webp", role: "admin" },
  { id: "agenthub-official", publicId: "ah-official", name: "agenthub官方", avatar: "/avatars/agents/agent-v2-01.png", role: "member" },
  { id: "guyue", publicId: "ah-7x4k2p9m", name: "古月", avatar: "/avatars/users/user-02.jpeg", role: "owner" },
  { id: "lin", publicId: "ah-5m8q1c3v", name: "林舟", avatar: "/avatars/users/user-01.jpg", role: "member" },
  { id: "chen", publicId: "ah-9r2t6n4b", name: "陈一", avatar: "/avatars/users/user-03.png", role: "member" }
];
const disabledBuiltInAgentIds = ["agent-review"];

async function main() {
  for (const user of bootstrapUsers) {
    await prisma.user.upsert({
      where: { id: user.id },
      create: {
        id: user.id,
        publicId: user.publicId,
        name: user.name,
        email: user.id,
        avatar: user.avatar,
        role: user.role,
        passwordHash: hashPassword(user.id)
      },
      update: {
        publicId: user.publicId,
        name: user.name,
        email: user.id,
        avatar: user.avatar,
        role: user.role,
        passwordHash: hashPassword(user.id),
        deletedAt: null
      }
    });
  }

  for (const agent of builtInAgents) {
    await prisma.agent.upsert({
      where: { id: agent.id },
      create: {
        id: agent.id,
        name: agent.name,
        avatar: agent.avatar,
        type: agent.type,
        provider: agent.provider,
        description: agent.description,
        capabilities: agent.capabilities as unknown as Prisma.InputJsonValue,
        visibility: "public",
        status: agent.status
      },
      update: {
        name: agent.name,
        avatar: agent.avatar,
        type: agent.type,
        provider: agent.provider,
        description: agent.description,
        capabilities: agent.capabilities as unknown as Prisma.InputJsonValue,
        visibility: "public",
        status: agent.status,
        deletedAt: null
      }
    });
  }

  await prisma.agent.updateMany({
    where: { id: { in: disabledBuiltInAgentIds }, deletedAt: null },
    data: { deletedAt: new Date(), status: "unavailable" }
  });

  for (const tool of toolRegistry) {
    const definition = completeBuiltinToolDefinition(tool);
    const fingerprint = fingerprintToolDefinition(definition);
    const existing = await prisma.toolDefinition.findUnique({
      where: { id: definition.id },
      include: { versions: { orderBy: { version: "desc" }, take: 1 } }
    });
    if (!existing) {
      await prisma.toolDefinition.create({
        data: {
          id: definition.id,
          category: definition.category,
          name: definition.name,
          risk: definition.risk,
          description: definition.description,
          runtimeType: definition.runtimeType,
          source: definition.source,
          visibility: definition.visibility,
          executable: definition.executable,
          inputSchema: definition.inputSchema as Prisma.InputJsonValue,
          outputSchema: definition.outputSchema as Prisma.InputJsonValue,
          permissionScopes: definition.permissionScopes as Prisma.InputJsonValue,
          requiresApproval: definition.requiresApproval,
          availableToAgentTypes: definition.availableToAgentTypes as Prisma.InputJsonValue,
          timeoutPolicy: definition.timeoutPolicy,
          auditLevel: definition.auditLevel,
          currentVersion: 1,
          currentFingerprint: fingerprint,
          versions: {
            create: {
              version: 1,
              definition: definition as Prisma.InputJsonValue,
              fingerprint
            }
          }
        }
      });
      continue;
    }
    const nextVersion = existing.currentFingerprint === fingerprint
      ? existing.currentVersion
      : (existing.versions[0]?.version ?? existing.currentVersion) + 1;
    if (existing.currentFingerprint !== fingerprint) {
      await prisma.toolVersion.create({
        data: {
          toolId: definition.id,
          version: nextVersion,
          definition: definition as Prisma.InputJsonValue,
          fingerprint
        }
      });
    }
    await prisma.toolDefinition.update({
      where: { id: definition.id },
      data: {
        category: definition.category,
        name: definition.name,
        risk: definition.risk,
        description: definition.description,
        runtimeType: definition.runtimeType,
        source: definition.source,
        visibility: definition.visibility,
        executable: definition.executable,
        inputSchema: definition.inputSchema as Prisma.InputJsonValue,
        outputSchema: definition.outputSchema as Prisma.InputJsonValue,
        permissionScopes: definition.permissionScopes as Prisma.InputJsonValue,
        requiresApproval: definition.requiresApproval,
        availableToAgentTypes: definition.availableToAgentTypes as Prisma.InputJsonValue,
        timeoutPolicy: definition.timeoutPolicy,
        auditLevel: definition.auditLevel,
        currentVersion: nextVersion,
        currentFingerprint: fingerprint,
        deletedAt: null
      }
    });
  }

  await prisma.friendConnection.upsert({
    where: { id: "friend-guyue-lin" },
    create: {
      id: "friend-guyue-lin",
      requesterId: "guyue",
      addresseeId: "lin",
      status: "accepted"
    },
    update: {
      requesterId: "guyue",
      addresseeId: "lin",
      status: "accepted",
      deletedAt: null
    }
  });

  await seedGuyueSkills();
  await seedOfficialSkills();

  await prisma.systemLog.create({
    data: {
      level: "info",
      scope: "bootstrap",
      message: "AgentHub PostgreSQL bootstrap completed.",
      payload: {
        users: bootstrapUsers.length,
        agents: builtInAgents.length
      } as Prisma.InputJsonValue
    }
  });
}

async function seedGuyueSkills() {
  const workspaceId = "workspace-hub-guyue";
  const conversationId = "conv-hub-guyue";
  const memberId = "member-hub-guyue";
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
      lastMessage: "个人 Hub fork 和订阅资产会保存在这里。",
      memberCount: 1
    },
    update: {
      type: "project",
      title: "个人 Hub 资产库",
      avatar: "HB",
      workspaceId,
      lastMessage: "个人 Hub fork 和订阅资产会保存在这里。",
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
      memberId: "guyue",
      role: "owner"
    },
    update: {
      memberType: "user",
      memberId: "guyue",
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
  const deprecatedStarterSkillNames = ["公共 Agent 协作 Skill", "个人长文档整理 Skill"];
  const deletedAt = new Date();
  await prisma.skillAsset.updateMany({
    where: { ownerType: "user", ownerId: "guyue", name: { in: deprecatedStarterSkillNames } },
    data: { deletedAt }
  });
  await prisma.workspaceAsset.updateMany({
    where: { workspaceId, name: { in: deprecatedStarterSkillNames } },
    data: { deletedAt }
  });

  const skills = [
    {
      id: "skill-guyue-private-doc-brief",
      sourceAssetId: "asset-skill-guyue-private-doc-brief",
      path: "skills/skill-guyue-private-doc-brief.md",
      name: "长文档简报 Skill",
      description: "当 Agent 产出较长时，先整理任务简报，并把正文写入工作空间 Doc 目录。",
      visibility: "private",
      content: [
        "# 长文档简报 Skill",
        "",
        "适用场景：PRD、技术方案、设计评审、调研总结、开发日志等长文本产出。",
        "",
        "规则：",
        "- 如果正文超过 800 字，优先创建 Markdown 文档。",
        "- 群聊回复只保留任务目标、关键结论、产物路径和下一步。",
        "- 文档路径必须是工作空间内的相对路径，优先写入 `Doc/`。",
        "- 未真正写入文件时，不得声称已经生成文档。"
      ].join("\n")
    },
    {
      id: "skill-guyue-public-agent-collaboration",
      sourceAssetId: "asset-skill-guyue-public-agent-collaboration",
      path: "skills/skill-guyue-public-agent-collaboration.md",
      name: "群聊协作回复 Skill",
      description: "约束 Agent 在项目群聊中像真实团队成员一样回复、引用、补充和沉淀结论。",
      visibility: "public",
      content: [
        "# 群聊协作回复 Skill",
        "",
        "适用场景：Orchestrator 分派任务、子 Agent 汇报结果、Review Agent 审阅其他 Agent 输出。",
        "",
        "规则：",
        "- 被分派任务后先简短确认收到。",
        "- 输出分为：结论、依据、产物、下一步。",
        "- 审阅其他 Agent 结果时使用引用语气，明确通过、补充或返工。",
        "- 信息不足时只提出最小必要问题，不重复追问已经确认的信息。"
      ].join("\n")
    }
  ] as const;

  for (const skill of skills) {
    const absolutePath = join(rootPath, skill.path);
    const content = Buffer.from(skill.content, "utf8");
    const checksum = createHash("sha256").update(content).digest("hex");
    await mkdir(join(rootPath, "skills"), { recursive: true });
    await writeFile(absolutePath, content);
    const existingById = await prisma.skillAsset.findUnique({ where: { id: skill.id } });
    if (existingById && existingById.sourceAssetId !== skill.sourceAssetId) {
      await prisma.skillAsset.update({
        where: { id: skill.id },
        data: { sourceAssetId: skill.sourceAssetId }
      });
    }
    await prisma.workspaceAsset.upsert({
      where: { id: skill.sourceAssetId },
      create: {
        id: skill.sourceAssetId,
        workspaceId,
        kind: "doc",
        name: `${skill.name}.md`,
        path: skill.path,
        mimeType: "text/markdown",
        size: content.byteLength,
        summary: skill.description,
        metadata: {
          hubKind: "skill",
          visibility: skill.visibility,
          ownerType: "user",
          ownerId: "guyue",
          ownerUserId: "guyue",
          storage: "local",
          source: "seed",
          checksumSha256: checksum,
          etag: `"sha256-${checksum}"`,
          latestVersion: 1
        } as Prisma.InputJsonValue
      },
      update: {
        workspaceId,
        kind: "doc",
        name: `${skill.name}.md`,
        path: skill.path,
        mimeType: "text/markdown",
        size: content.byteLength,
        summary: skill.description,
        metadata: {
          hubKind: "skill",
          visibility: skill.visibility,
          ownerType: "user",
          ownerId: "guyue",
          ownerUserId: "guyue",
          storage: "local",
          source: "seed",
          checksumSha256: checksum,
          etag: `"sha256-${checksum}"`,
          latestVersion: 1
        } as Prisma.InputJsonValue,
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
        size: content.byteLength,
        checksumSha256: checksum,
        createdByUserId: "guyue",
        metadata: {
          source: "seed",
          visibility: skill.visibility
        } as Prisma.InputJsonValue
      },
      update: {
        path: skill.path,
        size: content.byteLength,
        checksumSha256: checksum,
        createdByUserId: "guyue",
        metadata: {
          source: "seed",
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
        ownerId: "guyue"
      },
      source: {
        sourceAssetId: skill.sourceAssetId,
        sourceAssetVersion: 1,
        sourceType: "workspace_asset",
        storage: "workspace",
        workspaceId,
        path: skill.path,
        mimeType: "text/markdown",
        size: content.byteLength,
        sourceFingerprint: checksum
      },
      content: skill.content,
      triggerSyntax: {
        mode: "agent_decides",
        directSyntax: `#skill:${skill.id}`
      },
      injectionMode: "agent_decides",
      targetAgentTypes: ["universal", "product", "ui", "review"],
      requiredTools: [],
      outputRules: [
        "长内容优先写入 Doc，并在消息中提供相对路径。",
        "回复保留任务简报和可执行下一步。"
      ],
      safetyRules: [
        "不要编造不存在的文件路径。",
        "不要在公共 Skill 中包含密钥、账号或个人隐私。"
      ],
      metadata: {
        source: "seed",
        ownerUserId: "guyue",
        testAsset: true
      }
    };
    const fingerprint = fingerprintJson(spec);
    const row = await prisma.skillAsset.upsert({
      where: { sourceAssetId: skill.sourceAssetId },
      create: {
        id: skill.id,
        sourceAssetId: skill.sourceAssetId,
        ownerType: "user",
        ownerId: "guyue",
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
        currentFingerprint: fingerprint
      },
      update: {
        ownerType: "user",
        ownerId: "guyue",
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
        currentFingerprint: fingerprint,
        deletedAt: null
      }
    });
    await prisma.skillVersion.upsert({
      where: { skillAssetId_version: { skillAssetId: row.id, version: 1 } },
      create: {
        skillAssetId: row.id,
        version: 1,
        sourceAssetId: skill.sourceAssetId,
        sourceAssetVersion: 1,
        spec: spec as Prisma.InputJsonValue,
        fingerprint
      },
      update: {
        sourceAssetId: skill.sourceAssetId,
        sourceAssetVersion: 1,
        spec: spec as Prisma.InputJsonValue,
        fingerprint,
        deletedAt: null
      }
    });
  }
}

type SeedSkillDefinition = {
  id: string;
  sourceAssetId: string;
  path: string;
  name: string;
  description: string;
  visibility: "private" | "public";
  releaseVersion?: string;
  logo?: string;
  logoColor?: string;
  targetAgentTypes?: string[];
  requiredTools?: string[];
  outputRules?: string[];
  safetyRules?: string[];
  content: string;
  references?: string[];
};

async function seedOfficialSkills() {
  const references = [
    "https://github.com/anthropics/skills",
    "https://docs.github.com/en/copilot/concepts/agents/about-agent-skills",
    "https://docs.github.com/en/copilot/how-tos/use-copilot-agents/coding-agent/create-skills",
    "https://github.com/microsoft/SkillOpt"
  ];
  const officialSkills: SeedSkillDefinition[] = [
    {
      id: "skill-official-orchestrator-minimal-run",
      sourceAssetId: "asset-skill-official-orchestrator-minimal-run",
      path: "skills/official-orchestrator-minimal-run.md",
      name: "Orchestrator 最小轮次推进 Skill",
      description: "帮助主 Agent 把长期项目拆成本轮最小可推进范围，并在需要确认时自然暂停。",
      visibility: "public",
      releaseVersion: "v1.0.0",
      logo: "workflow",
      logoColor: "#7c3aed",
      targetAgentTypes: ["orchestrator", "product", "universal"],
      outputRules: ["先确定本轮边界，再分派子 Agent。", "需要用户确认时输出明确选项和下一步影响。"],
      safetyRules: ["不要越过用户尚未确认的阶段。", "不要把长期项目一次性全部做完。"],
      references,
      content: [
        "# Orchestrator 最小轮次推进 Skill",
        "",
        "适用场景：项目群聊中用户 @Orchestrator 或同时 @多个 Agent，需要由主 Agent 统一理解、分工和推进。",
        "",
        "工作方式：",
        "- 先读取长期记忆、最近消息、Pin、附件摘要和本轮已发生的调度记录。",
        "- 判断用户意图是否足够清楚；不清楚时只问一个最小必要问题。",
        "- 明确本轮最小执行范围：本轮只完成一个可验收的小阶段，而不是一次性完成整个项目。",
        "- 输出子 Agent 分派计划时，像真实团队协作一样在群聊里说明：@谁 负责什么、输入是什么、产出是什么、验收标准是什么。",
        "- 子 Agent 完成后先等待校验，再汇总；需要用户确认时自然暂停。",
        "",
        "输出格式：",
        "- 本轮目标：一句话。",
        "- 分工计划：按 Agent 列出任务、输入、预期产出。",
        "- 暂停点：说明是否需要用户确认。",
        "- 下一步：只给当前最合理的 1-3 个动作。"
      ].join("\n")
    },
    {
      id: "skill-official-requirement-to-execution-spec",
      sourceAssetId: "asset-skill-official-requirement-to-execution-spec",
      path: "skills/official-requirement-to-execution-spec.md",
      name: "需求到执行规格 Skill",
      description: "把模糊需求转成可执行规格，适合产品 Agent、通用 Agent 和主 Agent 前置分析。",
      visibility: "public",
      releaseVersion: "v1.0.0",
      logo: "compass",
      logoColor: "#2563eb",
      targetAgentTypes: ["orchestrator", "product", "universal", "review"],
      outputRules: ["把问题拆成目标、约束、范围、验收标准。", "显式列出缺口和风险。"],
      safetyRules: ["不能替用户补全关键业务决策。", "不能把猜测写成已确认事实。"],
      references,
      content: [
        "# 需求到执行规格 Skill",
        "",
        "适用场景：用户表达较口语化、需求范围不清、需要先形成可执行任务说明。",
        "",
        "处理步骤：",
        "- 提取用户目标：要解决什么问题，面向谁，产出是什么。",
        "- 提取已知约束：技术栈、时间、权限、数据、已有设计文档、不能做的事。",
        "- 识别缺失信息：只保留会影响执行路径的问题。",
        "- 形成执行规格：范围、输入、输出、验收标准、风险、需要确认的问题。",
        "- 如果需求足够清楚，直接交给 Decompose 或对应子 Agent；如果不清楚，先向用户确认。",
        "",
        "输出必须包含：",
        "- 需求摘要。",
        "- 本轮执行范围。",
        "- 关键约束。",
        "- 验收标准。",
        "- 待确认问题。"
      ].join("\n")
    },
    {
      id: "skill-official-code-agent-handoff",
      sourceAssetId: "asset-skill-official-code-agent-handoff",
      path: "skills/official-code-agent-handoff.md",
      name: "Code Agent 任务交接 Skill",
      description: "把群聊任务转成 Codex/OpenCode 可自然执行的代码任务说明，约束工作空间、文件和汇报方式。",
      visibility: "public",
      releaseVersion: "v1.0.0",
      logo: "code",
      logoColor: "#0d9488",
      targetAgentTypes: ["orchestrator", "code", "review"],
      requiredTools: ["workspace.read", "workspace.write", "git.status"],
      outputRules: ["给 Code Agent 的指令要像真实开发协作，不写内部状态机术语。", "完成后只汇报用户关心的改动、验证和文件路径。"],
      safetyRules: ["Code Agent 只能在工作空间 Code/ 下改代码。", "涉及删除、迁移、密钥和外部服务时必须要求确认。"],
      references,
      content: [
        "# Code Agent 任务交接 Skill",
        "",
        "适用场景：Orchestrator 或用户需要让 Codex/OpenCode 修改代码、跑测试、排查错误。",
        "",
        "交接指令结构：",
        "- 背景：当前项目目标和相关对话结论。",
        "- 任务：这次只需要完成的具体代码目标。",
        "- 工作目录：默认在工作空间 `Code/` 下执行。",
        "- 允许范围：可读写哪些目录，哪些目录禁止修改。",
        "- 参考文件：用户消息、附件、文档或上一次执行结果。",
        "- 验收方式：需要跑的 lint、test、build 或浏览器验证。",
        "- 汇报要求：只输出结论、修改文件、验证结果、风险和下一步。",
        "",
        "禁止事项：",
        "- 不要把内部工具调用日志原样发到群聊。",
        "- 不要声称改了文件但没有真实写入。",
        "- 不要跨出工作空间修改用户本机其他目录。"
      ].join("\n")
    },
    {
      id: "skill-official-agent-product-ui",
      sourceAssetId: "asset-skill-official-agent-product-ui",
      path: "skills/official-agent-product-ui.md",
      name: "Agent 产品 UI 设计 Skill",
      description: "面向 AgentHub 这类生产力应用的高密度、低干扰、类飞书工作台 UI 设计规范。",
      visibility: "public",
      releaseVersion: "v1.0.0",
      logo: "wand",
      logoColor: "#db2777",
      targetAgentTypes: ["ui", "product", "review", "universal"],
      outputRules: ["直接给可落地的布局、组件、状态和交互细节。", "避免营销页式表达，优先工作台效率。"],
      safetyRules: ["不要用大面积单色渐变、装饰光斑或无意义卡片堆叠。", "不要让按钮、标签、文本在移动端溢出。"],
      references,
      content: [
        "# Agent 产品 UI 设计 Skill",
        "",
        "适用场景：设计 AgentHub、聊天工作台、Hub 资产市场、Agent 状态面板、后台监控等生产力界面。",
        "",
        "设计原则：",
        "- 第一屏直接进入可操作工作台，不做营销首页。",
        "- 左侧全局导航、二级列表、主内容区、按需出现的右侧详情区，整体参考飞书/微信的工作流结构。",
        "- 字号克制，信息密度高但不拥挤。",
        "- 卡片只用于资产、消息附件、状态面板等重复对象；不要把整个页面 section 都包成卡片。",
        "- 图标按钮必须有 tooltip；常用操作用图标，危险操作不要默认大面积红色。",
        "- 消息区交互包括引用、评论、pin、点赞，默认弱化，悬浮时出现。",
        "",
        "输出建议：",
        "- 页面布局。",
        "- 组件清单。",
        "- 关键状态。",
        "- 响应式规则。",
        "- 需要浏览器验证的点。"
      ].join("\n")
    },
    {
      id: "skill-official-rich-message-rendering",
      sourceAssetId: "asset-skill-official-rich-message-rendering",
      path: "skills/official-rich-message-rendering.md",
      name: "富文本消息渲染 Skill",
      description: "规范 Agent 回复中的文本、图片、文件、Diff、网页预览和部署状态如何变成可渲染消息块。",
      visibility: "public",
      releaseVersion: "v1.0.0",
      logo: "layers",
      logoColor: "#ea580c",
      targetAgentTypes: ["ui", "code", "universal", "review"],
      outputRules: ["长内容用文档路径和右侧预览承载。", "Diff 和代码块默认限制高度，点击后展开或右侧预览。"],
      safetyRules: ["不要输出不可访问的本地绝对路径给 Web 用户。", "图片、文件、预览必须来自消息附件或工作空间资产。"],
      references,
      content: [
        "# 富文本消息渲染 Skill",
        "",
        "适用场景：Agent 回复不仅有文字，还包含图片、Markdown 文档、代码块、Diff、网页预览、部署状态和工作空间文件。",
        "",
        "消息块规范：",
        "- text：短文本和 Markdown 摘要，支持标题、列表、引用、代码高亮。",
        "- image：单图居中，多图同一行横向滑动。",
        "- file：显示文件名、摘要、大小、路径，点击后在右侧预览。",
        "- diff：默认固定高度滚动展示，提供应用、查看完整、复制等操作。",
        "- web：显示预览卡片和安全 iframe 入口。",
        "- deploy：显示状态、环境、URL、日志入口。",
        "",
        "Agent 回复规则：",
        "- 如果内容超过 800 字，优先写入工作空间 `Doc/` 并在消息中提供相对路径。",
        "- 群聊消息只保留任务简报、关键结论、产物路径和下一步。",
        "- 不要把工具执行的原始日志刷屏到聊天流。"
      ].join("\n")
    },
    {
      id: "skill-official-knowledgehub-rag-curation",
      sourceAssetId: "asset-skill-official-knowledgehub-rag-curation",
      path: "skills/official-knowledgehub-rag-curation.md",
      name: "KnowledgeHub RAG 构建 Skill",
      description: "指导 Agent 把用户上传文件整理成可检索知识库，并在回答时给出来源、摘要和查询路径。",
      visibility: "public",
      releaseVersion: "v1.0.0",
      logo: "database",
      logoColor: "#16a34a",
      targetAgentTypes: ["knowledge", "universal", "orchestrator", "review"],
      requiredTools: ["knowledge.search", "workspace.read"],
      outputRules: ["回答必须说明使用了哪些知识库和来源片段。", "索引失败时明确指出文件、原因和重试建议。"],
      safetyRules: ["不要把团队知识默认写入个人跨对话记忆。", "不要用未检索到的内容冒充知识库结果。"],
      references,
      content: [
        "# KnowledgeHub RAG 构建 Skill",
        "",
        "适用场景：用户上传文档、创建知识库、让 Agent 基于知识库回答或强化任务执行。",
        "",
        "构建流程：",
        "- 接收文件后保存到工作空间资产目录。",
        "- 生成文件摘要：主题、适用场景、关键术语、来源、上传者、时间、路径。",
        "- 建立分块索引：按标题、语义段落、代码块和表格边界切分。",
        "- 向量化成功后标记 indexStatus，并记录 chunk 数量和模型。",
        "- 回答问题时先检索，再组织答案；必要时提示用户查看右侧预览。",
        "",
        "输出格式：",
        "- 使用的知识库。",
        "- 命中的来源片段。",
        "- 回答结论。",
        "- 不确定或缺失的信息。"
      ].join("\n")
    },
    {
      id: "skill-official-toolhub-contract",
      sourceAssetId: "asset-skill-official-toolhub-contract",
      path: "skills/official-toolhub-contract.md",
      name: "ToolHub 工具接口规范 Skill",
      description: "帮助设计可被 Agent 安全调用的工具接口，包括 Schema、权限、审计、幂等和错误返回。",
      visibility: "public",
      releaseVersion: "v1.0.0",
      logo: "puzzle",
      logoColor: "#475569",
      targetAgentTypes: ["tool", "code", "orchestrator", "review"],
      outputRules: ["每个工具必须有输入 Schema、输出 Schema、权限和失败语义。", "说明工具适合哪些 Agent 类型调用。"],
      safetyRules: ["高风险工具必须要求审批。", "工具不得绕过工作空间边界或泄露密钥。"],
      references,
      content: [
        "# ToolHub 工具接口规范 Skill",
        "",
        "适用场景：为 AgentHub 设计新的 Tool、MCP 适配器、本地 Runner 工具或第三方服务工具。",
        "",
        "工具设计必须说明：",
        "- toolId、名称、分类、风险等级。",
        "- 输入 JSON Schema。",
        "- 输出 JSON Schema。",
        "- 权限范围：workspace.read、workspace.write、network.fetch、browser.preview 等。",
        "- 是否需要用户审批。",
        "- 超时、重试、幂等键和失败返回格式。",
        "- 审计日志：记录 caller、输入摘要、输出摘要、耗时、错误和 traceId。",
        "",
        "输出建议：",
        "- 工具定义草案。",
        "- 安全边界。",
        "- Agent 调用示例。",
        "- 测试用例。"
      ].join("\n")
    },
    {
      id: "skill-official-e2e-acceptance",
      sourceAssetId: "asset-skill-official-e2e-acceptance",
      path: "skills/official-e2e-acceptance.md",
      name: "端到端验收测试 Skill",
      description: "围绕真实账号、真实数据库、实时消息、Hub 资产和 Agent 调用设计验收测试。",
      visibility: "public",
      releaseVersion: "v1.0.0",
      logo: "gauge",
      logoColor: "#ca8a04",
      targetAgentTypes: ["review", "code", "universal", "orchestrator"],
      requiredTools: ["browser.open", "browser.click", "workspace.read"],
      outputRules: ["先列验收场景，再给测试步骤和通过标准。", "失败必须给可复现路径和日志入口。"],
      safetyRules: ["不要用假数据替代真实接口。", "不要只检查页面能打开，必须验证数据状态变化。"],
      references,
      content: [
        "# 端到端验收测试 Skill",
        "",
        "适用场景：检查 AgentHub 的登录、好友、群聊、消息实时更新、Hub 创建、订阅、fork、点赞、Agent 调用和后台监控。",
        "",
        "测试原则：",
        "- 使用真实账号、真实数据库、真实 API 和真实浏览器。",
        "- 每个可见按钮都必须有真实行为。",
        "- 消息发送后不刷新页面也应实时出现。",
        "- 未读红点进入会话后应正确清除。",
        "- Hub 资产创建后必须能在数据库、个人页、公共页中一致显示。",
        "- Agent 调用失败时应能在日志和状态面板中定位。",
        "",
        "输出格式：",
        "- 测试目标。",
        "- 前置数据。",
        "- 操作步骤。",
        "- 期望结果。",
        "- 实际结果。",
        "- 问题和修复建议。"
      ].join("\n")
    }
  ];
  await seedSkillSetForUser({
    userId: "agenthub-official",
    workspaceId: "workspace-hub-agenthub-official",
    conversationId: "conv-hub-agenthub-official",
    memberId: "member-hub-agenthub-official",
    skills: officialSkills
  });
}

async function seedSkillSetForUser(input: {
  userId: string;
  workspaceId: string;
  conversationId: string;
  memberId: string;
  skills: SeedSkillDefinition[];
}) {
  const workspaceRoot = process.env.AGENTHUB_WORKSPACES_ROOT?.trim()
    ? resolve(process.env.AGENTHUB_WORKSPACES_ROOT)
    : resolve(process.cwd(), "..", "workspaces");
  const rootPath = join(workspaceRoot, input.workspaceId);
  await mkdir(join(rootPath, "skills"), { recursive: true });
  await prisma.conversation.upsert({
    where: { id: input.conversationId },
    create: {
      id: input.conversationId,
      type: "project",
      title: "个人 Hub 资产库",
      avatar: "HB",
      workspaceId: input.workspaceId,
      codeAgentId: null,
      lastMessage: "个人 Hub fork 和订阅资产会保存在这里。",
      memberCount: 1
    },
    update: {
      type: "project",
      title: "个人 Hub 资产库",
      avatar: "HB",
      workspaceId: input.workspaceId,
      lastMessage: "个人 Hub fork 和订阅资产会保存在这里。",
      memberCount: 1,
      deletedAt: null
    }
  });
  await prisma.conversationMember.upsert({
    where: { id: input.memberId },
    create: {
      id: input.memberId,
      conversationId: input.conversationId,
      memberType: "user",
      memberId: input.userId,
      role: "owner"
    },
    update: {
      memberType: "user",
      memberId: input.userId,
      role: "owner",
      deletedAt: null
    }
  });
  await prisma.workspace.upsert({
    where: { id: input.workspaceId },
    create: {
      id: input.workspaceId,
      conversationId: input.conversationId,
      name: "个人 Hub 资产库",
      rootPath
    },
    update: {
      conversationId: input.conversationId,
      name: "个人 Hub 资产库",
      rootPath,
      deletedAt: null
    }
  });

  for (const skill of input.skills) {
    const absolutePath = join(rootPath, skill.path);
    const content = Buffer.from(skill.content, "utf8");
    const checksum = createHash("sha256").update(content).digest("hex");
    await writeFile(absolutePath, content);
    await prisma.workspaceAsset.upsert({
      where: { id: skill.sourceAssetId },
      create: {
        id: skill.sourceAssetId,
        workspaceId: input.workspaceId,
        kind: "doc",
        name: `${skill.name}.md`,
        path: skill.path,
        mimeType: "text/markdown",
        size: content.byteLength,
        summary: skill.description,
        metadata: {
          hubKind: "skill",
          visibility: skill.visibility,
          ownerType: "user",
          ownerId: input.userId,
          ownerUserId: input.userId,
          storage: "local",
          source: "official_seed",
          checksumSha256: checksum,
          etag: `"sha256-${checksum}"`,
          latestVersion: 1,
          releaseVersion: skill.releaseVersion ?? "v1.0.0",
          logo: skill.logo ?? "sparkles",
          logoColor: skill.logoColor ?? "#2563eb"
        } as Prisma.InputJsonValue
      },
      update: {
        workspaceId: input.workspaceId,
        kind: "doc",
        name: `${skill.name}.md`,
        path: skill.path,
        mimeType: "text/markdown",
        size: content.byteLength,
        summary: skill.description,
        metadata: {
          hubKind: "skill",
          visibility: skill.visibility,
          ownerType: "user",
          ownerId: input.userId,
          ownerUserId: input.userId,
          storage: "local",
          source: "official_seed",
          checksumSha256: checksum,
          etag: `"sha256-${checksum}"`,
          latestVersion: 1,
          releaseVersion: skill.releaseVersion ?? "v1.0.0",
          logo: skill.logo ?? "sparkles",
          logoColor: skill.logoColor ?? "#2563eb"
        } as Prisma.InputJsonValue,
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
        size: content.byteLength,
        checksumSha256: checksum,
        createdByUserId: input.userId,
        metadata: {
          source: "official_seed",
          visibility: skill.visibility
        } as Prisma.InputJsonValue
      },
      update: {
        path: skill.path,
        size: content.byteLength,
        checksumSha256: checksum,
        createdByUserId: input.userId,
        metadata: {
          source: "official_seed",
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
        ownerId: input.userId
      },
      source: {
        sourceAssetId: skill.sourceAssetId,
        sourceAssetVersion: 1,
        sourceType: "workspace_asset",
        storage: "workspace",
        workspaceId: input.workspaceId,
        path: skill.path,
        mimeType: "text/markdown",
        size: content.byteLength,
        sourceFingerprint: checksum
      },
      content: skill.content,
      triggerSyntax: {
        mode: "agent_decides",
        directSyntax: `#skill:${skill.id}`
      },
      injectionMode: "agent_decides",
      targetAgentTypes: skill.targetAgentTypes ?? ["universal", "product", "ui", "review"],
      requiredTools: skill.requiredTools ?? [],
      outputRules: skill.outputRules ?? [],
      safetyRules: skill.safetyRules ?? [
        "不要编造不存在的文件路径。",
        "不要在公共 Skill 中包含密钥、账号或个人隐私。"
      ],
      metadata: {
        source: "official_seed",
        ownerUserId: input.userId,
        logo: skill.logo ?? "sparkles",
        logoColor: skill.logoColor ?? "#2563eb",
        references: skill.references ?? []
      }
    };
    const fingerprint = fingerprintJson(spec);
    const row = await prisma.skillAsset.upsert({
      where: { sourceAssetId: skill.sourceAssetId },
      create: {
        id: skill.id,
        sourceAssetId: skill.sourceAssetId,
        ownerType: "user",
        ownerId: input.userId,
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
        releaseVersion: skill.releaseVersion ?? "v1.0.0",
        currentFingerprint: fingerprint
      },
      update: {
        ownerType: "user",
        ownerId: input.userId,
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
        releaseVersion: skill.releaseVersion ?? "v1.0.0",
        currentFingerprint: fingerprint,
        deletedAt: null
      }
    });
    await prisma.skillVersion.upsert({
      where: { skillAssetId_version: { skillAssetId: row.id, version: 1 } },
      create: {
        skillAssetId: row.id,
        version: 1,
        releaseVersion: skill.releaseVersion ?? "v1.0.0",
        sourceAssetId: skill.sourceAssetId,
        sourceAssetVersion: 1,
        spec: spec as Prisma.InputJsonValue,
        fingerprint
      },
      update: {
        releaseVersion: skill.releaseVersion ?? "v1.0.0",
        sourceAssetId: skill.sourceAssetId,
        sourceAssetVersion: 1,
        spec: spec as Prisma.InputJsonValue,
        fingerprint,
        deletedAt: null
      }
    });
  }
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
