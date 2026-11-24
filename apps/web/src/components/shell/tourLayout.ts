/**
 * The product tour's layout rules (preview `features/chat.js` tour): which step shows, where its card goes and how far the
 * page scrolls to bring its target into view. Pure, so the rules are testable without a page.
 */

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Space between the target's ring and the card. */
const GAP = 12;
/** Least distance between the card and the edge of the view. */
const EDGE = 12;

/**
 * The step to show: `current` while its target is on screen, else the next step on screen after it in tour order (a section
 * that went away is skipped), else the last one before it; null when no step is on screen.
 */
export function resolveStep(order: readonly string[], shown: readonly string[], current: string): string | null {
  if (shown.includes(current)) return current;
  const at = order.indexOf(current);
  return shown.find((id) => order.indexOf(id) > at) ?? shown.at(-1) ?? null;
}

/** The step `delta` away from `current` among those on screen; null past either end. */
export function stepAfter(shown: readonly string[], current: string, delta: 1 | -1): string | null {
  const at = shown.indexOf(current);
  return at < 0 ? null : (shown[at + delta] ?? null);
}

/**
 * Where the card's top-left corner goes. A sidebar target gets it beside it (right, then left), else below or above; a
 * main-content target below, then above, then right, then left — so the card never sits over the sidebar while below or
 * above fits. While any spot fits in the view the card never covers the target; when none does, the in-view spot that
 * covers the least of it.
 */
export function placeCard(
  target: Box,
  card: { width: number; height: number },
  view: Box,
  region: "sidebar" | "main",
): { left: number; top: number } {
  const { width: w, height: h } = card;
  const clampX = (x: number) => Math.max(view.left + EDGE, Math.min(view.right - EDGE - w, x));
  const clampY = (y: number) => Math.max(view.top + EDGE, Math.min(view.bottom - EDGE - h, y));
  const midX = (target.left + target.right - w) / 2;
  const midY = (target.top + target.bottom - h) / 2;
  const right = { left: target.right + GAP, top: clampY(midY) };
  const left = { left: target.left - GAP - w, top: clampY(midY) };
  const below = { left: clampX(midX), top: target.bottom + GAP };
  const above = { left: clampX(midX), top: target.top - GAP - h };
  const spots = region === "sidebar" ? [right, left, below, above] : [below, above, right, left];
  const fits = (s: { left: number; top: number }) =>
    s.left >= view.left + EDGE && s.top >= view.top + EDGE && s.left + w <= view.right - EDGE && s.top + h <= view.bottom - EDGE;
  const fit = spots.find(fits);
  if (fit) return fit;
  const covered = (s: { left: number; top: number }) =>
    Math.max(0, Math.min(s.left + w, target.right) - Math.max(s.left, target.left)) *
    Math.max(0, Math.min(s.top + h, target.bottom) - Math.max(s.top, target.top));
  return spots
    .map((s) => ({ left: clampX(s.left), top: clampY(s.top) }))
    .reduce((best, s) => (covered(s) < covered(best) ? s : best));
}

/**
 * How far to scroll so the target sits between `top` and `bottom` (the visible page, above the bottom sheet on phones):
 * 0 when it already does, centred when it fits, else its top aligned to `top`.
 */
export function revealBy(target: Box, top: number, bottom: number): number {
  if (target.top >= top && target.bottom <= bottom) return 0;
  const height = target.bottom - target.top;
  const room = bottom - top;
  return height > room ? target.top - top : target.top - (top + (room - height) / 2);
}

/**
 * The scrim's clip path: the whole `width`×`height` view minus a rounded hole over the target (even-odd), so only the
 * target shows through. The command structure never changes, so the hole can glide between steps.
 */
export function spotlightPath(target: Box, radius: number, width: number, height: number): string {
  const r = Math.max(0, Math.min(radius, (target.right - target.left) / 2, (target.bottom - target.top) / 2));
  const n = (v: number) => Math.round(v * 10) / 10;
  const [L, T, R, B] = [target.left, target.top, target.right, target.bottom].map(n);
  const a = `A${n(r)} ${n(r)} 0 0 1`;
  return `path(evenodd, "M0 0H${n(width)}V${n(height)}H0Z M${n(L + r)} ${T}H${n(R - r)}${a} ${R} ${n(T + r)}V${n(B - r)}${a} ${n(R - r)} ${B}H${n(L + r)}${a} ${L} ${n(B - r)}V${n(T + r)}${a} ${n(L + r)} ${T}Z")`;
}
