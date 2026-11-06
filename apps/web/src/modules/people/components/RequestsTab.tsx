"use client";

import { Button } from "@heroui/react";
import { CheckCheck, ChevronDown, ChevronRight } from "lucide-react";
import Link from "next/link";
import { useState, type ReactNode } from "react";

import { EmptyState, Gate, List, ListItem, SkeletonRows, StatusChip, UserAvatar, toast } from "@/components/ui";
import { errorMessage, resourceId } from "@/lib/api/client";
import { rel } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";
import { useKnowledgeBases } from "@/modules/knowledge/queries";

import { approveRequest, denyRequest, type AccessRequest } from "../api";
import { firstName } from "../model";
import { useAccessRequestsQuery, usePeopleClient, type Directory } from "../queries";

const ACCESS: Record<string, string> = { "roles/collectionViewer": "Viewer", "roles/collectionEditor": "Editor", "roles/collectionOwner": "Owner" };

export const isPending = (r: AccessRequest) => r.state === "OPEN" || r.state === "NEEDS_INFO";

/** Requests tab (preview `requestsTab`): pending access requests, approve/deny, recently decided. */
export function RequestsTab({ dir }: { dir: Directory | undefined }) {
  const { can } = useWorkspace();
  const { ws, refresh } = usePeopleClient();
  const query = useAccessRequestsQuery();
  const bases = useKnowledgeBases({ showLocked: true });
  const [open, setOpen] = useState(false);
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
        wants <span className="medium">{ACCESS[r.requestedRole ?? ""] ?? "Viewer"}</span> access to{" "}
        {base ? (
          <Link className="link" href={`/knowledge/${resourceId(base.name)}`} translate="no">
            {base.displayName}
          </Link>
        ) : (
          "a knowledge base"
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
      await refresh();
      if (approve) toast(`${requester?.displayName ?? "They"} can now ${r.requestedRole === "roles/collectionEditor" ? "edit" : "view"} ${base?.displayName ?? "it"}`);
      else toast(requester ? `Denied ${firstName(requester.displayName)}’s request` : "Request denied", { tone: "accent" });
    } catch (error) {
      toast(errorMessage(error), { tone: "danger" });
    } finally {
      setBusy(null);
    }
  }

  const none = <EmptyState icon={CheckCheck} boxed title="No pending requests" description="When someone asks for access to a restricted knowledge base, it shows up here." />;

  return (
    <Gate query={query} skeleton={<SkeletonRows rows={3} />}>
      {(all) => {
        const pending = all.filter(isPending);
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
                          <Button variant="primary" size="sm" isPending={busy === r.name} onPress={() => void act(r, true)}>
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
                <Button variant="ghost" size="sm" aria-expanded={open} onPress={() => setOpen((o) => !o)}>
                  {open ? <ChevronDown className="i" aria-hidden /> : <ChevronRight className="i" aria-hidden />}
                  Recently decided · {decided.length}
                </Button>
                {open ? (
                  <div className="mt-8">
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
                            actions={<StatusChip kind="request" value={r.state === "APPROVED" ? "approved" : "denied"} />}
                          />
                        );
                      })}
                    </List>
                  </div>
                ) : null}
              </div>
            ) : null}
          </>
        );
      }}
    </Gate>
  );
}
