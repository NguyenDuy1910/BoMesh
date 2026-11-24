"use client";

import { Users } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";

import { ClearFilters, EmptyState, ErrorState, FilterButton, List, NoMatches, Page, PageHeader, Pager, SearchInput, SectionTabs, SkeletonRows } from "@/components/ui";
import { resourceId } from "@/lib/api/client";
import { SEARCH_PAUSE_MS, useDebounced } from "@/lib/debounce";
import { plural } from "@/lib/format";
import { useMessages } from "@/lib/i18n";
import { useWorkspace } from "@/lib/workspace";
import { useMemberNames } from "@/modules/knowledge/queries";
import { useSpaces } from "@/modules/spaces";

import { isSpaceStaff, kindMeta, WORK_KINDS, workflowsFor } from "../kinds";
import type { Artifact } from "../model";
import { useWorkCount, useWorkList, WORK_PAGE } from "../queries";
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
  const { settings, hasModule } = useWorkspace();
  const spacesQuery = useSpaces();
  const spaces = useMemo(() => spacesQuery.data ?? [], [spacesQuery.data]);
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

  const mineCount = useWorkCount("mine");
  const sharedCount = useWorkCount("shared");
  /* "Shared with me" only earns a tab once something has been shared. */
  const showTabs = !!sharedCount.data || params.get("tab") === "shared";
  const tab = showTabs && params.get("tab") === "shared" ? "shared" : "mine";
  const tabCount = (tab === "mine" ? mineCount : sharedCount).data ?? 0;
  /* Newest first: the order people come back to work in. Search matches titles on the server. */
  const list = useWorkList({ tab, kind, space, q: useDebounced(q.trim(), SEARCH_PAUSE_MS) });
  const rows = list.data?.artifacts ?? [];
  const spaceOf = (a: Artifact) => (a.space ? spaces.find((s) => s.name === a.space) : undefined);
  const owners = useMemberNames(tab === "shared" ? rows.map((a) => a.owner) : []);

  const kindOpts = Object.keys(WORK_KINDS).map((k) => ({ value: k, label: kindMeta(k).label }));
  const spaceOpts = spaces.filter((s) => s.callerRole).map((s) => ({ value: resourceId(s.name), label: s.displayName ?? resourceId(s.name) }));
  const filtering = !!(q || kind || space);
  const tools = tabCount >= TOOLS_MIN || filtering;
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
      <SearchInput value={q} onChange={search} placeholder="Tìm kiếm công việc" label="Tìm kiếm công việc" />
      {kindOpts.length > 1 ? <FilterButton label="Loại" options={kindOpts} value={kind} onChange={(v) => setParam({ kind: v })} /> : null}
      {spaceOpts.length > 1 && hasModule("spaces") ? <FilterButton label="Cộng đồng" options={spaceOpts} value={space} onChange={(v) => setParam({ space: v })} /> : null}
      <ClearFilters isActive={!!(kind || space)} onClear={() => setParam({ kind: "", space: "" })} />
      {/* The tab (or the list itself) already shows how many there are; a count only helps while filtering. */}
      {filtering ? <span className="toolbar__end t-sm muted num">{plural(list.total ?? rows.length, "item")}</span> : null}
    </div>
  ) : null;

  let body: React.ReactNode;
  if (list.isPending || (tab === "mine" ? mineCount : sharedCount).isPending || (!tabCount && !flowsReady)) body = <SkeletonRows rows={5} />;
  else if (list.isError) body = <ErrorState error={list.error} onRetry={() => void list.refetch()} />;
  else if (!tabCount && !rows.length)
    body =
      tab === "mine" ? (
        <FirstRun flows={flows} />
      ) : (
        <EmptyState icon={Users} title="Chưa có gì được chia sẻ với bạn" description="Bài kiểm tra, hướng dẫn và bài ôn tập được chia sẻ vào cộng đồng của bạn sẽ xuất hiện ở đây." boxed />
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
          <NoMatches what="công việc" onClear={clear} />
        )}
        {list.page > 1 || list.hasNext ? <Pager page={list.page} pageSize={WORK_PAGE} total={list.total} hasNext={list.hasNext} onPageChange={list.setPage} /> : null}
      </>
    );

  return (
    <Page width="wide">
      <PageHeader title={m.nav.work} actions={flowsReady && flows.length ? <NewWorkMenu flows={flows} /> : null}>
        {showTabs ? (
          <SectionTabs
            items={[
              { id: "mine", label: "Của tôi", count: mineCount.data || null },
              { id: "shared", label: "Được chia sẻ với tôi", count: sharedCount.data || null },
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
