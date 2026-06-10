import { BadRequestException, Injectable } from "@nestjs/common";
import mammoth from "mammoth";
import pdfParse from "pdf-parse/lib/pdf-parse.js";
import { extname } from "node:path";

const MAX_EXTRACTED_CHARACTERS = 2_000_000;
const TEXT_EXTENSIONS = new Set([".txt", ".md", ".markdown", ".json", ".csv", ".log", ".html", ".htm", ".xml", ".yaml", ".yml"]);

@Injectable()
export class DocumentExtractionService {
  async extract(input: { name: string; mimeType: string; content: Buffer }) {
    const extension = extname(input.name).toLowerCase();
    let text: string;

    if (input.mimeType.startsWith("text/") || TEXT_EXTENSIONS.has(extension) || input.mimeType === "application/json") {
      text = input.content.toString("utf8");
    } else if (input.mimeType === "application/pdf" || extension === ".pdf") {
      text = (await pdfParse(input.content)).text;
    } else if (
      input.mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      || extension === ".docx"
    ) {
      text = (await mammoth.extractRawText({ buffer: input.content })).value;
    } else {
      throw new BadRequestException("当前知识库支持 TXT、Markdown、JSON、CSV、HTML、PDF 和 DOCX 文件");
    }

    const normalized = text.replace(/\u0000/g, "").trim();
    if (!normalized) throw new BadRequestException(`文件「${input.name}」没有可索引的文本内容`);
    if (normalized.length > MAX_EXTRACTED_CHARACTERS) {
      throw new BadRequestException(`文件「${input.name}」提取后的文本超过 ${MAX_EXTRACTED_CHARACTERS} 字符`);
    }
    return normalized;
  }
}
