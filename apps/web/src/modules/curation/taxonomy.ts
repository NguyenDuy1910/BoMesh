import type { Topic } from "@/modules/knowledge/api";

/**
 * Taxonomy spreadsheet import · export (preview `features/masterdata.js`): pure functions over the topics the
 * API returns. The topics resource has no stored code, keywords, synonyms or guidance, so codes are row keys
 * inside one file (they link topics to their domain row) and rows match the taxonomy by name: a domain by its
 * name, a topic by its name (preferring the same domain; found under another domain = moved).
 */

export const COLUMNS = ["code", "name", "parent_code", "description", "keywords", "synonyms", "guidance"] as const;
/** Columns the file may carry that the taxonomy can't store yet: read, never applied. */
export const UNSTORED = ["keywords", "synonyms", "guidance"] as const;

export type ImportMode = "merge" | "replace";

export interface SheetRow {
  /** 1-based spreadsheet row (header = 1). */
  row: number;
  code: string;
  name: string;
  parent: string;
  description: string;
}

export interface Sheet {
  rows: SheetRow[];
  /** The file has a description column (otherwise descriptions are neither compared nor changed). */
  hasDescription: boolean;
  /** Unstored columns the file carries. */
  ignored: string[];
}

const clean = (s: string | undefined) => String(s ?? "").trim().replace(/\s+/g, " ");
/** Case- and diacritics-insensitive key. */
export const foldName = (s: string | undefined) =>
  clean(s)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase();

/** Reads CSV or TSV text (quoted cells, header names in any order; only code and name are required). */
export function parseSheet(text: string): Sheet | { error: string } {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === "," || c === "\t") {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  const body = rows.filter((r) => r.some((x) => clean(x)));
  if (!body.length) return { error: "The file is empty." };
  const head = body[0].map((h) =>
    foldName(h)
      .replace(/^\ufeff/, "")
      .replace(/[^a-z]+/g, "_")
      .replace(/^_|_$/g, ""),
  );
  const ALIAS: Readonly<Record<string, readonly string[]>> = { parent_code: ["parent", "domain", "domain_code"], synonyms: ["synonym"], guidance: ["guidance_for_the_assistant", "assistant_guidance"] };
  const at = (k: string) => head.findIndex((h) => h === k || (ALIAS[k] ?? []).includes(h));
  const [iCode, iName, iParent, iDesc] = ["code", "name", "parent_code", "description"].map(at);
  if (iCode < 0 || iName < 0) return { error: "The first row must name the columns: code, name, parent_code, description, keywords, synonyms, guidance." };
  const out = body.slice(1).map((r, i) => ({
    row: i + 2,
    code: clean(r[iCode]).toUpperCase(),
    name: clean(r[iName]),
    parent: iParent < 0 ? "" : clean(r[iParent]).toUpperCase(),
    description: iDesc < 0 ? "" : clean(r[iDesc]),
  }));
  if (!out.length) return { error: "The file has a header but no rows." };
  return { rows: out, hasDescription: iDesc >= 0, ignored: UNSTORED.filter((k) => at(k) >= 0) };
}

export interface Change extends SheetRow {
  /** The matching topic (updates). */
  topic?: Topic;
  /** Domain name for topic rows. */
  domainName: string;
  /** What changes, in words (updates). */
  what: string[];
  /** Patch for an update: fields to set. */
  patch?: { description?: string; parentDomain?: string };
  restore?: boolean;
}

export interface TaxonomyDiff {
  added: Change[];
  updated: Change[];
  same: number;
  archived: Topic[];
  kept: Topic[];
  errors: { row: number; code: string; text: string }[];
  /** Proposed topics a new topic of the same name covers (merged into it on import). */
  covered: Topic[];
}

const isLive = (t: Topic) => t.state === "ACTIVE";
const known = (t: Topic) => t.state === "ACTIVE" || t.state === "DELETED";

/** Compares spreadsheet rows with the taxonomy. `used` says whether documents or submissions still use a topic. */
export function diffTaxonomy(sheet: Sheet, topics: readonly Topic[], mode: ImportMode, used: (t: Topic) => boolean): TaxonomyDiff {
  const out: TaxonomyDiff = { added: [], updated: [], same: 0, archived: [], kept: [], errors: [], covered: [] };
  const domainRows = new Map(sheet.rows.filter((r) => r.code && r.name && !r.parent).map((r) => [r.code, r]));
  const domains = topics.filter((t) => t.kind === "DOMAIN" && known(t));
  const leaves = topics.filter((t) => t.kind === "TOPIC" && known(t));
  const byName = new Map(topics.map((t) => [t.name ?? "", t]));
  const seenCodes = new Set<string>();
  const matched = new Set<string>();
  const matchedDomainNames = new Set<string>();

  for (const r of sheet.rows) {
    const fail = (text: string) => out.errors.push({ row: r.row, code: r.code || "—", text });
    if (!r.code) {
      fail("No code.");
      continue;
    }
    if (!r.name) {
      fail("No name.");
      continue;
    }
    if (seenCodes.has(r.code)) {
      fail(`Code ${r.code} appears more than once. Only the first row is used.`);
      continue;
    }
    seenCodes.add(r.code);
    const desc = (t: Topic | undefined) => (sheet.hasDescription && t && (t.description ?? "") !== r.description ? ["description"] : []);

    if (!r.parent) {
      // A domain: matched by name.
      const t = domains.find((d) => foldName(d.displayName) === foldName(r.name));
      matchedDomainNames.add(foldName(r.name));
      if (!t) {
        out.added.push({ ...r, domainName: "", what: [] });
        continue;
      }
      matched.add(t.name ?? "");
      const what = [...desc(t), ...(t.state === "DELETED" ? ["restored"] : [])];
      if (what.length) out.updated.push({ ...r, topic: t, domainName: "", what, restore: t.state === "DELETED", patch: desc(t).length ? { description: r.description } : undefined });
      else out.same++;
      continue;
    }

    const parentRow = domainRows.get(r.parent);
    if (!parentRow) {
      fail(`Domain ${r.parent} isn’t a domain row in the file.`);
      continue;
    }
    const domainName = parentRow.name;
    const candidates = leaves.filter((t) => foldName(t.displayName) === foldName(r.name));
    const sameDomain = candidates.find((t) => foldName(byName.get(t.parentTopic ?? "")?.displayName) === foldName(domainName));
    const t = sameDomain ?? candidates.find(isLive) ?? candidates[0];
    if (!t) {
      out.added.push({ ...r, domainName, what: [] });
      continue;
    }
    matched.add(t.name ?? "");
    const moved = !sameDomain;
    const what = [...(moved ? [`moved to ${domainName}`] : []), ...desc(t), ...(t.state === "DELETED" ? ["restored"] : [])];
    if (what.length) {
      out.updated.push({
        ...r,
        topic: t,
        domainName,
        what,
        restore: t.state === "DELETED",
        patch: moved || desc(t).length ? { ...(desc(t).length ? { description: r.description } : {}), ...(moved ? { parentDomain: domainName } : {}) } : undefined,
      });
    } else out.same++;
  }

  if (mode === "replace") {
    const archivedTopics = new Set<string>();
    for (const t of leaves.filter((x) => isLive(x) && !matched.has(x.name ?? ""))) {
      if (used(t)) out.kept.push(t);
      else {
        out.archived.push(t);
        archivedTopics.add(t.name ?? "");
      }
    }
    for (const d of domains.filter((x) => isLive(x) && !matched.has(x.name ?? "") && !matchedDomainNames.has(foldName(x.displayName)))) {
      const busy = leaves.some((t) => isLive(t) && t.parentTopic === d.name && !archivedTopics.has(t.name ?? ""));
      // A domain that keeps topics (in use, or moved into it by the file) is kept.
      const receives = out.updated.some((c) => c.patch?.parentDomain && foldName(c.patch.parentDomain) === foldName(d.displayName));
      if (busy || receives || used(d)) out.kept.push(d);
      else out.archived.push(d);
    }
  }

  const addedTopics = new Set(out.added.filter((c) => c.parent).map((c) => foldName(c.name)));
  out.covered = topics.filter((t) => t.state === "PROPOSED" && addedTopics.has(foldName(t.displayName)));
  return out;
}

export const changeCount = (d: TaxonomyDiff) => d.added.length + d.updated.length + d.archived.length;

/** Domain codes from their names ("Banking Operations" → BAN), unique per file; topics number within their domain. */
function codes(topics: readonly Topic[]): Map<string, string> {
  const out = new Map<string, string>();
  const taken = new Set<string>();
  const domains = topics.filter((t) => t.kind === "DOMAIN" && isLive(t));
  for (const d of domains) {
    const base = ((d.displayName ?? "").normalize("NFD").match(/[A-Za-z]/g) ?? ["X"]).join("").toUpperCase().slice(0, 3).padEnd(3, "X");
    let code = base;
    let n = 2;
    while (taken.has(code)) code = `${base.slice(0, 2)}${n++}`;
    taken.add(code);
    out.set(d.name ?? "", code);
    topics
      .filter((t) => t.kind === "TOPIC" && isLive(t) && t.parentTopic === d.name)
      .forEach((t, i) => out.set(t.name ?? "", `${code}-${String(i + 1).padStart(2, "0")}`));
  }
  return out;
}

/** The taxonomy as spreadsheet rows (domains, each followed by its topics). Unstored columns stay empty. */
export function exportRows(topics: readonly Topic[]): string[][] {
  const code = codes(topics);
  const rows: string[][] = [[...COLUMNS]];
  for (const d of topics.filter((t) => t.kind === "DOMAIN" && isLive(t))) {
    rows.push([code.get(d.name ?? "") ?? "", d.displayName ?? "", "", d.description ?? "", "", "", ""]);
    for (const t of topics.filter((x) => x.kind === "TOPIC" && isLive(x) && x.parentTopic === d.name)) {
      rows.push([code.get(t.name ?? "") ?? "", t.displayName ?? "", code.get(d.name ?? "") ?? "", t.description ?? "", "", "", ""]);
    }
  }
  return rows;
}

export const TEMPLATE_ROWS: readonly (readonly string[])[] = [
  COLUMNS,
  ["OPS", "Banking Operations", "", "Cut-off times, settlement and disputes.", "", "", ""],
  ["OPS-01", "Cards & disputes", "OPS", "Chargebacks and cardholder disputes.", "chargeback; dispute; card scheme", "cardholder dispute; reason code", "Use for card disputes and chargebacks.\nNot for merchant fees."],
];

/** CSV text (RFC 4180 quoting) with a BOM so spreadsheet apps read UTF-8. */
export function toCsv(rows: readonly (readonly string[])[]): string {
  const cell = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return `\ufeff${rows.map((r) => r.map(cell).join(",")).join("\r\n")}\r\n`;
}
