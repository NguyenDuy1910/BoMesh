import { cn } from "@/lib/cn";

/**
 * A keyboard key, e.g. `<Kbd>⌘</Kbd> <Kbd>K</Kbd>`. A hint only: every
 * shortcut has a visible control that does the same thing.
 */
export function Kbd({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        "inline-flex min-w-[1.25rem] items-center justify-center rounded-[5px] border border-b-2 border-[var(--border-default)]",
        "bg-[var(--surface-base)] px-[5px] py-px font-mono text-[length:var(--text-size-caption)] font-medium leading-4 text-[var(--text-tertiary)]",
        className,
      )}
    >
      {children}
    </kbd>
  );
}
