/**
 * Contribute: a folder or a ZIP becomes the documents inside it (preview `addInputs`, SCREEN_INVENTORY "Contribute
 * dialog"). Files are added flat, each with where it came from; hidden and system files are dropped silently; what a
 * folder or ZIP held that can't be sent is counted per source. A ZIP is opened here, in the browser, so its documents
 * are ordinary uploads that go through review like any file. ZIPs inside a ZIP aren't opened.
 *
 * Framework-free (no `@/` imports) so it runs under `node --test`.
 */

/** One send takes at most this many files. */
export const MAX_BATCH_FILES = 100;
/** Never documents: archiver and OS debris, hidden files. */
const SYSTEM_RE = /(^|\/)(__MACOSX|Thumbs\.db|desktop\.ini|\.[^/]*)(\/|$)/i;
/** A dropped folder tree is read up to this many files, so a huge folder can't hang the dialog. */
const MAX_WALK = 5000;

export const isZipName = (name: string) => /\.zip$/i.test(name);

/** A picked or dropped file. `path`: its path from the picked folder ("Thesis/Ch 1/a.pdf"); "" for a loose file. */
export interface Picked {
  file: File;
  path: string;
}

/** A file to list in the dialog. `where`: the folder it came from inside a folder or ZIP ("" for a loose file). */
export interface Added {
  file: File;
  where: string;
}

export interface LeftOut {
  source: string;
  count: number;
}

export interface Expansion {
  added: Added[];
  leftOut: LeftOut[];
  /** ZIPs that couldn't be read (damaged, encrypted directory, ZIP64): listed as failed rows by the dialog. */
  unreadable: File[];
}

/**
 * Expand picked files. Loose files are returned as they are (the dialog validates them and shows their errors); files
 * from folders and ZIPs are filtered with `accepts`, which says whether a file can be sent.
 */
export async function expandPicked(picked: readonly Picked[], accepts: (file: { name: string; size: number }) => boolean): Promise<Expansion> {
  const added: Added[] = [];
  const unreadable: File[] = [];
  const left = new Map<string, number>();
  const leave = (source: string) => left.set(source, (left.get(source) ?? 0) + 1);

  for (const { file, path } of picked) {
    const where = path.includes("/") ? path : file.name;
    if (isZipName(file.name)) {
      let members: ZipMember[];
      try {
        members = await zipMembers(file);
      } catch {
        unreadable.push(file);
        continue;
      }
      for (const member of members) {
        const memberPath = `${where}/${member.path}`;
        if (SYSTEM_RE.test(member.path)) continue;
        const name = member.path.split("/").pop() ?? member.path;
        if (isZipName(name) || member.encrypted || !accepts({ name, size: member.size })) {
          leave(where);
          continue;
        }
        try {
          // No type: the upload names it from the extension (`mimeOf` in api.ts).
          added.push({ file: new File([await member.read()], name), where: memberPath.slice(0, memberPath.lastIndexOf("/")) });
        } catch {
          leave(where);
        }
      }
    } else if (path.includes("/")) {
      if (SYSTEM_RE.test(path)) continue;
      if (accepts(file)) added.push({ file, where: path.slice(0, path.lastIndexOf("/")) });
      else leave(path.split("/")[0]);
    } else {
      added.push({ file, where: "" });
    }
  }
  return { added, leftOut: [...left].map(([source, count]) => ({ source, count })), unreadable };
}

/* ═══════════════ Folders ═══════════════ */

/** Files picked with a folder input (`webkitdirectory`) carry their path from the folder. */
export function pickedFromInput(files: FileList | readonly File[]): Picked[] {
  return [...files].map((file) => ({ file, path: file.webkitRelativePath || "" }));
}

/**
 * Dropped files and folders. Entries must be taken while the drop event runs (`entriesOf`); the folders are walked
 * after. Without folders the plain file list is used.
 */
export function entriesOf(data: DataTransfer): FileSystemEntry[] {
  return [...data.items].map((item) => item.webkitGetAsEntry?.() ?? null).filter((entry): entry is FileSystemEntry => !!entry);
}

export async function pickedFromEntries(entries: readonly FileSystemEntry[]): Promise<Picked[]> {
  const out: Picked[] = [];
  async function walk(list: readonly FileSystemEntry[]) {
    for (const entry of list) {
      if (out.length >= MAX_WALK) return;
      if (entry.isFile) {
        const file = await new Promise<File | null>((resolve) => (entry as FileSystemFileEntry).file(resolve, () => resolve(null)));
        if (file) out.push({ file, path: entry.fullPath.replace(/^\//, "") });
      } else if (entry.isDirectory) {
        const reader = (entry as FileSystemDirectoryEntry).createReader();
        // readEntries returns a batch at a time; an empty batch ends the folder.
        for (;;) {
          const batch = await new Promise<FileSystemEntry[]>((resolve) => reader.readEntries(resolve, () => resolve([])));
          if (!batch.length) break;
          await walk(batch);
        }
      }
    }
  }
  await walk(entries);
  return out;
}

/* ═══════════════ ZIP ═══════════════ */

export interface ZipMember {
  path: string;
  size: number;
  encrypted: boolean;
  read: () => Promise<Blob>;
}

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const UNICODE_PATH = 0x7075;

/**
 * The files of a ZIP from its central directory; each is read (stored or deflated) only when asked. Folders are
 * skipped. ZIP64 archives (over 4 GB or 65 535 entries) are refused.
 */
export async function zipMembers(zip: Blob): Promise<ZipMember[]> {
  const tailStart = Math.max(0, zip.size - 0xffff - 22);
  const tail = new DataView(await zip.slice(tailStart).arrayBuffer());
  let at = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--) {
    if (tail.getUint32(i, true) === EOCD) {
      at = i;
      break;
    }
  }
  if (at < 0) throw new Error("Không phải tệp ZIP");
  const count = tail.getUint16(at + 10, true);
  const dirSize = tail.getUint32(at + 12, true);
  const dirOffset = tail.getUint32(at + 16, true);
  if (count === 0xffff || dirOffset === 0xffffffff || dirSize === 0xffffffff) throw new Error("Không hỗ trợ ZIP64");
  const dir = new DataView(await zip.slice(dirOffset, dirOffset + dirSize).arrayBuffer());

  const members: ZipMember[] = [];
  let p = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > dir.byteLength || dir.getUint32(p, true) !== CENTRAL) throw new Error("Tệp ZIP bị hỏng");
    const flags = dir.getUint16(p + 8, true);
    const method = dir.getUint16(p + 10, true);
    const compressed = dir.getUint32(p + 20, true);
    const size = dir.getUint32(p + 24, true);
    const nameLen = dir.getUint16(p + 28, true);
    const extraLen = dir.getUint16(p + 30, true);
    const commentLen = dir.getUint16(p + 32, true);
    const local = dir.getUint32(p + 42, true);
    const nameBytes = new Uint8Array(dir.buffer, dir.byteOffset + p + 46, nameLen);
    const extra = new DataView(dir.buffer, dir.byteOffset + p + 46 + nameLen, extraLen);
    const path = memberName(nameBytes, flags, extra).replace(/\\/g, "/");
    p += 46 + nameLen + extraLen + commentLen;
    // Folders, and paths that try to climb out of the archive, are not files to send.
    if (path.endsWith("/") || path.startsWith("/") || path.split("/").includes("..")) continue;
    members.push({ path, size, encrypted: !!(flags & 1), read: () => readMember(zip, local, compressed, size, method) });
  }
  return members;
}

/** UTF-8 when the archive says so (flag bit 11 or an Info-ZIP Unicode path field), else UTF-8 if it decodes, else Latin-1. */
function memberName(bytes: Uint8Array, flags: number, extra: DataView): string {
  if (flags & 0x800) return new TextDecoder().decode(bytes);
  for (let q = 0; q + 4 <= extra.byteLength; ) {
    const id = extra.getUint16(q, true);
    const len = extra.getUint16(q + 2, true);
    if (id === UNICODE_PATH && len > 5) {
      return new TextDecoder().decode(new Uint8Array(extra.buffer, extra.byteOffset + q + 9, len - 5));
    }
    q += 4 + len;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("latin1").decode(bytes);
  }
}

async function readMember(zip: Blob, local: number, compressed: number, size: number, method: number): Promise<Blob> {
  const head = new DataView(await zip.slice(local, local + 30).arrayBuffer());
  if (head.getUint32(0, true) !== LOCAL) throw new Error("Tệp ZIP bị hỏng");
  const start = local + 30 + head.getUint16(26, true) + head.getUint16(28, true);
  const data = zip.slice(start, start + compressed);
  let out: Blob;
  if (method === 0) out = data;
  else if (method === 8) out = await new Response(data.stream().pipeThrough(new DecompressionStream("deflate-raw"))).blob();
  else throw new Error("Kiểu nén không được hỗ trợ");
  if (out.size !== size) throw new Error("Tệp trong ZIP bị hỏng");
  return out;
}
