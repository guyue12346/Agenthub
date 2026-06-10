import { Injectable } from "@nestjs/common";
import { ConfigService } from "./config.service.js";

export interface ChunkingConfig {
  strategy: "sentence" | "fixed_token";
  size: number;
  overlap: number;
}

export interface TextChunk {
  content: string;
  chunkIndex: number;
  tokenEstimate: number;
}

@Injectable()
export class ChunkingService {
  constructor(private readonly config: ConfigService) {}

  chunkText(text: string, config?: ChunkingConfig): TextChunk[] {
    const effectiveConfig = config ?? this.config.chunking;

    if (effectiveConfig.strategy === "sentence") {
      return this.chunkBySentence(text, effectiveConfig);
    }

    if (effectiveConfig.strategy === "fixed_token") {
      return this.chunkByFixedToken(text, effectiveConfig);
    }

    throw new Error(`Unsupported chunking strategy: ${effectiveConfig.strategy}`);
  }

  private chunkBySentence(text: string, config: ChunkingConfig): TextChunk[] {
    // 按句子分割（含滑动重叠）
    const sentences = this.splitIntoSentences(text);
    const chunks: TextChunk[] = [];
    let currentChunk: string[] = [];
    let currentTokens = 0;

    for (let i = 0; i < sentences.length; i++) {
      const sentence = sentences[i];
      if (!sentence) continue;
      const sentenceTokens = this.estimateTokens(sentence);

      // 如果当前句子加入后超过块大小，先保存当前块
      if (currentTokens + sentenceTokens > config.size && currentChunk.length > 0) {
        chunks.push({
          content: currentChunk.join(" "),
          chunkIndex: chunks.length,
          tokenEstimate: currentTokens
        });

        // 保留最后几句作为滑动重叠
        const overlapSentences = this.getOverlapSentences(currentChunk, config.overlap);
        currentChunk = overlapSentences;
        currentTokens = this.estimateTokens(currentChunk.join(" "));
      }

      currentChunk.push(sentence);
      currentTokens += sentenceTokens;
    }

    // 保存最后一块
    if (currentChunk.length > 0) {
      chunks.push({
        content: currentChunk.join(" "),
        chunkIndex: chunks.length,
        tokenEstimate: currentTokens
      });
    }

    return chunks;
  }

  private chunkByFixedToken(text: string, config: ChunkingConfig): TextChunk[] {
    // 按固定 token 数分割（含滑动重叠）
    const words = text.split(/\s+/);
    const chunks: TextChunk[] = [];
    let startIndex = 0;

    while (startIndex < words.length) {
      const chunkWords = words.slice(startIndex, startIndex + config.size);
      const content = chunkWords.join(" ");

      chunks.push({
        content,
        chunkIndex: chunks.length,
        tokenEstimate: this.estimateTokens(content)
      });

      // 下一块从 (当前位置 + 块大小 - 重叠) 开始
      startIndex += config.size - config.overlap;
    }

    return chunks;
  }

  private splitIntoSentences(text: string): string[] {
    // 简单句子分割：按 。！？.!? 加换行符分割
    return text
      .split(/([。！？.!?\n]+)/)
      .reduce((acc: string[], part, i, arr) => {
        if (i % 2 === 0 && part.trim()) {
          const sentence = part.trim() + (arr[i + 1] || "");
          acc.push(sentence);
        }
        return acc;
      }, [])
      .filter((s) => s.trim().length > 0);
  }

  private getOverlapSentences(sentences: string[], overlapTokens: number): string[] {
    // 从末尾往前取句子，直到累积 token 数 >= overlapTokens
    const result: string[] = [];
    let tokens = 0;

    for (let i = sentences.length - 1; i >= 0 && tokens < overlapTokens; i--) {
      const sentence = sentences[i];
      if (!sentence) continue;
      result.unshift(sentence);
      tokens += this.estimateTokens(sentence);
    }

    return result;
  }

  private estimateTokens(text: string): number {
    // 粗略估计：中文按字符数 / 1.5，英文按单词数 * 1.3
    const chineseChars = (text.match(/[一-龥]/g) || []).length;
    const englishWords = text.split(/\s+/).filter((w) => /[a-zA-Z]/.test(w)).length;
    return Math.ceil(chineseChars / 1.5 + englishWords * 1.3);
  }
}
