import type { ReactNode } from "react";

export interface PageHeaderProps {
  /** Page title (h1). */
  title: ReactNode;
  /** One line of purpose under the title. */
  description?: ReactNode;
  /** Chips beside the title (e.g. `<PreviewChip/>`, "Demo data"). Preview `extra`. */
  chips?: ReactNode;
  /** Primary action(s) on the right; one primary button per page. */
  actions?: ReactNode;
  /** Leading mark before the title block (avatar, file icon, workspace mark). */
  lead?: ReactNode;
  /** Rendered directly under the header, e.g. `<SectionTabs/>`. */
  children?: ReactNode;
}

/**
 * Page header (preview `pageHeader()`): title, optional description and chips,
 * actions on the right. Section tabs passed as children sit directly under it.
 */
export function PageHeader({ title, description, chips, actions, lead, children }: PageHeaderProps) {
  return (
    <>
      <header className="page-header">
        {lead ? <div className="page-header__lead">{lead}</div> : null}
        <div className="page-header__body">
          <div className="page-header__title-row">
            <h1 className="page-header__title">{title}</h1>
            {chips}
          </div>
          {description ? <p className="page-header__description">{description}</p> : null}
        </div>
        {actions ? <div className="page-header__actions">{actions}</div> : null}
      </header>
      {children ? <div className="page-tabs">{children}</div> : null}
    </>
  );
}
