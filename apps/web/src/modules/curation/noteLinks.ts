/**
 * A contributor's note as lines of text and links (preview `noteBody`): a line that is only "Label: URL" (an
 * import's "Nguồn: …") becomes a labelled source; any other http(s) address becomes a link chip inside its line.
 * Pure (no React), so the parsing is unit-tested.
 */

export interface NoteLink {
  href: string;
  /** Host without `www.`. */
  host: string;
  /** The page's file name (the path's last segment), decoded; empty for a bare host or a query-only address. */
  tail: string;
  /** The whole address, decoded, for the tooltip. */
  full: string;
}

export type NoteSegment = { text: string } | { link: NoteLink };

export type NoteLine = { label: string; link: NoteLink } | { segments: NoteSegment[] };

const URL_RE = /https?:\/\/[^\s<>"]+/g;
const LABELLED = /^([^:\n]{1,40}):\s*(https?:\/\/\S+)\s*$/;

/** Drops sentence punctuation after an address; a closing bracket stays when the address opened it ("…(2016)"). */
function trimUrl(raw: string): string {
  let s = raw;
  for (;;) {
    const c = s.at(-1) ?? "";
    if (c && ".,;:!?'”’".includes(c)) s = s.slice(0, -1);
    else if (c === ")" && s.split("(").length < s.split(")").length) s = s.slice(0, -1);
    else return s;
  }
}

const decode = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

export function noteLink(raw: string): NoteLink | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const last = url.pathname.split("/").filter(Boolean).pop() ?? "";
  return {
    href: url.href,
    host: url.hostname.replace(/^www\./, ""),
    tail: decode(last),
    full: decode(url.href),
  };
}

function segmentsOf(line: string): NoteSegment[] {
  const out: NoteSegment[] = [];
  let at = 0;
  for (const m of line.matchAll(URL_RE)) {
    const raw = trimUrl(m[0]);
    const link = noteLink(raw);
    if (!link) continue;
    const start = m.index ?? 0;
    if (start > at) out.push({ text: line.slice(at, start) });
    out.push({ link });
    at = start + raw.length;
  }
  if (at < line.length) out.push({ text: line.slice(at) });
  return out;
}

export function noteLines(note: string): NoteLine[] {
  return note
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const m = LABELLED.exec(line);
      const link = m ? noteLink(trimUrl(m[2])) : null;
      return m && link ? { label: m[1].trim(), link } : { segments: segmentsOf(line) };
    });
}
