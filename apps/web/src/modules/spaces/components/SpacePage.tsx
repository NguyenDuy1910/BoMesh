"use client";

import { useQueryClient } from "@tanstack/react-query";
import { Button, buttonVariants } from "@heroui/react";
import { Clock, Layers, Link, Lock, Plus, Settings, Sparkles, Users } from "lucide-react";
import NextLink from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState, type ReactNode } from "react";

import { PageChrome } from "@/components/shell/page-chrome";
import { EmptyState, ErrorState, IconButton, Page, PageHeader, SectionTabs, SkeletonRows, UserAvatar, toast, type SectionTab } from "@/components/ui";
import { ApiError, errorMessage, resourceId } from "@/lib/api/client";
import { plural, relInline } from "@/lib/format";
import { useMessages } from "@/lib/i18n";
import { useWorkspace } from "@/lib/workspace";
import { AskSpaceDialog, isActionable } from "@/modules/requests";
import { useCopyShareLink } from "@/modules/shares/queries";
import { NewWorkMenu, workflowsFor } from "@/modules/work";

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
import { OverviewTab } from "./OverviewTab";
import { PeopleTab } from "./PeopleTab";
import { AnnouncementDialog, EventDialog } from "./PostDialogs";
import { QueueTab } from "./QueueTab";
import { SettingsTab } from "./SettingsTab";
import { SpaceMark } from "./SpaceMark";
import { WorkTab } from "./WorkTab";

type BaseView = Omit<SpaceView, "newInHeader">;
type Dialog = { kind: "announcement"; announcement?: Announcement } | { kind: "event"; item?: UpNextItem } | { kind: "ask" } | null;

/** `/space/[id]` (preview `P.space`). */
export function SpacePage({ spaceId }: { spaceId: string }) {
  const { settings } = useWorkspace();
  const query = useSpace(spaceId);
  const space = query.data;
  const perms = useSpacePermissions(spaceId, !!space && space.state !== "DELETED");

  if (query.isError && !space) {
    const gone = query.error instanceof ApiError && (query.error.isNotFound || query.error.status === 403);
    return gone ? (
      <Unavailable />
    ) : (
      <Page>
        <ErrorState error={query.error} onRetry={query.refetch} />
      </Page>
    );
  }
  if (!space || perms.isPending)
    return (
      <Page width="wide">
        <SkeletonRows rows={6} />
      </Page>
    );
  if (space.state === "DELETED") return <Unavailable />;

  const type = spaceType(space.spaceType, settings);
  const role = space.callerRole || null;
  const manage = perms.can("spaces.update");
  const view: BaseView = {
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
  return <SpaceBody base={view} />;
}

function Unavailable() {
  const msg = useMessages();
  return (
    <Page>
      <PageChrome crumbs={[{ label: msg.nav.spaces, href: "/spaces" }, { label: "Not available" }]} />
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
function PeopleLine({ view, link }: { view: BaseView; link: boolean }) {
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
      {plural(Math.max(view.space.memberCount ?? 0, members.data?.length ?? 0), "member")}
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

/** Hero meta (preview `sp-head__meta` + `peopleLine`). */
function HeadMeta({ view, link }: { view: BaseView; link: boolean }) {
  return (
    <>
      {/* An untyped space's generic "Space" label would only repeat the breadcrumb. */}
      {view.space.spaceType ? <span className="sp-head__meta">{view.type.label}</span> : null}
      <PeopleLine view={view} link={link} />
    </>
  );
}

/** Outsiders of a non-open space (preview `lockedPage`): enrolled-only courses, a pending request, or Request to join. */
function LockedPage({ view }: { view: BaseView }) {
  const msg = useMessages();
  const spacesCrumb = { label: msg.nav.spaces, href: "/spaces" };
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
        description={`You asked ${relInline(pending.createTime)}. You’ll get in as soon as someone approves it.`}
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
      <PageHeader
        title={space.displayName}
        heading={<span translate="no">{space.displayName}</span>}
        lead={<SpaceMark space={space} size={48} />}
        meta={<HeadMeta view={view} link={false} />}
        crumbs={[spacesCrumb, { label: space.displayName }]}
      />
      {body}
      <JoinSpaceDialog space={joining ? space : null} onClose={() => setJoining(false)} />
    </Page>
  );
}

/** Settings is a rare admin task: its own page behind the header gear, not a tab (preview `query.tab === 'settings'`). */
function SettingsPage({ view }: { view: SpaceView }) {
  const msg = useMessages();
  const spacesCrumb = { label: msg.nav.spaces, href: "/spaces" };
  return (
    <Page>
      {/* Preview: the space itself heads its settings (mark and name), "Space settings" underneath. */}
      <PageHeader
        title={view.space.displayName}
        lead={<SpaceMark space={view.space} size={40} />}
        meta={<span className="sp-head__meta">Space settings</span>}
        crumbs={[spacesCrumb, { label: view.space.displayName, href: `/space/${view.sid}` }, { label: "Settings" }]}
      />
      <SettingsTab view={view} />
    </Page>
  );
}

function SpaceBody({ base }: { base: BaseView }) {
  const msg = useMessages();
  const spacesCrumb = { label: msg.nav.spaces, href: "/spaces" };
  const { id: ws, settings, hasModule, memberId } = useWorkspace();
  const copyShareLink = useCopyShareLink();
  const router = useRouter();
  const params = useSearchParams();
  const { space, sid, type, role, staff, manage, visitor, can } = base;
  const [dialog, setDialog] = useState<Dialog>(null);
  const bases = useSpaceBases(space);
  const materials = useSpaceMaterials(sid, can("materials.list"));
  const catalog = useRequestTypes(sid);
  const queueOn = staff && hasModule("requests");
  const queue = useSpaceQueue(sid, queueOn);

  const catalogCount = catalog.data?.length ?? 0;
  const queueLabel = catalogCount ? "Requests" : "Questions";
  const waiting = (queue.data ?? []).filter((r) => resourceId(r.requester) !== memberId && isActionable(r)).length;
  const readable = (bases.data ?? []).filter((b) => b.access !== "LOCKED");
  const workflows = hasModule("work") ? workflowsFor(settings, space) : [];
  /** Offices whose staff work a request queue: the queue is their space's main view (preview `isDesk`). */
  const desk = staff && type.key === "office" && catalogCount > 0;
  const newInHeader = (staff || (manage && !role)) && !desk && workflows.length > 0;
  const view: SpaceView = { ...base, newInHeader };

  if (params.get("tab") === "settings" && manage) return <SettingsPage view={view} />;

  // Preview `tabsFor`: desks open on their queue; visitors see Overview and Materials only.
  const tabs: SectionTab[] = [];
  const queueTab = () => tabs.push({ id: "queue", label: queueLabel, count: waiting || null, alert: waiting > 0 });
  if (desk) queueTab();
  tabs.push({ id: "overview", label: "Overview" });
  if (readable.length || manage || materials.data?.length) tabs.push({ id: "materials", label: "Materials" });
  if (!visitor) {
    if (hasModule("work")) tabs.push({ id: "work", label: "Work" });
    if (queueOn && !desk) queueTab();
    tabs.push({ id: "people", label: "Members" });
  }
  const tab = tabs.some((t) => t.id === params.get("tab")) ? params.get("tab")! : tabs[0].id;

  const ask = (variant: "primary" | "tertiary") => (
    <NextLink href={`/chat?space=${sid}`} className={buttonVariants({ variant })}>
      <Sparkles aria-hidden />
      Ask AI
    </NextLink>
  );
  const gear = manage ? <IconButton icon={Settings} tip="Space settings" onPress={() => router.push(`/space/${sid}?tab=settings`)} /> : null;
  // Copy link (a share of the space, `/s/{share}`): a quiet icon for everyone who can open the space.
  const copy = <IconButton icon={Link} tip="Copy link" onPress={() => void copyShareLink(`workspaces/${ws}/spaces/${sid}`)} />;

  let actions: ReactNode;
  if (visitor)
    actions = (
      <>
        {copy}
        {ask("tertiary")}
        {catalogCount ? (
          <NextLink href={`/requests/new?space=${sid}`} className={buttonVariants({ variant: "primary" })}>
            <Plus aria-hidden />
            New request
          </NextLink>
        ) : null}
      </>
    );
  else if (staff || (manage && !role))
    actions = (
      <>
        {copy}
        {ask("tertiary")}
        {newInHeader ? <NewWorkMenu flows={workflows} space={sid} /> : null}
        {gear}
      </>
    );
  else {
    const team = type.key === "course" ? "Ask the teaching team" : type.key === "office" ? "Ask the office" : "Ask the team";
    actions = (
      <>
        {copy}
        {hasModule("requests") ? (
          <Button variant="tertiary" onPress={() => setDialog({ kind: "ask" })}>
            <Users aria-hidden />
            {team}
          </Button>
        ) : null}
        {ask("primary")}
        {gear}
      </>
    );
  }

  let body: ReactNode;
  if (tab === "materials") body = <MaterialsTab view={view} />;
  else if (tab === "work") body = <WorkTab view={view} />;
  else if (tab === "queue") body = <QueueTab view={view} />;
  else if (tab === "people") body = <PeopleTab view={view} />;
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
    <Page width="wide">
      <PageHeader
        title={space.displayName}
        heading={<span translate="no">{space.displayName}</span>}
        lead={<SpaceMark space={space} size={48} />}
        meta={<HeadMeta view={view} link={!visitor} />}
        actions={actions}
        crumbs={[spacesCrumb, { label: space.displayName }]}
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
