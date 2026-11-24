"use client";

import { Button } from "@heroui/react";
import { Pencil, Upload } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { FileIcon } from "@/components/ui/FileIcon";
import { List, ListItem } from "@/components/ui/List";
import { NoMatches } from "@/components/ui/NoMatches";
import { Page } from "@/components/ui/Page";
import { Pager } from "@/components/ui/Pager";
import { PageHeader } from "@/components/ui/PageHeader";
import { SearchInput } from "@/components/ui/SearchInput";
import { Segmented } from "@/components/ui/Segmented";
import { SkeletonRows } from "@/components/ui/SkeletonRows";
import { SEARCH_PAUSE_MS, useDebounced } from "@/lib/debounce";
import { fmtNum } from "@/lib/format";
import { useMessages } from "@/lib/i18n";
import { useWorkspace } from "@/lib/workspace";

import { quote } from "../../api";
import { ContributeButton } from "../../components/KnowledgeHeader";
import { LifecycleChip } from "../../components/LifecycleChip";
import { ResDot } from "../../components/ResourceRow";
import { CTB_GROUPS, eventLine, type ContributionGroup } from "../contributions";
import { LIBRARY_PAGE, useMyContributionCounts, useMyContributionPage } from "../queries";
import { useRemovingContributions } from "../useContributionActions";
import { useContributionViews } from "../useContributionViews";
import { ContributionDrawer } from "./ContributionDrawer";
import { needsTools } from "./parts";

/**
 * My contributions (`/contributions`, preview `P.contributions`): what the member shared, where it stands and
 * what to do next, one server page of a group at a time (search matches the document name). `?open=<id>` (Home,
 * the bell, the Reader, the submit toast) opens that contribution once.
 */
export function ContributionsPage() {
  const { can } = useWorkspace();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const removing = useRemovingContributions();
  const [seg, setSeg] = useState<ContributionGroup>("all");
  const m = useMessages();
  const [q, setQ] = useState("");
  const term = useDebounced(q, SEARCH_PAUSE_MS).trim().replace(/\*/g, "");
  const query = useMyContributionPage(seg, term ? `itemDisplayName = ${quote(`*${term}*`)}` : "");
  const counts = useMyContributionCounts();
  const [open, setOpen] = useState<{ id: string; revise?: boolean } | null>(null);
  const canContribute = can("contributions.create");

  // ?open=<id> opens that contribution once, then leaves the address clean.
  const requested = params.get("open");
  useEffect(() => {
    if (!requested) return;
    setOpen({ id: requested });
    const next = new URLSearchParams(params.toString());
    next.delete("open");
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [requested, params, pathname, router]);

  const list = useMemo(() => (query.data?.contributions ?? []).filter((c) => !removing.has(c.name ?? "")), [query.data, removing]);
  const views = useContributionViews(list);
  const rows = useMemo(() => list.map(views.view), [list, views.view]);
  const everything = counts.all ?? query.data?.totalSize ?? rows.length;

  const drawer = open ? <ContributionDrawer key={open.id} id={open.id} focusRevise={open.revise} onClose={() => setOpen(null)} /> : null;

  let body;
  if (query.isError && !query.data) body = <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  else if (query.isPending || (views.isPending && list.length && !rows.some((v) => v.candidate || v.revised))) body = <SkeletonRows rows={4} />;
  else if (!everything && seg === "all" && !term) {
    body = (
      <EmptyState
        icon={Upload}
        title="Chưa có tài liệu đã gửi"
        description={
          canContribute
            ? "Chia sẻ tài liệu với nhóm. Bạn kiểm tra đề xuất của trợ lý, sau đó người duyệt sẽ công bố."
            : "Tài liệu bạn chia sẻ với nhóm sẽ hiển thị ở đây, kèm tình trạng hiện tại."
        }
        boxed
      />
    );
  } else {
    // One filter per state a contribution can be in (counts only where there is something); search earns its place on a long list.
    const options = CTB_GROUPS.map(([id]) => {
      const n = id === "all" ? 0 : (counts[id] ?? 0);
      const label = m.knowledge.contributionGroups[id];
      return { value: id, label: n ? `${label} · ${fmtNum(n)}` : label };
    });
    body = (
      <>
        <div className="toolbar lib-bar">
          <div className="lib-ctb-seg">
            <Segmented value={seg} label="Hiển thị" onChange={setSeg} options={options} />
          </div>
          {needsTools(everything, q) ? <SearchInput value={q} onChange={setQ} placeholder="Tìm tài liệu đã gửi" /> : null}
        </div>
        {rows.length ? (
          <>
            <List className="lib-list">
              {rows.map((v) => (
                <ListItem
                  key={v.id}
                  className="lib-ctb"
                  lead={<FileIcon name={v.fileName} mime={v.mime} />}
                  title={v.title}
                  contentTitle
                  titleExtra={<LifecycleChip lifecycle={v.life} size="sm" />}
                  description={
                    <span className="lib-ctb__desc">
                      {/* No collection yet (the assistant suggests one): the event says where it stands. */}
                      {v.base ? (
                        <>
                          <span className="lib-ctb__kb" translate="no">
                            {v.base}
                          </span>
                          <ResDot />
                        </>
                      ) : null}
                      <span className="truncate">{eventLine(v.contribution, v.ctx)}</span>
                    </span>
                  }
                  // The one row action, only when it waits on the member; everything else is in its panel.
                  actions={
                    v.life === "changes" ? (
                      <Button size="sm" variant="secondary" onPress={() => setOpen({ id: v.id, revise: true })}>
                        <Pencil className="i" aria-hidden />
                        Sửa đổi
                      </Button>
                    ) : null
                  }
                  onPress={() => setOpen({ id: v.id })}
                />
              ))}
            </List>
            {query.hasNext || query.page > 1 ? (
              <Pager page={query.page} pageSize={LIBRARY_PAGE} total={query.total} pageCount={list.length} hasNext={query.hasNext} onPageChange={query.setPage} />
            ) : null}
          </>
        ) : (
          <NoMatches
            what="bài gửi"
            onClear={() => {
              setQ("");
              setSeg("all");
            }}
          />
        )}
      </>
    );
  }

  return (
    <Page width="wide" className="lib">
      <PageHeader title={m.nav.myContributions} actions={canContribute ? <ContributeButton variant="primary" /> : null} />
      {body}
      {drawer}
    </Page>
  );
}
