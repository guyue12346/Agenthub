import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Query } from "@nestjs/common";
import type { AgentHubUser } from "@agenthub/shared";
import { z } from "zod";
import { CurrentUser } from "../../common/auth.decorators.js";
import { cuidLikeSchema, parseBody, parseQuery } from "../../common/validation.js";
import { HUB_LOGO_COLORS, HUB_LOGO_KEYS } from "../../common/hub-appearance.js";
import { KnowledgeService } from "./knowledge.service.js";

const createKnowledgeSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().default(""),
  preset: z.enum(["standard", "precise", "broad"]).default("standard"),
  visibility: z.enum(["private", "public"]).default("private"),
  logo: z.enum(HUB_LOGO_KEYS).default("book"),
  logoColor: z.enum(HUB_LOGO_COLORS).default("#2563eb")
});

const updateKnowledgeSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().optional(),
  preset: z.enum(["standard", "precise", "broad"]).optional(),
  visibility: z.enum(["private", "public"]).optional(),
  logo: z.enum(HUB_LOGO_KEYS).optional(),
  logoColor: z.enum(HUB_LOGO_COLORS).optional()
});

const indexDocumentSchema = z.object({
  name: z.string().trim().min(1).max(240).optional(),
  path: z.string().trim().min(1).max(1000).optional(),
  title: z.string().trim().min(1).max(240).optional(),
  content: z.string().min(1).max(2_000_000).optional(),
  contentBase64: z.string().min(1).max(8_000_000).optional(),
  mimeType: z.string().trim().min(1).max(160).optional(),
  sourceAssetVersion: z.number().int().positive().default(1)
}).refine((value) => Boolean(value.content || value.contentBase64), {
  message: "content 或 contentBase64 至少提供一个"
}).refine((value) => Boolean(value.name || value.path || value.title), {
  message: "name、path 或 title 至少提供一个"
});

const searchSchema = z.object({
  query: z.string().min(1),
  topK: z.number().int().positive().max(20).optional(),
  scoreThreshold: z.number().min(0).max(1).optional()
});

const listQuerySchema = z.object({
  filter: z.enum(["all", "mine", "public"]).default("all")
});

const idParamSchema = z.object({ id: cuidLikeSchema });

@Controller("knowledge")
export class KnowledgeController {
  constructor(@Inject(KnowledgeService) private readonly knowledge: KnowledgeService) {}

  /** GET /knowledge — 列出知识库 */
  @Get()
  async list(@CurrentUser() currentUser: AgentHubUser, @Query() query: unknown) {
    const { filter } = parseQuery(listQuerySchema, query);
    return { items: await this.knowledge.list(currentUser, filter) };
  }

  /** GET /knowledge/presets — 查看所有预设配置 */
  @Get("presets")
  async presets() {
    const { KNOWLEDGE_PRESETS } = await import("./knowledge.service.js");
    return { presets: KNOWLEDGE_PRESETS };
  }

  /** GET /knowledge/subscriptions — 我订阅的知识库 */
  @Get("subscriptions")
  async subscriptions(@CurrentUser() currentUser: AgentHubUser) {
    return { items: await this.knowledge.listSubscriptions(currentUser) };
  }

  /** POST /knowledge — 创建知识库 */
  @Post()
  async create(@CurrentUser() currentUser: AgentHubUser, @Body() body: unknown) {
    const input = parseBody(createKnowledgeSchema, body);
    return this.knowledge.create(currentUser, input);
  }

  /** GET /knowledge/:id — 获取知识库详情 */
  @Get(":id")
  async get(@CurrentUser() currentUser: AgentHubUser, @Param("id") id: string) {
    const { id: knowledgeId } = parseBody(idParamSchema, { id });
    return this.knowledge.get(currentUser, knowledgeId);
  }

  /** PATCH /knowledge/:id — 更新知识库元信息 */
  @Patch(":id")
  async update(@CurrentUser() currentUser: AgentHubUser, @Param("id") id: string, @Body() body: unknown) {
    const { id: knowledgeId } = parseBody(idParamSchema, { id });
    const input = parseBody(updateKnowledgeSchema, body);
    return this.knowledge.update(currentUser, knowledgeId, input);
  }

  /** DELETE /knowledge/:id — 删除知识库 */
  @Delete(":id")
  async delete(@CurrentUser() currentUser: AgentHubUser, @Param("id") id: string) {
    const { id: knowledgeId } = parseBody(idParamSchema, { id });
    await this.knowledge.delete(currentUser, knowledgeId);
    return { success: true };
  }

  /** POST /knowledge/:id/subscribe — 订阅公开知识库 */
  @Post(":id/subscribe")
  async subscribe(@CurrentUser() currentUser: AgentHubUser, @Param("id") id: string) {
    const { id: knowledgeId } = parseBody(idParamSchema, { id });
    return this.knowledge.subscribe(currentUser, knowledgeId);
  }

  /** DELETE /knowledge/:id/subscribe — 取消订阅 */
  @Delete(":id/subscribe")
  async unsubscribe(@CurrentUser() currentUser: AgentHubUser, @Param("id") id: string) {
    const { id: knowledgeId } = parseBody(idParamSchema, { id });
    return this.knowledge.unsubscribe(currentUser, knowledgeId);
  }

  /** POST /knowledge/:id/fork — Fork 公开知识库 */
  @Post(":id/fork")
  async fork(@CurrentUser() currentUser: AgentHubUser, @Param("id") id: string) {
    const { id: knowledgeId } = parseBody(idParamSchema, { id });
    return this.knowledge.fork(currentUser, knowledgeId);
  }

  /** GET /knowledge/:id/documents — 列出文档 */
  @Get(":id/documents")
  async listDocuments(@CurrentUser() currentUser: AgentHubUser, @Param("id") id: string) {
    const { id: knowledgeId } = parseBody(idParamSchema, { id });
    return { documents: await this.knowledge.listDocuments(currentUser, knowledgeId) };
  }

  /** POST /knowledge/:id/documents — 存储原始文件、提取文本并建立向量索引 */
  @Post(":id/documents")
  async indexDocument(@CurrentUser() currentUser: AgentHubUser, @Param("id") id: string, @Body() body: unknown) {
    const { id: knowledgeId } = parseBody(idParamSchema, { id });
    const input = parseBody(indexDocumentSchema, body);
    return this.knowledge.indexDocument(currentUser, knowledgeId, input);
  }

  /** DELETE /knowledge/:id/documents/:documentId — 删除文档 */
  @Delete(":id/documents/:documentId")
  async deleteDocument(
    @CurrentUser() currentUser: AgentHubUser,
    @Param("id") id: string,
    @Param("documentId") documentId: string
  ) {
    const { id: knowledgeId } = parseBody(idParamSchema, { id });
    const { id: docId } = parseBody(idParamSchema, { id: documentId });
    await this.knowledge.deleteDocument(currentUser, knowledgeId, docId);
    return { success: true };
  }

  /** POST /knowledge/:id/search — RAG 搜索 */
  @Post(":id/search")
  async search(@CurrentUser() currentUser: AgentHubUser, @Param("id") id: string, @Body() body: unknown) {
    const { id: knowledgeId } = parseBody(idParamSchema, { id });
    const input = parseBody(searchSchema, body);
    const results = await this.knowledge.search(currentUser, knowledgeId, input);
    return { results };
  }
}
