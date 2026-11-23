"use client";

import { Button } from "@heroui/react";
import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { ChevronDown, ChevronRight, FileText, Folder, FolderOpen, FolderPlus, Info, ListTree, Lock, Pencil, Search, Trash2, type LucideIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, type CSSProperties, type ReactNode } from "react";

import { confirm } from "@/components/ui/Confirm";
import { DataTable, RowMenu, type DataTableColumn, type RowAction } from "@/components/ui/DataTable";
import { EmptyState } from "@/components/ui/EmptyState";
import { FileIcon } from "@/components/ui/FileIcon";
import { SearchInput } from "@/components/ui/SearchInput";
import { SkeletonRows } from "@/components/ui/SkeletonRows";
import { resourceId } from "@/lib/api/client";
import { fmtDateTime, fmtNum, plural, rel } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";
import { rowOf } from "@/modules/curation/model";
import { DocumentDrawer } from "@/modules/curation/components/DocumentDrawer";
import { ActionsMenu } from "@/modules/curation/components/shared";

import { listAllItems, quote } from "../../api";
import { openMoveFolder, openMoveItems } from "../../components/dialogs";
import { LifecycleChip } from "../../components/LifecycleChip";
import { useWhoCanSeeAt } from "../../components/ResourceDetails";
import { fold } from "../../model";
import { knowledgeKeys, useKnowledgeModel, useMemberNames } from "../../queries";
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
            <button type="button" className="st-row__chev" aria-expanded={isOpen} aria-label={`${isOpen ? "Collapse" : "Expand"} ${label}`} onClick={() => setToggled((t) => ({ ...t, [id]: !isOpen }))}>
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
    <nav className="st-side" aria-label="Folders">
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
  const people = useSharePeople({ enabled: !!policy.data });
  const names = sharesOf(policy.data)
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
          Manage access
        </Button>
      ) : null,
    );
  if (via && via.name === folder.name)
    return line(
      Lock,
      <>
        <span className="medium">{`Own access: ${names || "no one yet"}`}</span>
        <span className="muted" aria-hidden>
          {" · "}
        </span>
        <span>{`Other readers of ${collection.displayName} don’t see it.`}</span>
      </>,
      owner ? (
        <Button variant="ghost" size="sm" onPress={() => onAccess(folder)}>
          Manage access
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
          set there
        </button>
      </>,
    );
  return line(
    who.icon,
    `Same as the collection: ${who.label}`,
    owner ? (
      <Button variant="ghost" size="sm" onPress={() => onAccess(folder)}>
        <Lock className="i" aria-hidden />
        Restrict access
      </Button>
    ) : null,
  );
}

/** Preview `contentsMain`: the open folder (or the top level) with its folders and documents; search looks through the whole collection. */
function ContentsMain({ collection, index, folder, onOpen }: { collection: Item; index: FolderIndex; folder: Item | null; onOpen: (folder: string | null) => void }) {
  const { id: ws } = useWorkspace();
  const router = useRouter();
  const ops = useFolderOperations();
  const { ctx } = useKnowledgeModel();
  const root = collection.name ?? "";
  const here = folder?.name ?? root;
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [drawer, setDrawer] = useState<Item | null>(null);
  const needle = q.trim();
  const filter = needle
    ? `itemKind = DOCUMENT AND ancestors:${quote(root)} AND displayName = ${quote(`*${needle}*`)}`
    : `itemKind = DOCUMENT AND parentItem = ${quote(here)}`;
  const docs = useQuery({
    queryKey: [...knowledgeKeys.items(ws), "contents", filter],
    queryFn: () => listAllItems(ws, { filter, orderBy: "updateTime desc", view: "FULL" }, 1000),
  });
  const contributor = useMemberNames([drawer?.creator]);
  // Who reads what a removed folder holds afterwards: the level above it (preview `whoCanSee(kb, f.parent)`).
  const whoHere = useWhoCanSeeAt(collection, index, folder?.name);
  const whoAbove = useWhoCanSeeAt(collection, index, folder?.parentItem !== root ? folder?.parentItem : null);

  const kids = needle ? [...index.byName.values()].filter((f) => fold(f.displayName ?? "").includes(fold(needle))) : [...(index.children.get(here) ?? [])];
  const rows: Row[] = [...kids.map((item) => ({ kind: "folder" as const, item })), ...(docs.data ?? []).map((item) => ({ kind: "doc" as const, item }))];
  const where = (parent: string | undefined) => whereLabel(collection.displayName ?? "", index, parent === root ? null : parent);
  const upName = (f: Item) => (f.parentItem && f.parentItem !== root ? index.byName.get(f.parentItem)?.displayName : collection.displayName) ?? "";
  const movable = (d: Item) => !d.document?.origin?.source;

  const trail = folderPath(index, folder?.name);
  const nDocs = (folder ?? collection).collection?.documentCount ?? 0;
  const nFolders = folder ? folderSubtree(index, folder.name ?? "").length - 1 : index.byName.size;
  const meta = [folder ? "" : "Top level", plural(nDocs, "document"), nFolders ? plural(nFolders, "folder") : ""].filter(Boolean).join(" · ");

  async function remove(f: Item) {
    if (hasOwnAccess(f) && (f.collection?.childCount ?? 0) > 0) {
      const who = f.parentItem === here ? whoHere.label : f.name === folder?.name ? whoAbove.label : `People with access to ${upName(f)}`;
      const ok = await confirm({
        title: `Remove “${f.displayName}”?`,
        description: `What’s in it moves to ${upName(f)} and loses this folder’s own access: ${who} will be able to read it.`,
        confirmLabel: "Remove folder",
        tone: "danger",
      });
      if (!ok) return;
    }
    if ((await ops.remove(f, upName(f))) && folder && folderSubtree(index, f.name ?? "").includes(folder.name ?? "")) onOpen(f.parentItem === root ? null : (f.parentItem ?? null));
  }

  const folderMenu = (f: Item): RowAction[] => [
    { id: "edit", label: "Edit details…", icon: Pencil, onAction: () => setOverlay({ kind: "edit", folder: f }) },
    { id: "move", label: "Move to…", icon: Folder, onAction: () => openMoveFolder(f.name ?? "", f.parentItem) },
    ...(isOwner(collection) ? [{ id: "access", label: hasOwnAccess(f) ? "Manage access…" : "Restrict access…", icon: Lock, onAction: () => setOverlay({ kind: "access", folder: f }) }] : []),
    { id: "remove", label: "Remove folder", icon: Trash2, danger: true, onAction: () => void remove(f) },
  ];
  const docMenu = (d: Item): RowAction[] => [
    { id: "details", label: "Details", icon: Info, onAction: () => setDrawer(d) },
    ...(movable(d) ? [{ id: "move", label: "Move to…", icon: Folder, onAction: () => openMoveItems([d.name ?? ""], d.parentItem) }] : []),
    ...(d.document?.publicationState === "PUBLISHED" ? [{ id: "open", label: "Open", icon: FileText, onAction: () => router.push(`/doc/${resourceId(d.name)}`) }] : []),
  ];

  const columns: DataTableColumn<Row>[] = [
    {
      id: "name",
      header: "Name",
      primary: true,
      cell: (r) => {
        if (r.kind === "folder") {
          const sub = [needle ? where(r.item.parentItem) : "", hasOwnAccess(r.item) ? "Own access" : ""].filter(Boolean).join(" · ");
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
      header: "Status",
      cell: (r) => (r.kind === "folder" ? <span className="muted t-sm">{plural(r.item.collection?.documentCount ?? 0, "document")}</span> : <LifecycleChip item={r.item} />),
    },
    {
      id: "updated",
      header: "Updated",
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
        <nav className="st-crumbs" aria-label="Location">
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
            <RowMenu actions={folderMenu(folder)} tip="Folder actions" />
          </>
        ) : (
          <p className="st-head__meta">{meta}</p>
        )}
        <span className="grow" />
        {/* New folder is the one visible folder action; the quiet ▾ beside it holds the bulk way (Import folders…). */}
        <Button variant="secondary" size="sm" onPress={() => setOverlay({ kind: "new", parent: here })}>
          <FolderPlus className="i" aria-hidden />
          New folder
        </Button>
        <ActionsMenu label="More ways to add folders" icon={ChevronDown} actions={[{ id: "import", label: "Import folders…", icon: ListTree, onAction: () => setOverlay({ kind: "import", parent: here }) }]} />
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
    rows.length > 12 || needle ? (
      <div className="toolbar st-tools">
        <SearchInput value={q} onChange={setQ} placeholder={`Search ${collection.displayName}`} />
      </div>
    ) : null;

  let body: ReactNode;
  if (docs.isPending) body = <SkeletonRows rows={4} />;
  else if (!rows.length)
    body = (
      <div className="st-empty">
        {needle ? (
          <EmptyState compact icon={Search} title={`Nothing called “${needle}”`} description="Search looks through every folder of this collection." />
        ) : (
          <EmptyState
            compact
            icon={FolderOpen}
            title={folder ? "This folder is empty" : "Nothing here yet"}
            description="Add documents here, or make a folder to organise them."
            actions={
              <Button variant="ghost" size="sm" onPress={() => setOverlay({ kind: "import", parent: here })}>
                <ListTree className="i" aria-hidden />
                Import folders…
              </Button>
            }
          />
        )}
      </div>
    );
  else
    body = (
      <DataTable
        label="Folders and documents"
        rows={rows}
        columns={columns}
        getRowId={(r) => r.item.name ?? ""}
        selectedIds={selected}
        onSelectionChange={setSelected}
        isRowSelectable={(r) => r.kind === "doc" && movable(r.item)}
        rowLabel={(r) => r.item.displayName ?? ""}
        onRowAction={(r) => (r.kind === "folder" ? onOpen(r.item.name ?? null) : setDrawer(r.item))}
        rowActions={(r) => (r.kind === "folder" ? folderMenu(r.item) : docMenu(r.item))}
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
            Move to…
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
