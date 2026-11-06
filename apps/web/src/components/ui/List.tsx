"use client";

import NextLink from "next/link";
import clsx from "clsx";
import type { ReactNode } from "react";

export interface ListProps {
  /** `plain` drops the card surface (rows separated, no box). */
  plain?: boolean;
  className?: string;
  children: ReactNode;
}

/** Card-surface list of rows (preview `list()`, ListBox composition). Children are `ListItem`s. */
export function List({ plain, className, children }: ListProps) {
  return <div className={clsx("list", plain && "list--plain", className)}>{children}</div>;
}

export interface ListItemProps {
  /** Leading avatar / icon tile / file icon. */
  lead?: ReactNode;
  /** Row title; truncated to one line. */
  title: ReactNode;
  /** Chips or marks after the title. */
  titleExtra?: ReactNode;
  /** Muted second line. */
  description?: ReactNode;
  /** Right-aligned muted meta (time, count). */
  meta?: ReactNode;
  /** Trailing controls (buttons, menus); they stay independent of the row activation. */
  actions?: ReactNode;
  /** Navigates on activation (the row is a link). */
  href?: string;
  /** Activates the row (the row is a button). Ignored when `href` is set. */
  onPress?: () => void;
  /** Accessible name of the row action; defaults to `title` when it is a string. */
  label?: string;
  /** Unread dot after the title. */
  unread?: boolean;
  /** Title is user/workspace content: `translate="no"` so the DOM localizer leaves it as written. */
  contentTitle?: boolean;
  className?: string;
}

/**
 * List row (preview `item()`): lead, title (+ extra), description, meta, trailing actions.
 * With `href`/`onPress` the whole row activates; trailing actions remain separate controls
 * (a stretched link/button sits under them, so there is no nested interactive content).
 */
export function ListItem({ lead, title, titleExtra, description, meta, actions, href, onPress, label, unread, contentTitle, className }: ListItemProps) {
  const interactive = Boolean(href || onPress);
  const name = label ?? (typeof title === "string" ? title : undefined);
  return (
    <div className={clsx("item", interactive && "item--action", unread && "item--unread", className)}>
      {href ? (
        <NextLink className="item__hit" href={href} aria-label={name} />
      ) : onPress ? (
        <button type="button" className="item__hit" aria-label={name} onClick={onPress} />
      ) : null}
      {lead ? <span className="item__lead">{lead}</span> : null}
      <span className="item__body">
        <span className="item__title">
          <span className="truncate" translate={contentTitle ? "no" : undefined}>
            {title}
          </span>
          {titleExtra}
        </span>
        {description ? <span className="item__desc">{description}</span> : null}
      </span>
      {meta ? <span className="item__meta">{meta}</span> : null}
      {actions ? <span className="item__trail">{actions}</span> : null}
    </div>
  );
}
