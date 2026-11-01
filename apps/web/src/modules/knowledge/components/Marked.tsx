/**
 * Paints the matches of a find-in-document query.
 *
 * Highlighting is presentation, so it wraps rather than rewrites the text and
 * the underlying line is still selectable and readable by assistive tech.
 */
export function Marked({ text, query }: { text: string; query: string }) {
  const needle = query.trim().toLowerCase();
  if (!needle || !text.toLowerCase().includes(needle)) return <>{text}</>;
  const parts = text.split(new RegExp(`(${needle.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)})`, "gi"));
  return (
    <>
      {parts.map((part, index) =>
        part.toLowerCase() === needle
          ? <mark className="knowledge-mark" key={index}>{part}</mark>
          : <span key={index}>{part}</span>,
      )}
    </>
  );
}
