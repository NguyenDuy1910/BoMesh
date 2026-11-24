"use client";

import { Button } from "@heroui/react";
import { Pencil, ShieldCheck } from "lucide-react";
import { useState, type ReactNode } from "react";

import { ClearFilters, DataTable, EmptyState, ErrorState, FilterButton, NoMatches, Pager, SearchInput, SkeletonRows, StatusChip, toast, type DataTableSort } from "@/components/ui";
import { errorMessage } from "@/lib/api/client";
import { SEARCH_PAUSE_MS, useDebounced } from "@/lib/debounce";
import { fmtDate, plural, relFuture } from "@/lib/format";
import { useMessages } from "@/lib/i18n";
import { useWorkspace } from "@/lib/workspace";
import { verifyItem } from "@/modules/knowledge/api";
import { openEditDetails } from "@/modules/knowledge/components/dialogs";
import { useKnowledgeModel, useMemberNames } from "@/modules/knowledge/queries";

import { nameSearch, reverifyFilter } from "../../docFilter";
import { QUEUE_HINT, REASONS, reviewEntries, reviewEntry, type ReasonKey, type ReviewEntry } from "../../governance";
import { useDocScope, useInvalidateCuration, useItemPages } from "../../queries";
import { DocCell, sortRows, useLiveSelection } from "../shared";
import { useDocDrawer } from "./useDocDrawer";

const PAGE = 20;
const DAY = 86_400_000;

function DueCell({ due }: { due: number | null }) {
  if (!due) return <span className="muted">—</span>;
  const late = due < Date.now();
  const days = Math.max(1, Math.round(Math.abs(Date.now() - due) / DAY));
  return (
    <div className="stack">
      <span className={late ? "text-warning medium res-nowrap" : "res-nowrap"}>{fmtDate(due)}</span>
      <span className="cell-sub res-nowrap">{late ? `${plural(days, "day")} quá hạn` : relFuture(due)}</span>
    </div>
  );
}

/**
 * Review → Re-verification due (preview `tabReview`): verification expired or never happened; Verify, in bulk. One
 * server page at a time (search, Collection and Reason are the filter; Document sorts on the server); within the page,
 * expired comes before never verified, soonest due first, unless Due is the sort.
 */
export function ReverifyQueue() {
  const { id: ws } = useWorkspace();
  const verification = useMessages().state.verification;
  const docScope = useDocScope();
  const { toResource } = useKnowledgeModel();
  const invalidate = useInvalidateCuration();
  const drawer = useDocDrawer();
  const [q, setQ] = useState("");
  const [kb, setKb] = useState("");
  const [reason, setReason] = useState<ReasonKey | "">("");
  const [sort, setSort] = useState<DataTableSort | null>(null);
  const sought = useDebounced(q, SEARCH_PAUSE_MS);
  const filter = [reverifyFilter(kb ? [kb] : docScope.scope, reason || undefined), nameSearch(sought)].filter(Boolean).join(" AND ");
  const orderBy = sort?.column === "name" && sort.direction === "descending" ? "displayName desc" : "displayName";
  const list = useItemPages(filter, orderBy, { pageSize: PAGE, enabled: docScope.scope.length > 0 });
  const resources = list.items.map((it) => toResource(it));
  // No sort: the reason order within the page. Due sorts the page; Document keeps the server's order.
  const rows = sort ? sortRows(resources.map(reviewEntry).filter((x): x is ReviewEntry => !!x), sort, { due: (x) => x.due ?? 9e15 }) : reviewEntries(resources);
  const [selected, setSelected] = useLiveSelection(rows.map((x) => x.r.id));
  const owners = useMemberNames(rows.map((x) => x.r.owner));

  if (docScope.isPending || (docScope.scope.length > 0 && list.isPending)) return <SkeletonRows rows={6} />;
  if (docScope.isError || list.isError) {
    return (
      <ErrorState
        error={docScope.error ?? list.error}
        onRetry={() => {
          void docScope.refetch();
          void list.refetch();
        }}
      />
    );
  }

  const wrap = (body: ReactNode) => (
    <div className="kh gov">
      <p className="gov-summary">{QUEUE_HINT.reverify}</p>
      {body}
      {drawer.node}
    </div>
  );
  const filtering = !!(kb || reason);
  if (!q && !filtering && !rows.length && list.page === 1) {
    return wrap(<EmptyState icon={ShieldCheck} tone="success" title="Không có tài liệu nào cần xác minh lại" description="Mọi tài liệu bạn phụ trách đều đã xác minh và cập nhật." boxed />);
  }

  const ownerName = (x: ReviewEntry) => (x.r.owner ? owners.get(x.r.owner) : "") ?? "";
  const kbOpts = docScope.bases.map((b) => ({ value: b.name ?? "", label: b.displayName || "Kho tài liệu" })).sort((a, b) => a.label.localeCompare(b.label));
  const reasonOpts = (Object.keys(REASONS) as ReasonKey[]).map((k) => ({ value: k, label: REASONS[k].label }));
  const clear = () => {
    setQ("");
    setKb("");
    setReason("");
  };

  async function verify(docs: ReviewEntry[], done?: () => void) {
    const editable = docs.filter((x) => x.r.editable);
    if (!editable.length) return;
    try {
      const results = await Promise.all(editable.map((x) => verifyItem(ws, x.r.name)));
      invalidate();
      done?.();
      const until = results.map((it) => it.document?.verification?.nextReviewTime).find(Boolean);
      toast(editable.length === 1 ? `Đã xác minh “${editable[0].r.title}”${until ? ` đến ${fmtDate(until)}` : ""}` : `Đã xác minh ${plural(editable.length, "document")}${until ? ` đến ${fmtDate(until)}` : ""}`);
    } catch (error) {
      invalidate();
      toast(errorMessage(error), { tone: "danger" });
    }
  }

  return wrap(
    <>
      {(list.total ?? 0) > 6 || q || filtering ? (
        <div className="toolbar">
          <SearchInput value={q} onChange={setQ} placeholder="Tìm kiếm tài liệu" />
          {kbOpts.length > 1 || kb ? <FilterButton label="Kho tài liệu" options={kbOpts} value={kb} onChange={setKb} /> : null}
          <FilterButton label="Lý do" options={reasonOpts} value={reason} onChange={(v) => setReason(v as ReasonKey | "")} />
          <ClearFilters isActive={filtering} onClear={clear} />
        </div>
      ) : null}
      {rows.length ? (
        <DataTable
          label="Cần xác minh lại"
          rows={rows}
          getRowId={(x) => x.r.id}
          sort={sort}
          onSortChange={setSort}
          selectedIds={selected}
          onSelectionChange={setSelected}
          rowLabel={(x) => x.r.title}
          onRowAction={(x) => drawer.open(x.r.item)}
          columns={[
            { id: "name", header: "Tài liệu", primary: true, sortValue: (x) => x.r.title, cell: (x) => <DocCell r={x.r} /> },
            {
              id: "reason",
              header: "Lý do",
              className: "kh-reason",
              cell: (x) => {
                const R = REASONS[x.reason];
                const why = x.note || verification[x.reason === "never" ? "unverified" : "review"].desc;
                return <StatusChip label={R.label} icon={R.icon} size="sm" tone={x.reason === "never" ? "default" : "warning"} tooltip={why} />;
              },
            },
            {
              id: "owner",
              header: "Chủ sở hữu",
              mobileLabel: "Chủ sở hữu",
              cell: (x) => (
                <div className="kh-owner">
                  <span className="truncate" translate="no">
                    {ownerName(x) || "—"}
                  </span>
                </div>
              ),
            },
            { id: "due", header: "Đến hạn", sortValue: (x) => x.due ?? 9e15, cell: (x) => <DueCell due={x.due} /> },
          ]}
          rowActionLead={(x) => (
            <Button size="sm" variant="secondary" isDisabled={!x.r.editable} onPress={() => void verify([x])}>
              <ShieldCheck className="i" aria-hidden />
              Xác minh
            </Button>
          )}
          rowActions={(x) => [{ id: "edit", label: "Sửa chi tiết…", icon: Pencil, onAction: () => openEditDetails(x.r.name) }]}
          bulkActions={(ids, done) => (
            <Button size="sm" variant="ghost" onPress={() => void verify(rows.filter((x) => ids.includes(x.r.id)), done)}>
              <ShieldCheck className="i" aria-hidden />
              Xác minh mục đã chọn
            </Button>
          )}
          footer={<Pager page={list.page} pageSize={PAGE} total={list.total} pageCount={rows.length} hasNext={list.hasNext} onPageChange={list.setPage} />}
        />
      ) : (
        <NoMatches what="tài liệu" onClear={clear} />
      )}
    </>,
  );
}
