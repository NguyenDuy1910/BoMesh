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
    return { error: "Tệp không phải JSON hợp lệ." };
  }
  let top: [readonly unknown[], string];
  if (Array.isArray(data)) top = [data, "$"];
  else if (isObject(data) && "folders" in data && Array.isArray(data.folders)) top = [data.folders, "$.folders"];
  else return { error: "Tệp phải là một danh sách thư mục, hoặc một đối tượng có danh sách “folders”." };

  const rows: CollectionImportRow[] = [];
  const walk = (list: readonly unknown[], at: string, path: readonly string[]): string => {
    for (const [i, node] of list.entries()) {
      const here = `${at}[${i}]`;
      const name = isObject(node) && "name" in node ? node.name : undefined;
      if (!isObject(node) || typeof name !== "string") return `Thư mục tại ${here} không có tên.`;
      const description = "description" in node ? node.description : undefined;
      const folders = "folders" in node ? node.folders : undefined;
      if (description != null && typeof description !== "string") return `Mô tả tại ${here} không phải văn bản.`;
      if (typeof description === "string" && description.length > DESCRIPTION_MAX) return `Mô tả tại ${here} dài hơn 2.000 ký tự.`;
      if (folders != null && !Array.isArray(folders)) return `Mục “folders” tại ${here} không phải danh sách.`;
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
  if (!rows.length) return { error: "Tệp không có thư mục nào." };
  if (rows.length > MAX_ROWS) return { error: "Tệp có hơn 1.000 thư mục. Hãy tách thành các tệp nhỏ hơn." };
  return { rows };
}

/** Download template: a small tree with the optional description. */
export const TEMPLATE = {
  folders: [
    {
      name: "Khoa Kỹ thuật",
      description: "Hiển thị trên bản đồ tri thức khi có người chọn thư mục này.",
      folders: [{ name: "Slide bài giảng" }, { name: "Đề thi & đáp án", description: "Không bắt buộc: mô tả cho từng thư mục." }],
    },
    { name: "Biểu mẫu" },
  ],
};

export const templateJson = () => JSON.stringify(TEMPLATE, null, 2) + "\n";
