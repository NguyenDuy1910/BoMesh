"use client";

import { Button } from "@heroui/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, CircleAlert, CircleCheck, Download, Folder, FolderOpen, ListTree, Upload } from "lucide-react";
import { Fragment, useRef, useState, type CSSProperties, type DragEvent, type ReactNode } from "react";

import { Callout, EmptyState, ErrorState, FileIcon, LinkButton, SkeletonRows, StatusChip, toast } from "@/components/ui";
import { errorMessage } from "@/lib/api/client";
import { fmtNum, fmtSize, plural } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";

import { KnowledgeModal } from "../../components/KnowledgeModal";
import { useWhoCanSeeAt } from "../../components/ResourceDetails";
import { invalidateKnowledge } from "../../queries";
import { importCollections, type CollectionImportRow, type ImportCollectionsResult } from "../api";
import { parseFolderTree, templateJson } from "../folderTree";
import { folderPath, type FolderIndex, type Item } from "../model";

type Change = NonNullable<ImportCollectionsResult["created"]>[number];

const DOT = (
  <span className="muted" aria-hidden="true">
    {" "}
    ·{" "}
  </span>
);
const SEP = (
  <span className="muted" aria-hidden="true">
    {" "}
    ›{" "}
  </span>
);

/** How the server matches names: case- and space-insensitive; accents count. */
const nameKey = (s: string) => s.trim().replace(/\s+/g, " ").normalize("NFC").toLowerCase();
const pathKey = (path: readonly string[]) => path.map(nameKey).join("\u0000");

function saveJson(fileName: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: "application/json;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
  toast("Đã tải mẫu");
}

export interface ImportFoldersDialogProps {
  collection: Item;
  index: FolderIndex;
  /** The collection or folder the tree goes in (the folder open in Contents). */
  parent: string;
  onClose: () => void;
  /** Opens a folder (the first new one, from the toast). */
  onOpen: (folder: string) => void;
}

/**
 * Import folders (preview `M['kb-folder-import']`): one dialog, two steps — choose a JSON folder tree (drop zone,
 * Download template) → Check the changes the server reports for its rows (ImportCollections `validateOnly`: the new
 * folders as a tree under the folders they start in, how many are already there, skipped rows with their reasons, and
 * whose access the new folders use) → Import n folders in one transaction. Nothing changes until you import.
 */
export function ImportFoldersDialog({ collection, index, parent, onClose, onOpen }: ImportFoldersDialogProps) {
  const { id: ws } = useWorkspace();
  const qc = useQueryClient();
  const [file, setFile] = useState<{ key: number; name: string; size: number; rows: CollectionImportRow[] } | null>(null);
  const [err, setErr] = useState("");
  const [drag, setDrag] = useState(false);
  const [applying, setApplying] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const picks = useRef(0);
  const root = collection.name ?? "";
  const at = parent === root ? null : parent;
  const dest = [collection.displayName ?? "", ...folderPath(index, at).map((f) => f.displayName ?? "")];
  const who = useWhoCanSeeAt(collection, index, at);
  const WhoIcon = who.icon;

  const check = useQuery({
    queryKey: [ws, "collections-import", parent, file?.key],
    enabled: !!file,
    queryFn: () => importCollections(ws, parent, { rows: file!.rows, validateOnly: true }),
    retry: false,
    staleTime: Infinity,
    gcTime: 0,
  });

  const read = (f: File) => {
    setErr("");
    if (!/\.json$/i.test(f.name)) {
      setErr("Hãy chọn một tệp JSON.");
      return;
    }
    void f.text().then((text) => {
      const parsed = parseFolderTree(text);
      if ("error" in parsed) setErr(parsed.error);
      else setFile({ key: ++picks.current, name: f.name, size: f.size, rows: parsed.rows });
    });
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDrag(false);
    const f = e.dataTransfer.files?.[0];
    if (f) read(f);
  };

  if (!file) {
    return (
      <KnowledgeModal
        isOpen
        onClose={onClose}
        size="md"
        icon={ListTree}
        title="Nhập thư mục từ JSON"
        description={`Tạo cây thư mục trong ${dest.join(" › ")}. Các thư mục đã có được giữ nguyên, và bạn kiểm tra mọi thay đổi trước khi áp dụng.`}
        footerStart={<span className="t-xs muted">Chưa có gì thay đổi cho đến khi bạn nhập.</span>}
        footer={
          <Button variant="ghost" onPress={onClose}>
            Hủy
          </Button>
        }
      >
        <button
          type="button"
          className={`ctb-drop${drag ? " is-drag" : ""}`}
          aria-describedby="kbi-drop-hint"
          onClick={() => input.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setDrag(true);
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={onDrop}
        >
          <span className="ctb-drop__icon">
            <ListTree className="i i-lg" aria-hidden />
          </span>
          <span className="medium">
            Thả tệp JSON vào đây hoặc <span className="text-accent">chọn tệp</span>
          </span>
          <span className="description" id="kbi-drop-hint">
            Mỗi thư mục có tên, có thể kèm mô tả và các thư mục con
          </span>
        </button>
        <input
          ref={input}
          type="file"
          hidden
          accept=".json,application/json"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) read(f);
            e.target.value = "";
          }}
        />
        {err ? (
          <div className="field-error mt-8" role="alert">
            <CircleAlert className="i" aria-hidden />
            <span>{err}</span>
          </div>
        ) : null}
        <div className="ctb-samples">
          <span className="grow" />
          <LinkButton icon={Download} onPress={() => saveJson("folders-template.json", templateJson())}>
            Tải mẫu
          </LinkButton>
        </div>
      </KnowledgeModal>
    );
  }

  const { rows } = file;
  const x = check.data;
  const created = x?.created ?? [];
  const skipped = x?.skippedRows ?? [];
  const n = created.length;
  const back = () => setFile(null);

  async function apply() {
    setApplying(true);
    try {
      const done = await importCollections(ws, parent, { rows, validateOnly: false });
      invalidateKnowledge(qc, ws);
      onClose();
      const first = done.created?.[0]?.item;
      toast(`Đã tạo ${plural(done.created?.length ?? 0, "folder")}`, first ? { action: { label: "Mở", onPress: () => onOpen(first) } } : undefined);
    } catch (error) {
      setApplying(false);
      toast(errorMessage(error), { tone: "danger" });
      void check.refetch();
    }
  }

  /** An existing folder's display names under the import target, for the start of a new branch (the file's own text when not loaded). */
  function existing(path: readonly string[]): string[] {
    const out: string[] = [];
    let here = parent;
    for (const seg of path) {
      const hit = (index.children.get(here) ?? []).find((f) => nameKey(f.displayName ?? "") === nameKey(seg));
      out.push(hit?.displayName ?? seg);
      here = hit?.name ?? "";
    }
    return out;
  }

  /** The new folders as a tree: each branch under the folder it starts in, then its new folders indented. */
  function tree(): ReactNode {
    const byKey = new Map<string, Change>();
    const kids = new Map<Change, Change[]>();
    const groups = new Map<string, { label: string[]; list: Change[] }>();
    for (const c of created) {
      const path = c.path ?? [];
      const up = byKey.get(pathKey(path.slice(0, -1)));
      byKey.set(pathKey(path), c);
      if (up) kids.set(up, [...(kids.get(up) ?? []), c]);
      else {
        const k = pathKey(path.slice(0, -1));
        const g = groups.get(k) ?? { label: [...dest, ...existing(path.slice(0, -1))], list: [] };
        g.list.push(c);
        groups.set(k, g);
      }
    }
    const line = (c: Change, depth: number): ReactNode => {
      const desc = c.row ? rows[c.row - 1]?.description : undefined;
      return (
        <Fragment key={pathKey(c.path ?? [])}>
          <li style={{ "--depth": depth } as CSSProperties}>
            <Folder className="i i-sm" aria-hidden />
            <span className="medium" translate="no">
              {c.path?.at(-1)}
            </span>
            {desc ? (
              <span className="muted truncate" translate="no" title={desc}>
                {desc}
              </span>
            ) : null}
          </li>
          {(kids.get(c) ?? []).map((k) => line(k, depth + 1))}
        </Fragment>
      );
    };
    return [...groups].map(([k, g]) => (
      <Fragment key={k || "here"}>
        <li style={{ "--depth": 0 } as CSSProperties}>
          <FolderOpen className="i i-sm" aria-hidden />
          <span className="muted" translate="no">
            {g.label.join(" › ")}
          </span>
        </li>
        {g.list.map((c) => line(c, 1))}
      </Fragment>
    ));
  }

  /** A skipped row by its path as the file writes it (long names cut, an empty one shown as Untitled). */
  const skippedPath = (row: number) =>
    (rows[row - 1]?.path ?? []).map((s, i) => (
      <Fragment key={i}>
        {i ? SEP : null}
        {s ? <span translate="no">{s.length > 60 ? `${s.slice(0, 60)}…` : s}</span> : <span className="muted">Chưa đặt tên</span>}
      </Fragment>
    ));

  let body: ReactNode;
  if (check.isError) body = <ErrorState title="Không kiểm tra được các thay đổi" error={check.error} onRetry={() => check.refetch()} boxed={false} compact />;
  else if (!x) body = <SkeletonRows rows={4} />;
  else
    body = (
      <>
        {skipped.length ? (
          <Callout
            tone="warning"
            title={`${plural(skipped.length, "folder")} sẽ bị bỏ qua`}
            description={
              <ul className="md-errs st-imp-errs">
                {skipped.map((s) => (
                  <li key={s.row}>
                    <span>{skippedPath(s.row ?? 0)}</span>
                    {DOT}
                    <span>{s.reason}</span>
                  </li>
                ))}
              </ul>
            }
          />
        ) : null}
        {!n ? (
          <EmptyState
            icon={CircleCheck}
            tone="success"
            title="Không có gì thay đổi"
            description={skipped.length ? "Các thư mục còn lại trong tệp đều đã có ở đây." : "Mọi thư mục trong tệp đều đã có ở đây."}
            compact
          />
        ) : (
          <>
            <section className="md-chg">
              <h3 className="md-chg__title">
                <StatusChip label={fmtNum(n)} size="sm" tone="success" dot={false} />
                <span>Thư mục sẽ tạo</span>
              </h3>
              <ul className="md-chg__list st-imp">{tree()}</ul>
            </section>
            <div className="st-access">
              <WhoIcon className="i i-sm" aria-hidden />
              <span className="grow">
                <span>Thư mục mới dùng quyền truy cập của</span>{" "}
                <span className="medium" translate="no">
                  {dest.join(" › ")}
                </span>
                {DOT}
                <span className="muted">{who.label}</span>
              </span>
            </div>
          </>
        )}
      </>
    );

  const unchanged = x?.unchangedCount ?? 0;
  const description = [unchanged ? `${plural(unchanged, "folder")} đã có.` : "", n ? "Nhập sẽ thêm các thư mục mới bên dưới." : ""].filter(Boolean).join(" ");

  return (
    <KnowledgeModal
      isOpen
      onClose={onClose}
      guard={applying}
      size="lg"
      icon={ListTree}
      title="Kiểm tra thay đổi"
      description={description || undefined}
      footerStart={
        <Button variant="ghost" onPress={back} isDisabled={applying}>
          <ArrowLeft className="i" aria-hidden />
          Quay lại
        </Button>
      }
      footer={
        <>
          <Button variant="ghost" onPress={onClose} isDisabled={applying}>
            Hủy
          </Button>
          {x && !n ? (
            <Button variant="primary" onPress={onClose}>
              Đóng
            </Button>
          ) : (
            <Button variant="primary" onPress={() => void apply()} isPending={applying} isDisabled={!x || check.isFetching}>
              <Upload className="i" aria-hidden />
              {x ? `Nhập ${plural(n, "folder")}` : "Nhập"}
            </Button>
          )}
        </>
      }
    >
      <div className="stack gap-16">
        <div className="md-file">
          <FileIcon name={file.name} size="sm" />
          <div className="grow md-min">
            <div className="medium truncate" translate="no">
              {file.name}
            </div>
            <div className="t-xs muted">{`${plural(rows.length, "folder")} · ${fmtSize(file.size)}`}</div>
          </div>
          <Button variant="ghost" size="sm" onPress={back} isDisabled={applying}>
            Chọn tệp khác
          </Button>
        </div>
        {body}
      </div>
    </KnowledgeModal>
  );
}
