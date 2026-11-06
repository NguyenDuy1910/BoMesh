"use client";

import { EmptyState as HeroEmptyState } from "@heroui/react";
import { Inbox, type LucideIcon } from "lucide-react";
import clsx from "clsx";
import type { ReactNode } from "react";
import type { Tone } from "./StatusChip";

export interface EmptyStateProps {
  icon?: LucideIcon;
  /** Tints the icon tile (`danger` for failures, `success` for "all done"). */
  tone?: Exclude<Tone, "warning">;
  title: ReactNode;
  description?: ReactNode;
  /** Recovery or first-use action buttons. */
  actions?: ReactNode;
  /** Card surface around the state (inside pages; omit inside cards/tables). */
  boxed?: boolean;
  /** Less padding (filtered lists, panels, menus). */
  compact?: boolean;
  className?: string;
}

/**
 * Empty state (preview `emptyState()`, HeroUI EmptyState): icon tile, title, description, actions.
 * First use, no results, no access and failure each get their own copy and recovery.
 */
export function EmptyState({ icon: Icon = Inbox, tone, title, description, actions, boxed, compact, className }: EmptyStateProps) {
  return (
    <HeroEmptyState className={clsx(boxed && "empty-state--boxed", compact && "empty-state--compact", className)} role="status">
      <div className={clsx("empty-state__icon", tone && tone !== "default" && `empty-state__icon--${tone}`)}>
        <Icon className="i i-lg" aria-hidden />
      </div>
      <div className="empty-state__title">{title}</div>
      {description ? <div className="empty-state__description">{description}</div> : null}
      {actions ? <div className="empty-state__actions">{actions}</div> : null}
    </HeroEmptyState>
  );
}
