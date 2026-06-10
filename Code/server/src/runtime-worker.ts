import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { ConfigService } from "./common/config.service.js";
import { AppModule } from "./modules/app.module.js";
import { RuntimeService } from "./modules/runtime/runtime.service.js";

process.env.AGENTHUB_RUNTIME_WORKER_MODE ??= "worker";

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ["log", "error", "warn"] });
  const config = app.get(ConfigService);
  const runtime = app.get(RuntimeService, { strict: false });
  const keepAlive = setInterval(() => undefined, 60_000);
  await runtime.startWorker();
  console.log(`AgentHub runtime worker started in ${config.runtimeWorkerMode} mode`);

  const shutdown = async () => {
    clearInterval(keepAlive);
    await app.close();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}

void bootstrap();
