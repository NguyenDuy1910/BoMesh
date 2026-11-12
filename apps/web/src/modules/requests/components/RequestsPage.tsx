"use client";

import { ClipboardList, Plus } from "lucide-react";
import { useSearchParams } from "next/navigation";

import { EmptyState, ErrorState, List, Page, PageHeader, Section, SectionTabs, SkeletonRows } from "@/components/ui";
import { useWorkspace } from "@/lib/workspace";

import { byUpdated, isActionable, isOpen, isOverdue, type Request } from "../model";
import { useCatalog, useRequests } from "../queries";
import { ButtonLink } from "./parts";
import { QueueView } from "./RequestQueue";
import { RequestRow } from "./RequestRow";

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
      <PageHeader
        title="Requests"
        actions={
          <ButtonLink href="/requests/new" variant="primary" icon={Plus}>
            New request
          </ButtonLink>
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
          <ButtonLink href="/requests/new" variant="primary" icon={Plus}>
            New request
          </ButtonLink>
        }
      />
    );
  const reply = rows.filter((r) => r.state === "NEEDS_INFO").sort(byUpdated);
  const open = rows.filter((r) => isOpen(r) && r.state !== "NEEDS_INFO").sort(byUpdated);
  const closed = rows.filter((r) => !isOpen(r)).sort(byUpdated);
  const sections: [string, Request[], string][] = [
    ["Needs your reply", reply, "rq-list rq-list--attn"],
    ["In progress", open, "rq-list"],
    ["Closed", closed, "rq-list"],
  ];
  return (
    <>
      {sections.map(([title, list, className]) =>
        list.length ? (
          <Section key={title} title={title}>
            <List className={className}>
              {list.map((r) => (
                <RequestRow key={r.name} request={r} />
              ))}
            </List>
          </Section>
        ) : null,
      )}
    </>
  );
}
