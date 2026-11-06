"use client";

import { Button, Checkbox, Label, ListBox, Select } from "@heroui/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, UserPlus, X } from "lucide-react";
import { useState } from "react";

import { Gate, List, ListItem, NoMatches, SearchInput, Section, SkeletonRows, StatusChip, UserAvatar, toast } from "@/components/ui";
import { errorMessage, resourceId } from "@/lib/api/client";
import { fmtNum, plural, rel } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";
import { KnowledgeModal } from "@/modules/knowledge/components/KnowledgeModal";
import { useMemberNames } from "@/modules/knowledge/queries";

import {
  createSpaceMember,
  decideRequest,
  deleteSpaceMember,
  joinSpace,
  leaveSpace,
  listWorkspaceMembers,
  setSpaceRole,
  type Request,
  type SpaceMember,
} from "../api";
import { invalidateSpaces, useJoinRequests, useSpaceMembers } from "../queries";
import { LEAD, MEMBER, defaultRole, isStaffRole, roleLabel, topRole, type SpaceRole } from "../types";
import type { SpaceView } from "./context";
import { Menu } from "./Menu";

function useWorkspaceMembers(enabled = true) {
  const { id } = useWorkspace();
  return useQuery({ queryKey: [id, "members", "all"], queryFn: () => listWorkspaceMembers(id), enabled, staleTime: 60_000 });
}

/** People (preview `peopleTab`): members by role, requests to join, add people, change roles, remove. */
export function PeopleTab({ view }: { view: SpaceView }) {
  const { id: ws, memberId } = useWorkspace();
  const qc = useQueryClient();
  const { space, sid, type, can } = view;
  const members = useSpaceMembers(sid);
  const people = useWorkspaceMembers();
  const canRole = can("spaces.setIamPolicy");
  const canDecide = can("requests.approve");
  const joins = useJoinRequests(sid, canDecide);
  const [q, setQ] = useState("");
  const [adding, setAdding] = useState(false);

  const email = new Map((people.data ?? []).map((m) => [resourceId(m.name), m.email ?? ""]));
  const order = (m: SpaceMember) => {
    const r = topRole(m.roles);
    const i = type.roles.findIndex((x) => x[0] === r);
    return i < 0 ? 99 : i;
  };
  const all = members.data ?? [];
  const leads = all.filter((m) => topRole(m.roles) === LEAD).length;
  const needle = q.trim().toLowerCase();
  const rows = all
    .filter((m) => !needle || `${m.displayName} ${email.get(resourceId(m.name)) ?? ""}`.toLowerCase().includes(needle))
    .sort((a, b) => order(a) - order(b) || (a.displayName ?? "").localeCompare(b.displayName ?? ""));
  const leadLabel = roleLabel(type, LEAD).toLowerCase();

  /** The space keeps at least one lead (the API refuses with LAST_SPACE_LEAD). */
  function guardLastLead(m: SpaceMember, next: SpaceRole | null): boolean {
    if (topRole(m.roles) === LEAD && next !== LEAD && leads <= 1) {
      toast(`${space.displayName} needs at least one ${leadLabel}. Add another first.`, { tone: "danger" });
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
      toast(`${m.displayName} is now ${label.toLowerCase()}`, {
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
      toast(you ? `You left ${space.displayName}` : `Removed ${m.displayName}`, undoable ? { undo: () => void restore().then(refresh).catch(fail) } : {});
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
      toast(approve ? `${name} joined ${space.displayName}` : `Declined ${name}’s request`);
    } catch (e) {
      fail(e);
    }
  }

  const total = space.memberCount ?? all.length;
  const shownNote =
    total > all.length ? `Showing ${fmtNum(all.length)} of ${plural(total, type.key === "course" ? "enrolled member" : "member")}` : plural(all.length, "member");

  return (
    <>
      {canDecide && joins.data?.length ? (
        <>
          <JoinRequests requests={joins.data} description={`Approved people join as ${roleLabel(type, defaultRole(type)).toLowerCase()}.`} onDecide={decide} />
          <div className="mt-32" />
        </>
      ) : null}
      <div className="toolbar">
        <SearchInput value={q} onChange={setQ} placeholder="Search people" />
        <div className="toolbar__end">
          <span className="t-sm muted hide-sm">{shownNote}</span>
          {can("spaceMembers.create") ? (
            <Button variant="tertiary" onPress={() => setAdding(true)}>
              <UserPlus aria-hidden />
              Add people
            </Button>
          ) : null}
        </div>
      </div>
      <Gate query={members} skeleton={<SkeletonRows rows={5} />} isEmpty={!rows.length} empty={<NoMatches what="people" onClear={() => setQ("")} />}>
        <List>
          {rows.map((m) => {
            const name = m.displayName ?? "Someone";
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
                      section: "Role",
                      items: type.roles.map(([key, l]) => ({ id: key, label: l, checked: role === key, run: () => void changeRole(m, key, l) })),
                    },
                    { sep: "1" },
                    { id: "remove", label: you ? "Leave space" : "Remove from space", icon: X, danger: true, run: () => void remove(m) },
                  ]}
                >
                  <Button variant="ghost" size="sm" aria-label={`${name}: ${label}. Change role`}>
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
                      Leave
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
                titleExtra={you ? <StatusChip label="You" size="sm" dot={false} /> : null}
                description={email.get(resourceId(m.name)) || undefined}
                actions={trail}
              />
            );
          })}
        </List>
      </Gate>
      {adding ? <AddPeopleDialog view={view} existing={new Set(all.map((m) => resourceId(m.name)))} onClose={() => setAdding(false)} /> : null}
    </>
  );
}

function JoinRequests({
  requests,
  description,
  onDecide,
}: {
  requests: readonly Request[];
  description: string;
  onDecide: (r: Request, approve: boolean, name: string) => Promise<void>;
}) {
  const names = useMemberNames(requests.map((r) => r.requester));
  const [busy, setBusy] = useState<string | null>(null);
  return (
    <Section title="Requests to join" description={description}>
      <List>
        {requests.map((r) => {
          const name = names.get(r.requester ?? "") || "Someone";
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
              description={note ? <span translate="no">{note}</span> : "No note"}
              meta={rel(r.createTime)}
              actions={
                <>
                  <Button variant="ghost" size="sm" onPress={() => run(false)} isPending={busy === `${r.name}:false`} isDisabled={!!busy}>
                    Decline
                  </Button>
                  <Button variant="secondary" size="sm" onPress={() => run(true)} isPending={busy === `${r.name}:true`} isDisabled={!!busy}>
                    Approve
                  </Button>
                </>
              }
            />
          );
        })}
      </List>
    </Section>
  );
}

/** Add people (preview `M['sp-add']`): pick workspace members, choose their role. */
function AddPeopleDialog({ view, existing, onClose }: { view: SpaceView; existing: Set<string>; onClose: () => void }) {
  const { id: ws } = useWorkspace();
  const qc = useQueryClient();
  const people = useWorkspaceMembers();
  const { type, sid, space } = view;
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<string[]>([]);
  const [role, setRole] = useState<SpaceRole>(defaultRole(type));
  const [busy, setBusy] = useState(false);
  const needle = q.trim().toLowerCase();
  const cands = (people.data ?? []).filter(
    (p) =>
      !existing.has(resourceId(p.name)) &&
      p.state !== "SUSPENDED" &&
      (!needle || (p.displayName ?? "").toLowerCase().includes(needle) || (p.email ?? "").toLowerCase().includes(needle)),
  );

  async function add() {
    if (!sel.length) return;
    setBusy(true);
    try {
      await Promise.all(sel.map((m) => createSpaceMember(ws, sid, m)));
      if (role !== MEMBER) await setSpaceRole(ws, sid, sel, role);
      void invalidateSpaces(qc, ws);
      onClose();
      const first = (people.data ?? []).find((p) => resourceId(p.name) === sel[0])?.displayName ?? "1 person";
      const added = [...sel];
      toast(added.length === 1 ? `Added ${first}` : `Added ${plural(added.length, "person", "people")}`, {
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
      title={
        <>
          Add people to <span translate="no">{space.displayName}</span>
        </>
      }
      footerStart={sel.length ? <span className="t-sm muted">{plural(sel.length, "person", "people")} selected</span> : undefined}
      footer={
        <>
          <Button variant="tertiary" onPress={onClose} isDisabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onPress={() => void add()} isPending={busy} isDisabled={!sel.length}>
            Add
          </Button>
        </>
      }
    >
      <div className="field">
        <span className="label">Find people</span>
        <SearchInput value={q} onChange={setQ} placeholder="Name or email" fullWidth autoFocus className="sp-add-q" />
      </div>
      <div className="sp-picks" role="group" aria-label="People">
        {people.isPending ? (
          <SkeletonRows rows={3} />
        ) : cands.length ? (
          cands.map((p) => {
            const pid = resourceId(p.name);
            return (
              <div key={p.name} className="sp-pick">
                <Checkbox isSelected={sel.includes(pid)} onChange={(on) => setSel(on ? [...sel, pid] : sel.filter((x) => x !== pid))} className="checkbox">
                  <Checkbox.Content className="checkbox__label">
                    <Checkbox.Control>
                      <Checkbox.Indicator />
                    </Checkbox.Control>
                    <UserAvatar name={p.displayName ?? p.email ?? ""} size="sm" />
                    <span className="stack sp-pick__text">
                      <span className="medium truncate" translate="no">
                        {p.displayName}
                      </span>
                      <span className="t-xs muted truncate">{p.email}</span>
                    </span>
                  </Checkbox.Content>
                </Checkbox>
              </div>
            );
          })
        ) : (
          <p className="t-sm muted sp-picks__empty">{needle ? "No one matches. Try another name." : "Everyone in the workspace is already here."}</p>
        )}
      </div>
      <Select value={role} onChange={(v) => setRole(v as SpaceRole)}>
        <Label>Role</Label>
        <Select.Trigger>
          <Select.Value />
          <Select.Indicator />
        </Select.Trigger>
        <Select.Popover>
          <ListBox>
            {type.roles.map(([key, l]) => (
              <ListBox.Item key={key} id={key} textValue={l}>
                {l}
                <ListBox.ItemIndicator />
              </ListBox.Item>
            ))}
          </ListBox>
        </Select.Popover>
      </Select>
    </KnowledgeModal>
  );
}
