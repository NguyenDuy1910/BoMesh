"use client";

import { Button, Description, FieldError, Input, Label, ListBox, Select, TextArea, TextField } from "@heroui/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { ArrowLeft, ArrowRight, CheckCheck, CircleAlert, CircleCheck, Lock, Send, Share, StickyNote, Upload, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useRef, useState, type DragEvent, type ReactNode } from "react";

import { Callout } from "@/components/ui/Callout";
import { ChoiceGroup } from "@/components/ui/ChoiceGroup";
import { Disclosure } from "@/components/ui/Disclosure";
import { FileIcon } from "@/components/ui/FileIcon";
import { IconButton } from "@/components/ui/IconButton";
import { List, ListItem } from "@/components/ui/List";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { toast } from "@/components/ui/Toast";
import { api, call, errorMessage, requestId, resourceId } from "@/lib/api/client";
import { fmtSize, plural } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";

import { createContribution, searchItems, uploadDocument, type Contribution, type Item } from "../api";
import { contributionHref } from "../library/contributions";
import { CONTRIBUTE_TYPES, fileProblem, inferKind, RESOURCE_KINDS, tokens, topicTree } from "../model";
import { openDocumentPreview } from "../preview/store";
import { invalidateKnowledge, useContributionTargets, useItem, useKnowledgeModel } from "../queries";
import type { ContributeOptions } from "./contribute-store";
import { KnowledgeModal } from "./KnowledgeModal";
import { useWhoCanSeeCollection } from "./ResourceDetails";
import { TopicPicker } from "./TopicPicker";

/* ═══════════════ Files ═══════════════ */

interface Entry {
  id: number;
  file: File;
  err: string;
  /** 0–1 while uploading. */
  progress: number;
  state: "ready" | "uploading" | "done" | "failed";
}

/** What the contributor confirms for one file (preview `ctb.meta`). `kb` "" = let the assistant suggest. */
interface Meta {
  title: string;
  kind: string;
  topics: string[];
  kb: string;
  summary: string;
}

const ACCEPT = CONTRIBUTE_TYPES.map((x) => `.${x}`).join(",");
let entrySeq = 0;

const stemOf = (name: string) => name.replace(/\.[^.]+$/, "");

/** File names that suggest personal data (preview `PERSONAL_RE`); the assistant checks the content after submission. */
const PERSONAL_RE = /\bcv\b|résumé|resume|transcript|salary|payslip|passport|national id|\bid card\b|medical|customer export|card numbers?|\bpan\b|cccd/i;

/** Title words that identify a document (versions, "draft", years dropped; preview `titleWords`). */
function titleWords(name: string): Set<string> {
  return new Set(tokens(stemOf(name)).filter((w) => !/^(v\d+|draft|update|updated|copy|final|new|\d{4})$/.test(w)));
}

/** Shared words over all words (preview `titleSim`). */
function titleSimilarity(a: string, b: string): number {
  const x = titleWords(a);
  const y = titleWords(b);
  if (!x.size || !y.size) return 0;
  const shared = [...x].filter((w) => y.has(w)).length;
  return shared / (x.size + y.size - shared);
}

/* ═══════════════ Check the details: one file ═══════════════ */

/** A published document whose title closely matches the file's (SearchItems over what the caller can see). */
function usePossibleDuplicate(fileName: string) {
  const { id: ws, member } = useWorkspace();
  const stem = stemOf(fileName).replace(/_+/g, " ");
  const query = useQuery({
    queryKey: [ws, "contribute", "duplicate", stem],
    queryFn: () => searchItems(ws, { query: stem, filter: "itemType = DOCUMENT AND document.publicationState = PUBLISHED", pageSize: 5 }),
    enabled: !!stem.trim(),
    staleTime: 5 * 60_000,
    retry: false,
  });
  const best = (query.data?.results ?? [])
    .map((r) => r.item)
    .filter((i): i is Item => !!i && i.state !== "DELETED" && i.parentItem !== member.personalCollection)
    .map((item) => ({ item, sim: titleSimilarity(fileName, item.displayName ?? "") }))
    .sort((a, b) => b.sim - a.sim)[0];
  return best && best.sim >= 0.55 ? best : null;
}

interface CheckFileProps {
  entry: Entry;
  meta: Meta;
  many: boolean;
  touched: boolean;
  busy: boolean;
  onChange: (patch: Partial<Meta>) => void;
}

/** One file's details as an editable form (preview `checkFile`). */
function CheckFile({ entry: x, meta: m, many, touched, busy, onChange }: CheckFileProps) {
  const { settings } = useWorkspace();
  const { topics } = useKnowledgeModel();
  const targets = useContributionTargets();
  const target = targets.data.find((t) => t.name === m.kb);
  const who = useWhoCanSeeCollection(target ? { id: resourceId(target.name), displayName: target.displayName } : null);
  const duplicate = usePossibleDuplicate(x.file.name);
  const titleError = touched && !m.title.trim() ? "Give it a title." : "";
  const configured = settings?.documentTypes ?? [];
  const kinds: [string, string][] = configured.length
    ? configured.map((t) => [t.key ?? "", t.displayName ?? t.key ?? ""])
    : Object.entries(RESOURCE_KINDS).map(([key, k]) => [key, k.label]);
  if (!kinds.some(([k]) => k === m.kind)) kinds.push([m.kind, RESOURCE_KINDS[m.kind]?.label ?? m.kind]);
  const WhoIcon = who.icon;

  return (
    <section className="ctb-check" aria-label={`Details for ${x.file.name}`}>
      {many ? (
        <div className="ctb-check__file">
          <FileIcon name={x.file.name} size="sm" />
          <span className="medium truncate" translate="no">
            {x.file.name}
          </span>
          <span className="t-xs muted none">{fmtSize(x.file.size)}</span>
        </div>
      ) : null}
      {PERSONAL_RE.test(x.file.name) || duplicate ? (
        <div className="stack gap-8">
          {PERSONAL_RE.test(x.file.name) ? (
            <Callout
              tone="warning"
              title="May contain personal data"
              description="Remove personal details before you submit, or say in the note why they’re needed."
            />
          ) : null}
          {duplicate ? (
            <Callout
              title="Possible duplicate"
              description={`Looks like “${stemOf(duplicate.item.displayName ?? "")}” (${Math.round(duplicate.sim * 100)}% similar title). If it replaces that document, submit a new version of it instead.`}
              actions={
                <Button size="sm" variant="tertiary" onPress={() => openDocumentPreview({ item: duplicate.item.name ?? "" })}>
                  Preview
                </Button>
              }
            />
          ) : null}
        </div>
      ) : null}
      <div className="ctb-check__row">
        <TextField value={m.title} onChange={(title) => onChange({ title })} isRequired isInvalid={!!titleError} isDisabled={busy} maxLength={120}>
          <Label>Title</Label>
          <Input />
          <FieldError>{titleError}</FieldError>
        </TextField>
        <Select value={m.kind} onChange={(v) => onChange({ kind: String(v) })} isDisabled={busy}>
          <Label>Type</Label>
          <Select.Trigger>
            <Select.Value />
            <Select.Indicator />
          </Select.Trigger>
          <Select.Popover>
            <ListBox>
              {kinds.map(([key, label]) => (
                <ListBox.Item key={key} id={key} textValue={label}>
                  {label}
                  <ListBox.ItemIndicator />
                </ListBox.Item>
              ))}
            </ListBox>
          </Select.Popover>
        </Select>
      </div>
      <div className="field">
        <span className="label">Topics</span>
        <TopicPicker
          value={m.topics}
          onChange={(next) => onChange({ topics: next })}
          topics={topics}
          label="Topics"
          empty={topicTree(topics).length ? "No clear topic. Add one if you know it." : "This workspace has no topics yet."}
          isDisabled={busy}
        />
      </div>
      <Select value={m.kb || "suggest"} onChange={(v) => onChange({ kb: v === "suggest" ? "" : String(v) })} isDisabled={busy}>
        <Label>Collection</Label>
        <Select.Trigger>
          <Select.Value />
          <Select.Indicator />
        </Select.Trigger>
        <Description>
          {target ? (
            <span className="row gap-4">
              <WhoIcon className="i i-xs" aria-hidden />
              <span>{`${who.label} will see it once published.`}</span>
            </span>
          ) : (
            "The assistant picks the best fit. A reviewer confirms it."
          )}
        </Description>
        <Select.Popover>
          <ListBox>
            <ListBox.Item id="suggest" textValue="Let the assistant suggest">
              Let the assistant suggest
              <ListBox.ItemIndicator />
            </ListBox.Item>
            {targets.data.map((t) => (
              <ListBox.Item key={t.name} id={t.name ?? ""} textValue={t.displayName ?? ""}>
                {t.displayName}
                <ListBox.ItemIndicator />
              </ListBox.Item>
            ))}
          </ListBox>
        </Select.Popover>
      </Select>
      <TextField value={m.summary} onChange={(summary) => onChange({ summary })} maxLength={280} isDisabled={busy}>
        <Label>
          Summary <span className="label__opt">(optional)</span>
        </Label>
        <TextArea rows={2} />
        <Description>Shown in search results and to reviewers.</Description>
      </TextField>
    </section>
  );
}

/* ═══════════════ Dialog ═══════════════ */

export interface ContributeDialogProps extends ContributeOptions {
  isOpen: boolean;
  onClose: () => void;
}

/**
 * Contribute (preview `M['contribute']`, DOCUMENT_LIFECYCLE.md). Destination first — Contribute to a collection
 * (a reviewer checks it before it's published) or Upload to My files — then drop or browse files. Contributing
 * takes two steps: Continue opens Check the details (title, type, topics, collection and who will see it,
 * summary, possible-duplicate and personal-data warnings, a note for reviewers; Back keeps edits), and Submit
 * uploads each file into the member's PERSONAL collection with what they confirmed, then opens a contribution
 * for review. Upload to My files and Submit a new version (one file, required "What changed?") are one step.
 */
export function ContributeDialog({ isOpen, onClose, mode, collection, folder, item }: ContributeDialogProps) {
  const { id: ws, can, member } = useWorkspace();
  const router = useRouter();
  const qc = useQueryClient();
  const targets = useContributionTargets();
  const base = useItem(item);
  const baseDoc: Item | undefined = item ? base.data : undefined;
  const personal = member.personalCollection;
  const canShare = can("contributions.create") && (targets.data.length > 0 || !!item);
  const presetPrivate = mode === "private" || (!!collection && !!personal && resourceId(collection) === resourceId(personal));
  const [dest, setDest] = useState<"share" | "private">(item ? "share" : canShare && !presetPrivate ? "share" : "private");
  // A collection passed in (a collection or reading list page) is pre-selected when it takes contributions.
  const preset = collection && !presetPrivate ? `workspaces/${ws}/items/${resourceId(collection)}` : "";
  const [step, setStep] = useState<"pick" | "details">("pick");
  const [meta, setMeta] = useState<Record<number, Meta>>({});
  const [note, setNote] = useState("");
  const [files, setFiles] = useState<Entry[]>([]);
  const [busy, setBusy] = useState(false);
  const [touched, setTouched] = useState(false);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const priv = !item && (dest === "private" || !canShare);
  const twoStep = !item && !priv;

  const valid = files.filter((f) => !f.err);
  const skipped = files.length - valid.length;
  const full = !!item && valid.length > 0;
  const noteError = item && touched && !note.trim() ? "Say what changed." : "";
  const fileError = touched && !busy && !valid.length ? (files.length ? "None of these files can be added. Add a supported file." : "Add at least one file.") : "";

  function add(list: FileList | File[]) {
    let next = [...files, ...[...list].map((file) => ({ id: ++entrySeq, file, err: fileProblem(file), progress: 0, state: "ready" as const }))];
    // A new version takes one file: keep the latest valid one.
    if (item) {
      const ok = next.filter((x) => !x.err);
      if (ok.length > 1) next = next.filter((x) => x.err || x === ok.at(-1));
    }
    if (next.some((x) => !x.err)) setTouched(false);
    setFiles(next);
  }

  const patch = (id: number, p: Partial<Entry>) => setFiles((list) => list.map((x) => (x.id === id ? { ...x, ...p } : x)));

  /** Continue: Check the details. Edits survive Back; only new files get first values. */
  function toDetails() {
    const next: Record<number, Meta> = {};
    for (const x of valid) {
      const title = stemOf(x.file.name).replace(/_+/g, " ").replace(/\s+/g, " ").trim();
      next[x.id] = meta[x.id] ?? {
        title,
        kind: inferKind(title, (/\.([a-z0-9]+)$/i.exec(x.file.name)?.[1] ?? "").toLowerCase()),
        topics: [],
        kb: targets.data.some((t) => t.name === preset) ? preset : "",
        summary: "",
      };
    }
    setMeta(next);
    setTouched(false);
    setStep("details");
  }

  function go() {
    if (busy) return;
    if (!valid.length || (item && !note.trim())) {
      setTouched(true);
      return;
    }
    if (twoStep) return toDetails();
    void upload();
  }

  /** Upload every valid file into My files (with what was confirmed) and, when sharing, open a contribution for each. */
  async function upload() {
    if (!personal) return;
    const missing = twoStep && valid.find((x) => !meta[x.id]?.title.trim());
    if (missing) {
      setTouched(true);
      return;
    }
    setBusy(true);
    const uploaded: { entry: Entry; doc: Item; contribution?: Contribution }[] = [];
    let failed = 0;
    await Promise.all(
      valid.map(async (entry) => {
        patch(entry.id, { state: "uploading", progress: 0 });
        const m = twoStep ? meta[entry.id] : null;
        try {
          const doc = await uploadDocument(
            ws,
            {
              parentItem: personal,
              file: entry.file,
              displayName: m?.title.trim(),
              document: m ? { documentType: m.kind, topics: m.topics, summary: m.summary.trim() || undefined } : undefined,
            },
            (p) => patch(entry.id, { progress: p }),
          );
          let contribution: Contribution | undefined;
          if (!priv) {
            contribution = await createContribution(ws, {
              kind: item ? "NEW_REVISION" : "NEW_DOCUMENT",
              item: doc.name,
              targetCollection: item ? undefined : (m?.kb && m.kb === preset && folder ? `workspaces/${ws}/items/${resourceId(folder)}` : m?.kb) || undefined,
              replacesItem: item ? `workspaces/${ws}/items/${resourceId(item)}` : undefined,
              note: note.trim() || undefined,
              changeSummary: item ? note.trim() : undefined,
            });
          }
          patch(entry.id, { state: "done", progress: 1 });
          uploaded.push({ entry, doc, contribution });
        } catch (error) {
          patch(entry.id, { state: "failed", err: errorMessage(error) });
          failed++;
        }
      }),
    );
    setBusy(false);
    invalidateKnowledge(qc, ws);
    if (priv && uploaded.length) {
      // My files never need review: prepare them for search and answers right away.
      void call(
        api.POST("/api/v1/workspaces/{workspace}/ingestionRuns", {
          params: { path: { workspace: ws }, query: { requestId: requestId() } },
          body: { selector: { items: uploaded.map((u) => u.doc.name ?? "") }, trigger: "MANUAL" },
        }),
      ).catch(() => undefined);
    }
    if (failed) {
      // Keep only what still needs sending; the errors show on the files.
      setFiles((list) => list.filter((x) => x.state !== "done"));
      setStep("pick");
      if (uploaded.length) toast(`${plural(uploaded.length, "file")} sent; ${plural(failed, "file")} couldn’t be uploaded`, { tone: "warning" });
      return;
    }
    onClose();
    if (priv) {
      toast("Added to My files", { action: { label: "Open", onPress: () => router.push("/knowledge/library?tab=files") } });
      return;
    }
    const message = item ? "Submitted the new version for review" : uploaded.length === 1 ? "Submitted for review" : `Submitted ${plural(uploaded.length, "document")} for review`;
    const open = uploaded.length === 1 ? uploaded[0].contribution?.name : "";
    toast(message, {
      action: can("contributions.review")
        ? { label: "Review now", onPress: () => router.push("/studio?tab=documents&view=review") }
        : { label: "Open", onPress: () => router.push(contributionHref(open)) },
    });
  }

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files.length) add(e.dataTransfer.files);
  };

  const n = valid.length;
  const footer = (primary: ReactNode) => (
    <>
      <Button variant="ghost" onPress={onClose} isDisabled={busy}>
        Cancel
      </Button>
      {primary}
    </>
  );

  if (step === "details") {
    const checked = valid.filter((x) => meta[x.id]);
    const lone = checked.length === 1 ? checked[0] : null;
    const shortNote = note.trim();
    return (
      <KnowledgeModal
        isOpen={isOpen}
        onClose={onClose}
        size="lg"
        guard={busy}
        title="Check the details"
        icon={CheckCheck}
        description="Change anything that’s off. Reviewers see what you confirm here."
        footerStart={
          busy ? null : (
            <Button variant="ghost" onPress={() => setStep("pick")}>
              <ArrowLeft className="i" aria-hidden />
              Back
            </Button>
          )
        }
        footer={footer(
          <Button variant="primary" onPress={() => void upload()} isPending={busy}>
            <Send className="i" aria-hidden />
            {checked.length > 1 ? `Submit ${checked.length} for review` : "Submit for review"}
          </Button>,
        )}
      >
        {lone ? (
          <div className="ctb-current">
            <FileIcon name={lone.file.name} />
            <div className="grow">
              <div className="medium truncate" translate="no">
                {lone.file.name}
              </div>
              <div className="t-xs muted">{fmtSize(lone.file.size)}</div>
            </div>
          </div>
        ) : null}
        <div className="ctb-checks">
          {checked.map((x) => (
            <CheckFile
              key={x.id}
              entry={x}
              meta={meta[x.id]}
              many={checked.length > 1}
              touched={touched}
              busy={busy}
              onChange={(p) => setMeta((all) => ({ ...all, [x.id]: { ...all[x.id], ...p } }))}
            />
          ))}
        </div>
        <div className="ctb-fields">
          <Disclosure title="Note for reviewers" icon={StickyNote} summary={shortNote ? (shortNote.length > 40 ? `${shortNote.slice(0, 40)}…` : shortNote) : "Optional"}>
            <TextField value={note} onChange={setNote} maxLength={400} aria-label="Note for reviewers" isDisabled={busy}>
              <TextArea rows={2} placeholder="What it covers and who it helps" />
            </TextField>
          </Disclosure>
        </div>
      </KnowledgeModal>
    );
  }

  const label = item ? "Submit new version" : priv ? (n > 1 ? `Add ${n} files` : "Add to My files") : "Continue";
  const hint = skipped
    ? `${plural(skipped, "file")} will be skipped`
    : priv
      ? "Only you can see them."
      : twoStep
        ? "You check the details before anything is sent."
        : "You can withdraw it while it’s in review.";
  const version = /\/revisions\/(\d+)$/.exec(baseDoc?.document?.revision ?? "")?.[1] ?? "1";

  return (
    <KnowledgeModal
      isOpen={isOpen}
      onClose={onClose}
      size="lg"
      guard={busy}
      title={item ? "Submit a new version" : priv ? "Upload to My files" : "Contribute documents"}
      icon={priv ? Lock : Upload}
      description={
        item
          ? "A reviewer checks it before it replaces the current version."
          : priv
            ? "Only you can see these files. Ask about them in chat."
            : "Share what your team should know. A reviewer checks it before it’s published."
      }
      footerStart={busy || !personal ? null : hint}
      footer={footer(
        <Button variant="primary" onPress={go} isPending={busy} isDisabled={!personal}>
          {twoStep ? null : priv ? <Upload className="i" aria-hidden /> : <Send className="i" aria-hidden />}
          {label}
          {twoStep ? <ArrowRight className="i" aria-hidden /> : null}
        </Button>,
      )}
    >
      {baseDoc ? (
        <div className="ctb-current">
          <FileIcon name={baseDoc.document?.fileName} mime={baseDoc.document?.mimeType} />
          <div className="grow">
            <div className="medium truncate" translate="no">
              {stemOf(baseDoc.displayName ?? "")}
            </div>
            <div className="t-xs muted">
              Current version v{version}
              {baseDoc.ancestors?.[0]?.displayName ? ` · ${baseDoc.ancestors[0].displayName}` : ""}
            </div>
          </div>
        </div>
      ) : null}
      {!item && !busy && canShare && personal ? (
        <div className="field ctb-dest">
          <span className="label">Where should it go?</span>
          <ChoiceGroup
            label="Where should it go?"
            columns={2}
            value={dest}
            onChange={setDest}
            options={[
              { value: "share", title: "Contribute to a collection", description: "Your team can find it once a reviewer publishes it.", icon: Share },
              { value: "private", title: "Upload to My files", description: "Only you can see it. Ask about it in chat.", icon: Lock },
            ]}
          />
        </div>
      ) : null}
      {busy ? (
        <p className="t-sm muted mb-12">{priv ? "Adding to My files…" : `Uploading the new version of ${stemOf(baseDoc?.displayName ?? "the document")}…`}</p>
      ) : null}
      {!personal ? (
        <p className="t-sm muted row gap-6">
          <Lock className="i i-sm" aria-hidden />
          You can’t add files to any collection.
        </p>
      ) : busy || full ? null : (
        <>
          <button
            type="button"
            className={clsx("ctb-drop", dragging && "is-drag")}
            aria-describedby="ctb-drop-hint"
            onClick={() => input.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
            }}
            onDrop={onDrop}
          >
            <span className="ctb-drop__icon">
              <Upload className="i i-lg" aria-hidden />
            </span>
            <span className="medium">
              {item ? "Drop the new file here or" : "Drop files here or"} <span className="text-accent">browse</span>
            </span>
            <span className="description" id="ctb-drop-hint">
              {item ? "PDF, Word, Excel, PowerPoint, text, Markdown or HTML · up to 100 MB" : "PDF, Word, Excel, PowerPoint, text, Markdown or HTML · up to 100 MB each"}
            </span>
          </button>
          <input
            ref={input}
            type="file"
            hidden
            multiple={!item}
            accept={ACCEPT}
            onChange={(e) => {
              if (e.target.files?.length) add(e.target.files);
              e.target.value = "";
            }}
          />
        </>
      )}
      {fileError ? (
        <div className="field-error mt-8" role="alert">
          <CircleAlert className="i" aria-hidden />
          <span>{fileError}</span>
        </div>
      ) : null}
      {files.length ? (
        <div className={busy && !item ? "" : "mt-12"}>
          <List>
            {files.map((x) => (
              <ListItem
                key={x.id}
                lead={<FileIcon name={x.file.name} />}
                title={<span translate="no">{x.file.name}</span>}
                description={
                  x.err ? (
                    <span className="field-error">
                      <CircleAlert className="i" aria-hidden />
                      <span>{x.err}</span>
                    </span>
                  ) : busy || x.state !== "ready" ? (
                    <span className="row gap-8">
                      <span className="grow">
                        <ProgressBar label="Upload progress" value={Math.round(x.progress * 100)} tone={x.state === "done" ? "success" : undefined} />
                      </span>
                      <span className="num t-xs muted ctb-pct">{Math.round(x.progress * 100)}%</span>
                    </span>
                  ) : (
                    fmtSize(x.file.size)
                  )
                }
                actions={
                  busy ? (
                    x.err ? (
                      <span className="t-xs muted">Skipped</span>
                    ) : x.state === "done" ? (
                      <CircleCheck className="i text-success" aria-label="Uploaded" />
                    ) : null
                  ) : (
                    <IconButton icon={X} tip={`Remove ${x.file.name}`} size="sm" onPress={() => setFiles(files.filter((f) => f.id !== x.id))} />
                  )
                }
              />
            ))}
          </List>
        </div>
      ) : null}
      {item && !busy ? (
        <div className="ctb-fields">
          <TextField
            value={note}
            onChange={(v) => {
              setNote(v);
              if (v.trim()) setTouched(false);
            }}
            maxLength={400}
            isRequired
            isInvalid={!!noteError}
          >
            <Label>What changed?</Label>
            <TextArea rows={3} placeholder="e.g. Corrected section 2 and updated the dates" />
            {noteError ? <FieldError>{noteError}</FieldError> : <Description>Reviewers see this next to the current version.</Description>}
          </TextField>
        </div>
      ) : null}
    </KnowledgeModal>
  );
}
