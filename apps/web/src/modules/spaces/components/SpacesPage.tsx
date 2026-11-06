"use client";

import { Button, buttonVariants } from "@heroui/react";
import { Clock, Layers, Plus, Send, Users } from "lucide-react";
import NextLink from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState, type KeyboardEvent, type MouseEvent } from "react";

import { PageChrome } from "@/components/shell/page-chrome";
import { EmptyState, Gate, NoMatches, Page, PageHeader, SearchInput, SectionTabs, SkeletonCards, StatusChip } from "@/components/ui";
import { resourceId } from "@/lib/api/client";
import { plural } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";

import { useMyJoinRequests, useRequestTypes, useSpaces } from "../queries";
import { isStaffRole, joinMode, roleLabel, spaceType, spaceTypesOf, type Space, type SpaceTypeDef } from "../types";
import { CreateSpaceDialog } from "./CreateSpaceDialog";
import { JoinSpaceDialog } from "./JoinSpaceDialog";
import { SpaceMark } from "./SpaceMark";

const OTHER = "other";

/** `/spaces` (preview `P.spaces`): Mine + one tab per space type, create, ask to join, send a request. */
export function SpacesPage() {
  const { settings, can } = useWorkspace();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const spaces = useSpaces();
  const mine = useMyJoinRequests();
  const [q, setQ] = useState("");
  const [creating, setCreating] = useState<{ type?: string } | null>(null);
  const [joining, setJoining] = useState<Space | null>(null);

  const types = spaceTypesOf(settings);
  const known = new Set(types.map((t) => t.key));
  const hasOther = (spaces.data ?? []).some((s) => !known.has(s.spaceType ?? ""));
  const tabList = [
    { id: "mine", label: "Mine" },
    ...types.map((t) => ({ id: t.key, label: t.plural })),
    ...(hasOther ? [{ id: OTHER, label: types.length ? "Other" : "All spaces" }] : []),
  ];
  const tab = tabList.some((t) => t.id === params.get("tab")) ? params.get("tab")! : "mine";
  const canCreate = can("spaces.create");
  const order = types.map((t) => t.key);
  const rank = (s: Space) => (order.includes(s.spaceType ?? "") ? order.indexOf(s.spaceType ?? "") : order.length);

  const all = (spaces.data ?? [])
    .filter((s) => (tab === "mine" ? !!s.callerRole : tab === OTHER ? !known.has(s.spaceType ?? "") : s.spaceType === tab))
    .sort((a, b) =>
      tab === "mine"
        ? rank(a) - rank(b) || (a.displayName ?? "").localeCompare(b.displayName ?? "")
        : Number(!!b.callerRole) - Number(!!a.callerRole) || (a.displayName ?? "").localeCompare(b.displayName ?? ""),
    );
  const needle = q.trim().toLowerCase();
  const rows = needle ? all.filter((s) => `${s.displayName} ${s.description ?? ""}`.toLowerCase().includes(needle)) : all;

  const openCreate = (type?: string) => setCreating({ type });
  const empty = () => {
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
              {types[0] ? (
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
  };

  return (
    <Page>
      <PageChrome crumbs={[{ label: "Spaces" }]} />
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
        <SectionTabs items={tabList} active={tab} base={pathname} />
      </PageHeader>
      {all.length > 3 || q ? (
        <div className="toolbar">
          <SearchInput value={q} onChange={setQ} placeholder="Search spaces" />
        </div>
      ) : null}
      <Gate query={spaces} skeleton={<SkeletonCards cards={6} columns="cols-3" />}>
        {!all.length ? (
          empty()
        ) : rows.length ? (
          <div className="grid cols-3">
            {rows.map((s) => (
              <SpaceCard
                key={s.name}
                space={s}
                type={spaceType(s.spaceType, settings)}
                requested={!!mine.data?.get(resourceId(s.name))}
                onOpen={() => router.push(`/space/${resourceId(s.name)}`)}
                onJoin={() => setJoining(s)}
              />
            ))}
          </div>
        ) : (
          <NoMatches what="spaces" onClear={() => setQ("")} />
        )}
      </Gate>
      <CreateSpaceDialog isOpen={!!creating} type={creating?.type} onClose={() => setCreating(null)} />
      <JoinSpaceDialog space={joining} onClose={() => setJoining(null)} />
    </Page>
  );
}

interface SpaceCardProps {
  space: Space;
  type: SpaceTypeDef;
  requested: boolean;
  onOpen: () => void;
  onJoin: () => void;
}

const stop = (e: MouseEvent | KeyboardEvent) => e.stopPropagation();

/** One space (preview `spaceCard`): mark, type, name, description, members and the caller's next step. */
function SpaceCard({ space, type, requested, onOpen, onJoin }: SpaceCardProps) {
  const role = space.callerRole;
  const mode = joinMode(space, type);
  let cta = null;
  if (role) cta = <StatusChip label={roleLabel(type, role)} tone={isStaffRole(role) ? "accent" : "default"} size="sm" dot={false} />;
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
    <div
      className="card card--action sp-card"
      role="link"
      tabIndex={0}
      aria-label={space.displayName}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter") onOpen();
      }}
    >
      <div className="sp-card__top">
        <SpaceMark space={space} size={40} />
        <span className="sp-card__type">{type.label}</span>
      </div>
      <div className="stack gap-2">
        <div className="sp-card__name truncate" translate="no">
          {space.displayName}
        </div>
      </div>
      <div className="sp-card__desc clamp-2" translate={space.description ? "no" : undefined}>
        {space.description || type.desc}
      </div>
      <div className="sp-card__foot">
        <span className="row gap-4">
          <Users className="i i-sm" aria-hidden />
          {plural(space.memberCount ?? 0, "member")}
        </span>
        {cta ? (
          <span onClick={stop} onKeyDown={stop}>
            {cta}
          </span>
        ) : null}
      </div>
    </div>
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
