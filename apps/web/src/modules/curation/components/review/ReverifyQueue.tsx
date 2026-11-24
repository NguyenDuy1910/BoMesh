"use client";

import { Button } from "@heroui/react";
import { Pencil, ShieldCheck } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

import { ClearFilters, DataTable, EmptyState, ErrorState, FilterButton, NoMatches, Pager, paginate, SearchInput, SkeletonRows, StatusChip, toast, type DataTableSort } from "@/components/ui";
import { errorMessage } from "@/lib/api/client";
import { fmtDate, plural, relFuture } from "@/lib/format";
import { useMessages } from "@/lib/i18n";
import { useWorkspace } from "@/lib/workspace";
import { verifyItem } from "@/modules/knowledge/api";
import { openEditDetails } from "@/modules/knowledge/components/dialogs";
import { useMemberNames } from "@/modules/knowledge/queries";

import { matches, QUEUE_HINT, REASONS, reviewEntries, type ReasonKey, type ReviewEntry } from "../../governance";
import { useCurationPool, useInvalidateCuration } from "../../queries";
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
      <span className="cell-sub res-nowrap">{late ? `${plural(days, "day")} overdue` : relFuture(due)}</span>
    </div>
  );
}

/** Review → Re-verification due (preview `tabReview`): verification expired or never happened; Verify, in bulk. */
export function ReverifyQueue() {
  const { id: ws } = useWorkspace();
  const verification = useMessages().state.verification;
  const pool = useCurationPool();
  const invalidate = useInvalidateCuration();
  const drawer = useDocDrawer();
  const entries = useMemo(() => (pool.data ? reviewEntries(pool.data.pool) : []), [pool.data]);
  const [q, setQ] = useState("");
  const [kb, setKb] = useState("");
  const [reason, setReason] = useState("");
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<DataTableSort | null>(null);
  const [selected, setSelected] = useLiveSelection(entries.map((x) => x.r.id));
  const owners = useMemberNames(entries.map((x) => x.r.owner));

  if (!pool.data) return pool.isError ? <ErrorState error={pool.error} onRetry={() => void pool.refetch()} /> : <SkeletonRows rows={6} />;

  const wrap = (body: ReactNode) => (
    <div className="kh gov">
      <p className="gov-summary">{QUEUE_HINT.reverify}</p>
      {body}
      {drawer.node}
    </div>
  );
  if (!entries.length) return wrap(<EmptyState icon={ShieldCheck} tone="success" title="Nothing is due for re-verification" description="Every document you look after is verified and current." boxed />);

  const ownerName = (x: ReviewEntry) => (x.r.owner ? owners.get(x.r.owner) : "") ?? "";
  const kbOpts = [...new Map(entries.map((x) => [x.r.base?.name ?? "", x.r.base?.displayName ?? ""])).entries()].sort((a, b) => a[1].localeCompare(b[1])).map(([value, label]) => ({ value, label }));
  const reasonOpts = (Object.keys(REASONS) as ReasonKey[]).filter((k) => entries.some((x) => x.reason === k)).map((k) => ({ value: k, label: REASONS[k].label }));
  const filtering = !!(kb || reason);
  const filtered = entries.filter((x) => (!kb || x.r.base?.name === kb) && (!reason || x.reason === reason) && matches(q, x.r.title, ownerName(x), x.r.base?.displayName));
  const rows = sortRows(filtered, sort, { name: (x) => x.r.title.toLowerCase(), due: (x) => x.due ?? 9e15 });
  const clear = () => {
    setQ("");
    setKb("");
    setReason("");
    setPage(1);
  };
  const reset = (set: (v: string) => void) => (v: string) => {
    set(v);
    setPage(1);
  };

  async function verify(docs: ReviewEntry[], done?: () => void) {
    const list = docs.filter((x) => x.r.editable);
    if (!list.length) return;
    try {
      const results = await Promise.all(list.map((x) => verifyItem(ws, x.r.name)));
      invalidate();
      done?.();
      const due = results.map((it) => it.document?.verification?.nextReviewTime).find(Boolean);
      toast(list.length === 1 ? `Verified “${list[0].r.title}”${due ? ` until ${fmtDate(due)}` : ""}` : `Verified ${plural(list.length, "document")}${due ? ` until ${fmtDate(due)}` : ""}`);
    } catch (error) {
      invalidate();
      toast(errorMessage(error), { tone: "danger" });
    }
  }

  return wrap(
    <>
      {entries.length > 6 || q || filtering ? (
        <div className="toolbar">
          <SearchInput value={q} onChange={reset(setQ)} placeholder="Search documents" />
          {kbOpts.length > 1 || kb ? <FilterButton label="Collection" options={kbOpts} value={kb} onChange={reset(setKb)} /> : null}
          {reasonOpts.length > 1 || reason ? <FilterButton label="Reason" options={reasonOpts} value={reason} onChange={reset(setReason)} /> : null}
          <ClearFilters isActive={filtering} onClear={clear} />
        </div>
      ) : null}
      {rows.length ? (
        <DataTable
          label="Re-verification due"
          rows={paginate(rows, page, PAGE)}
          getRowId={(x) => x.r.id}
          sort={sort}
          onSortChange={(s) => {
            setSort(s);
            setPage(1);
          }}
          selectedIds={selected}
          onSelectionChange={setSelected}
          rowLabel={(x) => x.r.title}
          onRowAction={(x) => drawer.open(x.r.item)}
          columns={[
            { id: "name", header: "Document", primary: true, sortValue: (x) => x.r.title, cell: (x) => <DocCell r={x.r} /> },
            {
              id: "reason",
              header: "Reason",
              className: "kh-reason",
              cell: (x) => {
                const R = REASONS[x.reason];
                const why = x.note || verification[x.reason === "never" ? "unverified" : "review"].desc;
                return <StatusChip label={R.label} icon={R.icon} size="sm" tone={x.reason === "never" ? "default" : "warning"} tooltip={why} />;
              },
            },
            {
              id: "owner",
              header: "Owner",
              mobileLabel: "Owner",
              cell: (x) => (
                <div className="kh-owner">
                  <span className="truncate" translate="no">
                    {ownerName(x) || "—"}
                  </span>
                </div>
              ),
            },
            { id: "due", header: "Due", sortValue: (x) => x.due ?? 9e15, cell: (x) => <DueCell due={x.due} /> },
          ]}
          rowActionLead={(x) => (
            <Button size="sm" variant="secondary" isDisabled={!x.r.editable} onPress={() => void verify([x])}>
              <ShieldCheck className="i" aria-hidden />
              Verify
            </Button>
          )}
          rowActions={(x) => [{ id: "edit", label: "Edit details…", icon: Pencil, onAction: () => openEditDetails(x.r.name) }]}
          bulkActions={(ids, done) => (
            <Button size="sm" variant="ghost" onPress={() => void verify(entries.filter((x) => ids.includes(x.r.id)), done)}>
              <ShieldCheck className="i" aria-hidden />
              Verify selected
            </Button>
          )}
          footer={<Pager page={page} pageSize={PAGE} total={rows.length} onPageChange={setPage} />}
        />
      ) : (
        <NoMatches what="documents" onClear={clear} />
      )}
    </>,
  );
}
