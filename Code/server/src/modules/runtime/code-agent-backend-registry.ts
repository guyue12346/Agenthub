import { Inject, Injectable, Optional } from "@nestjs/common";
import type { EffectiveRuntimeConfig } from "../../common/runtime-config.service.js";
import { ConfigService } from "../../common/config.service.js";
import { isCodexRuntimeConfigSupported, type CodeAgentTaskInput } from "./code-agent-adapter.service.js";
import type { CodeAgentBackend } from "./code-agent-backend.js";
import { CodexMcpBackend } from "./codex-mcp.backend.js";
import { OpenCodeServerBackend } from "./opencode-server.backend.js";

@Injectable()
export class CodeAgentBackendRegistry {
  constructor(
    @Inject(ConfigService) private readonly config: ConfigService,
    @Optional()
    @Inject(OpenCodeServerBackend)
    private readonly openCodeBackend?: CodeAgentBackend,
    @Optional()
    @Inject(CodexMcpBackend)
    private readonly codexBackend?: CodeAgentBackend
  ) {}

  resolve(requestedProvider: CodeAgentTaskInput["provider"], runtimeConfig: EffectiveRuntimeConfig): CodeAgentBackend | null {
    if (this.config.codeRunner.backendMode !== "protocol") return null;
    if (requestedProvider === "opencode") return this.openCodeBackend ?? null;
    if (this.config.codeRunner.codexMcpEnabled && isCodexRuntimeConfigSupported(runtimeConfig)) return this.codexBackend ?? null;
    return this.openCodeBackend ?? null;
  }
}
