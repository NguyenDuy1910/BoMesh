"use client";

import { Button } from "@heroui/react";
import {
  Archive,
  Check,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleX,
  Clock,
  EyeOff,
  File as FileGlyph,
  History,
  LoaderCircle,
  Minus,
  Pencil,
  RefreshCw,
  Upload,
  type LucideIcon,
} from "lucide-react";
import NextLink from "next/link";
import type { ReactNode } from "react";

import { Callout, Disclosure, EmptyState, FileIcon, ItemIcon, KeyValue, type Tone } from "@/components/ui";
import { resourceId } from "@/lib/api/client";
import { fmtDateTime, fmtSize, plural, rel } from "@/lib/format";
import { LifecycleChip } from "@/modules/knowledge/components/LifecycleChip";
import { ResourceDetails } from "@/modules/knowledge/components/ResourceDetails";
import { kindMeta } from "@/modules/knowledge/model";
import { useKnowledgeModel, useMemberNames, useSource } from "@/modules/knowledge/queries";

import { inSearch, changedAtSource } from "../lifecycle";
import { isLocked, opsFor, processOp, versionOf, type DocOp, type DocRow } from "../model";
import { useCollectionAudience } from "../queries";
import { CurationDrawer } from "./CurationDrawer";
import { ActionsMenu, TopicMenu, useApplyTopic } from "./shared";
import { OP_META, useDocOps } from "./useDocOps";

const EVENTS: Readonly<Record<string, [LucideIcon, string, Tone | undefined]>> = {
  SUBMITTED: [Upload, "Submitted", undefined],
  RESUBMITTED: [Upload, "Resubmitted", undefined],
  CHANGES_REQUESTED: [Pencil, "Changes requested", "warning"],
  REJECTED: [CircleX, "Declined", "danger"],
  APPROVED: [CircleCheck, "Approved", "success"],
  WITHDRAWN: [Archive, "Withdrawn", undefined],
};

/**
 * One document (preview `DR['cur-doc']`): the lifecycle chip and its one note, its progress (Received → Reviewed →
 * Published → Processed → Searchable: publication and processing are independent, Searchable needs both), History,
 * Details; the state's fix in the footer.
 */
export function DocumentDrawer({ row, onClose, contributorName }: { row: DocRow | null; onClose: () => void; contributorName: string }) {
  const ops = useDocOps();
  if (!row) {
    return (
      <CurationDrawer isOpen={false} onClose={onClose} title="">
        {null}
      </CurationDrawer>
    );
  }
  const { main } = opsFor(row);
  const meta = OP_META[main];
  const MainIcon = meta.icon;
  return (
    <CurationDrawer
      isOpen
      onClose={onClose}
      size="lg"
      lead={<FileIcon name={row.fileName} mime={row.mime} size="lg" />}
      title={<span translate="no">{row.title}</span>}
      description={<span translate="no">{row.baseName}</span>}
      headActions={<ActionsMenu actions={ops.menu(row, "drawer", onClose)} />}
      footer={
        <Button variant="primary" onPress={() => ops.run(main, row, onClose)}>
          <MainIcon className="i" aria-hidden />
          {meta.label}
        </Button>
      }
    >
      <DrawerBody row={row} contributorName={contributorName} onRun={(op) => ops.run(op, row, onClose)} />
    </CurationDrawer>
  );
}

interface Step {
  label: string;
  state: "done" | "current" | "issue" | "skipped" | "todo";
  busy?: boolean;
  text: string;
  at?: string;
  action?: ReactNode;
}

const STEP_ICON: Readonly<Record<Step["state"], [LucideIcon, string]>> = {
  done: [Check, "success"],
  current: [Clock, "accent"],
  issue: [CircleAlert, "warning"],
  skipped: [Minus, ""],
  todo: [CircleDashed, ""],
};
const STEP_SR: Readonly<Record<Step["state"], string>> = { done: "Done", current: "In progress", issue: "Needs attention", skipped: "Skipped", todo: "Not yet" };

function DrawerBody({ row, contributorName, onRun }: { row: DocRow; contributorName: string; onRun: (op: DocOp) => void }) {
  const { toResource, ctx } = useKnowledgeModel();
  const applyTopic = useApplyTopic();
  const c = row.contribution;
  const events = (c?.events ?? []).filter((e) => e.kind !== "ANALYZED");
  const memberNames = useMemberNames([...events.map((e) => e.actor), c?.decision?.reviewer, row.item?.creator]);
  const source = useSource(row.source);
  const audience = useCollectionAudience(row.base);
  const k = row.lifecycle;
  const ev = (kind: string) => [...events].reverse().find((e) => e.kind === kind);
  const by = (e: { actor?: string } | undefined) => (e?.actor && memberNames.get(e.actor) ? ` by ${memberNames.get(e.actor)}` : "");
  const sourceName = source.data?.displayName || "a source";
  const lastNote = [...events].reverse().find((e) => e.kind === "CHANGES_REQUESTED" || e.kind === "REJECTED");
  const indexError = row.item?.document?.indexingError?.message;
  const synced = !!row.source;
  const locked = isLocked(row.item);
  const resource = row.item ? toResource(row.item) : null;
  const published = !!row.item && row.publication === "published";

  // The chip names the state; one note says why and what fixes it (never a second title repeating the chip).
  const fixHint = locked ? (synced ? " Remove the password at the source, then sync again." : " Replace the file with a copy without a password.") : "";
  const note =
    row.processing === "failed" ? (
      <Callout tone="danger" description={(indexError || "Processing stopped partway. Try again.") + (indexError && /remove the password|copy without|sync again|try again/i.test(indexError) ? "" : fixHint)} />
    ) : (k === "changes" || k === "rejected") && lastNote?.message ? (
      <blockquote className="cur-tl__text">
        “<span translate="no">{lastNote.message}</span>” — {memberNames.get(lastNote.actor ?? "") || "A reviewer"}
      </blockquote>
    ) : null;

  /* ── Progress: Received → Reviewed → Published → Processed → Searchable ── */
  const open = row.publication === "review" || row.publication === "changes";
  const kind = kindMeta(row.kind, ctx.documentTypes).label;
  const topicNames = row.topics.map((t) => ctx.topicNames?.get(t) ?? "").filter(Boolean);
  const canTag = !!resource && !open && resource.editable;
  const who = audience?.label ?? "Readers of its collection";
  const opButton = (op: DocOp | undefined) => {
    if (!op) return undefined;
    const { label, icon: Icon } = OP_META[op];
    return (
      <Button size="sm" variant="secondary" onPress={() => onRun(op)}>
        <Icon className="i" aria-hidden />
        {label}
      </Button>
    );
  };
  const received: Step = {
    label: "Received",
    state: "done",
    at: c?.createTime || row.item?.createTime,
    text: c?.origin === "MEMBER" ? `Contributed by ${contributorName || "a member"}` : synced ? `Synced from ${sourceName}` : `Uploaded by ${memberNames.get(row.item?.creator ?? "") || "an editor"}`,
  };
  const approved = ev("APPROVED");
  const reviewed: Step =
    k === "analyzing" || k === "review"
      ? { label: "Reviewed", state: "current", text: "Waiting for a reviewer" }
      : k === "changes"
        ? { label: "Reviewed", state: "issue", text: `Changes requested${by(ev("CHANGES_REQUESTED"))}`, at: ev("CHANGES_REQUESTED")?.createTime }
        : k === "rejected"
          ? { label: "Reviewed", state: "issue", text: `Declined${by(ev("REJECTED"))}`, at: ev("REJECTED")?.createTime }
          : approved
            ? { label: "Reviewed", state: "done", text: `Approved${by(approved)}`, at: approved.createTime }
            : { label: "Reviewed", state: "skipped", text: synced ? `Not needed: ${sourceName} publishes automatically` : "Not needed: added by an editor of the collection" };
  const publishedStep: Step =
    k === "merged"
      ? { label: "Published", state: "done", text: "Published as a new version of another document" }
      : row.publication === "published"
        ? { label: "Published", state: "done", text: who }
        : row.publication === "unpublished"
          ? { label: "Published", state: "issue", text: "Unpublished · readers don’t see it", action: resource?.editable ? opButton("republish") : undefined }
          : row.publication === "rejected"
            ? { label: "Published", state: "skipped", text: "Won’t be published" }
            : { label: "Published", state: "todo", text: `After approval · ${who} will see it` };
  // Processed: read → classified → indexed, in one line, with what the pipeline chose.
  const indexed = versionOf(row.item?.document?.indexedRevision) ?? versionOf(row.item?.document?.revision) ?? 1;
  const fix = processOp(row);
  const procBtn = opButton(fix === "process" || fix === "retry" || fix === "update" ? fix : undefined);
  const what = `v${indexed} · ${kind} · ${topicNames.length ? topicNames.join(", ") : "no topic yet"}`;
  const PROCESSED: Readonly<Record<DocRow["processing"], Omit<Step, "label">>> = {
    pending: { state: "todo", text: "Not processed yet: search and the assistant can’t use it", action: procBtn },
    processing: { state: "current", busy: true, text: "Reading, classifying and indexing…" },
    ready: {
      state: "done",
      text: what,
      action: !topicNames.length && canTag ? <TopicMenu label="Add topic" variant="tertiary" chevron onPick={(t) => void applyTopic([resource!], t)} /> : undefined,
    },
    failed: { state: "issue", text: indexError || "Processing stopped partway", action: procBtn },
    outdated: {
      state: "issue",
      text: `${changedAtSource(row.item) ? "Changed at the source" : "Processed with earlier settings"} · v${indexed} still answers until it’s processed again`,
      action: procBtn,
    },
    unsupported: { state: "skipped", text: "This file type can’t be processed" },
  };
  const processedStep: Step = {
    label: "Processed",
    ...(open || row.publication === "rejected" || k === "merged" ? { state: "todo", text: open ? "After approval, unless the reviewer processes it later" : "Not processed" } : PROCESSED[row.processing]),
  };
  const searchable: Step = {
    label: "Searchable",
    ...(inSearch(row)
      ? { state: "done", text: `In search and answers for ${who}` }
      : row.publication === "published" && row.processing === "outdated"
        ? { state: "done", text: `Answers use v${indexed} until it’s processed again` }
        : {
            state: "todo",
            text: row.publication === "published" ? "Once it’s processed" : row.publication === "unpublished" && row.processing === "ready" ? "Once it’s published" : "Once it’s published and processed",
          }),
  };
  const steps = [received, reviewed, publishedStep, processedStep, searchable];

  /* ── History ── */
  const timeline: { icon: LucideIcon; tone?: Tone; label: string; by?: string; text?: string; at: string }[] = events.length
    ? events.map((e) => {
        const [icon, label, tone] = EVENTS[e.kind ?? ""] ?? [Clock, e.kind ?? "", undefined];
        const actor = e.actor ? memberNames.get(e.actor) : e.kind === "SUBMITTED" ? contributorName : "";
        return { icon, tone, label, by: actor, text: e.message, at: e.createTime ?? "" };
      })
    : [synced ? { icon: RefreshCw, label: `Synced from ${sourceName}`, at: row.item?.createTime ?? row.updated } : { icon: Upload, label: "Added", by: memberNames.get(row.item?.creator ?? "") ?? "", at: row.item?.createTime ?? row.updated }];
  if (row.publication === "unpublished") timeline.push({ icon: EyeOff, label: "Unpublished", at: row.item?.updateTime ?? "" });
  if (published && k !== "merged" && events.length) timeline.push({ icon: CircleCheck, tone: "success", label: "Published", at: row.item?.updateTime ?? row.updated });

  return (
    <>
      <div className="drawer__section">
        <div className="row gap-8 wrap">
          <LifecycleChip lifecycle={row.lifecycle} size="md" />
        </div>
        {note ? <div className="mt-12">{note}</div> : null}
      </div>
      <div className="drawer__section">
        <h3 className="drawer__section-title">Progress</h3>
        <ol className="flow-steps">
          {steps.map((s) => {
            const [Icon, tone] = s.busy ? [LoaderCircle, "accent"] : STEP_ICON[s.state];
            return (
              <li key={s.label} className={`flow-steps__item is-${s.state}${s.busy ? " is-busy" : ""}`}>
                <span className={`flow-steps__dot${tone ? ` flow-steps__dot--${tone}` : ""}`} aria-hidden="true">
                  <Icon className="i i-xs" />
                </span>
                <div className="grow">
                  <div className="t-sm">
                    <span className="medium">{s.label}</span>
                    <span className="sr-only">{STEP_SR[s.state]}</span>
                  </div>
                  <div className="flow-steps__text">
                    {s.text}
                    {s.at ? <span className="muted"> · {rel(s.at)}</span> : null}
                  </div>
                  {s.action ? <div className="mt-8">{s.action}</div> : null}
                </div>
              </li>
            );
          })}
        </ol>
      </div>
      <div className="drawer__section">
        <Disclosure title="History" icon={History} summary={events.length ? plural(events.length, "event") : undefined}>
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
        </Disclosure>
      </div>
      <div className="drawer__section">
        <h3 className="drawer__section-title">Details</h3>
        {resource && published ? (
          <ResourceDetails resource={resource} />
        ) : row.item ? (
          <KeyValue
            pairs={[
              [
                "Collection",
                row.base ? (
                  <NextLink className="link" href={`/studio/collections/${resourceId(row.base)}`} translate="no">
                    {row.baseName || "Collection"}
                  </NextLink>
                ) : (
                  "—"
                ),
              ],
              ["Contributor", contributorName || "—"],
              ["Type", kind],
              ["Size", fmtSize(row.item.document?.sizeBytes)],
              ["Version", `v${versionOf(row.item.document?.revision) ?? 1}`],
              [
                "Who could see it",
                <span key="who" className="row gap-6">
                  {audience ? <audience.icon className="i i-sm muted" aria-hidden /> : null}
                  {who}
                </span>,
              ],
            ]}
          />
        ) : (
          <EmptyState icon={FileGlyph} compact title="The file isn’t available" description="It’s back with its contributor." />
        )}
      </div>
    </>
  );
}
