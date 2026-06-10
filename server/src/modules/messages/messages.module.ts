import { Module } from "@nestjs/common";
import { ConversationsModule } from "../conversations/conversations.module.js";
import { RealtimeModule } from "../realtime/realtime.module.js";
import { RuntimeModule } from "../runtime/runtime.module.js";
import { WorkspacesModule } from "../workspaces/workspaces.module.js";
import { MessagesController } from "./messages.controller.js";
import { MessagesService } from "./messages.service.js";

@Module({
  imports: [ConversationsModule, RealtimeModule, RuntimeModule, WorkspacesModule],
  controllers: [MessagesController],
  providers: [MessagesService],
  exports: [MessagesService]
})
export class MessagesModule {}
