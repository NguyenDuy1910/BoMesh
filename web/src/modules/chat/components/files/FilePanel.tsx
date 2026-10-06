"use client";

import { BookUp, ChevronDown, Download, FileWarning, History, Layers, MoreHorizontal, Pencil, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";

import { Button, buttonClasses } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { Menu, MenuItem, MenuLabel, MenuRadioItem, MenuSeparator, type MenuTriggerProps } from "@/components/ui/Menu";
import { Skeleton } from "@/components/ui/Skeleton";
import { TabPanel, Tabs } from "@/components/ui/Tabs";
import { useToast } from "@/components/ui/Toast";
import { Tooltip } from "@/components/ui/Tooltip";
import { usePendingFeature } from "@/lib/api/pending";
import { cn } from "@/lib/cn";
import { isPendingMarkerEnabled } from "@/lib/config/pending";
import { FileTypeIcon, fileTypeOf } from "@/modules/knowledge/components/FileTypeIcon";
import { formatBytes, formatRelative } from "@/lib/format";

import {
  createArtifactRevision,
  deleteArtifactRevision,
  exportArtifactRevision,
  getArtifact,
  getArtifactContent,
  type ArtifactExportFormat,
} from "../../api";
import type { TurnArtifact } from "../../artifacts";
import { AskForChanges } from "./AskForChanges";
import { FileChanges } from "./FileChanges";
import { PublishDialog, RenameDialog } from "./FileDialogs";
import { FileEditor, editorText } from "./FileEditor";
import { FileHistory, type SavedCopy } from "./FileHistory";
import {
  baseName,
  canEditByHand,
  EXPORT_FORMATS,
  exportFormatsFor,
  extensionLabel,
  previousRevision,
  revisionTitle,
  type FileRevision,
} from "./file-model";
import { FilePreview } from "./FilePreview";
import { useFileDetail, useRevisionContents, type FileDetail } from "./useFileData";

export interface FilePanelProps {
  artifactId: string;
  /** The version to show; the newest when omitted. A newer value (the assistant made one) re-reads the file. */
  revision?: number;
  /** The chat the panel sits in. */
  conversationId: string;
  onClose: () => void;
  /** Send `instruction` as a chat turn addressed to the file. */
  onAskForChanges: (artifact: TurnArtifact, instruction: string) => void;
  /** A hand edit or restore made `revision`. */
  onSaved?: (revision: number) => void;
  /** A turn is streaming in this chat: asking and editing wait for it. */
  working?: boolean;
  /**
   * Whether a hand edit has unsaved changes. The host asks before replacing
   * or closing the panel some other way (another file, Esc, another panel).
   */
  onDirtyChange?: (dirty: boolean) => void;
}

type PanelTab = "preview" | "changes" | "history";

const errorText = (cause: unknown, fallback: string) => (cause instanceof Error && cause.message ? cause.message : fallback);

/** A neutral "Preview" word for places a focusable PreviewTag cannot go (inside a menu item). */
function LocalMark() {
  if (!isPendingMarkerEnabled()) return null;
  return (
    <span className="ml-1.5 inline-flex h-5 items-center rounded-sm bg-surface-inset px-1.5 text-[length:var(--text-size-caption)] font-medium text-text-secondary">
      Preview
    </span>
  );
}

/** A quiet icon button that opens a menu, with its name as a tooltip. */
function iconTrigger(label: string, icon: React.ReactNode) {
  return function IconTrigger(props: MenuTriggerProps, open: boolean) {
    return (
      <Tooltip disabled={open} label={label} side="bottom">
        <button {...props} aria-label={label} className={buttonClasses({ variant: "ghost", size: "sm", iconOnly: true, selected: open })}>
          {icon}
        </button>
      </Tooltip>
    );
  };
}

function saveBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

function openDownload(url: string) {
  const link = document.createElement("a");
  link.href = url;
  link.rel = "noopener noreferrer";
  link.target = "_blank";
  link.click();
}

/**
 * The file workspace beside the conversation: Preview · Changes · History,
 * a version menu, downloads, Save to knowledge, Rename, edit in place and
 * "Ask for changes". Nothing is ever overwritten: every edit, restore or
 * request makes a new version.
 */
export function FilePanel({ artifactId, onAskForChanges, onClose, onDirtyChange, onSaved, revision, working = false }: FilePanelProps) {
  const router = useRouter();
  const toast = useToast();
  const idBase = useId();
  const manualRevisions = usePendingFeature("artifact.manual_revision");
  const renameEnabled = usePendingFeature("artifact.rename");
  const exportEnabled = usePendingFeature("artifact.export_formats");
  const file = useFileDetail(artifactId);
  const contents = useRevisionContents(file.detail);
  const { reload } = file;

  const [selected, setSelected] = useState<number | undefined>(revision);
  const [tab, setTab] = useState<PanelTab>("preview");
  const [editing, setEditing] = useState<{ text: string; format: "markdown" | "text" } | null>(null);
  const [startingEdit, setStartingEdit] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editError, setEditError] = useState<string>();
  const [leave, setLeave] = useState<(() => void) | null>(null);
  const [restoring, setRestoring] = useState<number | null>(null);
  const [dialog, setDialog] = useState<"publish" | "rename" | null>(null);
  const [saved, setSaved] = useState<SavedCopy[]>([]);
  const editorRef = useRef<HTMLDivElement>(null);

  // The assistant made a newer version: read the file again and show it.
  const shownRevision = useRef(revision);
  useEffect(() => {
    if (revision === shownRevision.current) return;
    shownRevision.current = revision;
    setSelected(revision);
    void reload().catch(() => undefined);
  }, [reload, revision]);

  const unsaved = Boolean(editing) && dirty;
  useEffect(() => {
    onDirtyChange?.(unsaved);
  }, [onDirtyChange, unsaved]);
  // Unmounting with unsaved edits was confirmed by the host; report clean.
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const detail = file.detail;
  const revisions = useMemo(() => detail?.revisions ?? [], [detail]);
  const latest = revisions.at(-1);
  const current = revisions.find((candidate) => candidate.revision === selected) ?? latest;
  const previous = current ? previousRevision(revisions, current.revision) : undefined;
  const serverLatest = revisions.filter((candidate) => !candidate.local).at(-1);

  /** Run `action`, first asking to discard unsaved edits. */
  const guard = useCallback(
    (action: () => void) => {
      const proceed = () => {
        setEditing(null);
        setDirty(false);
        setEditError(undefined);
        action();
      };
      if (editing && dirty) setLeave(() => proceed);
      else if (editing) proceed();
      else action();
    },
    [dirty, editing],
  );

  const selectRevision = (next: number, nextTab?: PanelTab) =>
    guard(() => {
      setSelected(next);
      if (nextTab) setTab(nextTab);
      else if (tab === "history") setTab("preview");
    });

  const undo = useCallback(
    async (made: number) => {
      try {
        await deleteArtifactRevision(artifactId, made);
        await reload();
        setSelected(undefined);
        setTab("preview");
        toast.show({ message: `Version ${made} undone`, tone: "neutral" });
      } catch (cause) {
        toast.show({ message: `Version ${made} was kept`, description: errorText(cause, "Try again in a moment."), tone: "err" });
      }
    },
    [artifactId, reload, toast],
  );

  if (!detail || !current || !latest) {
    return (
      <PanelFrame label="File">
        {file.failure ? (
          <>
            <div className="flex min-h-14 items-center justify-end border-b border-border-subtle px-2.5">
              <CloseButton onClose={onClose} />
            </div>
            <div className="p-4">
              {file.failure.gone ? (
                <EmptyState
                  description="It may have been deleted, or you no longer have access to it."
                  icon={<FileWarning />}
                  size="sm"
                  title="This file isn’t available"
                />
              ) : (
                <ErrorState description={file.failure.message} onAction={file.retry} />
              )}
            </div>
          </>
        ) : (
          <div aria-busy="true" aria-label="Loading file" role="status">
            <div className="flex min-h-14 items-center gap-2.5 border-b border-border-subtle px-4">
              <Skeleton className="size-8 rounded-md" />
              <div className="grid flex-1 gap-1.5">
                <Skeleton className="h-4 w-1/2" />
                <Skeleton className="h-3 w-1/3" />
              </div>
            </div>
            <div className="grid gap-3 p-4">
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-2/3" />
            </div>
          </div>
        )}
      </PanelFrame>
    );
  }

  const isSheet = detail.kind === "sheet";
  const editable = manualRevisions && canEditByHand(detail.kind) && !working;
  const nextVersion = latest.revision + 1;
  const asArtifact: TurnArtifact = {
    id: detail.id,
    title: detail.title,
    fileName: detail.fileName,
    mimeType: detail.mimeType,
    revision: latest.revision,
    sizeBytes: latest.sizeBytes,
    updatedAt: latest.createdAt ?? "",
  };

  const download = async (target: FileRevision) => {
    const name = target.revision === latest.revision ? detail.fileName : `${baseName(detail.fileName)} (version ${target.revision})${extensionLabel(detail.fileName)}`;
    try {
      if (target.local) {
        saveBlob(new Blob([target.content ?? ""], { type: target.mimeType ?? detail.mimeType }), name);
        toast.show({ message: `Downloaded ${name}` });
        return;
      }
      // Signed URLs are short-lived: resolve one now, from the version itself or its preview.
      const fresh = await getArtifact(detail.id);
      const url = fresh.revisions.find((candidate) => candidate.revision === target.revision)?.download_url
        ?? (fresh.revision === target.revision ? fresh.download_url : null)
        ?? (await getArtifactContent(detail.id, target.revision)).preview?.original.url;
      if (!url) throw new Error("The download link isn’t available yet. Try again in a moment.");
      openDownload(url);
      toast.show({ message: `Downloading ${name}` });
    } catch (cause) {
      toast.show({ message: "Nothing was downloaded", description: errorText(cause, "Try again in a moment."), tone: "err" });
    }
  };

  const downloadAs = async (target: FileRevision, format: ArtifactExportFormat) => {
    const name = `${baseName(detail.fileName)}${target.revision === latest.revision ? "" : ` (version ${target.revision})`}.${EXPORT_FORMATS[format].extension}`;
    try {
      saveBlob(await exportArtifactRevision(detail.id, target.revision, format), name);
      toast.show({ message: `Downloaded ${name}` });
    } catch (cause) {
      toast.show({ message: "Nothing was downloaded", description: errorText(cause, "Try again in a moment."), tone: "err" });
    }
  };

  const startEdit = async () => {
    if (!canEditByHand(detail.kind)) return;
    setStartingEdit(true);
    try {
      const value = await contents.content(current);
      if (value.truncated) {
        toast.show({ message: "This version is too long to edit here", description: "Ask for changes instead.", tone: "info" });
        return;
      }
      setTab("preview");
      setEditError(undefined);
      setDirty(false);
      setEditing({ text: value.text, format: detail.kind === "markdown" ? "markdown" : "text" });
    } catch (cause) {
      toast.show({ message: "The editor didn’t open", description: errorText(cause, "Try again in a moment."), tone: "err" });
    } finally {
      setStartingEdit(false);
    }
  };

  const saveEdit = async () => {
    const editor = editorRef.current;
    if (!editor || !editing) return;
    setSaving(true);
    setEditError(undefined);
    try {
      const made = await createArtifactRevision(detail.id, { content: editorText(editor, editing.format), summary: "Edited by you" });
      await reload();
      setEditing(null);
      setDirty(false);
      setSelected(made.revision);
      setTab("changes");
      onSaved?.(made.revision);
      toast.show({ message: `Saved as version ${made.revision}`, action: { label: "Undo", onClick: () => void undo(made.revision) } });
    } catch (cause) {
      setEditError(`Nothing was saved. ${errorText(cause, "Try again in a moment.")}`);
    } finally {
      setSaving(false);
    }
  };

  const restore = async (from: number) => {
    let made: number;
    try {
      made = (await createArtifactRevision(detail.id, { summary: `Restored version ${from}`, restored_from: from })).revision;
    } catch (cause) {
      throw new Error(`Nothing was saved. ${errorText(cause, "Try again in a moment.")}`);
    }
    await reload().catch(() => undefined);
    setSelected(made);
    setTab("preview");
    onSaved?.(made);
    toast.show({ message: `Restored as version ${made}`, action: { label: "Undo", onClick: () => void undo(made) } });
  };

  const formats = exportEnabled ? exportFormatsFor(detail.mimeType, detail.fileName) : [];
  const type = fileTypeOf(detail.mimeType, detail.fileName);
  const tabs = [
    { id: "preview" as const, label: "Preview" },
    { id: "changes" as const, label: previous ? `Changes from v${previous.revision}` : "Changes" },
    { id: "history" as const, label: "History", count: revisions.length },
  ];

  return (
    <PanelFrame label={detail.title}>
      <header className="flex min-h-14 shrink-0 items-center gap-2.5 border-b border-border-subtle py-2.5 pl-4 pr-2.5">
        <FileTypeIcon decorative kind={type.kind} label={type.label} size="md" />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <h2 className="truncate text-[14.5px] font-semibold" title={detail.title}>{detail.title}</h2>
            <VersionMenu current={current} latest={latest} onCompare={() => guard(() => setTab("changes"))} onHistory={() => guard(() => setTab("history"))} onSelect={(next) => selectRevision(next, tab === "changes" && next === revisions[0]?.revision ? "preview" : undefined)} previous={previous} revisions={revisions} />
          </div>
          <p className="truncate text-[length:var(--text-size-meta)] text-text-tertiary">
            {[
              detail.fileName,
              current.sizeBytes > 0 ? formatBytes(current.sizeBytes) : null,
              `${current.author === "you" ? "edited by you" : "by the assistant"}${current.createdAt ? ` ${formatRelative(current.createdAt).toLowerCase()}` : ""}`,
            ].filter(Boolean).join(" · ")}
          </p>
        </div>
        <Menu
          align="end"
          trigger={iconTrigger("Download", <Download aria-hidden="true" className="size-4" />)}
        >
          <MenuLabel>Version {current.revision}</MenuLabel>
          <MenuItem icon={<Download />} onSelect={() => void download(current)} shortcut={extensionLabel(detail.fileName)}>
            {current.local ? "This version" : "Original file"}
          </MenuItem>
          {formats.length > 0 && (
            <>
              <MenuSeparator />
              <MenuLabel>Download as <LocalMark /></MenuLabel>
              {formats.map((format) => (
                <MenuItem key={format} onSelect={() => void downloadAs(current, format)} shortcut={`.${EXPORT_FORMATS[format].extension}`}>
                  {format === "csv" ? "CSV (every sheet)" : EXPORT_FORMATS[format].label}
                </MenuItem>
              ))}
            </>
          )}
        </Menu>
        <Tooltip label="Save to knowledge" side="bottom">
          <Button
            aria-label="Save to knowledge"
            icon={<BookUp aria-hidden="true" className="size-4" />}
            iconOnly
            onClick={() => setDialog("publish")}
            size="sm"
            variant="ghost"
          />
        </Tooltip>
        <Menu
          align="end"
          trigger={iconTrigger("More file actions", <MoreHorizontal aria-hidden="true" className="size-4" />)}
        >
          {renameEnabled && (
            <MenuItem icon={<Pencil />} onSelect={() => setDialog("rename")}>
              Rename
            </MenuItem>
          )}
          <MenuItem icon={<BookUp />} onSelect={() => setDialog("publish")}>
            Save to knowledge…
          </MenuItem>
          <MenuSeparator />
          <MenuItem disabled={!previous} icon={<Layers />} onSelect={() => guard(() => setTab("changes"))}>
            Compare with previous
          </MenuItem>
          <MenuItem icon={<History />} onSelect={() => guard(() => setTab("history"))}>
            All versions
          </MenuItem>
        </Menu>
        <CloseButton onClose={() => guard(onClose)} />
      </header>

      <div className="flex shrink-0 items-center gap-2 border-b border-border-subtle px-4">
        <Tabs
          activeTab={tab}
          ariaLabel="File views"
          className="min-w-0 flex-1 border-b-0"
          idBase={idBase}
          onChange={(next) => next !== tab && guard(() => setTab(next))}
          tabs={tabs}
        />
        {editable && tab === "preview" && !editing && (
          <Button
            disabled={working}
            icon={<Pencil aria-hidden="true" className="size-4" />}
            loading={startingEdit}
            onClick={() => void startEdit()}
            size="sm"
            variant="ghost"
          >
            Edit
          </Button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-auto bg-surface-subtle" data-file-panel-body>
        {current.revision !== latest.revision && tab !== "history" && !editing && (
          <div className="px-4 pt-3">
            <Callout
              actions={
                <>
                  <Button onClick={() => selectRevision(latest.revision)} size="sm" variant="secondary">
                    View latest
                  </Button>
                  {manualRevisions && (
                    <Button onClick={() => setRestoring(current.revision)} size="sm" variant="ghost">
                      Restore this version
                    </Button>
                  )}
                </>
              }
              title={`You’re viewing version ${current.revision} of ${latest.revision}`}
              tone="neutral"
            >
              {manualRevisions ? "Restoring makes a new version from it; nothing is overwritten." : null}
            </Callout>
          </div>
        )}
        <TabPanel idBase={idBase} tab={tab}>
          {editing ? (
            <FileEditor
              editorRef={editorRef}
              format={editing.format}
              label={detail.title}
              nextVersion={nextVersion}
              onChange={setDirty}
              onEscape={() => guard(() => undefined)}
              text={editing.text}
            />
          ) : tab === "history" ? (
            <FileHistory
              canRestore={manualRevisions}
              canSave
              onRestore={setRestoring}
              onSave={() => setDialog("publish")}
              onView={(next) => selectRevision(next, "preview")}
              revisions={revisions}
              saved={saved}
              selected={current.revision}
            />
          ) : tab === "changes" ? (
            <FileChanges contents={contents} detail={detail} previous={previous} revision={current} />
          ) : (
            <FilePreview contents={contents} detail={detail} onDownload={() => void download(current)} revision={current} />
          )}
        </TabPanel>
      </div>

      {editing ? (
        <div className="shrink-0 border-t border-border-subtle bg-surface-base px-3.5 py-2.5">
          {editError && (
            <Callout className="mb-2.5" tone="err">
              {editError}
            </Callout>
          )}
          <div className="flex items-center gap-2">
            <span aria-live="polite" className="flex-1 text-[12.5px] text-text-tertiary">
              {dirty ? "Unsaved changes" : "No changes yet"}
            </span>
            <Button disabled={saving} onClick={() => guard(() => undefined)} size="sm" variant="secondary">
              Cancel
            </Button>
            <Button disabled={!dirty} loading={saving} onClick={() => void saveEdit()} size="sm">
              Save as version {nextVersion}
            </Button>
          </div>
        </div>
      ) : (
        <AskForChanges isSheet={isSheet} onAsk={(instruction) => onAskForChanges(asArtifact, instruction)} title={detail.title} working={working} />
      )}

      <ConfirmDialog
        confirmLabel="Discard edits"
        description="Your changes to this document haven’t been saved as a version."
        onClose={() => setLeave(null)}
        onConfirm={() => {
          const proceed = leave;
          setLeave(null);
          proceed?.();
        }}
        open={leave !== null}
        title="Discard your edits?"
      />
      <ConfirmDialog
        confirmLabel="Restore"
        description={restoring === null ? "" : `This makes version ${nextVersion}, a copy of version ${restoring}. Every version stays in History.`}
        destructive={false}
        onClose={() => setRestoring(null)}
        onConfirm={() => (restoring === null ? undefined : restore(restoring))}
        open={restoring !== null}
        title={restoring === null ? "Restore" : `Restore version ${restoring}?`}
      />
      <PublishDialog
        artifactId={detail.id}
        latest={latest}
        onClose={() => setDialog(null)}
        onPublished={(result, collection) => {
          setDialog(null);
          setSaved((copies) => [
            { collectionId: result.collection_id, collectionTitle: collection.title, revision: result.revision, savedAt: new Date().toISOString() },
            ...copies.filter((copy) => copy.collectionId !== result.collection_id),
          ]);
          toast.show({
            message: result.created ? `Saved to ${collection.title}` : `Already saved to ${collection.title}`,
            action: { label: "Open", onClick: () => router.push(`/knowledge/${encodeURIComponent(result.collection_id)}`) },
          });
        }}
        open={dialog === "publish"}
        serverLatest={serverLatest}
        title={detail.title}
      />
      {renameEnabled && (
        <RenameDialog
          artifactId={detail.id}
          onClose={() => setDialog(null)}
          onRenamed={(title) => {
            setDialog(null);
            void reload().catch(() => undefined);
            toast.show({ message: `Renamed to ${title}` });
          }}
          open={dialog === "rename"}
          title={detail.title}
        />
      )}
    </PanelFrame>
  );
}

function PanelFrame({ children, label }: { children: React.ReactNode; label: string }) {
  return (
    <aside
      aria-label={label}
      className={cn(
        // 600px beside the thread; at ≤1100px the chat's overlay host caps it at 96% of the thread.
        "flex h-full min-h-0 w-[600px] max-w-full shrink-0 flex-col border-l border-border-subtle bg-surface-base text-text-primary",
        "motion-safe:animate-ui-slide-in",
      )}
    >
      {children}
    </aside>
  );
}

function CloseButton({ onClose }: { onClose: () => void }) {
  return (
    <Tooltip label="Close" side="bottom">
      <Button aria-label="Close file" icon={<X aria-hidden="true" className="size-4" />} iconOnly onClick={onClose} size="sm" variant="ghost" />
    </Tooltip>
  );
}

function VersionMenu({
  current,
  latest,
  onCompare,
  onHistory,
  onSelect,
  previous,
  revisions,
}: {
  revisions: readonly FileRevision[];
  current: FileRevision;
  latest: FileRevision;
  previous: FileRevision | undefined;
  onSelect: (revision: number) => void;
  onCompare: () => void;
  onHistory: () => void;
}) {
  return (
    <Menu
      trigger={(props) => (
        <button
          {...props}
          aria-label={`Version ${current.revision} of ${latest.revision}. Change version`}
          className="inline-flex h-[22px] shrink-0 items-center gap-1 rounded-sm bg-surface-inset pl-2 pr-1.5 text-[length:var(--text-size-caption)] font-medium text-text-secondary hover:bg-surface-pressed hover:text-text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
        >
          v{current.revision}
          {current.revision === latest.revision && " · latest"}
          <ChevronDown aria-hidden="true" className="size-3" />
        </button>
      )}
    >
      <MenuLabel>Versions</MenuLabel>
      {[...revisions].reverse().map((candidate) => (
        <MenuRadioItem
          checked={candidate.revision === current.revision}
          key={`${candidate.revision}-${candidate.local}`}
          onSelect={() => onSelect(candidate.revision)}
          textValue={`Version ${candidate.revision}`}
        >
          <span className="flex min-w-0 flex-col">
            <span className="flex items-center">
              Version {candidate.revision}
              {candidate.revision === latest.revision && " · latest"}
              {candidate.local && <LocalMark />}
            </span>
            <span className="truncate text-[length:var(--text-size-caption)] text-text-tertiary">
              {revisionTitle(candidate, candidate === revisions[0])}
              {candidate.createdAt ? ` · ${formatRelative(candidate.createdAt)}` : ""}
            </span>
          </span>
        </MenuRadioItem>
      ))}
      <MenuSeparator />
      <MenuItem disabled={!previous} icon={<Layers />} onSelect={onCompare}>
        Compare with previous
      </MenuItem>
      <MenuItem icon={<History />} onSelect={onHistory}>
        All versions
      </MenuItem>
    </Menu>
  );
}
