import type { CollectionImportRow } from "./api";

/**
 * Folder-tree file for Import folders (preview `features/knowledge.js` `parseFolderTree`): pure functions. The file is
 * JSON — `{"folders": [Node…]}` or a bare `[Node…]`, `Node = {name, description?, folders?}`; unknown keys are ignored —
 * and is flattened depth-first (parents before children) into ImportCollections rows, so row N is the Nth folder of
 * the file. Matching, limits per name and depth, and the skip reasons are the server's (`items/{item}:importCollections`).
 */

export const MAX_ROWS = 1000;
export const DESCRIPTION_MAX = 2000;

export type FolderTree = { rows: CollectionImportRow[] } | { error: string };

const isObject = (v: unknown): v is object => !!v && typeof v === "object" && !Array.isArray(v);

export function parseFolderTree(text: string): FolderTree {
  let data: unknown;
  try {
    data = JSON.parse(text.replace(/^\ufeff/, ""));
  } catch {
    return { error: "The file isn’t valid JSON." };
  }
  let top: [readonly unknown[], string];
  if (Array.isArray(data)) top = [data, "$"];
  else if (isObject(data) && "folders" in data && Array.isArray(data.folders)) top = [data.folders, "$.folders"];
  else return { error: "The file must be a list of folders, or an object with a “folders” list." };

  const rows: CollectionImportRow[] = [];
  const walk = (list: readonly unknown[], at: string, path: readonly string[]): string => {
    for (const [i, node] of list.entries()) {
      const here = `${at}[${i}]`;
      const name = isObject(node) && "name" in node ? node.name : undefined;
      if (!isObject(node) || typeof name !== "string") return `The folder at ${here} has no name.`;
      const description = "description" in node ? node.description : undefined;
      const folders = "folders" in node ? node.folders : undefined;
      if (description != null && typeof description !== "string") return `The description at ${here} isn’t text.`;
      if (typeof description === "string" && description.length > DESCRIPTION_MAX) return `The description at ${here} is longer than 2,000 characters.`;
      if (folders != null && !Array.isArray(folders)) return `The folders at ${here} aren’t a list.`;
      const p = [...path, name.trim()];
      const desc = typeof description === "string" ? description.trim() : "";
      rows.push(desc ? { path: p, description: desc } : { path: p });
      const error = Array.isArray(folders) ? walk(folders, `${here}.folders`, p) : "";
      if (error) return error;
    }
    return "";
  };
  const error = walk(top[0], top[1], []);
  if (error) return { error };
  if (!rows.length) return { error: "The file has no folders." };
  if (rows.length > MAX_ROWS) return { error: "The file has more than 1,000 folders. Split it into smaller files." };
  return { rows };
}

/** Download template: a small tree with the optional description. */
export const TEMPLATE = {
  folders: [
    {
      name: "Faculty of Engineering",
      description: "Shown on the knowledge map when someone selects it.",
      folders: [{ name: "Lecture slides" }, { name: "Exams & answers", description: "Optional: a description for each folder." }],
    },
    { name: "Forms" },
  ],
};

export const templateJson = () => JSON.stringify(TEMPLATE, null, 2) + "\n";
