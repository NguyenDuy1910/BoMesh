"use client";

import { Button, buttonVariants, Dropdown, Header, Input, Label, Separator } from "@heroui/react";
import { useQueryClient } from "@tanstack/react-query";
import { Archive, ArrowDown, ArrowUp, ChevronDown, Copy, Ellipsis, Link as LinkIcon, List as ListIcon, Lock, Pencil, Plus, Sparkles, Trash2 } from "lucide-react";
import NextLink from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, type ReactNode } from "react";

import { PageChrome } from "@/components/shell/page-chrome";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { FileIcon } from "@/components/ui/FileIcon";
import { IconButton } from "@/components/ui/IconButton";
import { ItemIcon } from "@/components/ui/ItemIcon";
import { Page } from "@/components/ui/Page";
import { PageHeader } from "@/components/ui/PageHeader";
import { SkeletonRows } from "@/components/ui/SkeletonRows";
import { StatusChip } from "@/components/ui/StatusChip";
import { toast } from "@/components/ui/Toast";
import { errorMessage, resourceId } from "@/lib/api/client";
import { plural } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";
import { newWorkHref, workflowsFor } from "@/modules/work/kinds";

import {
  copyReadingList,
  createReadingListEntry,
  deleteReadingList,
  deleteReadingListEntry,
  undeleteReadingList,
  updateReadingListEntry,
  type ReadingList,
  type ReadingListEntry,
} from "../../api";
import { useShareLabel } from "../../components/AddToCollectionDialog";
import { openReadingListEditor } from "../../components/dialogs";
import { ResourceList, ResourceRow } from "../../components/ResourceRow";
import type { Resource } from "../../model";
import { knowledgeKeys, useKnowledgeModel, useMember, useReadingList, useReadingListEntries } from "../../queries";
import { useItemsByName, useSpaces } from "../queries";
import { AddResourcesDialog } from "./AddResourcesDialog";
import { updatedLow } from "./CollectionsTab";

const LIBRARY_COLLECTIONS = "/knowledge/library?tab=collections";

function Unavailable() {
  return (
    <Page>
      <PageChrome crumbs={[{ label: "Knowledge", href: "/knowledge" }, { label: "My library", href: LIBRARY_COLLECTIONS }, { label: "Not available" }]} />
      <EmptyState
        icon={ListIcon}
        title="This collection isn’t available"
        description="It may have been archived, or it isn’t shared with you."
        actions={
          <NextLink href={LIBRARY_COLLECTIONS} className={buttonVariants({ variant: "primary" })}>
            Go to My library
          </NextLink>
        }
        boxed
      />
    </Page>
  );
}

interface Row {
  entry: ReadingListEntry;
  resource: Resource;
}

/** One collection (reading list): read it in order, ask about it, use it, edit it (preview `P.collection`). */
export function CollectionPage({ id }: { id: string }) {
  const list = useReadingList(id);
  if (list.isError && !list.data) {
    const status = (list.error as { status?: number } | null)?.status;
    if (status === 404 || status === 403) return <Unavailable />;
    return (
      <Page>
        <PageChrome crumbs={[{ label: "Knowledge", href: "/knowledge" }, { label: "My library", href: LIBRARY_COLLECTIONS }]} />
        <ErrorState error={list.error} onRetry={() => void list.refetch()} />
      </Page>
    );
  }
  if (!list.data) {
    return (
      <Page>
        <PageChrome crumbs={[{ label: "Knowledge", href: "/knowledge" }, { label: "My library", href: LIBRARY_COLLECTIONS }]} />
        <SkeletonRows rows={5} />
      </Page>
    );
  }
  if (list.data.state === "DELETED" || list.data.type === "FEATURED") return <Unavailable />;
  return <Collection list={list.data} />;
}

function Collection({ list }: { list: ReadingList }) {
  const { id: ws, member, can, hasModule, settings, workspace } = useWorkspace();
  const qc = useQueryClient();
  const router = useRouter();
  const listId = resourceId(list.name);
  const entries = useReadingListEntries(listId);
  const items = useItemsByName((entries.data?.entries ?? []).map((e) => e.item));
  const { toResource } = useKnowledgeModel();
  const spaces = useSpaces();
  const owner = useMember(list.owner);
  const shareLabel = useShareLabel();
  const [editing, setEditing] = useState(false);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [adding, setAdding] = useState(false);

  const space = list.audience === "SPACE" ? spaces.data?.find((s) => s.name === list.space) : undefined;
  const own = list.owner === member.name;
  const canEdit =
    own ||
    (list.audience === "WORKSPACE" && can("readingLists.publish")) ||
    (!!space && (space.callerRole === "roles/spaceLead" || space.callerRole === "roles/spaceStaff"));

  const rows: Row[] = useMemo(
    () =>
      [...(entries.data?.entries ?? [])]
        .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
        .flatMap((entry) => {
          const item = entry.item ? items.items.get(entry.item) : undefined;
          return item && item.state !== "DELETED" ? [{ entry, resource: toResource(item) }] : [];
        }),
    [entries.data, items.items, toResource],
  );
  const locked = entries.data?.hiddenItemCount ?? list.hiddenItemCount ?? 0;
  const docs = rows.map((r) => r.resource.id);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: knowledgeKeys.readingLists(ws) });
  };
  const fail = (e: unknown) => toast(errorMessage(e), { tone: "danger" });

  /* ── Actions ── */
  const ask = () => {
    const q = new URLSearchParams({ q: "Summarize what these resources cover and how they relate", send: "1" });
    for (const d of docs) q.append("doc", d);
    if (space?.name) q.set("space", resourceId(space.name));
    router.push(`/chat?${q.toString()}`);
  };

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/knowledge/collections/${listId}`);
      toast("Link copied");
    } catch {
      toast("Couldn’t copy the link", { tone: "danger" });
    }
  }

  async function duplicate() {
    try {
      const copy = await copyReadingList(ws, listId, `${list.displayName} (copy)`);
      refresh();
      router.push(`/knowledge/collections/${resourceId(copy.name)}`);
      toast(`Copied to “${copy.displayName}”`);
    } catch (e) {
      fail(e);
    }
  }

  async function archive() {
    try {
      await deleteReadingList(ws, listId, list.etag);
      refresh();
      router.push(LIBRARY_COLLECTIONS);
      toast(`Archived “${list.displayName}”`, {
        undo: () =>
          void undeleteReadingList(ws, listId).then(() => {
            refresh();
            router.push(`/knowledge/collections/${listId}`);
          }, fail),
      });
    } catch (e) {
      fail(e);
    }
  }

  async function saveNotes(): Promise<number> {
    const changed = rows.filter((r) => {
      const next = notes[r.entry.item ?? ""];
      return next !== undefined && next.trim() !== (r.entry.note ?? "");
    });
    if (!changed.length) return 0;
    try {
      await Promise.all(changed.map((r) => updateReadingListEntry(ws, listId, r.entry.item ?? "", { note: notes[r.entry.item ?? ""].trim() }, ["note"])));
      setNotes({});
      refresh();
      return changed.length;
    } catch (e) {
      fail(e);
      return 0;
    }
  }

  async function toggleEdit() {
    if (!editing) {
      setNotes({});
      setEditing(true);
      return;
    }
    const n = await saveNotes();
    setEditing(false);
    if (n) toast(n === 1 ? "Note saved" : `${n} notes saved`);
  }

  async function move(index: number, dir: -1 | 1) {
    const target = rows[index + dir];
    const current = rows[index];
    if (!target || !current) return;
    try {
      // Moving onto the neighbour's position swaps them; entries the caller can't open keep their places.
      await updateReadingListEntry(ws, listId, current.entry.item ?? "", { position: target.entry.position ?? index + dir }, ["position"]);
      refresh();
    } catch (e) {
      fail(e);
    }
  }

  async function remove(row: Row) {
    const { item = "", note, position } = row.entry;
    try {
      await deleteReadingListEntry(ws, listId, item);
      refresh();
      toast(`Removed “${row.resource.title}”`, {
        undo: () =>
          void createReadingListEntry(ws, listId, item, note)
            .then(() => updateReadingListEntry(ws, listId, item, { position }, ["position"]))
            .then(refresh, fail),
      });
    } catch (e) {
      fail(e);
    }
  }

  async function addItems(names: string[]) {
    try {
      for (const n of names) await createReadingListEntry(ws, listId, n);
      refresh();
      toast(`Added ${plural(names.length, "resource")}`, {
        undo: () => void Promise.all(names.map((n) => deleteReadingListEntry(ws, listId, n))).then(refresh, fail),
      });
    } catch (e) {
      refresh();
      fail(e);
      throw e;
    }
  }

  /* ── Header ── */
  const share = shareLabel(list);
  const workflows = hasModule("work") && rows.length ? workflowsFor(settings, space?.callerRole ? space : undefined) : [];
  const moreNodes: ({ id: string; label: string; icon: typeof Pencil; danger?: boolean; run: () => void } | "sep")[] = [
    ...(canEdit ? [{ id: "edit", label: "Edit details", icon: Pencil, run: () => openReadingListEditor({ list }) }] : []),
    { id: "link", label: "Copy link", icon: LinkIcon, run: () => void copyLink() },
    ...(!own ? [{ id: "copy", label: "Duplicate to my collections", icon: Copy, run: () => void duplicate() }] : []),
    ...(canEdit ? (["sep", { id: "archive", label: "Archive", icon: Archive, danger: true, run: () => void archive() }] as const) : []),
  ];

  const actions: ReactNode = (
    <>
      {rows.length ? (
        <Button variant="primary" onPress={ask}>
          <Sparkles className="i" aria-hidden />
          Ask about this collection
        </Button>
      ) : null}
      {workflows.length ? (
        <Dropdown>
          <Button variant="tertiary">
            <Sparkles className="i" aria-hidden />
            Use in
            <ChevronDown className="i" aria-hidden />
          </Button>
          <Dropdown.Popover placement="bottom end">
            <Dropdown.Menu
              aria-label="Use in"
              onAction={(key) => router.push(newWorkHref({ workflow: workflows.find((w) => w.id === key)?.id, space: space?.callerRole ? space.name : undefined, docs }))}
            >
              <Dropdown.Section>
                <Header>Start with these resources</Header>
                {workflows.map((w) => (
                  <Dropdown.Item key={w.id} id={w.id} textValue={w.label}>
                    <w.icon className="i" aria-hidden />
                    <Label>{w.label}</Label>
                  </Dropdown.Item>
                ))}
              </Dropdown.Section>
            </Dropdown.Menu>
          </Dropdown.Popover>
        </Dropdown>
      ) : null}
      <Dropdown>
        <Button isIconOnly variant="ghost" aria-label="More" className="button--muted">
          <Ellipsis aria-hidden />
        </Button>
        <Dropdown.Popover placement="bottom end">
          <Dropdown.Menu
            aria-label="More"
            onAction={(key) => {
              const node = moreNodes.find((n) => n !== "sep" && n.id === key);
              if (node && node !== "sep") node.run();
            }}
          >
            {moreNodes.map((n, i) =>
              n === "sep" ? (
                <Separator key={`sep-${i}`} />
              ) : (
                <Dropdown.Item key={n.id} id={n.id} textValue={n.label} variant={n.danger ? "danger" : undefined}>
                  <n.icon className="i" aria-hidden />
                  <Label>{n.label}</Label>
                </Dropdown.Item>
              ),
            )}
          </Dropdown.Menu>
        </Dropdown.Popover>
      </Dropdown>
    </>
  );

  const description = (
    <>
      {list.description ? (
        <>
          <span translate="no">{list.description}</span>
          <br />
        </>
      ) : null}
      <span className="lib-col__head-meta">
        <StatusChip label={share.label} icon={share.icon} size="sm" />
        <span className="t-sm muted">
          {own ? "By you" : `By ${owner.data?.displayName ?? "someone"}`} · {updatedLow(list.updateTime)}
        </span>
      </span>
    </>
  );

  const lockedRow = locked ? (
    <div className="lib-locked">
      <Lock className="i i-sm" aria-hidden />
      <span>
        {plural(locked, "item")} {locked === 1 ? "isn’t" : "aren’t"} shared with you
      </span>
    </div>
  ) : null;

  let body: ReactNode;
  if (entries.isError && !entries.data) body = <ErrorState error={entries.error} onRetry={() => void entries.refetch()} />;
  else if (entries.isPending || (items.isPending && !rows.length && (entries.data?.entries.length ?? 0) > 0)) body = <SkeletonRows rows={5} />;
  else if (items.isError && !rows.length) body = <ErrorState error={items.error} onRetry={items.refetch} />;
  else if (!rows.length && !locked) {
    body = (
      <EmptyState
        icon={ListIcon}
        title="This collection is empty"
        description={canEdit ? "Add resources people should read, in order." : "The owner hasn’t added anything yet."}
        actions={
          canEdit ? (
            <Button variant="primary" onPress={() => setAdding(true)}>
              <Plus className="i" aria-hidden />
              Add resources
            </Button>
          ) : null
        }
        boxed
      />
    );
  } else if (editing) {
    body = (
      <>
        <div className="lib-edit">
          {rows.map((row, i) => {
            const key = row.entry.item ?? "";
            return (
              <div key={key} className="lib-edit__row">
                <span className="lib-edit__order">
                  <span className="num t-sm muted">{i + 1}</span>
                  <IconButton icon={ArrowUp} tip="Move up" size="sm" isDisabled={i === 0} onPress={() => void move(i, -1)} />
                  <IconButton icon={ArrowDown} tip="Move down" size="sm" isDisabled={i === rows.length - 1} onPress={() => void move(i, 1)} />
                </span>
                <span className="lib-edit__body">
                  <FileIcon type={row.resource.ext} mime={row.resource.mime} />
                  <span className="stack gap-4 grow">
                    <span className="medium truncate" translate="no">
                      {row.resource.title}
                    </span>
                    <Input
                      className="input--sm"
                      value={notes[key] ?? row.entry.note ?? ""}
                      placeholder="Add a note for readers"
                      maxLength={160}
                      aria-label={`Note for ${row.resource.title}`}
                      onChange={(e) => setNotes({ ...notes, [key]: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key !== "Enter") return;
                        e.preventDefault();
                        void saveNotes().then((n) => n && toast("Note saved"));
                      }}
                    />
                  </span>
                </span>
                <IconButton icon={Trash2} tip="Remove from collection" size="sm" onPress={() => void remove(row)} />
              </div>
            );
          })}
        </div>
        {lockedRow}
      </>
    );
  } else {
    body = (
      <>
        {rows.length ? (
          <ResourceList>
            {rows.map((row) => (
              <ResourceRow key={row.resource.id} resource={row.resource} note={row.entry.note} />
            ))}
          </ResourceList>
        ) : null}
        {lockedRow}
      </>
    );
  }

  return (
    <Page className="lib">
      <PageChrome crumbs={[{ label: "Knowledge", href: "/knowledge" }, { label: "My library", href: LIBRARY_COLLECTIONS }, { label: list.displayName ?? "" }]} />
      <PageHeader
        title={<span translate="no">{list.displayName}</span>}
        lead={<ItemIcon icon={ListIcon} tone="accent" />}
        description={description}
        chips={workspace.demo ? <StatusChip label="Demo data" size="sm" dot={false} tooltip="This workspace holds fictional demo content." /> : null}
        actions={actions}
      />
      {canEdit ? (
        <div className="toolbar">
          <span className="t-sm muted">{plural(rows.length, "item")}</span>
          <div className="toolbar__end">
            {editing ? (
              <>
                <Button variant="tertiary" onPress={() => setAdding(true)}>
                  <Plus className="i" aria-hidden />
                  Add resources
                </Button>
                <Button variant="secondary" onPress={() => void toggleEdit()}>
                  Done
                </Button>
              </>
            ) : (
              <Button variant="tertiary" onPress={() => void toggleEdit()}>
                <Pencil className="i" aria-hidden />
                Edit items
              </Button>
            )}
          </div>
        </div>
      ) : null}
      {body}
      {adding ? (
        <AddResourcesDialog
          listName={list.displayName ?? ""}
          have={new Set((entries.data?.entries ?? []).map((e) => e.item ?? ""))}
          onAdd={addItems}
          onClose={() => setAdding(false)}
        />
      ) : null}
    </Page>
  );
}
