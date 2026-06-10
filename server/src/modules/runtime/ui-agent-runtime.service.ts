import { Inject, Injectable } from "@nestjs/common";
import { nanoid } from "nanoid";
import type { ChatMessage } from "@agenthub/shared";
import { Prisma, type Agent } from "../../generated/prisma/client.js";
import { PrismaService } from "../../common/prisma.service.js";
import { ContextManagerService } from "./context-manager.service.js";
import { ExcalidrawRenderService } from "./excalidraw-render.service.js";
import { LlmService } from "./llm.service.js";
import { MemoryManagerService } from "./memory-manager.service.js";
import { RealtimeService } from "../realtime/realtime.service.js";
import { ToolRuntimeService } from "./tool-runtime.service.js";
import { type RuntimeAgentCreatedAsset, type RuntimeAgentIdentity, type RuntimeAgentResult } from "./agent-runtime.service.js";
import { type UiAgentDesign, type UiAgentDesignCandidate, type UiAgentValidation, uiAgentDesignSchema, uiAgentValidationSchema } from "./ui-agent.schemas.js";

type UiAgentStepId = "wake" | "design" | "normalize" | "validate" | "revise" | "render" | "publish" | "memory";
type UiAgentStepStatus = "running" | "completed" | "failed";

interface UiAgentStepTrace {
  id: string;
  step: UiAgentStepId;
  status: UiAgentStepStatus;
  at: string;
  summary: string;
  candidateId?: string;
  attempt?: number;
  inputKeys?: string[];
  outputKeys?: string[];
  error?: string;
}

interface UiAgentCandidateResult {
  candidate: UiAgentDesignCandidate;
  validation: UiAgentValidation | undefined;
  attempts: number;
  passed: boolean;
  assets: RuntimeAgentCreatedAsset[];
}

@Injectable()
export class UiAgentRuntimeService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(LlmService) private readonly llm: LlmService,
    @Inject(ContextManagerService) private readonly contextManager: ContextManagerService,
    @Inject(MemoryManagerService) private readonly memoryManager: MemoryManagerService,
    @Inject(ToolRuntimeService) private readonly toolRuntime: ToolRuntimeService,
    @Inject(ExcalidrawRenderService) private readonly renderer: ExcalidrawRenderService,
    @Inject(RealtimeService) private readonly realtime: RealtimeService
  ) {}

  async runAssignment(input: {
    runId: string;
    conversationId: string;
    assignment: Record<string, unknown>;
    agent: RuntimeAgentIdentity;
    context: unknown;
    ownerUserId: string;
    signal?: AbortSignal;
    agentRunId?: string;
  }): Promise<RuntimeAgentResult> {
    const agentMemoryPack = await this.contextManager.buildAgentMemoryPack({
      conversationId: input.conversationId,
      agentId: input.agent.id,
      userId: input.ownerUserId
    });
    const uiContext = {
      ...(asRecord(input.context) ?? { assignmentContext: input.context }),
      assignmentAgent: {
        agentId: input.agent.id,
        ownerUserId: input.ownerUserId,
        ...agentMemoryPack
      }
    };
    const result = await this.runUiAgent({
      runId: input.runId,
      conversationId: input.conversationId,
      callerId: `${input.runId}:agent-ui`,
      task: input.assignment,
      context: uiContext,
      ownerUserId: input.ownerUserId,
      mode: "assignment",
      ...(input.agentRunId ? { agentRunId: input.agentRunId } : {}),
      ...(input.signal ? { signal: input.signal } : {})
    });
    await this.writeUiAgentMemory(input.conversationId, input.ownerUserId, result, "assignment");
    return result;
  }

  async runDirect(input: {
    conversationId: string;
    agent: Agent;
    userId: string;
    triggerMessage: ChatMessage;
  }): Promise<RuntimeAgentResult> {
    const context = await this.contextManager.buildDirectAgentContext({
      conversationId: input.conversationId,
      agentId: input.agent.id,
      userId: input.userId,
      triggerMessage: input.triggerMessage
    });
    const result = await this.runUiAgent({
      conversationId: input.conversationId,
      callerId: `direct:${input.agent.id}:${input.triggerMessage.id}`,
      task: {
        userMessage: extractMessageText(input.triggerMessage),
        mode: "direct_ui_agent_chat"
      },
      context,
      ownerUserId: input.userId,
      mode: "direct"
    });
    await this.writeUiAgentMemory(input.conversationId, input.userId, result, "direct");
    return result;
  }

  private async runUiAgent(input: {
    runId?: string;
    conversationId: string;
    callerId: string;
    task: unknown;
    context: unknown;
    ownerUserId: string;
    mode: "assignment" | "direct";
    signal?: AbortSignal;
    agentRunId?: string;
  }): Promise<RuntimeAgentResult> {
    const uiRunId = `ui-agent-run-${nanoid(10)}`;
    const trace = createUiAgentTraceRecorder({
      realtime: this.realtime,
      conversationId: input.conversationId,
      agentRunId: input.agentRunId,
      uiRunId
    });
    await trace.record("wake", "completed", "UI Agent 已接收任务和上下文。", {
      inputKeys: objectKeys(input.context),
      outputKeys: ["task", "context", "ownerUserId"]
    });
    const initialDesign = await trace.step("design", "生成初始 UI 设计候选。", {
      inputKeys: ["task", "context", "previousValidation", "attempt"],
      outputKeys: ["title", "summary", "screens", "variants"]
    }, () => this.design({
        callerId: `${input.callerId}:design:initial`,
        task: input.task,
        context: input.context,
        previousValidation: undefined,
        attempt: 1,
        ...(input.signal ? { signal: input.signal } : {})
      }));
    const initialCandidates = await trace.step("normalize", "规范化 LLM 输出为稳定候选列表。", {
      inputKeys: ["UiAgentDesign"],
      outputKeys: ["UiAgentDesignCandidate[]"]
    }, async () => normalizeDesignCandidates(initialDesign));
    if (initialCandidates.length === 0) throw new Error("UI Agent failed to produce design");
    const canCreateWorkspaceAssets = await this.hasConversationWorkspace(input.conversationId);

    if (input.mode === "direct" && !canCreateWorkspaceAssets) {
      const candidateResults = initialCandidates.map((candidate): UiAgentCandidateResult => ({
        candidate,
        validation: undefined,
        attempts: 1,
        passed: true,
        assets: []
      }));
      await trace.record("publish", "completed", "UI Agent 单聊已形成文本回复。", {
        outputKeys: ["publicMessage"]
      });
      await trace.record("memory", "completed", "UI Agent 单聊简报准备写入记忆。", {
        outputKeys: ["lastUiDesignSummary", "lastUiDesignCandidates"]
      });
      return {
        publicMessage: buildPublicMessage(candidateResults, []),
        resultSummary: candidateResults.map((result) => `${result.candidate.title}: ${result.candidate.summary}`).join("\n"),
        status: "completed",
        internalTraceRef: uiRunId,
        memoryPatch: {
          lastUiDesignRunId: uiRunId,
          lastUiDesignCandidates: candidateResults.map((result) => ({
            id: result.candidate.id,
            title: result.candidate.title,
            kind: result.candidate.kind,
            summary: result.candidate.summary,
            passed: result.passed,
            score: null,
            attempts: result.attempts,
            artifactPaths: []
          })),
          failedUiDesignCandidates: [],
          lastUiArtifactPaths: [],
          validationScore: null,
          uiAgentSteps: trace.steps,
          updatedAt: new Date().toISOString()
        },
        createdAssets: []
      };
    }

    const candidateResults: UiAgentCandidateResult[] = [];
    const createdAssets: RuntimeAgentCreatedAsset[] = [];

    for (let index = 0; index < initialCandidates.length; index += 1) {
      let candidate = initialCandidates[index]!;
      let validation: UiAgentValidation | undefined;
      let attempts = 0;
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        attempts = attempt;
        validation = await trace.step("validate", `校验候选项：${candidate.title}`, {
          ...optionalCandidateId(candidate),
          attempt,
          inputKeys: ["task", "context", "candidate", "attempt"],
          outputKeys: ["passed", "score", "findings", "revisionRequest"]
        }, () => this.validateDesign({
          callerId: `${input.callerId}:validate:${candidate.id ?? `candidate-${index + 1}`}:${attempt}`,
          task: input.task,
          context: input.context,
          design: candidate,
          attempt,
          ...(input.signal ? { signal: input.signal } : {})
        }));
        if (validation.passed || attempt >= 2) break;
        const revisedDesign = await trace.step("revise", `按校验意见返工候选项：${candidate.title}`, {
          ...optionalCandidateId(candidate),
          attempt: attempt + 1,
          inputKeys: ["task", "context", "previousValidation", "candidateFocus"],
          outputKeys: ["revisedCandidate"]
        }, () => this.design({
            callerId: `${input.callerId}:design:${candidate.id ?? `candidate-${index + 1}`}:retry:${attempt + 1}`,
            task: input.task,
            context: input.context,
            previousValidation: {
              targetCandidate: candidate,
              validation,
              instruction: "只重新生成这个未通过的候选项，不要重写其他已经通过或尚未校验的候选项。"
            },
            candidateFocus: candidate,
            attempt: attempt + 1,
            ...(input.signal ? { signal: input.signal } : {})
          }));
        candidate = pickRevisedCandidate(normalizeDesignCandidates(revisedDesign), candidate, index);
      }

      const candidateAssets: RuntimeAgentCreatedAsset[] = [];
      if (canCreateWorkspaceAssets) {
        const rendered = await trace.step("render", `导出候选项画布：${candidate.title}`, {
          ...optionalCandidateId(candidate),
          inputKeys: ["UiAgentDesignCandidate"],
          outputKeys: ["png", "svg", "excalidrawJson"]
        }, () => this.renderer.render(candidate));
        const basePath = `Doc/ui-agent/runs/${uiRunId}/${safePathSegment(candidate.id ?? candidate.title, `candidate-${index + 1}`)}`;
        candidateAssets.push(await this.storeAsset(input.conversationId, `${basePath}/sketch.png`, rendered.png, {
          kind: "image",
          mimeType: "image/png",
          summary: `${candidate.title} PNG 预览图`
        }));
        candidateAssets.push(await this.storeAsset(input.conversationId, `${basePath}/sketch.svg`, rendered.svg, {
          kind: "image",
          mimeType: "image/svg+xml",
          summary: `${candidate.title} SVG 矢量预览`
        }));
        candidateAssets.push(await this.storeAsset(input.conversationId, `${basePath}/sketch.excalidraw`, rendered.excalidrawJson, {
          kind: "file",
          mimeType: "application/vnd.excalidraw+json",
          summary: `${candidate.title} Excalidraw 源文件`
        }));
      } else {
        await trace.record("render", "completed", `当前是无工作空间单聊，跳过候选项画布导出：${candidate.title}`, {
          ...optionalCandidateId(candidate),
          inputKeys: ["UiAgentDesignCandidate"],
          outputKeys: ["inlinePublicMessage"]
        });
      }
      createdAssets.push(...candidateAssets);
      candidateResults.push({
        candidate,
        validation,
        attempts,
        passed: validation?.passed !== false,
        assets: candidateAssets
      });
    }

    const report = buildDesignReport(candidateResults, uiRunId);
    await trace.record("publish", "completed", "UI Agent 已形成群聊消息和产物引用。", {
      outputKeys: ["publicMessage", "createdAssets"]
    });
    if (canCreateWorkspaceAssets) {
      createdAssets.push(await this.storeAsset(input.conversationId, `Doc/ui-agent/runs/${uiRunId}/report.json`, JSON.stringify(report, null, 2), {
        kind: "log",
        mimeType: "application/json",
        summary: "UI Agent 运行报告"
      }));
    }
    await trace.record("memory", "completed", "UI Agent 运行简报准备写入记忆。", {
      outputKeys: ["lastUiDesignSummary", "lastUiArtifacts", "lastUiDesignCandidates"]
    });
    const allPassed = candidateResults.every((result) => result.passed);
    return {
      publicMessage: buildPublicMessage(candidateResults, createdAssets),
      resultSummary: candidateResults.map((result) => `${result.candidate.title}: ${result.candidate.summary}`).join("\n"),
      status: allPassed ? "completed" : "needs_clarification",
      internalTraceRef: uiRunId,
      memoryPatch: {
        lastUiDesignRunId: uiRunId,
        lastUiDesignCandidates: candidateResults.map((result) => ({
          id: result.candidate.id,
          title: result.candidate.title,
          kind: result.candidate.kind,
          summary: result.candidate.summary,
          passed: result.passed,
          score: result.validation?.score ?? null,
          attempts: result.attempts,
          artifactPaths: result.assets.map((asset) => asset.path)
        })),
        failedUiDesignCandidates: candidateResults
          .filter((result) => !result.passed)
          .map((result) => ({
            id: result.candidate.id,
            title: result.candidate.title,
            findings: result.validation?.findings ?? [],
            revisionRequest: result.validation?.revisionRequest ?? null
          })),
        lastUiArtifactPaths: createdAssets.map((asset) => asset.path),
        validationScore: Math.round(candidateResults.reduce((sum, result) => sum + (result.validation?.score ?? 0), 0) / Math.max(candidateResults.length, 1)),
        uiAgentSteps: trace.steps,
        updatedAt: new Date().toISOString()
      },
      createdAssets
    };
  }

  private async design(input: {
    callerId: string;
    task: unknown;
    context: unknown;
    previousValidation: unknown;
    candidateFocus?: UiAgentDesignCandidate | undefined;
    attempt: number;
    signal?: AbortSignal;
  }) {
    return this.llm.generateJson<UiAgentDesign>({
      callerType: "ui_agent_node",
      callerId: input.callerId,
      schemaName: "ui_agent_design",
      schema: uiAgentDesignSchema,
      systemPrompt: uiAgentDesignPrompt(),
      ...(input.signal ? { signal: input.signal } : {}),
      userPrompt: JSON.stringify({
        task: input.task,
        context: input.context,
        previousValidation: input.previousValidation,
        candidateFocus: input.candidateFocus,
        attempt: input.attempt
      }, null, 2)
    });
  }

  private async validateDesign(input: {
    callerId: string;
    task: unknown;
    context: unknown;
    design: UiAgentDesignCandidate;
    attempt: number;
    signal?: AbortSignal;
  }) {
    return this.llm.generateJson<UiAgentValidation>({
      callerType: "ui_agent_node",
      callerId: input.callerId,
      schemaName: "ui_agent_validate",
      schema: uiAgentValidationSchema,
      systemPrompt: uiAgentValidatePrompt(),
      ...(input.signal ? { signal: input.signal } : {}),
      userPrompt: JSON.stringify({
        task: input.task,
        context: input.context,
        candidate: input.design,
        attempt: input.attempt
      }, null, 2)
    });
  }

  private async storeAsset(
    conversationId: string,
    path: string,
    content: string | Buffer,
    options: { kind: "image" | "file" | "log"; mimeType: string; summary: string }
  ): Promise<RuntimeAgentCreatedAsset> {
    const asset = await this.toolRuntime.storeGeneratedAsset({
      conversationId,
      path,
      content,
      kind: options.kind,
      mimeType: options.mimeType,
      summary: options.summary,
      source: "ui-agent-runtime",
      callerType: "agent",
      callerId: "agent-ui"
    });
    return {
      assetId: asset.assetId,
      workspaceId: asset.workspaceId,
      name: asset.name,
      path: asset.path,
      mimeType: asset.mimeType,
      size: asset.size,
      summary: asset.summary
    };
  }

  private async hasConversationWorkspace(conversationId: string) {
    const conversation = await this.prisma.conversation.findFirst({
      where: { id: conversationId, deletedAt: null },
      select: { workspaceId: true }
    });
    return Boolean(conversation?.workspaceId);
  }

  private async writeUiAgentMemory(conversationId: string, ownerUserId: string, result: RuntimeAgentResult, mode: "assignment" | "direct") {
    if (mode === "direct") {
      await this.memoryManager.writeAgentMemory({
        agentId: "agent-ui",
        ownerUserId,
        scope: "personal_cross_conversation",
        memoryPatch: {
          lastUiDesignSummary: result.resultSummary,
          ...(result.memoryPatch ?? {})
        }
      });
    }
    await this.memoryManager.writeAgentMemory({
      agentId: "agent-ui",
      ownerUserId,
      conversationId,
      scope: mode === "direct" ? "personal_direct" : "conversation",
      memoryPatch: {
        lastUiDesignSummary: result.resultSummary,
        lastUiArtifacts: (result.createdAssets ?? []).map((asset) => ({
          assetId: asset.assetId,
          path: asset.path,
          mimeType: asset.mimeType
        })),
        updatedAt: new Date().toISOString()
      }
    });
  }
}

function uiAgentDesignPrompt() {
  return [
    "你是一名资深产品 UI 设计师，负责为软件项目生成可以落地的界面设计稿。",
    "你会收到项目上下文、用户任务、历史记忆、工作空间索引和可用 Agent/Tool 说明。",
    "你的任务是先完成 UI 设计表达，不写代码，不输出调试日志。",
    "设计需要面向真实应用，说明页面目标、布局结构、关键区域、交互方式、视觉风格和验收标准。",
    "如果任务需要比较或拆分，你可以一次输出多个候选项，放入 variants。variants 中每一项代表一个设计方案或一个实现形态。",
    "如果输入里包含 candidateFocus 和 previousValidation，说明这是某个未通过候选项的返工轮次。你只需要重写这个候选项，保持 id 和 kind 稳定，不要重新生成整批候选项。",
    "screens[].sections、screens[].interactions、targetUsers、designGoals、acceptanceCriteria、risks、visualStyle.colors 必须是字符串数组，数组元素只能是自然语言短句，禁止输出对象、数组嵌套或结构化 JSON。",
    "如果 previousValidation 指出字段出现 [object Object]、序列化失败或结构化数据缺失，返工时必须把相关字段改成可直接展示的字符串短句。",
    "如果内容较长，documentMarkdown 字段可以给出适合写入 Doc/ 的设计说明正文。",
    "summary、documentMarkdown 和候选说明是用户可见内容，要像一个真实 UI 设计师在讲设计思路：清楚、具体、有一点人的判断感，但不要写营销文案或空泛口号。",
    "输出必须是 JSON。单候选可直接填 title、summary、targetUsers、designGoals、screens、visualStyle、acceptanceCriteria、risks、documentMarkdown；多候选必须填 variants，每个候选包含 id、kind、title、summary、screens、visualStyle、acceptanceCriteria、risks、documentMarkdown。"
  ].join("\n");
}

function createUiAgentTraceRecorder(input: {
  realtime: RealtimeService;
  conversationId: string;
  agentRunId?: string | undefined;
  uiRunId: string;
}) {
  const steps: UiAgentStepTrace[] = [];
  const emit = async (type: "agent_run.step.started" | "agent_run.step.completed" | "agent_run.step.failed", step: UiAgentStepTrace) => {
    await input.realtime.emit("conversation", input.conversationId, type, {
      agentId: "agent-ui",
      agentRunId: input.agentRunId ?? null,
      uiRunId: input.uiRunId,
      step
    });
    if (input.agentRunId) {
      await input.realtime.emit("agent_run", input.agentRunId, type, {
        agentId: "agent-ui",
        conversationId: input.conversationId,
        uiRunId: input.uiRunId,
        step
      });
    }
  };
  return {
    steps,
    async record(step: UiAgentStepId, status: UiAgentStepStatus, summary: string, meta: Partial<Omit<UiAgentStepTrace, "id" | "step" | "status" | "at" | "summary">> = {}) {
      const item: UiAgentStepTrace = {
        id: `ui-step-${nanoid(8)}`,
        step,
        status,
        at: new Date().toISOString(),
        summary,
        ...meta
      };
      steps.push(item);
      const type = status === "running"
        ? "agent_run.step.started"
        : status === "failed"
          ? "agent_run.step.failed"
          : "agent_run.step.completed";
      await emit(type, item).catch(() => undefined);
      return item;
    },
    async step<T>(step: UiAgentStepId, summary: string, meta: Partial<Omit<UiAgentStepTrace, "id" | "step" | "status" | "at" | "summary">>, run: () => Promise<T>) {
      await this.record(step, "running", summary, meta);
      try {
        const result = await run();
        await this.record(step, "completed", summary, meta);
        return result;
      } catch (error) {
        await this.record(step, "failed", summary, {
          ...meta,
          error: error instanceof Error ? error.message : String(error)
        });
        throw error;
      }
    }
  };
}

function objectKeys(value: unknown) {
  const record = asRecord(value);
  return record ? Object.keys(record) : [];
}

function optionalCandidateId(candidate: UiAgentDesignCandidate) {
  return candidate.id ? { candidateId: candidate.id } : {};
}

function uiAgentValidatePrompt() {
  return [
    "你是一名 UI 设计审阅者，负责检查一个候选设计或候选实现是否满足用户任务和项目上下文。",
    "每次输入只包含一个 candidate。你必须只校验当前 candidate，不要替其他候选项下结论。",
    "你只校验 UI 设计和实现表达，不写代码，不臆造已经生成的文件。",
    "如果 candidate 中出现 [object Object]、对象数组被当作文本、sections/interactions/colors 不可直接渲染，必须判定为不通过，并给出明确字段级修订要求。",
    "如果设计不满足要求，指出必须返工的具体原因和修订要求。",
    "publicMessage 是用户可见的审阅回复，要像设计负责人在群里给反馈：先说通过/不通过，再说明最关键的理由和下一步。",
    "输出必须是 JSON，字段包括 targetId、targetTitle、passed、score、findings、revisionRequest、publicMessage。"
  ].join("\n");
}

function buildPublicMessage(
  candidateResults: UiAgentCandidateResult[],
  assets: RuntimeAgentCreatedAsset[]
) {
  const passedCount = candidateResults.filter((result) => result.passed).length;
  const resultLines = candidateResults.map((result, index) => {
    const status = result.passed ? "通过" : "需返工";
    const score = result.validation?.score !== undefined ? `，${result.validation.score}/100` : "";
    const findings = result.validation?.findings?.slice(0, 2).join("；");
    const goals = result.candidate.designGoals?.slice(0, 3).map((item) => `- ${item}`).join("\n");
    const screens = result.candidate.screens?.slice(0, 2).map((screen) => {
      const sections = screen.sections?.slice(0, 4).map((item) => `  - ${item}`).join("\n");
      return `- ${screen.name}: ${screen.purpose}${sections ? `\n${sections}` : ""}`;
    }).join("\n");
    return [
      `${index + 1}. ${result.candidate.title}（${result.candidate.kind}）：${status}${score}${findings ? `。${findings}` : ""}`,
      result.candidate.summary,
      goals ? `设计目标：\n${goals}` : "",
      screens ? `页面结构：\n${screens}` : ""
    ].filter(Boolean).join("\n");
  }).join("\n");
  const paths = assets
    .filter((asset) => !asset.path.endsWith("/report.json"))
    .map((asset) => `- ${asset.path}`)
    .join("\n");
  const failed = candidateResults
    .filter((result) => !result.passed)
    .map((result) => `- ${result.candidate.title}: ${result.validation?.revisionRequest ?? "需要按审阅意见重新生成"}`)
    .join("\n");
  return [
    `UI Agent 已完成 ${candidateResults.length} 个候选项的设计与逐项审阅，${passedCount}/${candidateResults.length} 通过。`,
    "",
    resultLines,
    failed ? `\n需返工项：\n${failed}` : "",
    "",
    paths ? `已生成产物：\n${paths}` : "当前是 Agent 单聊，未生成工作空间产物；我已把设计建议直接放在消息里。"
  ].filter(Boolean).join("\n");
}

function buildDesignReport(candidateResults: UiAgentCandidateResult[], uiRunId: string) {
  return {
    uiRunId,
    candidates: candidateResults.map((result) => ({
      candidate: result.candidate,
      validation: result.validation,
      attempts: result.attempts,
      passed: result.passed,
      assets: result.assets
    })),
    generatedAt: new Date().toISOString()
  };
}

function extractMessageText(message: ChatMessage) {
  return message.blocks.map((block) => (block.type === "markdown" ? block.payload.text : block.type)).join("\n").trim();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function normalizeDesignCandidates(design: UiAgentDesign): UiAgentDesignCandidate[] {
  const designTargetUsers = stringArray(design.targetUsers);
  const designGoals = stringArray(design.designGoals);
  const designScreens = Array.isArray(design.screens) ? design.screens : [];
  const designAcceptanceCriteria = stringArray(design.acceptanceCriteria);
  const designRisks = stringArray(design.risks);
  const variants = Array.isArray(design.variants) && design.variants.length > 0
    ? design.variants
    : [{
        id: "candidate-01",
        kind: "design" as const,
        title: design.title,
        summary: design.summary,
        targetUsers: designTargetUsers,
        designGoals,
        screens: designScreens,
        visualStyle: design.visualStyle,
        acceptanceCriteria: designAcceptanceCriteria,
        risks: designRisks,
        documentMarkdown: design.documentMarkdown
      }];
  return variants.map((candidate, index) => ({
    ...candidate,
    id: candidate.id ?? `candidate-${String(index + 1).padStart(2, "0")}`,
    kind: candidate.kind ?? "design",
    targetUsers: stringArray(candidate.targetUsers).length > 0 ? stringArray(candidate.targetUsers) : designTargetUsers,
    designGoals: stringArray(candidate.designGoals).length > 0 ? stringArray(candidate.designGoals) : designGoals,
    screens: Array.isArray(candidate.screens) && candidate.screens.length > 0 ? candidate.screens : designScreens,
    visualStyle: candidate.visualStyle ?? design.visualStyle,
    acceptanceCriteria: stringArray(candidate.acceptanceCriteria).length > 0 ? stringArray(candidate.acceptanceCriteria) : designAcceptanceCriteria,
    risks: stringArray(candidate.risks).length > 0 ? stringArray(candidate.risks) : designRisks
  }));
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item)).filter(Boolean);
}

function pickRevisedCandidate(candidates: UiAgentDesignCandidate[], previous: UiAgentDesignCandidate, fallbackIndex: number) {
  const picked = candidates.find((candidate) => candidate.id === previous.id)
    ?? candidates.find((candidate) => candidate.title === previous.title)
    ?? candidates[0]
    ?? previous;
  return {
    ...picked,
    id: previous.id ?? picked.id ?? `candidate-${String(fallbackIndex + 1).padStart(2, "0")}`,
    kind: picked.kind ?? previous.kind
  };
}

function safePathSegment(value: string, fallback: string) {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || fallback;
}
