"use client";

import clsx from "clsx";
import { ChevronDown, type LucideIcon } from "lucide-react";
import { useId, useState, type ReactNode } from "react";

export interface DisclosureProps {
  /** The quiet header row's text (may carry an "(optional)" mark). */
  title: ReactNode;
  /** A short summary of the current choice, shown at the end of the header row. */
  summary?: ReactNode;
  icon?: LucideIcon;
  /** Uncontrolled initial state. */
  defaultOpen?: boolean;
  /** Controlled state (with `onOpenChange`). */
  isOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
  children: ReactNode;
}

/**
 * Progressive disclosure (preview `disclosure()`, HeroUI Disclosure visuals): a quiet header row (title, optional
 * summary of the current choice) that expands its body. The body mounts only while open.
 */
export function Disclosure({ title, summary, icon: Icon, defaultOpen = false, isOpen, onOpenChange, className, children }: DisclosureProps) {
  const [own, setOwn] = useState(defaultOpen);
  const open = isOpen ?? own;
  const id = useId();
  const toggle = () => {
    if (isOpen === undefined) setOwn(!open);
    onOpenChange?.(!open);
  };
  return (
    <div className={clsx("disclosure", open && "is-open", className)}>
      <button type="button" className="disclosure__trigger" aria-expanded={open} aria-controls={id} onClick={toggle}>
        {Icon ? <Icon className="i" aria-hidden /> : null}
        <span className="grow">{title}</span>
        {summary ? <span className="disclosure__summary">{summary}</span> : null}
        <ChevronDown className="i disclosure__chevron" aria-hidden />
      </button>
      {open ? (
        <div className="disclosure__body" id={id}>
          {children}
        </div>
      ) : null}
    </div>
  );
}
