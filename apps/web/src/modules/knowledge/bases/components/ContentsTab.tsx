"use client";

import { Button } from "@heroui/react";
import clsx from "clsx";
import { ChevronDown, ChevronRight, FileText, Folder, FolderOpen, FolderPlus, Info, ListTree, Lock, Pencil, Search, Trash2, type LucideIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, type CSSProperties, type ReactNode } from "react";

import { confirm } from "@/components/ui/Confirm";
import { DataTable, RowMenu, type DataTableColumn, type RowAction } from "@/components/ui/DataTable";
import { EmptyState } from "@/components/ui/EmptyState";
import { FileIcon } from "@/components/ui/FileIcon";
import { Pager } from "@/components/ui/Pager";
import { SearchInput } from "@/components/ui/SearchInput";
import { SkeletonRows } from "@/components/ui/SkeletonRows";
import { resourceId } from "@/lib/api/client";
import { SEARCH_PAUSE_MS, useDebounced } from "@/lib/debounce";
import { fmtDateTime, fmtNum, plural, rel } from "@/lib/format";
import { useTokenPages } from "@/lib/paging";
import { useWorkspace } from "@/lib/workspace";
import { nameSearch } from "@/modules/curation/docFilter";
import { rowOf } from "@/modules/curation/model";
import { DocumentDrawer } from "@/modules/curation/components/DocumentDrawer";
import { ActionsMenu } from "@/modules/curation/components/shared";

import { listItems, quote } from "../../api";
import { openMoveFolder, openMoveItems } from "../../components/dialogs";
import { LifecycleChip } from "../../components/LifecycleChip";
import { useWhoCanSeeAt } from "../../components/ResourceDetails";
import { fold } from "../../model";
import { knowledgeKeys, useKnowledgeModel, useMemberNames } from "../../queries";
import { LEVELS, levelOf } from "../../map/layout";
import { useFolderOperations } from "../operations";
import { collectionHref, folderPath, folderSubtree, hasOwnAccess, isOwner, sharesOf, whereLabel, type FolderIndex, type Item } from "../model";
import { useBasePolicy, useFolders } from "../queries";
import { BaseMark } from "./BaseMark";
import { FolderAccessDialog, FolderDialog } from "./FolderDialogs";
import { ImportFoldersDialog } from "./ImportFoldersDialog";
import { useSharePeople } from "./ShareDialog";

type Row = { kind: "folder"; item: Item } | { kind: "doc"; item: Item };
type Overlay = { kind: "new"; parent: string } | { kind: "import"; parent: string } | { kind: "edit"; folder: Item } | { kind: "access"; folder: Item } | null;

/**
 * Contents (preview `contentsTab`): the collection's structure (the folder tree Home draws) and its documents in one
 * place — a folder tree beside the open folder's folders and documents. Folders are made, described, moved and
 * removed here, documents are moved between them, and a folder can take its own access. `?folder=<id>` opens a folder.
 */
export function ContentsTab({ collection, folder: folderId }: { collection: Item; folder: string | null }) {
  const router = useRouter();
  const root = collection.name ?? "";
  const folders = useFolders(root);
  const index = folders.index;
  const open = folderId ? ([...index.byName.values()].find((f) => resourceId(f.name) === resourceId(folderId)) ?? null) : null;
  const go = (folder: string | null) => router.push(collectionHref(root, "contents") + (folder ? `&folder=${resourceId(folder)}` : ""));

  if (folders.isPending) return <SkeletonRows rows={6} />;
  return (
    <div className="st-panes">
      <ContentsTree collection={collection} index={index} selected={open?.name ?? null} onOpen={go} />
      <ContentsMain key={open?.name ?? root} collection={collection} index={index} folder={open} onOpen={go} />
    </div>
  );
}

/** Preview `contentsTree`: the collection and its folders, each with its document count; the open folder's path stays expanded. */
function ContentsTree({ collection, index, selected, onOpen }: { collection: Item; index: FolderIndex; selected: string | null; onOpen: (folder: string | null) => void }) {
  const [toggled, setToggled] = useState<Record<string, boolean>>({});
  const onPath = new Set(folderPath(index, selected).map((f) => f.name ?? ""));
  const node = (f: Item | null, depth: number): ReactNode => {
    const id = f?.name ?? index.root;
    const kids = index.children.get(id) ?? [];
    const isOpen = !f || (toggled[id] ?? onPath.has(id));
    const isSel = (selected ?? index.root) === id;
    const label = (f ?? collection).displayName ?? "";
    return (
      <li key={id}>
        <div className={clsx("st-row", isSel && "is-selected", !f && "st-row--root")} style={{ "--depth": depth } as CSSProperties}>
          {f && kids.length ? (
            <button type="button" className="st-row__chev" aria-expanded={isOpen} aria-label={`${isOpen ? "Thu gọn" : "Mở rộng"} ${label}`} onClick={() => setToggled((t) => ({ ...t, [id]: !isOpen }))}>
              {isOpen ? <ChevronDown className="i i-sm" aria-hidden /> : <ChevronRight className="i i-sm" aria-hidden />}
            </button>
          ) : (
            <span className="st-row__chev" aria-hidden />
          )}
          <button type="button" className="st-row__main" aria-current={isSel ? "true" : undefined} onClick={() => onOpen(f?.name ?? null)}>
            {f ? <span className="st-row__icon" aria-hidden>{hasOwnAccess(f) ? <Lock className="i i-sm" /> : <Folder className="i i-sm" />}</span> : <BaseMark base={collection} size={20} />}
            <span className="st-row__name" translate="no" title={label}>
              {label}
            </span>
            <span className="st-row__count num">{fmtNum((f ?? collection).collection?.documentCount ?? 0)}</span>
          </button>
        </div>
        {isOpen && kids.length ? <ul className="st-group">{kids.map((k) => node(k, depth + 1))}</ul> : null}
      </li>
    );
  };
  return (
    <nav className="st-side" aria-label="Thư mục">
      <ul className="st-tree">{node(null, 0)}</ul>
    </nav>
  );
}

/** Preview `accessLine`: who reads what's here, and where that is decided, with the one access action that fits. */
function AccessLine({ collection, index, folder, onOpen, onAccess }: { collection: Item; index: FolderIndex; folder: Item | null; onOpen: (folder: string) => void; onAccess: (folder: Item) => void }) {
  const router = useRouter();
  const owner = isOwner(collection);
  const who = useWhoCanSeeAt(collection, index, folder?.name);
  const via = folder ? folderPath(index, folder.name).reverse().find(hasOwnAccess) : undefined;
  const policy = useBasePolicy(via ?? null);
  const shares = sharesOf(policy.data);
  const people = useSharePeople(shares.map((s) => s.principal));
  const names = shares
    .map((s) => people.get(s.principal)?.name)
    .filter(Boolean)
    .join(", ");
  const line = (icon: LucideIcon, text: ReactNode, action?: ReactNode) => {
    const Icon = icon;
    return (
      <div className="st-access">
        <Icon className="i i-sm" aria-hidden />
        <span className="grow">{text}</span>
        {action}
      </div>
    );
  };
  const extra = names ? <span className="muted">{` · ${names}`}</span> : null;
  if (!folder)
    return line(
      who.icon,
      who.label,
      owner ? (
        <Button variant="ghost" size="sm" onPress={() => router.push(collectionHref(collection.name, "access"))}>
          Quản lý quyền truy cập
        </Button>
      ) : null,
    );
  if (via && via.name === folder.name)
    return line(
      Lock,
      <>
        <span className="medium">{`Quyền truy cập riêng: ${names || "chưa có ai"}`}</span>
        <span className="muted" aria-hidden>
          {" · "}
        </span>
        <span>{`Những người đọc khác của ${collection.displayName} không xem được.`}</span>
      </>,
      owner ? (
        <Button variant="ghost" size="sm" onPress={() => onAccess(folder)}>
          Quản lý quyền truy cập
        </Button>
      ) : null,
    );
  if (via)
    return line(
      Lock,
      <>
        {who.label}
        {extra}
        {" · "}
        <button type="button" className="link" onClick={() => onOpen(via.name ?? "")}>
          đặt tại đó
        </button>
      </>,
    );
  return line(
    who.icon,
    `Giống kho tài liệu: ${who.label}`,
    owner ? (
      <Button variant="ghost" size="sm" onPress={() => onAccess(folder)}>
        <Lock className="i" aria-hidden />
        Giới hạn quyền truy cập
      </Button>
    ) : null,
  );
}

/** Documents per Contents page (one ListItems page). */
const DOCS_PAGE = 50;

/** Preview `contentsMain`: the open folder (or the top level) with its folders and documents (one server page at a time); search looks through the whole collection. */
function ContentsMain({ collection, index, folder, onOpen }: { collection: Item; index: FolderIndex; folder: Item | null; onOpen: (folder: string | null) => void }) {
  const { id: ws, workspace } = useWorkspace();
  const levels = LEVELS[workspace.template === "CAMPUS" ? "CAMPUS" : "ENTERPRISE"];
  const router = useRouter();
  const ops = useFolderOperations();
  const { ctx } = useKnowledgeModel();
  const root = collection.name ?? "";
  const here = folder?.name ?? root;
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [drawer, setDrawer] = useState<Item | null>(null);
  const needle = useDebounced(q.trim(), SEARCH_PAUSE_MS);
  const search = nameSearch(needle);
  const filter = search ? `itemKind = DOCUMENT AND ancestors:${quote(root)} AND ${search}` : `itemKind = DOCUMENT AND parentItem = ${quote(here)}`;
  const docs = useTokenPages([...knowledgeKeys.items(ws), "contents", filter], (pageToken) =>
    listItems(ws, { filter, orderBy: "updateTime desc", view: "FULL", pageSize: DOCS_PAGE, pageToken }),
  );
  const pageDocs = docs.data?.items ?? [];
  const contributor = useMemberNames([drawer?.creator]);
  // Who reads what a removed folder holds afterwards: the level above it (preview `whoCanSee(kb, f.parent)`).
  const whoHere = useWhoCanSeeAt(collection, index, folder?.name);
  const whoAbove = useWhoCanSeeAt(collection, index, folder?.parentItem !== root ? folder?.parentItem : null);

  // Folders come from the collection's folder index; they lead the first page of documents.
  const kids = docs.page > 1 ? [] : needle ? [...index.byName.values()].filter((f) => fold(f.displayName ?? "").includes(fold(needle))) : [...(index.children.get(here) ?? [])];
  const rows: Row[] = [...kids.map((item) => ({ kind: "folder" as const, item })), ...pageDocs.map((item) => ({ kind: "doc" as const, item }))];
  const where = (parent: string | undefined) => whereLabel(collection.displayName ?? "", index, parent === root ? null : parent);
  const upName = (f: Item) => (f.parentItem && f.parentItem !== root ? index.byName.get(f.parentItem)?.displayName : collection.displayName) ?? "";
  const movable = (d: Item) => !d.document?.origin?.source;

  const trail = folderPath(index, folder?.name);
  const nDocs = (folder ?? collection).collection?.documentCount ?? 0;
  const nFolders = folder ? folderSubtree(index, folder.name ?? "").length - 1 : index.byName.size;
  const meta = [folder ? "" : "Cấp cao nhất", plural(nDocs, "document"), nFolders ? plural(nFolders, "folder") : ""].filter(Boolean).join(" · ");

  async function remove(f: Item) {
    if (hasOwnAccess(f) && (f.collection?.childCount ?? 0) > 0) {
      const who = f.parentItem === here ? whoHere.label : f.name === folder?.name ? whoAbove.label : `Những người có quyền truy cập ${upName(f)}`;
      const ok = await confirm({
        title: `Gỡ “${f.displayName}”?`,
        description: `Nội dung bên trong sẽ di chuyển đến ${upName(f)} và mất quyền truy cập riêng của thư mục này: ${who} sẽ đọc được.`,
        confirmLabel: "Gỡ thư mục",
        tone: "danger",
      });
      if (!ok) return;
    }
    if ((await ops.remove(f, upName(f))) && folder && folderSubtree(index, f.name ?? "").includes(folder.name ?? "")) onOpen(f.parentItem === root ? null : (f.parentItem ?? null));
  }

  const folderMenu = (f: Item): RowAction[] => [
    { id: "edit", label: "Sửa chi tiết…", icon: Pencil, onAction: () => setOverlay({ kind: "edit", folder: f }) },
    { id: "move", label: "Chuyển đến…", icon: Folder, onAction: () => openMoveFolder(f.name ?? "", f.parentItem) },
    ...(isOwner(collection) ? [{ id: "access", label: hasOwnAccess(f) ? "Quản lý quyền truy cập…" : "Giới hạn quyền truy cập…", icon: Lock, onAction: () => setOverlay({ kind: "access", folder: f }) }] : []),
    { id: "remove", label: "Gỡ thư mục", icon: Trash2, danger: true, onAction: () => void remove(f) },
  ];
  const docMenu = (d: Item): RowAction[] => [
    { id: "details", label: "Chi tiết", icon: Info, onAction: () => setDrawer(d) },
    ...(movable(d) ? [{ id: "move", label: "Chuyển đến…", icon: Folder, onAction: () => openMoveItems([d.name ?? ""], d.parentItem) }] : []),
    ...(d.document?.publicationState === "PUBLISHED" ? [{ id: "open", label: "Mở", icon: FileText, onAction: () => router.push(`/doc/${resourceId(d.name)}`) }] : []),
  ];

  const columns: DataTableColumn<Row>[] = [
    {
      id: "name",
      header: "Tên",
      primary: true,
      cell: (r) => {
        if (r.kind === "folder") {
          // Preview `fRow`: where it is (when searching) or its kind, then how much it holds; its Status cell stays empty.
          const sub = [
            needle ? where(r.item.parentItem) : levelOf(levels, folderPath(index, r.item.name).length),
            plural(r.item.collection?.documentCount ?? 0, "document"),
            hasOwnAccess(r.item) ? "Quyền truy cập riêng" : "",
          ]
            .filter(Boolean)
            .join(" · ");
          return (
            <div className="row gap-12">
              <span className="st-ficon" aria-hidden>
                {hasOwnAccess(r.item) ? <Lock className="i i-sm" /> : <Folder className="i i-sm" />}
              </span>
              <div className="grow src-min">
                <div className="cell-title truncate" translate="no" title={r.item.displayName}>
                  {r.item.displayName}
                </div>
                {sub ? <div className="cell-sub truncate">{sub}</div> : null}
              </div>
            </div>
          );
        }
        const sub = needle ? where(r.item.parentItem) : (r.item.document?.topics ?? []).slice(0, 2).map((t) => ctx.topicNames?.get(t) ?? "").filter(Boolean).join(" · ");
        return (
          <div className="row gap-12">
            <FileIcon name={r.item.document?.fileName || r.item.displayName} mime={r.item.document?.mimeType} />
            <div className="grow src-min">
              <div className="cell-title truncate" translate="no" title={r.item.displayName}>
                {r.item.displayName}
              </div>
              {sub ? (
                <div className="cell-sub truncate" translate="no" title={sub}>
                  {sub}
                </div>
              ) : null}
            </div>
          </div>
        );
      },
    },
    {
      id: "status",
      header: "Trạng thái",
      cell: (r) => (r.kind === "folder" ? null : <LifecycleChip item={r.item} />),
    },
    {
      id: "updated",
      header: "Đã cập nhật",
      hideOnMobile: true,
      cell: (r) =>
        r.kind === "doc" ? (
          <span className="muted cur-nowrap" title={fmtDateTime(r.item.updateTime)}>
            {rel(r.item.updateTime)}
          </span>
        ) : null,
    },
  ];

  const head = (
    <div className="st-head">
      {trail.length ? (
        <nav className="st-crumbs" aria-label="Vị trí">
          {[{ name: null as string | null, displayName: collection.displayName }, ...trail.slice(0, -1).map((f) => ({ name: f.name ?? null, displayName: f.displayName }))].map((x, i) => (
            <span key={x.name ?? "root"} className="row gap-2">
              {i ? <ChevronRight className="i i-xs" aria-hidden /> : null}
              <button type="button" className="st-crumb" translate="no" onClick={() => onOpen(x.name)}>
                {x.displayName}
              </button>
            </span>
          ))}
        </nav>
      ) : null}
      <div className="st-head__row">
        {folder ? (
          <>
            <h2 className="st-head__title" translate="no">
              {folder.displayName}
            </h2>
            <RowMenu actions={folderMenu(folder)} tip="Thao tác với thư mục" />
          </>
        ) : (
          <p className="st-head__meta">{meta}</p>
        )}
        <span className="grow" />
        {/* New folder is the one visible folder action; the quiet ▾ beside it holds the bulk way (Import folders…). */}
        <Button variant="secondary" size="sm" onPress={() => setOverlay({ kind: "new", parent: here })}>
          <FolderPlus className="i" aria-hidden />
          Thư mục mới
        </Button>
        <ActionsMenu label="Cách khác để thêm thư mục" icon={ChevronDown} actions={[{ id: "import", label: "Nhập thư mục từ JSON…", icon: ListTree, onAction: () => setOverlay({ kind: "import", parent: here }) }]} />
      </div>
      {folder ? <p className="st-head__meta">{meta}</p> : null}
      {folder?.collection?.description ? (
        <p className="st-head__desc" translate="no">
          {folder.collection.description}
        </p>
      ) : null}
      <AccessLine collection={collection} index={index} folder={folder} onOpen={onOpen} onAccess={(f) => setOverlay({ kind: "access", folder: f })} />
    </div>
  );

  const tools =
    rows.length > 12 || docs.page > 1 || q.trim() ? (
      <div className="toolbar st-tools">
        <SearchInput value={q} onChange={setQ} placeholder={`Tìm kiếm ${collection.displayName}`} />
      </div>
    ) : null;

  let body: ReactNode;
  if (docs.isPending) body = <SkeletonRows rows={4} />;
  else if (!rows.length)
    body = (
      <div className="st-empty">
        {needle ? (
          <EmptyState compact icon={Search} title={`Không có gì tên “${needle}”`} description="Tìm kiếm trong mọi thư mục của kho tài liệu này." />
        ) : (
          <EmptyState
            compact
            icon={FolderOpen}
            title={folder ? "Thư mục này trống" : "Chưa có gì ở đây"}
            description="Thêm tài liệu vào đây, hoặc tạo thư mục để sắp xếp chúng."
            actions={
              <Button variant="ghost" size="sm" onPress={() => setOverlay({ kind: "import", parent: here })}>
                <ListTree className="i" aria-hidden />
                Nhập thư mục từ JSON…
              </Button>
            }
          />
        )}
      </div>
    );
  else
    body = (
      <DataTable
        label="Thư mục và tài liệu"
        rows={rows}
        columns={columns}
        getRowId={(r) => r.item.name ?? ""}
        selectedIds={selected}
        onSelectionChange={setSelected}
        isRowSelectable={(r) => r.kind === "doc" && movable(r.item)}
        rowLabel={(r) => r.item.displayName ?? ""}
        onRowAction={(r) => (r.kind === "folder" ? onOpen(r.item.name ?? null) : setDrawer(r.item))}
        rowActions={(r) => (r.kind === "folder" ? folderMenu(r.item) : docMenu(r.item))}
        footer={docs.hasNext || docs.page > 1 ? <Pager page={docs.page} pageSize={DOCS_PAGE} total={docs.total} pageCount={pageDocs.length} hasNext={docs.hasNext} onPageChange={docs.setPage} /> : undefined}
        bulkActions={(ids, clear) => (
          <Button
            variant="ghost"
            size="sm"
            onPress={() => {
              openMoveItems(ids, needle ? undefined : here);
              clear();
            }}
          >
            <Folder className="i" aria-hidden />
            Chuyển đến…
          </Button>
        )}
      />
    );

  return (
    <section className="st-main" aria-label={(folder ?? collection).displayName}>
      {head}
      {tools}
      {body}
      {overlay?.kind === "new" ? <FolderDialog collection={collection} index={index} parent={overlay.parent} onClose={() => setOverlay(null)} onOpen={(f) => onOpen(f.name ?? null)} /> : null}
      {overlay?.kind === "import" ? <ImportFoldersDialog collection={collection} index={index} parent={overlay.parent} onClose={() => setOverlay(null)} onOpen={onOpen} /> : null}
      {overlay?.kind === "edit" ? <FolderDialog collection={collection} index={index} folder={overlay.folder} parent={here} onClose={() => setOverlay(null)} onOpen={(f) => onOpen(f.name ?? null)} /> : null}
      {overlay?.kind === "access" ? <FolderAccessDialog collection={collection} index={index} folder={overlay.folder} onClose={() => setOverlay(null)} /> : null}
      <DocumentDrawer row={drawer ? rowOf(drawer, null, ctx.collectionNames ?? new Map()) : null} onClose={() => setDrawer(null)} contributorName={drawer && !drawer.document?.origin?.source ? contributor.get(drawer.creator ?? "") || "" : ""} />
    </section>
  );
}
