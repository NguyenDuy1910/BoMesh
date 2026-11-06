import type { ReactNode } from "react";

export interface FormSectionProps {
  /** Label column title (h3). */
  title: ReactNode;
  /** Explanation under the title. */
  description?: ReactNode;
  /** Controls column. */
  children: ReactNode;
}

/**
 * Settings-style row (preview `formSection()`): label + description on the left
 * (280 px), controls on the right; stacks below 1024 px.
 */
export function FormSection({ title, description, children }: FormSectionProps) {
  return (
    <div className="form-section">
      <div>
        <h3 className="form-section__title">{title}</h3>
        {description ? <p className="form-section__description">{description}</p> : null}
      </div>
      <div className="stack gap-16">{children}</div>
    </div>
  );
}
