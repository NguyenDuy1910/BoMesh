"use client";

import { buttonVariants, Label, ListBox, Select } from "@heroui/react";
import type { LucideIcon } from "lucide-react";
import NextLink from "next/link";
import type { ReactNode } from "react";

import { PreviewChip } from "@/components/ui";
import { useLazyOptions } from "@/components/ui/useLazyOptions";
import { useWorkspace } from "@/lib/workspace";
import { useSource } from "@/modules/knowledge/queries";

import { confLevel } from "../model";

/** The section header's *Demo data* chip in demo workspaces. */
export function DemoChip() {
  const { workspace } = useWorkspace();
  return workspace.demo ? <PreviewChip label="Demo data" tooltip="This workspace holds fictional demo content." /> : null;
}

/** A source's display name ("Source sync" while unknown). */
export function SourceName({ source }: { source: string | undefined }) {
  const src = useSource(source);
  return <>{src.data?.displayName || "Source sync"}</>;
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

/**
 * Compact select with an accessible (visually hidden) label. Closed, it builds only the chosen option (what the
 * trigger shows): a list of hundreds of topics would otherwise be built on every render of the page around it.
 */
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
  const [shown, onOpenChange] = useLazyOptions(options, ([key]) => key === value);
  return (
    <Select aria-label={label} value={value || null} onChange={(v) => onChange(v == null ? "" : String(v))} onOpenChange={onOpenChange} className={className} placeholder={placeholder}>
      <Label className="sr-only">{label}</Label>
      <Select.Trigger>
        <Select.Value />
        <Select.Indicator />
      </Select.Trigger>
      <Select.Popover>
        <ListBox>
          {shown.map(([key, text]) => (
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
