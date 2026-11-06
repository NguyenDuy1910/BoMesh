"use client";

import { Button } from "@heroui/react";
import { useQueryClient } from "@tanstack/react-query";
import { AlertCircle, Globe, Lock, UserPlus, Users, X } from "lucide-react";
import { useState } from "react";

import { confirm } from "@/components/ui/Confirm";
import { EmptyState } from "@/components/ui/EmptyState";
import { Gate } from "@/components/ui/Gate";
import { IconButton } from "@/components/ui/IconButton";
import { ItemIcon } from "@/components/ui/ItemIcon";
import { List, ListItem } from "@/components/ui/List";
import { Section } from "@/components/ui/Section";
import { SkeletonRows } from "@/components/ui/SkeletonRows";
import { StatusChip } from "@/components/ui/StatusChip";
import { toast } from "@/components/ui/Toast";
import { UserAvatar } from "@/components/ui/UserAvatar";
import { errorMessage, resourceId } from "@/lib/api/client";
import { rel } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";

import { updateItem } from "../../api";
import { invalidateKnowledge, useMemberNames } from "../../queries";
import { approveRequest, denyRequest, getItemIamPolicy, setItemIamPolicy } from "../api";
import {
  accessInfo,
  generalAccessOf,
  ownerCount,
  requestRole,
  ROLE_LABEL,
  ROLES,
  sharesOf,
  withGeneralAccess,
  withShares,
  type AccessRequest,
  type GeneralAccess,
  type Item,
  type Policy,
  type Share,
  type ShareRole,
} from "../model";
import { basesKeys, useBasePolicy, usePendingRequestsFor } from "../queries";
import { InlineSelect } from "./InlineSelect";
import { useBaseSpace } from "./parts";
import { ShareDialog, ShareLead, useSharePeople } from "./ShareDialog";

/** "is now an owner" / "a viewer" / "an editor". */
const roleSentence = (role: ShareRole) => (role === "owner" ? "an owner" : role === "editor" ? "an editor" : "a viewer");

/** Access tab (preview `accessTab(kb)`): requests, general access, people and groups. Owners only. */
export function AccessTab({ base }: { base: Item }) {
  const { id: ws, workspace, member, can } = useWorkspace();
  const qc = useQueryClient();
  const policy = useBasePolicy(base);
  const requests = usePendingRequestsFor(base);
  const people = useSharePeople();
  const requesters = useMemberNames(requests.data.map((r) => r.requester));
  const space = useBaseSpace(base);
  const [sharing, setSharing] = useState(false);
  const [rowError, setRowError] = useState<{ principal: string; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const baseName = base.name ?? "";
  const meP = `user:${resourceId(member.user)}`;

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: basesKeys.policy(ws, resourceId(baseName)) });
    invalidateKnowledge(qc, ws);
  };

  /** Read–modify–write on the latest policy (avoids stale etags). */
  async function change(update: (p: Policy) => Policy): Promise<boolean> {
    setBusy(true);
    try {
      const fresh = await getItemIamPolicy(ws, baseName);
      const saved = await setItemIamPolicy(ws, baseName, update(fresh));
      qc.setQueryData(basesKeys.policy(ws, resourceId(baseName)), saved);
      refresh();
      return true;
    } catch (e) {
      toast(errorMessage(e), { tone: "danger" });
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function setGeneral(next: GeneralAccess, { quiet = false }: { quiet?: boolean } = {}) {
    const prev = generalAccessOf(base, policy.data) as GeneralAccess;
    const discoverable = next !== "private";
    try {
      if ((base.collection?.discoverable !== false) !== discoverable) {
        await updateItem(ws, baseName, { collection: { discoverable } }, ["collection.discoverable"]);
      }
    } catch (e) {
      toast(errorMessage(e), { tone: "danger" });
      return;
    }
    const ok = await change((p) => withGeneralAccess(p, next));
    if (!ok || quiet) return;
    toast(accessInfo(next, workspace.displayName ?? "", space?.displayName).long, {
      undo: () => void setGeneral(prev, { quiet: true }).then(() => toast("Access restored")),
    });
  }

  async function setRole(s: Share, role: ShareRole, shares: Share[]) {
    if (s.role === "owner" && role !== "owner" && ownerCount(shares) === 1) {
      setRowError({ principal: s.principal, message: "Every knowledge base needs an owner. Make someone else an owner first." });
      return;
    }
    setRowError(null);
    if (await change((p) => withShares(p, [s.principal], role))) toast(`${nameOf(s)} is now ${roleSentence(role)}`);
  }

  async function remove(s: Share, shares: Share[]) {
    if (s.role === "owner" && ownerCount(shares) === 1) {
      setRowError({ principal: s.principal, message: "You can’t remove the last owner. Make someone else an owner first." });
      return;
    }
    setRowError(null);
    if (s.principal === meP) {
      const ok = await confirm({
        title: "Remove your access?",
        description: can("workspaces.update") ? "You’ll still manage it as a workspace admin." : "You won’t be able to open it unless someone shares it again.",
        confirmLabel: "Remove",
        tone: "danger",
      });
      if (!ok) return;
    }
    if (await change((p) => withShares(p, [s.principal], null))) {
      toast(`Removed ${nameOf(s)}`, {
        undo: () => void change((p) => withShares(p, [s.principal], s.role)).then((ok) => ok && toast(`Restored ${nameOf(s)}`)),
      });
    }
  }

  async function decide(r: AccessRequest, approve: boolean) {
    const who = requesters.get(r.requester ?? "") || "request";
    try {
      await (approve ? approveRequest(ws, r.name ?? "") : denyRequest(ws, r.name ?? ""));
      void qc.invalidateQueries({ queryKey: basesKeys.requests(ws) });
      refresh();
      toast(approve ? `Approved ${who}` : `Denied ${who}`);
    } catch (e) {
      toast(errorMessage(e), { tone: "danger" });
    }
  }

  const nameOf = (s: Share) => people.get(s.principal)?.name ?? (s.kind === "group" ? "Group" : "Someone");
  const general = generalAccessOf(base, policy.data);

  return (
    <Gate query={policy} skeleton={<SkeletonRows rows={4} />}>
      {(p) => {
        const shares = sharesOf(p);
        const info = general && general !== "personal" ? accessInfo(general, workspace.displayName ?? "", space?.displayName) : null;
        return (
          <div className="kb-narrow">
            {requests.data.length ? (
              <Section title="Requests">
                <List>
                  {requests.data.map((r) => {
                    const who = requesters.get(r.requester ?? "") || "Someone";
                    return (
                      <ListItem
                        key={r.name}
                        lead={<UserAvatar name={who} />}
                        title={who}
                        titleExtra={<StatusChip label={requestRole(r) === "editor" ? "Edit" : "View"} size="sm" dot={false} />}
                        description={
                          <>
                            {r.question ? (
                              <>
                                “<span translate="no">{r.question}</span>” ·{" "}
                              </>
                            ) : null}
                            {rel(r.createTime)}
                          </>
                        }
                        actions={
                          <>
                            <Button size="sm" variant="ghost" onPress={() => void decide(r, false)}>
                              Deny
                            </Button>
                            <Button size="sm" variant="secondary" onPress={() => void decide(r, true)}>
                              Approve
                            </Button>
                          </>
                        }
                      />
                    );
                  })}
                </List>
              </Section>
            ) : null}
            <Section title="General access">
              <List>
                <ListItem
                  lead={<ItemIcon icon={general === "workspace" ? Globe : Lock} />}
                  title={info?.label ?? ""}
                  description={info?.long}
                  actions={
                    <InlineSelect
                      label="General access"
                      value={(general === "personal" || !general ? "restricted" : general) as GeneralAccess}
                      isDisabled={busy}
                      options={[
                        ["workspace", `Everyone in ${workspace.displayName ?? ""}`],
                        ["restricted", "Only people added"],
                        ["private", "Only owners"],
                      ]}
                      onChange={(v) => void setGeneral(v)}
                    />
                  }
                />
              </List>
            </Section>
            <Section
              title="People and groups"
              description="Workspace admins can always manage every knowledge base."
              actions={
                <Button variant="secondary" onPress={() => setSharing(true)}>
                  <UserPlus className="i" aria-hidden />
                  Share
                </Button>
              }
            >
              {shares.length ? (
                <List>
                  {shares.map((s) => {
                    const who = people.get(s.principal);
                    const name = nameOf(s);
                    const err = rowError?.principal === s.principal ? rowError.message : "";
                    return (
                      <ListItem
                        key={s.principal}
                        lead={<ShareLead who={{ kind: s.kind, name }} />}
                        title={
                          <span>
                            {name}
                            {s.principal === meP ? (
                              <span className="muted" style={{ fontWeight: 400 }}>
                                {" "}
                                (you)
                              </span>
                            ) : null}
                          </span>
                        }
                        description={
                          <>
                            {who?.sub}
                            {err ? (
                              <span className="field-error mt-4" role="alert">
                                <AlertCircle className="i" aria-hidden />
                                <span>{err}</span>
                              </span>
                            ) : null}
                          </>
                        }
                        actions={
                          <>
                            <InlineSelect
                              label={`Role for ${name}`}
                              value={s.role}
                              isDisabled={busy}
                              options={ROLES.map((r) => [r, ROLE_LABEL[r]] as const)}
                              onChange={(role) => void setRole(s, role, shares)}
                            />
                            <IconButton icon={X} tip={`Remove ${name}`} size="sm" isDisabled={busy} onPress={() => void remove(s, shares)} />
                          </>
                        }
                      />
                    );
                  })}
                </List>
              ) : (
                <EmptyState icon={Users} boxed compact title="Not shared with anyone yet" description="Share it to give people edit or owner rights." />
              )}
            </Section>
            <ShareDialog
              baseName={base.displayName ?? ""}
              shares={shares}
              isOpen={sharing}
              onClose={() => setSharing(false)}
              onShare={async (principals, role, names) => {
                const ok = await change((cur) => withShares(cur, principals, role));
                if (ok) toast(`Shared with ${names.length === 1 ? names[0] : `${names.length} people and groups`}`);
                return ok;
              }}
            />
          </div>
        );
      }}
    </Gate>
  );
}
