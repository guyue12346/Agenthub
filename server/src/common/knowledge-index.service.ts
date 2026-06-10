import { Inject, Injectable } from "@nestjs/common";
import { Prisma } from "../generated/prisma/client.js";
import { PrismaService } from "./prisma.service.js";
import { EmbeddingService } from "./embedding.service.js";
import { ChunkingService } from "./chunking.service.js";
import type { ChunkingConfig } from "./chunking.service.js";
import { ConfigService } from "./config.service.js";

export interface IndexDocumentInput {
  knowledgeAssetId: string;
  sourceAssetId: string;
  sourceAssetVersion: number;
  workspaceId: string;
  path: string;
  title: string;
  content: string;
  mimeType?: string;
  checksumSha256?: string;
  chunking?: ChunkingConfig;
}

export interface SearchKnowledgeInput {
  knowledgeAssetId: string;
  query: string;
  topK?: number;
  scoreThreshold?: number;
}

export interface SearchResult {
  chunkId: string;
  documentId: string;
  content: string;
  score: number;
  metadata: {
    path: string;
    title: string;
    chunkIndex: number;
  };
}

@Injectable()
export class KnowledgeIndexService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(EmbeddingService) private readonly embedding: EmbeddingService,
    @Inject(ChunkingService) private readonly chunking: ChunkingService,
    @Inject(ConfigService) private readonly config: ConfigService
  ) {}

  async indexDocument(input: IndexDocumentInput): Promise<{ documentId: string; chunkCount: number }> {
    const embeddingConfig = this.config.embedding;
    if (!embeddingConfig) {
      throw new Error("Embedding is not configured. Please set AGENTHUB_EMBEDDING_API_KEY.");
    }

    const document = await this.prisma.knowledgeDocument.upsert({
      where: {
        knowledgeAssetId_sourceAssetId_sourceAssetVersion: {
          knowledgeAssetId: input.knowledgeAssetId,
          sourceAssetId: input.sourceAssetId,
          sourceAssetVersion: input.sourceAssetVersion
        }
      },
      create: {
        knowledgeAssetId: input.knowledgeAssetId,
        sourceAssetId: input.sourceAssetId,
        sourceAssetVersion: input.sourceAssetVersion,
        workspaceId: input.workspaceId,
        path: input.path,
        title: input.title,
        mimeType: input.mimeType ?? null,
        checksumSha256: input.checksumSha256 ?? null,
        metadata: {} as Prisma.InputJsonValue
      },
      update: {
        title: input.title,
        path: input.path,
        workspaceId: input.workspaceId,
        mimeType: input.mimeType ?? null,
        checksumSha256: input.checksumSha256 ?? null,
        deletedAt: null,
        indexedAt: new Date()
      }
    });

    const chunks = this.chunking.chunkText(input.content, input.chunking);
    if (chunks.length === 0) {
      await this.prisma.knowledgeChunk.deleteMany({ where: { documentId: document.id } });
      return { documentId: document.id, chunkCount: 0 };
    }

    // 外部 Embedding 请求不能放在数据库事务内，否则慢请求会长期占用连接。
    const embeddings = await this.embedding.embedBatch(
      chunks.map((chunk) => chunk.content),
      embeddingConfig
    );

    await this.prisma.$transaction(async (tx) => {
      await tx.knowledgeChunk.deleteMany({ where: { documentId: document.id } });
      await tx.knowledgeChunk.createMany({
        data: chunks.map((chunk, index) => ({
          knowledgeAssetId: input.knowledgeAssetId,
          documentId: document.id,
          chunkIndex: chunk.chunkIndex,
          content: chunk.content,
          tokenEstimate: chunk.tokenEstimate,
          keywords: [] as Prisma.InputJsonValue,
          embedding: embeddings[index]?.embedding ?? [],
          embeddingModel: embeddingConfig.model,
          metadata: {} as Prisma.InputJsonValue
        }))
      });
    });

    return { documentId: document.id, chunkCount: chunks.length };
  }

  async search(input: SearchKnowledgeInput): Promise<SearchResult[]> {
    const embeddingConfig = this.config.embedding;
    if (!embeddingConfig) {
      throw new Error("Embedding is not configured. Please set AGENTHUB_EMBEDDING_API_KEY.");
    }

    // 生成查询向量
    const queryEmbedding = await this.embedding.embed(input.query, embeddingConfig);

    // 向量相似度搜索（使用 cosine 距离）
    const topK = input.topK ?? 5;
    const scoreThreshold = input.scoreThreshold ?? 0.7;

    const candidates = await this.prisma.knowledgeChunk.findMany({
      where: {
        knowledgeAssetId: input.knowledgeAssetId,
        deletedAt: null,
        embedding: { isEmpty: false }
      },
      select: {
        id: true,
        documentId: true,
        content: true,
        chunkIndex: true,
        embedding: true
      }
    });
    const results = candidates
      .map((candidate) => ({
        id: candidate.id,
        document_id: candidate.documentId,
        content: candidate.content,
        chunk_index: candidate.chunkIndex,
        score: cosineSimilarity(queryEmbedding.embedding, candidate.embedding)
      }))
      .filter((candidate) => candidate.score >= scoreThreshold)
      .sort((left, right) => right.score - left.score)
      .slice(0, topK);

    const documents = await this.prisma.knowledgeDocument.findMany({
      where: { id: { in: [...new Set(results.map((result) => result.document_id))] }, deletedAt: null },
      select: { id: true, path: true, title: true }
    });
    const documentsById = new Map(documents.map((document) => [document.id, document]));
    return results.flatMap((result) => {
      const document = documentsById.get(result.document_id);
      if (!document) return [];
      return [{
        chunkId: result.id,
        documentId: result.document_id,
        content: result.content,
        score: result.score,
        metadata: {
          path: document.path,
          title: document.title,
          chunkIndex: result.chunk_index
        }
      }];
    });
  }

  async deleteDocument(documentId: string): Promise<void> {
    const deletedAt = new Date();
    await this.prisma.$transaction([
      this.prisma.knowledgeChunk.updateMany({ where: { documentId, deletedAt: null }, data: { deletedAt } }),
      this.prisma.knowledgeDocument.update({ where: { id: documentId }, data: { deletedAt } })
    ]);
  }
}

function cosineSimilarity(left: number[], right: number[]) {
  if (left.length === 0 || left.length !== right.length) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftNorm += leftValue * leftValue;
    rightNorm += rightValue * rightValue;
  }
  if (leftNorm === 0 || rightNorm === 0) return 0;
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}
