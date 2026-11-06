"use client";

import { StatusChip } from "@/components/ui/StatusChip";

import type { Contribution, Item } from "../api";
import { LIFECYCLE, lifecycleKey, type LifecycleKey } from "../model";

export type LifecycleChipProps = {
  size?: "sm" | "md" | "lg";
  /** Hide the description tooltip. */
  noTip?: boolean;
} & ({ lifecycle: LifecycleKey } | { item?: Item | null; contribution?: Contribution | null; lifecycle?: undefined });

/**
 * The one lifecycle label people see (preview `lifeChip`): In review, Changes requested,
 * Publishing, Published… Healthy end states are quiet (tertiary) and live states pulse.
 */
export function LifecycleChip(props: LifecycleChipProps) {
  const key = props.lifecycle ?? lifecycleKey({ item: props.item, contribution: props.contribution });
  const life = LIFECYCLE[key];
  return (
    <StatusChip
      label={life.label}
      tone={life.tone}
      variant={life.quiet ? "tertiary" : "soft"}
      dot
      live={!!life.live}
      size={props.size ?? "sm"}
      tooltip={props.noTip ? undefined : life.desc}
    />
  );
}
