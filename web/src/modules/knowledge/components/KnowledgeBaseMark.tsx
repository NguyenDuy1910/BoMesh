import { Globe, Lock, User } from "lucide-react";

import { paletteIndex } from "@/components/ui/interaction";
import { PreviewTag } from "@/components/ui/PreviewTag";
import { cn } from "@/lib/cn";
import type { AccessSummary } from "@/modules/knowledge/model";

/* Written out in full so Tailwind generates every palette class. */
const PALETTE = [
  "bg-avatar-1",
  "bg-avatar-2",
  "bg-avatar-3",
  "bg-avatar-4",
  "bg-avatar-5",
  "bg-avatar-6",
  "bg-avatar-7",
  "bg-avatar-8",
  "bg-avatar-9",
  "bg-avatar-10",
] as const;

const SIZES = {
  sm: "size-5 rounded-[5px] text-[length:var(--text-size-caption)] [&_svg]:size-3",
  md: "size-8 rounded-[var(--radius-md)] text-[length:var(--text-size-body)] [&_svg]:size-4",
  lg: "size-9 rounded-[9px] text-[length:var(--text-size-section)] [&_svg]:size-[18px]",
} as const;

/**
 * A knowledge base's tile: its initial on a colour derived from its id, a
 * person for My files, a lock for one the caller cannot open. Decorative —
 * the name is always written beside it.
 */
export function KnowledgeBaseMark({
  id,
  title,
  personal = false,
  locked = false,
  size = "lg",
  className,
}: {
  id: string;
  title: string;
  personal?: boolean;
  locked?: boolean;
  size?: keyof typeof SIZES;
  className?: string;
}) {
  const quiet = personal || locked;
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-grid shrink-0 place-items-center font-semibold leading-none tracking-[-0.02em]",
        quiet ? "bg-[var(--surface-inset)] text-[var(--text-secondary)]" : cn("text-[var(--text-on-accent)]", PALETTE[paletteIndex(id, PALETTE.length)]),
        SIZES[size],
        className,
      )}
    >
      {locked ? <Lock /> : personal ? <User /> : (title.trim()[0] ?? "K").toUpperCase()}
    </span>
  );
}

const ACCESS_ICON = { me: User, workspace: Globe, restricted: Lock } as const;

/**
 * Who can see a knowledge base, quietly: "Only you", "Everyone", "Restricted".
 * `pill` is the header chip; `local` marks general access kept in this
 * browser (`collection.general_access` is pending).
 */
export function AccessBadge({
  access,
  pill = false,
  sentence = false,
  local = false,
  className,
}: {
  access: AccessSummary;
  pill?: boolean;
  /** The whole sentence ("Only people added can view"), for details panels. */
  sentence?: boolean;
  local?: boolean;
  className?: string;
}) {
  const Icon = ACCESS_ICON[access.key];
  return (
    <span className={cn("inline-flex items-center gap-1.5", className)}>
      <span
        className={cn(
          "inline-flex items-center gap-[5px] whitespace-nowrap text-[length:var(--text-size-meta)]",
          pill
            ? "h-6 rounded-full bg-[var(--surface-inset)] px-[9px] font-medium text-[var(--text-secondary)]"
            : sentence
              ? "text-[13.5px] text-[var(--text-primary)]"
              : "text-[var(--text-tertiary)]",
        )}
        title={sentence ? undefined : access.long}
      >
        <Icon aria-hidden="true" className={cn("size-3.5", sentence && "size-4 text-[var(--text-tertiary)]")} />
        {sentence ? access.long : access.label}
        {!sentence && <span className="sr-only">: {access.long}</span>}
      </span>
      {local && <PreviewTag />}
    </span>
  );
}
