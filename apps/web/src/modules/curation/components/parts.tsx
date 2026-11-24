"use client";

import { buttonVariants, Label, ListBox, Select } from "@heroui/react";
import type { LucideIcon } from "lucide-react";
import NextLink from "next/link";
import type { ReactNode } from "react";

import { PreviewChip } from "@/components/ui";
import { useLazyOptions } from "@/components/ui/useLazyOptions";
import { useWorkspace } from "@/lib/workspace";
import { useSource } from "@/modules/knowledge/queries";

/** The section header's *Demo data* chip in demo workspaces. */
export function DemoChip() {
  const { workspace } = useWorkspace();
  return workspace.demo ? <PreviewChip label="Dữ liệu mẫu" tooltip="Không gian làm việc này chứa nội dung minh họa hư cấu." /> : null;
}

/** A source's display name ("Source sync" while unknown). */
export function SourceName({ source }: { source: string | undefined }) {
  const src = useSource(source);
  return <>{src.data?.displayName || "Đồng bộ nguồn dữ liệu"}</>;
}

/** A field's one status tag (`cur-tag`, preview `fieldTag`): Edited once the reviewer changed it, else Suggestion for
 *  the assistant's value, with its confidence when there is one. */
export function FieldTag({ edited, suggested, value }: { edited?: boolean; suggested?: boolean; value?: number | null }) {
  if (edited) return <span className="cur-tag cur-tag--edited">Đã sửa</span>;
  if (value != null) {
    return (
      <span className="cur-tag cur-tag--ai" title="Mức chắc chắn của trợ lý">
        {`Gợi ý · ${Math.round(value * 100)}%`}
      </span>
    );
  }
  return suggested ? <span className="cur-tag cur-tag--ai">Gợi ý</span> : null;
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
