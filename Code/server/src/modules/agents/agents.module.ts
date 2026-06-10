import { Module } from "@nestjs/common";
import { KnowledgeModule } from "../knowledge/knowledge.module.js";
import { LlmService } from "../runtime/llm.service.js";
import { ToolRuntimeService } from "../runtime/tool-runtime.service.js";
import { ToolsModule } from "../tools/tools.module.js";
import { AgentsController } from "./agents.controller.js";
import { AgentsService } from "./agents.service.js";

@Module({
  imports: [KnowledgeModule, ToolsModule],
  controllers: [AgentsController],
  providers: [AgentsService, LlmService, ToolRuntimeService],
  exports: [AgentsService]
})
export class AgentsModule {}
