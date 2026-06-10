import { Module } from "@nestjs/common";
import { RealtimeModule } from "../realtime/realtime.module.js";
import { MonitorController } from "./monitor.controller.js";
import { RuntimeConfigController } from "./runtime-config.controller.js";

@Module({
  imports: [RealtimeModule],
  controllers: [MonitorController, RuntimeConfigController]
})
export class MonitorModule {}
