/**
 * The one panel beside a chat thread. State stays at identity — which answer,
 * which document, which file — and each panel re-reads what it shows through
 * the authorized API, so nothing here copies source content.
 */
export type ChatPanel =
  | {
      kind: "sources";
      /** The answer whose sources are listed. */
      messageId: string;
      /** The source (document) to bring into view; absent opens at the first. */
      sourceId?: string;
      /** The cited passage to focus inside that source. */
      chunkId?: string;
    }
  | { kind: "file"; artifactId: string; revision?: number }
  | { kind: "files" };

/** Whether `next` is what the panel already shows, so a repeated click keeps it. */
export function isSamePanel(current: ChatPanel | null, next: ChatPanel): boolean {
  if (!current || current.kind !== next.kind) return false;
  if (current.kind === "sources" && next.kind === "sources") {
    return current.messageId === next.messageId
      && current.sourceId === next.sourceId
      && current.chunkId === next.chunkId;
  }
  if (current.kind === "file" && next.kind === "file") {
    return current.artifactId === next.artifactId && current.revision === next.revision;
  }
  return true;
}

