"use client";

import { Button } from "@heroui/react";
import { CheckCheck, History } from "lucide-react";
import Link from "next/link";
import { useState, type ReactNode } from "react";

import { Disclosure, EmptyState, Gate, List, ListItem, SkeletonRows, UserAvatar, toast } from "@/components/ui";
import { errorMessage, resourceId } from "@/lib/api/client";
import { fmtNum, rel } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";
import { useKnowledgeBases } from "@/modules/knowledge/queries";
import { overviewKeys } from "@/modules/overview/queries";

import { approveRequest, denyRequest, type AccessRequest } from "../api";
import { ACCESS_LABEL } from "../model";
import { peopleKeys, useAccessRequestsQuery, usePeopleClient, type Directory } from "../queries";

export const isPending = (r: AccessRequest) => r.state === "OPEN" || r.state === "NEEDS_INFO";

/** Access requests (preview `requestsTab`): pending requests to collections (Approve · Deny), then Recently decided. */
export function RequestsTab({ dir }: { dir: Directory | undefined }) {
  const { can } = useWorkspace();
  const { qc, ws } = usePeopleClient();
  const query = useAccessRequestsQuery();
  const bases = useKnowledgeBases({ showLocked: true });
  const [busy, setBusy] = useState<string | null>(null);
  const decide = can("members.create");

  const person = (member: string | undefined) => (member ? dir?.personById.get(resourceId(member)) : undefined);
  const baseOf = (r: AccessRequest) => bases.data?.find((b) => b.name === r.collection);
  const sentence = (r: AccessRequest): ReactNode => {
    const base = baseOf(r);
    return (
      <>
        <span className="medium" translate="no">
          {person(r.requester)?.displayName ?? "Someone"}
        </span>{" "}
        wants <span className="medium">{ACCESS_LABEL[r.requestedRole ?? ""] ?? "Viewer"}</span> access to{" "}
        {base ? (
          <Link className="link" href={`/studio/collections/${resourceId(base.name)}?tab=access`} translate="no">
            {base.displayName}
          </Link>
        ) : (
          "a collection"
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
      if (approve) toast(`${requester?.displayName ?? "They"} is now ${ACCESS_LABEL[r.requestedRole ?? ""] ?? "Viewer"} on ${base?.displayName ?? "it"}`);
      else toast(requester ? `Denied ${requester.displayName}’s request` : "Request denied", { tone: "accent" });
    } catch (error) {
      toast(errorMessage(error), { tone: "danger" });
    } finally {
      setBusy(null);
    }
  }

  const none = <EmptyState icon={CheckCheck} boxed title="No pending requests" description="When someone asks for access to a restricted collection, it shows up here." />;

  return (
    <Gate query={query} skeleton={<SkeletonRows rows={3} />}>
      {(all) => {
        const pending = all.filter(isPending).sort((a, b) => Date.parse(b.createTime ?? "") - Date.parse(a.createTime ?? ""));
        const decided = all
          .filter((r) => r.state === "APPROVED" || r.state === "DENIED")
          .sort((a, b) => Date.parse(b.closeTime ?? b.updateTime ?? "") - Date.parse(a.closeTime ?? a.updateTime ?? ""));
        return (
          <>
            {pending.length ? (
              <List>
                {pending.map((r) => (
                  <ListItem
                    key={r.name}
                    className="ppl-req"
                    lead={<UserAvatar name={person(r.requester)?.displayName ?? "?"} />}
                    title={sentence(r)}
                    label={`${person(r.requester)?.displayName ?? "Someone"} access request`}
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
                            Deny
                          </Button>
                          <Button variant="secondary" size="sm" isPending={busy === r.name} onPress={() => void act(r, true)}>
                            Approve
                          </Button>
                        </>
                      ) : null
                    }
                  />
                ))}
              </List>
            ) : (
              none
            )}
            {decided.length ? (
              <div className="mt-24">
                <Disclosure icon={History} title="Recently decided" summary={fmtNum(decided.length)}>
                  <List>
                    {decided.map((r) => {
                      const by = person(r.assignee)?.displayName;
                      return (
                        <ListItem
                          key={r.name}
                          className="ppl-req"
                          lead={<UserAvatar name={person(r.requester)?.displayName ?? "?"} size="sm" />}
                          title={sentence(r)}
                          label={`${person(r.requester)?.displayName ?? "Someone"} access request`}
                          description={`${r.state === "APPROVED" ? "Approved" : "Denied"}${by ? ` by ${by}` : ""} · ${rel(r.closeTime ?? r.updateTime)}`}
                        />
                      );
                    })}
                  </List>
                </Disclosure>
              </div>
            ) : null}
          </>
        );
      }}
    </Gate>
  );
}
