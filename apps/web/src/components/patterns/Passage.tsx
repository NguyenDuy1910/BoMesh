import { Highlight } from "@/components/patterns/Highlight";
import { cn } from "@/lib/cn";

/**
 * A cited passage: the quoted text on the evidence tint with the evidence
 * rule on its left. `highlight` marks the exact words the answer relied on;
 * `source` is a quiet header line ("Employee Handbook.pdf · Page 31").
 */
export function Passage({
  children,
  highlight,
  source,
  className,
}: {
  /** The passage text. Plain strings can carry a `highlight`. */
  children: React.ReactNode;
  /** A substring of `children` to mark as the focused evidence. */
  highlight?: string;
  source?: React.ReactNode;
  className?: string;
}) {
  const quote = (
    <blockquote
      className={cn(
        "rounded-r-[var(--radius-md)] border-l-[3px] border-[var(--evidence-line)] bg-[var(--evidence-bg)] px-3 py-2.5",
        "text-[13.5px] leading-[1.55] text-[var(--text-primary)]",
        !source && className,
      )}
    >
      {typeof children === "string" && highlight ? markText(children, highlight) : children}
    </blockquote>
  );
  if (!source) return quote;
  return (
    <figure className={className}>
      <figcaption className="mb-2 truncate text-[length:var(--text-size-meta)] text-[var(--text-tertiary)]">{source}</figcaption>
      {quote}
    </figure>
  );
}

function markText(text: string, highlight: string): React.ReactNode {
  const at = text.indexOf(highlight);
  if (at < 0) return text;
  return (
    <>
      {text.slice(0, at)}
      <Highlight focus>{highlight}</Highlight>
      {text.slice(at + highlight.length)}
    </>
  );
}
