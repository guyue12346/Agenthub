import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { z } from "zod";
import { ConfigService } from "./config.service.js";
import { ObservabilityService } from "./observability.service.js";
import { PrismaService } from "./prisma.service.js";
import { decryptSecret, encryptSecret, isEncryptedSecret, isEncryptedWithCurrentKey } from "./secret-crypto.js";

export const runtimeConfigUpdateSchema = z.object({
  id: z.string().trim().min(1).max(80).optional(),
  name: z.string().trim().min(1).max(120).optional(),
  provider: z.string().trim().min(1).max(80).optional(),
  baseUrl: z.string().trim().url().max(300).optional(),
  apiKey: z.string().trim().max(4000).optional(),
  clearApiKey: z.boolean().optional(),
  model: z.string().trim().min(1).max(160).optional(),
  reasoningEffort: z.string().trim().min(1).max(64).optional(),
  wireApi: z.enum(["responses", "chat_completions"]).optional(),
  codexModel: z.string().trim().min(1).max(160).optional(),
  codexReasoningEffort: z.string().trim().min(1).max(64).optional(),
  openCodeModel: z.string().trim().min(1).max(180).optional(),
  openCodeReasoningEffort: z.string().trim().min(1).max(64).optional(),
  makeActiveFor: z.enum(["chat", "code", "both"]).optional(),
  makeActive: z.boolean().optional()
});
export const runtimeConfigTestSchema = runtimeConfigUpdateSchema.extend({
  target: z.enum(["api_key", "codex", "opencode"])
});
export const runtimeConfigSwitchSchema = z.object({
  id: z.string().trim().min(1).max(80),
  scope: z.enum(["chat", "code", "both"]).optional()
});

export type RuntimeConfigUpdateInput = z.infer<typeof runtimeConfigUpdateSchema>;
export type RuntimeConfigTestInput = z.infer<typeof runtimeConfigTestSchema>;
export type RuntimeWireApi = "responses" | "chat_completions";
export type RuntimeConfigScope = "chat" | "code";
export type RuntimeConfigActivationScope = RuntimeConfigScope | "both";

export interface EffectiveRuntimeConfig {
  provider: string;
  baseUrl: string;
  apiKey?: string | undefined;
  model: string;
  reasoningEffort: string;
  wireApi: RuntimeWireApi;
  codexModel: string;
  codexReasoningEffort: string;
  openCodeModel: string;
  openCodeReasoningEffort: string;
}

export interface RuntimeConfigAdminView extends Omit<EffectiveRuntimeConfig, "apiKey"> {
  id: string;
  name: string;
  isActive: boolean;
  isChatActive: boolean;
  isCodeActive: boolean;
  source: "database" | "environment";
  apiKeyConfigured: boolean;
  apiKeyLast4: string | null;
  apiKeySource: "database" | "environment" | "missing";
  updatedByUserId: string | null;
  updatedAt: string | null;
}

export interface RuntimeConfigProfileView {
  id: string;
  name: string;
  provider: string;
  baseUrl: string;
  model: string;
  reasoningEffort: string;
  wireApi: RuntimeWireApi;
  codexModel: string;
  codexReasoningEffort: string;
  openCodeModel: string;
  openCodeReasoningEffort: string;
  apiKeyConfigured: boolean;
  apiKeyLast4: string | null;
  apiKeySource: "database" | "environment" | "missing";
  isActive: boolean;
  isChatActive: boolean;
  isCodeActive: boolean;
  updatedAt: string | null;
}

export interface RuntimeConfigAdminPayload {
  config: RuntimeConfigAdminView;
  chatConfig: RuntimeConfigAdminView;
  codeConfig: RuntimeConfigAdminView;
  configs: RuntimeConfigProfileView[];
  activeConfigId: string;
  chatConfigId: string;
  codeConfigId: string;
}

export interface RuntimeConfigTestResult {
  target: RuntimeConfigTestInput["target"];
  ok: boolean;
  latencyMs: number;
  model: string;
  message: string;
}

const RUNTIME_CONFIG_ID = "default";
const RUNTIME_CONFIG_NAME = "默认配置";

interface RuntimeConfigRow {
  id: string;
  name: string;
  isActive: boolean;
  isChatActive: boolean;
  isCodeActive: boolean;
  provider: string;
  baseUrl: string;
  apiKeySecret: string | null;
  apiKeyLast4: string | null;
  model: string;
  reasoningEffort: string;
  wireApi: string;
  codexModel: string;
  codexReasoningEffort: string;
  openCodeModel: string;
  openCodeReasoningEffort: string;
  updatedByUserId: string | null;
  updatedAt: Date;
}

@Injectable()
export class RuntimeConfigService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ConfigService) private readonly config: ConfigService,
    @Inject(ObservabilityService) private readonly observability: ObservabilityService
  ) {}

  async getEffectiveConfig(scope: RuntimeConfigScope = "chat"): Promise<EffectiveRuntimeConfig> {
    const [row, fallback] = await Promise.all([this.getActiveConfigRow(scope), Promise.resolve(this.fromEnvironment())]);
    if (!row) return fallback;
    return this.toEffectiveConfig(row, fallback);
  }

  async getAdminPayload(): Promise<RuntimeConfigAdminPayload> {
    const [chatConfig, codeConfig, configs] = await Promise.all([
      this.getAdminView("chat"),
      this.getAdminView("code"),
      this.listAdminConfigs()
    ]);
    return {
      config: chatConfig,
      chatConfig,
      codeConfig,
      configs,
      activeConfigId: chatConfig.id,
      chatConfigId: chatConfig.id,
      codeConfigId: codeConfig.id
    };
  }

  async getAdminView(scope: RuntimeConfigScope = "chat"): Promise<RuntimeConfigAdminView> {
    const row = await this.getActiveConfigRow(scope);
    const effective = row ? await this.getEffectiveConfig(scope) : this.fromEnvironment();
    const envApiKey = nonEmpty(this.config.llm.apiKey);
    const dbApiKey = nonEmpty(decryptStoredSecret(row?.apiKeySecret, this.config));
    const envFallbackAvailable = !row || row.id === RUNTIME_CONFIG_ID;
    const apiKey = dbApiKey ?? (envFallbackAvailable ? envApiKey : undefined);
    const isChatActive = Boolean(row?.isChatActive || row?.isActive);
    const isCodeActive = Boolean(row?.isCodeActive || (!hasScopedActive(row) && row?.isActive));
    return {
      id: row?.id ?? RUNTIME_CONFIG_ID,
      name: row?.name ?? RUNTIME_CONFIG_NAME,
      isActive: scope === "code" ? isCodeActive : isChatActive,
      isChatActive,
      isCodeActive,
      source: row ? "database" : "environment",
      provider: effective.provider,
      baseUrl: effective.baseUrl,
      model: effective.model,
      reasoningEffort: effective.reasoningEffort,
      wireApi: effective.wireApi,
      codexModel: effective.codexModel,
      codexReasoningEffort: effective.codexReasoningEffort,
      openCodeModel: effective.openCodeModel,
      openCodeReasoningEffort: effective.openCodeReasoningEffort,
      apiKeyConfigured: Boolean(apiKey),
      apiKeyLast4: apiKey ? last4(apiKey) : null,
      apiKeySource: dbApiKey ? "database" : envFallbackAvailable && envApiKey ? "environment" : "missing",
      updatedByUserId: row?.updatedByUserId ?? null,
      updatedAt: row?.updatedAt?.toISOString() ?? null
    };
  }

  async listAdminConfigs(): Promise<RuntimeConfigProfileView[]> {
    const rows = await this.prisma.runtimeConfig.findMany({
      orderBy: [{ isChatActive: "desc" }, { isCodeActive: "desc" }, { isActive: "desc" }, { updatedAt: "desc" }]
    });
    const envApiKey = nonEmpty(this.config.llm.apiKey);
    return rows.map((row) => {
      const dbApiKey = nonEmpty(decryptStoredSecret(row.apiKeySecret, this.config));
      const envFallbackAvailable = row.id === RUNTIME_CONFIG_ID;
      const apiKey = dbApiKey ?? (envFallbackAvailable ? envApiKey : undefined);
      return {
        id: row.id,
        name: row.name,
        provider: row.provider,
        baseUrl: normalizeBaseUrl(row.baseUrl),
        model: row.model,
        reasoningEffort: row.reasoningEffort,
        wireApi: toWireApi(row.wireApi, this.fromEnvironment().wireApi),
        codexModel: row.codexModel,
        codexReasoningEffort: row.codexReasoningEffort,
        openCodeModel: row.openCodeModel,
        openCodeReasoningEffort: row.openCodeReasoningEffort,
        apiKeyConfigured: Boolean(apiKey),
        apiKeyLast4: apiKey ? last4(apiKey) : null,
        apiKeySource: dbApiKey ? "database" : envFallbackAvailable && envApiKey ? "environment" : "missing",
        isActive: Boolean(row.isChatActive || row.isActive),
        isChatActive: Boolean(row.isChatActive || row.isActive),
        isCodeActive: Boolean(row.isCodeActive || (!hasScopedActive(row) && row.isActive)),
        updatedAt: row.updatedAt.toISOString()
      };
    });
  }

  async updateAdminConfig(actorUserId: string, input: RuntimeConfigUpdateInput): Promise<RuntimeConfigAdminView> {
    const configId = input.id ?? RUNTIME_CONFIG_ID;
    const current = await this.prisma.runtimeConfig.findUnique({ where: { id: configId } });
    const fallback = this.fromEnvironment();
    const currentApiKey = decryptStoredSecret(current?.apiKeySecret, this.config);
    const nextApiKey = nonEmpty(input.apiKey);
    const apiKeyForLast4 = input.clearApiKey
      ? null
      : nextApiKey ?? currentApiKey ?? null;
    const retainedApiKeySecret = current?.apiKeySecret && currentApiKey && !isEncryptedWithCurrentKey(current.apiKeySecret, this.config)
      ? encryptSecret(currentApiKey, this.config)
      : current?.apiKeySecret ?? null;
    const apiKeySecret = input.clearApiKey
      ? null
      : nextApiKey
        ? encryptSecret(nextApiKey, this.config)
        : retainedApiKeySecret;
    const activationScope = normalizeActivationScope(input.makeActiveFor, input.makeActive);
    const [hasChatActive, hasCodeActive] = await Promise.all([
      this.hasActiveConfig("chat"),
      this.hasActiveConfig("code")
    ]);
    const currentChatActive = Boolean(current?.isChatActive || current?.isActive);
    const currentCodeActive = Boolean(current?.isCodeActive || (!hasScopedActive(current) && current?.isActive));
    const shouldMakeChatActive = activationScope
      ? activatesScope(activationScope, "chat") || currentChatActive
      : currentChatActive || !hasChatActive;
    const shouldMakeCodeActive = activationScope
      ? activatesScope(activationScope, "code") || currentCodeActive
      : currentCodeActive || !hasCodeActive;
    const saved = await this.prisma.runtimeConfig.upsert({
      where: { id: configId },
      create: {
        id: configId,
        name: input.name ?? configId,
        isActive: shouldMakeChatActive,
        isChatActive: shouldMakeChatActive,
        isCodeActive: shouldMakeCodeActive,
        provider: input.provider ?? fallback.provider,
        baseUrl: normalizeBaseUrl(input.baseUrl ?? fallback.baseUrl),
        apiKeySecret,
        apiKeyLast4: apiKeyForLast4 ? last4(apiKeyForLast4) : null,
        model: input.model ?? fallback.model,
        reasoningEffort: input.reasoningEffort ?? fallback.reasoningEffort,
        wireApi: input.wireApi ?? fallback.wireApi,
        codexModel: input.codexModel ?? fallback.codexModel,
        codexReasoningEffort: input.codexReasoningEffort ?? fallback.codexReasoningEffort,
        openCodeModel: input.openCodeModel ?? fallback.openCodeModel,
        openCodeReasoningEffort: input.openCodeReasoningEffort ?? fallback.openCodeReasoningEffort,
        updatedByUserId: actorUserId
      },
      update: {
        name: input.name ?? current?.name ?? configId,
        isActive: shouldMakeChatActive,
        isChatActive: shouldMakeChatActive,
        isCodeActive: shouldMakeCodeActive,
        provider: input.provider ?? current?.provider ?? fallback.provider,
        baseUrl: normalizeBaseUrl(input.baseUrl ?? current?.baseUrl ?? fallback.baseUrl),
        apiKeySecret,
        apiKeyLast4: apiKeyForLast4 ? last4(apiKeyForLast4) : null,
        model: input.model ?? current?.model ?? fallback.model,
        reasoningEffort: input.reasoningEffort ?? current?.reasoningEffort ?? fallback.reasoningEffort,
        wireApi: input.wireApi ?? current?.wireApi ?? fallback.wireApi,
        codexModel: input.codexModel ?? current?.codexModel ?? fallback.codexModel,
        codexReasoningEffort: input.codexReasoningEffort ?? current?.codexReasoningEffort ?? fallback.codexReasoningEffort,
        openCodeModel: input.openCodeModel ?? current?.openCodeModel ?? fallback.openCodeModel,
        openCodeReasoningEffort: input.openCodeReasoningEffort ?? current?.openCodeReasoningEffort ?? fallback.openCodeReasoningEffort,
        updatedByUserId: actorUserId
      }
    });
    if (shouldMakeChatActive) await this.deactivateOtherConfigs(saved.id, "chat");
    if (shouldMakeCodeActive) await this.deactivateOtherConfigs(saved.id, "code");
    await this.observability.audit({
      actorUserId,
      action: "runtime_config.update",
      targetType: "runtime_config",
      targetId: saved.id,
      payload: {
        provider: saved.provider,
        baseUrl: saved.baseUrl,
        model: saved.model,
        reasoningEffort: saved.reasoningEffort,
        wireApi: saved.wireApi,
        codexModel: saved.codexModel,
        codexReasoningEffort: saved.codexReasoningEffort,
        openCodeModel: saved.openCodeModel,
        openCodeReasoningEffort: saved.openCodeReasoningEffort,
        isChatActive: shouldMakeChatActive,
        isCodeActive: shouldMakeCodeActive,
        apiKeyConfigured: Boolean(apiKeyForLast4),
        apiKeyEncrypted: Boolean(saved.apiKeySecret && isEncryptedSecret(saved.apiKeySecret))
      }
    });
    await this.observability.system({
      level: "info",
      scope: "runtime-config",
      message: "Runtime model configuration updated.",
      payload: {
        updatedByUserId: actorUserId,
        provider: saved.provider,
        model: saved.model,
        codexModel: saved.codexModel,
        openCodeModel: saved.openCodeModel,
        isChatActive: shouldMakeChatActive,
        isCodeActive: shouldMakeCodeActive,
        apiKeyConfigured: Boolean(apiKeyForLast4),
        apiKeyEncrypted: Boolean(saved.apiKeySecret && isEncryptedSecret(saved.apiKeySecret))
      }
    });
    return this.getAdminView();
  }

  async switchAdminConfig(actorUserId: string, id: string, scope: RuntimeConfigActivationScope = "both"): Promise<RuntimeConfigAdminPayload> {
    const target = await this.prisma.runtimeConfig.findUnique({ where: { id } });
    if (!target) throw new Error(`Runtime config not found: ${id}`);
    const transaction = [
      ...(activatesScope(scope, "chat")
        ? [this.prisma.runtimeConfig.updateMany({
            where: { id: { not: id }, OR: [{ isChatActive: true }, { isActive: true }] },
            data: { isChatActive: false, isActive: false }
          })]
        : []),
      ...(activatesScope(scope, "code")
        ? [this.prisma.runtimeConfig.updateMany({ where: { isCodeActive: true, id: { not: id } }, data: { isCodeActive: false } })]
        : []),
      this.prisma.runtimeConfig.update({
        where: { id },
        data: {
          ...(activatesScope(scope, "chat") ? { isChatActive: true, isActive: true } : {}),
          ...(activatesScope(scope, "code") ? { isCodeActive: true } : {}),
          updatedByUserId: actorUserId
        }
      })
    ];
    await this.prisma.$transaction(transaction);
    await this.observability.audit({
      actorUserId,
      action: "runtime_config.switch",
      targetType: "runtime_config",
      targetId: id,
      payload: { provider: target.provider, model: target.model, scope }
    });
    await this.observability.system({
      level: "info",
      scope: "runtime-config",
      message: "Runtime model configuration switched.",
      payload: { updatedByUserId: actorUserId, id, provider: target.provider, model: target.model, scope }
    });
    return this.getAdminPayload();
  }

  async deleteAdminConfig(actorUserId: string, id: string): Promise<RuntimeConfigAdminPayload> {
    const target = await this.prisma.runtimeConfig.findUnique({ where: { id } });
    if (!target) throw new NotFoundException(`Runtime config not found: ${id}`);
    if (target.isActive || target.isChatActive || target.isCodeActive) {
      throw new BadRequestException("Cannot delete an active runtime config. Switch chat/code configs first.");
    }
    await this.prisma.runtimeConfig.delete({ where: { id } });
    await this.observability.audit({
      actorUserId,
      action: "runtime_config.delete",
      targetType: "runtime_config",
      targetId: id,
      payload: { provider: target.provider, model: target.model }
    });
    await this.observability.system({
      level: "info",
      scope: "runtime-config",
      message: "Runtime model configuration deleted.",
      payload: { updatedByUserId: actorUserId, id, provider: target.provider, model: target.model }
    });
    return this.getAdminPayload();
  }

  async testRuntimeConfig(actorUserId: string, input: RuntimeConfigTestInput): Promise<RuntimeConfigTestResult> {
    const fallback = this.fromEnvironment();
    const selectedRow = input.id ? await this.prisma.runtimeConfig.findUnique({ where: { id: input.id } }) : null;
    const defaultScope: RuntimeConfigScope = input.target === "api_key" ? "chat" : "code";
    const effective = selectedRow ? this.toEffectiveConfig(selectedRow, fallback) : await this.getEffectiveConfig(defaultScope);
    const testConfig = {
      provider: input.provider ?? effective.provider,
      baseUrl: normalizeBaseUrl(input.baseUrl ?? effective.baseUrl),
      apiKey: nonEmpty(input.apiKey) ?? effective.apiKey,
      model: input.target === "codex"
        ? input.codexModel ?? effective.codexModel
        : input.target === "opencode"
          ? toApiModelId(input.openCodeModel ?? effective.openCodeModel)
          : input.model ?? effective.model,
      reasoningEffort: input.target === "codex"
        ? input.codexReasoningEffort ?? effective.codexReasoningEffort
        : input.target === "opencode"
          ? input.openCodeReasoningEffort ?? effective.openCodeReasoningEffort
          : input.reasoningEffort ?? effective.reasoningEffort,
      wireApi: input.target === "codex" ? "responses" : input.wireApi ?? effective.wireApi
    };
    const startedAt = Date.now();
    let result: RuntimeConfigTestResult;
    try {
      const apiKey = testConfig.apiKey;
      if (!apiKey) throw new Error("API Key is not configured");
      if (input.target === "codex") {
        const incompatibleReason = codexProbeIncompatibilityReason(testConfig);
        if (incompatibleReason) throw new Error(incompatibleReason);
      }
      const message = await callRuntimeProbe({ ...testConfig, apiKey });
      result = {
        target: input.target,
        ok: true,
        latencyMs: Date.now() - startedAt,
        model: testConfig.model,
        message
      };
    } catch (error) {
      result = {
        target: input.target,
        ok: false,
        latencyMs: Date.now() - startedAt,
        model: testConfig.model,
        message: error instanceof Error ? error.message : String(error)
      };
    }
    await this.observability.audit({
      actorUserId,
      action: `runtime_config.test.${input.target}`,
      targetType: "runtime_config",
      targetId: selectedRow?.id ?? (await this.getAdminView(defaultScope)).id,
      payload: { ok: result.ok, model: result.model, latencyMs: result.latencyMs }
    });
    return result;
  }

  private async getActiveConfigRow(scope: RuntimeConfigScope): Promise<RuntimeConfigRow | null> {
    const scopedActive = await this.prisma.runtimeConfig.findFirst({
      where: scope === "code" ? { isCodeActive: true } : { isChatActive: true },
      orderBy: { updatedAt: "desc" }
    });
    if (scopedActive) return scopedActive;
    const legacyActive = await this.prisma.runtimeConfig.findFirst({ where: { isActive: true }, orderBy: { updatedAt: "desc" } });
    if (legacyActive) return legacyActive;
    return this.prisma.runtimeConfig.findUnique({ where: { id: RUNTIME_CONFIG_ID } });
  }

  private async hasActiveConfig(scope: RuntimeConfigScope) {
    const scopedActive = await this.prisma.runtimeConfig.findFirst({
      where: scope === "code" ? { isCodeActive: true } : { isChatActive: true },
      select: { id: true }
    });
    if (scopedActive) return true;
    const legacyActive = await this.prisma.runtimeConfig.findFirst({ where: { isActive: true }, select: { id: true } });
    return Boolean(legacyActive);
  }

  private async deactivateOtherConfigs(id: string, scope: RuntimeConfigScope) {
    if (scope === "chat") {
      await this.prisma.runtimeConfig.updateMany({
        where: { id: { not: id }, OR: [{ isChatActive: true }, { isActive: true }] },
        data: { isChatActive: false, isActive: false }
      });
      return;
    }
    await this.prisma.runtimeConfig.updateMany({
      where: { isCodeActive: true, id: { not: id } },
      data: { isCodeActive: false }
    });
  }

  private toEffectiveConfig(row: RuntimeConfigRow, fallback: EffectiveRuntimeConfig): EffectiveRuntimeConfig {
    const storedApiKey = decryptStoredSecret(row.apiKeySecret, this.config);
    const envFallbackAvailable = row.id === RUNTIME_CONFIG_ID;
    return {
      provider: row.provider || fallback.provider,
      baseUrl: normalizeBaseUrl(row.baseUrl || fallback.baseUrl),
      apiKey: nonEmpty(storedApiKey) ?? (envFallbackAvailable ? fallback.apiKey : undefined),
      model: row.model || fallback.model,
      reasoningEffort: row.reasoningEffort || fallback.reasoningEffort,
      wireApi: toWireApi(row.wireApi, fallback.wireApi),
      codexModel: row.codexModel || fallback.codexModel,
      codexReasoningEffort: row.codexReasoningEffort || fallback.codexReasoningEffort,
      openCodeModel: row.openCodeModel || fallback.openCodeModel,
      openCodeReasoningEffort: row.openCodeReasoningEffort || fallback.openCodeReasoningEffort
    };
  }

  private fromEnvironment(): EffectiveRuntimeConfig {
    const llm = this.config.llm;
    const runner = this.config.codeRunner;
    return {
      provider: llm.provider,
      baseUrl: normalizeBaseUrl(llm.baseUrl),
      apiKey: nonEmpty(llm.apiKey),
      model: llm.model,
      reasoningEffort: llm.reasoningEffort,
      wireApi: llm.wireApi,
      codexModel: runner.codexModel ?? llm.model,
      codexReasoningEffort: runner.codexReasoningEffort,
      openCodeModel: runner.openCodeModel ?? llm.model,
      openCodeReasoningEffort: runner.openCodeReasoningEffort
    };
  }
}

function decryptStoredSecret(value: string | null | undefined, config: ConfigService) {
  try {
    return decryptSecret(value, config);
  } catch (error) {
    throw new Error(`Stored runtime API key cannot be decrypted: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function normalizeBaseUrl(value: string) {
  return value.replace(/\/$/, "");
}

function nonEmpty(value: string | undefined | null) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function last4(value: string) {
  return value.slice(-4);
}

function toWireApi(value: string, fallback: RuntimeWireApi): RuntimeWireApi {
  return value === "chat_completions" || value === "responses" ? value : fallback;
}

function normalizeActivationScope(
  makeActiveFor: RuntimeConfigActivationScope | undefined,
  makeActive: boolean | undefined
): RuntimeConfigActivationScope | undefined {
  if (makeActiveFor) return makeActiveFor;
  return makeActive === true ? "both" : undefined;
}

function activatesScope(activation: RuntimeConfigActivationScope, scope: RuntimeConfigScope) {
  return activation === "both" || activation === scope;
}

function hasScopedActive(row: Pick<RuntimeConfigRow, "isChatActive" | "isCodeActive"> | null | undefined) {
  return Boolean(row?.isChatActive || row?.isCodeActive);
}

function toApiModelId(model: string) {
  const parts = model.split("/");
  return parts[parts.length - 1] || model;
}

async function callRuntimeProbe(config: {
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  reasoningEffort: string;
  wireApi: RuntimeWireApi;
}) {
  const response = config.wireApi === "chat_completions"
    ? await fetch(`${config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: config.model,
          ...chatCompletionReasoningOptions(config.provider, config.reasoningEffort),
          messages: [
            { role: "system", content: "Return a JSON object only." },
            { role: "user", content: "Return {\"ok\":true}." }
          ]
        })
      })
    : await fetch(`${config.baseUrl}/responses`, {
        method: "POST",
        headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: config.model,
          reasoning: { effort: config.reasoningEffort },
          text: { format: { type: "json_object" } },
          input: [
            { role: "system", content: [{ type: "input_text", text: "Return a JSON object only." }] },
            { role: "user", content: [{ type: "input_text", text: "Return {\"ok\":true}." }] }
          ]
        })
      });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Probe failed ${response.status}: ${JSON.stringify(json)}`);
  return "连接测试通过";
}

function chatCompletionReasoningOptions(provider: string, reasoningEffort: string) {
  if (isMoonshotCompatibleProvider(provider)) return {};
  return { reasoning_effort: reasoningEffort };
}

function isMoonshotCompatibleProvider(provider: string) {
  return ["kimi", "moonshot", "moonshotai", "runapi"].includes(provider.trim().toLowerCase());
}

function codexProbeIncompatibilityReason(config: { provider: string; baseUrl: string; wireApi: RuntimeWireApi }) {
  const provider = config.provider || "unknown";
  if (config.wireApi !== "responses") {
    return `Codex requires a Responses-compatible model API, but current provider ${provider} is configured for ${config.wireApi}. Use OpenCode for chat/completions models or switch Codex to a Responses-compatible provider.`;
  }
  if (isKnownChatCompletionsOnlyProvider(provider, config.baseUrl)) {
    return `Codex requires a Responses-compatible model API, but current provider ${provider} at ${config.baseUrl} is known to support chat/completions only. Use OpenCode for this provider or configure a Responses-compatible Codex provider.`;
  }
  return undefined;
}

function isKnownChatCompletionsOnlyProvider(provider: string, baseUrl: string) {
  const normalizedProvider = provider.trim().toLowerCase();
  if (["kimi", "moonshot", "moonshotai", "deepseek"].includes(normalizedProvider)) return true;
  const normalizedUrl = baseUrl.trim().toLowerCase();
  return normalizedUrl.includes("api.moonshot.cn") || normalizedUrl.includes("api.deepseek.com");
}
