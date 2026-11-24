"use client";

import { Button } from "@heroui/react";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowUp, Calendar, ClipboardList, Megaphone, MoreHorizontal, Pencil, Plus, Trash2, Upload, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Callout, EmptyState, ErrorState, ItemIcon, LinkButton, List, ListItem, Pager, Section, SkeletonRows, StatusChip, UserAvatar, confirm, toast } from "@/components/ui";
import { errorMessage, resourceId } from "@/lib/api/client";
import { plural, rel } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";
import { BaseMark } from "@/modules/knowledge/bases/components/BaseMark";
import { openContribute } from "@/modules/knowledge/components/contribute-store";
import { useMemberNames } from "@/modules/knowledge/queries";
import { catalogHref } from "@/modules/knowledge/model";
import { newWorkHref, workflowsFor } from "@/modules/work";

import { createAnnouncement, createSpaceEvent, deleteAnnouncement, deleteSpaceEvent, joinSpace, updateAnnouncement, type Announcement } from "../api";
import { invalidateSpaces, useAnnouncementPages, useRequestTypes, useSpaceBases, useUpNext, type UpNextItem } from "../queries";
import type { SpaceView } from "./context";
import { Menu } from "./Menu";
import { UpNextList } from "./UpNextList";

/** Announcements shown before Show all; Show all pages through them. */
const ANN_PREVIEW = 3;
const ANN_PAGE = 20;

export interface OverviewActions {
  postAnnouncement: (announcement?: Announcement) => void;
  /** Add an event (no item) or edit one. */
  editEvent: (item?: UpNextItem) => void;
}

/** Overview (preview `overviewTab`): Up next and announcements; request catalog, workflows and collections beside. */
export function OverviewTab({ view, actions }: { view: SpaceView; actions: OverviewActions }) {
  const { space, sid, manage, visitor, staff, newInHeader, can } = view;
  const { settings, hasModule } = useWorkspace();
  const router = useRouter();
  const bases = useSpaceBases(space);
  const catalog = useRequestTypes(sid);
  // Staff start work from the header; members get the same workflows here.
  const workflows = !visitor && !newInHeader && !staff && hasModule("work") ? workflowsFor(settings, space) : [];

  const linked = bases.data ?? [];
  const editable = linked.find((b) => b.access === "EDITOR" || b.access === "OWNER");
  const hasDocs = linked.some((b) => b.access !== "LOCKED" && (b.collection?.documentCount ?? 0) > 0);
  const setup = manage && bases.isSuccess && !hasDocs ? editable : undefined;
  const collections = linked.filter((b) => b.itemType !== "PERSONAL");

  const side = (
    <>
      {catalog.data?.length ? (
        <Section title="Những gì bạn có thể yêu cầu">
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
        <Section title="Bắt đầu">
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
      {collections.length ? (
        <Section title="Tài liệu">
          <List className="sp-side-list">
            {collections.map((b) => (
              <ListItem
                key={b.name}
                lead={<BaseMark base={b} size={28} />}
                title={b.displayName}
                contentTitle
                description={b.access !== "LOCKED" ? plural(b.collection?.documentCount ?? 0, "document") : "Đã khóa"}
                href={catalogHref({ filters: { kb: [resourceId(b.name)] } })}
              />
            ))}
          </List>
        </Section>
      ) : null}
    </>
  );
  const hasSide = !!catalog.data?.length || workflows.length > 0 || collections.length > 0;

  return (
    <>
      {setup ? (
        <div className="mb-24">
          <Callout
            tone="accent"
            title="Thêm tài liệu học tập để bắt đầu"
            description="Thành viên có thể hỏi về chúng và dùng trong quy trình."
            actions={
              <Button size="sm" variant="tertiary" onPress={() => openContribute({ collection: setup.name })}>
                <Upload aria-hidden />
                Gửi tài liệu
              </Button>
            }
          />
        </div>
      ) : null}
      <div className="sp-overview">
        <div className="sp-overview__main">
          <UpNext view={view} onEdit={actions.editEvent} />
          {can("announcements.list") ? (
            <Announcements view={view} onPost={actions.postAnnouncement} canPost={can("announcements.create")} canEdit={can("announcements.update")} />
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
  const [showAll, setShowAll] = useState(false);
  // The server orders pinned first, then newest.
  const query = useAnnouncementPages(view.sid, showAll ? ANN_PAGE : ANN_PREVIEW);
  const shown = query.data?.announcements ?? [];
  const total = query.total ?? shown.length;
  const names = useMemberNames(shown.map((a) => a.author));

  async function togglePin(a: Announcement) {
    try {
      await updateAnnouncement(a.name ?? "", { title: a.title, pinned: !a.pinned, etag: a.etag }, ["pinned"]);
      void invalidateSpaces(qc, ws);
      toast(a.pinned ? "Đã bỏ ghim" : "Đã ghim");
    } catch (e) {
      toast(errorMessage(e), { tone: "danger" });
    }
  }
  async function remove(a: Announcement) {
    try {
      await deleteAnnouncement(a.name ?? "");
      void invalidateSpaces(qc, ws);
      toast("Đã xóa thông báo", {
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
  else if (!shown.length && query.page === 1)
    body = (
      <EmptyState
        icon={Megaphone}
        title="Chưa có thông báo"
        description={canPost ? "Đăng cập nhật mà thành viên cần xem trước tiên." : "Cập nhật từ nhóm sẽ hiển thị tại đây."}
        actions={
          canPost ? (
            <Button variant="tertiary" onPress={() => onPost()}>
              <Plus aria-hidden />
              Đăng thông báo
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
          const by = names.get(a.author ?? "") || "Ai đó";
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
                {a.pinned ? <StatusChip label="Đã ghim" tone="accent" size="sm" dot={false} /> : null}
                {canEdit ? (
                  <Menu
                    label="Tùy chọn thông báo"
                    nodes={[
                      { id: "edit", label: "Chỉnh sửa", icon: Pencil, run: () => onPost(a) },
                      { id: "pin", label: a.pinned ? "Bỏ ghim" : "Ghim lên đầu", icon: a.pinned ? X : ArrowUp, run: () => void togglePin(a) },
                      { sep: "1" },
                      { id: "delete", label: "Xóa", icon: Trash2, danger: true, run: () => void remove(a) },
                    ]}
                  >
                    <Button isIconOnly size="sm" variant="ghost" aria-label="Tùy chọn thông báo" className="button--muted">
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
        {showAll && (query.page > 1 || query.hasNext) ? (
          <Pager page={query.page} pageSize={ANN_PAGE} total={query.total} pageCount={shown.length} hasNext={query.hasNext} onPageChange={query.setPage} />
        ) : null}
        {total > ANN_PREVIEW || query.hasNext || showAll ? (
          <div>
            <LinkButton onPress={() => setShowAll(!showAll)}>{showAll ? "Thu gọn" : query.total !== undefined ? `Hiện tất cả ${total}` : "Hiển thị tất cả"}</LinkButton>
          </div>
        ) : null}
      </div>
    );

  return (
    <Section
      title="Thông báo"
      actions={
        canPost && shown.length ? (
          <Button variant="ghost" size="sm" onPress={() => onPost()}>
            <Plus aria-hidden />
            Đăng
          </Button>
        ) : null
      }
    >
      {body}
    </Section>
  );
}

/**
 * Up next for this space (preview: the space's own queue is counted on its tab, so it's left out; empty sections are omitted).
 * Space events are the web's source of Up next, so people who may add events keep the section (and its Add event) when empty.
 */
function UpNext({ view, onEdit }: { view: SpaceView; onEdit: (item?: UpNextItem) => void }) {
  const { id: ws } = useWorkspace();
  const qc = useQueryClient();
  const query = useUpNext({ space: view.sid, limit: 5, queue: false });
  const canAdd = view.can("events.create");
  const canEdit = view.can("events.update");
  const items = query.data ?? [];

  async function remove(item: UpNextItem) {
    const e = item.event;
    if (!e?.name) return;
    const ok = await confirm({ title: `Xóa “${e.title}”?`, description: "Sự kiện sẽ biến mất khỏi mục Tiếp theo của mọi người trong cộng đồng.", confirmLabel: "Xóa sự kiện", tone: "danger" });
    if (!ok) return;
    try {
      await deleteSpaceEvent(e.name);
      void invalidateSpaces(qc, ws);
      toast("Đã xóa sự kiện", {
        undo: () =>
          void createSpaceEvent(ws, view.sid, { title: e.title, startTime: e.startTime, endTime: e.endTime, location: e.location, description: e.description })
            .then(() => invalidateSpaces(qc, ws))
            .catch((err) => toast(errorMessage(err), { tone: "danger" })),
      });
    } catch (err) {
      toast(errorMessage(err), { tone: "danger" });
    }
  }

  if (!query.data || (!items.length && !canAdd)) return null;
  const add = canAdd ? (
    <Button variant="ghost" size="sm" onPress={() => onEdit()}>
      <Plus aria-hidden />
      Thêm sự kiện
    </Button>
  ) : null;
  return (
    <Section title="Tiếp theo" actions={items.length ? add : null}>
      <UpNextList
        items={items}
        space={view.sid}
        empty={<EmptyState icon={Calendar} title="Không có sự kiện sắp tới" description="Hạn chót và sự kiện của cộng đồng này sẽ hiển thị tại đây." actions={add} compact boxed />}
        renderActions={
          canEdit
            ? (item) =>
                item.event ? (
                  <Menu
                    label="Tùy chọn sự kiện"
                    nodes={[
                      { id: "edit", label: "Chỉnh sửa", icon: Pencil, run: () => onEdit(item) },
                      { sep: "1" },
                      { id: "delete", label: "Xóa", icon: Trash2, danger: true, run: () => void remove(item) },
                    ]}
                  >
                    <Button isIconOnly size="sm" variant="ghost" aria-label="Tùy chọn sự kiện" className="button--muted">
                      <MoreHorizontal aria-hidden />
                    </Button>
                  </Menu>
                ) : null
            : undefined
        }
      />
    </Section>
  );
}

/** Visitors of an open space who can't read announcements: they join with `:join`. */
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
      toast(`Bạn đã tham gia ${view.space.displayName}`);
    } catch (e) {
      toast(errorMessage(e), { tone: "danger" });
    } finally {
      setBusy(false);
    }
  }
  return (
    <Section title="Thông báo">
      <EmptyState
        icon={Megaphone}
        title="Tham gia để xem cập nhật"
        description="Thông báo và các sự kiện sắp tới được chia sẻ với thành viên."
        actions={
          <Button variant="tertiary" onPress={() => void join()} isPending={busy}>
            Tham gia cộng đồng
          </Button>
        }
        boxed
        compact
      />
    </Section>
  );
}
