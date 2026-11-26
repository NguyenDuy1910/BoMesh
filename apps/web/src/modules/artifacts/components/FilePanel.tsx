"use client";

import { Button, Spinner } from "@heroui/react";
import { useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { ChevronRight, GitCompare, History, Maximize2, Pencil, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { errorMessage, resourceId } from "@/lib/api/client";
import { fmtSize, relInline } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";
import { Callout, confirm, EmptyState, ErrorState, FileIcon, IconButton, SectionTabs, SkeletonRows, toast } from "@/components/ui";
import { ContentView } from "@/modules/knowledge/content/ContentView";

import { commitArtifact, deleteRevision, rollbackRevision, type Artifact } from "../api";
import { columnLetter } from "../sheet";
import { fileNameOf, fileViewOf, isEditableView, isSheetView, revisionNumber, toDelimited, type Version } from "../model";
import { listenPanel, setLeaveGuard, type PanelTab } from "../panel-bus";
import { artifactKeys, useArtifact, useVersions } from "../queries";
import { useRevising } from "../revise";
import { DownloadMenu, FileMoreMenu, VersionMenu } from "./ArtifactMenus";
import { DocEditor, MarkdownPage, PlainPage, StructureDiff, TextDiff, type DocEditorHandle } from "./DocView";
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
 * History of an artifact, edit in place, restore, download, rename and save to
 * knowledge. Changes are asked for in the thread composer: a turn that writes the next version (`editArtifact`).
 * Every change makes a new version.
 */
export function FilePanel({ artifact: artifactRef, onClose }: FilePanelProps) {
  const { id: ws, member } = useWorkspace();
  const artifactQ = useArtifact(artifactRef);
  const artifact = artifactQ.data;

  if (!artifact) {
    return (
      <aside className="split__panel split__panel--wide wk-panel" aria-label="Tệp">
        <div className="panel__header wk-head">
          <h2 className="panel__title">{artifactQ.isError ? "Tệp" : "Đang tải…"}</h2>
          <IconButton icon={X} tip="Đóng" size="sm" onPress={onClose} />
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
  const title = artifact.displayName || "Tệp chưa đặt tên";
  const fileName = fileNameOf(artifact);
  const versionsQ = useVersions(name, artifact.revision);
  const versions = versionsQ.versions;
  const latest = versions.at(-1);
  const latestN = latest?.n ?? revisionNumber(artifact.revision);

  const [tab, setTab] = useState<PanelTab>("preview");
  const [revPick, setRevPick] = useState<number | null>(null);
  const [full, setFull] = useState(widePanel);
  const [cell, setCell] = useState<CellRef | null>(null);
  const [editing, setEditing] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
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
      const ok = await confirm({ title: "Bỏ các thay đổi?", description: "Thay đổi của bạn chưa được lưu thành phiên bản.", confirmLabel: "Bỏ thay đổi", tone: "danger" });
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
      toast(`Đã lưu thành phiên bản ${n}`, {
        undo: () =>
          void deleteRevision(ws, name, n)
            .then(async () => {
              await refresh();
              setRevPick(null);
              setTab("preview");
            })
            .catch((e: unknown) => toast("Không hoàn tác được", { tone: "danger", description: errorMessage(e) })),
      });
    } catch (e) {
      toast("Không lưu được", { tone: "danger", description: errorMessage(e) });
    } finally {
      setSaving(false);
    }
  };

  const saveEdit = () => {
    const markdown = editor.current?.markdown();
    if (markdown !== undefined) void commit(markdown, "Do bạn chỉnh sửa", "changes");
  };

  const saveCell = (at: CellRef, value: string) => {
    const s = content.sheet;
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
    void commit(toDelimited(columns, rows, tsv ? "\t" : ","), `Đã chỉnh sửa ${columnLetter(at.c)}${at.r + 1}`, "preview");
  };

  const restore = async (n: number) => {
    const ok = await confirm({
      title: `Khôi phục phiên bản ${n}?`,
      description: `Thao tác này tạo phiên bản ${latestN + 1}, bản sao của phiên bản ${n}. Mọi phiên bản đều được giữ trong Lịch sử.`,
      confirmLabel: "Khôi phục",
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
      toast(`Đã khôi phục thành phiên bản ${revisionNumber(updated.revision)}`);
    } catch (e) {
      toast("Không khôi phục được", { tone: "danger", description: errorMessage(e) });
    }
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
        <EmptyState icon={History} title="Trợ lý đang viết tệp này" description="Tệp sẽ hiện ở đây ngay khi phiên bản đầu tiên sẵn sàng." compact />
      ) : versionsQ.isPending ? (
        <SkeletonRows rows={6} />
      ) : (
        <EmptyState icon={History} title="Tệp này chưa có nội dung" description={artifact.state === "FAILED" ? "Trợ lý chưa viết xong tệp này." : "Chưa có gì được lưu."} compact />
      );
  } else if (tab === "history") {
    body = <FileHistory artifact={artifact} versions={versions} current={current.n} canRestore={isOwner && !busy} onView={(n) => void go({ rev: n, tab: "preview" })} onRestore={(n) => void restore(n)} />;
  } else if (tab === "changes") {
    body = !previous ? (
      <EmptyState
        icon={GitCompare}
        title="Đây là phiên bản đầu tiên"
        description={sheet ? "Sửa một ô hoặc yêu cầu chỉnh sửa để tạo phiên bản mới." : "Chỉnh sửa hoặc yêu cầu thay đổi để tạo phiên bản mới."}
        compact
      />
    ) : (
      <>
        <div className="wk-legend">
          <span>
            <i className="wk-legend__add" />
            Đã thêm
          </span>
          {view === "csv" ? (
            <span>
              <i className="wk-legend__chg" />
              Đã thay đổi
            </span>
          ) : null}
          <span>
            <i className="wk-legend__del" />
            Đã gỡ
          </span>
          <span className="grow" />
          <span className="medium truncate">
            v{previous.n} → v{current.n} · {current.summary}
          </span>
        </div>
        <ChangesBody item={resourceId(name)} after={content} before={before} />
      </>
    );
  } else if (editing && current.text !== undefined) {
    body = <DocEditor key={current.n} text={current.text} title={title} nextVersion={latestN + 1} onDirtyChange={setDirty} handleRef={editor} />;
  } else {
    body = (
      <PreviewBody
        item={resourceId(name)}
        content={content}
        title={title}
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
            {current ? ` · ${fmtSize(current.sizeBytes)} · ${current.author === "you" ? "do bạn chỉnh sửa" : "do trợ lý tạo"} ${relInline(current.createTime)}` : null}
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
          tip={full ? "Hẹp hơn" : "Rộng hơn"}
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
        <IconButton icon={X} tip="Đóng" size="sm" onPress={() => void leaveEdit().then((ok) => ok && onClose())} />
      </div>

      <div className="wk-tabs">
        <SectionTabs
          label="Chế độ xem tệp"
          active={tab}
          onChange={(t) => void go({ tab: t as PanelTab })}
          items={[
            { id: "preview", label: "Xem trước" },
            { id: "changes", label: "Thay đổi" },
            { id: "history", label: "Lịch sử", count: versions.length || null },
          ]}
        />
        {canEdit ? (
          <Button size="sm" variant="ghost" isDisabled={busy} onPress={() => setEditing(true)}>
            <Pencil aria-hidden />
            Chỉnh sửa
          </Button>
        ) : null}
      </div>

      <div className="panel__body wk-body" id="chat-panel-body">
        {oldVersion ? (
          <div className="mb-12">
            <Callout
              icon={History}
              title={`Bạn đang xem phiên bản ${current.n} của ${versions.length}`}
              actions={
                <>
                  <Button size="sm" variant="tertiary" onPress={() => void go({ rev: null })}>
                    Xem bản mới nhất
                  </Button>
                  {isOwner && !busy ? (
                    <Button size="sm" variant="ghost" onPress={() => void restore(current.n)}>
                      Khôi phục
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
          <span className="grow t-xs muted">{dirty ? "Thay đổi chưa lưu" : "Chưa có thay đổi"}</span>
          <Button size="sm" variant="ghost" onPress={() => void leaveEdit()}>
            Hủy
          </Button>
          <Button size="sm" variant="primary" isDisabled={!dirty} isPending={saving} onPress={saveEdit}>
            {`Lưu thành phiên bản ${latestN + 1}`}
          </Button>
        </div>
      ) : isOwner && busy ? (
        <div className="panel__footer wk-status" role="status">
          <Spinner size="sm" />
          <span>{`Đang tạo phiên bản ${revising || latestN + 1}… bạn có thể tiếp tục xem lại.`}</span>
        </div>
      ) : null}

      {dialog === "rename" ? <RenameDialog artifact={artifact} isOpen onClose={() => setDialog(null)} /> : null}
      {dialog === "publish" ? <PublishDialog artifact={artifact} version={latestN} isOpen onClose={() => setDialog(null)} /> : null}
    </aside>
  );
}

function ContentState({ content, children }: { content: VersionContent; children: () => React.ReactNode }) {
  if (content.isError) return <ErrorState error={content.error} onRetry={content.refetch} boxed={false} title="Không tải được phiên bản này" />;
  if (content.isPending) return <SkeletonRows rows={6} />;
  return <>{children()}</>;
}

const WITHHELD = (
  <Callout title="Bạn không xem được một phần của tệp này" description="Nội dung trích dẫn nguồn bạn hiện không mở được nên đã bị ẩn." />
);

const NO_PREVIEW = (
  <EmptyState icon={History} title="Tệp này chưa có bản xem trước" description="Tải xuống để mở trên máy tính." compact />
);

function PreviewBody({
  item,
  content,
  title,
  cell,
  onSelect,
  cellEditable,
  onSaveCell,
  saving,
}: {
  item: string;
  content: VersionContent;
  title: string;
  cell: CellRef | null;
  onSelect: (cell: CellRef | null) => void;
  cellEditable: boolean;
  onSaveCell: (cell: CellRef, value: string) => void;
  saving: boolean;
}) {
  return (
    <ContentState content={content}>
      {() => {
        const { view, structure } = content;
        if ((view === "markdown" || view === "text" || view === "csv") && content.text === undefined) return WITHHELD;
        if (content.sheet) {
          return <SheetView sheet={content.sheet} selected={cell} onSelect={onSelect} editable={cellEditable} onSaveCell={onSaveCell} isSaving={saving} />;
        }
        if (view === "markdown") return <MarkdownPage text={content.text ?? ""} />;
        if (view === "text") return <PlainPage text={content.text ?? ""} />;
        if (content.imageUri) {
          return (
            <div className="wk-doc">
              {/* eslint-disable-next-line @next/next/no-img-element -- signed storage URL */}
              <img src={content.imageUri} alt={title} style={{ maxWidth: "100%", borderRadius: "var(--radius-xl)" }} />
            </div>
          );
        }
        if (structure) return <ContentView key={`${structure.revision}:${structure.version}`} item={item} revision={structure.revision} version={structure.version} />;
        return NO_PREVIEW;
      }}
    </ContentState>
  );
}

function ChangesBody({ item, after, before }: { item: string; after: VersionContent; before: VersionContent }) {
  const bothText = after.text !== undefined && before.text !== undefined;
  return (
    <ContentState content={after.isError || after.isPending ? after : before}>
      {() => {
        if (after.sheet && before.sheet) return <SheetView sheet={after.sheet} previous={before.sheet} />;
        if ((after.view === "markdown" || after.view === "text") && bothText) {
          return <TextDiff before={before.text!} after={after.text!} markdown={after.view === "markdown"} />;
        }
        if (after.structure && before.structure) return <StructureDiff item={item} before={before.structure} after={after.structure} />;
        if ((after.view === "markdown" || after.view === "text" || after.view === "csv") && !bothText) return WITHHELD;
        return <EmptyState icon={GitCompare} title="Không thể so sánh các phiên bản này tại đây" description="Tải xuống cả hai phiên bản để so sánh." compact />;
      }}
    </ContentState>
  );
}

