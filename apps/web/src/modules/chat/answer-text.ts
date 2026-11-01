/** An answer as text the reader takes elsewhere: copied, or saved as a file. */

interface CitedSource {
  index: number;
  title: string;
  locator?: string;
}

/** The answer without Markdown syntax or citation markers, for "Copy". */
export function answerPlainText(markdown: string): string {
  return markdown
    .replace(/\s?\[\d{1,3}\]/g, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1$2")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * The answer as Markdown with its sources listed under it, so the `[n]`
 * markers still mean something outside the chat. Only sources the reader can
 * open are listed.
 */
export function answerMarkdown(markdown: string, sources: readonly CitedSource[]): string {
  const body = markdown.trim();
  if (!sources.length) return body;
  const list = [...sources]
    .sort((a, b) => a.index - b.index)
    .map((source) => `${source.index}. ${source.title}${source.locator ? ` (${source.locator})` : ""}`)
    .join("\n");
  return `${body}\n\n**Sources**\n\n${list}`;
}

/** "Per diem for international travel.md" — from the question, safe as a file name. */
export function answerFileName(question: string): string {
  const words = question
    .replace(/[\\/:*?"<>|#%{}^~[\]`]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[?.!,;:]+$/, "");
  const base = words.length > 72 ? words.slice(0, 72).replace(/\s+\S*$/, "") : words;
  return `${base || "Answer"}.md`;
}
