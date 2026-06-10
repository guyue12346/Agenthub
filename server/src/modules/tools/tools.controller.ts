import { Body, Controller, Delete, Get, Inject, Param, Post, Query } from "@nestjs/common";
import type { AgentHubUser } from "@agenthub/shared";
import { z } from "zod";
import { CurrentUser } from "../../common/auth.decorators.js";
import { parseBody, parseQuery } from "../../common/validation.js";
import { executableRuntimeToolIds } from "./tool-registry.js";
import { ToolsService } from "./tools.service.js";

const toolsQuerySchema = z.object({
  scope: z.enum(["personal", "public"]).optional()
});

const jsonObjectSchema = z.record(z.string(), z.unknown());

const createPersonalToolSchema = z.object({
  runtimeType: z.enum(["builtin_alias", "function"]).default("builtin_alias"),
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().min(1).max(600),
  runtimeToolId: z.enum(executableRuntimeToolIds).optional(),
  category: z.string().trim().min(1).max(40).optional(),
  risk: z.enum(["read", "write", "external"]).optional(),
  inputSchema: jsonObjectSchema.optional(),
  outputSchema: jsonObjectSchema.optional(),
  permissionScopes: z.array(z.string().trim().min(1).max(80)).max(30).optional(),
  availableToAgentTypes: z.array(z.string().trim().min(1).max(40)).max(12).optional(),
  functionSource: z.string().trim().min(1).max(20_000).optional(),
  functionLanguage: z.literal("javascript").default("javascript"),
  functionTimeoutMs: z.coerce.number().int().min(50).max(2_000).default(800),
  functionMemoryMb: z.coerce.number().int().min(4).max(32).default(16),
  functionOutputBytes: z.coerce.number().int().min(1_024).max(128_000).default(32_000)
}).superRefine((value, ctx) => {
  if (value.runtimeType === "builtin_alias" && !value.runtimeToolId) {
    ctx.addIssue({ code: "custom", path: ["runtimeToolId"], message: "builtin_alias 工具必须选择 runtimeToolId" });
  }
  if (value.runtimeType === "function" && !value.functionSource?.trim()) {
    ctx.addIssue({ code: "custom", path: ["functionSource"], message: "function 工具必须提供函数源码" });
  }
});

@Controller("tools")
export class ToolsController {
  constructor(@Inject(ToolsService) private readonly tools: ToolsService) {}

  @Get()
  async list(@CurrentUser() currentUser: AgentHubUser, @Query() query?: unknown) {
    const input = parseQuery(toolsQuerySchema, query ?? {});
    return { tools: await this.tools.listTools(currentUser, input.scope) };
  }

  @Post("personal")
  async createPersonal(@CurrentUser() currentUser: AgentHubUser, @Body() body: unknown) {
    const input = parseBody(createPersonalToolSchema, body);
    return { tool: await this.tools.createPersonalTool(currentUser, input) };
  }

  @Delete(":id")
  async delete(@CurrentUser() currentUser: AgentHubUser, @Param("id") id: string) {
    return this.tools.deleteTool(currentUser, id);
  }
}
