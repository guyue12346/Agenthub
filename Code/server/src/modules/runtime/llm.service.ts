import { Inject, Injectable, Optional } from "@nestjs/common";
import { z } from "zod";
import { ConfigService } from "../../common/config.service.js";
import { ObservabilityService } from "../../common/observability.service.js";
import { RuntimeConfigService } from "../../common/runtime-config.service.js";

interface GenerateJsonInput {
  callerType: string;
  callerId: string;
  systemPrompt: string;
  userPrompt: string;
  schemaName: string;
  schema: z.ZodType;
  signal?: AbortSignal;
  modelOverride?: {
    model?: string;
    reasoningEffort?: string;
  };
}

const LLM_FETCH_TIMEOUT_MS = 240_000;

@Injectable()
export class LlmService {
  constructor(
    @Inject(ObservabilityService) private readonly observability: ObservabilityService,
    @Inject(RuntimeConfigService) private readonly runtimeConfig: RuntimeConfigService,
    @Optional()
    @Inject(ConfigService)
    private readonly config?: Pick<ConfigService, "llm">
  ) {}

  async generateJson<T>(input: GenerateJsonInput): Promise<T> {
    const config = applyModelOverride(await this.readLlmConfig(), input.modelOverride);
    const startedAt = Date.now();
    await this.observability.llmCall({
      provider: config.provider,
      model: config.model,
      callerType: input.callerType,
      callerId: input.callerId,
      promptRef: input.schemaName,
      status: "started"
    });
    try {
      let currentUserPrompt = input.userPrompt;
      let lastError: unknown;
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        const attemptInput = { ...input, userPrompt: currentUserPrompt };
        const rawText = config.wireApi === "chat_completions"
          ? await callChatCompletions(config, attemptInput)
          : await callResponses(config, attemptInput);
        try {
          const parsedJson = parseJsonText(rawText);
          const parsed = input.schema.parse(parsedJson) as T;
          await this.observability.llmCall({
            provider: config.provider,
            model: config.model,
            callerType: input.callerType,
            callerId: input.callerId,
            promptRef: input.schemaName,
            responseRef: attempt === 1 ? "json" : "json_retry",
            latencyMs: Date.now() - startedAt,
            status: "completed"
          });
          return parsed;
        } catch (error) {
          lastError = error;
          if (attempt >= 2) break;
          currentUserPrompt = buildRetryPrompt(input.userPrompt, rawText, error);
        }
      }
      throw lastError;
    } catch (error) {
      await this.observability.llmCall({
        provider: config.provider,
        model: config.model,
        callerType: input.callerType,
        callerId: input.callerId,
        promptRef: input.schemaName,
        latencyMs: Date.now() - startedAt,
        status: "failed",
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  private async readLlmConfig(): Promise<LlmConfig> {
    const llm = await this.runtimeConfig.getEffectiveConfig("chat");
    if (!llm.apiKey) throw new Error("Runtime LLM API Key is required. Configure it in admin runtime settings or AGENTHUB_LLM_API_KEY.");
    return {
      provider: llm.provider,
      baseUrl: llm.baseUrl,
      apiKey: llm.apiKey,
      model: llm.model,
      reasoningEffort: llm.reasoningEffort,
      wireApi: llm.wireApi
    };
  }
}

interface LlmConfig {
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  reasoningEffort: string;
  wireApi: "responses" | "chat_completions";
}

function applyModelOverride(config: LlmConfig, override: GenerateJsonInput["modelOverride"] | undefined): LlmConfig {
  if (!override) return config;
  const model = normalizeRuntimeOverride(override.model);
  const reasoningEffort = normalizeRuntimeOverride(override.reasoningEffort);
  return {
    ...config,
    ...(model ? { model } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {})
  };
}

function normalizeRuntimeOverride(value: unknown) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed === "runtime_default") return undefined;
  return trimmed;
}

async function callResponses(config: LlmConfig, input: GenerateJsonInput) {
  const { response, payload } = await fetchTransportPayload(config, `${config.baseUrl}/responses`, {
    method: "POST",
    ...(input.signal ? { signal: input.signal } : {}),
    headers: {
      authorization: `Bearer ${config.apiKey}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: config.model,
      stream: false,
      reasoning: { effort: config.reasoningEffort },
      text: { format: { type: "json_object" } },
      input: [
        { role: "system", content: [{ type: "input_text", text: withJsonOnlyInstruction(input.systemPrompt) }] },
        { role: "user", content: [{ type: "input_text", text: input.userPrompt }] }
      ]
    })
  });
  if (!response.ok) throw new Error(`LLM responses call failed: ${formatPayloadForError(payload)}`);
  if (payload.kind === "sse") {
    if (payload.text) return payload.text;
    return isRecord(payload.finalJson) ? extractResponseText(payload.finalJson) : "";
  }
  return isRecord(payload.json) ? extractResponseText(payload.json) : "";
}

async function callChatCompletions(config: LlmConfig, input: GenerateJsonInput) {
  const { response, payload } = await fetchTransportPayload(config, `${config.baseUrl}/chat/completions`, {
    method: "POST",
    ...(input.signal ? { signal: input.signal } : {}),
    headers: {
      authorization: `Bearer ${config.apiKey}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: config.model,
      stream: false,
      ...chatCompletionReasoningOptions(config),
      messages: [
        { role: "system", content: withJsonOnlyInstruction(input.systemPrompt) },
        { role: "user", content: input.userPrompt }
      ]
    })
  });
  if (!response.ok) throw new Error(`LLM chat completion failed: ${formatPayloadForError(payload)}`);
  if (payload.kind === "sse") {
    if (payload.text) return payload.text;
    return isRecord(payload.finalJson) ? extractChatCompletionText(payload.finalJson) : "";
  }
  return isRecord(payload.json) ? extractChatCompletionText(payload.json) : "";
}

type TransportPayload =
  | { kind: "json"; json: unknown }
  | { kind: "sse"; text: string; finalJson?: unknown; frames: unknown[]; rawText: string };

async function fetchTransportPayload(_config: LlmConfig, url: string, init: RequestInit) {
  const timeout = createTimeoutSignal(init.signal, LLM_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...init, signal: timeout.signal });
    const payload = await readTransportPayload(response);
    return { response, payload };
  } catch (error) {
    if (timeout.timedOut()) throw new Error(`LLM request timed out after ${Math.round(LLM_FETCH_TIMEOUT_MS / 1000)}s`);
    throw error;
  } finally {
    timeout.cleanup();
  }
}

function createTimeoutSignal(parent: AbortSignal | null | undefined, timeoutMs: number) {
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort(parent?.reason);
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(`Timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  if (parent?.aborted) {
    onAbort();
  } else {
    parent?.addEventListener("abort", onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    cleanup: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onAbort);
    }
  };
}

async function readTransportPayload(response: Response): Promise<TransportPayload> {
  const text = await response.text();
  return parseTransportPayload(text);
}

function parseTransportPayload(text: string): TransportPayload {
  const trimmed = text.trim();
  if (trimmed) {
    try {
      return { kind: "json", json: JSON.parse(trimmed) };
    } catch {
      // Fall through to SSE parsing. Some compatible providers return text/event-stream
      // even when the request explicitly asks for a non-streaming response.
    }
  }
  const frames = parseSseFrames(text);
  if (frames.length > 0) {
    const collapsed = collapseSseFrames(frames);
    return {
      kind: "sse",
      text: collapsed.text,
      finalJson: collapsed.finalJson,
      frames,
      rawText: text
    };
  }
  return { kind: "sse", text: "", frames: [], rawText: text };
}

function parseSseFrames(text: string) {
  const frames: unknown[] = [];
  let dataLines: string[] = [];
  const flush = () => {
    if (dataLines.length === 0) return;
    const data = dataLines.join("\n").trim();
    dataLines = [];
    if (!data || data === "[DONE]") return;
    try {
      frames.push(JSON.parse(data));
    } catch {
      frames.push(data);
    }
  };
  for (const line of text.split(/\r?\n/)) {
    if (line === "") {
      flush();
      continue;
    }
    if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
  }
  flush();
  return frames;
}

function collapseSseFrames(frames: unknown[]) {
  const parts: string[] = [];
  let finalText = "";
  let finalJson: unknown;
  for (const frame of frames) {
    if (!isRecord(frame)) {
      if (typeof frame === "string") parts.push(frame);
      continue;
    }
    if (isRecord(frame.error)) finalJson = frame;
    if (typeof frame.output_text === "string") finalText = frame.output_text;
    if (typeof frame.delta === "string" && String(frame.type ?? "").includes(".delta")) parts.push(frame.delta);
    if (String(frame.type ?? "") === "response.output_text.done" && typeof frame.text === "string") finalText = frame.text;
    if (String(frame.type ?? "") === "response.completed" && isRecord(frame.response)) finalJson = frame.response;
    if (Array.isArray(frame.output)) finalJson = frame;
    const choices = frame.choices;
    if (!Array.isArray(choices)) continue;
    for (const choice of choices) {
      if (!isRecord(choice)) continue;
      const delta = choice.delta;
      const message = choice.message;
      if (isRecord(delta) && typeof delta.content === "string") parts.push(delta.content);
      if (isRecord(message) && typeof message.content === "string") finalText = message.content;
      if (typeof choice.text === "string") parts.push(choice.text);
    }
  }
  return { text: finalText || parts.join(""), finalJson };
}

function chatCompletionReasoningOptions(config: LlmConfig) {
  if (isMoonshotCompatibleProvider(config.provider)) return {};
  return { reasoning_effort: config.reasoningEffort };
}

function isMoonshotCompatibleProvider(provider: string) {
  return ["kimi", "moonshot", "moonshotai", "runapi"].includes(provider.trim().toLowerCase());
}

function extractChatCompletionText(json: Record<string, unknown>) {
  const choice = (json.choices as Array<{ message?: { content?: string } }> | undefined)?.[0];
  return choice?.message?.content ?? "";
}

function formatPayloadForError(payload: TransportPayload) {
  const value = payload.kind === "json" ? payload.json : payload.finalJson ?? payload.frames;
  if (value !== undefined && !(Array.isArray(value) && value.length === 0)) return JSON.stringify(value);
  if (payload.kind === "sse") return JSON.stringify({ raw: payload.rawText.slice(0, 1000) });
  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function extractResponseText(json: Record<string, unknown>) {
  if (typeof json.output_text === "string") return json.output_text;
  const output = json.output;
  if (!Array.isArray(output)) return "";
  const parts: string[] = [];
  for (const item of output) {
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      const text = (part as { text?: unknown }).text;
      if (typeof text === "string") parts.push(text);
    }
  }
  return parts.join("\n");
}

function parseJsonText(text: string) {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("LLM returned empty response");
  try {
    return JSON.parse(trimmed);
  } catch {
    const match = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (match?.[1]) return JSON.parse(match[1].trim());
    const firstBrace = trimmed.indexOf("{");
    const lastBrace = trimmed.lastIndexOf("}");
    if (firstBrace >= 0 && lastBrace > firstBrace) return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
    throw new Error("LLM response is not valid JSON");
  }
}

function withJsonOnlyInstruction(systemPrompt: string) {
  return [
    systemPrompt,
    "",
    "输出格式要求：只返回一个 JSON object，不要使用 Markdown，不要包裹代码块，不要输出解释性文字。字段必须严格匹配本节点要求。"
  ].join("\n");
}

function buildRetryPrompt(originalUserPrompt: string, invalidResponse: string, error: unknown) {
  return JSON.stringify(
    {
      instruction: "上一次输出不是有效的结构化 JSON，必须修正后重新输出。只返回修正后的 JSON object。",
      validationError: error instanceof Error ? error.message : String(error),
      invalidResponse: invalidResponse.slice(0, 4000),
      originalUserPrompt
    },
    null,
    2
  );
}
