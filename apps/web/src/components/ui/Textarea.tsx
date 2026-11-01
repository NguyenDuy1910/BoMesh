"use client";

import { forwardRef, useId, useState, type ComponentProps } from "react";

import { ui } from "@/components/ui/design-system";
import { cn } from "@/lib/cn";

export interface TextareaProps extends Omit<ComponentProps<"textarea">, "ref"> {
  /** Marks the value invalid (red edge, `aria-invalid`). Show the message with FormField. */
  error?: boolean;
  /**
   * Shows a `used / limit` counter under the field. The limit is soft: typing
   * past it is allowed and turns the counter red, so a long paste is never
   * silently cut. Use `maxLength` for a hard cap.
   */
  counterLimit?: number;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  {
    className,
    error,
    counterLimit,
    onChange,
    "aria-invalid": ariaInvalid,
    "aria-describedby": ariaDescribedBy,
    ...props
  },
  ref,
) {
  const counterId = useId();
  const [uncontrolledLength, setUncontrolledLength] = useState(
    () => String(props.defaultValue ?? "").length,
  );
  const length = props.value === undefined ? uncontrolledLength : String(props.value).length;
  const over = counterLimit !== undefined && length > counterLimit;
  const describedBy =
    [ariaDescribedBy, counterLimit !== undefined ? counterId : undefined].filter(Boolean).join(" ") || undefined;

  const field = (
    <textarea
      aria-describedby={describedBy}
      aria-invalid={error || over || ariaInvalid || undefined}
      className={cn(ui.textarea, "read-only:bg-surface-subtle", counterLimit === undefined && className)}
      onChange={(event) => {
        if (counterLimit !== undefined) setUncontrolledLength(event.target.value.length);
        onChange?.(event);
      }}
      ref={ref}
      {...props}
    />
  );
  if (counterLimit === undefined) return field;
  return (
    <div className={cn("grid gap-1", className)}>
      {field}
      <p className={cn(ui.counter, "text-right", over && "font-medium text-status-danger")} id={counterId}>
        {length.toLocaleString()} / {counterLimit.toLocaleString()}
        {over && <span className="sr-only"> — over the limit</span>}
      </p>
    </div>
  );
});
