"use client";

import { Button, Description, Drawer, FieldError, Label, Spinner, TextArea, TextField } from "@heroui/react";
import { useQueries } from "@tanstack/react-query";
import { CircleAlert, Eye, File as FileGlyph, FileText, GitCompare, History, Plus, Send, Shield, Trash2, Undo2, Upload, X } from "lucide-react";
import NextLink from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, type ReactNode } from "react";

import { Callout } from "@/components/ui/Callout";
import { Disclosure } from "@/components/ui/Disclosure";
import { EmptyState } from "@/components/ui/EmptyState";
import { FileIcon } from "@/components/ui/FileIcon";
import { IconButton } from "@/components/ui/IconButton";
import { KeyValue } from "@/components/ui/KeyValue";
import { SkeletonRows } from "@/components/ui/SkeletonRows";
import { StatusChip } from "@/components/ui/StatusChip";
import { resourceId } from "@/lib/api/client";
import { fmtSize } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";

import type { Contribution } from "../../api";
import { openContribute } from "../../components/contribute-store";
import { CONTRIBUTE_TYPES, fileProblem, kindMeta, LIFECYCLE } from "../../model";
import { useContribution, useItemsByName, useKnowledgeModel } from "../../queries";
import { getTopic } from "../api";
import { flagText, lastEvent, lastEventAt, PUBLISHED_KEYS, relLow, who, type ContributionEventView } from "../contributions";
import { useContributionActions } from "../useContributionActions";
import { useContributionViews, type ContributionView } from "../useContributionViews";
import { ProgressStepper, TimelineSteps } from "./ContributionTimeline";

/** The contribution panel (preview `DR['ctb']`): where it stands, the revise form, progress, details and history. */
export function ContributionDrawer({ id, focusRevise, onClose }: { id: string; focusRevise?: boolean; onClose: () => void }) {
  const query = useContribution(id);
  return (
    <Drawer.Backdrop isOpen onOpenChange={(open) => !open && onClose()}>
      <Drawer.Content placement="right">
        <Drawer.Dialog className="drawer__dialog--lg">
          <Drawer.CloseTrigger aria-label="Close" />
          {query.data ? (
            <Panel contribution={query.data} focusRevise={focusRevise} onClose={onClose} />
          ) : query.isError ? (
            <>
              <Drawer.Header>
                <Drawer.Heading>Contribution not available</Drawer.Heading>
              </Drawer.Header>
              <Drawer.Body>
                <EmptyState icon={FileGlyph} title="This contribution isn’t available" description="It may have been withdrawn." compact />
              </Drawer.Body>
            </>
          ) : (
            <>
              <Drawer.Header>
                <Drawer.Heading>Contribution</Drawer.Heading>
              </Drawer.Header>
              <Drawer.Body>
                <SkeletonRows rows={4} />
              </Drawer.Body>
            </>
          )}
        </Drawer.Dialog>
      </Drawer.Content>
    </Drawer.Backdrop>
  );
}

/** Which details section the panel shows: how a published one is classified, or what was suggested/confirmed. */
function detailsOf(v: ContributionView): "classified" | "suggested" | null {
  if (PUBLISHED_KEYS.includes(v.life) && v.published) return "classified";
  if (v.life === "analyzing" || v.life === "review" || v.life === "changes" || v.contribution.suggestions) return "suggested";
  return null;
}

/**
 * One contribution. Each fact appears once: the file (and, when no section names it, the collection) in the
 * subtitle; where it stands in Progress (plus an alert with the reviewer's message); the details in their
 * section; every event in History (collapsed).
 */
function Panel({ contribution, focusRevise, onClose }: { contribution: Contribution; focusRevise?: boolean; onClose: () => void }) {
  const router = useRouter();
  const { can } = useWorkspace();
  const { view } = useContributionViews([contribution]);
  const actions = useContributionActions();
  const v = view(contribution);
  const c = contribution;
  const [note, setNote] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);

  const details = detailsOf(v);
  const state = stateBlock(v);
  const openId = v.published ? resourceId(v.published.name) : resourceId(c.item);
  const ext = (v.fileName.split(".").pop() || "file").toUpperCase();
  const subtitle: ReactNode[] = [
    !details && v.base ? (
      <span key="kb" translate="no">
        {v.base}
      </span>
    ) : null,
    `${ext} · ${fmtSize(v.sizeBytes)}`,
    !v.mine ? `Contributed by ${who(c.contributor ?? "", v.ctx)}` : null,
    c.replacesItem ? (
      <span key="orig">
        New version of{" "}
        <NextLink className="link" href={`/doc/${resourceId(c.replacesItem)}`} translate="no">
          {v.revised?.displayName ?? "the published document"}
        </NextLink>
      </span>
    ) : null,
  ].filter(Boolean);

  const withdrawBtn = (
    <Button
      variant="ghost"
      onPress={() =>
        void actions.withdraw(v).then((done) => {
          if (done) onClose();
        })
      }
    >
      <Undo2 className="i" aria-hidden />
      Withdraw
    </Button>
  );
  const openBtn = (label: string, variant: "primary" | "secondary", icon: ReactNode) => (
    <Button variant={variant} onPress={() => router.push(`/doc/${openId}`)}>
      {icon}
      {label}
    </Button>
  );

  async function resubmit() {
    setTouched(true);
    if (!note.trim() || (file && fileProblem(file))) return;
    setBusy(true);
    const ok = await actions.resubmit(v, { changeSummary: note.trim(), file });
    setBusy(false);
    if (ok) {
      setNote("");
      setFile(null);
      setTouched(false);
    }
  }

  let foot: ReactNode = null;
  let footStart: ReactNode = null;
  if (v.mine) {
    switch (v.life) {
      case "analyzing":
      case "review":
        // The API withdraws only once it's in review (not while the assistant is reading it).
        footStart = c.state === "IN_REVIEW" ? withdrawBtn : null;
        foot = openBtn("Open preview", "secondary", <Eye className="i" aria-hidden />);
        break;
      case "changes":
        footStart = withdrawBtn;
        foot = (
          <Button variant="primary" isPending={busy} onPress={() => void resubmit()}>
            <Send className="i" aria-hidden />
            Resubmit
          </Button>
        );
        break;
      case "published":
      case "publishing":
      case "queued":
      case "update":
      case "stored":
      case "merged":
        foot = (
          <>
            {can("contributions.create") && v.published ? (
              <Button
                variant="tertiary"
                onPress={() => {
                  onClose();
                  openContribute({ item: v.published?.name });
                }}
              >
                <Upload className="i" aria-hidden />
                Submit a new version
              </Button>
            ) : null}
            {openBtn("Open", "primary", <FileText className="i" aria-hidden />)}
          </>
        );
        break;
      case "rejected":
        foot = (
          <Button
            variant="danger-soft"
            onPress={() => {
              actions.remove(v);
              onClose();
            }}
          >
            <Trash2 className="i" aria-hidden />
            Remove
          </Button>
        );
        break;
    }
  }

  return (
    <>
      <Drawer.Header>
        <div className="row gap-12">
          <FileIcon name={v.fileName} mime={v.mime} />
          <div className="grow">
            <Drawer.Heading>
              <span translate="no">{v.title}</span>
            </Drawer.Heading>
            <p className="drawer__description">
              {subtitle.map((part, i) => (
                <span key={i}>
                  {i ? " · " : null}
                  {part}
                </span>
              ))}
            </p>
          </div>
        </div>
      </Drawer.Header>
      <Drawer.Body>
        <div className="ctb-panel">
          {state.alert}
          {v.life === "changes" && v.mine ? (
            <ReviseForm note={note} setNote={setNote} file={file} setFile={setFile} touched={touched} autoFocus={focusRevise} />
          ) : null}
          <section>
            <h3 className="ctb-sec__title">Progress</h3>
            <ProgressStepper view={v} />
          </section>
          {details ? <Details view={v} kind={details} /> : null}
          <Disclosure icon={History} title="History" summary={`Last update ${relLow(lastEventAt(c))}`}>
            <TimelineSteps view={v} quoted={state.quoted} />
          </Disclosure>
        </div>
      </Drawer.Body>
      {foot || footStart ? (
        <Drawer.Footer>
          {footStart ? <div className="drawer__footer-start row gap-8">{footStart}</div> : null}
          {foot}
        </Drawer.Footer>
      ) : null}
    </>
  );
}

/**
 * Where it stands when someone decided something: an alert with their message (History doesn't repeat it).
 * Every other state is the stepper's current step. Returns the event the alert quotes (preview `stateBlock`).
 */
function stateBlock(v: ContributionView): { alert: ReactNode; quoted?: ContributionEventView } {
  const quote = (text?: string) =>
    text ? (
      <blockquote className="ctb-quote" translate="no">
        {text}
      </blockquote>
    ) : null;
  const c = v.contribution;
  if (v.life === "changes") {
    const e = lastEvent(c, "changes");
    return { alert: <Callout tone="warning" title={`${who(e?.by ?? "", v.ctx)} asked for changes`} description={quote(e?.text)} />, quoted: e };
  }
  if (v.life === "rejected") {
    const e = lastEvent(c, "rejected");
    return { alert: <Callout tone="danger" title={`${who(e?.by ?? "", v.ctx)} declined it`} description={quote(e?.text) ?? "It won’t be published."} />, quoted: e };
  }
  if (v.life === "unpublished") return { alert: <Callout tone="default" title={LIFECYCLE.unpublished.label} description={LIFECYCLE.unpublished.desc} /> };
  if (v.life === "failed") {
    return {
      alert: (
        <Callout
          tone="danger"
          title="Processing failed — the reviewers have been told"
          description="It was approved, but the file couldn’t be processed for search. You don’t need to do anything."
        />
      ),
    };
  }
  return { alert: null };
}

const ACCEPT = CONTRIBUTE_TYPES.map((x) => `.${x}`).join(",");

function ReviseForm({
  note,
  setNote,
  file,
  setFile,
  touched,
  autoFocus,
}: {
  note: string;
  setNote: (v: string) => void;
  file: File | null;
  setFile: (f: File | null) => void;
  touched: boolean;
  autoFocus?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const err = touched && !note.trim() ? "Say what you changed." : "";
  const problem = file ? fileProblem(file) : "";
  return (
    <section className="ctb-revise" aria-label="Revise and resubmit">
      <h3 className="ctb-sec__title">Revise and resubmit</h3>
      <div className="field">
        <span className="label">
          Replacement file<span className="label__opt">(optional)</span>
        </span>
        <input
          ref={input}
          type="file"
          hidden
          accept={ACCEPT}
          onChange={(e) => {
            setFile(e.target.files?.[0] ?? null);
            e.target.value = "";
          }}
        />
        {file ? (
          <div className="ctb-revfile">
            <FileIcon name={file.name} mime={file.type} />
            <span className="grow stack gap-2">
              <span className="medium truncate" translate="no">
                {file.name}
              </span>
              {problem ? (
                <span className="field-error">
                  <CircleAlert className="i" aria-hidden />
                  <span>{problem}</span>
                </span>
              ) : (
                <span className="t-xs muted">{fmtSize(file.size)}</span>
              )}
            </span>
            <IconButton icon={X} tip="Remove file" size="sm" onPress={() => setFile(null)} />
          </div>
        ) : (
          <>
            <div className="row wrap gap-8">
              <Button size="sm" variant="tertiary" onPress={() => input.current?.click()}>
                <Upload className="i" aria-hidden />
                Choose a file
              </Button>
            </div>
            <div className="description">Keep the current file if you only need to explain something.</div>
          </>
        )}
      </div>
      <TextField value={note} onChange={setNote} maxLength={400} isRequired isInvalid={!!err} autoFocus={autoFocus}>
        <Label>What did you change?</Label>
        <TextArea id="ctb-rev-note" rows={3} placeholder="e.g. Removed the full answers and kept my approach" />
        {err ? <FieldError>{err}</FieldError> : <Description className="sr-only">Required</Description>}
      </TextField>
    </section>
  );
}

const FLAG_ICON = { PERSONAL_DATA: Shield, UNSEARCHABLE_FORMAT: FileGlyph } as const;

/**
 * Read-only details (preview `suggestion`): how a published one is classified; otherwise what the contributor
 * confirmed (type and topics written on the candidate) or what the assistant suggested. Contributors never see
 * the assistant's confidence; reviewers do.
 */
function Details({ view: v, kind }: { view: ContributionView; kind: "classified" | "suggested" }) {
  const { id: ws } = useWorkspace();
  const { ctx } = useKnowledgeModel();
  const c = v.contribution;
  const s = c.suggestions;
  const related = useItemsByName(
    (c.flags ?? []).map((f) => f.relatedItem),
    { view: "BASIC" },
  );
  const proposed = useQueries({
    queries: (s?.proposedTopics ?? []).map((t) => ({ queryKey: [ws, "topics", "one", resourceId(t)], queryFn: () => getTopic(ws, t), retry: false, staleTime: 5 * 60_000 })),
  });
  const topicChip = (name: string) => <StatusChip key={name} label={ctx.topicNames?.get(name) ?? "Untitled topic"} size="sm" dot={false} />;
  const pct = (conf?: number) => (v.mine ? null : <span className="ctb-conf">{Math.round((conf ?? 0) * 100)}%</span>);
  const collection = (sub?: string) => (
    <span key="kb" className="stack gap-2">
      {v.base ? <span translate="no">{v.base}</span> : <span className="muted">Not chosen yet</span>}
      {sub ? <span className="t-xs muted">{sub}</span> : null}
    </span>
  );

  if (kind === "classified") {
    const d = v.published?.document;
    return (
      <section>
        <h3 className="ctb-sec__title">How it’s classified</h3>
        <KeyValue
          pairs={[
            ["Type", kindMeta(d?.documentType ?? "", ctx.documentTypes).label],
            ["Topics", d?.topics?.length ? <span className="ctb-topics">{d.topics.map(topicChip)}</span> : <span className="muted">None</span>],
            ["Collection", collection()],
          ]}
        />
      </section>
    );
  }

  const confirmed = !!v.ctx.confirmed;
  const head = <h3 className="ctb-sec__title">{confirmed ? (v.mine ? "What you confirmed" : "Confirmed by the contributor") : "What the assistant suggested"}</h3>;
  if (!confirmed && (v.life === "analyzing" || !s)) {
    return (
      <section>
        {head}
        <div className="ctb-reading">
          <Spinner size="sm" />
          <span>Reading the file…</span>
        </div>
      </section>
    );
  }
  const doc = v.candidate?.document;
  const type = confirmed ? doc?.documentType : s?.documentType;
  const topics = (confirmed ? doc?.topics : s?.topics) ?? [];
  const proposals = proposed.flatMap((p) => (p.data?.displayName ? [p.data.displayName] : []));
  const flags = (c.flags ?? []).map((f) => {
    const rel = f.relatedItem ? related.items.get(f.relatedItem)?.displayName : undefined;
    return { kind: f.kind ?? "", text: flagText(f.kind, rel) };
  });
  const chosenBy = c.targetCollection
    ? `Chosen by ${v.mine ? "you" : who(c.contributor ?? "", v.ctx)}`
    : v.base
      ? "Suggested by the assistant"
      : "The assistant picks the best fit. A reviewer confirms it.";
  return (
    <section>
      {head}
      <KeyValue
        pairs={[
          [
            "Type",
            <span key="type" className="row gap-6">
              {type ? kindMeta(type, ctx.documentTypes).label : "—"}
              {type && !confirmed ? pct(s?.documentTypeConfidence) : null}
            </span>,
          ],
          [
            "Topics",
            topics.length || proposals.length ? (
              <span key="topics" className="ctb-topics">
                {topics.map(topicChip)}
                {topics.length && !confirmed ? pct(s?.topicsConfidence) : null}
                {proposals.map((name) => (
                  <StatusChip
                    key={`p-${name}`}
                    label={name}
                    tone="accent"
                    icon={Plus}
                    size="sm"
                    tooltip="Proposed new topic. A workspace admin decides whether to add it."
                  />
                ))}
              </span>
            ) : (
              <span key="none" className="muted">
                No clear topic
              </span>
            ),
          ],
          ["Collection", collection(chosenBy)],
        ]}
      />
      {flags.length ? (
        <ul className="ctb-flags">
          {flags.map((f) => {
            const Icon = FLAG_ICON[f.kind as keyof typeof FLAG_ICON] ?? GitCompare;
            return (
              <li key={f.kind}>
                <Icon className="i i-sm" aria-hidden />
                <span translate="no">{f.text}</span>
              </li>
            );
          })}
        </ul>
      ) : null}
      <p className="t-xs muted mt-8">Reviewers can change these before publishing.</p>
    </section>
  );
}
