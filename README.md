# AgentHub

AgentHub 是一个面向 AI Agent 的协同工作台，把消息协作、Agent 资产、工具能力、知识库、代码执行和运行监控组织在同一个产品体系里。它不是单一聊天界面，而是围绕真实任务执行建立的多端 Agent 工作空间。

## 项目定位

AgentHub 以 IM 式工作台作为主入口，让用户可以像在团队沟通软件中一样与人、Agent、项目群和工作空间协作。Agent 不只负责回复消息，还可以连接工具、检索知识、执行代码任务、生成运行记录，并把过程沉淀为可追踪、可复用、可管理的系统资产。

## 核心亮点

### 一体化 Agent 工作台

Web 工作台把会话、联系人、工作空间、Hub 资产和详情面板组织在同一个界面中。用户可以在对话中发起任务，也可以进入工作空间查看产物、上下文、运行日志和后续操作。

### AgentHub / ToolHub / SkillHub / KnowledgeHub

项目不是只管理单个 Agent，而是围绕 Agent 能力建立资产体系：

- `AgentHub`：管理系统 Agent、用户自建 Agent 和可复用 Agent 资产。
- `ToolHub`：沉淀可被 Agent 调用的工具能力。
- `SkillHub`：组织可组合的技能与工作流能力。
- `KnowledgeHub`：管理知识库、文档和检索上下文。

### 真实代码执行链路

AgentHub 保留了 Code Agent、Runner、工作空间隔离和运行事件链路。Agent 可以围绕真实代码任务工作，执行过程进入统一事件、日志和任务记录，而不是停留在演示级伪流程。

### 可追踪的运行过程

后端记录 Runtime Event、Agent Run、Tool Run、LLM 调用日志、系统日志和审计信息。后台监控是系统运行可信度的一部分，用来回答任务为什么失败、Agent 正在做什么、哪一步需要用户确认。

### 多端产品形态

项目包含 Web 工作台、Electron 桌面端外壳和 Android 初版。移动端按消息列表、会话详情和连接配置重新组织交互，不是简单复制桌面四栏界面。

## 工程结构

| 目录 | 说明 |
| --- | --- |
| `shared` | 前后端共享类型、消息协议、运行事件和状态约定 |
| `server` | 后端服务，包含账号、会话、消息、Agent、Hub、Workspace、Runtime、日志和监控模块 |
| `web` | React + TypeScript Web 工作台 |
| `desktop` | Electron 桌面端外壳 |
| `mobile` | Android 移动端初版 |
| `runner` | Code Agent 执行环境与隔离边界 |
