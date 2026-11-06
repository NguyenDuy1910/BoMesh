"use client";

import { Card } from "@heroui/react";
import type { LucideIcon } from "lucide-react";
import NextLink from "next/link";
import clsx from "clsx";
import type { ReactNode } from "react";
import type { Tone } from "./StatusChip";

export interface StatCardProps {
  icon: LucideIcon;
  /** Short metric label ("Questions this week"). */
  label: ReactNode;
  /** Formatted value (use `fmtNum`/`fmtCompact`). */
  value: ReactNode;
  /** One muted line under the value (trend, comparison, next step). */
  meta?: ReactNode;
  /** Colors the icon tile only. */
  tone?: Exclude<Tone, "default">;
  /** Makes the whole card a link. */
  href?: string;
  /** Makes the whole card a button. Ignored when `href` is set. */
  onPress?: () => void;
  /** Extra content under the meta line (sparkline, progress). */
  children?: ReactNode;
  className?: string;
}

/**
 * KPI card (preview `statCard()`, HeroUI CRM pattern): icon tile + label, value, meta.
 * Numbers appear only where they lead to an action, so prefer `href`/`onPress`.
 */
export function StatCard({ icon: Icon, label, value, meta, tone, href, onPress, children, className }: StatCardProps) {
  const body = (
    <>
      <div className="stat__label">
        <span className={clsx("stat__icon", tone && `stat__icon--${tone}`)}>
          <Icon className="i i-sm" aria-hidden />
        </span>
        {label}
      </div>
      <div className="stat__value">{value}</div>
      {meta ? <div className="stat__meta">{meta}</div> : null}
      {children}
    </>
  );
  const cls = clsx("stat", (href || onPress) && "card--action", className);
  if (href) {
    return (
      <Card<"a"> className={cls} render={(props) => <NextLink {...props} href={href} />}>
        {body}
      </Card>
    );
  }
  if (onPress) {
    return (
      <Card<"button"> className={cls} render={(props) => <button {...props} type="button" onClick={onPress} />}>
        {body}
      </Card>
    );
  }
  return <Card className={cls}>{body}</Card>;
}
