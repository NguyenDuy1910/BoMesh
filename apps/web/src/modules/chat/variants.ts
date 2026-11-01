import type { AnswerVariant, ChatMessage, TurnState } from "./types";

/**
 * Answer variants (‹ 1/2 ›), kept in the local conversation store.
 *
 * Invariant once an answer has been retried and has settled: `variants`
 * holds every attempt oldest first and `turn` is `variants[variantIndex].turn`.
 * While a retry streams, `variants` holds the earlier attempts only and
 * `variantIndex` is absent.
 */

/** The attempts so far, with the shown one's feedback written back to it. */
function settledAttempts(message: ChatMessage): AnswerVariant[] {
  if (message.variants?.length && typeof message.variantIndex === "number") {
    return message.variants.map((variant, index) => (
      index === message.variantIndex ? { ...variant, feedback: message.feedback } : variant
    ));
  }
  return message.turn ? [{ turn: message.turn, ...(message.feedback ? { feedback: message.feedback } : {}) }] : [];
}

/** Start another attempt at this answer; earlier attempts stay reachable. */
export function beginAttempt(message: ChatMessage, turn: TurnState): ChatMessage {
  const earlier = settledAttempts(message);
  return {
    ...message,
    turn,
    variants: earlier.length ? earlier : undefined,
    variantIndex: undefined,
    feedback: undefined,
  };
}

/** The attempt that just ended (finished, stopped or failed) becomes the newest variant. */
export function settleAttempt(message: ChatMessage): ChatMessage {
  if (!message.variants?.length || typeof message.variantIndex === "number" || !message.turn) return message;
  const variants = [...message.variants, { turn: message.turn }];
  return { ...message, variants, variantIndex: variants.length - 1 };
}

/** Show attempt `index` (zero-based), clamped to the attempts that exist. */
export function selectVariant(message: ChatMessage, index: number): ChatMessage {
  if (!message.variants?.length || typeof message.variantIndex !== "number") return message;
  const variants = settledAttempts(message);
  const next = Math.max(0, Math.min(variants.length - 1, index));
  const shown = variants[next]!;
  return { ...message, variants, variantIndex: next, turn: shown.turn, feedback: shown.feedback };
}

/** Where the pager stands, or null when there is only one attempt. */
export function variantPosition(message: ChatMessage): { index: number; count: number } | null {
  if (!message.variants || message.variants.length < 2 || typeof message.variantIndex !== "number") return null;
  return { index: message.variantIndex, count: message.variants.length };
}
