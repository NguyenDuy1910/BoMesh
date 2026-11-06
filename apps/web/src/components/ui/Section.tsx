import type { ReactNode } from "react";

export interface SectionProps {
  /** Section heading (h2). */
  title: ReactNode;
  description?: ReactNode;
  /** Section-level actions on the right of the heading (tertiary/ghost buttons, links). */
  actions?: ReactNode;
  id?: string;
  className?: string;
  children: ReactNode;
}

/** Titled page section (preview `section()`): 32 px apart, heading row with actions. */
export function Section({ title, description, actions, id, className, children }: SectionProps) {
  return (
    <section className={className ? `section ${className}` : "section"} id={id}>
      <div className="section__header">
        <div className="grow">
          <h2 className="section__title">{title}</h2>
          {description ? <p className="section__description">{description}</p> : null}
        </div>
        {actions ? <div className="row gap-8 none">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}
