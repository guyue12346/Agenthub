import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";

export function workspaceAllowedRoots(workspacesRoot: string) {
  const currentRoot = resolve(workspacesRoot);
  const currentParent = dirname(currentRoot);
  const roots = [currentRoot];

  if (basename(currentParent) === "Code") {
    roots.push(resolve(dirname(currentParent), "workspaces"));
  } else {
    roots.push(resolve(currentParent, "Code", "workspaces"));
  }

  return Array.from(new Set(roots));
}

export function isChildPath(basePath: string, targetPath: string) {
  const relativePath = relative(resolve(basePath), resolve(targetPath));
  return Boolean(relativePath) && !relativePath.startsWith("..") && !isAbsolute(relativePath);
}

export function isInsideAnyWorkspaceRoot(workspacesRoot: string, targetPath: string) {
  return workspaceAllowedRoots(workspacesRoot).some((root) => isChildPath(root, targetPath));
}

export async function isInsideAnyWorkspaceRootRealpath(workspacesRoot: string, targetPath: string) {
  const resolvedTarget = resolve(targetPath);
  for (const root of workspaceAllowedRoots(workspacesRoot)) {
    if (!isChildPath(root, resolvedTarget)) continue;
    const [rootRealpath, targetRealpath] = await Promise.all([
      realpath(root).catch(() => resolve(root)),
      realpath(resolvedTarget).catch(() => resolvedTarget)
    ]);
    if (isChildPath(rootRealpath, targetRealpath)) return true;
  }
  return false;
}
