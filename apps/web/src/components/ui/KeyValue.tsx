import type { ReactNode } from "react";

/** One `[label, value]` pair; falsy entries are skipped so callers can inline conditions. */
export type KeyValuePair = readonly [ReactNode, ReactNode];

export interface KeyValueProps {
  pairs: ReadonlyArray<KeyValuePair | false | null | undefined>;
  className?: string;
}

/** Description list (preview `kv()`): muted labels column, values wrap anywhere. */
export function KeyValue({ pairs, className }: KeyValueProps) {
  return (
    <dl className={className ? `kv ${className}` : "kv"}>
      {pairs.map((pair, index) =>
        pair ? (
          <div key={index} className="kv__row">
            <dt>{pair[0]}</dt>
            <dd>{pair[1]}</dd>
          </div>
        ) : null,
      )}
    </dl>
  );
}
