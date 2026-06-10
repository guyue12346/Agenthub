import { Module } from "@nestjs/common";
import { RealtimeModule } from "../realtime/realtime.module.js";
import { WorkspacesModule } from "../workspaces/workspaces.module.js";
import { DeploymentsController } from "./deployments.controller.js";
import { DeploymentsService } from "./deployments.service.js";

@Module({
  imports: [RealtimeModule, WorkspacesModule],
  controllers: [DeploymentsController],
  providers: [DeploymentsService],
  exports: [DeploymentsService]
})
export class DeploymentsModule {}
