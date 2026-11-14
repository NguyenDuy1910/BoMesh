"use client";

import { Button, buttonVariants, Dropdown, FieldError, Header, Input, Label, Separator, TextField } from "@heroui/react";
import { useQueryClient } from "@tanstack/react-query";
import { Archive, ArrowDown, ArrowUp, Check, Copy, Ellipsis, Link as LinkIcon, List as ListIcon, Lock, Pencil, Plus, Sparkles, Trash2 } from "lucide-react";
import NextLink from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, type KeyboardEvent, type ReactNode } from "react";

import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { FileIcon } from "@/components/ui/FileIcon";
import { IconButton } from "@/components/ui/IconButton";
import { ItemIcon } from "@/components/ui/ItemIcon";
import { LinkButton } from "@/components/ui/LinkButton";
import { Page } from "@/components/ui/Page";
import { PageHeader } from "@/components/ui/PageHeader";
import { SkeletonRows } from "@/components/ui/SkeletonRows";
import { StatusChip } from "@/components/ui/StatusChip";
import { toast } from "@/components/ui/Toast";
import { errorMessage, resourceId } from "@/lib/api/client";
import { fmtNum, plural } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";
import { useSpaces } from "@/modules/spaces/queries";
import { newWorkHref, workflowsFor } from "@/modules/work/kinds";

import {
  copyReadingList,
  createReadingListEntry,
  deleteReadingList,
  deleteReadingListEntry,
  undeleteReadingList,
  updateReadingList,
  updateReadingListEntry,
  type ReadingList,
  type ReadingListEntry,
} from "../../api";
import { openReadingListEditor } from "../../components/dialogs";
import { DemoChip, MY_LISTS_HREF } from "../../components/KnowledgeHeader";
import { ResourceList, ResourceRow, updatedLabel } from "../../components/ResourceRow";
import { useShareLabel } from "../../components/share-label";
import type { Resource } from "../../model";
import { knowledgeKeys, useItemsByName, useKnowledgeModel, useMember, useReadingList, useReadingListEntries, useRecentItems } from "../../queries";
import { originParam } from "../../reader/links";
import { AddResourcesDialog } from "./AddResourcesDialog";

const KNOWLEDGE = { label: "Knowledge", href: "/knowledge" };

function Unavailable() {
  return (
    <Page>
      <PageHeader title="Not available" crumbs={[KNOWLEDGE, { label: "Not available" }]} />
      <EmptyState
        icon={ListIcon}
        title="This reading list isn’t available"
        description="It may have been archived, or it isn’t shared with you."
        actions={
          <NextLink href="/knowledge" className={buttonVariants({ variant: "primary" })}>
            Browse knowledge
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

/** One reading list (`/knowledge/lists/:id`, preview `P.collection`): read it in order, ask about it, use it, edit it. */
export function ReadingListPage({ id }: { id: string }) {
  const list = useReadingList(id);
  if (list.isError && !list.data) {
    const status = (list.error as { status?: number } | null)?.status;
    if (status === 404 || status === 403) return <Unavailable />;
    return (
      <Page>
        <PageHeader title="Reading list" crumbs={[KNOWLEDGE]} />
        <ErrorState error={list.error} onRetry={() => void list.refetch()} />
      </Page>
    );
  }
  if (!list.data) {
    return (
      <Page>
        <PageHeader title="Reading list" crumbs={[KNOWLEDGE]} />
        <SkeletonRows rows={5} />
      </Page>
    );
  }
  if (list.data.state === "DELETED" || list.data.type === "FEATURED") return <Unavailable />;
  return <ReadingListView list={list.data} />;
}

/** Enter leaves an autosaving field (which saves it). */
const blurOnEnter = (e: KeyboardEvent<HTMLInputElement>) => {
  if (e.key !== "Enter") return;
  e.preventDefault();
  e.currentTarget.blur();
};

/**
 * A reading list is ordered: view mode numbers the items and marks the ones the member has read. Edit (one
 * entry, for editors) turns the page into its editor — name and description inline, reorder, notes, remove,
 * Add resources — with Done as the only primary. Every change saves as it is made (toast with Undo).
 */
function ReadingListView({ list }: { list: ReadingList }) {
  const { id: ws, member, can, hasModule, settings } = useWorkspace();
  const qc = useQueryClient();
  const router = useRouter();
  const listId = resourceId(list.name);
  const entries = useReadingListEntries(listId);
  const items = useItemsByName((entries.data?.entries ?? []).map((e) => e.item));
  const recent = useRecentItems(200);
  const { toResource } = useKnowledgeModel();
  const spaces = useSpaces();
  const owner = useMember(list.owner);
  const shareLabel = useShareLabel();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<{ displayName?: string; description?: string }>({});
  const [nameErr, setNameErr] = useState("");
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [adding, setAdding] = useState(false);

  const space = list.audience === "SPACE" ? spaces.data?.find((s) => s.name === list.space) : undefined;
  const own = list.owner === member.name;
  const canEdit =
    own ||
    (list.audience === "WORKSPACE" && can("readingLists.publish")) ||
    (!!space && (space.callerRole === "roles/spaceLead" || space.callerRole === "roles/spaceStaff"));
  const edit = editing && canEdit;

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
  const read = useMemo(() => new Set((recent.data ?? []).map((r) => resourceId(r.item))), [recent.data]);
  const locked = entries.data?.hiddenItemCount ?? list.hiddenItemCount ?? 0;
  const docs = rows.map((r) => r.resource.id);
  const refresh = () => void qc.invalidateQueries({ queryKey: knowledgeKeys.readingLists(ws) });
  const fail = (e: unknown) => toast(errorMessage(e), { tone: "danger" });
  const setList = (next: ReadingList) => qc.setQueryData(knowledgeKeys.readingList(ws, listId), next);

  /* ── View actions ── */
  const ask = () => {
    const q = new URLSearchParams({ q: "Summarize what these resources cover and how they relate", send: "1" });
    for (const d of docs) q.append("doc", d);
    if (space?.name) q.set("space", resourceId(space.name));
    router.push(`/chat?${q.toString()}`);
  };

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/knowledge/lists/${listId}`);
      toast("Link copied");
    } catch {
      toast("Couldn’t copy the link", { tone: "danger" });
    }
  }

  async function duplicate() {
    try {
      const copy = await copyReadingList(ws, listId, `${list.displayName} (copy)`);
      refresh();
      router.push(`/knowledge/lists/${resourceId(copy.name)}`);
      toast(`Copied to “${copy.displayName}”`);
    } catch (e) {
      fail(e);
    }
  }

  async function archive() {
    try {
      await deleteReadingList(ws, listId, list.etag);
      refresh();
      router.push(own ? MY_LISTS_HREF : "/knowledge");
      toast(`Archived “${list.displayName}”`, {
        undo: () =>
          void undeleteReadingList(ws, listId).then(() => {
            refresh();
            router.push(`/knowledge/lists/${listId}`);
          }, fail),
      });
    } catch (e) {
      fail(e);
    }
  }

  /* ── Edit mode: every change saves as it is made ── */

  /** Name and description save when the field is left (or on Enter). A name can't be emptied: the field says so and keeps the old one. */
  async function saveMeta(field: "displayName" | "description") {
    const value = draft[field];
    if (value === undefined) return;
    const v = value.trim();
    if (field === "displayName" && !v) {
      setNameErr("Enter a name.");
      return;
    }
    setNameErr("");
    const prev = list[field] ?? "";
    const done = () => setDraft(({ [field]: _, ...rest }) => rest);
    if (prev === v) {
      done();
      return;
    }
    try {
      setList(await updateReadingList(ws, listId, { [field]: v, etag: list.etag }, [field]));
      done();
      refresh();
      toast(field === "displayName" ? "Name saved" : "Description saved", {
        undo: () => void updateReadingList(ws, listId, { [field]: prev }, [field]).then(setList).then(refresh, fail),
      });
    } catch (e) {
      fail(e);
    }
  }

  /** A note saves when its field is left (Enter leaves it too). */
  async function saveNote(row: Row) {
    const item = row.entry.item ?? "";
    const value = notes[item];
    if (value === undefined) return;
    const v = value.trim();
    const prev = row.entry.note ?? "";
    const done = () => setNotes(({ [item]: _, ...rest }) => rest);
    if (v === prev) {
      done();
      return;
    }
    try {
      await updateReadingListEntry(ws, listId, item, { note: v }, ["note"]);
      await qc.invalidateQueries({ queryKey: knowledgeKeys.entries(ws, listId) });
      done();
      toast(v ? "Note saved" : "Note removed", {
        undo: () => void updateReadingListEntry(ws, listId, item, { note: prev }, ["note"]).then(refresh, fail),
      });
    } catch (e) {
      fail(e);
    }
  }

  /** Swaps with the neighbouring readable item; entries the member can't open keep their positions. */
  async function move(index: number, dir: -1 | 1) {
    const target = rows[index + dir];
    const current = rows[index];
    if (!target || !current) return;
    try {
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

  const toggleEdit = () => {
    setDraft({});
    setNotes({});
    setNameErr("");
    setEditing(!editing);
  };

  /* ── Header ── */
  const share = shareLabel(list);
  const workflows = hasModule("work") && rows.length ? workflowsFor(settings, space?.callerRole ? space : undefined) : [];
  const onMore = (key: string | number) => {
    const k = String(key);
    if (k.startsWith("wf:")) {
      router.push(newWorkHref({ workflow: workflows.find((w) => w.id === k.slice(3))?.id, space: space?.callerRole ? space.name : undefined, docs }));
    } else if (k === "link") void copyLink();
    else if (k === "copy") void duplicate();
    else if (k === "archive") void archive();
  };
  // View: one primary (Ask), Edit, and ⋯ (Use in, copy link, duplicate, archive). Edit mode: Done is the primary.
  const actions: ReactNode = edit ? (
    <>
      <Button variant="tertiary" onPress={() => setAdding(true)}>
        <Plus className="i" aria-hidden />
        Add resources
      </Button>
      <Button variant="primary" onPress={toggleEdit}>
        <Check className="i" aria-hidden />
        Done
      </Button>
    </>
  ) : (
    <>
      {rows.length ? (
        <Button variant="primary" onPress={ask}>
          <Sparkles className="i" aria-hidden />
          Ask about this reading list
        </Button>
      ) : null}
      {canEdit ? (
        <Button variant="tertiary" onPress={toggleEdit}>
          <Pencil className="i" aria-hidden />
          Edit
        </Button>
      ) : null}
      <Dropdown>
        <Button isIconOnly variant="ghost" aria-label="More actions" className="button--muted">
          <Ellipsis aria-hidden />
        </Button>
        <Dropdown.Popover placement="bottom end">
          <Dropdown.Menu aria-label="More actions" onAction={onMore}>
            {workflows.length ? (
              <Dropdown.Section>
                <Header>Use in</Header>
                {workflows.map((w) => (
                  <Dropdown.Item key={w.id} id={`wf:${w.id}`} textValue={w.label}>
                    <w.icon className="i" aria-hidden />
                    <Label>{w.label}</Label>
                  </Dropdown.Item>
                ))}
              </Dropdown.Section>
            ) : null}
            {workflows.length ? <Separator /> : null}
            <Dropdown.Item id="link" textValue="Copy link">
              <LinkIcon className="i" aria-hidden />
              <Label>Copy link</Label>
            </Dropdown.Item>
            {!own ? (
              <Dropdown.Item id="copy" textValue="Duplicate to my reading lists">
                <Copy className="i" aria-hidden />
                <Label>Duplicate to my reading lists</Label>
              </Dropdown.Item>
            ) : null}
            {canEdit ? <Separator /> : null}
            {canEdit ? (
              <Dropdown.Item id="archive" textValue="Archive" variant="danger">
                <Archive className="i" aria-hidden />
                <Label>Archive</Label>
              </Dropdown.Item>
            ) : null}
          </Dropdown.Menu>
        </Dropdown.Popover>
      </Dropdown>
    </>
  );

  const meta = edit ? (
    "Changes save as you go."
  ) : (
    <>
      {list.description ? (
        <>
          <span translate="no">{list.description}</span>
          <br />
        </>
      ) : null}
      <span className="lib-col__head-meta">
        <StatusChip label={share.label} icon={share.icon} size="sm" dot={false} />
        <span className="t-sm muted">
          {own ? "By you" : `By ${owner.data?.displayName ?? "someone"}`} · {updatedLabel(list.updateTime)}
        </span>
      </span>
    </>
  );

  const details = edit ? (
    <section className="lib-edit__meta" aria-label="Reading list details">
      <TextField
        className="field"
        value={draft.displayName ?? list.displayName ?? ""}
        onChange={(v) => setDraft((d) => ({ ...d, displayName: v }))}
        onBlur={() => void saveMeta("displayName")}
        maxLength={60}
        isRequired
        isInvalid={!!nameErr}
        autoFocus
      >
        <Label>Name</Label>
        <Input onKeyDown={blurOnEnter} />
        <FieldError>{nameErr}</FieldError>
      </TextField>
      <TextField
        className="field"
        value={draft.description ?? list.description ?? ""}
        onChange={(v) => setDraft((d) => ({ ...d, description: v }))}
        onBlur={() => void saveMeta("description")}
        maxLength={200}
      >
        <Label>
          Description <span className="label__opt">(optional)</span>
        </Label>
        <Input placeholder="What it’s for and who should read it" onKeyDown={blurOnEnter} />
      </TextField>
      <div className="lib-edit__share">
        <span className="label">Who can see it</span>
        <span className="row gap-8">
          <StatusChip label={share.label} icon={share.icon} size="sm" dot={false} />
          <LinkButton onPress={() => openReadingListEditor({ list })}>Change</LinkButton>
        </span>
      </div>
    </section>
  ) : null;

  const lockedRow = locked ? (
    <div className="lib-locked">
      <Lock className="i i-sm" aria-hidden />
      <span>{locked === 1 ? "1 item isn’t shared with you" : `${fmtNum(locked)} items aren’t shared with you`}</span>
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
        title="This reading list is empty"
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
  } else if (edit) {
    body = (
      <>
        {rows.length ? (
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
                        onChange={(e) => setNotes((n) => ({ ...n, [key]: e.target.value }))}
                        onBlur={() => void saveNote(row)}
                        onKeyDown={blurOnEnter}
                      />
                    </span>
                  </span>
                  <IconButton icon={Trash2} tip="Remove from reading list" size="sm" onPress={() => void remove(row)} />
                </div>
              );
            })}
          </div>
        ) : null}
        {lockedRow}
      </>
    );
  } else {
    body = (
      <>
        {rows.length ? (
          <ResourceList>
            {rows.map((row, i) => (
              <ResourceRow
                key={row.resource.id}
                resource={row.resource}
                note={row.entry.note}
                pos={i + 1}
                read={read.has(row.resource.id)}
                from={originParam({ kind: "list", id: listId })}
              />
            ))}
          </ResourceList>
        ) : null}
        {lockedRow}
      </>
    );
  }

  const name = list.displayName ?? "";
  // Yours sit in My reading lists; a shared reading list was found in Browse, so its trail is just Knowledge.
  const crumbs = [KNOWLEDGE, ...(own ? [{ label: "My reading lists", href: MY_LISTS_HREF }] : []), { label: name }];

  return (
    <Page className="lib">
      <PageHeader
        title={edit ? "Edit reading list" : name}
        heading={edit ? undefined : <span translate="no">{name}</span>}
        lead={<ItemIcon icon={ListIcon} tone="accent" />}
        meta={meta}
        chips={edit ? null : <DemoChip />}
        actions={actions}
        crumbs={crumbs}
      />
      {details}
      {body}
      {adding ? (
        <AddResourcesDialog
          listName={name}
          personal={list.audience === "PRIVATE"}
          have={new Set((entries.data?.entries ?? []).map((e) => e.item ?? ""))}
          onAdd={addItems}
          onClose={() => setAdding(false)}
        />
      ) : null}
    </Page>
  );
}
