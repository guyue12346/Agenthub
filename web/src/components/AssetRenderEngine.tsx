import { Download, FileText } from "lucide-react";
import { CodeHighlighter, formatJsonForPreview } from "./CodeHighlighter";
import { ExcalidrawPreview, isExcalidrawFile } from "./ExcalidrawRenderer";
import { MarkdownPreview } from "./MarkdownPreview";
import { formatBytes } from "../utils/upload";

export type AssetRenderEngineId =
  | "image"
  | "pdf"
  | "html"
  | "markdown"
  | "excalidraw"
  | "json"
  | "csv"
  | "diff"
  | "code"
  | "text"
  | "office"
  | "binary";

export interface RenderableAssetFile {
  name: string;
  mimeType?: string | null | undefined;
  size?: number | null | undefined;
  content?: string | undefined;
  binary?: boolean | undefined;
  previewableText?: boolean | undefined;
}

export interface AssetRenderEngine {
  id: AssetRenderEngineId;
  label: string;
  inline: boolean;
}

export function resolveAssetRenderEngine(file: RenderableAssetFile): AssetRenderEngine {
  const mimeType = (file.mimeType ?? "").toLowerCase();
  const lowerName = file.name.toLowerCase();
  if (mimeType.startsWith("image/")) return { id: "image", label: "图片", inline: true };
  if (mimeType === "application/pdf" || lowerName.endsWith(".pdf")) return { id: "pdf", label: "PDF", inline: true };
  if (mimeType === "text/html" || /\.(html|htm)$/i.test(lowerName)) return { id: "html", label: "HTML", inline: true };
  if (mimeType.includes("markdown") || /\.(md|markdown)$/i.test(lowerName)) return { id: "markdown", label: "Markdown", inline: true };
  if (isExcalidrawFile(file)) return { id: "excalidraw", label: "Excalidraw", inline: true };
  if (mimeType.includes("json") || /\.(json|jsonl)$/i.test(lowerName)) return { id: "json", label: "JSON", inline: true };
  if (mimeType === "text/csv" || /\.(csv|tsv)$/i.test(lowerName)) return { id: "csv", label: lowerName.endsWith(".tsv") ? "TSV" : "CSV", inline: true };
  if (mimeType === "text/x-diff" || /\.(diff|patch)$/i.test(lowerName)) return { id: "diff", label: "Diff", inline: true };
  if (isOfficeFile(mimeType, lowerName)) return { id: "office", label: "Office", inline: false };
  if (isCodeFile(mimeType, lowerName)) return { id: "code", label: "代码", inline: true };
  if (!file.binary && (mimeType.startsWith("text/") || file.content)) return { id: "text", label: "文本", inline: true };
  return { id: "binary", label: "下载", inline: false };
}

export function assetRenderEngineLabel(file: RenderableAssetFile) {
  return resolveAssetRenderEngine(file).label;
}

export function AssetRenderPreview({ file, assetUrl, className }: { file: RenderableAssetFile; assetUrl?: string | undefined; className?: string | undefined }) {
  const engine = resolveAssetRenderEngine(file);
  const content = file.content ?? "";
  const rootClassName = ["asset-render-preview", `asset-render-${engine.id}`, className].filter(Boolean).join(" ");
  if (engine.id === "image" && assetUrl) {
    return <img className="asset-preview-image" src={assetUrl} alt={file.name} />;
  }
  if (engine.id === "pdf" && assetUrl) {
    return <iframe className="workspace-rendered-frame" title={file.name} src={assetUrl} loading="lazy" />;
  }
  if (engine.id === "html") {
    return content
      ? <iframe className="workspace-rendered-frame" title={file.name} srcDoc={content} sandbox="allow-scripts allow-forms" />
      : assetUrl
        ? <iframe className="workspace-rendered-frame" title={file.name} src={assetUrl} sandbox="allow-scripts allow-forms" loading="lazy" />
        : <BinaryAssetFallback file={file} assetUrl={assetUrl} engine={engine} />;
  }
  if (engine.id === "markdown") {
    return <MarkdownPreview className={className ?? "asset-markdown-preview"} source={content} />;
  }
  if (engine.id === "excalidraw") {
    return <ExcalidrawPreview content={content} name={file.name} />;
  }
  if (engine.id === "json") {
    return <JsonAssetPreview content={content} fileName={file.name} />;
  }
  if (engine.id === "csv") {
    return <CsvAssetPreview content={content} delimiter={file.name.toLowerCase().endsWith(".tsv") ? "\t" : ","} />;
  }
  if (engine.id === "diff") {
    return <DiffAssetPreview content={content} />;
  }
  if (engine.id === "code" || engine.id === "text") {
    return (
      <CodeHighlighter
        className={engine.id === "text" ? "asset-text-preview" : "workspace-code-preview"}
        code={content}
        fileName={file.name}
        language={engine.id === "text" ? "plaintext" : undefined}
      />
    );
  }
  return (
    <div className={rootClassName}>
      <BinaryAssetFallback file={file} assetUrl={assetUrl} engine={engine} />
    </div>
  );
}

function JsonAssetPreview({ content, fileName }: { content: string; fileName: string }) {
  return (
    <div className="json-render-preview">
      <CodeHighlighter className="workspace-json-preview" code={formatJsonForPreview(content)} fileName={fileName} language="json" />
    </div>
  );
}

function DiffAssetPreview({ content }: { content: string }) {
  const lines = content.split(/\r?\n/);
  return (
    <pre className="workspace-git-diff-preview">
      <code>
        {lines.map((line, index) => {
          const kind = line.startsWith("+") && !line.startsWith("+++") ? "add"
            : line.startsWith("-") && !line.startsWith("---") ? "remove"
              : line.startsWith("@@") ? "hunk"
                : line.startsWith("diff --git") || line.startsWith("index ") || line.startsWith("+++") || line.startsWith("---") ? "meta"
                  : "context";
          return (
            <span key={`${index}-${line}`} className={`workspace-git-diff-line ${kind}`}>
              <b>{index + 1}</b>
              <span>{line || " "}</span>
            </span>
          );
        })}
      </code>
    </pre>
  );
}

function CsvAssetPreview({ content, delimiter }: { content: string; delimiter: "," | "\t" }) {
  const rows = parseDelimited(content, delimiter).slice(0, 80);
  if (!rows.length) return <p className="muted">表格文件没有可显示的数据。</p>;
  const headers = rows[0] ?? [];
  const body = rows.slice(1);
  return (
    <div className="workspace-csv-preview">
      <table>
        <thead>
          <tr>{headers.map((cell, index) => <th key={`${cell}-${index}`}>{cell || `列 ${index + 1}`}</th>)}</tr>
        </thead>
        <tbody>
          {body.map((row, rowIndex) => (
            <tr key={`row-${rowIndex}`}>
              {headers.map((_header, cellIndex) => <td key={`cell-${rowIndex}-${cellIndex}`}>{row[cellIndex] ?? ""}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
      {content.split(/\r?\n/).length > rows.length ? <small>仅显示前 {rows.length} 行。</small> : null}
    </div>
  );
}

function BinaryAssetFallback({ file, assetUrl, engine }: { file: RenderableAssetFile; assetUrl?: string | undefined; engine: AssetRenderEngine }) {
  return (
    <div className="workspace-binary-preview">
      <FileText size={34} />
      <strong>{engine.id === "office" ? "Office 文件暂不支持浏览器内联渲染" : "该文件不能按文本内联预览"}</strong>
      <p>{file.mimeType || "application/octet-stream"} · {formatBytes(file.size ?? 0)}</p>
      {assetUrl ? (
        <a className="secondary-button compact" href={assetUrl} download={file.name}>
          <Download size={14} /> 下载文件
        </a>
      ) : null}
    </div>
  );
}

function parseDelimited(content: string, delimiter: "," | "\t") {
  return content
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => splitDelimitedLine(line, delimiter));
}

function splitDelimitedLine(line: string, delimiter: "," | "\t") {
  const cells: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];
    if (char === "\"" && quoted && next === "\"") {
      cell += "\"";
      index += 1;
      continue;
    }
    if (char === "\"") {
      quoted = !quoted;
      continue;
    }
    if (char === delimiter && !quoted) {
      cells.push(cell);
      cell = "";
      continue;
    }
    cell += char;
  }
  cells.push(cell);
  return cells;
}

function isOfficeFile(mimeType: string, lowerName: string) {
  return [
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/msword",
    "application/vnd.ms-powerpoint",
    "application/vnd.ms-excel"
  ].includes(mimeType) || /\.(doc|docx|ppt|pptx|xls|xlsx)$/i.test(lowerName);
}

function isCodeFile(mimeType: string, lowerName: string) {
  if ([
    "text/typescript",
    "text/javascript",
    "application/javascript",
    "text/css",
    "text/x-scss",
    "text/x-python",
    "text/x-java",
    "text/x-go",
    "text/x-rust",
    "text/x-sql",
    "text/x-shellscript",
    "application/xml",
    "text/yaml"
  ].includes(mimeType)) return true;
  return /\.(ts|tsx|js|jsx|mjs|cjs|css|scss|less|py|java|go|rs|sql|sh|bash|zsh|xml|yaml|yml|toml|ini|env)$/i.test(lowerName);
}
