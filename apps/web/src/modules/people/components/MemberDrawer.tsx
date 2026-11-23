"use client";

import { Button } from "@heroui/react";
import { useQuery } from "@tanstack/react-query";
import { LogIn, Pause, Play, Trash2 } from "lucide-react";
import { useState } from "react";

import { Callout, Disclosure, EmptyState, KeyValue, List, ListItem, StatusChip, UserAvatar, toast } from "@/components/ui";
import { errorMessage, resourceId } from "@/lib/api/client";
import { fmtDate, plural, rel, relInline } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";
import { SpaceMark, roleLabel, spaceType, useSpaces } from "@/modules/spaces";

import { addToGroup, lastSignIn, removeFromGroup } from "../api";
import { ADMIN_ROLE, ACCESS_LABEL, accountGuard, roleGuard } from "../model";
import { peopleKeys, usePeopleClient, useAnalysis, type Directory, type Person } from "../queries";
import { GroupChecks } from "./GroupChecks";
import { ALL_MEMBERS_VIA, BaseDot, useKnowledgeAccess } from "./KnowledgeAccess";
import { MoreMenu, type MenuAction } from "./MoreMenu";
import { RoleSelect } from "./RoleSelect";
import { DrawerSection, SideDrawer } from "./SideDrawer";
import { useMemberActions } from "./useMemberActions";

const KB_PREVIEW = 5;
const fail = (error: unknown) => toast(errorMessage(error), { tone: "danger" });

/**
 * Member drawer (preview `DR['ppl-member']`): role, groups, effective knowledge access, spaces and sign-in details.
 * Every change applies at once with Undo (no draft); ⋯ Suspend · Remove from workspace.
 */
export function MemberDrawer({ dir, memberId, onClose }: { dir: Directory | undefined; memberId: string | null; onClose: () => void }) {
  const { can } = useWorkspace();
  const actions = useMemberActions(dir);
  const person = memberId ? dir?.personById.get(memberId) : undefined;

  const menu: MenuAction[] = [];
  if (person && dir && can("members.delete")) {
    if (person.state !== "SUSPENDED" && !accountGuard(person, dir.people, dir.self, "suspend")) {
      menu.push({ id: "suspend", label: "Suspend", icon: Pause, onAction: () => void actions.suspend([person.id]) });
    }
    if (!accountGuard(person, dir.people, dir.self, "remove")) {
      menu.push({ id: "remove", label: "Remove from workspace", icon: Trash2, danger: true, sep: menu.length > 0, onAction: () => void actions.remove(person, onClose) });
    }
  }
  const lastActive = person?.member.lastActiveTime;

  return (
    <SideDrawer
      isOpen={Boolean(memberId)}
      onClose={onClose}
      title={
        person ? (
          <span className="row gap-8">
            <span className="truncate" translate="no">
              {person.displayName}
            </span>
            {person.user === dir?.self ? <StatusChip label="You" dot={false} size="sm" /> : null}
          </span>
        ) : (
          "Member removed"
        )
      }
      description={
        person ? (
          <>
            <span translate="no">{person.email}</span>
            {lastActive ? (
              <>
                {" · "}
                <span>{`Last active ${relInline(lastActive)}`}</span>
              </>
            ) : null}
          </>
        ) : undefined
      }
      lead={person ? <UserAvatar name={person.displayName} size="lg" /> : undefined}
      headActions={menu.length ? <MoreMenu actions={menu} /> : null}
    >
      {person && dir ? (
        <MemberBody key={person.id} person={person} dir={dir} onReactivate={() => void actions.reactivate(person)} onRole={(role) => void actions.setRole([person.id], role)} />
      ) : dir ? (
        <EmptyState compact title="This person is no longer a member" />
      ) : null}
    </SideDrawer>
  );
}

function MemberBody({ person, dir, onReactivate, onRole }: { person: Person; dir: Directory; onReactivate: () => void; onRole: (role: string) => void }) {
  const { id: ws, can, hasModule, settings } = useWorkspace();
  const { refresh } = usePeopleClient();
  const [allKb, setAllKb] = useState(false);
  const role = dir.roleByName.get(person.role) ?? dir.roles[0];
  const rWhy = roleGuard(person, dir.people, dir.self);
  const manage = can("members.create");
  const access = useKnowledgeAccess({ user: person.user, groups: person.groups, currentGroups: person.groups, groupLabel: (g) => dir.groupByName.get(g)?.displayName ?? "" });
  const analysis = useAnalysis(`user:${resourceId(person.user)}`, { enabled: hasModule("spaces") });
  const spaces = useSpaces();
  const signIn = useQuery({ queryKey: peopleKeys.lastSignIn(ws, person.user), queryFn: () => lastSignIn(ws, person.user), enabled: can("auditEvents.list") });
  const spaceRows = (analysis.data?.results ?? []).flatMap((r) => {
    const space = r.resource?.includes("/spaces/") ? spaces.data?.find((s) => s.name === r.resource) : undefined;
    const key = ["roles/spaceLead", "roles/spaceStaff", "roles/spaceMember"].find((x) => r.roles?.includes(x));
    return space && key ? [{ space, type: spaceType(space.spaceType, settings), key }] : [];
  });

  // Add to or take out of a group: applies at once with Undo.
  async function toggleGroup(next: string[]) {
    const added = next.find((g) => !person.groups.includes(g));
    const group = added ?? person.groups.find((g) => !next.includes(g));
    if (!group) return;
    const label = dir.groupByName.get(group)?.displayName ?? "the group";
    try {
      await (added ? addToGroup(ws, group, person.name) : removeFromGroup(ws, group, person.name));
    } catch (error) {
      fail(error);
      return;
    }
    void refresh();
    toast(added ? `Added ${person.displayName} to ${label}` : `Removed ${person.displayName} from ${label}`, {
      undo: () =>
        void (added ? removeFromGroup(ws, group, person.name) : addToGroup(ws, group, person.name)).catch(fail).finally(() => void refresh()),
    });
  }

  const grants = access.data?.filter((a) => a.via !== ALL_MEMBERS_VIA) ?? [];
  const everyone = access.data?.filter((a) => a.via === ALL_MEMBERS_VIA).length ?? 0;
  const plus = everyone ? (
    <p className={grants.length ? "t-sm muted mt-8" : "t-sm muted"}>
      {grants.length ? `Plus ${plural(everyone, "collection")} all members can open.` : `Only the ${plural(everyone, "collection")} all members can open.`}
    </p>
  ) : null;
  let knowledge;
  if (person.role === ADMIN_ROLE) knowledge = <p className="t-sm muted">Workspace admins can open every collection.</p>;
  else if (access.isPending) knowledge = <p className="t-sm muted">…</p>;
  else if (access.isError) knowledge = <p className="t-sm muted">Knowledge access didn’t load.</p>;
  else if (grants.length) {
    knowledge = (
      <>
        <List>
          {(allKb ? grants : grants.slice(0, KB_PREVIEW)).map((a) => (
            <ListItem
              key={a.id}
              lead={<BaseDot id={a.id} />}
              title={a.name}
              contentTitle
              description={<span translate={a.via === "Shared directly" ? undefined : "no"}>{a.via}</span>}
              meta={ACCESS_LABEL[a.role] ?? "Viewer"}
              href={`/studio/collections/${a.id}?tab=access`}
            />
          ))}
        </List>
        {grants.length > KB_PREVIEW ? (
          <div className="mt-8">
            <button type="button" className="link-button" onClick={() => setAllKb((v) => !v)}>
              {allKb ? "Show fewer" : `Show all ${grants.length}`}
            </button>
          </div>
        ) : null}
        {plus}
      </>
    );
  } else knowledge = plus ?? <p className="t-sm muted">{`No collections shared with ${person.displayName}.`}</p>;

  return (
    <>
      {person.state === "SUSPENDED" ? (
        <div className="mb-16">
          <Callout
            tone="danger"
            title="Suspended"
            description={`${person.displayName} can’t sign in until reactivated.`}
            actions={
              can("members.delete") ? (
                <Button variant="secondary" size="sm" onPress={onReactivate}>
                  <Play className="i" aria-hidden />
                  Reactivate
                </Button>
              ) : undefined
            }
          />
        </div>
      ) : null}
      <DrawerSection title="Role">
        <RoleSelect ariaLabel="Role" value={person.role} roles={dir.roles} isDisabled={Boolean(rWhy) || !manage} onChange={onRole} description={rWhy || role?.description} fullWidth />
      </DrawerSection>
      <DrawerSection title="Groups">
        {dir.groups.length ? <GroupChecks groups={dir.groups} value={person.groups} onChange={(next) => void toggleGroup(next)} isDisabled={!manage} /> : <p className="t-sm muted">No groups yet.</p>}
      </DrawerSection>
      <DrawerSection title="Knowledge access">{knowledge}</DrawerSection>
      {hasModule("spaces") && spaceRows.length ? (
        <DrawerSection title="Spaces">
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
        </DrawerSection>
      ) : null}
      <section className="drawer__section">
        <Disclosure icon={LogIn} title="Sign-in details" summary={`Joined ${fmtDate(person.member.joinTime)}`}>
          <KeyValue
            pairs={[
              [
                "Last sign-in",
                !can("auditEvents.list")
                  ? "—"
                  : signIn.data
                    ? [rel(signIn.data.createTime), signIn.data.ipAddress].filter(Boolean).join(" · ")
                    : signIn.isPending
                      ? "…"
                      : "No sign-ins yet",
              ],
            ]}
          />
        </Disclosure>
      </section>
    </>
  );
}
