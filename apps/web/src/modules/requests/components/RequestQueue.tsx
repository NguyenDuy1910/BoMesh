"use client";

import { Button } from "@heroui/react";
import { useQuery } from "@tanstack/react-query";
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
  SearchInput,
  Segmented,
  SkeletonRows,
  toast,
  UserAvatar,
  type DataTableColumn,
  type DataTableSort,
  type FilterOption,
} from "@/components/ui";
import { errorMessage, resourceId } from "@/lib/api/client";
import { SEARCH_PAUSE_MS, useDebounced } from "@/lib/debounce";
import { plural, rel } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";
import { listMemberPage } from "@/modules/people/api";
import { literal, memberSearch } from "@/modules/people/model";
import { useRequestTypes } from "@/modules/spaces/queries";

import { CLOSED_FILTER, OPEN_FILTER, STATUS_FILTER, createdMs, dueMs, isOpen, isOverdue, isQuestion, requestTitle, shortId, type Request, type RequestStatus } from "../model";
import { useBulkAssign, useMemberMap, useRequestPages, useRequestTypeMap, useSpaceMap } from "../queries";
import { RequestStatusChip, SlaText } from "./RequestStatus";

const PAGE = 20;
/** Preview list-tools rule (`needsTools`): search, filters, sorting and selection from 7 items, or while filtering. */
const TOOLS_MIN = 7;
/** People a queue search matches by name (their requests join the title matches). */
const SEARCH_PEOPLE = 20;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const OPEN_STATUS_OPTS: { value: RequestStatus; label: string }[] = [
  { value: "submitted", label: "Đã gửi" },
  { value: "in_review", label: "Chờ duyệt" },
  { value: "needs_info", label: "Đang chờ phản hồi" },
  { value: "approved", label: "Đã phê duyệt" },
];
const CLOSED_STATUS_OPTS: { value: RequestStatus; label: string }[] = [
  { value: "completed", label: "Xong" },
  { value: "declined", label: "Đã từ chối" },
  { value: "withdrawn", label: "Đã rút lại" },
];

/**
 * A space's request queue for its staff (preview `X.requestQueue`): the same table, SLA, assignee and bulk
 * actions as the Requests Queue tab, scoped to one space. Excludes the caller's own requests.
 */
export function RequestQueue({ space }: { space: string }) {
  const types = useRequestTypes(resourceId(space));
  const typeOptions = (types.data ?? []).map((t) => ({ value: t.name ?? "", label: t.displayName }));
  return <QueueView space={space} typeOptions={[...typeOptions, { value: "question", label: "Câu hỏi" }]} />;
}

/**
 * The one staff queue (preview `queueView`), read a server page at a time. `space`: scoped to one space (its Queue
 * tab); otherwise `spaces` are the Space filter's choices. `typeOptions`: the Type filter's choices.
 */
export function QueueView({ space: scope, spaces: spaceOptions = [], typeOptions }: { space?: string; spaces?: readonly FilterOption[]; typeOptions: readonly FilterOption[] }) {
  const { id: ws, member } = useWorkspace();
  const spaces = useSpaceMap();
  const bulk = useBulkAssign();
  const [view, setView] = useState<"open" | "closed">("open");
  const [q, setQ] = useState("");
  const [space, setSpace] = useState("");
  const [status, setStatus] = useState("");
  const [type, setType] = useState("");
  const [sort, setSort] = useState<DataTableSort | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const needle = useDebounced(q.trim(), SEARCH_PAUSE_MS);

  // A search matches titles and questions, a pasted request ID, and requests filed by people whose name or email matches.
  const people = useQuery({
    queryKey: [ws, "members", "search", memberSearch(needle), SEARCH_PEOPLE],
    queryFn: async () => (await listMemberPage(ws, { filter: memberSearch(needle), orderBy: "displayName", pageSize: SEARCH_PEOPLE })).members ?? [],
    enabled: Boolean(needle),
  });
  const requesters = (people.data ?? []).map((m) => `requester = ${literal(m.name ?? "")}`);
  const byId = UUID.test(needle) ? [`name = ${literal(`workspaces/${ws}/requests/${needle.toLowerCase()}`)}`] : [];
  const search = needle ? `(${[`title = ${literal(`*${needle}*`)}`, `question = ${literal(`*${needle}*`)}`, ...byId, ...requesters].join(" OR ")})` : "";
  const base = [`requester != ${literal(member.name ?? "")}`, scope && `space = ${literal(scope)}`, view === "closed" ? CLOSED_FILTER : OPEN_FILTER].filter(Boolean).join(" AND ");
  const filter = [
    base,
    space && `space = ${literal(space)}`,
    status && STATUS_FILTER[status as RequestStatus],
    type && (type === "question" ? 'kind = "QUESTION"' : `requestType = ${literal(type)}`),
    search,
  ]
    .filter(Boolean)
    .join(" AND ");
  const ORDER: Record<string, string> = { created: "createTime", due: view === "closed" ? "updateTime" : "dueTime" };
  const orderBy = sort ? `${ORDER[sort.column] ?? "createTime"}${sort.direction === "descending" ? " desc" : ""}` : view === "closed" ? "updateTime desc" : "dueTime";
  const requests = useRequestPages(filter, orderBy, PAGE, { enabled: !needle || !people.isPending });
  const rows = requests.data?.requests ?? [];
  const types = useRequestTypeMap(rows.map((r) => r.requestType));
  const names = useMemberMap(rows.flatMap((r) => [r.requester, r.assignee]));

  const personName = (name: string | undefined) => (name ? names.get(name)?.displayName || "Ai đó" : "Ai đó");
  const multiSpace = !scope && spaceOptions.length > 1;
  const filtering = !!(q || space || status || type);
  const known = requests.total ?? (requests.page - 1) * PAGE + rows.length + (requests.hasNext ? 1 : 0);
  const tools = known >= TOOLS_MIN || filtering;
  const clear = () => {
    setQ("");
    setSpace("");
    setStatus("");
    setType("");
  };
  const setPage = (p: number) => {
    requests.setPage(p);
    setSelected(new Set());
  };

  const columns: DataTableColumn<Request>[] = [
    {
      id: "name",
      header: "Người yêu cầu",
      cell: (r) => (
        <span className="row gap-12">
          <UserAvatar name={personName(r.requester)} size="sm" />
          <span className="stack" style={{ minWidth: 0 }}>
            <span className="cell-title truncate" translate="no">
              {personName(r.requester)}
            </span>
            <span className="cell-sub truncate num">{names.get(r.requester ?? "")?.email ?? ""}</span>
          </span>
        </span>
      ),
    },
    {
      id: "request",
      header: "Yêu cầu",
      primary: true,
      cell: (r) => {
        const sp = spaces.get(r.space ?? "");
        return (
          <span className="stack rq-cell-req">
            <span className="cell-title rq-clamp" translate={isQuestion(r) || r.title ? "no" : undefined}>
              {requestTitle(r, types.get(r.requestType ?? ""))}
            </span>
            <span className="cell-sub truncate">
              {isQuestion(r) ? (scope ? `Câu hỏi · ${shortId(r)}` : `Câu hỏi · ${sp?.displayName ?? ""}`) : `${multiSpace && sp ? sp.displayName + " · " : ""}${shortId(r)}`}
            </span>
          </span>
        );
      },
    },
    { id: "created", header: "Đã gửi", sortValue: tools ? createdMs : undefined, hideOnMobile: true, cell: (r) => <span className="rq-nowrap muted">{rel(r.createTime)}</span> },
    { id: "due", header: view === "closed" ? "Đã đóng" : "SLA", sortValue: tools ? dueMs : undefined, cell: (r) => <SlaText request={r} /> },
    { id: "status", header: "Trạng thái", cell: (r) => <RequestStatusChip request={r} mine={false} space={spaces.get(r.space ?? "")} /> },
    {
      id: "assignee",
      header: "Người phụ trách",
      hideOnMobile: true,
      className: "hide-md",
      cell: (r) =>
        r.assignee ? (
          <span className="row gap-6">
            <UserAvatar name={personName(r.assignee)} size="xs" />
            <span className="truncate" translate="no">
              {r.assignee === member.name ? "Bạn" : personName(r.assignee)}
            </span>
          </span>
        ) : (
          <span className="muted">Chưa giao</span>
        ),
    },
  ];

  const assignToMe = (ids: string[], done: () => void) => {
    const targets = rows.filter((r) => ids.includes(r.name ?? "") && isOpen(r) && r.assignee !== member.name);
    done();
    if (!targets.length) {
      toast("Các mục này đã thuộc về bạn", { tone: "accent" });
      return;
    }
    const before = targets.map((r) => ({ request: resourceId(r.name), assignee: r.assignee ?? null }));
    bulk.mutate(
      targets.map((r) => ({ request: resourceId(r.name), assignee: member.name ?? "" })),
      {
        onSuccess: () => toast(`${plural(targets.length, "request")} đã được giao cho bạn`, { undo: () => bulk.mutate(before) }),
        onError: (e) => toast(errorMessage(e), { tone: "danger" }),
      },
    );
  };

  const empty =
    view === "closed" ? (
      <EmptyState icon={Archive} boxed compact={!!scope} title="Chưa có mục nào đã đóng" description="Các yêu cầu bạn phê duyệt, từ chối hoặc trả lời sẽ chuyển đến đây." />
    ) : (
      <EmptyState
        icon={CheckCircle2}
        tone="success"
        boxed
        compact={!!scope}
        title="Hàng đợi của bạn đã trống"
        description={scope ? "Yêu cầu và câu hỏi mới cho cộng đồng này sẽ xuất hiện ở đây." : "Yêu cầu và câu hỏi mới cho các cộng đồng của bạn sẽ hiển thị tại đây."}
      />
    );

  let body;
  if (requests.isError && !requests.data) body = <ErrorState error={requests.error} onRetry={() => void requests.refetch()} />;
  else if (!requests.data) body = <SkeletonRows rows={4} />;
  else if (!rows.length && requests.page === 1) body = filtering ? <NoMatches what="yêu cầu" onClear={clear} /> : empty;
  else
    body = (
      <DataTable
        label="Hàng đợi yêu cầu"
        rows={rows}
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
            Giao cho tôi
          </Button>
        )}
        footer={<Pager page={requests.page} pageSize={PAGE} total={requests.total} pageCount={rows.length} hasNext={requests.hasNext} onPageChange={setPage} />}
      />
    );

  // The tab counts what waits on you; Open / Closed only switches the view.
  return (
    <>
      <div className="toolbar">
        <Segmented
          label="Hiển thị"
          value={view}
          onChange={(v) => {
            setView(v);
            setStatus("");
            setSelected(new Set());
          }}
          options={[
            { value: "open", label: "Mở" },
            { value: "closed", label: "Đã đóng" },
          ]}
        />
        {tools ? (
          <>
            <SearchInput value={q} onChange={setQ} placeholder="Tìm theo người, ID hoặc yêu cầu" />
            {multiSpace ? <FilterButton label="Cộng đồng" value={space} onChange={setSpace} options={spaceOptions} /> : null}
            <FilterButton label="Trạng thái" value={status} onChange={setStatus} options={view === "closed" ? CLOSED_STATUS_OPTS : OPEN_STATUS_OPTS} />
            {typeOptions.length > 1 ? <FilterButton label="Loại" value={type} onChange={setType} options={typeOptions} /> : null}
            <ClearFilters isActive={!!(space || status || type)} onClear={clear} />
            {filtering && requests.total !== undefined ? <span className="toolbar__end t-sm muted num">{plural(requests.total, "request")}</span> : null}
          </>
        ) : null}
      </div>
      {body}
    </>
  );
}
