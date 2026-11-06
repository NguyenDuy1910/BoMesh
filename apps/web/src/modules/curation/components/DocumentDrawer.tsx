"use client";

import { Button } from "@heroui/react";
import { Archive, CircleCheck, CircleX, Clock, Download, ExternalLink, EyeOff, File as FileGlyph, Pencil, RefreshCw, Upload, Users, type LucideIcon } from "lucide-react";
import NextLink from "next/link";

import { Callout, EmptyState, FileIcon, IconButton, ItemIcon, KeyValue, type Tone } from "@/components/ui";
import { resourceId } from "@/lib/api/client";
import { fmtDateTime, fmtSize } from "@/lib/format";
import { LifecycleChip } from "@/modules/knowledge/components/LifecycleChip";
import { ResourceDetails } from "@/modules/knowledge/components/ResourceDetails";
import { kindMeta, LIFECYCLE } from "@/modules/knowledge/model";
import { useKnowledgeModel, useMemberNames, useSource } from "@/modules/knowledge/queries";

import { isLocked, opsFor, type DocRow } from "../model";
import { CurationDrawer } from "./CurationDrawer";
import { OP_META, useDocOps } from "./useDocOps";

const EVENTS: Readonly<Record<string, [LucideIcon, string, Tone | undefined]>> = {
  SUBMITTED: [Upload, "Submitted", undefined],
  RESUBMITTED: [Upload, "Resubmitted", undefined],
  CHANGES_REQUESTED: [Pencil, "Changes requested", "warning"],
  REJECTED: [CircleX, "Declined", "danger"],
  APPROVED: [CircleCheck, "Approved", "success"],
  WITHDRAWN: [Archive, "Withdrawn", undefined],
};

interface TimelineEntry {
  icon: LucideIcon;
  tone?: Tone;
  label: string;
  by?: string;
  text?: string;
  at: string;
}

/** One document (preview `DR['cur-doc']`): lifecycle, history, details and the actions its state allows. */
export function DocumentDrawer({ row, onClose, contributorName }: { row: DocRow | null; onClose: () => void; contributorName: string }) {
  const ops = useDocOps();
  if (!row) return <CurationDrawer isOpen={false} onClose={onClose} title="">{null}</CurationDrawer>;
  const { main, more, tail } = opsFor(row);
  const opBtn = (op: typeof main, variant: "primary" | "tertiary") => {
    const meta = OP_META[op];
    const Icon = meta.icon;
    return (
      <Button key={op} variant={variant} onPress={() => ops.run(op, row, onClose)}>
        <Icon className="i" aria-hidden />
        {meta.label}
      </Button>
    );
  };
  return (
    <CurationDrawer
      isOpen
      onClose={onClose}
      size="lg"
      lead={<FileIcon name={row.fileName} mime={row.mime} size="lg" />}
      title={<span translate="no">{row.title}</span>}
      description={<span translate="no">{row.baseName}</span>}
      headActions={
        <>
          {main !== "open" && row.item ? <IconButton icon={ExternalLink} tip="Open" onPress={() => ops.run("open", row, onClose)} /> : null}
          {tail.includes("download") ? <IconButton icon={Download} tip="Download" onPress={() => ops.run("download", row)} /> : null}
        </>
      }
      footerStart={
        tail.includes("archive") ? (
          <Button variant="ghost" onPress={() => ops.run("archive", row, onClose)}>
            <Archive className="i" aria-hidden />
            Archive
          </Button>
        ) : null
      }
      footer={
        <>
          {more.filter((op) => op !== "open" && op !== "move").map((op) => opBtn(op, "tertiary"))}
          {opBtn(main, "primary")}
        </>
      }
    >
      <DrawerBody row={row} contributorName={contributorName} />
    </CurationDrawer>
  );
}

function DrawerBody({ row, contributorName }: { row: DocRow; contributorName: string }) {
  const { toResource, ctx } = useKnowledgeModel();
  const c = row.contribution;
  const events = (c?.events ?? []).filter((e) => e.kind !== "ANALYZED");
  const memberNames = useMemberNames([...events.map((e) => e.actor), c?.decision?.reviewer]);
  const source = useSource(row.source);
  const life = LIFECYCLE[row.lifecycle];
  const k = row.lifecycle;
  const lastNote = [...events].reverse().find((e) => e.kind === "CHANGES_REQUESTED" || e.kind === "REJECTED");
  const indexError = row.item?.document?.indexingError?.message;

  const note =
    k === "failed" ? (
      <Callout tone="danger" title="Couldn’t publish" description={isLocked(row.item) ? indexError : indexError || "Publishing stopped partway. Try again."} />
    ) : k === "update" ? (
      <Callout tone="warning" title="The original changed" description="Answers use the previous version until you publish the update." />
    ) : (k === "changes" || k === "rejected") && lastNote?.message ? (
      <blockquote className="cur-tl__text">
        “<span translate="no">{lastNote.message}</span>” — {memberNames.get(lastNote.actor ?? "") || "A reviewer"}
      </blockquote>
    ) : null;

  const timeline: TimelineEntry[] = events.length
    ? events.map((e) => {
        const [icon, label, tone] = EVENTS[e.kind ?? ""] ?? [Clock, e.kind ?? "", undefined];
        const by = e.actor ? memberNames.get(e.actor) : e.kind === "SUBMITTED" ? contributorName : "";
        return { icon, tone, label, by, text: e.message, at: e.createTime ?? "" };
      })
    : [
        row.source
          ? { icon: RefreshCw, label: `Synced from ${source.data?.displayName || "a source"}`, at: row.item?.createTime ?? row.updated }
          : { icon: Upload, label: "Added", by: contributorName, at: row.item?.createTime ?? row.updated },
      ];
  if (k === "unpublished") timeline.push({ icon: EyeOff, label: "Unpublished", at: row.item?.updateTime ?? "" });
  if (k === "published") timeline.push({ icon: CircleCheck, tone: "success", label: "Published", at: row.item?.updateTime ?? row.updated });

  const published = !!row.item && row.item.document?.publicationState === "PUBLISHED" && !["analyzing", "review", "changes", "rejected", "withdrawn"].includes(k);
  return (
    <>
      <div className="drawer__section">
        <div className="row gap-8 wrap">
          <LifecycleChip lifecycle={row.lifecycle} size="md" />
        </div>
        <p className="t-sm muted mt-8">{life.desc}</p>
        {note ? <div className="mt-12">{note}</div> : null}
      </div>
      <div className="drawer__section">
        <h3 className="drawer__section-title">History</h3>
        <ol className="cur-tl">
          {timeline.map((x, i) => (
            <li key={i} className="cur-tl__item">
              <ItemIcon icon={x.icon} tone={x.tone} size="sm" />
              <div className="grow">
                <div className="t-sm">
                  <span className="medium">{x.label}</span>
                  {x.by ? ` · ${x.by}` : ""}
                </div>
                {x.text ? (
                  <div className="cur-tl__text">
                    “<span translate="no">{x.text}</span>”
                  </div>
                ) : null}
                <div className="t-xs muted">{fmtDateTime(x.at)}</div>
              </div>
            </li>
          ))}
        </ol>
      </div>
      <div className="drawer__section">
        <h3 className="drawer__section-title">Details</h3>
        {row.item && published ? (
          <ResourceDetails resource={toResource(row.item)} />
        ) : row.item ? (
          <PendingDetails row={row} contributorName={contributorName} typeLabel={kindMeta(row.kind, ctx.documentTypes).label} />
        ) : (
          <EmptyState icon={FileGlyph} compact title="The file isn’t available" description="It’s back with its contributor." />
        )}
      </div>
    </>
  );
}

function PendingDetails({ row, contributorName, typeLabel }: { row: DocRow; contributorName: string; typeLabel: string }) {
  // The base it goes to decides who reads it once published (the server's audience summary when it has one).
  const who = row.contribution?.audienceSummary || (row.baseName ? `Readers of ${row.baseName}` : "—");
  return (
    <KeyValue
      pairs={[
        [
          "Knowledge base",
          row.base ? (
            <NextLink className="link" href={`/knowledge/${resourceId(row.base)}`} translate="no">
              {row.baseName}
            </NextLink>
          ) : (
            "—"
          ),
        ],
        ["Contributor", contributorName || "—"],
        ["Type", typeLabel],
        ["Size", fmtSize(row.item?.document?.sizeBytes)],
        [
          "Who could see it",
          <span key="who" className="row gap-6">
            <Users className="i i-sm muted" aria-hidden />
            {who}
          </span>,
        ],
      ]}
    />
  );
}
