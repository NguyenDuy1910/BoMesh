"use client";

import { Button, buttonVariants } from "@heroui/react";
import { Clock, Layers, Plus, Send, Users } from "lucide-react";
import NextLink from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useState, type ReactNode } from "react";

import { EmptyState, Gate, NoMatches, Page, PageHeader, SearchInput, Section, SectionTabs, SkeletonCards, StatusChip } from "@/components/ui";
import { resourceId } from "@/lib/api/client";
import { plural } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";

import { useMyJoinRequests, useRequestTypes, useSpaces } from "../queries";
import { isStaffRole, joinMode, roleLabel, spaceType, spaceTypesOf, type Space, type SpaceTypeDef } from "../types";
import { TOOLS_MIN } from "./context";
import { CreateSpaceDialog } from "./CreateSpaceDialog";
import { JoinSpaceDialog } from "./JoinSpaceDialog";
import { SpaceMark } from "./SpaceMark";

const OTHER = "other";

/**
 * `/spaces` (preview `P.spaces`): a handful of spaces fits on one screen (yours first, then the rest);
 * Mine + one tab per space type only pay off with many spaces.
 */
export function SpacesPage() {
  const { settings, can } = useWorkspace();
  const pathname = usePathname();
  const params = useSearchParams();
  const spaces = useSpaces();
  const mine = useMyJoinRequests();
  const [q, setQ] = useState("");
  const [creating, setCreating] = useState<{ type?: string } | null>(null);
  const [joining, setJoining] = useState<Space | null>(null);

  const types = spaceTypesOf(settings);
  const known = new Set(types.map((t) => t.key));
  const visible = spaces.data ?? [];
  const useTabs = visible.length >= TOOLS_MIN;
  const hasOther = visible.some((s) => !known.has(s.spaceType ?? ""));
  const tabList = [
    { id: "mine", label: "Mine" },
    ...types.map((t) => ({ id: t.key, label: t.plural })),
    ...(hasOther ? [{ id: OTHER, label: types.length ? "Other" : "All spaces" }] : []),
  ];
  const tab = useTabs && tabList.some((t) => t.id === params.get("tab")) ? params.get("tab")! : "mine";
  const canCreate = can("spaces.create");
  const manageAll = can("spaces.update");
  const order = types.map((t) => t.key);
  const rank = (s: Space) => (order.includes(s.spaceType ?? "") ? order.indexOf(s.spaceType ?? "") : order.length);
  const byName = (a: Space, b: Space) => Number(!!b.callerRole) - Number(!!a.callerRole) || (a.displayName ?? "").localeCompare(b.displayName ?? "");
  const yours = visible.filter((s) => !!s.callerRole).sort((a, b) => rank(a) - rank(b) || (a.displayName ?? "").localeCompare(b.displayName ?? ""));

  const all = !useTabs
    ? visible
    : tab === "mine"
      ? yours
      : visible.filter((s) => (tab === OTHER ? !known.has(s.spaceType ?? "") : s.spaceType === tab)).sort(byName);
  const needle = q.trim().toLowerCase();
  const match = (s: Space) => !needle || `${s.displayName} ${s.description ?? ""}`.toLowerCase().includes(needle);

  const openCreate = (type?: string) => setCreating({ type });
  const card = (s: Space, inMine: boolean) => (
    <SpaceCard
      key={s.name}
      space={s}
      type={spaceType(s.spaceType, settings)}
      inMine={inMine}
      manager={manageAll}
      requested={!!mine.data?.get(resourceId(s.name))}
      onJoin={() => setJoining(s)}
    />
  );
  const grid = (list: Space[], inMine: boolean) => <div className="grid cols-3">{list.map((s) => card(s, inMine))}</div>;

  function listEmpty(): ReactNode {
    if (tab === "mine") {
      const kinds = types.map((t) => t.plural.toLowerCase());
      const list = kinds.length > 1 ? `${kinds.slice(0, -1).join(", ")} and ${kinds[kinds.length - 1]}` : kinds[0];
      return (
        <EmptyState
          icon={Layers}
          boxed
          title="You’re not in any spaces yet"
          description={list ? `Spaces bring people, materials and work together by ${list}.` : "Spaces bring people, materials and work together."}
          actions={
            <>
              {canCreate ? (
                <Button variant="primary" onPress={() => openCreate()}>
                  <Plus aria-hidden />
                  Create space
                </Button>
              ) : null}
              {useTabs && types[0] ? (
                <NextLink href={`/spaces?tab=${types[0].key}`} className={buttonVariants({ variant: "tertiary" })}>
                  Browse {types[0].plural.toLowerCase()}
                </NextLink>
              ) : null}
            </>
          }
        />
      );
    }
    const t = spaceType(tab === OTHER ? "" : tab, settings);
    return (
      <EmptyState
        icon={t.icon}
        boxed
        title={`No ${t.plural.toLowerCase()} yet`}
        description={t.desc}
        actions={
          canCreate ? (
            <Button variant="primary" onPress={() => openCreate(tab)}>
              <Plus aria-hidden />
              Create {t.label.toLowerCase()}
            </Button>
          ) : null
        }
      />
    );
  }

  /** Without tabs: Your spaces, then Other spaces; while searching, only sections with matches show. */
  function sections(): ReactNode {
    const ids = new Set(yours.map((s) => s.name));
    const own = yours.filter(match);
    const others = visible.filter((s) => !ids.has(s.name)).sort(byName).filter(match);
    if (!own.length && !others.length) return <NoMatches what="spaces" onClear={() => setQ("")} />;
    const yoursBody = own.length ? (
      grid(own, true)
    ) : needle ? null : (
      <EmptyState icon={Layers} title="You’re not in any spaces yet" description="Open one below to ask to join or send a request." compact boxed />
    );
    return (
      <>
        {yoursBody ? <Section title="Your spaces">{yoursBody}</Section> : null}
        {others.length ? <Section title="Other spaces">{grid(others, false)}</Section> : null}
      </>
    );
  }

  let body: ReactNode;
  if (!all.length) body = listEmpty();
  else if (!useTabs) body = sections();
  else {
    const rows = all.filter(match);
    body = rows.length ? grid(rows, tab === "mine") : <NoMatches what="spaces" onClear={() => setQ("")} />;
  }

  return (
    <Page width="wide">
      <PageHeader
        title="Spaces"
        actions={
          canCreate ? (
            <Button variant="primary" onPress={() => openCreate(tab === "mine" || tab === OTHER ? undefined : tab)}>
              <Plus aria-hidden />
              Create space
            </Button>
          ) : null
        }
      >
        {useTabs ? <SectionTabs items={tabList} active={tab} base={pathname} /> : null}
      </PageHeader>
      {all.length >= TOOLS_MIN || q ? (
        <div className="toolbar">
          <SearchInput value={q} onChange={setQ} placeholder="Search spaces" />
        </div>
      ) : null}
      <Gate query={spaces} skeleton={<SkeletonCards cards={6} columns="cols-3" />}>
        {body}
      </Gate>
      <CreateSpaceDialog isOpen={!!creating} type={creating?.type} onClose={() => setCreating(null)} />
      <JoinSpaceDialog space={joining} onClose={() => setJoining(null)} />
    </Page>
  );
}

interface SpaceCardProps {
  space: Space;
  type: SpaceTypeDef;
  /** Shown in Mine / Your spaces: every card is a membership, so only roles that carry responsibility get a chip. */
  inMine: boolean;
  /** The caller manages every space as a workspace admin. */
  manager: boolean;
  requested: boolean;
  onJoin: () => void;
}

/** One space (preview `spaceCard`): the name is the link (stretched over the card); the call to action is a sibling above it. */
function SpaceCard({ space, type, inMine, manager, requested, onJoin }: SpaceCardProps) {
  const role = space.callerRole;
  const mode = joinMode(space, type);
  let cta: ReactNode = null;
  if (role) cta = !inMine || isStaffRole(role) ? <StatusChip label={roleLabel(type, role)} tone={isStaffRole(role) ? "accent" : "default"} size="sm" dot={false} /> : null;
  else if (manager) cta = <StatusChip label="Manager" tone="accent" size="sm" dot={false} tooltip="You can manage this space as a workspace admin" />;
  else if (mode === "enrolled") cta = <span className="sp-card__note">Enrolled through the student portal</span>;
  else if (mode === "open") cta = <SendRequestCta space={space} />;
  else if (requested) cta = <StatusChip label="Requested" tone="warning" icon={Clock} size="sm" />;
  else
    cta = (
      <Button size="sm" variant="tertiary" onPress={onJoin}>
        Request to join
      </Button>
    );
  return (
    <article className="card card--action sp-card">
      <div className="sp-card__top">
        <SpaceMark space={space} size={40} />
        <span className="sp-card__type">{type.label}</span>
      </div>
      <div className="stack gap-2">
        <NextLink className="sp-card__name sp-card__link truncate" href={`/space/${resourceId(space.name)}`} translate="no">
          {space.displayName}
        </NextLink>
      </div>
      <div className="sp-card__desc clamp-2" translate={space.description ? "no" : undefined}>
        {space.description || type.desc}
      </div>
      <div className="sp-card__foot">
        <span className="row gap-4">
          <Users className="i i-sm" aria-hidden />
          {plural(space.memberCount ?? 0, "member")}
        </span>
        {cta ? <span className="sp-card__cta">{cta}</span> : null}
      </div>
    </article>
  );
}

/** Offices: "Send a request" when the space has a request catalog. */
function SendRequestCta({ space }: { space: Space }) {
  const types = useRequestTypes(resourceId(space.name));
  if (!types.data?.length) return null;
  return (
    <NextLink href={`/requests/new?space=${resourceId(space.name)}`} className={buttonVariants({ size: "sm", variant: "tertiary" })}>
      <Send aria-hidden />
      Send a request
    </NextLink>
  );
}
