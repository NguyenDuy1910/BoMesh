"use client";

import { ClipboardList, Plus } from "lucide-react";
import { useSearchParams } from "next/navigation";

import { EmptyState, ErrorState, List, Page, PageHeader, Pager, Section, SectionTabs, SkeletonRows } from "@/components/ui";
import { useMessages } from "@/lib/i18n";
import { useWorkspace } from "@/lib/workspace";
import { literal } from "@/modules/people/model";

import { ACTIONABLE_FILTER, CLOSED_FILTER, OPEN_FILTER } from "../model";
import { useCatalog, useRequestCount, useRequestPages } from "../queries";
import { ButtonLink } from "./parts";
import { QueueView } from "./RequestQueue";
import { RequestRow } from "./RequestRow";

const PAGE = 20;

/** /requests — My requests and, for staff, the Queue (preview `P.requests`). */
export function RequestsPage() {
  const m = useMessages();
  const { member } = useWorkspace();
  const params = useSearchParams();
  const catalog = useCatalog();
  const me = literal(member.name ?? "");
  const mine = useRequestCount(`requester = ${me}`);
  const mineOpen = useRequestCount(`requester = ${me} AND ${OPEN_FILTER}`);
  const queue = useRequestCount(`requester != ${me}`);
  const waiting = useRequestCount(`requester != ${me} AND ${ACTIONABLE_FILTER}`);
  const overdue = useRequestCount(`requester != ${me} AND ${ACTIONABLE_FILTER} AND overdue = true`);
  const hasQueue = (queue.data ?? 0) > 0 || catalog.staffSpaces.length > 0;
  const asked = params.get("tab");
  const tab = hasQueue ? (asked === "mine" || asked === "queue" ? asked : mine.data || mine.isPending ? "mine" : "queue") : "mine";
  // No requests yet: the empty state's New request is the page's one primary action (no second copy in the header).
  const firstRequest = tab === "mine" && mine.isSuccess && !mine.data;
  // The queue's filters: the spaces whose requests the caller decides and their request types.
  const staffSpaces = new Set(catalog.staffSpaces.map((s) => s.name));
  const spaceOptions = catalog.staffSpaces.map((s) => ({ value: s.name ?? "", label: s.displayName }));
  const typeOptions = [
    ...catalog.groups.filter((g) => staffSpaces.has(g.space.name)).flatMap((g) => g.types.map((t) => ({ value: t.name ?? "", label: t.displayName }))),
    { value: "question", label: "Câu hỏi" },
  ];

  return (
    // The staff queue is a table and takes the full width; your own requests are a short list in the centred column.
    <Page width={tab === "queue" ? "wide" : "centered"} className="rq-page">
      <PageHeader
        title={m.nav.requests}
        actions={
          firstRequest ? null : (
            <ButtonLink href="/requests/new" variant="primary" icon={Plus}>
              Tạo yêu cầu
            </ButtonLink>
          )
        }
      >
        {hasQueue ? (
          <SectionTabs
            base="/requests"
            active={tab}
            items={[
              { id: "mine", label: "Yêu cầu của tôi", count: mineOpen.data || null },
              { id: "queue", label: "Hàng đợi", count: waiting.data || null, alert: (overdue.data ?? 0) > 0 },
            ]}
          />
        ) : null}
      </PageHeader>
      {mine.isError && mine.data === undefined ? (
        <ErrorState error={mine.error} onRetry={() => void mine.refetch()} />
      ) : mine.isPending ? (
        <SkeletonRows rows={4} />
      ) : tab === "queue" ? (
        <QueueView spaces={spaceOptions} typeOptions={typeOptions} />
      ) : (
        <MineView me={me} empty={!mine.data} />
      )}
    </Page>
  );
}

function MineView({ me, empty }: { me: string; empty: boolean }) {
  if (empty)
    return (
      <EmptyState
        icon={ClipboardList}
        boxed
        title="Chưa có yêu cầu"
        description="Gửi yêu cầu đến nhóm hoặc văn phòng phụ trách. Trợ lý sẽ kiểm tra quy định trước khi bạn gửi."
        actions={
          <ButtonLink href="/requests/new" variant="primary" icon={Plus}>
            Tạo yêu cầu
          </ButtonLink>
        }
      />
    );
  return (
    <>
      <MineSection title="Cần bạn phản hồi" className="rq-list rq-list--attn" filter={`requester = ${me} AND state = "NEEDS_INFO"`} />
      <MineSection title="Đang xử lý" className="rq-list" filter={`requester = ${me} AND (state = "OPEN" OR state = "APPROVED")`} />
      <MineSection title="Đã đóng" className="rq-list" filter={`requester = ${me} AND ${CLOSED_FILTER}`} />
    </>
  );
}

/** One section of your requests, most recently updated first, a server page at a time. */
function MineSection({ title, className, filter }: { title: string; className: string; filter: string }) {
  const pages = useRequestPages(filter, "updateTime desc", PAGE);
  const rows = pages.data?.requests ?? [];
  if (!rows.length) return null;
  return (
    <Section title={title}>
      <List className={className}>
        {rows.map((r) => (
          <RequestRow key={r.name} request={r} />
        ))}
      </List>
      {pages.page > 1 || pages.hasNext ? <Pager page={pages.page} pageSize={PAGE} total={pages.total} pageCount={rows.length} hasNext={pages.hasNext} onPageChange={pages.setPage} /> : null}
    </Section>
  );
}
