import { cn } from "@/lib/cn";

/**
 * Cited text inside a document or passage, on the evidence amber. `focus`
 * marks the one passage the reader arrived for (stronger fill; give it an
 * `id` to scroll it into view).
 */
export function Highlight({
  focus = false,
  id,
  className,
  children,
}: {
  focus?: boolean;
  id?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <mark
      className={cn(
        "rounded-[3px] border-b-2 border-[var(--evidence-line)] px-px text-inherit [box-decoration-break:clone]",
        focus
          ? "scroll-mt-[120px] bg-[var(--evidence-strong)] shadow-[0_0_0_3px_var(--evidence-strong)]"
          : "bg-[var(--evidence-bg)] shadow-[0_0_0_2px_var(--evidence-bg)]",
        className,
      )}
      data-focus={focus || undefined}
      id={id}
    >
      {children}
    </mark>
  );
}
