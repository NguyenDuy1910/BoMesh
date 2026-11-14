"use client";

import { Button, buttonVariants } from "@heroui/react";
import clsx from "clsx";
import { Link as LinkIcon, Lock, Pencil } from "lucide-react";
import NextLink from "next/link";
import type { ReactNode } from "react";

import { StatusChip } from "@/components/ui/StatusChip";
import { toast } from "@/components/ui/Toast";
import { resourceId } from "@/lib/api/client";
import { fmtDate } from "@/lib/format";

import type { Resource } from "../../model";
import { useItem, useMemberNames } from "../../queries";
import { openEditDetails } from "../../components/dialogs";
import { ResourceDetails } from "../../components/ResourceDetails";
import type { ItemRevision } from "../api";
import { revisionNumber } from "../links";

/** A titled rail section (preview `railSec`). */
export function RailSection({ title, extra, children }: { title: string; extra?: ReactNode; children: ReactNode }) {
  return (
    <section className="rdr-sec">
      <div className="rdr-sec__head">
        <h3 className="rdr-sec__title">{title}</h3>
        {extra}
      </div>
      {children}
    </section>
  );
}

export interface AboutPaneProps {
  resource: Resource;
  canEdit: boolean;
  revisions: readonly ItemRevision[] | undefined;
  /** Revision number on screen. */
  viewing: number;
  /** Current revision number. */
  current: number;
  onView: (v: number | undefined) => void;
}

/**
 * About tab (preview `aboutPane`): details (type, topics, owner, collection, source/provenance, trust,
 * version, who can see it; Edit for editors), the source link and the collection's access for its
 * owners, then the version history (View an older version → `?v=`).
 */
export function AboutPane({ resource: r, canEdit, revisions, viewing, current, onView }: AboutPaneProps) {
  const base = useItem(r.isPersonal ? null : r.base?.id);
  const owner = base.data?.access === "OWNER" && !r.isPersonal;
  const names = useMemberNames((revisions ?? []).map((v) => v.creator));
  const copySource = async () => {
    try {
      await navigator.clipboard.writeText(r.source.url);
      toast("Source link copied");
    } catch {
      toast("Couldn’t copy the link", { tone: "danger" });
    }
  };
  const acts = [
    r.source.url && (
      <Button key="src" size="sm" variant="ghost" onPress={() => void copySource()}>
        <LinkIcon className="i" aria-hidden />
        Copy source link
      </Button>
    ),
    owner && r.base && (
      <NextLink key="access" href={`/studio/collections/${resourceId(r.base.id)}?tab=access`} className={buttonVariants({ variant: "ghost", size: "sm" })}>
        <Lock className="i" aria-hidden />
        Manage access
      </NextLink>
    ),
  ].filter(Boolean);

  return (
    <>
      <RailSection
        title="Details"
        extra={
          canEdit ? (
            <Button size="sm" variant="ghost" aria-label="Edit details" onPress={() => openEditDetails(r.name)}>
              <Pencil className="i" aria-hidden />
              Edit
            </Button>
          ) : null
        }
      >
        <ResourceDetails resource={r} />
      </RailSection>
      {acts.length ? <div className="rdr-acts">{acts}</div> : null}
      <RailSection title="Version history">
        {revisions?.length ? (
          <ol className="rdr-vers">
            {revisions.map((v) => {
              const n = revisionNumber(v.name) ?? Number(resourceId(v.name));
              const cur = n === current;
              const on = n === viewing;
              const by = v.creator ? names.get(v.creator) : undefined;
              return (
                <li key={v.name} className={clsx("rdr-ver", on && "is-on")}>
                  <span className="rdr-ver__v num">v{n}</span>
                  <span className="rdr-ver__body">
                    <span className="rdr-ver__note" translate={v.changeSummary ? "no" : undefined}>
                      {v.changeSummary || "Updated"}
                    </span>
                    <span className="rdr-ver__meta">
                      {fmtDate(v.createTime)}
                      {by ? ` · ${by}` : ""}
                    </span>
                  </span>
                  <span className="rdr-ver__trail">
                    {cur ? (
                      <StatusChip label="Current" tone={on ? "accent" : "default"} size="sm" />
                    ) : on ? (
                      <StatusChip label="Viewing" tone="accent" size="sm" />
                    ) : (
                      <button type="button" className="link-button" onClick={() => onView(n)}>
                        View
                      </button>
                    )}
                  </span>
                </li>
              );
            })}
          </ol>
        ) : (
          <p className="rdr-none">{revisions ? "No earlier versions." : "Loading versions…"}</p>
        )}
      </RailSection>
    </>
  );
}
