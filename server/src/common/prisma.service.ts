import "dotenv/config";
import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { PrismaPg } from "@prisma/adapter-pg";
import { ConfigService } from "./config.service.js";
import { PrismaClient } from "../generated/prisma/client.js";

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  readonly mode = "postgresql";

  constructor(@Inject(ConfigService) config = new ConfigService()) {
    const connectionString = config.databaseUrl;
    if (!connectionString) {
      throw new Error("DATABASE_URL is required for AgentHub server runtime");
    }
    super({
      adapter: new PrismaPg(connectionString)
    });
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
