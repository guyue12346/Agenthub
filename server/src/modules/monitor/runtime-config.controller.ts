import { Body, Controller, Delete, Get, Inject, Param, Post, Put } from "@nestjs/common";
import type { AgentHubUser } from "@agenthub/shared";
import { CurrentUser, Roles } from "../../common/auth.decorators.js";
import { RuntimeConfigService, runtimeConfigSwitchSchema, runtimeConfigTestSchema, runtimeConfigUpdateSchema } from "../../common/runtime-config.service.js";
import { parseBody } from "../../common/validation.js";

@Roles("admin")
@Controller("admin/runtime-config")
export class RuntimeConfigController {
  constructor(@Inject(RuntimeConfigService) private readonly runtimeConfig: RuntimeConfigService) {}

  @Get()
  async getConfig() {
    return this.runtimeConfig.getAdminPayload();
  }

  @Put()
  async updateConfig(@CurrentUser() currentUser: AgentHubUser, @Body() body: unknown) {
    const input = parseBody(runtimeConfigUpdateSchema, body);
    return { config: await this.runtimeConfig.updateAdminConfig(currentUser.id, input) };
  }

  @Post("test")
  async testConfig(@CurrentUser() currentUser: AgentHubUser, @Body() body: unknown) {
    const input = parseBody(runtimeConfigTestSchema, body);
    return { result: await this.runtimeConfig.testRuntimeConfig(currentUser.id, input) };
  }

  @Post("switch")
  async switchConfig(@CurrentUser() currentUser: AgentHubUser, @Body() body: unknown) {
    const input = parseBody(runtimeConfigSwitchSchema, body);
    return this.runtimeConfig.switchAdminConfig(currentUser.id, input.id, input.scope);
  }

  @Delete(":id")
  async deleteConfig(@CurrentUser() currentUser: AgentHubUser, @Param("id") id: string) {
    const input = parseBody(runtimeConfigSwitchSchema, { id });
    return this.runtimeConfig.deleteAdminConfig(currentUser.id, input.id);
  }
}
