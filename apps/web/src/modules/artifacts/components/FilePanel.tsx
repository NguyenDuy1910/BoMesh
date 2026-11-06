"use client";

import { Button, Input, Spinner, Tooltip } from "@heroui/react";
import { useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { ArrowUp, ChevronRight, GitCompare, History, Maximize2, Pencil, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { errorMessage } from "@/lib/api/client";
import { fmtSize, rel } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";
import { Callout, confirm, EmptyState, ErrorState, FileIcon, IconButton, SectionTabs, SkeletonRows, toast } from "@/components/ui";

import { commitArtifact, deleteRevision, rollbackRevision, type Artifact } from "../api";
import { columnLetter } from "../sheet";
import { fileNameOf, fileViewOf, isEditableView, isSheetView, revisionNumber, toDelimited, type Version } from "../model";
import { listenPanel, setLeaveGuard, type PanelTab } from "../panel-bus";
import { artifactKeys, useArtifact, useVersions } from "../queries";
import { askForChanges, useRevising } from "../revise";
import { DownloadMenu, FileMoreMenu, VersionMenu } from "./ArtifactMenus";
import { DocEditor, MarkdownPage, PlainPage, RenditionDiff, RenditionPage, TextDiff, type DocEditorHandle } from "./DocView";
import { PublishDialog, RenameDialog } from "./FileDialogs";
import { FileHistory } from "./FileHistory";
import { SheetView, type CellRef } from "./SheetView";
import { useVersionContent, type VersionContent } from "./useVersionContent";

export interface FilePanelProps {
  /** Artifact resource name (`workspaces/w/artifacts/a`) or ID. */
  artifact: string;
  onClose: () => void;
}

/** Wider/narrower survives switching files, like the preview's panel state. */
let widePanel = false;

/**
 * The file workspace panel (preview `X.chatFiles.panel`): Preview · Changes ·
 * History of an artifact, edit in place, ask for changes, restore, download,
 * rename and save to knowledge. Every change makes a new version.
 */
export function FilePanel({ artifact: artifactRef, onClose }: FilePanelProps) {
  const { id: ws, member } = useWorkspace();
  const artifactQ = useArtifact(artifactRef);
  const artifact = artifactQ.data;

  if (!artifact) {
    return (
      <aside className="split__panel split__panel--wide wk-panel" aria-label="File">
        <div className="panel__header wk-head">
          <h2 className="panel__title">{artifactQ.isError ? "File" : "Loading…"}</h2>
          <IconButton icon={X} tip="Close" size="sm" onPress={onClose} />
        </div>
        <div className="panel__body wk-body">
          {artifactQ.isError ? (
            <ErrorState error={artifactQ.error} onRetry={() => void artifactQ.refetch()} boxed={false} />
          ) : (
            <SkeletonRows rows={6} />
          )}
        </div>
      </aside>
    );
  }
  return <LoadedPanel key={artifact.name} ws={ws} artifact={artifact} isOwner={!artifact.owner || artifact.owner === member.name} onClose={onClose} />;
}

function LoadedPanel({ ws, artifact, isOwner, onClose }: { ws: string; artifact: Artifact; isOwner: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const name = artifact.name ?? "";
  const title = artifact.displayName || "Untitled file";
  const fileName = fileNameOf(artifact);
  const versionsQ = useVersions(name, artifact.revision);
  const versions = versionsQ.versions;
  const latest = versions.at(-1);
  const latestN = latest?.n ?? revisionNumber(artifact.revision);

  const [tab, setTab] = useState<PanelTab>("preview");
  const [revPick, setRevPick] = useState<number | null>(null);
  const [full, setFull] = useState(widePanel);
  const [sheetIndex, setSheetIndex] = useState(0);
  const [cell, setCell] = useState<CellRef | null>(null);
  const [editing, setEditing] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [askText, setAskText] = useState("");
  const [dialog, setDialog] = useState<"rename" | "publish" | null>(null);
  const editor = useRef<DocEditorHandle | null>(null);

  const revising = useRevising(name);
  const busy = revising > 0 || artifact.state === "GENERATING";

  const current: Version | undefined = versions.find((v) => v.n === revPick) ?? latest;
  const previous = current ? versions.find((v) => v.n === current.n - 1) : undefined;
  const view = fileViewOf(current?.mimeType || artifact.mimeType);
  const sheet = isSheetView(view);
  const isLatest = !!current && current.n === latestN;

  const content = useVersionContent(name, current, artifact.mimeType, tab !== "history");
  const before = useVersionContent(name, previous, artifact.mimeType, tab === "changes" && !!previous);

  /* ─── Leaving edit mode ─── */
  const leaveEdit = useCallback(async (): Promise<boolean> => {
    if (!editing) return true;
    if (dirty) {
      const ok = await confirm({ title: "Discard your edits?", description: "Your changes haven’t been saved as a version.", confirmLabel: "Discard edits", tone: "danger" });
      if (!ok) return false;
    }
    setEditing(false);
    setDirty(false);
    return true;
  }, [dirty, editing]);

  useEffect(() => {
    setLeaveGuard(editing ? leaveEdit : null);
    return () => setLeaveGuard(null);
  }, [editing, leaveEdit]);

  const go = useCallback(
    async (next: { rev?: number | null; tab?: PanelTab }) => {
      if (!(await leaveEdit())) return;
      if (next.rev !== undefined) setRevPick(next.rev);
      if (next.tab) setTab(next.tab);
      setCell(null);
    },
    [leaveEdit],
  );

  useEffect(() => listenPanel(name, (v) => void go({ rev: v.rev ?? null, tab: v.tab })), [go, name]);

  const refresh = () => qc.invalidateQueries({ queryKey: artifactKeys.one(ws, name) });

  /* ─── Changes that make a version ─── */
  const commit = async (text: string, summary: string, after: PanelTab) => {
    setSaving(true);
    try {
      const updated = await commitArtifact(ws, name, { text, changeSummary: summary, etag: artifact.etag });
      const n = revisionNumber(updated.revision);
      qc.setQueryData(artifactKeys.one(ws, name), updated);
      await refresh();
      setEditing(false);
      setDirty(false);
      setCell(null);
      setRevPick(null);
      setTab(after);
      toast(`Saved as version ${n}`, {
        undo: () =>
          void deleteRevision(ws, name, n)
            .then(async () => {
              await refresh();
              setRevPick(null);
              setTab("preview");
            })
            .catch((e: unknown) => toast("Couldn’t undo", { tone: "danger", description: errorMessage(e) })),
      });
    } catch (e) {
      toast("Couldn’t save", { tone: "danger", description: errorMessage(e) });
    } finally {
      setSaving(false);
    }
  };

  const saveEdit = () => {
    const markdown = editor.current?.markdown();
    if (markdown !== undefined) void commit(markdown, "Edited by you", "changes");
  };

  const saveCell = (at: CellRef, value: string) => {
    const s = content.sheets?.[0];
    if (!s) return;
    const columns = [...s.columns];
    const rows = s.rows.map((r) => [...r]);
    if (at.r === 0) {
      if (!value.trim() || value === columns[at.c]) return setCell(null);
      columns[at.c] = value.trim();
    } else {
      const row = rows[at.r - 1]!;
      if ((row[at.c] ?? "") === value) return setCell(null);
      while (row.length <= at.c) row.push("");
      row[at.c] = value;
    }
    const tsv = (current?.mimeType ?? "").includes("tab-separated");
    void commit(toDelimited(columns, rows, tsv ? "\t" : ","), `Edited ${columnLetter(at.c)}${at.r + 1}`, "preview");
  };

  const restore = async (n: number) => {
    const ok = await confirm({
      title: `Restore version ${n}?`,
      description: `This makes version ${latestN + 1}, a copy of version ${n}. Every version stays in History.`,
      confirmLabel: "Restore",
      tone: "accent",
    });
    if (!ok) return;
    try {
      const updated = await rollbackRevision(ws, name, n, artifact.etag);
      qc.setQueryData(artifactKeys.one(ws, name), updated);
      await refresh();
      setRevPick(null);
      setTab("preview");
      setCell(null);
      toast(`Restored as version ${revisionNumber(updated.revision)}`);
    } catch (e) {
      toast("Couldn’t restore", { tone: "danger", description: errorMessage(e) });
    }
  };

  const ask = (text: string) => {
    const instructions = text.trim();
    if (!instructions) {
      document.getElementById("wk-ask-in")?.focus();
      return;
    }
    if (busy) {
      toast("Wait for the current change to finish.", { tone: "accent" });
      return;
    }
    setAskText("");
    void askForChanges(qc, { workspace: ws, artifact: name, title, etag: artifact.etag, instructions, nextVersion: latestN + 1 });
  };

  const showInConversation = () => {
    const card = document.querySelector(`[data-artifact="${CSS.escape(name)}"]`);
    (card?.closest(".chat-msg") ?? card)?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  /* ─── Body ─── */
  let body: React.ReactNode;
  if (versionsQ.isError) body = <ErrorState error={versionsQ.error} onRetry={() => void versionsQ.refetch()} boxed={false} />;
  else if (!current) {
    body =
      artifact.state === "GENERATING" ? (
        <EmptyState icon={History} title="The assistant is writing this file" description="It appears here as soon as the first version is ready." compact />
      ) : versionsQ.isPending ? (
        <SkeletonRows rows={6} />
      ) : (
        <EmptyState icon={History} title="This file has no content" description={artifact.state === "FAILED" ? "The assistant couldn’t finish writing it." : "Nothing was saved yet."} compact />
      );
  } else if (tab === "history") {
    body = <FileHistory artifact={artifact} versions={versions} current={current.n} canRestore={isOwner && !busy} onView={(n) => void go({ rev: n, tab: "preview" })} onRestore={(n) => void restore(n)} />;
  } else if (tab === "changes") {
    body = !previous ? (
      <EmptyState
        icon={GitCompare}
        title="This is the first version"
        description={sheet ? "Edit a cell or ask for changes to make a new version." : "Edit it or ask for changes to make a new version."}
        compact
      />
    ) : (
      <>
        <div className="wk-legend">
          <span>
            <i className="wk-legend__add" />
            Added
          </span>
          {sheet ? (
            <span>
              <i className="wk-legend__chg" />
              Changed
            </span>
          ) : null}
          <span>
            <i className="wk-legend__del" />
            Removed
          </span>
          <span className="grow" />
          <span className="medium truncate">
            v{previous.n} → v{current.n} · {current.summary}
          </span>
        </div>
        <ChangesBody after={content} before={before} sheetIndex={sheetIndex} onSheetChange={setSheetIndex} />
      </>
    );
  } else if (editing && current.text !== undefined) {
    body = <DocEditor key={current.n} text={current.text} title={title} nextVersion={latestN + 1} onDirtyChange={setDirty} handleRef={editor} />;
  } else {
    body = (
      <PreviewBody
        content={content}
        title={title}
        sheetIndex={sheetIndex}
        onSheetChange={(i) => {
          setSheetIndex(i);
          setCell(null);
        }}
        cell={cell}
        onSelect={setCell}
        cellEditable={isOwner && isLatest && view === "csv" && !busy}
        onSaveCell={saveCell}
        saving={saving}
      />
    );
  }

  const canEdit = isOwner && !sheet && isEditableView(view) && tab === "preview" && !editing && isLatest && current?.text !== undefined;
  const oldVersion = current && !isLatest && tab !== "history";
  const quick = sheet ? ["Sort by largest amount", "Add a total row", "Add a status column"] : ["Make it shorter", "More formal tone", "Add an at-a-glance table"];

  return (
    <aside className={clsx("split__panel split__panel--wide wk-panel", full && "wk-panel--full")} aria-label={title}>
      <div className="panel__header wk-head">
        <FileIcon mime={artifact.mimeType} name={fileName} />
        <div className="grow" style={{ minWidth: 0 }}>
          <h2 className="panel__title truncate" translate="no">
            {title}
          </h2>
          <div className="t-xs muted truncate">
            <span translate="no">{fileName}</span>
            {current ? ` · ${fmtSize(current.sizeBytes)} · ${current.author === "you" ? "edited by you" : "by the assistant"} ${rel(current.createTime).toLowerCase()}` : null}
          </div>
        </div>
        {current ? (
          <VersionMenu
            versions={versions}
            current={current}
            onPick={(n) => void go({ rev: n })}
            onCompare={() => void go({ tab: "changes" })}
            onAll={() => void go({ tab: "history" })}
          />
        ) : null}
        <IconButton
          icon={full ? ChevronRight : Maximize2}
          tip={full ? "Narrower" : "Wider"}
          size="sm"
          className="hide-md"
          onPress={() => {
            widePanel = !full;
            setFull(!full);
          }}
        />
        <DownloadMenu artifact={artifact} version={current} latest={latestN} />
        <FileMoreMenu
          isOwner={isOwner}
          canPublish={artifact.state === "ACTIVE" && !!latest}
          inConversation={!!artifact.conversation}
          onPublish={() => setDialog("publish")}
          onRename={() => setDialog("rename")}
          onShowInConversation={showInConversation}
        />
        <IconButton icon={X} tip="Close" size="sm" onPress={() => void leaveEdit().then((ok) => ok && onClose())} />
      </div>

      <div className="wk-tabs">
        <SectionTabs
          label="File views"
          active={tab}
          onChange={(t) => void go({ tab: t as PanelTab })}
          items={[
            { id: "preview", label: "Preview" },
            { id: "changes", label: "Changes" },
            { id: "history", label: "History", count: versions.length || null },
          ]}
        />
        {canEdit ? (
          <Button size="sm" variant="ghost" isDisabled={busy} onPress={() => setEditing(true)}>
            <Pencil aria-hidden />
            Edit
          </Button>
        ) : null}
      </div>

      <div className="panel__body wk-body" id="chat-panel-body">
        {oldVersion ? (
          <div className="mb-12">
            <Callout
              icon={History}
              title={`You’re viewing version ${current.n} of ${versions.length}`}
              actions={
                <>
                  <Button size="sm" variant="tertiary" onPress={() => void go({ rev: null })}>
                    View latest
                  </Button>
                  {isOwner && !busy ? (
                    <Button size="sm" variant="ghost" onPress={() => void restore(current.n)}>
                      Restore
                    </Button>
                  ) : null}
                </>
              }
            />
          </div>
        ) : null}
        {body}
      </div>

      {editing ? (
        <div className="panel__footer wk-edit-foot">
          <span className="grow t-xs muted">{dirty ? "Unsaved changes" : "No changes yet"}</span>
          <Button size="sm" variant="tertiary" onPress={() => void leaveEdit()}>
            Cancel
          </Button>
          <Button size="sm" variant="primary" isDisabled={!dirty} isPending={saving} onPress={saveEdit}>
            Save as version {latestN + 1}
          </Button>
        </div>
      ) : !isOwner ? null : busy ? (
        <div className="panel__footer wk-ask">
          <div className="row gap-8 t-sm muted">
            <Spinner size="sm" />
            <span>Working on version {(revising || latestN + 1)}… you can keep reviewing.</span>
          </div>
        </div>
      ) : (
        <div className="panel__footer wk-ask">
          <div className="wk-ask__row">
            <Input
              id="wk-ask-in"
              fullWidth
              value={askText}
              placeholder="Ask for changes…"
              aria-label={`Ask for changes to ${title}`}
              onChange={(e) => setAskText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") ask(askText);
              }}
            />
            <Tooltip>
              <Button isIconOnly variant="primary" aria-label="Ask for changes" onPress={() => ask(askText)}>
                <ArrowUp aria-hidden />
              </Button>
              <Tooltip.Content>Ask for changes</Tooltip.Content>
            </Tooltip>
          </div>
          <div className="wk-quick">
            {quick.map((q) => (
              <button key={q} type="button" className="chip chip--default chip--outline wk-quick__item" onClick={() => ask(q)}>
                {q}
              </button>
            ))}
          </div>
        </div>
      )}

      {dialog === "rename" ? <RenameDialog artifact={artifact} isOpen onClose={() => setDialog(null)} /> : null}
      {dialog === "publish" ? <PublishDialog artifact={artifact} version={latestN} isOpen onClose={() => setDialog(null)} /> : null}
    </aside>
  );
}

function ContentState({ content, children }: { content: VersionContent; children: () => React.ReactNode }) {
  if (content.isError) return <ErrorState error={content.error} onRetry={content.refetch} boxed={false} title="This version didn’t load" />;
  if (content.isPending) return <SkeletonRows rows={6} />;
  return <>{children()}</>;
}

const WITHHELD = (
  <Callout title="Part of this file isn’t available to you" description="It cites sources you can’t open now, so its text is hidden." />
);

const NO_PREVIEW = (
  <EmptyState icon={History} title="No preview for this file" description="Download it to open it on your computer." compact />
);

function PreviewBody({
  content,
  title,
  sheetIndex,
  onSheetChange,
  cell,
  onSelect,
  cellEditable,
  onSaveCell,
  saving,
}: {
  content: VersionContent;
  title: string;
  sheetIndex: number;
  onSheetChange: (i: number) => void;
  cell: CellRef | null;
  onSelect: (cell: CellRef | null) => void;
  cellEditable: boolean;
  onSaveCell: (cell: CellRef, value: string) => void;
  saving: boolean;
}) {
  return (
    <ContentState content={content}>
      {() => {
        const { view } = content;
        if ((view === "markdown" || view === "text" || view === "csv") && content.text === undefined) return WITHHELD;
        if (content.sheets?.length) {
          return (
            <SheetView
              sheets={content.sheets}
              sheetIndex={sheetIndex}
              onSheetChange={onSheetChange}
              selected={cell}
              onSelect={onSelect}
              editable={cellEditable}
              onSaveCell={onSaveCell}
              isSaving={saving}
            />
          );
        }
        if (view === "markdown") return <MarkdownPage text={content.text ?? ""} />;
        if (view === "text") return <PlainPage text={content.text ?? ""} />;
        if (content.blocks?.length) return <RenditionPage blocks={content.blocks} />;
        if (content.imageUri) {
          return (
            <div className="wk-doc">
              {/* eslint-disable-next-line @next/next/no-img-element -- signed storage URL */}
              <img src={content.imageUri} alt={title} style={{ maxWidth: "100%", borderRadius: "var(--radius-xl)" }} />
            </div>
          );
        }
        if (content.pages?.length) {
          return (
            <div className="stack gap-12">
              {content.pages.map((page) => (
                // eslint-disable-next-line @next/next/no-img-element -- signed storage URL
                <img key={page.n} src={page.uri} alt={`Page ${page.n}`} style={{ width: "100%", borderRadius: "var(--radius-xl)", boxShadow: "inset 0 0 0 1px var(--border)" }} />
              ))}
            </div>
          );
        }
        return NO_PREVIEW;
      }}
    </ContentState>
  );
}

function ChangesBody({ after, before, sheetIndex, onSheetChange }: { after: VersionContent; before: VersionContent; sheetIndex: number; onSheetChange: (i: number) => void }) {
  const bothText = after.text !== undefined && before.text !== undefined;
  return (
    <ContentState content={after.isError || after.isPending ? after : before}>
      {() => {
        if (after.sheets?.length && before.sheets) {
          return <SheetView sheets={after.sheets} sheetIndex={sheetIndex} onSheetChange={onSheetChange} previous={before.sheets} />;
        }
        if ((after.view === "markdown" || after.view === "text") && bothText) {
          return <TextDiff before={before.text!} after={after.text!} markdown={after.view === "markdown"} />;
        }
        if (after.blocks && before.blocks) return <RenditionDiff before={before.blocks} after={after.blocks} />;
        if ((after.view === "markdown" || after.view === "text" || after.view === "csv") && !bothText) return WITHHELD;
        return <EmptyState icon={GitCompare} title="These versions can’t be compared here" description="Download both versions to compare them." compact />;
      }}
    </ContentState>
  );
}

