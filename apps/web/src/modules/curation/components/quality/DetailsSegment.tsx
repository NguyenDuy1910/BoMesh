"use client";

import { Button } from "@heroui/react";
import { CircleCheck, Pencil } from "lucide-react";
import { useMemo, useState } from "react";

import { ClearFilters, DataTable, EmptyState, FilterButton, IconButton, NoMatches, Pager, paginate, SearchInput, StatusChip, type DataTableSort } from "@/components/ui";
import { fmtDateTime, fmtNum, rel } from "@/lib/format";
import { openEditDetails } from "@/modules/knowledge/components/dialogs";

import { GAP_KEYS, GAPS, matches, type DetailEntry, type GapKey } from "../../governance";
import { DocCell, sortRows, TopicMenu, useApplyTopic, useLiveSelection } from "./parts";

const PAGE = 20;

/** Missing details (preview `tabDetails`): documents without a topic, an owner or a summary. */
export function DetailsSegment({ entries }: { entries: readonly DetailEntry[] }) {
  const applyTopic = useApplyTopic();
  const [q, setQ] = useState("");
  const [gap, setGap] = useState("");
  const [kb, setKb] = useState("");
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<DataTableSort | null>(null);
  const [selected, setSelected] = useLiveSelection(entries.map((x) => x.r.id));

  const kbOpts = useMemo(
    () => [...new Map(entries.map((x) => [x.r.base?.name ?? "", x.r.base?.displayName ?? ""])).entries()].sort((a, b) => a[1].localeCompare(b[1])).map(([value, label]) => ({ value, label })),
    [entries],
  );

  if (!entries.length) {
    return <EmptyState icon={CircleCheck} tone="success" title="Every document is described" description="Documents you look after all have a topic, an owner and a summary." boxed />;
  }

  const counts = Object.fromEntries(GAP_KEYS.map((g) => [g, entries.filter((x) => x.gaps.includes(g)).length])) as Record<GapKey, number>;
  const gapOpts = GAP_KEYS.filter((g) => counts[g] || g === gap).map((g) => ({ value: g, label: `${GAPS[g].label} · ${fmtNum(counts[g])}` }));
  const filtered = entries.filter((x) => (!gap || x.gaps.includes(gap as GapKey)) && (!kb || x.r.base?.name === kb) && matches(q, x.r.title, x.r.base?.displayName));
  const rows = sortRows(filtered, sort, { name: (x) => x.r.title.toLowerCase(), updated: (x) => Date.parse(x.r.updated ?? "") || 0 });
  const clear = () => {
    setQ("");
    setGap("");
    setKb("");
    setPage(1);
  };
  const reset = (set: (v: string) => void) => (v: string) => {
    set(v);
    setPage(1);
  };

  const toolbar = (
    <div className="toolbar">
      <SearchInput value={q} onChange={reset(setQ)} placeholder="Search documents" />
      <FilterButton label="Missing" options={gapOpts} value={gap} onChange={reset(setGap)} />
      <FilterButton label="Knowledge base" options={kbOpts} value={kb} onChange={reset(setKb)} />
      <ClearFilters isActive={!!(q || gap || kb)} onClear={clear} />
    </div>
  );

  if (!rows.length) {
    return (
      <>
        {toolbar}
        {q || kb ? (
          <NoMatches what="documents" onClear={clear} />
        ) : (
          <EmptyState icon={CircleCheck} tone="success" title={`Every document has ${GAPS[gap as GapKey]?.noun ?? "its details"}`} boxed compact />
        )}
      </>
    );
  }

  return (
    <>
      {toolbar}
      <DataTable
        label="Missing details"
        rows={paginate(rows, page, PAGE)}
        getRowId={(x) => x.r.id}
        sort={sort}
        onSortChange={(s) => {
          setSort(s);
          setPage(1);
        }}
        selectedIds={selected}
        onSelectionChange={setSelected}
        rowHref={(x) => `/doc/${x.r.id}`}
        columns={[
          { id: "name", header: "Document", primary: true, sortValue: (x) => x.r.title, cell: (x) => <DocCell r={x.r} /> },
          {
            id: "gaps",
            header: "Missing",
            className: "kh-gaps",
            cell: (x) => (
              <div className="kh-chips">
                {x.gaps.map((g) => (
                  <StatusChip key={g} label={GAPS[g].label} icon={GAPS[g].icon} size="sm" tone={g === gap ? "warning" : "default"} />
                ))}
              </div>
            ),
          },
          {
            id: "updated",
            header: "Updated",
            hideOnMobile: true,
            className: "muted res-nowrap",
            sortValue: (x) => Date.parse(x.r.updated ?? "") || 0,
            cell: (x) => <span title={fmtDateTime(x.r.updated)}>{rel(x.r.updated)}</span>,
          },
        ]}
        rowActionLead={(x) =>
          x.gaps.includes("topic") ? (
            <>
              <TopicMenu label="Add topic" onPick={(t) => void applyTopic([x.r], t)} />
              <IconButton icon={Pencil} tip="Edit details" size="sm" onPress={() => openEditDetails(x.r.name)} />
            </>
          ) : (
            <Button size="sm" variant="tertiary" onPress={() => openEditDetails(x.r.name)}>
              <Pencil className="i" aria-hidden />
              Edit details
            </Button>
          )
        }
        bulkActions={(ids, done) => (
          <TopicMenu
            label="Apply topic"
            variant="ghost"
            chevron
            onPick={(t) =>
              void applyTopic(
                entries.filter((x) => ids.includes(x.r.id)).map((x) => x.r),
                t,
                done,
              )
            }
          />
        )}
        footer={<Pager page={page} pageSize={PAGE} total={rows.length} onPageChange={setPage} />}
      />
    </>
  );
}
