"use client";

import { Chip } from "@heroui/react";
import type { LucideIcon } from "lucide-react";
import clsx from "clsx";
import { Tip } from "./Tip";

/** Semantic tone shared by chips, alerts, avatars, icon tiles and toasts. */
export type Tone = "default" | "accent" | "success" | "warning" | "danger";
/** Chip variant: `soft` (tinted, default), `primary` (solid), `tertiary` (text only, quiet), `outline`. */
export type ChipVariant = "soft" | "primary" | "tertiary" | "outline";

/** `[tone, label, variant?, live?]` — preview STATUS tuple. */
type StatusEntry = readonly [Tone, string, ChipVariant?, 1?];

/**
 * Status vocabulary — one place, plain language (preview `STATUS` in ui.js).
 * Healthy steady states are quiet (tertiary); action-required states are soft + dot;
 * in-flight states pulse (`live`).
 */
export const STATUS = {
  doc: { ready: ["success", "Ready", "tertiary"], processing: ["accent", "Processing", "soft", 1], pending: ["default", "Waiting"], failed: ["danger", "Failed"], outdated: ["warning", "Needs update"], unsupported: ["default", "Not searchable"] },
  source: { healthy: ["success", "Up to date", "tertiary"], syncing: ["accent", "Syncing", "soft", 1], failed: ["danger", "Sync failed"], reconnect: ["danger", "Reconnect needed"], paused: ["default", "Paused"] },
  account: { connected: ["success", "Connected", "tertiary"], expired: ["danger", "Reconnect needed"], error: ["warning", "Can’t reach"], disabled: ["default", "Disabled"] },
  run: { queued: ["accent", "Queued", "soft", 1], running: ["accent", "In progress", "soft", 1], completed: ["success", "Completed", "tertiary"], partial: ["warning", "Completed with issues"], failed: ["danger", "Failed"], cancelled: ["default", "Cancelled"] },
  member: { active: ["success", "Active", "tertiary"], suspended: ["danger", "Suspended"], invited: ["accent", "Invited"] },
  request: { pending: ["warning", "Pending"], approved: ["success", "Approved"], denied: ["default", "Denied"] },
  outcome: { success: ["success", "Succeeded", "tertiary"], failure: ["danger", "Failed"] },
  ws: { active: ["success", "Active", "tertiary"], suspended: ["danger", "Suspended"], new: ["accent", "Setting up"] },
  service: { operational: ["success", "Operational", "tertiary"], degraded: ["warning", "Degraded"], down: ["danger", "Outage"] },
  connector: { builtin: ["default", "Built in"], enabled: ["success", "Enabled", "tertiary"], disabled: ["default", "Disabled"], unavailable: ["default", "Not available"] },
} as const satisfies Record<string, Record<string, StatusEntry>>;

export type StatusKind = keyof typeof STATUS;
/** Known values of one status kind, e.g. `StatusValue<"run">` = `"queued" | "running" | …`. */
export type StatusValue<K extends StatusKind> = keyof (typeof STATUS)[K];

interface ChipLookProps {
  size?: "sm" | "md" | "lg";
  /** Tooltip explaining the state or the next step. */
  tooltip?: string;
  className?: string;
}

/** Status from the shared vocabulary: `<StatusChip kind="run" value={run.state} />`. Unknown values render a neutral chip. */
export interface StatusChipVocabularyProps extends ChipLookProps {
  kind: StatusKind;
  value: string | null | undefined;
}

/** Ad-hoc chip with the same anatomy (domain vocabularies such as lifecycle or trust). */
export interface StatusChipCustomProps extends ChipLookProps {
  kind?: undefined;
  label: string;
  tone?: Tone;
  variant?: ChipVariant;
  /** Leading status dot (default true unless `icon` is set). */
  dot?: boolean;
  /** Pulsing dot for in-flight states. */
  live?: boolean;
  /** Leading icon instead of the dot. */
  icon?: LucideIcon;
}

export type StatusChipProps = StatusChipVocabularyProps | StatusChipCustomProps;

/** Looks up a status tuple; `undefined` for unknown values. */
export function statusOf(kind: StatusKind, value: string | null | undefined): { tone: Tone; label: string; variant: ChipVariant; live: boolean } | undefined {
  const entry = value ? (STATUS[kind] as Record<string, StatusEntry>)[value] : undefined;
  if (!entry) return undefined;
  return { tone: entry[0], label: entry[1], variant: entry[2] ?? "soft", live: entry[3] === 1 };
}

/**
 * Status chip (preview `status(kind, value)` / `chip()`): label + dot or icon, never color alone.
 * Built on HeroUI Chip; `outline` and the dot/live marks are product additions.
 */
export function StatusChip(props: StatusChipProps) {
  let look: { tone: Tone; label: string; variant: ChipVariant; live: boolean; dot: boolean; icon?: LucideIcon };
  if (props.kind !== undefined) {
    const found = statusOf(props.kind, props.value);
    look = found ? { ...found, dot: true } : { tone: "default", label: String(props.value || "—"), variant: "soft", live: false, dot: false };
  } else {
    look = { tone: props.tone ?? "default", label: props.label, variant: props.variant ?? "soft", live: !!props.live, dot: props.dot ?? !props.icon, icon: props.icon };
  }
  const Icon = look.icon;
  const chip = (
    <Chip
      color={look.tone}
      variant={look.variant === "outline" ? "tertiary" : look.variant}
      size={props.size}
      className={clsx(look.variant === "outline" && "chip--outline", look.live && "chip--live", props.className)}
    >
      {Icon ? <Icon aria-hidden /> : look.dot ? <span className="chip__dot" aria-hidden /> : null}
      {look.label}
    </Chip>
  );
  return props.tooltip ? <Tip content={props.tooltip}>{chip}</Tip> : chip;
}
