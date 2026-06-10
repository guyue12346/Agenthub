import { Body, Controller, Get, Inject, Param, Patch, Post } from "@nestjs/common";
import type { AgentHubUser } from "@agenthub/shared";
import { CurrentUser } from "../../common/auth.decorators.js";
import { parseBody } from "../../common/validation.js";
import { UsersService } from "./users.service.js";
import { z } from "zod";

const addFriendSchema = z.object({
  targetPublicId: z.string().trim().min(3).max(64)
});

const updateProfileSchema = z.object({
  avatar: z.string().trim().min(1).max(800_000).optional()
});

@Controller("users")
export class UsersController {
  constructor(@Inject(UsersService) private readonly users: UsersService) {}

  @Get()
  async list(@CurrentUser() currentUser: AgentHubUser) {
    return { users: await this.users.listVisibleUsers(currentUser) };
  }

  @Get("me/friends")
  async friends(@CurrentUser() currentUser: AgentHubUser) {
    return { friends: await this.users.listFriends(currentUser.id) };
  }

  @Get(":userId")
  async detail(@CurrentUser() currentUser: AgentHubUser, @Param("userId") userId: string) {
    return { user: await this.users.findVisibleById(currentUser, userId) };
  }

  @Post("me/friends")
  async addFriend(@CurrentUser() currentUser: AgentHubUser, @Body() body: unknown) {
    const input = parseBody(addFriendSchema, body);
    return this.users.addFriendByPublicId(currentUser.id, input.targetPublicId);
  }

  @Patch("me/profile")
  async updateProfile(@CurrentUser() currentUser: AgentHubUser, @Body() body: unknown) {
    const input = parseBody(updateProfileSchema, body);
    return { user: await this.users.updateProfile(currentUser.id, input) };
  }
}
