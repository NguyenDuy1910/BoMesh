"use client";

import { ShieldCheck } from "lucide-react";

import { StatusChip } from "@/components/ui/StatusChip";
import { Tip } from "@/components/ui/Tip";

import { TRUST, trustOf, type Resource } from "../model";
import { useMember } from "../queries";

/** The trust note with the verifier's name resolved ("Verified by Lan on 3 Nov 2026 · next review …"). */
export function useTrust(resource: Resource) {
  const verifier = useMember(resource.trust.state === "verified" || resource.trust.state === "review" ? resource.trust.verifier : null);
  return verifier.data?.displayName ? trustOf(resource.item, { personal: resource.isPersonal, verifierName: verifier.data.displayName }) : resource.trust;
}

export interface TrustChipProps {
  resource: Resource;
  /** Lists: hide "Not verified" (details show it). */
  quiet?: boolean;
  size?: "sm" | "md" | "lg";
}

/** Trust chip (preview `X.res.trustChip`): Verified · Review due · Not verified; nothing for personal files. */
export function TrustChip({ resource, quiet = false, size = "sm" }: TrustChipProps) {
  const trust = useTrust(resource);
  if (trust.state === "personal" || (quiet && trust.state === "unverified")) return null;
  const meta = TRUST[trust.state];
  return <StatusChip label={meta.label} tone={meta.tone} icon={meta.icon} size={size} tooltip={trust.note || meta.desc} />;
}

/** Card trust (preview `trustMark`): a quiet ✓ for Verified, a Review due chip; nothing otherwise. */
export function TrustMark({ resource }: { resource: Resource }) {
  const trust = useTrust(resource);
  if (trust.state === "verified") {
    return (
      <Tip content={trust.note}>
        <span className="doc-card__ok">
          <ShieldCheck className="i i-sm" aria-hidden />
          <span className="sr-only">Verified</span>
        </span>
      </Tip>
    );
  }
  if (trust.state !== "review") return null;
  return <StatusChip label={TRUST.review.label} tone="warning" icon={TRUST.review.icon} size="sm" tooltip={trust.note} />;
}
