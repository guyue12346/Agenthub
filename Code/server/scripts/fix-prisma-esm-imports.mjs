import { readdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { extname, join } from "node:path";

const generatedDir = fileURLToPath(new URL("../dist/generated/prisma/", import.meta.url));

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(path)));
    else if (entry.isFile() && extname(entry.name) === ".js") files.push(path);
  }
  return files;
}

function withJsExtension(specifier) {
  if (!specifier.startsWith(".")) return specifier;
  if (specifier.endsWith(".js") || specifier.endsWith(".json") || specifier.endsWith(".node")) return specifier;
  return `${specifier}.js`;
}

function rewriteImports(source) {
  return source
    .replace(/(from\s+["'])(\.[^"']+)(["'])/g, (_match, prefix, specifier, suffix) => {
      return `${prefix}${withJsExtension(specifier)}${suffix}`;
    })
    .replace(/(import\s*\(\s*["'])(\.[^"']+)(["']\s*\))/g, (_match, prefix, specifier, suffix) => {
      return `${prefix}${withJsExtension(specifier)}${suffix}`;
    });
}

try {
  const files = await walk(generatedDir);
  await Promise.all(
    files.map(async (file) => {
      const source = await readFile(file, "utf8");
      const next = rewriteImports(source);
      if (next !== source) await writeFile(file, next);
    })
  );
} catch (error) {
  if (error?.code === "ENOENT") {
    throw new Error("Prisma generated dist directory is missing. Run TypeScript build before fixing ESM imports.");
  }
  throw error;
}
