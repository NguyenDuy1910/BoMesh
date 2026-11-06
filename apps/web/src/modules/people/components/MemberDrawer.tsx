"use client";

import { Button } from "@heroui/react";
import { useQuery } from "@tanstack/react-query";
import { Pause, Play, Trash2 } from "lucide-react";
import { useState } from "react";

import { Callout, EmptyState, KeyValue, List, ListItem, StatusChip, Tip, UserAvatar, toast } from "@/components/ui";
import { errorMessage, resourceId } from "@/lib/api/client";
import { fmtDate, rel } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";
import { SpaceMark, roleLabel, spaceType, useSpaces } from "@/modules/spaces";

import { addToGroup, lastSignIn, removeFromGroup } from "../api";
import { ADMIN_ROLE, accountGuard, firstName, roleGuard } from "../model";
import { applyRoles, peopleKeys, usePeopleClient, useAnalysis, type Directory, type Person } from "../queries";
import { GroupChecks } from "./GroupChecks";
import { KnowledgeAccessList, useKnowledgeAccess } from "./KnowledgeAccess";
import { RoleSelect } from "./RoleSelect";
import { DrawerSection, SideDrawer } from "./SideDrawer";
import { useMemberActions } from "./useMemberActions";

interface Draft {
  id: string;
  role: string;
  groups: string[];
}

const sameSet = (a: readonly string[], b: readonly string[]) => [...a].sort().join() === [...b].sort().join();

/** Member drawer (preview `DR['ppl-member']`): role and groups stay a draft until Save. */
export function MemberDrawer({ dir, memberId, onClose }: { dir: Directory | undefined; memberId: string | null; onClose: () => void }) {
  const { ws, refresh } = usePeopleClient();
  const { can } = useWorkspace();
  const actions = useMemberActions(dir);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const person = memberId ? dir?.personById.get(memberId) : undefined;
  // A draft belongs to one person; opening someone else starts from their saved values.
  const f: Draft | null = person ? (draft?.id === person.id ? draft : { id: person.id, role: person.role, groups: person.groups }) : null;
  const dirty = Boolean(person && f && (f.role !== person.role || !sameSet(f.groups, person.groups)));

  async function save() {
    if (!dir || !person || !f || !dirty || busy) return;
    const why = roleGuard(person, dir.people, dir.self);
    if (f.role !== person.role && why) {
      toast(why, { tone: "danger" });
      return;
    }
    const roleNames = new Set(dir.roles.map((r) => r.name));
    const added = f.groups.filter((g) => !person.groups.includes(g));
    const removed = person.groups.filter((g) => !f.groups.includes(g));
    const prevRole = person.role;
    const roleChanged = f.role !== prevRole;
    setBusy(true);
    try {
      if (roleChanged) await applyRoles(ws, new Map([[person.user, f.role]]), roleNames);
      await Promise.all([...added.map((g) => addToGroup(ws, g, person.name)), ...removed.map((g) => removeFromGroup(ws, g, person.name))]);
      await refresh();
    } catch (error) {
      toast(errorMessage(error), { tone: "danger" });
      void refresh();
      return;
    } finally {
      setBusy(false);
    }
    setDraft(null);
    onClose();
    toast(`Saved changes to ${person.displayName}`, {
      undo: () =>
        void (async () => {
          if (roleChanged) await applyRoles(ws, new Map([[person.user, prevRole]]), roleNames);
          await Promise.all([...added.map((g) => removeFromGroup(ws, g, person.name)), ...removed.map((g) => addToGroup(ws, g, person.name))]);
        })()
          .catch((error: unknown) => toast(errorMessage(error), { tone: "danger" }))
          .finally(() => void refresh()),
    });
  }

  let footStart = null;
  if (person && dir && can("members.delete")) {
    const xWhy = accountGuard(person, dir.people, dir.self, "remove");
    const sWhy = accountGuard(person, dir.people, dir.self, "suspend");
    const remove = (
      <Button variant="danger-soft" isDisabled={Boolean(xWhy)} onPress={() => void actions.remove(person, onClose)}>
        <Trash2 className="i" aria-hidden />
        Remove
      </Button>
    );
    const suspend = (
      <Button variant="secondary" isDisabled={Boolean(sWhy)} onPress={() => void actions.suspend([person.id])}>
        <Pause className="i" aria-hidden />
        Suspend
      </Button>
    );
    footStart = (
      <>
        {xWhy ? (
          <Tip content={xWhy}>
            <span className="ppl-tip">{remove}</span>
          </Tip>
        ) : (
          remove
        )}
        {person.state === "SUSPENDED" ? (
          <Button variant="secondary" onPress={() => void actions.reactivate(person)}>
            <Play className="i" aria-hidden />
            Reactivate
          </Button>
        ) : sWhy ? (
          <Tip content={sWhy}>
            <span className="ppl-tip">{suspend}</span>
          </Tip>
        ) : (
          suspend
        )}
      </>
    );
  }

  return (
    <SideDrawer
      isOpen={Boolean(memberId)}
      onClose={onClose}
      title={person ? person.displayName + (person.user === dir?.self ? " (you)" : "") : "Member removed"}
      contentTitle={Boolean(person)}
      description={person ? <span translate="no">{person.email}</span> : undefined}
      lead={person ? <UserAvatar name={person.displayName} size="lg" /> : undefined}
      footStart={footStart}
      foot={
        person && can("members.create") ? (
          <Button variant="primary" isDisabled={!dirty} isPending={busy} onPress={() => void save()}>
            Save
          </Button>
        ) : null
      }
    >
      {person && dir && f ? (
        <MemberBody person={person} dir={dir} draft={f} onDraft={setDraft} />
      ) : dir ? (
        <EmptyState compact title="This person is no longer a member" />
      ) : null}
    </SideDrawer>
  );
}

function MemberBody({ person, dir, draft: f, onDraft }: { person: Person; dir: Directory; draft: Draft; onDraft: (d: Draft) => void }) {
  const { id: ws, can, hasModule, settings } = useWorkspace();
  const role = dir.roleByName.get(f.role) ?? dir.roles[0];
  const rWhy = roleGuard(person, dir.people, dir.self);
  const manage = can("members.create");
  const access = useKnowledgeAccess({
    user: person.user,
    groups: f.groups,
    currentGroups: person.groups,
    groupLabel: (g) => dir.groupByName.get(g)?.displayName ?? "",
  });
  const analysis = useAnalysis(`user:${resourceId(person.user)}`, { enabled: hasModule("spaces") });
  const spaces = useSpaces();
  const signIn = useQuery({
    queryKey: peopleKeys.lastSignIn(ws, person.user),
    queryFn: () => lastSignIn(ws, person.user),
    enabled: can("auditEvents.list"),
  });
  const spaceRows = (analysis.data?.results ?? []).flatMap((r) => {
    const space = r.resource?.includes("/spaces/") ? spaces.data?.find((s) => s.name === r.resource) : undefined;
    const key = ["roles/spaceLead", "roles/spaceStaff", "roles/spaceMember"].find((x) => r.roles?.includes(x));
    return space && key ? [{ space, type: spaceType(space.spaceType, settings), key }] : [];
  });
  const first = firstName(person.displayName);

  return (
    <>
      {person.state === "SUSPENDED" ? (
        <div className="mb-16">
          <Callout tone="danger" title="Suspended" description={`${first} can’t sign in until reactivated.`} />
        </div>
      ) : null}
      <DrawerSection title="Role">
        <RoleSelect
          ariaLabel="Role"
          value={f.role}
          roles={dir.roles}
          isDisabled={Boolean(rWhy) || !manage}
          onChange={(next) => onDraft({ ...f, role: next })}
          description={rWhy ? `${rWhy}.` : role?.description}
          fullWidth
        />
      </DrawerSection>
      <DrawerSection title="Groups" extra={<span className="t-xs muted">{f.groups.length} selected</span>}>
        {dir.groups.length ? (
          <GroupChecks groups={dir.groups} value={f.groups} onChange={(groups) => onDraft({ ...f, groups })} isDisabled={!manage} />
        ) : (
          <p className="t-sm muted">No groups yet.</p>
        )}
      </DrawerSection>
      <DrawerSection title="Knowledge access">
        {f.role === ADMIN_ROLE ? (
          <p className="t-sm muted">Workspace admins can open every knowledge base.</p>
        ) : (
          <KnowledgeAccessList access={access} empty={`No knowledge bases shared with ${first}.`} />
        )}
      </DrawerSection>
      {hasModule("spaces") ? (
        <DrawerSection title="Spaces">
          {spaceRows.length ? (
            <List>
              {spaceRows.map(({ space, type, key }) => (
                <ListItem
                  key={space.name}
                  lead={<SpaceMark space={space} size={28} />}
                  title={space.displayName}
                  contentTitle
                  description={type.label}
                  meta={roleLabel(type, key)}
                  href={`/space/${resourceId(space.name)}`}
                />
              ))}
            </List>
          ) : (
            <p className="t-sm muted">{analysis.isPending || spaces.isPending ? "…" : `${first} isn’t in any spaces.`}</p>
          )}
        </DrawerSection>
      ) : null}
      <DrawerSection title="Activity">
        <KeyValue
          pairs={[
            ["Joined", fmtDate(person.member.joinTime)],
            ["Last active", person.member.lastActiveTime ? rel(person.member.lastActiveTime) : "Not yet"],
            can("auditEvents.list") && [
              "Last sign-in",
              signIn.data ? (
                <span className="row gap-6">
                  {rel(signIn.data.createTime)}
                  {signIn.data.ipAddress ? <StatusChip label={signIn.data.ipAddress} dot={false} size="sm" variant="outline" /> : null}
                </span>
              ) : signIn.isPending ? (
                "…"
              ) : (
                "No sign-ins yet"
              ),
            ],
          ]}
        />
      </DrawerSection>
    </>
  );
}
