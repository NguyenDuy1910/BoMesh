"use client";

import { StatusChip } from "@/components/ui/StatusChip";
import { useMessages } from "@/lib/i18n";
import { PROCESSING, PUBLICATION, type ProcessingKey, type PublicationKey } from "@/modules/curation/lifecycle";

import type { Contribution, Item } from "../api";
import { LIFECYCLE, lifecycleKey, type LifecycleKey } from "../model";

export type LifecycleChipProps = {
  size?: "sm" | "md" | "lg";
  /** Hide the description tooltip. */
  noTip?: boolean;
} & ({ lifecycle: LifecycleKey } | { item?: Item | null; contribution?: Contribution | null; lifecycle?: undefined });

/**
 * The one lifecycle label people see (preview `lifeChip`): In review, Changes requested, Not processed,
 * Processing, Published… Healthy end states are quiet (tertiary) and live states pulse.
 */
export function LifecycleChip(props: LifecycleChipProps) {
  const key = props.lifecycle ?? lifecycleKey({ item: props.item, contribution: props.contribution });
  const life = LIFECYCLE[key];
  const text = useMessages().state.lifecycle[key];
  return (
    <StatusChip
      label={text.label}
      tone={life.tone}
      variant={life.quiet ? "tertiary" : "soft"}
      dot
      live={!!life.live}
      size={props.size ?? "sm"}
      tooltip={props.noTip ? undefined : text.desc}
    />
  );
}

/** A document's processing state on its own (the Studio shows it apart from publication); Processed is quiet. */
export function ProcessingChip({ state, size = "sm" }: { state: ProcessingKey; size?: "sm" | "md" | "lg" }) {
  const p = PROCESSING[state];
  const text = useMessages().state.processing[state];
  return <StatusChip label={text.label} tone={p.tone} variant={state === "ready" ? "tertiary" : "soft"} dot live={!!p.live} size={size} tooltip={text.desc} />;
}

/** Whether readers can see a document, apart from processing; Published is quiet. */
export function PublicationChip({ state, size = "sm" }: { state: PublicationKey; size?: "sm" | "md" | "lg" }) {
  const text = useMessages().state.publication[state];
  return <StatusChip label={text.label} tone={PUBLICATION[state].tone} variant={state === "published" ? "tertiary" : "soft"} dot size={size} tooltip={text.desc} />;
}
