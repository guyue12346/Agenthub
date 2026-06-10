import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { SessionAuthGuard } from "../common/session-auth.guard.js";
import { AgentsModule } from "./agents/agents.module.js";
import { AuthModule } from "./auth/auth.module.js";
import { ConversationsModule } from "./conversations/conversations.module.js";
import { DeploymentsModule } from "./deployments/deployments.module.js";
import { HealthModule } from "./health/health.module.js";
import { HubsModule } from "./hubs/hubs.module.js";
import { MessagesModule } from "./messages/messages.module.js";
import { MonitorModule } from "./monitor/monitor.module.js";
import { RealtimeModule } from "./realtime/realtime.module.js";
import { RuntimeModule } from "./runtime/runtime.module.js";
import { ToolsModule } from "./tools/tools.module.js";
import { UsersModule } from "./users/users.module.js";
import { WorkspacesModule } from "./workspaces/workspaces.module.js";
import { KnowledgeModule } from "./knowledge/knowledge.module.js";
import { DatabaseModule } from "../common/database.module.js";

@Module({
  imports: [
    DatabaseModule,
    AuthModule,
    HealthModule,
    RealtimeModule,
    UsersModule,
    AgentsModule,
    DeploymentsModule,
    ConversationsModule,
    MessagesModule,
    WorkspacesModule,
    HubsModule,
    ToolsModule,
    RuntimeModule,
    MonitorModule,
    KnowledgeModule
  ],
  providers: [{ provide: APP_GUARD, useClass: SessionAuthGuard }]
})
export class AppModule {}
