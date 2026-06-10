import { BadGatewayException, HttpException, HttpStatus, Injectable } from "@nestjs/common";
import { GoogleGenerativeAI, TaskType } from "@google/generative-ai";
import { ConfigService } from "./config.service.js";

const GEMINI_BATCH_SIZE = 50;

export interface EmbeddingConfig {
  provider: "gemini";
  model: string;
  apiKey: string;
  dimension: number;
}

export interface EmbeddingResult {
  embedding: number[];
  model: string;
  dimension: number;
}

@Injectable()
export class EmbeddingService {
  private client: GoogleGenerativeAI | null = null;
  private clientApiKey: string | null = null;

  constructor(private readonly config: ConfigService) {}

  async embed(text: string, config?: EmbeddingConfig): Promise<EmbeddingResult> {
    const effectiveConfig = config ?? this.getDefaultConfig();

    if (effectiveConfig.provider === "gemini") {
      return this.embedWithGemini(text, effectiveConfig);
    }

    throw new Error(`Unsupported embedding provider: ${effectiveConfig.provider}`);
  }

  async embedBatch(texts: string[], config?: EmbeddingConfig): Promise<EmbeddingResult[]> {
    const effectiveConfig = config ?? this.getDefaultConfig();

    if (effectiveConfig.provider === "gemini") {
      return this.embedBatchWithGemini(texts, effectiveConfig);
    }

    throw new Error(`Unsupported embedding provider: ${effectiveConfig.provider}`);
  }

  private async embedWithGemini(text: string, config: EmbeddingConfig): Promise<EmbeddingResult> {
    const client = this.getOrCreateGeminiClient(config.apiKey);
    const model = client.getGenerativeModel({ model: config.model });
    try {
      const result = await model.embedContent({
        content: { role: "user", parts: [{ text }] },
        taskType: TaskType.RETRIEVAL_QUERY
      });
      return toEmbeddingResult(result.embedding.values, config.model);
    } catch (error) {
      throwEmbeddingProviderError(error);
    }
  }

  private async embedBatchWithGemini(texts: string[], config: EmbeddingConfig): Promise<EmbeddingResult[]> {
    const client = this.getOrCreateGeminiClient(config.apiKey);
    const model = client.getGenerativeModel({ model: config.model });
    const embeddings: EmbeddingResult[] = [];
    try {
      for (let offset = 0; offset < texts.length; offset += GEMINI_BATCH_SIZE) {
        const batch = texts.slice(offset, offset + GEMINI_BATCH_SIZE);
        const result = await model.batchEmbedContents({
          requests: batch.map((text) => ({
            content: { role: "user", parts: [{ text }] },
            taskType: TaskType.RETRIEVAL_DOCUMENT
          }))
        });
        embeddings.push(...result.embeddings.map((embedding) => toEmbeddingResult(embedding.values, config.model)));
      }
      return embeddings;
    } catch (error) {
      throwEmbeddingProviderError(error);
    }
  }

  private getOrCreateGeminiClient(apiKey: string): GoogleGenerativeAI {
    if (!this.client || this.clientApiKey !== apiKey) {
      this.client = new GoogleGenerativeAI(apiKey);
      this.clientApiKey = apiKey;
    }
    return this.client;
  }

  private getDefaultConfig(): EmbeddingConfig {
    const embeddingConfig = this.config.embedding;
    if (!embeddingConfig) {
      throw new Error("Embedding configuration is not set. Please configure embedding provider in settings.");
    }
    return embeddingConfig;
  }
}

function toEmbeddingResult(values: number[] | undefined, model: string): EmbeddingResult {
  if (!values || values.length === 0) throw new BadGatewayException("Embedding 服务返回了空向量");
  return {
    embedding: Array.from(values),
    model,
    dimension: values.length
  };
}

function throwEmbeddingProviderError(error: unknown): never {
  if (error instanceof HttpException) throw error;
  const status = typeof error === "object" && error !== null && "status" in error
    ? Number((error as { status?: unknown }).status)
    : undefined;
  if (status === HttpStatus.TOO_MANY_REQUESTS) {
    throw new HttpException("Embedding 服务请求过于频繁或配额已用尽，请稍后重试", HttpStatus.TOO_MANY_REQUESTS, {
      cause: error
    });
  }
  throw new BadGatewayException("Embedding 服务调用失败，请检查模型配置或稍后重试", { cause: error });
}
