import type { AgentDefinition } from "./domain";

export const builtInAgents: AgentDefinition[] = [
  {
    id: "agent-orchestrator",
    name: "Orchestrator",
    avatar: "/avatars/agents/agent-v2-01.png",
    type: "orchestrator",
    provider: "internal",
    description: "主协调 Agent，负责理解、拆解、分配、校验和汇总。",
    capabilities: ["planning", "coordination", "validation", "summary"],
    status: "available"
  },
  {
    id: "agent-universal",
    name: "Universal Agent",
    avatar: "/avatars/agents/agent-v2-02.png",
    type: "universal",
    provider: "internal",
    description: "通用兜底 Agent，处理没有专属 Agent 的分析、整理和问答。",
    capabilities: ["general", "analysis", "writing"],
    status: "available"
  },
  {
    id: "agent-product",
    name: "Product Agent",
    avatar: "/avatars/agents/agent-v2-03.png",
    type: "product",
    provider: "internal",
    description: "需求与产品 Agent，负责需求边界、流程和验收标准。",
    capabilities: ["product", "requirements", "acceptance"],
    status: "available"
  },
  {
    id: "agent-ui",
    name: "UI Agent",
    avatar: "/avatars/agents/agent-v2-04.png",
    type: "ui",
    provider: "internal",
    description: "UI 与交互 Agent，负责界面结构、视觉层级和交互细节。",
    capabilities: ["ui", "interaction", "prototype"],
    status: "available"
  },
  {
    id: "agent-deploy",
    name: "Deploy Agent",
    avatar: "/avatars/agents/agent-v2-07.png",
    type: "universal",
    provider: "internal",
    description: "部署 Agent，负责在受控工作空间内构建静态预览、生成部署日志并回写部署状态。",
    capabilities: ["deploy", "static_preview", "build", "release"],
    status: "available"
  },
  {
    id: "agent-codex",
    name: "Codex",
    avatar: "/avatars/agents/agent-v2-05.png",
    type: "code",
    provider: "codex",
    description: "Code Agent，负责复杂代码生成、修改、运行和 Diff。",
    capabilities: ["code", "diff", "test", "preview"],
    status: "available"
  },
  {
    id: "agent-opencode",
    name: "OpenCode",
    avatar: "/avatars/agents/agent-v2-06.png",
    type: "code",
    provider: "opencode",
    description: "Code Agent，负责代码搜索、修改、运行和本地检查。",
    capabilities: ["code", "shell", "diff", "inspect"],
    status: "available"
  }
];
