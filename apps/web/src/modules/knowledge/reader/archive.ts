/**
 * The ARCHIVE representation (`application/vnd.bomesh.archive+json`, gzip-encoded; document_viewer.md
 * "Payloads"): the archive's central directory — paths, sizes, folders — up to 10,000 entries.
 */

export interface ArchiveEntry {
  path: string;
  sizeBytes: number;
  directory: boolean;
}

export interface ArchivePayload {
  entries: ArchiveEntry[];
  /** Entries in the archive (at least those listed). */
  totalEntries: number;
  truncated: boolean;
}

export class ArchivePayloadError extends Error {
  constructor(message = "This archive’s listing couldn’t be read.") {
    super(message);
    this.name = "ArchivePayloadError";
  }
}

/** An ARCHIVE payload, checked and normalized. */
export function parseArchivePayload(json: unknown): ArchivePayload {
  const payload = json as { schema?: unknown; entries?: unknown; totalEntries?: unknown; truncated?: unknown } | null;
  if (payload?.schema !== 1 || !Array.isArray(payload.entries)) throw new ArchivePayloadError();
  const entries = payload.entries.flatMap((raw: unknown): ArchiveEntry[] => {
    const entry = (raw ?? {}) as { path?: unknown; sizeBytes?: unknown; directory?: unknown };
    const path = typeof entry.path === "string" ? entry.path.replace(/^\/+/, "") : "";
    if (!path) return [];
    const directory = entry.directory === true || path.endsWith("/");
    return [{ path: directory ? path.replace(/\/+$/, "") : path, sizeBytes: Math.max(0, Number(entry.sizeBytes) || 0), directory }];
  });
  const total = typeof payload.totalEntries === "number" && payload.totalEntries > 0 ? Math.floor(payload.totalEntries) : 0;
  const totalEntries = Math.max(total, entries.length);
  return { entries, totalEntries, truncated: payload.truncated === true || totalEntries > entries.length };
}

/** One line of the listing: a folder or a file, indented under its folder. */
export interface ArchiveRow {
  path: string;
  name: string;
  depth: number;
  directory: boolean;
  /** A file's size; a folder's is the sum of the files listed under it. */
  sizeBytes: number;
}

/**
 * The entries as a tree, flattened in reading order: folders first then files, each by name, a folder
 * the archive doesn't list itself added for its files.
 */
export function archiveRows(entries: readonly ArchiveEntry[]): ArchiveRow[] {
  interface Node {
    name: string;
    path: string;
    directory: boolean;
    sizeBytes: number;
    children: Map<string, Node>;
  }
  const root: Node = { name: "", path: "", directory: true, sizeBytes: 0, children: new Map() };
  for (const entry of entries) {
    const parts = entry.path.split("/").filter(Boolean);
    let node = root;
    parts.forEach((name, i) => {
      const last = i === parts.length - 1;
      let child = node.children.get(name);
      if (!child) {
        child = { name, path: parts.slice(0, i + 1).join("/"), directory: !last || entry.directory, sizeBytes: 0, children: new Map() };
        node.children.set(name, child);
      } else if (!last) child.directory = true;
      if (last && !entry.directory) child.sizeBytes = entry.sizeBytes;
      node = child;
    });
  }
  const total = (node: Node): number => {
    if (!node.directory) return node.sizeBytes;
    node.sizeBytes = [...node.children.values()].reduce((sum, child) => sum + total(child), 0);
    return node.sizeBytes;
  };
  total(root);
  const out: ArchiveRow[] = [];
  const walk = (node: Node, depth: number) => {
    const children = [...node.children.values()].sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name));
    for (const child of children) {
      out.push({ path: child.path, name: child.name, depth, directory: child.directory, sizeBytes: child.sizeBytes });
      walk(child, depth + 1);
    }
  };
  walk(root, 0);
  return out;
}
