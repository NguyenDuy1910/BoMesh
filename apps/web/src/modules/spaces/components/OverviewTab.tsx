"use client";

import { Button } from "@heroui/react";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowUp, BookOpen, Calendar, ClipboardList, List as ListIcon, Lock, Megaphone, MoreHorizontal, Pencil, Plus, Trash2, Upload, X } from "lucide-react";
import NextLink from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Callout, EmptyState, ErrorState, ItemIcon, List, ListItem, Section, SkeletonRows, StatusChip, UserAvatar, confirm, toast } from "@/components/ui";
import { errorMessage, resourceId } from "@/lib/api/client";
import { plural, rel } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";
import { openContribute } from "@/modules/knowledge/components/Contribute";
import { useMemberNames, useReadingLists } from "@/modules/knowledge/queries";
import { newWorkHref, workflowsFor } from "@/modules/work/kinds";

import { createAnnouncement, createSpaceEvent, deleteAnnouncement, deleteSpaceEvent, joinSpace, updateAnnouncement, type Announcement } from "../api";
import { invalidateSpaces, useAnnouncements, useRequestTypes, useSpaceBases, useUpNext, type UpNextItem } from "../queries";
import type { SpaceView } from "./context";
import { Menu } from "./Menu";
import { UpNextList } from "./UpNextList";

export interface OverviewActions {
  postAnnouncement: (announcement?: Announcement) => void;
  editEvent: (item: UpNextItem) => void;
}

/** Overview (preview `overviewTab`): announcements and Up next; request catalog, workflows, knowledge and collections beside. */
export function OverviewTab({ view, actions }: { view: SpaceView; actions: OverviewActions }) {
  const { space, sid, manage, visitor, can } = view;
  const { settings, hasModule } = useWorkspace();
  const router = useRouter();
  const member = !!view.role || manage;
  const bases = useSpaceBases(space);
  const catalog = useRequestTypes(sid);
  const lists = useReadingLists(`audience = SPACE AND space = "${space.name}"`);
  const workflows = !visitor && hasModule("work") ? workflowsFor(settings, space) : [];

  const editable = (bases.data ?? []).find((b) => b.access === "EDITOR" || b.access === "OWNER");
  const hasDocs = (bases.data ?? []).some((b) => b.access !== "LOCKED" && (b.collection?.documentCount ?? 0) > 0);
  const setup = manage && bases.isSuccess && !hasDocs && editable;
  const visibleBases = (bases.data ?? []).filter((b) => b.collection?.kind !== "PERSONAL");
  const spaceLists = (lists.data ?? []).filter((l) => l.space === space.name);

  const side = (
    <>
      {catalog.data?.length ? (
        <Section title="What you can request">
          <List className="sp-side-list">
            {catalog.data.map((t) => (
              <ListItem
                key={t.name}
                lead={<ItemIcon icon={ClipboardList} size="sm" />}
                title={t.displayName}
                contentTitle
                description={t.description ? <span className="clamp-2" translate="no">{t.description}</span> : undefined}
                href={`/requests/new?space=${sid}&type=${resourceId(t.name)}`}
              />
            ))}
          </List>
        </Section>
      ) : null}
      {workflows.length ? (
        <Section title="Get started">
          <List className="sp-side-list">
            {workflows.map((w) => (
              <ListItem
                key={w.id}
                lead={<ItemIcon icon={w.icon} tone="accent" size="sm" />}
                title={w.label}
                description={<span className="clamp-2">{w.desc}</span>}
                href={newWorkHref({ workflow: w.id, space: sid })}
              />
            ))}
          </List>
        </Section>
      ) : null}
      {visibleBases.length ? (
        <Section
          title="Knowledge"
          actions={
            manage ? (
              <NextLink className="link-button" href={`/space/${sid}?tab=settings`}>
                Manage
              </NextLink>
            ) : null
          }
        >
          <List className="sp-side-list">
            {visibleBases.map((b) => {
              const ok = b.access !== "LOCKED";
              return (
                <ListItem
                  key={b.name}
                  lead={<ItemIcon icon={ok ? BookOpen : Lock} size="sm" />}
                  title={b.displayName}
                  contentTitle
                  description={ok ? plural(b.collection?.documentCount ?? 0, "document") : "Locked"}
                  href={`/knowledge/${resourceId(b.name)}`}
                />
              );
            })}
          </List>
        </Section>
      ) : null}
      {spaceLists.length ? (
        <Section title="Collections">
          <List className="sp-side-list">
            {spaceLists.map((c) => (
              <ListItem
                key={c.name}
                lead={<ItemIcon icon={ListIcon} tone="accent" size="sm" />}
                title={c.displayName}
                contentTitle
                description={plural(c.itemCount ?? 0, "item")}
                href={`/knowledge/collections/${resourceId(c.name)}`}
              />
            ))}
          </List>
        </Section>
      ) : null}
    </>
  );
  const hasSide = !!catalog.data?.length || workflows.length > 0 || visibleBases.length > 0 || spaceLists.length > 0;

  return (
    <>
      {setup && editable ? (
        <div className="mb-24">
          <Callout
            tone="accent"
            title="Add materials to get started"
            description="Members can ask about them and use them in workflows."
            actions={
              <Button size="sm" variant="tertiary" onPress={() => openContribute({ collection: editable.name })}>
                <Upload aria-hidden />
                Add materials
              </Button>
            }
          />
        </div>
      ) : null}
      <div className="sp-overview">
        <div className="sp-overview__main">
          {member ? (
            <>
              <Announcements view={view} onPost={actions.postAnnouncement} canPost={can("announcements.create")} canEdit={can("announcements.update")} />
              <UpNext view={view} onEdit={actions.editEvent} />
            </>
          ) : (
            <VisitorJoin view={view} onJoined={() => router.refresh()} />
          )}
        </div>
        {hasSide ? <aside className="sp-overview__side">{side}</aside> : null}
      </div>
    </>
  );
}

function Announcements({ view, onPost, canPost, canEdit }: { view: SpaceView; onPost: (a?: Announcement) => void; canPost: boolean; canEdit: boolean }) {
  const { id: ws } = useWorkspace();
  const qc = useQueryClient();
  const query = useAnnouncements(view.sid);
  const [showAll, setShowAll] = useState(false);
  const all = [...(query.data ?? [])].sort(
    (a, b) => Number(!!b.pinned) - Number(!!a.pinned) || Date.parse(b.createTime ?? "") - Date.parse(a.createTime ?? ""),
  );
  const names = useMemberNames(all.map((a) => a.author));
  const shown = showAll ? all : all.slice(0, 3);

  async function togglePin(a: Announcement) {
    try {
      await updateAnnouncement(a.name ?? "", { title: a.title, pinned: !a.pinned, etag: a.etag }, ["pinned"]);
      void invalidateSpaces(qc, ws);
      toast(a.pinned ? "Unpinned" : "Pinned");
    } catch (e) {
      toast(errorMessage(e), { tone: "danger" });
    }
  }
  async function remove(a: Announcement) {
    try {
      await deleteAnnouncement(a.name ?? "");
      void invalidateSpaces(qc, ws);
      toast("Announcement deleted", {
        undo: () =>
          void createAnnouncement(ws, view.sid, { title: a.title, body: a.body, pinned: a.pinned })
            .then(() => invalidateSpaces(qc, ws))
            .catch((e) => toast(errorMessage(e), { tone: "danger" })),
      });
    } catch (e) {
      toast(errorMessage(e), { tone: "danger" });
    }
  }

  let body;
  if (query.data === undefined && query.isError) body = <ErrorState error={query.error} onRetry={query.refetch} />;
  else if (query.data === undefined) body = <SkeletonRows rows={2} />;
  else if (!all.length)
    body = (
      <EmptyState
        icon={Megaphone}
        title="No announcements yet"
        description={canPost ? "Post updates members should see first." : "Updates from the team will show up here."}
        actions={
          canPost ? (
            <Button variant="tertiary" onPress={() => onPost()}>
              <Plus aria-hidden />
              Post announcement
            </Button>
          ) : null
        }
        boxed
        compact
      />
    );
  else
    body = (
      <div className="stack gap-12">
        {shown.map((a) => {
          const by = names.get(a.author ?? "") || "Someone";
          return (
            <div key={a.name} className="card sp-ann">
              <div className="sp-ann__head">
                <UserAvatar name={by} size="sm" />
                <div className="grow stack">
                  <span className="sp-ann__by truncate" translate="no">
                    {by}
                  </span>
                  <span className="sp-ann__at">{rel(a.createTime)}</span>
                </div>
                {a.pinned ? <StatusChip label="Pinned" tone="accent" size="sm" dot={false} /> : null}
                {canEdit ? (
                  <Menu
                    label="Announcement options"
                    nodes={[
                      { id: "edit", label: "Edit", icon: Pencil, run: () => onPost(a) },
                      { id: "pin", label: a.pinned ? "Unpin" : "Pin to the top", icon: a.pinned ? X : ArrowUp, run: () => void togglePin(a) },
                      { sep: "1" },
                      { id: "delete", label: "Delete", icon: Trash2, danger: true, run: () => void remove(a) },
                    ]}
                  >
                    <Button isIconOnly size="sm" variant="ghost" aria-label="Announcement options" className="button--muted">
                      <MoreHorizontal aria-hidden />
                    </Button>
                  </Menu>
                ) : null}
              </div>
              <div className="stack gap-4">
                <h3 className="sp-ann__title" translate="no">
                  {a.title}
                </h3>
                {a.body ? (
                  <p className="sp-ann__text" translate="no">
                    {a.body}
                  </p>
                ) : null}
              </div>
            </div>
          );
        })}
        {all.length > 3 ? (
          <div>
            <Button variant="ghost" size="sm" className="link-button" onPress={() => setShowAll(!showAll)}>
              {showAll ? "Show fewer" : `Show all ${all.length}`}
            </Button>
          </div>
        ) : null}
      </div>
    );

  return (
    <Section
      title="Announcements"
      actions={
        canPost && all.length ? (
          <Button variant="ghost" size="sm" onPress={() => onPost()}>
            <Plus aria-hidden />
            Post
          </Button>
        ) : null
      }
    >
      {body}
    </Section>
  );
}

function UpNext({ view, onEdit }: { view: SpaceView; onEdit: (item: UpNextItem) => void }) {
  const { id: ws } = useWorkspace();
  const qc = useQueryClient();
  const query = useUpNext({ space: view.sid, limit: 5 });
  const canEdit = view.can("events.update");

  async function remove(item: UpNextItem) {
    const e = item.event;
    if (!e?.name) return;
    const ok = await confirm({ title: `Delete “${e.title}”?`, description: "It disappears from Up next for everyone in the space.", confirmLabel: "Delete event", tone: "danger" });
    if (!ok) return;
    try {
      await deleteSpaceEvent(e.name);
      void invalidateSpaces(qc, ws);
      toast("Event deleted", {
        undo: () =>
          void createSpaceEvent(ws, view.sid, { title: e.title, startTime: e.startTime, endTime: e.endTime, location: e.location, description: e.description })
            .then(() => invalidateSpaces(qc, ws))
            .catch((err) => toast(errorMessage(err), { tone: "danger" })),
      });
    } catch (err) {
      toast(errorMessage(err), { tone: "danger" });
    }
  }

  return (
    <Section title="Up next">
      {query.data === undefined && query.isError ? (
        <ErrorState error={query.error} onRetry={query.refetch} />
      ) : query.data === undefined ? (
        <SkeletonRows rows={2} />
      ) : (
        <UpNextList
          items={query.data}
          space={view.sid}
          empty={<EmptyState icon={Calendar} title="Nothing coming up" description="Deadlines and events for this space show up here." compact boxed />}
          renderActions={
            canEdit
              ? (item) =>
                  item.event ? (
                    <Menu
                      label="Event options"
                      nodes={[
                        { id: "edit", label: "Edit", icon: Pencil, run: () => onEdit(item) },
                        { sep: "1" },
                        { id: "delete", label: "Delete", icon: Trash2, danger: true, run: () => void remove(item) },
                      ]}
                    >
                      <Button isIconOnly size="sm" variant="ghost" aria-label="Event options" className="button--muted">
                        <MoreHorizontal aria-hidden />
                      </Button>
                    </Menu>
                  ) : null
              : undefined
          }
        />
      )}
    </Section>
  );
}

/** Visitors of an open space read the catalog; announcements and Up next are for members (`:join`). */
function VisitorJoin({ view, onJoined }: { view: SpaceView; onJoined: () => void }) {
  const { id: ws } = useWorkspace();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  async function join() {
    setBusy(true);
    try {
      await joinSpace(ws, view.sid);
      await invalidateSpaces(qc, ws);
      onJoined();
      toast(`You joined ${view.space.displayName}`);
    } catch (e) {
      toast(errorMessage(e), { tone: "danger" });
    } finally {
      setBusy(false);
    }
  }
  return (
    <Section title="Announcements">
      <EmptyState
        icon={Megaphone}
        title="Join to see updates"
        description="Announcements and what’s coming up are shared with members."
        actions={
          <Button variant="tertiary" onPress={() => void join()} isPending={busy}>
            Join space
          </Button>
        }
        boxed
        compact
      />
    </Section>
  );
}
