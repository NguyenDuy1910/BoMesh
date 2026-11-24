"use client";

import { buttonVariants } from "@heroui/react";
import clsx from "clsx";
import { Calendar, Inbox, MessageSquare, type LucideIcon } from "lucide-react";
import NextLink from "next/link";
import type { ReactNode } from "react";

import { EmptyState, ItemIcon, List, ListItem } from "@/components/ui";
import { fmtDate, fmtDateTime, fmtTime } from "@/lib/format";

import type { UpNextItem, UpNextKind } from "../queries";

const KIND_ICON: Readonly<Record<UpNextKind, LucideIcon>> = { event: Calendar, reply: MessageSquare, queue: Inbox };
const DAY = 86_400_000;

function dayDiff(at: number): number {
  const start = (t: number) => new Date(t).setHours(0, 0, 0, 0);
  return Math.round((start(at) - start(Date.now())) / DAY);
}

/** Relative, human wording for an up-next item (preview `when`): "Needs your reply", "Tomorrow, 9:00 AM", "Oldest due in 3 days". */
export function upNextWhen(item: Pick<UpNextItem, "kind" | "at">): { text: string; tone: "" | "soon" | "danger" } {
  if (item.kind === "reply") return { text: "Cần bạn phản hồi", tone: "soon" };
  const at = Date.parse(item.at);
  const due = item.kind === "queue";
  if (at < Date.now()) return { text: due ? `Quá hạn lâu nhất · ${fmtDate(at)}` : fmtDate(at), tone: due ? "danger" : "" };
  const d = dayDiff(at);
  const day = d <= 0 ? `hôm nay, ${fmtTime(at)}` : d === 1 ? `ngày mai, ${fmtTime(at)}` : d < 7 ? `sau ${d} ngày` : fmtDate(at);
  return { text: due ? `Hạn sớm nhất ${day}` : day[0].toUpperCase() + day.slice(1), tone: due && d <= 1 ? "soon" : "" };
}

export interface UpNextListProps {
  items: readonly UpNextItem[];
  /** Inside one space: drop the space name from each row. */
  space?: string;
  /** Replaces the default "You're all caught up" state. */
  empty?: ReactNode;
  /** Extra trailing controls for a row (e.g. an event menu for space staff). */
  renderActions?: (item: UpNextItem) => ReactNode;
}

/** List of up-next items, each with one action (preview `X.upNextList`). */
export function UpNextList({ items, space, empty, renderActions }: UpNextListProps) {
  if (!items.length)
    return (
      <>
        {empty ?? (
          <EmptyState icon={Calendar} title="Bạn đã xử lý hết" description="Hạn chót, bài kiểm tra và yêu cầu cần bạn xử lý sẽ hiển thị ở đây." compact boxed />
        )}
      </>
    );
  return (
    <List className="upnext">
      {items.map((it) => {
        const w = upNextWhen(it);
        const a = it.action;
        return (
          <ListItem
            key={it.id}
            lead={<ItemIcon icon={KIND_ICON[it.kind]} tone={w.tone === "danger" ? "danger" : w.tone === "soon" ? "warning" : undefined} size="sm" />}
            title={it.title}
            contentTitle
            description={
              <>
                <span className={clsx("upnext-when", w.tone && `upnext-when--${w.tone}`)} title={fmtDateTime(it.at)}>
                  {w.text}
                </span>
                {!space && it.spaceName ? (
                  <>
                    {" · "}
                    <span translate="no">{it.spaceName}</span>
                  </>
                ) : null}
              </>
            }
            actions={
              a || renderActions ? (
                <>
                  {a ? (
                    <NextLink href={a.href} className={buttonVariants({ size: "sm", variant: a.strong ? "secondary" : "tertiary" })}>
                      {a.label}
                    </NextLink>
                  ) : null}
                  {renderActions?.(it)}
                </>
              ) : undefined
            }
          />
        );
      })}
    </List>
  );
}
