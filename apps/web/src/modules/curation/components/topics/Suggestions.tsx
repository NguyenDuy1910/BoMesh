"use client";

import { Tag } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

import { ClearFilters, DataTable, EmptyState, ErrorState, FilterButton, NoMatches, Pager, SearchInput, Section, SkeletonRows, type DataTableSort } from "@/components/ui";
import { fmtDateTime, rel } from "@/lib/format";
import type { Item } from "@/modules/knowledge/api";
import { useKnowledgeModel } from "@/modules/knowledge/queries";

import type { Topic } from "../../api";
import { useHeldDecisions } from "../../decisions";
import { assistantTaggedFilter, nameSearch, withoutTopicFilter } from "../../docFilter";
import { correctionSuggestions } from "../../governance";
import { useAssistantTaggedCounts, useDocScope, useItemPages, useOpenTopicCorrections } from "../../queries";
import { useDocDrawer } from "../review/useDocDrawer";
import { DocCell, orderByOf, TopicMenu, useApplyTopic, useLiveSelection } from "../shared";
import { CorrectionCard } from "./Corrections";
import { ProposedList } from "./Proposed";
import { ConfirmCard, confirmKey, type ConfirmGroup } from "./ToConfirm";

const PAGE = 20;

/**
 * Topics → Suggestions (preview `X.gov.suggestions`), biggest decisions first: a topic to create files every document
 * that mentions it, a keyword from corrections re-files what reviewers keep moving, a group confirms many at once, then
 * documents one by one. Each section shows only when it has something. `proposals` excludes held decisions. Documents
 * are the collections the caller looks after: one facet read counts every topic to confirm (a card reads its sample when
 * it comes near the view), and Without a topic reads server pages.
 */
export function TopicSuggestions({ proposals, topics }: { proposals: readonly Topic[]; topics: readonly Topic[] }) {
  const corrections = useOpenTopicCorrections();
  const docScope = useDocScope();
  const scope = docScope.scope;
  const held = useHeldDecisions();
  const active = useMemo(() => topics.filter((t) => t.kind === "TOPIC" && t.state === "ACTIVE"), [topics]);
  const tagged = useAssistantTaggedCounts(scope);
  // Without a topic's first page (the list reads the same page): whether the section shows.
  const loose = useItemPages(withoutTopicFilter(scope), orderByOf(null), { pageSize: PAGE, enabled: scope.length > 0 });

  const learn = useMemo(() => correctionSuggestions((corrections.data ?? []).filter((c) => !held.has(c.name ?? "")), topics), [corrections.data, held, topics]);
  const groups: ConfirmGroup[] = active
    .map((topic) => ({ topic, n: tagged.data?.get(topic.name ?? "") ?? 0, filter: assistantTaggedFilter(scope, topic.name ?? "") }))
    .filter((g) => g.n > 0 && !held.has(confirmKey(g.topic.name ?? "")))
    .sort((a, b) => b.n - a.n || (a.topic.displayName ?? "").localeCompare(b.topic.displayName ?? ""));
  const docRead = { isError: docScope.isError || loose.isError, error: docScope.error ?? loose.error, refetch: () => (docScope.isError ? docScope.refetch() : loose.refetch()) };
  const hasLoose = (loose.total ?? loose.items.length) > 0;

  if (corrections.isPending || docScope.isPending || (scope.length > 0 && (tagged.isPending || loose.isPending))) return <SkeletonRows rows={6} />;

  const failed = (q: { isError: boolean; error: unknown; refetch: () => unknown }) => (q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} compact /> : null);
  if (!proposals.length && !learn.length && !groups.length && !hasLoose && !corrections.isError && !tagged.isError && !docRead.isError) {
    return (
      <EmptyState
        icon={Tag}
        tone="success"
        title="Không có gợi ý"
        description="Tài liệu trợ lý chưa gắn chủ đề, chủ đề mới trợ lý đề xuất và từ khóa từ các lần sửa của người duyệt sẽ hiển thị ở đây."
        boxed
      />
    );
  }

  return (
    <div className="kh gov gov--classify">
      {proposals.length ? (
        <Section title="Chủ đề mới do trợ lý đề xuất" description="Nhiều tài liệu nhắc đến nhưng chưa chủ đề nào bao quát. Chấp nhận sẽ thêm chủ đề và gắn chủ đề cho các tài liệu đó.">
          <ProposedList proposals={proposals} topics={topics} />
        </Section>
      ) : null}
      {learn.length || corrections.isError ? (
        <Section
          title="Từ khóa từ các lần sửa của người duyệt"
          description="Khi người duyệt chuyển tài liệu sang chủ đề khác, các từ chung trong tiêu đề sẽ thành từ khóa đề xuất. Không có gì thay đổi cho đến khi bạn thêm."
        >
          {failed(corrections) ?? (
            <ul className="md-learns">
              {learn.map((s) => (
                <CorrectionCard key={s.topic.name} s={s} topics={topics} />
              ))}
            </ul>
          )}
        </Section>
      ) : null}
      {groups.length || tagged.isError ? (
        <Section title="Chủ đề cần xác nhận" description="Trợ lý đã gắn các chủ đề này khi xử lý tài liệu. Hãy xác nhận hàng loạt.">
          {failed(tagged) ?? (
            <div className="cg-list">
              {groups.map((g) => (
                <ConfirmCard key={g.topic.name} g={g} topics={topics} />
              ))}
            </div>
          )}
        </Section>
      ) : null}
      {hasLoose || docRead.isError ? (
        <Section title="Chưa có chủ đề" description="Đã xử lý nhưng trợ lý chưa gắn chủ đề nào.">
          {failed(docRead) ?? <WithoutTopic scope={scope} bases={docScope.bases} />}
        </Section>
      ) : null}
    </div>
  );
}

/**
 * Without a topic (preview `tabDetails` for topic gaps): Add topic per row, Apply topic to a selection; Undo on the
 * toast. One server page at a time: search and Collection are the filter, Document and Updated the server's order.
 */
function WithoutTopic({ scope, bases }: { scope: readonly string[]; bases: readonly Item[] }) {
  const applyTopic = useApplyTopic();
  const drawer = useDocDrawer();
  const { toResource } = useKnowledgeModel();
  const [q, setQ] = useState("");
  const [kb, setKb] = useState("");
  const [sort, setSort] = useState<DataTableSort | null>(null);
  const filter = [withoutTopicFilter(kb ? [kb] : scope), nameSearch(q)].filter(Boolean).join(" AND ");
  const list = useItemPages(filter, orderByOf(sort), { pageSize: PAGE });
  const rows = list.items.map((it) => toResource(it));
  const [selected, setSelected] = useLiveSelection(rows.map((r) => r.id));

  const kbOpts = bases.map((b) => ({ value: b.name ?? "", label: b.displayName || "Kho tài liệu" })).sort((a, b) => a.label.localeCompare(b.label));
  const clear = () => {
    setQ("");
    setKb("");
  };

  const toolbar =
    (list.total ?? 0) > 6 || q || kb ? (
      <div className="toolbar">
        <SearchInput value={q} onChange={setQ} placeholder="Tìm kiếm tài liệu" />
        {kbOpts.length > 1 || kb ? <FilterButton label="Kho tài liệu" options={kbOpts} value={kb} onChange={setKb} /> : null}
        <ClearFilters isActive={!!kb} onClear={clear} />
      </div>
    ) : null;

  let body: ReactNode;
  if (list.isPending) body = <SkeletonRows rows={6} />;
  else if (list.isError) body = <ErrorState error={list.error} onRetry={() => void list.refetch()} compact />;
  else if (!rows.length) body = <NoMatches what="tài liệu" onClear={clear} />;
  else
    body = (
      <DataTable
        label="Chưa có chủ đề"
        rows={rows}
        getRowId={(r) => r.id}
        sort={sort}
        onSortChange={setSort}
        selectedIds={selected}
        onSelectionChange={setSelected}
        rowLabel={(r) => r.title}
        onRowAction={(r) => drawer.open(r.item)}
        columns={[
          { id: "name", header: "Tài liệu", primary: true, sortValue: (r) => r.title, cell: (r) => <DocCell r={r} /> },
          {
            id: "updated",
            header: "Đã cập nhật",
            hideOnMobile: true,
            className: "muted res-nowrap",
            sortValue: (r) => Date.parse(r.updated ?? "") || 0,
            cell: (r) => <span title={fmtDateTime(r.updated)}>{rel(r.updated)}</span>,
          },
        ]}
        rowActionLead={(r) => <TopicMenu label="Thêm chủ đề" variant="tertiary" chevron onPick={(t) => void applyTopic([r], t)} />}
        bulkActions={(ids, done) => (
          <TopicMenu
            label="Áp dụng chủ đề"
            variant="ghost"
            chevron
            onPick={(t) =>
              void applyTopic(
                rows.filter((r) => ids.includes(r.id)),
                t,
                done,
              )
            }
          />
        )}
        footer={<Pager page={list.page} pageSize={PAGE} total={list.total} pageCount={rows.length} hasNext={list.hasNext} onPageChange={list.setPage} />}
      />
    );

  return (
    <>
      {toolbar}
      {body}
      {drawer.node}
    </>
  );
}
