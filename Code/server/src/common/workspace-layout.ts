import { mkdir } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

export const WORKSPACE_DOCS_DIR = "Doc";
export const WORKSPACE_CODE_DIR = "Code";

export async function ensureWorkspaceLayout(rootPath: string) {
  await Promise.all([
    mkdir(resolve(rootPath, WORKSPACE_DOCS_DIR), { recursive: true }),
    mkdir(resolve(rootPath, WORKSPACE_CODE_DIR), { recursive: true })
  ]);
}

export async function ensureWorkspaceCodeRoot(rootPath: string) {
  const codeRoot = resolve(rootPath, WORKSPACE_CODE_DIR);
  await mkdir(codeRoot, { recursive: true });
  return codeRoot;
}

export function normalizeAgentDocumentPath(filePath: string) {
  let normalized = filePath.replaceAll("\\", "/").trim();
  while (normalized.startsWith("./")) normalized = normalized.slice(2);
  if (isAbsolute(normalized) || /^[a-z]:\//i.test(normalized)) throw new Error("agent document path must be relative");
  if (!normalized || normalized === ".") throw new Error("agent document path is required");
  const segments = normalized.split("/").filter(Boolean);
  if (segments.some((segment) => segment === "..")) throw new Error("agent document path cannot contain ..");
  if (segments.length === 1) return `${WORKSPACE_DOCS_DIR}/${segments[0]}`;
  const first = segments[0]!.toLowerCase();
  if (first === "doc" || first === "docs") return [WORKSPACE_DOCS_DIR, ...segments.slice(1)].join("/");
  throw new Error(`agent document writes must target ${WORKSPACE_DOCS_DIR}/...`);
}
