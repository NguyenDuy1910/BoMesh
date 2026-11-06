"use client";

import { buttonVariants, Card, Label, ListBox, Select } from "@heroui/react";
import type { LucideIcon } from "lucide-react";
import NextLink from "next/link";
import type { ReactNode } from "react";

import { useSource } from "@/modules/knowledge/queries";

import { confLevel } from "../model";

/** A source's display name ("Source sync" while unknown). */
export function SourceName({ source }: { source: string | undefined }) {
  const src = useSource(source);
  return <>{src.data?.displayName || "Source sync"}</>;
}

/** Card with a header (preview `card(body, { title, desc, actions, cls })`). */
export function PanelCard({ title, description, actions, className, children }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; className?: string; children: ReactNode }) {
  return (
    <Card className={className}>
      <Card.Header>
        <div className="grow">
          <Card.Title>{title}</Card.Title>
          {description ? <Card.Description>{description}</Card.Description> : null}
        </div>
        {actions ? <div className="row gap-4 none">{actions}</div> : null}
      </Card.Header>
      {children}
    </Card>
  );
}

/** Assistant confidence badge (`cur-conf`): Edited wins over a percentage. */
export function ConfBadge({ value, edited }: { value?: number | null; edited?: boolean }) {
  if (edited) return <span className="cur-conf cur-conf--edited">Edited</span>;
  if (value == null) return null;
  return (
    <span className={`cur-conf cur-conf--${confLevel(value)}`} title="Assistant confidence">
      {Math.round(value * 100)}%
    </span>
  );
}

/** A link styled as a button (navigation, not an action). */
export function LinkButton({
  href,
  children,
  icon: Icon,
  variant = "ghost",
  size = "sm",
}: {
  href: string;
  children: ReactNode;
  icon?: LucideIcon;
  variant?: "primary" | "secondary" | "tertiary" | "ghost";
  size?: "sm" | "md";
}) {
  return (
    <NextLink href={href} className={buttonVariants({ variant, size })}>
      {Icon ? <Icon className="i" aria-hidden /> : null}
      {children}
    </NextLink>
  );
}

/** Compact select with an accessible (visually hidden) label. */
export function PlainSelect({
  label,
  value,
  options,
  onChange,
  className,
  placeholder,
}: {
  label: string;
  value: string;
  options: readonly (readonly [string, string])[];
  onChange: (value: string) => void;
  className?: string;
  placeholder?: string;
}) {
  return (
    <Select aria-label={label} value={value || null} onChange={(v) => onChange(v == null ? "" : String(v))} className={className} placeholder={placeholder}>
      <Label className="sr-only">{label}</Label>
      <Select.Trigger>
        <Select.Value />
        <Select.Indicator />
      </Select.Trigger>
      <Select.Popover>
        <ListBox>
          {options.map(([key, text]) => (
            <ListBox.Item key={key} id={key} textValue={text}>
              {text}
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ))}
        </ListBox>
      </Select.Popover>
    </Select>
  );
}
