import { Badge } from "@/components/ui/Badge";
import { statusOf, type StatusKind, type StatusValue } from "@/lib/status";

export interface StatusBadgeProps<K extends StatusKind> {
  kind: K;
  /** A `kind` key from `lib/status.ts` — translate backend enums with its `*StatusKey` helpers. */
  value: StatusValue<K> | (string & {}) | null | undefined;
  /** Dense lists: dot only, label kept for screen readers. */
  dotOnly?: boolean;
  className?: string;
}

/**
 * A status in the product's one vocabulary: tone, wording, quiet rendering
 * for healthy steady states and the live pulse all come from `lib/status.ts`.
 * Unknown values render neutral with a humanised label.
 */
export function StatusBadge<K extends StatusKind>({ kind, value, dotOnly, className }: StatusBadgeProps<K>) {
  const spec = statusOf(kind, value);
  return (
    <Badge className={className} dotOnly={dotOnly} live={spec.live} plain={spec.plain} tone={spec.tone}>
      {spec.label}
    </Badge>
  );
}
