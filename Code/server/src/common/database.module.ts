import { Global, Module } from "@nestjs/common";
import { ConfigService } from "./config.service.js";
import { ObservabilityService } from "./observability.service.js";
import { PrismaService } from "./prisma.service.js";
import { RuntimeConfigService } from "./runtime-config.service.js";

@Global()
@Module({
  providers: [ConfigService, PrismaService, ObservabilityService, RuntimeConfigService],
  exports: [ConfigService, PrismaService, ObservabilityService, RuntimeConfigService]
})
export class DatabaseModule {}
