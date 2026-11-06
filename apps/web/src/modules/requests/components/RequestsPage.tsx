"use client";

import { Button } from "@heroui/react";
import { Archive, CheckCircle2, ClipboardList, Plus, User } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useState } from "react";

import { PageChrome } from "@/components/shell/page-chrome";
import {
  ClearFilters,
  DataTable,
  EmptyState,
  ErrorState,
  FilterButton,
  List,
  NoMatches,
  Page,
  PageHeader,
  Pager,
  paginate,
  SearchInput,
  Section,
  SectionTabs,
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

import {
  byDue,
  byUpdated,
  createdMs,
  dueMs,
  firstName,
  isActionable,
  isOpen,
  isOverdue,
  isQuestion,
  requestStatus,
  requestTitle,
  shortId,
  type Request,
  type RequestStatus,
} from "../model";
import { useBulkAssign, useCatalog, useMemberMap, useRequests, useRequestTypeMap, useSpaceMap } from "../queries";
import { LinkButton } from "./parts";
import { RequestRow } from "./RequestRow";
import { RequestStatusChip, SlaText } from "./RequestStatus";

const PAGE = 20;

const OPEN_STATUS_OPTS: { value: RequestStatus; label: string }[] = [
  { value: "submitted", label: "Submitted" },
  { value: "in_review", label: "In review" },
  { value: "needs_info", label: "Waiting for reply" },
  { value: "approved", label: "Approved" },
];
const DONE_STATUS_OPTS: { value: RequestStatus; label: string }[] = [
  { value: "completed", label: "Done" },
  { value: "declined", label: "Declined" },
  { value: "withdrawn", label: "Withdrawn" },
];

/** /requests — My requests and, for staff, the Queue (preview `P.requests`). */
export function RequestsPage() {
  const { member } = useWorkspace();
  const params = useSearchParams();
  const requests = useRequests();
  const catalog = useCatalog();
  const all = requests.data ?? [];
  const mine = all.filter((r) => r.requester === member.name);
  const queue = all.filter((r) => r.requester !== member.name);
  const hasQueue = queue.length > 0 || catalog.staffSpaces.length > 0;
  const asked = params.get("tab");
  const tab = hasQueue ? (asked === "mine" || asked === "queue" ? asked : mine.length || requests.isPending ? "mine" : "queue") : "mine";

  return (
    <Page className="rq-page">
      <PageChrome crumbs={[{ label: "Requests" }]} />
      <PageHeader
        title="Requests"
        actions={
          <LinkButton href="/requests/new" variant="primary" icon={Plus}>
            New request
          </LinkButton>
        }
      >
        {hasQueue ? (
          <SectionTabs
            base="/requests"
            active={tab}
            items={[
              { id: "mine", label: "My requests", count: mine.filter(isOpen).length || null },
              { id: "queue", label: "Queue", count: queue.filter(isActionable).length || null, alert: queue.some((r) => isOverdue(r)) },
            ]}
          />
        ) : null}
      </PageHeader>
      {requests.isError && !requests.data ? (
        <ErrorState error={requests.error} onRetry={() => void requests.refetch()} />
      ) : requests.isPending ? (
        <SkeletonRows rows={4} />
      ) : tab === "queue" ? (
        <QueueView rows={queue} />
      ) : (
        <MineView rows={mine} />
      )}
    </Page>
  );
}

function MineView({ rows }: { rows: Request[] }) {
  if (!rows.length)
    return (
      <EmptyState
        icon={ClipboardList}
        boxed
        title="No requests yet"
        description="Ask a team or office for something they handle. The assistant checks the rules before you send."
        actions={
          <LinkButton href="/requests/new" variant="primary" icon={Plus}>
            New request
          </LinkButton>
        }
      />
    );
  const reply = rows.filter((r) => r.state === "NEEDS_INFO").sort(byUpdated);
  const open = rows.filter((r) => isOpen(r) && r.state !== "NEEDS_INFO").sort(byUpdated);
  const closed = rows.filter((r) => !isOpen(r)).sort(byUpdated);
  return (
    <>
      {reply.length ? (
        <Section title="Needs your reply">
          <List className="rq-list rq-list--attn">
            {reply.map((r) => (
              <RequestRow key={r.name} request={r} />
            ))}
          </List>
        </Section>
      ) : null}
      {open.length ? (
        <Section title="In progress">
          <List className="rq-list">
            {open.map((r) => (
              <RequestRow key={r.name} request={r} />
            ))}
          </List>
        </Section>
      ) : null}
      {closed.length ? (
        <Section title="Closed">
          <List className="rq-list">
            {closed.map((r) => (
              <RequestRow key={r.name} request={r} />
            ))}
          </List>
        </Section>
      ) : null}
    </>
  );
}

function QueueView({ rows: queue }: { rows: Request[] }) {
  const { member } = useWorkspace();
  const spaces = useSpaceMap();
  const types = useRequestTypeMap(queue.map((r) => r.requestType));
  const people = useMemberMap(queue.flatMap((r) => [r.requester, r.assignee]));
  const bulk = useBulkAssign();
  const [view, setView] = useState<"open" | "done">("open");
  const [q, setQ] = useState("");
  const [space, setSpace] = useState("");
  const [status, setStatus] = useState("");
  const [type, setType] = useState("");
  const [sort, setSort] = useState<DataTableSort | null>(null);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const personName = (name: string | undefined) => (name ? people.get(name)?.displayName || "Someone" : "Someone");
  const queueSpaces = [...new Set(queue.map((r) => r.space ?? ""))].filter(Boolean);
  const multiSpace = queueSpaces.length > 1;
  const inView = queue.filter((r) => (view === "done" ? !isOpen(r) : isOpen(r)));
  const needle = q.trim().toLowerCase();
  const filtered = inView.filter(
    (r) =>
      (!space || r.space === space) &&
      (!status || requestStatus(r) === status) &&
      (!type || r.requestType === type || (type === "question" && isQuestion(r))) &&
      (!needle ||
        [requestTitle(r, types.get(r.requestType ?? "")), personName(r.requester), people.get(r.requester ?? "")?.email, shortId(r), types.get(r.requestType ?? "")?.displayName]
          .filter(Boolean)
          .some((s) => String(s).toLowerCase().includes(needle))),
  );
  const sortValue: Record<string, (r: Request) => string | number> = {
    name: (r) => personName(r.requester).toLowerCase(),
    created: createdMs,
    due: (r) => (view === "done" ? Date.parse(r.closeTime ?? r.updateTime ?? "") || 0 : dueMs(r) || Infinity),
  };
  const sortBy = sort ? (sortValue[sort.column] ?? createdMs) : null;
  const dir = sort?.direction === "ascending" ? 1 : -1;
  const rows = [...filtered].sort(
    sortBy ? (a, b) => (sortBy(a) < sortBy(b) ? -dir : sortBy(a) > sortBy(b) ? dir : 0) : view === "done" ? byUpdated : byDue,
  );
  const typeOpts = [
    ...new Map(
      queue.map((r) => (isQuestion(r) ? ["question", "Question"] : [r.requestType ?? "", types.get(r.requestType ?? "")?.displayName ?? "Request"]) as [string, string]),
    ),
  ].map(([value, label]) => ({ value, label }));
  const counts = { open: queue.filter(isOpen).length, done: queue.filter((r) => !isOpen(r)).length };
  const filtersSet = !!(q || space || status || type);
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
      sortValue: (r) => personName(r.requester),
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
            <span className="cell-sub truncate">{isQuestion(r) ? `Question · ${sp?.displayName ?? ""}` : `${multiSpace && sp ? sp.displayName + " · " : ""}${shortId(r)}`}</span>
          </span>
        );
      },
    },
    { id: "created", header: "Submitted", sortValue: createdMs, hideOnMobile: true, cell: (r) => <span className="rq-nowrap muted">{rel(r.createTime)}</span> },
    { id: "due", header: view === "done" ? "Closed" : "SLA", sortValue: dueMs, cell: (r) => <SlaText request={r} /> },
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
              {r.assignee === member.name ? "You" : firstName(personName(r.assignee))}
            </span>
          </span>
        ) : (
          <span className="muted">Unassigned</span>
        ),
    },
  ];

  const assignToMe = (ids: string[], done: () => void) => {
    const targets = queue.filter((r) => ids.includes(r.name ?? "") && isOpen(r) && r.state !== "APPROVED" && r.assignee !== member.name);
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
    view === "done" ? (
      <EmptyState icon={Archive} boxed title="Nothing closed yet" description="Requests you approve, decline or answer move here." />
    ) : (
      <EmptyState icon={CheckCircle2} tone="success" boxed title="Your queue is clear" description="New requests and questions for your spaces show up here." />
    );

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
            { value: "open", label: `Open · ${counts.open}` },
            { value: "done", label: `Done · ${counts.done}` },
          ]}
        />
        <SearchInput value={q} onChange={(v) => (setQ(v), setPage(1))} placeholder="Search by person, ID or request" />
        {multiSpace ? (
          <FilterButton
            label="Space"
            value={space}
            onChange={(v) => (setSpace(v), setPage(1))}
            options={queueSpaces.map((s) => ({ value: s, label: spaces.get(s)?.displayName ?? "Space" }))}
          />
        ) : null}
        <FilterButton label="Status" value={status} onChange={(v) => (setStatus(v), setPage(1))} options={view === "done" ? DONE_STATUS_OPTS : OPEN_STATUS_OPTS} />
        {typeOpts.length > 1 ? <FilterButton label="Type" value={type} onChange={(v) => (setType(v), setPage(1))} options={typeOpts} /> : null}
        <ClearFilters isActive={!!(space || status || type)} onClear={clear} />
        <span className="toolbar__end t-sm muted num">{plural(rows.length, "request")}</span>
      </div>
      {!inView.length ? (
        empty
      ) : !rows.length ? (
        <NoMatches what="requests" onClear={filtersSet ? clear : undefined} />
      ) : (
        <DataTable
          label="Request queue"
          rows={pageRows}
          columns={columns}
          getRowId={(r) => r.name ?? ""}
          sort={sort}
          onSortChange={setSort}
          rowHref={(r) => `/requests/${resourceId(r.name)}`}
          selectedIds={view === "open" ? selected : undefined}
          onSelectionChange={view === "open" ? setSelected : undefined}
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
