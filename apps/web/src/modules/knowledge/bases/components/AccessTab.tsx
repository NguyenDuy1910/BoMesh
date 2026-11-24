"use client";

import { Button, buttonVariants } from "@heroui/react";
import { useQueryClient } from "@tanstack/react-query";
import { AlertCircle, Link, UserPlus, Users, X } from "lucide-react";
import NextLink from "next/link";
import { useState } from "react";

import { Callout } from "@/components/ui/Callout";
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
import { plural, rel } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";
import { InviteLinksDialog } from "@/modules/shares/components/InviteLinksDialog";

import { updateItem } from "../../api";
import { invalidateKnowledge, useMemberNames } from "../../queries";
import { approveRequest, denyRequest, getItemIamPolicy, setItemIamPolicy } from "../api";
import {
  accessInfo,
  GENERAL_ACCESS,
  generalAccessOf,
  ownerCount,
  requestRole,
  ROLE_DESC,
  ROLE_LABEL,
  ROLE_OF,
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
import { ShareDialog, ShareLead, useSharePeople } from "./ShareDialog";

/** "is now an owner" / "a viewer" / "an editor". */
const roleSentence = (role: ShareRole) => (role === "owner" ? "chủ sở hữu" : role === "editor" ? "người chỉnh sửa" : "người xem");

/** Access tab (preview `accessTab(kb)`): access requests, general access, people and groups. Owners only. */
export function AccessTab({ base }: { base: Item }) {
  const { id: ws, workspace, member, can } = useWorkspace();
  const qc = useQueryClient();
  const policy = useBasePolicy(base);
  const requests = usePendingRequestsFor(base);
  const people = useSharePeople(sharesOf(policy.data).map((s) => s.principal));
  const requesters = useMemberNames(requests.data.map((r) => r.requester));
  const [sharing, setSharing] = useState(false);
  const [inviting, setInviting] = useState(false);
  const [rowError, setRowError] = useState<{ principal: string; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const baseName = base.name ?? "";
  const meP = `user:${resourceId(member.user)}`;
  /** Owners decide their collection's requests here; people who manage People decide every request there. */
  const decidesHere = !can("members.create");

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
    toast(accessInfo(next, workspace).long, {
      undo: () => void setGeneral(prev, { quiet: true }),
    });
  }

  async function setRole(s: Share, role: ShareRole, shares: Share[]) {
    if (s.role === "owner" && role !== "owner" && ownerCount(shares) === 1) {
      setRowError({ principal: s.principal, message: "Mỗi kho tài liệu cần có chủ sở hữu. Hãy đặt người khác làm chủ sở hữu trước." });
      return;
    }
    setRowError(null);
    if (await change((p) => withShares(p, [s.principal], role))) toast(`${nameOf(s)} hiện là ${roleSentence(role)}`);
  }

  async function remove(s: Share, shares: Share[]) {
    if (s.role === "owner" && ownerCount(shares) === 1) {
      setRowError({ principal: s.principal, message: "Không gỡ được chủ sở hữu cuối cùng. Hãy đặt người khác làm chủ sở hữu trước." });
      return;
    }
    setRowError(null);
    if (s.principal === meP) {
      const ok = await confirm({
        title: "Tự gỡ quyền truy cập?",
        description: can("workspaces.update") ? "Bạn vẫn quản lý được với vai trò quản trị viên không gian làm việc." : "Bạn sẽ không thể mở trừ khi có người chia sẻ lại.",
        confirmLabel: "Gỡ",
        tone: "danger",
      });
      if (!ok) return;
    }
    if (await change((p) => withShares(p, [s.principal], null))) {
      toast(`Đã gỡ ${nameOf(s)}`, {
        undo: () => void change((p) => withShares(p, [s.principal], s.role)),
      });
    }
  }

  async function decide(r: AccessRequest, approve: boolean) {
    const who = requesters.get(r.requester ?? "") || "request";
    try {
      await (approve ? approveRequest(ws, r.name ?? "") : denyRequest(ws, r.name ?? ""));
      void qc.invalidateQueries({ queryKey: basesKeys.requests(ws) });
      refresh();
      toast(approve ? `Đã phê duyệt ${who}` : `Đã từ chối ${who}`);
    } catch (e) {
      toast(errorMessage(e), { tone: "danger" });
    }
  }

  const nameOf = (s: Share) => people.get(s.principal)?.name ?? (s.kind === "group" ? "Nhóm" : "Ai đó");
  const general = generalAccessOf(base, policy.data);

  return (
    <Gate query={policy} skeleton={<SkeletonRows rows={4} />}>
      {(p) => {
        const shares = sharesOf(p);
        const info = general && general !== "personal" ? accessInfo(general, workspace) : null;
        return (
          <div className="kb-narrow">
            {requests.total && !decidesHere ? (
              <div className="mb-16">
                <Callout
                  tone="warning"
                  icon={UserPlus}
                  title={`${plural(requests.total, "person")} đã yêu cầu quyền truy cập`}
                  description="Bạn xử lý yêu cầu truy cập của mọi kho tài liệu trong mục Người dùng & phân quyền."
                  actions={
                    <NextLink href="/people?tab=requests" className={buttonVariants({ variant: "secondary", size: "sm" })}>
                      Mở các yêu cầu truy cập
                    </NextLink>
                  }
                />
              </div>
            ) : null}
            {requests.data.length && decidesHere ? (
              <Section title="Yêu cầu truy cập">
                <List>
                  {requests.data.map((r) => {
                    const who = requesters.get(r.requester ?? "") || "Ai đó";
                    const role = requestRole(r);
                    return (
                      <ListItem
                        key={r.name}
                        className="kb-req"
                        lead={<UserAvatar name={who} />}
                        title={who}
                        titleExtra={<StatusChip label={ROLE_LABEL[role]} size="sm" dot={false} tooltip={ROLE_DESC[role]} />}
                        description={
                          <>
                            {r.question ? (
                              <span className="kb-req__note" translate="no">
                                “{r.question}”
                              </span>
                            ) : null}
                            <span className="kb-req__when">{rel(r.createTime)}</span>
                          </>
                        }
                        actions={
                          <>
                            <Button size="sm" variant="ghost" onPress={() => void decide(r, false)}>
                              Từ chối
                            </Button>
                            <Button size="sm" variant="secondary" onPress={() => void decide(r, true)}>
                              Phê duyệt
                            </Button>
                          </>
                        }
                      />
                    );
                  })}
                </List>
              </Section>
            ) : null}
            <Section title="Quyền truy cập chung">
              <List>
                <ListItem
                  className="kb-general"
                  lead={info ? <ItemIcon icon={info.icon} /> : null}
                  title={info?.label ?? ""}
                  description={info?.long}
                  actions={
                    <InlineSelect
                      label="Quyền truy cập chung"
                      value={(general === "personal" || !general ? "restricted" : general) as GeneralAccess}
                      isDisabled={busy}
                      options={GENERAL_ACCESS.map((key) => [key, accessInfo(key, workspace).label] as const)}
                      onChange={(v) => void setGeneral(v)}
                    />
                  }
                />
              </List>
            </Section>
            <Section
              title="Người và nhóm"
              description="Quản trị viên không gian làm việc luôn có thể quản lý mọi kho tài liệu."
              actions={
                <>
                  <Button variant="ghost" size="sm" onPress={() => setInviting(true)}>
                    <Link className="i" aria-hidden />
                    Liên kết mời
                  </Button>
                  <Button variant="secondary" size="sm" onPress={() => setSharing(true)}>
                    <UserPlus className="i" aria-hidden />
                    Chia sẻ
                  </Button>
                </>
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
                        className="kb-share-row"
                        lead={<ShareLead who={{ kind: s.kind, name }} />}
                        title={
                          <span>
                            {name}
                            {s.principal === meP ? (
                              <span className="muted" style={{ fontWeight: 400 }}>
                                {" "}
                                (bạn)
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
                              label={`Vai trò của ${name}`}
                              value={s.role}
                              isDisabled={busy}
                              options={ROLES.map((r) => [r, ROLE_LABEL[r]] as const)}
                              onChange={(role) => void setRole(s, role, shares)}
                            />
                            <IconButton icon={X} tip={`Gỡ ${name}`} size="sm" isDisabled={busy} onPress={() => void remove(s, shares)} />
                          </>
                        }
                      />
                    );
                  })}
                </List>
              ) : (
                <EmptyState icon={Users} boxed compact title="Chưa chia sẻ với ai" description="Chia sẻ để cấp quyền chỉnh sửa hoặc chủ sở hữu." />
              )}
            </Section>
            <ShareDialog
              baseName={base.displayName ?? ""}
              shares={shares}
              isOpen={sharing}
              onClose={() => setSharing(false)}
              onShare={async (principals, role, names) => {
                const ok = await change((cur) => withShares(cur, principals, role));
                if (ok) toast(`Đã chia sẻ với ${names.length === 1 ? names[0] : `${names.length} người và nhóm`}`);
                return ok;
              }}
            />
            <InviteLinksDialog
              target={baseName}
              scopeName={base.displayName ?? ""}
              roles={(["viewer", "editor"] as const).map((r) => ({ name: ROLE_OF[r], label: ROLE_LABEL[r] }))}
              defaultRole={ROLE_OF.viewer}
              isOpen={inviting}
              onClose={() => setInviting(false)}
            />
          </div>
        );
      }}
    </Gate>
  );
}
