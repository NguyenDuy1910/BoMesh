"use client";

import { Button, Description, FieldError, Label, ListBox, ProgressBar, Select, TextArea, TextField } from "@heroui/react";
import { useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { CircleAlert, CircleCheck, Send, Upload, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useRef, useState, type DragEvent } from "react";

import { ChoiceGroup } from "@/components/ui/ChoiceGroup";
import { FileIcon } from "@/components/ui/FileIcon";
import { IconButton } from "@/components/ui/IconButton";
import { List, ListItem } from "@/components/ui/List";
import { toast } from "@/components/ui/Toast";
import { api, call, errorMessage, requestId, resourceId } from "@/lib/api/client";
import { fmtSize, plural } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";

import { createContribution, uploadDocument, type Item } from "../api";
import { CONTRIBUTE_TYPES, fileProblem } from "../model";
import { invalidateKnowledge, useContributionTargets, useItem } from "../queries";
import { createOverlayStore } from "./dialog-store";
import { KnowledgeModal } from "./KnowledgeModal";

/* ═══════════════ Opener ═══════════════ */

export interface ContributeOptions {
  /** `share` = Share as knowledge (review first, default for contributors); `private` = Keep private in My files. */
  mode?: "share" | "private";
  /** Preselected knowledge base (item name or ID). The caller's personal collection means My files. */
  collection?: string;
  /** Submit a new version of this published document (item name or ID). */
  item?: string;
}

const store = createOverlayStore<ContributeOptions>();

/** Opens the Contribute dialog (preview `A['contribute']`). Rendered by `<ContributeHost/>`. */
export function openContribute(options: ContributeOptions = {}) {
  store.open(options);
}

/** Current Contribute request (for `<ContributeHost/>`). */
export const useContributeRequest = store.useCurrent;
export const closeContribute = store.close;

/* ═══════════════ Dialog ═══════════════ */

interface Entry {
  id: number;
  file: File;
  err: string;
  /** 0–1 while uploading. */
  progress: number;
  state: "ready" | "uploading" | "done" | "failed";
}

const ACCEPT = CONTRIBUTE_TYPES.map((x) => `.${x}`).join(",");
let entrySeq = 0;

export interface ContributeDialogProps extends ContributeOptions {
  isOpen: boolean;
  onClose: () => void;
}

/**
 * Contribute (preview `M['contribute']`, DOCUMENT_LIFECYCLE.md): drop or browse files, choose Share as
 * knowledge (a reviewer checks it before it's published) or Keep private in My files, pick a knowledge base
 * (or let the assistant suggest), add a note. Files upload into the member's PERSONAL collection; sharing then
 * opens a Contribution for review — nothing publishes without a reviewer. New-version mode takes one file and
 * a required "What changed?".
 */
export function ContributeDialog({ isOpen, onClose, mode, collection, item }: ContributeDialogProps) {
  const { id: ws, can, member } = useWorkspace();
  const router = useRouter();
  const qc = useQueryClient();
  const targets = useContributionTargets();
  const base = useItem(item);
  const baseDoc: Item | undefined = item ? base.data : undefined;
  const personal = member.personalCollection;
  const canShare = can("contributions.create") && (targets.data.length > 0 || !!item);
  const preferPrivate = mode === "private" || (!!collection && !!personal && resourceId(collection) === resourceId(personal));
  const [dest, setDest] = useState<"share" | "private">(item ? "share" : canShare && !preferPrivate ? "share" : "private");
  const presetKb = collection && !preferPrivate ? `workspaces/${ws}/items/${resourceId(collection)}` : "";
  const [kb, setKb] = useState(presetKb);
  const [note, setNote] = useState("");
  const [files, setFiles] = useState<Entry[]>([]);
  const [busy, setBusy] = useState(false);
  const [touched, setTouched] = useState(false);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const priv = !item && (dest === "private" || !canShare);
  const share = !priv;

  const valid = files.filter((f) => !f.err);
  const skipped = files.length - valid.length;
  const full = !!item && valid.length > 0;
  const target = targets.data.find((t) => t.name === kb);
  const versionBase = baseDoc;
  const noteError = item && touched && !note.trim() ? "Say what changed." : "";

  function add(list: FileList | File[]) {
    let next = [...files, ...[...list].map((file) => ({ id: ++entrySeq, file, err: fileProblem(file), progress: 0, state: "ready" as const }))];
    // A new version takes one file: keep the latest valid one.
    if (item) {
      const ok = next.filter((x) => !x.err);
      if (ok.length > 1) next = next.filter((x) => x.err || x === ok.at(-1));
    }
    setFiles(next);
  }

  const patch = (id: number, p: Partial<Entry>) => setFiles((list) => list.map((x) => (x.id === id ? { ...x, ...p } : x)));

  async function submit() {
    if (busy || !valid.length || !personal) return;
    if (item && !note.trim()) {
      setTouched(true);
      return;
    }
    setBusy(true);
    const uploaded: { entry: Entry; doc: Item }[] = [];
    const failed: { entry: Entry; error: unknown }[] = [];
    await Promise.all(
      valid.map(async (entry) => {
        patch(entry.id, { state: "uploading", progress: 0 });
        try {
          const doc = await uploadDocument(ws, { parentItem: personal, file: entry.file }, (p) => patch(entry.id, { progress: p }));
          if (share) {
            await createContribution(ws, {
              kind: item ? "NEW_REVISION" : "NEW_DOCUMENT",
              item: doc.name,
              targetCollection: item ? undefined : kb || undefined,
              replacesItem: item ? `workspaces/${ws}/items/${resourceId(item)}` : undefined,
              note: note.trim() || undefined,
              changeSummary: item ? note.trim() : undefined,
            });
          }
          patch(entry.id, { state: "done", progress: 1 });
          uploaded.push({ entry, doc });
        } catch (error) {
          patch(entry.id, { state: "failed", err: errorMessage(error) });
          failed.push({ entry, error });
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
    if (failed.length) {
      setFiles((list) => list.filter((x) => x.state !== "done"));
      if (uploaded.length) toast(`${plural(uploaded.length, "file")} added; ${plural(failed.length, "file")} couldn’t be uploaded`, { tone: "warning" });
      return;
    }
    onClose();
    if (priv) {
      toast("Added to My files", { action: { label: "Open", onPress: () => router.push("/knowledge/library?tab=files") } });
      return;
    }
    const review = can("contributions.review");
    const message = item
      ? "Submitted the new version for review"
      : uploaded.length === 1
        ? `Submitted “${uploaded[0].doc.displayName}” for review`
        : `Submitted ${plural(uploaded.length, "document")} for review`;
    toast(message, {
      action: review
        ? { label: "Review now", onPress: () => router.push("/documents?tab=review") }
        : { label: "Track", onPress: () => router.push("/knowledge/library?tab=contributions") },
    });
  }

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files.length) add(e.dataTransfer.files);
  };

  const n = valid.length;
  const label = item ? "Submit new version" : priv ? (n > 1 ? `Add ${n} files` : "Add to My files") : n > 1 ? `Submit ${n} for review` : "Submit for review";
  const SubmitIcon = priv ? Upload : Send;

  return (
    <KnowledgeModal
      isOpen={isOpen}
      onClose={onClose}
      size="lg"
      guard={busy}
      title={item ? "Submit a new version" : canShare ? "Contribute" : "Upload to My files"}
      description={item ? "A reviewer checks it before it replaces the current version." : canShare ? undefined : "Only you can see these files."}
      footerStart={skipped && !busy ? <span className="t-sm muted">{plural(skipped, "file")} will be skipped</span> : null}
      footer={
        <>
          <Button variant="tertiary" onPress={onClose} isDisabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onPress={() => void submit()} isDisabled={!n || !personal} isPending={busy}>
            <SubmitIcon className="i" aria-hidden />
            {label}
          </Button>
        </>
      }
    >
      {versionBase ? (
        <div className="ctb-current">
          <FileIcon name={versionBase.document?.fileName} mime={versionBase.document?.mimeType} />
          <div className="grow">
            <div className="medium truncate" translate="no">
              {versionBase.displayName}
            </div>
            <div className="t-xs muted">
              Current version v{/\/revisions\/(\d+)$/.exec(versionBase.document?.revision ?? "")?.[1] ?? "1"}
              {versionBase.ancestors?.[0]?.displayName ? ` · ${versionBase.ancestors[0].displayName}` : ""}
            </div>
          </div>
        </div>
      ) : null}
      {busy ? (
        <p className="t-sm muted mb-12">
          {priv ? "Adding to My files…" : item ? `Uploading the new version of ${versionBase?.displayName ?? "the document"}…` : target ? `Uploading for review in ${target.displayName}…` : "Uploading for review…"}
        </p>
      ) : null}
      {!personal ? (
        <p className="t-sm muted">You can’t add files to any knowledge base.</p>
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
              PDF, Word, Excel, PowerPoint, text, Markdown or HTML · up to 100 MB{item ? "" : " each"}
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
                        <ProgressBar aria-label="Upload progress" value={Math.round(x.progress * 100)} color={x.state === "done" ? "success" : "accent"}>
                          <ProgressBar.Track>
                            <ProgressBar.Fill />
                          </ProgressBar.Track>
                        </ProgressBar>
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
      {!item && !busy && canShare && personal ? (
        <div className="field ctb-dest">
          <span className="label">Where should it go?</span>
          <ChoiceGroup
            label="Where should it go?"
            columns={2}
            value={dest}
            onChange={setDest}
            options={[
              { value: "share", title: "Share as knowledge", description: "A reviewer checks it before it’s published." },
              { value: "private", title: "Keep private in My files", description: "Only you can use it, e.g. in chat." },
            ]}
          />
        </div>
      ) : null}
      {!item && share && !busy ? (
        <div className="ctb-fields">
          <Select value={kb || "suggest"} onChange={(v) => setKb(v === "suggest" ? "" : String(v))}>
            <Label>Knowledge base</Label>
            <Select.Trigger>
              <Select.Value />
              <Select.Indicator />
            </Select.Trigger>
            <Description>{target ? `Reviewed by the owners of ${target.displayName}.` : "The assistant picks the best fit. A reviewer confirms it."}</Description>
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
          <TextField value={note} onChange={setNote} maxLength={400}>
            <Label>
              Note for reviewers <span className="label__opt">(optional)</span>
            </Label>
            <TextArea rows={2} placeholder="What it covers and who it helps" />
          </TextField>
        </div>
      ) : null}
      {item && !busy ? (
        <div className="ctb-fields">
          <TextField value={note} onChange={setNote} maxLength={400} isRequired isInvalid={!!noteError}>
            <Label>What changed?</Label>
            <TextArea rows={3} placeholder="e.g. Corrected section 2 and updated the dates" />
            <Description>Reviewers see this next to the current version.</Description>
            <FieldError>{noteError}</FieldError>
          </TextField>
        </div>
      ) : null}
    </KnowledgeModal>
  );
}
