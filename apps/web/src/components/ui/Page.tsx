import clsx from "clsx";
import type { ReactNode } from "react";

/**
 * How much width a page's work needs (preview `.page` variants; widths in `styles/tokens.css`, rules in `styles/layout.css`):
 * - `centered` (default): dashboards, entity and mixed pages — 1200 px.
 * - `narrow`: settings, forms and one focused list — 800 px.
 * - `wide`: tables, card grids, boards and split workbenches — the whole width between the gutters.
 * - `canvas`: a page that is one canvas (Home's Knowledge Atlas) — full width, filling the screen; the canvas pans, the page doesn't scroll.
 * AI Chat and the Reader render no `Page`: they own their scrollers and centre the conversation column.
 */
export type PageWidth = "centered" | "narrow" | "wide" | "canvas";

export interface PageProps {
  width?: PageWidth;
  className?: string;
  children: ReactNode;
}

/**
 * Page container (preview `.page`): the content column (`--page-max`; the CompactHeader aligns to it), content starting
 * right under the top row. Every routed screen renders its content inside one `Page`.
 */
export function Page({ width = "centered", className, children }: PageProps) {
  return <div className={clsx("page", width !== "centered" && `page--${width}`, className)}>{children}</div>;
}
