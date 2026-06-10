import "reflect-metadata";
import cors from "@fastify/cors";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { ConfigService } from "./common/config.service.js";
import { AppModule } from "./modules/app.module.js";
import { RealtimeService } from "./modules/realtime/realtime.service.js";
import { RuntimeService } from "./modules/runtime/runtime.service.js";

process.env.AGENTHUB_RUNTIME_WORKER_MODE ??= "inline";

async function bootstrap() {
  const config = new ConfigService();
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({
      logger: true,
      bodyLimit: config.httpBodyLimitBytes
    })
  );
  const webOrigins = new Set(config.webOrigins);
  await app.register(cors, {
    origin: (origin, callback) => {
      if (!origin) {
        callback(null, true);
        return;
      }
      callback(null, webOrigins.has(origin) ? origin : false);
    },
    credentials: true
  });
  app.setGlobalPrefix("api");
  app.get(RealtimeService).attach(app.getHttpServer());
  if (config.shouldRunRuntimeWorker) {
    await app.get(RuntimeService, { strict: false }).startWorker();
  }
  await app.listen(config.port, "0.0.0.0");
  console.log(`AgentHub API listening on http://127.0.0.1:${config.port}`);
}

void bootstrap();
