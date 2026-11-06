"use client";

import { Button, Tooltip } from "@heroui/react";
import { ArrowUpRight, FileText, Pencil, RefreshCw, ShieldCheck } from "lucide-react";
import NextLink from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import { ClearFilters, DataTable, EmptyState, FilterButton, NoMatches, Pager, paginate, SearchInput, StatusChip, Tip, toast, type DataTableSort } from "@/components/ui";
import { errorMessage } from "@/lib/api/client";
import { fmtDate, plural, relFuture } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";
import { verifyItem } from "@/modules/knowledge/api";
import { openEditDetails } from "@/modules/knowledge/components/dialogs";
import { useDocumentOperations } from "@/modules/knowledge/operations";
import { useMemberNames } from "@/modules/knowledge/queries";

import { createIngestionRun } from "../../api";
import { matches, REASONS, type ReasonKey, type ReviewEntry } from "../../governance";
import { useInvalidateCuration } from "../../queries";
import { DocCell, sortRows, useLiveSelection, useQualityAbilities } from "./parts";

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

/** Due for re-verification (preview `tabReview`): changed at source, verification expired, never verified. */
export function ReverifySegment({ entries }: { entries: readonly ReviewEntry[] }) {
  const { id: ws, can: canWs } = useWorkspace();
  const router = useRouter();
  const ops = useDocumentOperations();
  const invalidate = useInvalidateCuration();
  const [q, setQ] = useState("");
  const [kb, setKb] = useState("");
  const [reason, setReason] = useState("");
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<DataTableSort | null>(null);
  const [selected, setSelected] = useLiveSelection(entries.map((x) => x.r.id));
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());

  const owners = useMemberNames(entries.map((x) => x.r.owner));
  const sourceItems = useMemo(() => entries.filter((x) => x.reason === "source").map((x) => x.r.name), [entries]);
  const can = useQualityAbilities(sourceItems);

  const kbOpts = useMemo(
    () => [...new Map(entries.map((x) => [x.r.base?.name ?? "", x.r.base?.displayName ?? ""])).entries()].sort((a, b) => a[1].localeCompare(b[1])).map(([value, label]) => ({ value, label })),
    [entries],
  );
  const reasonOpts = (Object.keys(REASONS) as ReasonKey[]).filter((k) => entries.some((x) => x.reason === k)).map((k) => ({ value: k, label: REASONS[k].label }));

  if (!entries.length) {
    return <EmptyState icon={ShieldCheck} tone="success" title="Nothing is due for re-verification" description="Every document you look after is verified and current." boxed />;
  }

  const ownerName = (x: ReviewEntry) => (x.r.owner ? owners.get(x.r.owner) : "") ?? "";
  const filtered = entries.filter(
    (x) => (!kb || x.r.base?.name === kb) && (!reason || x.reason === reason) && matches(q, x.r.title, ownerName(x), x.r.base?.displayName),
  );
  const rows = sortRows(filtered, sort, { name: (x) => x.r.title.toLowerCase(), due: (x) => x.due ?? 9e15 });
  const filtering = !!(q || kb || reason);
  const clear = () => {
    setQ("");
    setKb("");
    setReason("");
    setPage(1);
  };
  const reset = <T,>(set: (v: T) => void) => (v: T) => {
    set(v);
    setPage(1);
  };

  const republishBlocked = (x: ReviewEntry) => !can(x.r.name, "ingestionRuns.create") || x.r.item.document?.indexingState === "RUNNING" || busy.has(x.r.id);
  async function republish(x: ReviewEntry) {
    setBusy((b) => new Set(b).add(x.r.id));
    try {
      await createIngestionRun(ws, [x.r.name]);
      invalidate();
      toast(`Republishing ${x.r.title}`);
    } catch (error) {
      toast(errorMessage(error), { tone: "danger" });
    } finally {
      setBusy((b) => {
        const next = new Set(b);
        next.delete(x.r.id);
        return next;
      });
    }
  }

  async function verifySelected(ids: string[], done: () => void) {
    const picked = entries.filter((x) => ids.includes(x.r.id));
    const docs = picked.filter((x) => x.reason !== "source" && x.r.editable).map((x) => x.r);
    const skipped = picked.length - docs.length;
    if (!docs.length) {
      toast("Republish documents that changed at the source before verifying them", { tone: "accent" });
      return;
    }
    try {
      const results = await Promise.all(docs.map((r) => verifyItem(ws, r.name)));
      invalidate();
      done();
      const due = results.map((it) => it.document?.verification?.nextReviewTime).find(Boolean);
      toast(`Verified ${plural(docs.length, "document")}${due ? ` until ${fmtDate(due)}` : ""}${skipped ? ` · ${skipped} changed at the source need republishing first` : ""}`);
    } catch (error) {
      invalidate();
      toast(errorMessage(error), { tone: "danger" });
    }
  }

  function primaryAction(x: ReviewEntry) {
    if (x.reason !== "source") {
      return (
        <Button size="sm" variant="tertiary" onPress={() => void ops.verify(x.r)}>
          <ShieldCheck className="i" aria-hidden />
          Verify
        </Button>
      );
    }
    const allowed = can(x.r.name, "ingestionRuns.create");
    const button = (
      <Button size="sm" variant="tertiary" isDisabled={republishBlocked(x)} isPending={busy.has(x.r.id)} onPress={() => void republish(x)}>
        <RefreshCw className="i" aria-hidden />
        Republish
      </Button>
    );
    if (!allowed) return <Tip content="Ask someone who can run syncs">{button}</Tip>;
    return (
      <Tooltip delay={350}>
        {button}
        <Tooltip.Content>Publish the version that changed at the source</Tooltip.Content>
      </Tooltip>
    );
  }

  return (
    <>
      <div className="toolbar">
        <SearchInput value={q} onChange={reset(setQ)} placeholder="Search documents" />
        <FilterButton label="Knowledge base" options={kbOpts} value={kb} onChange={reset(setKb)} />
        <FilterButton label="Reason" options={reasonOpts} value={reason} onChange={reset(setReason)} />
        <ClearFilters isActive={filtering} onClear={clear} />
        {entries.some((x) => x.reason === "source") && canWs("sources.list") ? (
          <div className="toolbar__end">
            <NextLink className="link-button" href="/sources">
              Sync status in Sources
              <ArrowUpRight className="i i-sm" aria-hidden />
            </NextLink>
          </div>
        ) : null}
      </div>
      {rows.length ? (
        <DataTable
          label="Due for re-verification"
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
              id: "reason",
              header: "Reason",
              className: "kh-reason",
              cell: (x) => {
                const R = REASONS[x.reason];
                return <StatusChip label={R.label} icon={R.icon} size="sm" tone={x.reason === "never" ? "default" : "warning"} tooltip={x.note} />;
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
          rowActionLead={primaryAction}
          rowActions={(x) => [
            { id: "open", label: "Open", icon: FileText, onAction: () => router.push(`/doc/${x.r.id}`) },
            x.reason !== "source"
              ? { id: "verify", label: "Mark as verified", icon: ShieldCheck, onAction: () => void ops.verify(x.r) }
              : { id: "republish", label: "Republish", icon: RefreshCw, isDisabled: republishBlocked(x), onAction: () => void republish(x) },
            { id: "edit", label: "Edit details…", icon: Pencil, onAction: () => openEditDetails(x.r.name) },
          ]}
          bulkActions={(ids, done) => (
            <Button size="sm" variant="ghost" onPress={() => void verifySelected(ids, done)}>
              <ShieldCheck className="i" aria-hidden />
              Verify selected
            </Button>
          )}
          footer={<Pager page={page} pageSize={PAGE} total={rows.length} onPageChange={setPage} />}
        />
      ) : (
        <NoMatches what="documents" onClear={clear} />
      )}
    </>
  );
}
