import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import "./support/register-aliases.mjs";

const { DOMAIN_COLORS, freeDomainColor } = await import("../src/lib/tones.ts");
const { TOPIC_ICONS, DOMAIN_ICON } = await import("../src/modules/home/domainIcon.ts");

const preview = (path: string) => readFileSync(new URL(`../../ux_preview/scripts/${path}`, import.meta.url), "utf8");
/** The `[value, label]` pairs of a preview list literal `const NAME = [...];`. */
function previewPairs(path: string, name: string): [string, string][] {
  const body = new RegExp(`const ${name} = \\[([\\s\\S]*?)\\];`).exec(preview(path))?.[1] ?? "";
  return [...body.matchAll(/\['([^']+)', '([^']+)'\]/g)].map((m) => [m[1]!, m[2]!]);
}

test("domain palette: twelve distinct lowercase #rrggbb colors, the same as the preview's", () => {
  assert.equal(DOMAIN_COLORS.length, 12);
  assert.equal(new Set(DOMAIN_COLORS.map((c) => c.hex)).size, 12);
  for (const c of DOMAIN_COLORS) assert.match(c.hex, /^#[0-9a-f]{6}$/);
  assert.deepEqual(
    DOMAIN_COLORS.map((c) => [c.hex, c.label]),
    previewPairs("core/ui.js", "DOMAIN_COLORS"),
  );
});

test("a new domain gets the first palette color no domain uses, case-insensitively, and repeats once all are taken", () => {
  assert.equal(freeDomainColor([]), DOMAIN_COLORS[0]!.hex);
  assert.equal(freeDomainColor([DOMAIN_COLORS[0]!.hex.toUpperCase(), undefined, "#123456"]), DOMAIN_COLORS[1]!.hex);
  const all = DOMAIN_COLORS.map((c) => c.hex);
  assert.equal(freeDomainColor([...all, all[0]]), DOMAIN_COLORS[13 % 12]!.hex);
});

test("topic icons: the preview's names in its order, each drawn by its sprite and valid as Topic.icon", () => {
  assert.deepEqual(
    TOPIC_ICONS.map((i) => [i.name, i.label]),
    previewPairs("core/catalog.js", "TOPIC_ICONS"),
  );
  const sprite = preview("core/icons.js");
  for (const { name } of TOPIC_ICONS) {
    assert.match(name, /^[a-z][a-z0-9-]{0,63}$/);
    assert.ok(sprite.includes(`"${name}": "`), `${name} is in the preview sprite`);
  }
  assert.ok(TOPIC_ICONS.some((i) => i.name === DOMAIN_ICON));
  assert.match(preview("core/catalog.js"), new RegExp(`const DOMAIN_ICON = '${DOMAIN_ICON}';`));
});
