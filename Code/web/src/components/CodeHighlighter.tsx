import hljs from "highlight.js/lib/common";
import { useMemo } from "react";

type CodeHighlighterProps = {
  code: string;
  language?: string | null | undefined;
  fileName?: string | null | undefined;
  className?: string | undefined;
  emptyText?: string | undefined;
};

const EXTENSION_LANGUAGE: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  jsonl: "json",
  excalidraw: "json",
  css: "css",
  scss: "scss",
  less: "less",
  html: "xml",
  htm: "xml",
  xml: "xml",
  svg: "xml",
  md: "markdown",
  markdown: "markdown",
  py: "python",
  java: "java",
  go: "go",
  rs: "rust",
  sql: "sql",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  yaml: "yaml",
  yml: "yaml",
  toml: "ini",
  ini: "ini",
  env: "ini",
  diff: "diff",
  patch: "diff"
};

export function CodeHighlighter({
  code,
  language,
  fileName,
  className,
  emptyText = "当前文件没有可显示的文本内容。"
}: CodeHighlighterProps) {
  const normalizedCode = code || emptyText;
  const resolvedLanguage = resolveCodeLanguage(language, fileName);
  const html = useMemo(() => highlightCode(normalizedCode, resolvedLanguage), [normalizedCode, resolvedLanguage]);
  return (
    <pre className={["syntax-code", className].filter(Boolean).join(" ")}>
      <code className={resolvedLanguage ? `language-${resolvedLanguage}` : undefined} dangerouslySetInnerHTML={{ __html: html }} />
    </pre>
  );
}

export function resolveCodeLanguage(language?: string | null, fileName?: string | null) {
  const explicit = normalizeLanguage(language);
  if (explicit) return explicit;
  const extension = (fileName ?? "").toLowerCase().split(".").pop();
  if (!extension) return undefined;
  return EXTENSION_LANGUAGE[extension] ?? undefined;
}

export function formatJsonForPreview(content: string) {
  try {
    return JSON.stringify(JSON.parse(content), null, 2);
  } catch {
    return content;
  }
}

export function summarizeJson(content: string) {
  try {
    const parsed = JSON.parse(content) as unknown;
    if (Array.isArray(parsed)) return `Array · ${parsed.length} items`;
    if (parsed && typeof parsed === "object") return `Object · ${Object.keys(parsed).length} keys`;
    return typeof parsed;
  } catch {
    return "Invalid JSON · 按文本显示";
  }
}

function highlightCode(code: string, language: string | undefined) {
  try {
    if (language && hljs.getLanguage(language)) {
      return hljs.highlight(code, { language, ignoreIllegals: true }).value;
    }
  } catch {
    return escapeHtml(code);
  }
  return escapeHtml(code);
}

function normalizeLanguage(language?: string | null) {
  const value = (language ?? "").trim().toLowerCase();
  if (!value) return undefined;
  const normalized = value.replace(/^language-/, "");
  if (normalized === "ts") return "typescript";
  if (normalized === "tsx") return "typescript";
  if (normalized === "js" || normalized === "jsx") return "javascript";
  if (normalized === "shell" || normalized === "sh" || normalized === "zsh") return "bash";
  if (normalized === "yml") return "yaml";
  if (normalized === "html" || normalized === "svg") return "xml";
  return normalized;
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
