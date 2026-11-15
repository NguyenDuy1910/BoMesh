"use client";

import { Tag } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

import { ClearFilters, DataTable, EmptyState, ErrorState, FilterButton, NoMatches, Pager, paginate, SearchInput, Section, SkeletonRows, type DataTableSort } from "@/components/ui";
import { fmtDateTime, rel } from "@/lib/format";
import type { Resource } from "@/modules/knowledge/model";
import { useKnowledgeModel } from "@/modules/knowledge/queries";

import type { Topic } from "../../api";
import { useHeldDecisions } from "../../decisions";
import { confirmGroups, correctionSuggestions, matches } from "../../governance";
import { useAssistantTaggedDocuments, useDocumentsWithoutTopic, useOpenTopicCorrections } from "../../queries";
import { useDocDrawer } from "../review/useDocDrawer";
import { DocCell, sortRows, TopicMenu, useApplyTopic, useLiveSelection } from "../shared";
import { CorrectionCard } from "./Corrections";
import { ProposedList } from "./Proposed";
import { ConfirmCard, confirmKey } from "./ToConfirm";

const PAGE = 20;

/**
 * Topics → Suggestions (preview `X.gov.suggestions`), biggest decisions first: a topic to create files every document
 * that mentions it, a keyword from corrections re-files what reviewers keep moving, a group confirms many at once, then
 * documents one by one. Each section shows only when it has something. `proposals` excludes held decisions.
 */
export function TopicSuggestions({ proposals, topics }: { proposals: readonly Topic[]; topics: readonly Topic[] }) {
  const corrections = useOpenTopicCorrections();
  const tagged = useAssistantTaggedDocuments();
  const loose = useDocumentsWithoutTopic();
  const held = useHeldDecisions();
  const { toResource } = useKnowledgeModel();

  const learn = useMemo(() => correctionSuggestions((corrections.data ?? []).filter((c) => !held.has(c.name ?? "")), topics), [corrections.data, held, topics]);
  // Only documents the caller can edit: confirming narrows to those server-side.
  const groups = useMemo(
    () => confirmGroups((tagged.data ?? []).filter((it) => it.access === "EDITOR" || it.access === "OWNER"), topics).filter((g) => !held.has(confirmKey(g.topic.name ?? ""))),
    [tagged.data, held, topics],
  );
  const rows = useMemo(() => (loose.data ?? []).map((it) => toResource(it)).filter((r) => r.editable && !r.isPersonal && !r.deleted), [loose.data, toResource]);

  if (corrections.isPending || tagged.isPending || loose.isPending) return <SkeletonRows rows={6} />;

  const failed = (q: { isError: boolean; error: unknown; refetch: () => unknown }) => (q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} compact /> : null);
  if (!proposals.length && !learn.length && !groups.length && !rows.length && !corrections.isError && !tagged.isError && !loose.isError) {
    return (
      <EmptyState
        icon={Tag}
        tone="success"
        title="No suggestions"
        description="Documents the assistant gave no topic, new topics it proposes and keywords from reviewers’ corrections show up here."
        boxed
      />
    );
  }

  return (
    <div className="kh gov gov--classify">
      {proposals.length ? (
        <Section title="New topics the assistant proposes" description="Documents keep mentioning them and no topic covers them. Accepting adds the topic and tags those documents.">
          <ProposedList proposals={proposals} topics={topics} />
        </Section>
      ) : null}
      {learn.length || corrections.isError ? (
        <Section
          title="Keywords from reviewers’ corrections"
          description="When reviewers move documents to another topic, the words their titles share are keyword candidates. Nothing changes until you add one."
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
        <Section title="Topics to confirm" description="The assistant applied these topics when it processed the documents. Confirm them in bulk.">
          {failed(tagged) ?? (
            <div className="cg-list">
              {groups.map((g) => (
                <ConfirmCard key={g.topic.name} g={g} topics={topics} />
              ))}
            </div>
          )}
        </Section>
      ) : null}
      {rows.length || loose.isError ? (
        <Section title="Without a topic" description="Processed, but the assistant gave them no topic.">
          {failed(loose) ?? <WithoutTopic all={rows} />}
        </Section>
      ) : null}
    </div>
  );
}

/** Without a topic (preview `tabDetails` for topic gaps): Add topic per row, Apply topic to a selection; Undo on the toast. */
function WithoutTopic({ all }: { all: readonly Resource[] }) {
  const applyTopic = useApplyTopic();
  const drawer = useDocDrawer();
  const [q, setQ] = useState("");
  const [kb, setKb] = useState("");
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<DataTableSort | null>(null);
  const [selected, setSelected] = useLiveSelection(all.map((r) => r.id));

  const kbOpts = [...new Map(all.map((r) => [r.base?.name ?? "", r.base?.displayName ?? ""])).entries()].sort((a, b) => a[1].localeCompare(b[1])).map(([value, label]) => ({ value, label }));
  const filtered = all.filter((r) => (!kb || r.base?.name === kb) && matches(q, r.title, r.base?.displayName));
  const rows = sortRows(filtered, sort, { name: (r) => r.title.toLowerCase(), updated: (r) => Date.parse(r.updated ?? "") || 0 });
  const clear = () => {
    setQ("");
    setKb("");
    setPage(1);
  };
  const reset = (set: (v: string) => void) => (v: string) => {
    set(v);
    setPage(1);
  };

  const toolbar =
    all.length > 6 || q || kb ? (
      <div className="toolbar">
        <SearchInput value={q} onChange={reset(setQ)} placeholder="Search documents" />
        {kbOpts.length > 1 || kb ? <FilterButton label="Collection" options={kbOpts} value={kb} onChange={reset(setKb)} /> : null}
        <ClearFilters isActive={!!kb} onClear={clear} />
      </div>
    ) : null;

  let body: ReactNode;
  if (!rows.length) body = <NoMatches what="documents" onClear={clear} />;
  else
    body = (
      <DataTable
        label="Without a topic"
        rows={paginate(rows, page, PAGE)}
        getRowId={(r) => r.id}
        sort={sort}
        onSortChange={(s) => {
          setSort(s);
          setPage(1);
        }}
        selectedIds={selected}
        onSelectionChange={setSelected}
        rowLabel={(r) => r.title}
        onRowAction={(r) => drawer.open(r.item)}
        columns={[
          { id: "name", header: "Document", primary: true, sortValue: (r) => r.title, cell: (r) => <DocCell r={r} /> },
          {
            id: "updated",
            header: "Updated",
            hideOnMobile: true,
            className: "muted res-nowrap",
            sortValue: (r) => Date.parse(r.updated ?? "") || 0,
            cell: (r) => <span title={fmtDateTime(r.updated)}>{rel(r.updated)}</span>,
          },
        ]}
        rowActionLead={(r) => <TopicMenu label="Add topic" variant="tertiary" chevron onPick={(t) => void applyTopic([r], t)} />}
        bulkActions={(ids, done) => (
          <TopicMenu
            label="Apply topic"
            variant="ghost"
            chevron
            onPick={(t) =>
              void applyTopic(
                all.filter((r) => ids.includes(r.id)),
                t,
                done,
              )
            }
          />
        )}
        footer={<Pager page={page} pageSize={PAGE} total={rows.length} onPageChange={setPage} />}
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
