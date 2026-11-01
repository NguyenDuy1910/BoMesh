import { Fragment } from "react";

import { cn } from "@/lib/cn";

/** Label/value pairs in a drawer (prototype `.kv`). Rows whose value is null or false are left out. */
export function Facts({ items }: { items: readonly (readonly [string, React.ReactNode])[] }) {
  return (
    <dl className="grid grid-cols-[140px_minmax(0,1fr)] gap-x-4 gap-y-2.5 text-[0.84375rem] max-[480px]:grid-cols-1 max-[480px]:gap-y-1">
      {items.map(([label, value]) =>
        value === null || value === undefined || value === false ? null : (
          <Fragment key={label}>
            <dt className="text-text-tertiary">{label}</dt>
            <dd className="m-0 min-w-0 break-words text-text-primary max-[480px]:mb-2">{value}</dd>
          </Fragment>
        ),
      )}
    </dl>
  );
}

/** The bordered list of rows used inside drawers and dialogs (prototype `.list`). */
export function RowList({ children, label }: { children: React.ReactNode; label?: string }) {
  return (
    <ul aria-label={label} className="m-0 list-none overflow-hidden rounded-lg border border-border-subtle p-0">
      {children}
    </ul>
  );
}

export function RowListItem({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <li className={cn("flex items-center gap-3 border-b border-border-subtle bg-surface-base px-4 py-3 last:border-b-0", className)}>
      {children}
    </li>
  );
}
