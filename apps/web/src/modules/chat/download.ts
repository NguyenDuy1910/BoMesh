/**
 * Answer downloads (preview `downloadAnswer`, `saveWord`, `savePdf`): a Word
 * document from the rendered answer, or a plain one-page PDF built in the
 * browser. Nothing leaves the device.
 */

import { toast } from "@/components/ui/Toast";

import type { AnswerSource } from "./turn";

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

function save(fileName: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement("a");
  link.hidden = true;
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast(`Downloaded ${fileName}`);
}

function fileBase(title: string) {
  return title.replace(/[\\/:*?"<>|]+/g, " ").trim() || "Answer";
}

const sourceLine = (s: AnswerSource) => `${s.title || "Document"}${s.passages[0]?.page ? `, page ${s.passages[0].page}` : ""}`;

/** Word: the answer as rendered (markers become superscripts) plus its sources. */
export function downloadWord(title: string, answerElement: HTMLElement | null, text: string, sources: readonly AnswerSource[]) {
  let body: string;
  if (answerElement) {
    const copy = answerElement.cloneNode(true) as HTMLElement;
    copy.querySelectorAll("button.cite").forEach((b) => b.replaceWith(Object.assign(document.createElement("sup"), { textContent: `[${b.textContent}]` })));
    copy.querySelectorAll(".chat-caret").forEach((c) => c.remove());
    body = copy.innerHTML;
  } else {
    body = text.split(/\n{2,}/).map((p) => `<p>${escapeHtml(p)}</p>`).join("");
  }
  const visible = sources.filter((s) => s.available);
  if (visible.length) {
    body += `<h3>Sources</h3><ol>${visible.map((s) => `<li>${escapeHtml(sourceLine(s))}${s.passages[0]?.excerpt ? ` — “${escapeHtml(s.passages[0].excerpt)}”` : ""}</li>`).join("")}</ol>`;
  }
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body><h1>${escapeHtml(title)}</h1>${body}</body></html>`;
  save(`${fileBase(title)}.doc`, html, "application/msword");
}

function wrap(line: string, width = 90): string[] {
  const out: string[] = [];
  let current = "";
  for (const word of line.split(/\s+/)) {
    if (`${current} ${word}`.trim().length > width) {
      if (current) out.push(current);
      current = word;
    } else current = `${current} ${word}`.trim();
  }
  if (current) out.push(current);
  return out.length ? out : [""];
}

/** PDF: plain text lines (Helvetica, ASCII) with the sources at the end. */
export function downloadPdf(title: string, text: string, sources: readonly AnswerSource[]) {
  const body = text
    .replace(/\*\*|\*/g, "")
    .split("\n")
    .filter((l) => !/^\s*\|[\s|:-]+\|?\s*$/.test(l))
    .map((l) => l.replace(/^\s*\|/, "").replace(/\|\s*$/, "").replace(/\|/g, " | ").replace(/^\s*- /, "• "));
  const visible = sources.filter((s) => s.available).map((s) => `[${s.n}] ${sourceLine(s)}`);
  const lines = [...body.flatMap((l) => wrap(l)), ...(visible.length ? ["", "Sources", ...visible.flatMap((l) => wrap(l))] : [])];
  const ascii = [title, ...lines].map((l) => l.normalize("NFKD").replace(/[^\x20-\x7e]/g, "?").slice(0, 92));
  const pdfText = (v: string) => v.replace(/([\\()])/g, "\\$1");
  const commands = `BT\n/F1 11 Tf\n72 744 Td\n15 TL\n${ascii.map((l, i) => `(${pdfText(l)}) Tj${i < ascii.length - 1 ? " T*" : ""}`).join("\n")}\nET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${commands.length} >>\nstream\n${commands}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n `).join("\n")}\ntrailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  save(`${fileBase(title)}.pdf`, pdf, "application/pdf");
}

/** Clipboard with a toast either way (preview `copyText`). */
export async function copyText(value: string, success = "Copied"): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    toast(success);
    return true;
  } catch {
    toast("Couldn’t copy. Select the text and copy it manually.", { tone: "danger" });
    return false;
  }
}
