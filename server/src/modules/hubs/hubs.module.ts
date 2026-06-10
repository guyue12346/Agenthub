import { Module } from "@nestjs/common";
import { WorkspacesModule } from "../workspaces/workspaces.module.js";
import { HubsController } from "./hubs.controller.js";
import { HubsService } from "./hubs.service.js";

@Module({
  imports: [WorkspacesModule],
  controllers: [HubsController],
  providers: [HubsService],
  exports: [HubsService]
})
export class HubsModule {}
