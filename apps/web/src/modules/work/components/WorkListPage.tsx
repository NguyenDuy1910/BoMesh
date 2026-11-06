"use client";

import { Users } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";

import { PageChrome } from "@/components/shell/page-chrome";
import {
  ClearFilters,
  DataTable,
  EmptyState,
  ErrorState,
  FilterButton,
  NoMatches,
  Page,
  PageHeader,
  SearchInput,
  SectionTabs,
  SkeletonRows,
  UserAvatar,
  type DataTableColumn,
} from "@/components/ui";
import { resourceId } from "@/lib/api/client";
import { plural, rel } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";
import { useMemberNames } from "@/modules/knowledge/queries";
import { useSpaces } from "@/modules/spaces";

import { isSpaceStaff, kindMeta, workflowsFor } from "../kinds";
import { isOwnerOf, workSummary, type Artifact } from "../model";
import { useWorkList } from "../queries";
import { SpaceTag, WorkStatusChip, WorkTile } from "./parts";
import { FirstRun, NewWorkMenu } from "./WorkFlows";

/** `/work` — my AI-made work (preview `P.work`). */
export function WorkListPage() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const { settings, member, hasModule } = useWorkspace();
  const spacesQuery = useSpaces();
  const spaces = useMemo(() => spacesQuery.data ?? [], [spacesQuery.data]);
  const list = useWorkList();
  const flows = workflowsFor(settings, null, { mySpaces: spaces.filter((s) => s.callerRole), spacesOn: hasModule("spaces") });

  const tab = params.get("tab") === "shared" ? "shared" : "mine";
  /** Typed text lives in state (the URL only mirrors it): binding the input to the URL dropped keystrokes. */
  const [q, setQ] = useState(() => params.get("q") ?? "");
  const kind = params.get("kind") ?? "";
  const space = params.get("space") ?? "";
  const setParam = (patch: Record<string, string>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    const s = next.toString();
    router.replace(s ? `${pathname}?${s}` : pathname, { scroll: false });
  };

  const all = useMemo(() => list.data ?? [], [list.data]);
  const mine = all.filter((a) => isOwnerOf(a, member.name ?? ""));
  const shared = all.filter((a) => !isOwnerOf(a, member.name ?? ""));
  const src = tab === "mine" ? mine : shared;
  const spaceOf = (a: Artifact) => (a.space ? spaces.find((s) => s.name === a.space) : undefined);
  const owners = useMemberNames(shared.map((a) => a.owner));

  const kindOpts = [...new Set(all.map((a) => a.kind ?? ""))].map((k) => ({ value: k, label: kindMeta(k).label }));
  const spaceOpts = [...new Set(all.map((a) => a.space).filter((s): s is string => !!s))].map((s) => ({ value: resourceId(s), label: spaces.find((x) => x.name === s)?.displayName ?? resourceId(s) }));
  const needle = q.trim().toLowerCase();
  const rows = src.filter(
    (a) =>
      (!needle || [a.displayName, workSummary(a), spaceOf(a)?.displayName].some((t) => t?.toLowerCase().includes(needle))) &&
      (!kind || a.kind === kind) &&
      (!space || resourceId(a.space) === space),
  );
  const filtered = !!(q || kind || space);
  const search = (v: string) => {
    setQ(v);
    setParam({ q: v });
  };
  const clear = () => {
    setQ("");
    setParam({ q: "", kind: "", space: "" });
  };

  const columns: DataTableColumn<Artifact>[] = [
    {
      id: "title",
      header: "Name",
      primary: true,
      sortValue: (a) => (a.displayName ?? "").toLowerCase(),
      cell: (a) => (
        <div className="work-name">
          <WorkTile kind={a.kind} size="sm" />
          <div className="work-name__text">
            <span className="medium truncate" translate="no">
              {a.displayName}
            </span>
            <span className="t-xs muted truncate">{workSummary(a)}</span>
          </div>
        </div>
      ),
    },
    {
      id: "space",
      header: "Space",
      cell: (a) => {
        const sp = spaceOf(a);
        return sp ? <SpaceTag space={sp} /> : <span className="muted">—</span>;
      },
    },
    { id: "status", header: "Status", cell: (a) => <WorkStatusChip artifact={a} staffQuiz={isSpaceStaff(spaceOf(a))} /> },
    { id: "updated", header: "Updated", sortValue: (a) => a.updateTime ?? "", cell: (a) => <span className="t-sm muted num">{rel(a.updateTime)}</span> },
    ...(tab === "shared"
      ? [
          {
            id: "owner",
            header: "Owner",
            hideOnMobile: true,
            cell: (a: Artifact) => {
              const name = owners.get(a.owner ?? "") ?? "";
              return (
                <div className="work-owner">
                  <UserAvatar name={name} size="xs" />
                  <span className="t-sm truncate">{name}</span>
                </div>
              );
            },
          } satisfies DataTableColumn<Artifact>,
        ]
      : []),
  ];

  let body: React.ReactNode;
  if (list.isPending) body = <SkeletonRows rows={5} />;
  else if (list.isError) body = <ErrorState error={list.error} onRetry={() => void list.refetch()} />;
  else if (!src.length)
    body =
      tab === "mine" ? (
        <FirstRun flows={flows} />
      ) : (
        <EmptyState icon={Users} title="Nothing shared with you yet" description="Quizzes, guides and reviews people share to your spaces show up here." boxed />
      );
  else
    body = (
      <>
        <div className="toolbar">
          <SearchInput value={q} onChange={search} placeholder="Search work" label="Search work" />
          {kindOpts.length > 1 ? <FilterButton label="Type" options={kindOpts} value={kind} onChange={(v) => setParam({ kind: v })} /> : null}
          {spaceOpts.length > 1 && hasModule("spaces") ? <FilterButton label="Space" options={spaceOpts} value={space} onChange={(v) => setParam({ space: v })} /> : null}
          <ClearFilters isActive={!!(kind || space)} onClear={() => setParam({ kind: "", space: "" })} />
          <span className="toolbar__end t-sm muted num">{plural(rows.length, "item")}</span>
        </div>
        {rows.length ? (
          <DataTable
            label="Work"
            rows={rows}
            columns={columns}
            getRowId={(a) => a.name ?? ""}
            defaultSort={{ column: "updated", direction: "descending" }}
            rowHref={(a) => `/work/${resourceId(a.name)}`}
          />
        ) : (
          <NoMatches what="work" onClear={filtered ? clear : undefined} />
        )}
      </>
    );

  return (
    <Page>
      <PageChrome crumbs={[{ label: "Work" }]} />
      <PageHeader title="Work" actions={flows.length ? <NewWorkMenu flows={flows} /> : null} />
      <div className="page-tabs">
        <SectionTabs
          items={[
            { id: "mine", label: "Mine", count: mine.length || null },
            { id: "shared", label: "Shared with me", count: shared.length || null },
          ]}
          active={tab}
          base="/work"
        />
      </div>
      {body}
    </Page>
  );
}
