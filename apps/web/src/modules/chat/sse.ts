/**
 * Server-Sent Events framing for `:converse` (WHATWG event-stream format).
 *
 * Bytes arrive in arbitrary chunks: a frame, a line, even a multi-byte UTF-8
 * character can be split across reads. The decoder keeps the unfinished tail
 * and emits only complete frames: `event:` names the OpenResponses event type,
 * `data:` lines (possibly several) join with "\n" into the JSON payload.
 * Comment lines (`:`) and unknown fields are ignored.
 */

export interface SseFrame {
  /** `event:` field; "message" when the frame named none. */
  event: string;
  data: string;
}

export class SseDecoder {
  private readonly decoder = new TextDecoder();
  private buffer = "";
  private event = "";
  private data: string[] = [];

  /** Feed one chunk; returns the frames it completed. */
  push(chunk: Uint8Array | string): SseFrame[] {
    this.buffer += typeof chunk === "string" ? chunk : this.decoder.decode(chunk, { stream: true });
    return this.drain(false);
  }

  /** End of stream: flushes a final frame that had no trailing blank line. */
  end(): SseFrame[] {
    this.buffer += this.decoder.decode();
    return this.drain(true);
  }

  private drain(final: boolean): SseFrame[] {
    const frames: SseFrame[] = [];
    let start = 0;
    for (;;) {
      const newline = this.buffer.slice(start).search(/\r\n|\r|\n/);
      if (newline < 0) break;
      const at = start + newline;
      // A lone "\r" at the very end may be the first half of "\r\n": wait for more.
      if (!final && this.buffer[at] === "\r" && at === this.buffer.length - 1) break;
      const line = this.buffer.slice(start, at);
      start = at + (this.buffer.startsWith("\r\n", at) ? 2 : 1);
      const frame = this.line(line);
      if (frame) frames.push(frame);
    }
    this.buffer = this.buffer.slice(start);
    if (final) {
      if (this.buffer) {
        const frame = this.line(this.buffer);
        if (frame) frames.push(frame);
        this.buffer = "";
      }
      const frame = this.dispatch();
      if (frame) frames.push(frame);
    }
    return frames;
  }

  private line(line: string): SseFrame | null {
    if (line === "") return this.dispatch();
    if (line.startsWith(":")) return null;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") this.event = value;
    else if (field === "data") this.data.push(value);
    return null;
  }

  private dispatch(): SseFrame | null {
    const frame = this.data.length ? { event: this.event || "message", data: this.data.join("\n") } : null;
    this.event = "";
    this.data = [];
    return frame;
  }
}

/** Parse a frame's JSON payload; the `event:` name wins over a missing `type`. */
export function parseFrame<T extends { type: string }>(frame: SseFrame): T | null {
  try {
    const value = JSON.parse(frame.data) as Partial<T> | null;
    if (!value || typeof value !== "object") return null;
    return { ...value, type: (value.type as string | undefined) ?? frame.event } as T;
  } catch {
    return null;
  }
}
