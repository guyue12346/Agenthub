import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { AgentHubUser, FriendConnection } from "@agenthub/shared";
import type { User } from "../../generated/prisma/client.js";
import { ObservabilityService } from "../../common/observability.service.js";
import { PrismaService } from "../../common/prisma.service.js";

@Injectable()
export class UsersService {
  constructor(
    @Inject(PrismaService)
    private readonly prisma: PrismaService,
    @Inject(ObservabilityService)
    private readonly observability: ObservabilityService
  ) {}

  async listUsers() {
    const users = await this.prisma.user.findMany({
      where: { deletedAt: null },
      orderBy: [{ role: "asc" }, { createdAt: "asc" }]
    });
    return users.map(toAgentHubUser);
  }

  async listVisibleUsers(currentUser: AgentHubUser) {
    if (currentUser.role === "admin") return this.listUsers();
    const friendIds = await this.visiblePeerIds(currentUser.id);
    const users = await this.prisma.user.findMany({
      where: { id: { in: [currentUser.id, ...friendIds] }, deletedAt: null },
      orderBy: [{ role: "asc" }, { createdAt: "asc" }]
    });
    return users.map(toAgentHubUser);
  }

  async findById(userId: string) {
    const user = await this.prisma.user.findFirst({ where: { id: userId, deletedAt: null } });
    if (!user) throw new NotFoundException(`User ${userId} not found`);
    return toAgentHubUser(user);
  }

  async findVisibleById(currentUser: AgentHubUser, userId: string) {
    if (currentUser.role === "admin" || currentUser.id === userId) return this.findById(userId);
    const friendIds = await this.visiblePeerIds(currentUser.id);
    if (!friendIds.includes(userId)) throw new NotFoundException("User not found");
    return this.findById(userId);
  }

  async listFriends(currentUserId: string) {
    const connections = await this.prisma.friendConnection.findMany({
      where: {
        status: "accepted",
        deletedAt: null,
        OR: [{ requesterId: currentUserId }, { addresseeId: currentUserId }]
      },
      orderBy: { updatedAt: "desc" }
    });
    const friendIds = connections.map((connection) =>
      connection.requesterId === currentUserId ? connection.addresseeId : connection.requesterId
    );
    const users = await this.prisma.user.findMany({ where: { id: { in: friendIds }, deletedAt: null } });
    const userById = new Map(users.map((user) => [user.id, toAgentHubUser(user)]));
    return connections.flatMap((connection) => {
      const user = userById.get(connection.requesterId === currentUserId ? connection.addresseeId : connection.requesterId);
      return user ? [{ connection: toFriendConnection(connection), user }] : [];
    });
  }

  async addFriend(currentUserId: string, targetUserId: string) {
    if (currentUserId === targetUserId) throw new BadRequestException("Cannot add yourself");
    const targetUser = await this.findById(targetUserId);
    const existing = await this.prisma.friendConnection.findFirst({
      where: {
        deletedAt: null,
        OR: [
          { requesterId: currentUserId, addresseeId: targetUserId },
          { requesterId: targetUserId, addresseeId: currentUserId }
        ]
      }
    });
    if (existing) return { connection: toFriendConnection(existing), user: targetUser };

    const connection = await this.prisma.friendConnection.create({
      data: {
        id: `friend-${currentUserId}-${targetUserId}`,
        requesterId: currentUserId,
        addresseeId: targetUserId,
        status: "accepted"
      }
    });
    await this.observability?.audit({
      actorUserId: currentUserId,
      action: "friend.add",
      targetType: "user",
      targetId: targetUserId,
      payload: { connectionId: connection.id }
    });
    return { connection: toFriendConnection(connection), user: targetUser };
  }

  async addFriendByPublicId(currentUserId: string, targetPublicId: string) {
    const targetUser = await this.prisma.user.findFirst({
      where: { publicId: targetPublicId.trim(), deletedAt: null }
    });
    if (!targetUser) throw new NotFoundException("User not found");
    return this.addFriend(currentUserId, targetUser.id);
  }

  async updateProfile(currentUserId: string, input: { avatar?: string | undefined }) {
    const avatar = input.avatar?.trim();
    if (avatar && !isAllowedAvatarValue(avatar)) {
      throw new BadRequestException("头像只支持内置路径、图片 URL、data:image 或 1-3 位头像标识");
    }
    const user = await this.prisma.user.update({
      where: { id: currentUserId },
      data: {
        ...(avatar ? { avatar } : {})
      }
    });
    await this.observability?.audit({
      actorUserId: currentUserId,
      action: "user.profile.update",
      targetType: "user",
      targetId: currentUserId,
      payload: { fields: Object.keys(input) }
    });
    return toAgentHubUser(user);
  }

  private async visiblePeerIds(currentUserId: string) {
    const connections = await this.prisma.friendConnection.findMany({
      where: {
        status: "accepted",
        deletedAt: null,
        OR: [{ requesterId: currentUserId }, { addresseeId: currentUserId }]
      },
      select: { requesterId: true, addresseeId: true }
    });
    return connections.map((connection) =>
      connection.requesterId === currentUserId ? connection.addresseeId : connection.requesterId
    );
  }

}

function isAllowedAvatarValue(value: string) {
  if (/^[A-Za-z0-9\u4e00-\u9fa5]{1,3}$/.test(value)) return true;
  if (value.startsWith("/")) return true;
  if (/^https?:\/\/\S+\.(png|jpe?g|webp|gif|svg)(\?\S*)?$/i.test(value)) return true;
  if (/^data:image\/(png|jpeg|jpg|webp|gif|svg\+xml);base64,[A-Za-z0-9+/=]+$/i.test(value)) return true;
  return false;
}

export function toAgentHubUser(user: User): AgentHubUser {
  return {
    id: user.id,
    publicId: user.publicId,
    name: user.name,
    avatar: user.avatar ?? user.name.slice(0, 2),
    role: user.role as AgentHubUser["role"]
  };
}

function toFriendConnection(connection: {
  id: string;
  requesterId: string;
  addresseeId: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}): FriendConnection {
  return {
    id: connection.id,
    requesterId: connection.requesterId,
    addresseeId: connection.addresseeId,
    status: connection.status as FriendConnection["status"],
    createdAt: connection.createdAt.toISOString(),
    updatedAt: connection.updatedAt.toISOString()
  };
}
