// Node resolve hooks that mirror the web app's bundler resolution for tests:
// the `@/` alias maps to `web/src/`, and extensionless TypeScript specifiers
// probe `.ts` and `/index.ts` the way Next's bundler does.
import { existsSync, statSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const sourceRoot = new URL("../../src/", import.meta.url);
const probes = [".ts", ".tsx", "/index.ts", "/index.tsx"];

function existingFile(url) {
  const path = fileURLToPath(url);
  return existsSync(path) && statSync(path).isFile();
}

function probe(url) {
  if (existingFile(url)) return url;
  for (const suffix of probes) {
    const candidate = new URL(`${url.href}${suffix}`);
    if (existingFile(candidate)) return candidate;
  }
  return null;
}

export async function resolve(specifier, context, nextResolve) {
  let target = null;
  if (specifier.startsWith("@/")) {
    target = probe(new URL(specifier.slice(2), sourceRoot));
  } else if ((specifier.startsWith("./") || specifier.startsWith("../")) && context.parentURL?.startsWith("file:")) {
    const url = new URL(specifier, context.parentURL);
    if (!existingFile(url)) target = probe(url);
  }
  return target ? nextResolve(pathToFileURL(fileURLToPath(target)).href, context) : nextResolve(specifier, context);
}
