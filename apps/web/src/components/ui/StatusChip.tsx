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
  doc: { ready: ["success", "Sẵn sàng", "tertiary"], processing: ["accent", "Đang xử lý", "soft", 1], pending: ["default", "Đang chờ"], failed: ["danger", "Lỗi"], outdated: ["warning", "Cần cập nhật"], unsupported: ["default", "Chưa tra cứu được"] },
  source: { healthy: ["success", "Mới nhất", "tertiary"], syncing: ["accent", "Đang đồng bộ", "soft", 1], failed: ["danger", "Không đồng bộ được"], reconnect: ["danger", "Cần kết nối lại"], paused: ["default", "Đã tạm dừng"] },
  account: { connected: ["success", "Đã kết nối", "tertiary"], expired: ["danger", "Cần kết nối lại"], error: ["warning", "Không kết nối được"], disabled: ["default", "Đã tắt"] },
  run: { queued: ["accent", "Đang chờ", "soft", 1], running: ["accent", "Đang xử lý", "soft", 1], completed: ["success", "Đã hoàn thành", "tertiary"], partial: ["warning", "Đã hoàn tất nhưng có sự cố"], failed: ["danger", "Lỗi"], cancelled: ["default", "Đã hủy"] },
  member: { active: ["success", "Đang hoạt động", "tertiary"], suspended: ["danger", "Đã tạm ngưng"], invited: ["accent", "Đã mời"] },
  request: { pending: ["warning", "Đang chờ"], approved: ["success", "Đã phê duyệt"], denied: ["default", "Đã từ chối"] },
  outcome: { success: ["success", "Thành công", "tertiary"], failure: ["danger", "Lỗi"] },
  ws: { active: ["success", "Đang hoạt động", "tertiary"], suspended: ["danger", "Đã tạm ngưng"], new: ["accent", "Đang thiết lập"] },
  service: { operational: ["success", "Hoạt động bình thường", "tertiary"], degraded: ["warning", "Suy giảm"], down: ["danger", "Sự cố"] },
  connector: { builtin: ["default", "Tích hợp sẵn"], enabled: ["success", "Đã bật", "tertiary"], disabled: ["default", "Đã tắt"], unavailable: ["default", "Không khả dụng"] },
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
