"use client";

import { ArrowRight, Inbox } from "lucide-react";
import NextLink from "next/link";
import { useState } from "react";

import { EmptyState, Gate, List, Segmented, SkeletonRows } from "@/components/ui";
import { RequestRow } from "@/modules/requests/components/RequestRow";
import { byUpdated, createdMs, isActive } from "@/modules/requests/model";

import { useSpaceQueue } from "../queries";
import type { SpaceView } from "./context";

/** Questions / Requests (preview `queueTab`, staff): the space's queue, open oldest first or closed newest first. */
export function QueueTab({ view, noun }: { view: SpaceView; noun: string }) {
  const queue = useSpaceQueue(view.sid);
  const [show, setShow] = useState<"open" | "closed">("open");
  const all = queue.data ?? [];
  const open = all.filter(isActive).sort((a, b) => createdMs(a) - createdMs(b));
  const closed = all.filter((r) => !isActive(r)).sort(byUpdated);
  const rows = show === "closed" ? closed : open;

  return (
    <>
      <div className="toolbar">
        <Segmented
          label="Show"
          value={show}
          onChange={(v) => setShow(v as "open" | "closed")}
          options={[
            { value: "open", label: `Open · ${open.length}` },
            { value: "closed", label: "Closed" },
          ]}
        />
        <div className="toolbar__end">
          <NextLink className="link-button" href="/requests?tab=queue">
            Open in Requests
            <ArrowRight className="i i-sm" aria-hidden />
          </NextLink>
        </div>
      </div>
      <Gate
        query={queue}
        skeleton={<SkeletonRows rows={4} />}
        isEmpty={!rows.length}
        empty={
          <EmptyState
            icon={Inbox}
            boxed
            compact
            title={show === "closed" ? `No closed ${noun} yet` : `No open ${noun}`}
            description={show === "closed" ? undefined : "You’re all caught up. New ones show up here and in Requests."}
          />
        }
      >
        <List>
          {rows.map((r) => (
            <RequestRow key={r.name} request={r} />
          ))}
        </List>
      </Gate>
    </>
  );
}
