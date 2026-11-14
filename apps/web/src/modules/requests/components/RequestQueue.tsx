"use client";

import { Button } from "@heroui/react";
import { Archive, CheckCircle2, User } from "lucide-react";
import { useState } from "react";

import {
  ClearFilters,
  DataTable,
  EmptyState,
  ErrorState,
  FilterButton,
  NoMatches,
  Pager,
  paginate,
  SearchInput,
  Segmented,
  SkeletonRows,
  toast,
  UserAvatar,
  type DataTableColumn,
  type DataTableSort,
} from "@/components/ui";
import { errorMessage, resourceId } from "@/lib/api/client";
import { plural, rel } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";

import { byDue, byUpdated, createdMs, dueMs, isOpen, isOverdue, isQuestion, requestStatus, requestTitle, shortId, type Request, type RequestStatus } from "../model";
import { useBulkAssign, useMemberMap, useRequests, useRequestTypeMap, useSpaceMap } from "../queries";
import { RequestStatusChip, SlaText } from "./RequestStatus";

const PAGE = 20;
/** Preview list-tools rule (`needsTools`): search, filters, sorting and selection from 7 items, or while filtering. */
const TOOLS_MIN = 7;

const OPEN_STATUS_OPTS: { value: RequestStatus; label: string }[] = [
  { value: "submitted", label: "Submitted" },
  { value: "in_review", label: "In review" },
  { value: "needs_info", label: "Waiting for reply" },
  { value: "approved", label: "Approved" },
];
const CLOSED_STATUS_OPTS: { value: RequestStatus; label: string }[] = [
  { value: "completed", label: "Done" },
  { value: "declined", label: "Declined" },
  { value: "withdrawn", label: "Withdrawn" },
];

/**
 * A space's request queue for its staff (preview `X.requestQueue`): the same table, SLA, assignee and bulk
 * actions as the Requests Queue tab, scoped to one space. Excludes the caller's own requests.
 */
export function RequestQueue({ space }: { space: string }) {
  const { member } = useWorkspace();
  const requests = useRequests();
  if (requests.isError && !requests.data) return <ErrorState error={requests.error} onRetry={() => void requests.refetch()} />;
  if (requests.isPending) return <SkeletonRows rows={4} />;
  const rows = (requests.data ?? []).filter((r) => r.space === space && r.requester !== member.name);
  return <QueueView rows={rows} space={space} />;
}

/** The one staff queue (preview `queueView`). `space`: scoped to one space (its Queue tab). */
export function QueueView({ rows: queue, space: scope }: { rows: Request[]; space?: string }) {
  const { member } = useWorkspace();
  const spaces = useSpaceMap();
  const types = useRequestTypeMap(queue.map((r) => r.requestType));
  const people = useMemberMap(queue.flatMap((r) => [r.requester, r.assignee]));
  const bulk = useBulkAssign();
  const [view, setView] = useState<"open" | "closed">("open");
  const [q, setQ] = useState("");
  const [space, setSpace] = useState("");
  const [status, setStatus] = useState("");
  const [type, setType] = useState("");
  const [sort, setSort] = useState<DataTableSort | null>(null);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const personName = (name: string | undefined) => (name ? people.get(name)?.displayName || "Someone" : "Someone");
  const queueSpaces = scope ? [] : [...new Set(queue.map((r) => r.space ?? ""))].filter(Boolean);
  const multiSpace = queueSpaces.length > 1;
  const inView = queue.filter((r) => (view === "closed" ? !isOpen(r) : isOpen(r)));
  const filtering = !!(q || space || status || type);
  const tools = inView.length >= TOOLS_MIN || filtering;
  const needle = q.trim().toLowerCase();
  const typeName = (r: Request) => types.get(r.requestType ?? "")?.displayName;
  const filtered = inView.filter(
    (r) =>
      (!space || r.space === space) &&
      (!status || requestStatus(r) === status) &&
      (!type || r.requestType === type || (type === "question" && isQuestion(r))) &&
      (!needle ||
        [requestTitle(r, types.get(r.requestType ?? "")), personName(r.requester), people.get(r.requester ?? "")?.email, shortId(r), typeName(r)]
          .filter(Boolean)
          .some((s) => String(s).toLowerCase().includes(needle))),
  );
  const sortValue: Record<string, (r: Request) => string | number> = {
    name: (r) => personName(r.requester).toLowerCase(),
    created: createdMs,
    due: (r) => (view === "closed" ? Date.parse(r.closeTime ?? r.updateTime ?? "") || 0 : dueMs(r) || Infinity),
  };
  const sortBy = tools && sort ? (sortValue[sort.column] ?? createdMs) : null;
  const dir = sort?.direction === "ascending" ? 1 : -1;
  const rows = [...filtered].sort(sortBy ? (a, b) => (sortBy(a) < sortBy(b) ? -dir : sortBy(a) > sortBy(b) ? dir : 0) : view === "closed" ? byUpdated : byDue);
  const typeOpts = [
    ...new Map(queue.map((r) => (isQuestion(r) ? ["question", "Question"] : [r.requestType ?? "", typeName(r) ?? "Request"]) as [string, string])),
  ].map(([value, label]) => ({ value, label }));
  const clear = () => {
    setQ("");
    setSpace("");
    setStatus("");
    setType("");
    setPage(1);
  };
  const pageRows = paginate(rows, page, PAGE);

  const columns: DataTableColumn<Request>[] = [
    {
      id: "name",
      header: "Requester",
      sortValue: tools ? (r) => personName(r.requester) : undefined,
      cell: (r) => (
        <span className="row gap-12">
          <UserAvatar name={personName(r.requester)} size="sm" />
          <span className="stack" style={{ minWidth: 0 }}>
            <span className="cell-title truncate" translate="no">
              {personName(r.requester)}
            </span>
            <span className="cell-sub truncate num">{people.get(r.requester ?? "")?.email ?? ""}</span>
          </span>
        </span>
      ),
    },
    {
      id: "request",
      header: "Request",
      primary: true,
      cell: (r) => {
        const sp = spaces.get(r.space ?? "");
        return (
          <span className="stack rq-cell-req">
            <span className="cell-title rq-clamp" translate={isQuestion(r) || r.title ? "no" : undefined}>
              {requestTitle(r, types.get(r.requestType ?? ""))}
            </span>
            <span className="cell-sub truncate">
              {isQuestion(r) ? (scope ? `Question · ${shortId(r)}` : `Question · ${sp?.displayName ?? ""}`) : `${multiSpace && sp ? sp.displayName + " · " : ""}${shortId(r)}`}
            </span>
          </span>
        );
      },
    },
    { id: "created", header: "Submitted", sortValue: tools ? createdMs : undefined, hideOnMobile: true, cell: (r) => <span className="rq-nowrap muted">{rel(r.createTime)}</span> },
    { id: "due", header: view === "closed" ? "Closed" : "SLA", sortValue: tools ? dueMs : undefined, cell: (r) => <SlaText request={r} /> },
    { id: "status", header: "Status", cell: (r) => <RequestStatusChip request={r} mine={false} space={spaces.get(r.space ?? "")} /> },
    {
      id: "assignee",
      header: "Assignee",
      hideOnMobile: true,
      className: "hide-md",
      cell: (r) =>
        r.assignee ? (
          <span className="row gap-6">
            <UserAvatar name={personName(r.assignee)} size="xs" />
            <span className="truncate" translate="no">
              {r.assignee === member.name ? "You" : personName(r.assignee)}
            </span>
          </span>
        ) : (
          <span className="muted">Unassigned</span>
        ),
    },
  ];

  const assignToMe = (ids: string[], done: () => void) => {
    const targets = queue.filter((r) => ids.includes(r.name ?? "") && isOpen(r) && r.assignee !== member.name);
    done();
    if (!targets.length) {
      toast("These are already yours", { tone: "accent" });
      return;
    }
    const before = targets.map((r) => ({ request: resourceId(r.name), assignee: r.assignee ?? null }));
    bulk.mutate(
      targets.map((r) => ({ request: resourceId(r.name), assignee: member.name ?? "" })),
      {
        onSuccess: () => toast(`${plural(targets.length, "request")} assigned to you`, { undo: () => bulk.mutate(before) }),
        onError: (e) => toast(errorMessage(e), { tone: "danger" }),
      },
    );
  };

  const empty =
    view === "closed" ? (
      <EmptyState icon={Archive} boxed compact={!!scope} title="Nothing closed yet" description="Requests you approve, decline or answer move here." />
    ) : (
      <EmptyState
        icon={CheckCircle2}
        tone="success"
        boxed
        compact={!!scope}
        title="Your queue is clear"
        description={scope ? "New requests and questions for this space show up here." : "New requests and questions for your spaces show up here."}
      />
    );

  // The tab counts what waits on you; Open / Closed only switches the view.
  return (
    <>
      <div className="toolbar">
        <Segmented
          label="Show"
          value={view}
          onChange={(v) => {
            setView(v);
            setStatus("");
            setSelected(new Set());
            setPage(1);
          }}
          options={[
            { value: "open", label: "Open" },
            { value: "closed", label: "Closed" },
          ]}
        />
        {tools ? (
          <>
            <SearchInput value={q} onChange={(v) => (setQ(v), setPage(1))} placeholder="Search by person, ID or request" />
            {multiSpace ? (
              <FilterButton
                label="Space"
                value={space}
                onChange={(v) => (setSpace(v), setPage(1))}
                options={queueSpaces.map((s) => ({ value: s, label: spaces.get(s)?.displayName ?? "Space" }))}
              />
            ) : null}
            <FilterButton label="Status" value={status} onChange={(v) => (setStatus(v), setPage(1))} options={view === "closed" ? CLOSED_STATUS_OPTS : OPEN_STATUS_OPTS} />
            {typeOpts.length > 1 ? <FilterButton label="Type" value={type} onChange={(v) => (setType(v), setPage(1))} options={typeOpts} /> : null}
            <ClearFilters isActive={!!(space || status || type)} onClear={clear} />
            {filtering ? <span className="toolbar__end t-sm muted num">{plural(rows.length, "request")}</span> : null}
          </>
        ) : null}
      </div>
      {!inView.length ? (
        empty
      ) : !rows.length ? (
        <NoMatches what="requests" onClear={clear} />
      ) : (
        <DataTable
          label="Request queue"
          rows={pageRows}
          columns={columns}
          getRowId={(r) => r.name ?? ""}
          sort={tools ? sort : null}
          onSortChange={setSort}
          rowHref={(r) => `/requests/${resourceId(r.name)}`}
          rowClassName={(r) => (isOverdue(r) ? "rq-row--over" : undefined)}
          selectedIds={tools && view === "open" ? selected : undefined}
          onSelectionChange={tools && view === "open" ? setSelected : undefined}
          rowLabel={(r) => requestTitle(r, types.get(r.requestType ?? ""))}
          bulkActions={(ids, done) => (
            <Button variant="ghost" size="sm" onPress={() => assignToMe(ids, done)} isPending={bulk.isPending}>
              <User className="i" aria-hidden />
              Assign to me
            </Button>
          )}
          footer={<Pager page={page} pageSize={PAGE} total={rows.length} onPageChange={setPage} />}
        />
      )}
    </>
  );
}
