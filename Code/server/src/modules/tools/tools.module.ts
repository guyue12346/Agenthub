import { Module } from "@nestjs/common";
import { HubsModule } from "../hubs/hubs.module.js";
import { ToolsController } from "./tools.controller.js";
import { ToolsService } from "./tools.service.js";

@Module({
  imports: [HubsModule],
  controllers: [ToolsController],
  providers: [ToolsService],
  exports: [ToolsService]
})
export class ToolsModule {}
