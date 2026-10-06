"use client";

import { CircleAlert } from "lucide-react";
import { cloneElement, isValidElement, type ReactElement, type ReactNode } from "react";

import { ui } from "@/components/ui/design-system";
import { cn } from "@/lib/cn";

interface FormFieldProps {
  label: ReactNode;
  /** Id of the control; links the label, help and error to it. */
  htmlFor?: string;
  /** What the value is for, in plain language. Shown until an error replaces it. */
  help?: ReactNode;
  error?: ReactNode;
  /** Required fields carry no marker; the others say "Optional". */
  required?: boolean;
  /** A control on the label row's right, e.g. a counter or "Generate" link. */
  labelAction?: ReactNode;
  children: ReactNode;
  className?: string;
}

type DescribableProps = {
  id?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean | "true" | "false";
  "aria-required"?: boolean | "true" | "false";
};

/**
 * Label, control, help and error in one column. When `htmlFor` is set and the
 * child is a single element, the child receives the id, `aria-describedby`
 * (help or error), `aria-invalid` and `aria-required`.
 */
export function FormField({
  label,
  htmlFor,
  help,
  error,
  required = false,
  labelAction,
  children,
  className,
}: FormFieldProps) {
  const messageId = htmlFor ? `${htmlFor}-${error ? "error" : "help"}` : undefined;
  const hasMessage = Boolean(error) || Boolean(help);

  let control = children;
  if (htmlFor && isValidElement<DescribableProps>(children)) {
    const child = children as ReactElement<DescribableProps>;
    control = cloneElement(child, {
      id: child.props.id ?? htmlFor,
      "aria-describedby":
        [child.props["aria-describedby"], hasMessage ? messageId : undefined].filter(Boolean).join(" ") || undefined,
      "aria-invalid": error ? true : child.props["aria-invalid"],
      "aria-required": required || child.props["aria-required"] || undefined,
    });
  }

  return (
    <div className={cn("grid gap-1.5", className)}>
      <div className="flex items-center justify-between gap-3">
        <label className={ui.label} htmlFor={htmlFor}>
          {label}
          {!required && <span className={ui.labelHint}>Optional</span>}
        </label>
        {labelAction}
      </div>
      {control}
      {error ? (
        <p className={ui.errorText} id={messageId} role="alert">
          <CircleAlert aria-hidden="true" className="mt-px size-3.5 shrink-0" />
          <span>{error}</span>
        </p>
      ) : (
        help && (
          <p className={ui.helper} id={messageId}>
            {help}
          </p>
        )
      )}
    </div>
  );
}

/**
 * Groups related fields under one heading so a long form reads as a few
 * decisions rather than a list of inputs.
 */
export function FormSection({
  title,
  description,
  children,
  className,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <fieldset className={cn("m-0 min-w-0 border-0 p-0", className)}>
      <legend className={ui.sectionTitle}>{title}</legend>
      {description && <p className={ui.sectionDescription}>{description}</p>}
      <div className="mt-3 space-y-4">{children}</div>
    </fieldset>
  );
}
