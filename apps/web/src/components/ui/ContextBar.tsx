import type { ReactNode } from "react";

export interface ContextBarProps {
  /** The tabs (`<SectionTabs/>`) — views of ONE thing: an entity's tabs or one list's views (Mine · Shared). */
  children: ReactNode;
  /** Compact tools on the right of the row. */
  tools?: ReactNode;
}

/**
 * ContextualToolbar (preview `contextBar()`): one row that sticks under the top row while the page scrolls.
 * The only sticky row a page adds; filters and search stay with the content. An area's sections are sidebar
 * sub-rows, never a ContextBar.
 */
export function ContextBar({ children, tools }: ContextBarProps) {
  return (
    <div className="ctx-bar">
      {children}
      {tools ? <div className="ctx-bar__tools">{tools}</div> : null}
    </div>
  );
}
