import { Module } from "@nestjs/common";
import { DatabaseModule } from "../../common/database.module.js";
import { EmbeddingService } from "../../common/embedding.service.js";
import { ChunkingService } from "../../common/chunking.service.js";
import { KnowledgeIndexService } from "../../common/knowledge-index.service.js";
import { KnowledgeController } from "./knowledge.controller.js";
import { KnowledgeService } from "./knowledge.service.js";
import { WorkspacesModule } from "../workspaces/workspaces.module.js";
import { DocumentExtractionService } from "./document-extraction.service.js";

@Module({
  imports: [DatabaseModule, WorkspacesModule],
  controllers: [KnowledgeController],
  providers: [KnowledgeService, DocumentExtractionService, EmbeddingService, ChunkingService, KnowledgeIndexService],
  exports: [KnowledgeService, KnowledgeIndexService]
})
export class KnowledgeModule {}
