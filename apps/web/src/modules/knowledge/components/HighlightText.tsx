import { markParts } from "../model";

/** Text with query words wrapped in `<mark class="srch-hl">` (accent-insensitive; preview `markTokens`). */
export function HighlightText({ text, q }: { text: string; q?: string }) {
  if (!q) return <>{text}</>;
  return (
    <>
      {markParts(text, q).map((part, i) =>
        part.hit ? (
          <mark key={i} className="srch-hl">
            {part.text}
          </mark>
        ) : (
          part.text
        ),
      )}
    </>
  );
}
