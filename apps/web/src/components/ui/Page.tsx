import clsx from "clsx";
import type { ReactNode } from "react";

export interface PageProps {
  /** 800 px column for forms and settings (preview `.page--narrow`). */
  narrow?: boolean;
  /** No max width (preview `.page--wide`), for full-bleed tables and boards. */
  wide?: boolean;
  className?: string;
  children: ReactNode;
}

/**
 * Page container (preview `.page`): the shared content column (`--page-max`, 1200 px; the CompactHeader aligns to it),
 * content starting right under the top row. Every routed screen renders its content inside one `Page`.
 */
export function Page({ narrow, wide, className, children }: PageProps) {
  return <div className={clsx("page", narrow && "page--narrow", wide && "page--wide", className)}>{children}</div>;
}
