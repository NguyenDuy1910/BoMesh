"use client";

import { Button, Checkbox } from "@heroui/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, CircleAlert, Link, UserPlus, X } from "lucide-react";
import { useState, type ReactNode } from "react";

import { Gate, List, ListItem, NoMatches, Pager, SearchInput, Section, Segmented, SkeletonRows, StatusChip, UserAvatar, toast } from "@/components/ui";
import { errorMessage, resourceId } from "@/lib/api/client";
import { SEARCH_PAUSE_MS, useDebounced } from "@/lib/debounce";
import { plural, rel } from "@/lib/format";
import { useTokenPages } from "@/lib/paging";
import { useWorkspace } from "@/lib/workspace";
import { batchGetMembers } from "@/modules/knowledge/api";
import { KnowledgeModal } from "@/modules/knowledge/components/KnowledgeModal";
import { useMemberNames } from "@/modules/knowledge/queries";
import { listMemberPage } from "@/modules/people/api";
import { literal, memberSearch } from "@/modules/people/model";
import { InviteLinksDialog } from "@/modules/shares/components/InviteLinksDialog";

import { createSpaceMember, decideRequest, deleteSpaceMember, joinSpace, leaveSpace, listSpaceMemberPage, setSpaceRole, type Request, type SpaceMember } from "../api";
import { invalidateSpaces, spacesKeys, useJoinRequestPages, useSpaceMemberPages } from "../queries";
import { LEAD, MEMBER, defaultRole, inSentence, isStaffRole, roleLabel, topRole, type SpaceRole } from "../types";
import { TOOLS_MIN, type SpaceView } from "./context";
import { Menu } from "./Menu";

const PAGE = 50;
const JOIN_PAGE = 20;
const PICK_PAGE = 20;

/** People (preview `peopleTab`): members by role, requests to join, add people, change roles, remove. */
export function PeopleTab({ view }: { view: SpaceView }) {
  const { id: ws, memberId } = useWorkspace();
  const qc = useQueryClient();
  const { space, sid, type, can } = view;
  const [q, setQ] = useState("");
  const needle = useDebounced(q.trim(), SEARCH_PAUSE_MS);
  const members = useSpaceMemberPages(sid, { filter: needle ? `displayName = ${literal(`*${needle}*`)}` : "", pageSize: PAGE });
  // The last-lead guard needs only whether another lead remains.
  const leadPage = useSpaceMemberPages(sid, { filter: `roles:${literal(LEAD)}`, pageSize: 2 });
  const canRole = can("spaces.setIamPolicy");
  const canDecide = can("requests.approve");
  const joins = useJoinRequestPages(sid, JOIN_PAGE, canDecide);
  const [adding, setAdding] = useState(false);
  const [inviting, setInviting] = useState(false);

  const all = members.data?.members ?? [];
  // Emails of the members on this page: one batch read.
  const ids = all.map((m) => resourceId(m.name)).sort();
  const emails = useQuery({
    queryKey: [...spacesKeys.members(ws, sid), "emails", ids],
    queryFn: async () => new Map((await batchGetMembers(ws, ids)).map((m) => [resourceId(m.name), m.email ?? ""])),
    enabled: ids.length > 0,
    staleTime: 60_000,
  });
  const email = emails.data ?? new Map<string, string>();
  const order = (m: SpaceMember) => {
    const r = topRole(m.roles);
    const i = type.roles.findIndex((x) => x[0] === r);
    return i < 0 ? 99 : i;
  };
  const leads = leadPage.total ?? leadPage.data?.members?.length ?? 0;
  // The server pages by name; each page lists its people by role, then name.
  const rows = [...all].sort((a, b) => order(a) - order(b) || (a.displayName ?? "").localeCompare(b.displayName ?? ""));
  const leadLabel = inSentence(roleLabel(type, LEAD));

  /** The space keeps at least one lead (the API refuses with LAST_SPACE_LEAD). */
  function guardLastLead(m: SpaceMember, next: SpaceRole | null): boolean {
    if (topRole(m.roles) === LEAD && next !== LEAD && leads <= 1) {
      toast(`${space.displayName} cần ít nhất một ${leadLabel}. Hãy thêm người khác trước.`, { tone: "danger" });
      return false;
    }
    return true;
  }
  const refresh = () => invalidateSpaces(qc, ws);
  const fail = (e: unknown) => toast(errorMessage(e), { tone: "danger" });

  async function changeRole(m: SpaceMember, role: SpaceRole, label: string) {
    const prev = topRole(m.roles) ?? MEMBER;
    if (prev === role || !guardLastLead(m, role)) return;
    try {
      await setSpaceRole(ws, sid, [m.member ?? m.name ?? ""], role);
      void refresh();
      toast(`${m.displayName} hiện là ${inSentence(label)}`, {
        undo: () => void setSpaceRole(ws, sid, [m.member ?? m.name ?? ""], prev).then(refresh).catch(fail),
      });
    } catch (e) {
      fail(e);
    }
  }

  async function remove(m: SpaceMember) {
    if (!guardLastLead(m, null)) return;
    const you = resourceId(m.name) === memberId;
    const prev = topRole(m.roles) ?? MEMBER;
    try {
      if (you) await leaveSpace(ws, sid);
      else await deleteSpaceMember(ws, sid, resourceId(m.name));
      void refresh();
      const restore = async () => {
        if (you) await joinSpace(ws, sid);
        else await createSpaceMember(ws, sid, resourceId(m.name));
        if (prev !== MEMBER) await setSpaceRole(ws, sid, [resourceId(m.name)], prev);
      };
      const undoable = !you || space.joinPolicy === "OPEN";
      toast(you ? `Bạn đã rời ${space.displayName}` : `Đã gỡ ${m.displayName}`, undoable ? { undo: () => void restore().then(refresh).catch(fail) } : {});
    } catch (e) {
      fail(e);
    }
  }

  async function decide(r: Request, approve: boolean, name: string) {
    try {
      await decideRequest(r.name ?? "", approve ? "approve" : "deny");
      const role = defaultRole(type);
      if (approve && role !== MEMBER) await setSpaceRole(ws, sid, [r.requester ?? ""], role);
      void refresh();
      toast(approve ? `${name} đã tham gia ${space.displayName}` : `Đã từ chối yêu cầu của ${name}`);
    } catch (e) {
      fail(e);
    }
  }

  // Search appears for the space's real size (not just who's loaded), so anyone in it can be found.
  const search = Math.max(space.memberCount ?? 0, members.total ?? all.length) >= TOOLS_MIN || q;
  const canAdd = can("spaceMembers.create");
  /** An invite grants a space role, so it takes what changing roles takes (setIamPolicy on the space). */
  const canInvite = canRole;

  return (
    <>
      {canDecide && joins.data?.requests?.length ? (
        <>
          <JoinRequests
            requests={joins.data.requests}
            description={`Người được phê duyệt sẽ tham gia với vai trò ${inSentence(roleLabel(type, defaultRole(type)))}.`}
            onDecide={decide}
            pager={
              joins.page > 1 || joins.hasNext ? (
                <Pager page={joins.page} pageSize={JOIN_PAGE} total={joins.total} pageCount={joins.data.requests.length} hasNext={joins.hasNext} onPageChange={joins.setPage} />
              ) : null
            }
          />
          <div className="mt-32" />
        </>
      ) : null}
      {search || canAdd || canInvite ? (
        <div className="toolbar">
          {search ? <SearchInput value={q} onChange={setQ} placeholder="Tìm kiếm người" /> : null}
          <div className="toolbar__end">
            {canInvite ? (
              <Button variant="ghost" onPress={() => setInviting(true)}>
                <Link aria-hidden />
                Liên kết mời
              </Button>
            ) : null}
            {canAdd ? (
              <Button variant="tertiary" onPress={() => setAdding(true)}>
                <UserPlus aria-hidden />
                Thêm người
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
      {canInvite ? (
        <InviteLinksDialog
          target={`workspaces/${ws}/spaces/${sid}`}
          scopeName={space.displayName ?? ""}
          roles={type.roles.map(([name, label]) => ({ name, label }))}
          defaultRole={defaultRole(type)}
          isOpen={inviting}
          onClose={() => setInviting(false)}
        />
      ) : null}
      <Gate query={members} skeleton={<SkeletonRows rows={5} />} isEmpty={!rows.length && members.page === 1} empty={<NoMatches what="người" onClear={() => setQ("")} />}>
        <List>
          {rows.map((m) => {
            const name = m.displayName ?? "Ai đó";
            const you = resourceId(m.name) === memberId;
            const role = topRole(m.roles);
            const label = roleLabel(type, role);
            let trail;
            if (canRole) {
              trail = (
                <Menu
                  label={`${name}: ${label}`}
                  nodes={[
                    {
                      section: "Vai trò",
                      items: type.roles.map(([key, l]) => ({ id: key, label: l, checked: role === key, run: () => void changeRole(m, key, l) })),
                    },
                    { sep: "1" },
                    { id: "remove", label: you ? "Rời cộng đồng" : "Gỡ khỏi cộng đồng", icon: X, danger: true, run: () => void remove(m) },
                  ]}
                >
                  <Button variant="ghost" size="sm" aria-label={`${name}: ${label}. Đổi vai trò`}>
                    {label}
                    <ChevronDown aria-hidden />
                  </Button>
                </Menu>
              );
            } else {
              trail = (
                <>
                  <StatusChip label={label} tone={isStaffRole(role) ? "accent" : "default"} size="sm" dot={false} />
                  {you ? (
                    <Button variant="ghost" size="sm" onPress={() => void remove(m)}>
                      Rời khỏi
                    </Button>
                  ) : null}
                </>
              );
            }
            return (
              <ListItem
                key={m.name}
                lead={<UserAvatar name={name} />}
                title={name}
                contentTitle
                titleExtra={you ? <StatusChip label="Bạn" size="sm" dot={false} /> : null}
                description={email.get(resourceId(m.name)) || undefined}
                actions={trail}
              />
            );
          })}
        </List>
        {members.page > 1 || members.hasNext ? (
          <Pager page={members.page} pageSize={PAGE} total={members.total} pageCount={rows.length} hasNext={members.hasNext} onPageChange={members.setPage} />
        ) : null}
      </Gate>
      {adding ? <AddPeopleDialog view={view} onClose={() => setAdding(false)} /> : null}
    </>
  );
}

function JoinRequests({
  requests,
  description,
  onDecide,
  pager,
}: {
  requests: readonly Request[];
  description: string;
  onDecide: (r: Request, approve: boolean, name: string) => Promise<void>;
  pager: ReactNode;
}) {
  const names = useMemberNames(requests.map((r) => r.requester));
  const [busy, setBusy] = useState<string | null>(null);
  return (
    <Section title="Yêu cầu tham gia" description={description}>
      <List>
        {requests.map((r) => {
          const name = names.get(r.requester ?? "") || "Ai đó";
          const note = typeof r.fields?.note === "string" ? r.fields.note : "";
          const run = (approve: boolean) => {
            setBusy(`${r.name}:${approve}`);
            void onDecide(r, approve, name).finally(() => setBusy(null));
          };
          return (
            <ListItem
              key={r.name}
              lead={<UserAvatar name={name} />}
              title={name}
              contentTitle
              description={note ? <span translate="no">{note}</span> : "Không có ghi chú"}
              meta={rel(r.createTime)}
              actions={
                <>
                  <Button variant="ghost" size="sm" onPress={() => run(false)} isPending={busy === `${r.name}:false`} isDisabled={!!busy}>
                    Từ chối
                  </Button>
                  <Button variant="secondary" size="sm" onPress={() => run(true)} isPending={busy === `${r.name}:true`} isDisabled={!!busy}>
                    Phê duyệt
                  </Button>
                </>
              }
            />
          );
        })}
      </List>
      {pager}
    </Section>
  );
}

/** Add people (preview `M['sp-add']`): pick workspace members, choose their role. */
function AddPeopleDialog({ view, onClose }: { view: SpaceView; onClose: () => void }) {
  const { id: ws } = useWorkspace();
  const qc = useQueryClient();
  const { type, sid, space } = view;
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<string[]>([]);
  const [picked, setPicked] = useState<ReadonlyMap<string, string>>(new Map());
  const [role, setRole] = useState<SpaceRole>(defaultRole(type));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const needle = useDebounced(q.trim(), SEARCH_PAUSE_MS);
  const filter = [memberSearch(needle), 'state = "ACTIVE"'].filter(Boolean).join(" AND ");
  const people = useTokenPages([ws, "members", "spacePicker", filter], (pageToken) => listMemberPage(ws, { filter, orderBy: "displayName", pageSize: PICK_PAGE, pageToken }));
  const page = people.data?.members ?? [];
  // Who on this page is already in the space: one ListSpaceMembers read by name.
  const pageIds = page.map((p) => resourceId(p.name)).sort();
  const existing = useQuery({
    queryKey: [...spacesKeys.members(ws, sid), "among", pageIds],
    queryFn: async () => {
      const byName = pageIds.map((m) => `member = ${literal(`workspaces/${ws}/members/${m}`)}`).join(" OR ");
      const found = await listSpaceMemberPage(ws, sid, { filter: byName, pageSize: pageIds.length });
      return new Set((found.members ?? []).map((m) => resourceId(m.member)));
    },
    enabled: pageIds.length > 0,
  });
  const inSpace = existing.data;
  const cands = inSpace ? page.filter((p) => !inSpace.has(resourceId(p.name))) : [];

  async function add() {
    if (!sel.length) {
      setErr("Chọn ít nhất một người.");
      return;
    }
    setBusy(true);
    try {
      await Promise.all(sel.map((m) => createSpaceMember(ws, sid, m)));
      if (role !== MEMBER) await setSpaceRole(ws, sid, sel, role);
      void invalidateSpaces(qc, ws);
      onClose();
      const first = picked.get(sel[0]) || "1 người";
      const added = [...sel];
      toast(added.length === 1 ? `Đã thêm ${first}` : `Đã thêm ${plural(added.length, "person")}`, {
        undo: () =>
          void Promise.all(added.map((m) => deleteSpaceMember(ws, sid, m)))
            .then(() => invalidateSpaces(qc, ws))
            .catch((e) => toast(errorMessage(e), { tone: "danger" })),
      });
    } catch (e) {
      toast(errorMessage(e), { tone: "danger" });
      void invalidateSpaces(qc, ws);
      setBusy(false);
    }
  }

  return (
    <KnowledgeModal
      isOpen
      onClose={onClose}
      guard={busy}
      icon={UserPlus}
      title={`Thêm người vào ${space.displayName}`}
      description="Họ có thể mở cộng đồng, tài liệu và công việc của cộng đồng ngay lập tức."
      footerStart={<span>{sel.length ? `Đã chọn ${plural(sel.length, "person")}` : "Bạn có thể đổi vai trò sau."}</span>}
      footer={
        <>
          <Button variant="ghost" onPress={onClose} isDisabled={busy}>
            Hủy
          </Button>
          <Button variant="primary" onPress={() => void add()} isPending={busy}>
            <UserPlus aria-hidden />
            {sel.length ? `Thêm ${plural(sel.length, "person")}` : "Thêm người"}
          </Button>
        </>
      }
    >
      <SearchInput value={q} onChange={setQ} placeholder="Tìm theo tên hoặc email" fullWidth autoFocus />
      {people.isPending || (pageIds.length > 0 && existing.isPending) ? (
        <div className="mt-12">
          <SkeletonRows rows={3} />
        </div>
      ) : cands.length ? (
        <div className="option-list sp-options mt-12" role="group" aria-label="Thành viên">
          {cands.map((p) => {
            const pid = resourceId(p.name);
            return (
              <Checkbox
                key={p.name}
                className="checkbox"
                isSelected={sel.includes(pid)}
                onChange={(on) => {
                  setErr("");
                  setSel(on ? [...sel, pid] : sel.filter((x) => x !== pid));
                  setPicked(new Map(picked).set(pid, p.displayName ?? ""));
                }}
              >
                <Checkbox.Content className="checkbox__label">
                  <Checkbox.Control>
                    <Checkbox.Indicator />
                  </Checkbox.Control>
                  <span className="sp-opt">
                    <UserAvatar name={p.displayName ?? p.email ?? ""} size="sm" />
                    <span className="sp-opt__text">
                      <span className="sp-opt__title truncate" translate="no">
                        {p.displayName}
                      </span>
                      <span className="sp-opt__meta truncate">{p.email}</span>
                    </span>
                  </span>
                </Checkbox.Content>
              </Checkbox>
            );
          })}
        </div>
      ) : people.page === 1 && !people.hasNext ? (
        <p className="t-sm muted sp-options__empty">{needle ? "Không có ai phù hợp. Hãy thử tên khác." : "Mọi thành viên trong không gian làm việc đều đã ở đây."}</p>
      ) : null}
      {people.page > 1 || people.hasNext ? (
        <Pager page={people.page} pageSize={PICK_PAGE} total={people.total} pageCount={page.length} hasNext={people.hasNext} onPageChange={people.setPage} />
      ) : null}
      {err ? (
        <div className="field-error mt-8" role="alert">
          <CircleAlert className="i" aria-hidden />
          <span>{err}</span>
        </div>
      ) : null}
      <div className="field sp-role-field mt-16">
        <span className="label">Thêm với vai trò</span>
        <Segmented label="Thêm với vai trò" value={role} onChange={setRole} options={type.roles.map(([value, label]) => ({ value, label }))} />
      </div>
    </KnowledgeModal>
  );
}
