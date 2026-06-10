import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";

interface SnapshotFile {
  hash: string;
  text: string;
  lineCount: number;
}

export interface WorkspaceSnapshot {
  root: string;
  files: Map<string, SnapshotFile>;
}

const MAX_SNAPSHOT_FILE_BYTES = 1_000_000;
const MAX_SNAPSHOT_FILES = 2_000;
const EXCLUDED_DIRS = new Set([".agenthub", ".git", "node_modules", "dist", "build", ".next", ".vite", "coverage"]);

export async function captureWorkspaceSnapshot(root: string): Promise<WorkspaceSnapshot> {
  const files = new Map<string, SnapshotFile>();
  await walk(root, root, files);
  return { root, files };
}

export function diffWorkspaceSnapshots(before: WorkspaceSnapshot, after: WorkspaceSnapshot) {
  const paths = new Set([...before.files.keys(), ...after.files.keys()]);
  const changedFiles: Array<{ path: string; additions: number; deletions: number }> = [];
  const patches: string[] = [];
  for (const path of [...paths].sort()) {
    const previous = before.files.get(path);
    const current = after.files.get(path);
    if (previous?.hash === current?.hash) continue;
    changedFiles.push({
      path,
      additions: current?.lineCount ?? 0,
      deletions: previous?.lineCount ?? 0
    });
    patches.push(formatPatch(path, previous?.text, current?.text));
  }
  return {
    changedFiles,
    diffText: patches.filter(Boolean).join("\n")
  };
}

async function walk(root: string, dir: string, files: Map<string, SnapshotFile>) {
  if (files.size >= MAX_SNAPSHOT_FILES) return;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (files.size >= MAX_SNAPSHOT_FILES) return;
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      await walk(root, join(dir, entry.name), files);
      continue;
    }
    if (!entry.isFile()) continue;
    const absolutePath = join(dir, entry.name);
    const info = await stat(absolutePath).catch(() => undefined);
    if (!info || info.size > MAX_SNAPSHOT_FILE_BYTES) continue;
    const buffer = await readFile(absolutePath).catch(() => undefined);
    if (!buffer || isBinary(buffer)) continue;
    const path = toWorkspaceRelativePath(root, absolutePath);
    const text = buffer.toString("utf8");
    files.set(path, {
      hash: createHash("sha256").update(buffer).digest("hex"),
      text,
      lineCount: countLines(text)
    });
  }
}

function formatPatch(path: string, previous: string | undefined, current: string | undefined) {
  const beforeLines = splitLines(previous ?? "");
  const afterLines = splitLines(current ?? "");
  return [
    `diff --git a/${path} b/${path}`,
    previous === undefined ? "new file mode 100644" : current === undefined ? "deleted file mode 100644" : "",
    previous === undefined ? "--- /dev/null" : `--- a/${path}`,
    current === undefined ? "+++ /dev/null" : `+++ b/${path}`,
    `@@ -1,${Math.max(beforeLines.length, 1)} +1,${Math.max(afterLines.length, 1)} @@`,
    ...beforeLines.map((line) => `-${line}`),
    ...afterLines.map((line) => `+${line}`)
  ].filter(Boolean).join("\n");
}

function splitLines(text: string) {
  if (!text) return [];
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function countLines(text: string) {
  return splitLines(text).length;
}

function isBinary(buffer: Buffer) {
  return buffer.includes(0);
}

function toWorkspaceRelativePath(root: string, absolutePath: string) {
  return relative(root, absolutePath).split(/[\\/]/).join("/");
}
