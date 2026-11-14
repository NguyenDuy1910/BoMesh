"use client";

import type { ReactNode } from "react";

import { PageChrome, type Crumb } from "@/components/shell/page-chrome";

import { ContextBar } from "./ContextBar";

export interface PageHeaderProps {
  /** Page title (the H1). A string: it is also the top-row title and the document title. */
  title: string;
  /** Custom title markup for hero pages (e.g. an inline rename button). `title` still names the page. */
  heading?: ReactNode;
  /** Chips beside the title (e.g. `<PreviewChip/>`, "Demo data"). Preview `extra`. */
  chips?: ReactNode;
  /** A short dynamic status ("4 things need you", "Updated 2 min ago"). Never a static purpose sentence. */
  meta?: ReactNode;
  /** The page's one primary action (plus at most a quiet secondary), rendered compact in the top row. */
  actions?: ReactNode;
  /** Parents for the top-row trail. */
  crumbs?: Crumb[];
  /**
   * Entity pages only (a space, a collection, a request, a work item): the leading mark. With a lead the page
   * renders a compact `.page-hero` (mark, H1, meta) as its first child and the top row peeks the title on scroll.
   */
  lead?: ReactNode;
  /** An entity's own tabs (views of ONE thing), rendered as the sticky ContextualToolbar under the header. */
  children?: ReactNode;
}

/**
 * Page header (preview `pageHeader()` + `crumbs()`): declares the page's title, chips, status, actions and
 * trail to the shell's single top row. Index pages render nothing in the page; entity pages (`lead`) render a
 * compact hero. An area's sections are never tabs here: they are sidebar sub-rows (`navigation.ts` sections).
 */
export function PageHeader({ title, heading, chips, meta, actions, crumbs, lead, children }: PageHeaderProps) {
  if (!lead) {
    return (
      <>
        <PageChrome title={title} extra={chips} meta={meta} actions={actions} crumbs={crumbs} />
        {children ? <ContextBar>{children}</ContextBar> : null}
      </>
    );
  }
  return (
    <>
      <PageChrome title={title} actions={actions} crumbs={crumbs} hero />
      <header className="page-hero" id="page-hero">
        <div className="page-hero__lead">{lead}</div>
        <div className="page-hero__body">
          <div className="page-hero__title-row">
            <h1 className="page-hero__title" translate={heading ? undefined : "no"}>
              {heading ?? title}
            </h1>
            {chips}
          </div>
          {meta ? <div className="page-hero__meta">{meta}</div> : null}
        </div>
      </header>
      {children ? <ContextBar>{children}</ContextBar> : null}
    </>
  );
}
