import { cn } from "@/lib/cn";

export type PageWidth = "default" | "narrow" | "wide" | "bare";

const WIDTH: Record<Exclude<PageWidth, "bare">, string> = {
  default: "max-w-(--page-max)",
  narrow: "max-w-(--page-max-narrow)",
  wide: "max-w-none",
};

/**
 * The one page frame inside the shell's sheet (prototype `.page`): 28/36/64
 * padding, centred at 1240px (880px narrow). `bare` pages — chat and the
 * document reader — fill the sheet edge to edge and own their own scrolling.
 */
export function Page({
  width = "default",
  className,
  children,
}: {
  width?: PageWidth;
  className?: string;
  children: React.ReactNode;
}) {
  if (width === "bare") {
    return <div className={cn("flex min-h-0 w-full flex-1 flex-col", className)}>{children}</div>;
  }
  return (
    <div
      className={cn(
        "mx-auto w-full px-9 pt-(--page-pt) pb-16 max-[1100px]:px-6 max-[640px]:px-4",
        WIDTH[width],
        className,
      )}
    >
      {children}
    </div>
  );
}
