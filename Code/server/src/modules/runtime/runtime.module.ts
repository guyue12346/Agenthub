import { Module } from "@nestjs/common";
import { ConversationsModule } from "../conversations/conversations.module.js";
import { DeploymentsModule } from "../deployments/deployments.module.js";
import { RealtimeModule } from "../realtime/realtime.module.js";
import { KnowledgeModule } from "../knowledge/knowledge.module.js";
import { AgentRuntimeService } from "./agent-runtime.service.js";
import { CodeAgentAdapterService } from "./code-agent-adapter.service.js";
import { CodeAgentBackendRegistry } from "./code-agent-backend-registry.js";
import { CodeAgentWorkspaceLockService } from "./code-agent-workspace-lock.service.js";
import { ContextManagerService } from "./context-manager.service.js";
import { CodexMcpBackend } from "./codex-mcp.backend.js";
import { ExcalidrawRenderService } from "./excalidraw-render.service.js";
import { LlmService } from "./llm.service.js";
import { MemoryManagerService } from "./memory-manager.service.js";
import { OpenCodeServerBackend } from "./opencode-server.backend.js";
import { RuntimeController } from "./runtime.controller.js";
import { RuntimeService } from "./runtime.service.js";
import { ToolRuntimeService } from "./tool-runtime.service.js";
import { UiAgentRuntimeService } from "./ui-agent-runtime.service.js";

@Module({
  imports: [ConversationsModule, RealtimeModule, KnowledgeModule, DeploymentsModule],
  controllers: [RuntimeController],
  providers: [
    RuntimeService,
    CodeAgentAdapterService,
    CodeAgentWorkspaceLockService,
    CodeAgentBackendRegistry,
    OpenCodeServerBackend,
    CodexMcpBackend,
    LlmService,
    ContextManagerService,
    MemoryManagerService,
    ToolRuntimeService,
    AgentRuntimeService,
    ExcalidrawRenderService,
    UiAgentRuntimeService
  ],
  exports: [RuntimeService, MemoryManagerService]
})
export class RuntimeModule {}
