"use client";

import { useQueryClient } from "@tanstack/react-query";
import { Button, buttonVariants } from "@heroui/react";
import { Calendar, ChevronDown, Clock, Layers, Lock, Megaphone, MessageSquare, Plus, Sparkles, Upload } from "lucide-react";
import NextLink from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState, type ReactNode } from "react";

import { PageChrome } from "@/components/shell/page-chrome";
import { EmptyState, ErrorState, Page, PageHeader, SectionTabs, SkeletonRows, UserAvatar, toast, type SectionTab } from "@/components/ui";
import { ApiError, errorMessage, resourceId } from "@/lib/api/client";
import { plural, rel } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";
import { openContribute } from "@/modules/knowledge/components/Contribute";
import { AskSpaceDialog } from "@/modules/requests/components/AskSpaceDialog";
import { newWorkHref, workflowsFor } from "@/modules/work/kinds";

import { decideRequest, type Announcement } from "../api";
import {
  invalidateSpaces,
  useMyJoinRequests,
  useRequestTypes,
  useSpace,
  useSpaceBases,
  useSpaceMaterials,
  useSpaceMembers,
  useSpacePermissions,
  useSpaceQueue,
  type UpNextItem,
} from "../queries";
import { isStaffRole, joinMode, spaceType } from "../types";
import type { SpaceView } from "./context";
import { JoinSpaceDialog } from "./JoinSpaceDialog";
import { MaterialsTab } from "./MaterialsTab";
import { Menu, type MenuNode } from "./Menu";
import { OverviewTab } from "./OverviewTab";
import { PeopleTab } from "./PeopleTab";
import { AnnouncementDialog, EventDialog } from "./PostDialogs";
import { QueueTab } from "./QueueTab";
import { SettingsTab } from "./SettingsTab";
import { SpaceMark } from "./SpaceMark";
import { WorkTab } from "./WorkTab";

type Dialog = { kind: "announcement"; announcement?: Announcement } | { kind: "event"; item?: UpNextItem } | { kind: "ask" } | null;

/** `/space/[id]` (preview `P.space`). */
export function SpacePage({ spaceId }: { spaceId: string }) {
  const { settings } = useWorkspace();
  const query = useSpace(spaceId);
  const space = query.data;
  const perms = useSpacePermissions(spaceId, !!space && space.state !== "DELETED");

  if (query.isError && !space) {
    const gone = query.error instanceof ApiError && (query.error.isNotFound || query.error.status === 403);
    return gone ? <Unavailable /> : <ErrorState error={query.error} onRetry={query.refetch} />;
  }
  if (!space || perms.isPending) return <SkeletonRows rows={6} />;
  if (space.state === "DELETED") return <Unavailable />;

  const type = spaceType(space.spaceType, settings);
  const role = space.callerRole || null;
  const manage = perms.can("spaces.update");
  const view: SpaceView = {
    space,
    sid: resourceId(space.name),
    type,
    role,
    staff: isStaffRole(role),
    manage,
    visitor: !role && !manage,
    can: perms.can,
  };
  if (view.visitor && joinMode(space, type) !== "open") return <LockedPage view={view} />;
  return <SpaceBody view={view} />;
}

function Unavailable() {
  return (
    <Page>
      <PageChrome crumbs={[{ label: "Spaces", href: "/spaces" }, { label: "Not available" }]} />
      <EmptyState
        icon={Layers}
        boxed
        title="This space isn’t available"
        description="It may have been archived, or it’s private."
        actions={
          <NextLink href="/spaces" className={buttonVariants({ variant: "primary" })}>
            Browse spaces
          </NextLink>
        }
      />
    </Page>
  );
}

/** Header people line (preview `peopleLine`): first faces and the member count; links to People for members. */
function PeopleLine({ view, link }: { view: SpaceView; link: boolean }) {
  const members = useSpaceMembers(view.sid, link);
  const faces = (
    <>
      {link && members.data?.length ? (
        <span className="avatar-group">
          {members.data.slice(0, 4).map((m) => (
            <UserAvatar key={m.name} name={m.displayName ?? ""} size="sm" />
          ))}
        </span>
      ) : null}
      {plural(view.space.memberCount ?? members.data?.length ?? 0, "member")}
    </>
  );
  return link ? (
    <NextLink className="sp-head__people" href={`/space/${view.sid}?tab=people`}>
      {faces}
    </NextLink>
  ) : (
    <span className="sp-head__people">{faces}</span>
  );
}

function Description({ view, link }: { view: SpaceView; link: boolean }) {
  return (
    <>
      <span className="sp-head__meta">{view.type.label}</span>
      <PeopleLine view={view} link={link} />
    </>
  );
}

/** Outsiders of a non-open space (preview `lockedPage`): enrolled-only courses, a pending request, or Request to join. */
function LockedPage({ view }: { view: SpaceView }) {
  const { id: ws } = useWorkspace();
  const qc = useQueryClient();
  const mine = useMyJoinRequests();
  const [joining, setJoining] = useState(false);
  const pending = mine.data?.get(view.sid);
  const { space, type } = view;

  async function withdraw() {
    if (!pending?.name) return;
    try {
      await decideRequest(pending.name, "withdraw");
      void invalidateSpaces(qc, ws);
      toast("Request withdrawn");
    } catch (e) {
      toast(errorMessage(e), { tone: "danger" });
    }
  }

  let body: ReactNode;
  if (joinMode(space, type) === "enrolled")
    body = (
      <EmptyState
        icon={type.icon}
        boxed
        title="You’re not enrolled in this course"
        description="Courses are joined through the student portal. Once you’re enrolled, its materials, quizzes and announcements show up here."
        actions={
          <NextLink href="/spaces" className={buttonVariants({ variant: "tertiary" })}>
            Browse spaces
          </NextLink>
        }
      />
    );
  else if (mine.isPending) body = <SkeletonRows rows={3} />;
  else if (pending)
    body = (
      <EmptyState
        icon={Clock}
        boxed
        title="Your request is with the team"
        description={`You asked ${rel(pending.createTime).toLowerCase()}. You’ll get in as soon as someone approves it.`}
        actions={
          <Button variant="tertiary" onPress={() => void withdraw()}>
            Withdraw request
          </Button>
        }
      />
    );
  else
    body = (
      <EmptyState
        icon={Lock}
        boxed
        title="Join to see materials and work"
        description={space.description ? <span translate="no">{space.description}</span> : type.desc}
        actions={
          <Button variant="primary" onPress={() => setJoining(true)}>
            Request to join
          </Button>
        }
      />
    );

  return (
    <Page>
      <PageChrome crumbs={[{ label: "Spaces", href: "/spaces" }, { label: space.displayName ?? "Space" }]} />
      <PageHeader title={<span translate="no">{space.displayName}</span>} lead={<SpaceMark space={space} size={48} />} description={<Description view={view} link={false} />} />
      {body}
      <JoinSpaceDialog space={joining ? space : null} onClose={() => setJoining(false)} />
    </Page>
  );
}

function SpaceBody({ view }: { view: SpaceView }) {
  const { settings, hasModule } = useWorkspace();
  const router = useRouter();
  const params = useSearchParams();
  const { space, sid, type, staff, manage, visitor, can } = view;
  const [dialog, setDialog] = useState<Dialog>(null);
  const bases = useSpaceBases(space);
  const materials = useSpaceMaterials(sid, can("materials.list"));
  const catalog = useRequestTypes(sid);
  const queueOn = staff && hasModule("requests");
  const queue = useSpaceQueue(sid, queueOn);

  const catalogCount = catalog.data?.length ?? 0;
  const queueLabel = catalogCount ? "Requests" : "Questions";
  const waiting = (queue.data ?? []).filter((r) => r.state === "OPEN").length;
  const readable = (bases.data ?? []).filter((b) => b.access !== "LOCKED");
  const editable = readable.find((b) => b.access === "EDITOR" || b.access === "OWNER");
  const workflows = hasModule("work") && view.role ? workflowsFor(settings, space) : [];

  const tabs: SectionTab[] = [{ id: "overview", label: "Overview" }];
  if (readable.length || manage || materials.data?.length) tabs.push({ id: "materials", label: "Materials" });
  if (!visitor) {
    if (hasModule("work")) tabs.push({ id: "work", label: "Work" });
    if (queueOn) tabs.push({ id: "queue", label: queueLabel, count: waiting || null, alert: waiting > 0 });
    tabs.push({ id: "people", label: "People" });
    if (manage) tabs.push({ id: "settings", label: "Settings" });
  }
  const tab = tabs.some((t) => t.id === params.get("tab")) ? params.get("tab")! : "overview";

  const newNodes: MenuNode[] = workflows.map((w) => ({ id: w.id, label: w.label, icon: w.icon, run: () => router.push(newWorkHref({ workflow: w.id, space: sid })) }));
  const extra: MenuNode[] = [];
  if (can("announcements.create")) extra.push({ id: "announcement", label: "Announcement", icon: Megaphone, run: () => setDialog({ kind: "announcement" }) });
  if (can("events.create")) extra.push({ id: "event", label: "Event", icon: Calendar, run: () => setDialog({ kind: "event" }) });
  if (editable && (staff || manage)) extra.push({ id: "materials", label: "Add materials", icon: Upload, run: () => openContribute({ collection: editable.name }) });
  const newMenu = newNodes.length && extra.length ? [...newNodes, { sep: "1" }, ...extra] : [...newNodes, ...extra];

  const askLabel = type.key === "course" && !staff ? "Ask about this course" : "Ask";
  const ask = (variant: "primary" | "tertiary") => (
    <NextLink href={`/chat?space=${sid}`} className={buttonVariants({ variant })}>
      <Sparkles aria-hidden />
      {askLabel}
    </NextLink>
  );
  const newButton = (variant: "primary" | "tertiary") =>
    newMenu.length ? (
      <Menu label="New" nodes={newMenu}>
        <Button variant={variant}>
          <Plus aria-hidden />
          New
          <ChevronDown aria-hidden />
        </Button>
      </Menu>
    ) : null;

  let actions: ReactNode;
  if (visitor)
    actions = (
      <>
        {ask("tertiary")}
        {catalogCount ? (
          <NextLink href={`/requests/new?space=${sid}`} className={buttonVariants({ variant: "primary" })}>
            <Plus aria-hidden />
            New request
          </NextLink>
        ) : null}
      </>
    );
  else if (staff || (manage && !view.role))
    actions = (
      <>
        {ask("tertiary")}
        {newButton("primary")}
      </>
    );
  else
    actions = (
      <>
        {hasModule("requests") ? (
          <Button variant="tertiary" onPress={() => setDialog({ kind: "ask" })}>
            <MessageSquare aria-hidden />
            {type.key === "course" ? (
              "Ask the teaching team"
            ) : (
              <span>
                Ask <span translate="no">{space.displayName}</span>
              </span>
            )}
          </Button>
        ) : type.key === "course" ? null : (
          newButton("tertiary")
        )}
        {ask("primary")}
      </>
    );

  let body: ReactNode;
  if (tab === "materials") body = <MaterialsTab view={view} />;
  else if (tab === "work") body = <WorkTab view={view} />;
  else if (tab === "queue") body = <QueueTab view={view} noun={queueLabel.toLowerCase()} />;
  else if (tab === "people") body = <PeopleTab view={view} />;
  else if (tab === "settings") body = <SettingsTab view={view} />;
  else
    body = (
      <OverviewTab
        view={view}
        actions={{
          postAnnouncement: (announcement) => setDialog({ kind: "announcement", announcement }),
          editEvent: (item) => setDialog({ kind: "event", item }),
        }}
      />
    );

  return (
    <Page>
      <PageChrome crumbs={[{ label: "Spaces", href: "/spaces" }, { label: space.displayName ?? "Space" }]} />
      <PageHeader
        title={<span translate="no">{space.displayName}</span>}
        lead={<SpaceMark space={space} size={48} />}
        description={<Description view={view} link={!visitor} />}
        actions={actions}
      >
        <SectionTabs items={tabs} active={tab} base={`/space/${sid}`} />
      </PageHeader>
      {body}
      {dialog?.kind === "announcement" ? <AnnouncementDialog space={space} announcement={dialog.announcement} onClose={() => setDialog(null)} /> : null}
      {dialog?.kind === "event" ? <EventDialog space={space} event={dialog.item?.event} onClose={() => setDialog(null)} /> : null}
      <AskSpaceDialog space={space} isOpen={dialog?.kind === "ask"} onClose={() => setDialog(null)} />
    </Page>
  );
}
