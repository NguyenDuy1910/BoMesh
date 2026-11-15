/**
 * Streaming markdown geometry: where accumulated assistant text may be cut, and
 * how fast to put it on screen.
 *
 * The renderer parses the finished prefix once per completed block and re-parses
 * only the arriving tail, so both decisions live here as pure code.
 */

/** Never slower than this, so a slow model never crawls (characters per ms). */
const MIN_SPEED = 0.03;
/** Once the stream ended, the rest arrives at least this fast. */
const DONE_MIN_SPEED = 0.2;
/** How far the screen may trail the received text while streaming (ms of backlog). */
const TARGET_LAG_MS = 250;
/** After the stream ended, the backlog drains within roughly this. */
const DONE_DRAIN_MS = 200;
/** Weight of the newest arrival in the arrival-rate average. */
const RATE_SMOOTHING = 0.25;
/** A token longer than this shows as it types rather than stall the reveal. */
const MAX_WORD = 24;

/**
 * Paces the reveal to the arrival rate: network chunks come in bursts, the
 * screen moves at the model's average speed with a short lag. A backlog larger
 * than the lag speeds the reveal up, so it never falls behind; after the stream
 * ends the rest drains quickly. The client paces paints, it never holds text.
 */
export class RevealPacer {
  private position: number;
  private received: number;
  private lastArrival = 0;
  /** Arrival rate, characters per ms. */
  private rate = MIN_SPEED;

  constructor(start = 0) {
    this.position = start;
    this.received = start;
  }

  /** The received text grew to ``length`` at ``now`` (ms). */
  arrive(length: number, now: number): void {
    if (length <= this.received) return;
    if (this.lastArrival) {
      const observed = (length - this.received) / Math.max(16, now - this.lastArrival);
      this.rate += (observed - this.rate) * RATE_SMOOTHING;
    }
    this.received = length;
    this.lastArrival = now;
  }

  /** Where the reveal stands after ``elapsed`` ms; ``done`` once no more text is coming. */
  advance(length: number, elapsed: number, done: boolean): number {
    const backlog = length - this.position;
    if (backlog <= 0) return (this.position = length);
    const speed = done
      ? Math.max(DONE_MIN_SPEED, backlog / DONE_DRAIN_MS)
      : Math.max(MIN_SPEED, this.rate, backlog / TARGET_LAG_MS);
    this.position = Math.min(length, this.position + speed * elapsed);
    return this.position;
  }
}

/**
 * How much of ``text`` to show for a reveal at ``position``: whole words only,
 * unless one token is longer than ``MAX_WORD`` and snapping back would stall.
 */
export function revealLength(text: string, position: number, shown: number): number {
  const at = Math.min(text.length, Math.floor(position));
  if (at >= text.length) return text.length;
  const boundary = wordBoundaryAtOrBefore(text, at);
  return boundary > shown || at - shown <= MAX_WORD ? Math.max(boundary, shown) : at;
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const LIST_MARKER = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/;
// A reference definition resolves links and footnotes anywhere in the same
// document, so text that uses them is only correct parsed as a single piece.
const REFERENCE_DEFINITION = /^ {0,3}\[[^\]]*\]:/m;

export interface StreamingMarkdownSplit {
  /** Blocks that are finished: parse once, then leave alone. */
  stable: string;
  /** The block still being written, plus anything that cannot be cut off yet. */
  tail: string;
}

/**
 * Split accumulated markdown into a finished prefix and the arriving tail.
 *
 * The two halves are parsed by separate markdown roots, so the cut may only
 * fall where a markdown block actually ends. Cutting inside a block changes
 * what the text means: a fenced code block loses its terminator and swallows
 * the following prose, a loose list becomes several lists, and an indented list
 * continuation becomes a code block. Only a blank line followed by a new
 * top-level block is safe, and everything after the last one stays in the tail.
 */
export function splitStreamingMarkdown(content: string): StreamingMarkdownSplit {
  const boundary = content ? stableMarkdownBoundary(content) : 0;
  return boundary > 0
    ? { stable: content.slice(0, boundary), tail: content.slice(boundary) }
    : { stable: "", tail: content };
}

function stableMarkdownBoundary(content: string): number {
  if (REFERENCE_DEFINITION.test(content)) return 0;

  let boundary = 0;
  let offset = 0;
  let openFence: string | null = null;
  let openMath = false;
  let openList = false;
  let previousLineIsBlank = false;

  for (const line of content.split("\n")) {
    const isBlank = !line.trim();
    const isIndented = /^[ \t]/.test(line);
    const isListItem = LIST_MARKER.test(line);
    if (
      previousLineIsBlank
      && !isBlank
      && !openFence
      && !openMath
      // Indented text continues the item or code block above the blank line.
      && !isIndented
      // A list item after a blank line continues a loose list; splitting it off
      // would render one list as several.
      && !(isListItem && openList)
    ) {
      boundary = offset;
    }

    if (openFence) {
      if (closesFence(line, openFence)) openFence = null;
    } else {
      const fence = FENCE_OPEN.exec(line);
      if (fence) openFence = fence[1];
      else if (countDisplayMathMarkers(line) % 2 === 1) openMath = !openMath;
    }
    if (!openFence && !isBlank) {
      // A list stays open across its own blank lines and indented continuations.
      openList = isListItem || (openList && isIndented);
    }

    // A blank line inside a fence or a display-math block separates nothing.
    previousLineIsBlank = isBlank && !openFence && !openMath;
    offset += line.length + 1;
  }

  return boundary;
}

function closesFence(line: string, openFence: string): boolean {
  const closing = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
  return Boolean(
    closing
    && closing[1][0] === openFence[0]
    && closing[1].length >= openFence.length,
  );
}

function countDisplayMathMarkers(line: string): number {
  return line.split("$$").length - 1;
}

function wordBoundaryAtOrBefore(text: string, position: number): number {
  for (let index = position; index > 0; index -= 1) {
    const character = text[index - 1];
    if (character === " " || character === "\n" || character === "\t") return index;
  }
  return 0;
}
