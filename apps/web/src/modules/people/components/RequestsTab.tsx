"use client";

import { Button } from "@heroui/react";
import { CheckCheck, History } from "lucide-react";
import Link from "next/link";
import { useState, type ReactNode } from "react";

import { Disclosure, EmptyState, Gate, List, ListItem, Pager, SkeletonRows, UserAvatar, toast } from "@/components/ui";
import { errorMessage, resourceId } from "@/lib/api/client";
import { fmtNum, rel } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";
import { useKnowledgeBases, useMemberNames } from "@/modules/knowledge/queries";
import { overviewKeys } from "@/modules/overview/queries";

import { approveRequest, denyRequest, type AccessRequest } from "../api";
import { ACCESS_LABEL } from "../model";
import { peopleKeys, useAccessRequestPages, usePeopleClient } from "../queries";

export const isPending = (r: AccessRequest) => r.state === "OPEN" || r.state === "NEEDS_INFO";

const PAGE = 20;

/** Access requests (preview `requestsTab`): pending requests to collections (Approve · Deny), then Recently decided. */
export function RequestsTab() {
  const { can } = useWorkspace();
  const { qc, ws } = usePeopleClient();
  const query = useAccessRequestPages('state = "OPEN" OR state = "NEEDS_INFO"', "createTime desc", PAGE);
  const decidedQuery = useAccessRequestPages('state = "APPROVED" OR state = "DENIED"', "updateTime desc", PAGE);
  const bases = useKnowledgeBases({ showLocked: true });
  const [busy, setBusy] = useState<string | null>(null);
  const decide = can("members.create");
  const shownRows = [...(query.data?.requests ?? []), ...(decidedQuery.data?.requests ?? [])];
  const names = useMemberNames(shownRows.flatMap((r) => [r.requester, r.assignee]));

  const person = (member: string | undefined) => (member ? names.get(member) || undefined : undefined);
  const baseOf = (r: AccessRequest) => bases.data?.find((b) => b.name === r.collection);
  const sentence = (r: AccessRequest): ReactNode => {
    const base = baseOf(r);
    return (
      <>
        <span className="medium" translate="no">
          {person(r.requester) ?? "Ai đó"}
        </span>{" "}
        muốn có quyền <span className="medium">{ACCESS_LABEL[r.requestedRole ?? ""] ?? "Người xem"}</span> đối với{" "}
        {base ? (
          <Link className="link" href={`/studio/collections/${resourceId(base.name)}?tab=access`} translate="no">
            {base.displayName}
          </Link>
        ) : (
          "một kho tài liệu"
        )}
      </>
    );
  };

  async function act(r: AccessRequest, approve: boolean) {
    const requester = person(r.requester);
    const base = baseOf(r);
    setBusy(r.name ?? "");
    try {
      if (approve) await approveRequest(ws, r.name ?? "");
      else await denyRequest(ws, r.name ?? "");
      // Only the requests list and its badge change; what the requester can now read refetches in the background.
      await Promise.all([qc.invalidateQueries({ queryKey: peopleKeys.requests(ws) }), qc.invalidateQueries({ queryKey: [ws, "shell-badge", "access"] })]);
      void qc.invalidateQueries({ queryKey: [ws, "people", "analysis"] });
      void qc.invalidateQueries({ queryKey: overviewKeys.access(ws) });
      if (approve) toast(`${requester ?? "Người này"} giờ là ${ACCESS_LABEL[r.requestedRole ?? ""] ?? "Người xem"} của ${base?.displayName ?? "kho tài liệu"}`);
      else toast(requester ? `Đã từ chối yêu cầu của ${requester}` : "Đã từ chối yêu cầu", { tone: "accent" });
    } catch (error) {
      toast(errorMessage(error), { tone: "danger" });
    } finally {
      setBusy(null);
    }
  }

  const none = <EmptyState icon={CheckCheck} boxed title="Không có yêu cầu đang chờ" description="Khi có người yêu cầu quyền truy cập kho tài liệu bị hạn chế, yêu cầu sẽ hiện ở đây." />;

  return (
    <Gate query={query} skeleton={<SkeletonRows rows={3} />}>
      {(page) => {
        const pending = page.requests ?? [];
        const decided = decidedQuery.data?.requests ?? [];
        return (
          <>
            {pending.length ? (
              <>
                <List>
                  {pending.map((r) => (
                    <ListItem
                      key={r.name}
                      className="ppl-req"
                      lead={<UserAvatar name={person(r.requester) ?? "?"} />}
                      title={sentence(r)}
                      label={`Yêu cầu truy cập của ${person(r.requester) ?? "Ai đó"}`}
                      description={
                        <>
                          {r.question ? (
                            <q className="ppl-req__note" translate="no">
                              {r.question}
                            </q>
                          ) : null}
                          <span className="ppl-req__time">{rel(r.createTime)}</span>
                        </>
                      }
                      actions={
                        decide ? (
                          <>
                            <Button variant="ghost" size="sm" isDisabled={busy === r.name} onPress={() => void act(r, false)}>
                              Từ chối
                            </Button>
                            <Button variant="secondary" size="sm" isPending={busy === r.name} onPress={() => void act(r, true)}>
                              Phê duyệt
                            </Button>
                          </>
                        ) : null
                      }
                    />
                  ))}
                </List>
                {query.page > 1 || query.hasNext ? (
                  <Pager page={query.page} pageSize={PAGE} total={query.total} pageCount={pending.length} hasNext={query.hasNext} onPageChange={query.setPage} />
                ) : null}
              </>
            ) : (
              none
            )}
            {decided.length ? (
              <div className="mt-24">
                <Disclosure icon={History} title="Đã xử lý gần đây" summary={fmtNum(decidedQuery.total ?? decided.length)}>
                  <List>
                    {decided.map((r) => {
                      const by = person(r.assignee);
                      return (
                        <ListItem
                          key={r.name}
                          className="ppl-req"
                          lead={<UserAvatar name={person(r.requester) ?? "?"} size="sm" />}
                          title={sentence(r)}
                          label={`Yêu cầu truy cập của ${person(r.requester) ?? "Ai đó"}`}
                          description={`${r.state === "APPROVED" ? "Đã phê duyệt" : "Đã từ chối"}${by ? ` bởi ${by}` : ""} · ${rel(r.closeTime ?? r.updateTime)}`}
                        />
                      );
                    })}
                  </List>
                  {decidedQuery.page > 1 || decidedQuery.hasNext ? (
                    <Pager page={decidedQuery.page} pageSize={PAGE} total={decidedQuery.total} pageCount={decided.length} hasNext={decidedQuery.hasNext} onPageChange={decidedQuery.setPage} />
                  ) : null}
                </Disclosure>
              </div>
            ) : null}
          </>
        );
      }}
    </Gate>
  );
}
