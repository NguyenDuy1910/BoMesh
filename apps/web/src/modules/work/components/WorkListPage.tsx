"use client";

import { Users } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";

import { ClearFilters, EmptyState, ErrorState, FilterButton, List, NoMatches, Page, PageHeader, SearchInput, SectionTabs, SkeletonRows } from "@/components/ui";
import { resourceId } from "@/lib/api/client";
import { plural } from "@/lib/format";
import { useMessages } from "@/lib/i18n";
import { useWorkspace } from "@/lib/workspace";
import { useMemberNames } from "@/modules/knowledge/queries";
import { useSpaces } from "@/modules/spaces";

import { isSpaceStaff, kindMeta, workflowsFor } from "../kinds";
import { isOwnerOf, workSummary, type Artifact } from "../model";
import { useWorkList } from "../queries";
import { FirstRun, NewWorkMenu } from "./WorkFlows";
import { WorkItemRow } from "./WorkItemRow";

/** List tools (search, filters) appear from this many items, or while one is in use (preview `needsTools`). */
const TOOLS_MIN = 7;

/** `/work` — my AI-made work (preview `P.work`): Mine · Shared with me are views of one list. */
export function WorkListPage() {
  const m = useMessages();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const { settings, member, hasModule } = useWorkspace();
  const spacesQuery = useSpaces();
  const spaces = useMemo(() => spacesQuery.data ?? [], [spacesQuery.data]);
  const list = useWorkList();
  const flows = workflowsFor(settings, null, { mySpaces: spaces.filter((s) => s.callerRole), spacesOn: hasModule("spaces") });
  // Space workflows (quiz, review) depend on my spaces: until they load, "New" would flash as the lone Draft button.
  const flowsReady = !hasModule("spaces") || !spacesQuery.isPending;

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

  /* Newest first: the order people come back to work in. */
  const all = useMemo(() => [...(list.data ?? [])].sort((a, b) => (b.updateTime ?? "").localeCompare(a.updateTime ?? "")), [list.data]);
  const me = member.name ?? "";
  const mine = all.filter((a) => isOwnerOf(a, me));
  const shared = all.filter((a) => !isOwnerOf(a, me));
  /* "Shared with me" only earns a tab once something has been shared. */
  const showTabs = shared.length > 0 || params.get("tab") === "shared";
  const tab = showTabs && params.get("tab") === "shared" ? "shared" : "mine";
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
  const filtering = !!(q || kind || space);
  const tools = src.length >= TOOLS_MIN || filtering;
  const search = (v: string) => {
    setQ(v);
    setParam({ q: v });
  };
  const clear = () => {
    setQ("");
    setParam({ q: "", kind: "", space: "" });
  };

  const toolbar = tools ? (
    <div className="toolbar">
      <SearchInput value={q} onChange={search} placeholder="Search work" label="Search work" />
      {kindOpts.length > 1 ? <FilterButton label="Type" options={kindOpts} value={kind} onChange={(v) => setParam({ kind: v })} /> : null}
      {spaceOpts.length > 1 && hasModule("spaces") ? <FilterButton label="Space" options={spaceOpts} value={space} onChange={(v) => setParam({ space: v })} /> : null}
      <ClearFilters isActive={!!(kind || space)} onClear={() => setParam({ kind: "", space: "" })} />
      {/* The tab (or the list itself) already shows how many there are; a count only helps while filtering. */}
      {filtering ? <span className="toolbar__end t-sm muted num">{plural(rows.length, "item")}</span> : null}
    </div>
  ) : null;

  let body: React.ReactNode;
  if (list.isPending || (!src.length && !flowsReady)) body = <SkeletonRows rows={5} />;
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
        {toolbar}
        {rows.length ? (
          <List className="work-list">
            {rows.map((a) => {
              const sp = spaceOf(a);
              return (
                <WorkItemRow
                  key={a.name}
                  artifact={a}
                  spaceName={sp?.displayName}
                  ownerName={tab === "shared" ? owners.get(a.owner ?? "") || undefined : undefined}
                  staffQuiz={isSpaceStaff(sp)}
                />
              );
            })}
          </List>
        ) : (
          <NoMatches what="work" onClear={clear} />
        )}
      </>
    );

  return (
    <Page width="wide">
      <PageHeader title={m.nav.work} actions={flowsReady && flows.length ? <NewWorkMenu flows={flows} /> : null}>
        {showTabs ? (
          <SectionTabs
            items={[
              { id: "mine", label: "Mine", count: mine.length || null },
              { id: "shared", label: "Shared with me", count: shared.length || null },
            ]}
            active={tab}
            base="/work"
          />
        ) : null}
      </PageHeader>
      {body}
    </Page>
  );
}
