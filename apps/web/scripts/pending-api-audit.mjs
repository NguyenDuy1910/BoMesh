/**
 * Fails when the pending-API layer drifts from its contract.
 *
 * For every key in PENDING_FEATURES (apps/web/src/lib/api/pending.ts):
 *   1. a client function in the registered module calls pendingApi("<key>", …);
 *   2. that module imports a local implementation from lib/api/pending/;
 *   3. a component renders <PreviewTag> next to the feature (it names the key or
 *      imports one of the key's client functions);
 *   4. its entry points are gated with usePendingFeature/isPendingFeatureEnabled;
 *   5. it names at least one operationId, and each one exists in
 *      backend/docs_design/openapi.yaml.
 * And globally: only owning api.ts files (and pending files themselves) import
 * lib/api/pending/*; no component reads process.env for pending configuration.
 *
 *   node scripts/pending-api-audit.mjs        (run from apps/web/)
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const src = join(root, "src");
const openapi = readFileSync(join(root, "../../backend/docs_design/openapi.yaml"), "utf8");
const operationIds = new Set([...openapi.matchAll(/^\s*operationId:\s*(\w+)\s*$/gm)].map(([, id]) => id));
const registry = readFileSync(join(src, "lib/api/pending.ts"), "utf8");

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(tsx?|mts)$/.test(entry)) out.push(full);
  }
  return out;
}
const files = walk(src).map((path) => ({ path, rel: relative(src, path), text: readFileSync(path, "utf8") }));

const features = [...registry.matchAll(/key:\s*"([\w.]+)",[\s\S]*?module:\s*"([^"]+)",[\s\S]*?operationIds:\s*\[([^\]]*)\]/g)]
  .map(([, key, module, ids]) => ({ key, module, ids: [...ids.matchAll(/"(\w+)"/g)].map(([, id]) => id) }));

const problems = [];
if (features.length === 0) problems.push("PENDING_FEATURES could not be parsed");
if (operationIds.size === 0) problems.push("backend/docs_design/openapi.yaml has no operationId lines");

const isPendingInternal = (rel) => rel === "lib/api/pending.ts" || rel.startsWith("lib/api/pending/") || rel === "lib/config/pending.ts";
const isApiModule = (rel) => /(^|\/)api\.ts$/.test(rel);

for (const { key, module, ids } of features) {
  const owner = files.find((file) => file.rel === module);
  if (!owner) {
    problems.push(`${key}: registered module ${module} does not exist`);
    continue;
  }
  // Client functions: each exported chunk of the owning module that calls pendingApi(key).
  const clientFunctions = owner.text
    .split(/\n(?=export )/)
    .filter((chunk) => chunk.includes(`pendingApi("${key}"`))
    .map((chunk) => chunk.match(/^export (?:async )?function (\w+)/)?.[1])
    .filter(Boolean);
  if (clientFunctions.length === 0) problems.push(`${key}: no exported client function in ${module} calls pendingApi("${key}")`);
  if (!/from "@\/lib\/api\/pending\/[\w-]+"/.test(owner.text)) problems.push(`${key}: ${module} imports no local implementation from lib/api/pending/`);

  const consumers = files.filter((file) => file.rel.endsWith(".tsx") && !isPendingInternal(file.rel));
  const mentions = (file) => file.text.includes(`"${key}"`) || clientFunctions.some((name) => new RegExp(`\\b${name}\\b`).test(file.text));
  if (!consumers.some((file) => file.text.includes("PreviewTag") && mentions(file))) {
    problems.push(`${key}: no component renders <PreviewTag> alongside it`);
  }
  if (!files.some((file) => !isPendingInternal(file.rel) && new RegExp(`(usePendingFeature|isPendingFeatureEnabled)\\(\\s*"${key.replace(".", "\\.")}"`).test(file.text))) {
    problems.push(`${key}: entry points are not gated with usePendingFeature("${key}")`);
  }
  if (ids.length === 0) problems.push(`${key}: operationIds is empty`);
  for (const id of ids) {
    if (!operationIds.has(id)) problems.push(`${key}: openapi.yaml has no operationId ${id}`);
  }
}

for (const file of files) {
  if (isPendingInternal(file.rel) || isApiModule(file.rel)) continue;
  if (/from "@\/lib\/api\/pending\/[\w-]+"|from "\.{1,2}\/[^"]*lib\/api\/pending\//.test(file.text)) {
    problems.push(`${file.rel}: imports a local pending implementation directly (only api.ts files may)`);
  }
  if (/process\.env\.NEXT_PUBLIC_BOMESH_PENDING/.test(file.text)) {
    problems.push(`${file.rel}: reads pending configuration from process.env (use lib/config/pending.ts)`);
  }
}

console.log(`${features.length} pending features checked, ${problems.length} problem(s)`);
for (const problem of problems) console.log(`  - ${problem}`);
process.exit(problems.length ? 1 : 0);
