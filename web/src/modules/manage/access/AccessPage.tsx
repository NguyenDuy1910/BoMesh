"use client";

import { Plus, UserPlus } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useCurrentWorkspace } from "@/components/shell/useCurrentWorkspace";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { PageHeader } from "@/components/ui/PageHeader";
import { TabPanel, Tabs, type TabItem } from "@/components/ui/Tabs";
import { usePendingFeature } from "@/lib/api/pending";
import { roleChoices } from "@/modules/manage/access/access-model";
import { listRemovedMembers } from "@/modules/manage/access/api";
import {
  approvalRequestsApi,
  knowledgeAccessApi,
  REVIEW_PERMISSION,
  workspaceDirectoryApi,
  type GroupRef,
} from "@/modules/manage/access/directory";
import { GroupsTab } from "@/modules/manage/access/GroupsTab";
import { EMPTY_MEMBER_FILTERS, MembersTab, type MemberFilters } from "@/modules/manage/access/MembersTab";
import { RequestsTab } from "@/modules/manage/access/RequestsTab";
import { RolesTab } from "@/modules/manage/access/RolesTab";
import { useApiData } from "@/lib/hooks/useApiData";

type AccessTab = "members" | "groups" | "roles" | "requests";

const TAB_LABEL: Record<AccessTab, string> = {
  members: "Members",
  groups: "Groups",
  roles: "Roles",
  requests: "Requests",
};

/** Query params that belong to one tab and are dropped when the tab changes. */
const TAB_SCOPED = ["member", "group", "role", "request", "action"] as const;

const NO_PERMISSIONS: readonly string[] = [];

/**
 * People & access: who is in the workspace (Members), how they are grouped
 * (Groups), what each role allows (Roles) and who is waiting for access
 * (Requests). Each tab appears only for the permission that governs it, and
 * every selection lives in the URL (`?tab=`, `?member=`, `?group=`, `?role=`,
 * `?request=`) so other screens can link straight to it.
 */
export function AccessPage() {
  const { session } = useCurrentWorkspace();
  const callerPermissions = session?.permissions ?? NO_PERMISSIONS;
  const callerId = session?.user_id ?? null;
  const callerRoleCodes = session?.workspaces.find((workspace) => workspace.id === session.active_workspace_id)?.role_codes ?? NO_PERMISSIONS;
  const has = (permission: string) => callerPermissions.includes(permission);
  const can: Record<AccessTab, boolean> = {
    members: has("user.manage"),
    groups: has("group.manage"),
    roles: has("role.manage"),
    requests: has(REVIEW_PERMISSION.resource_access) || has(REVIEW_PERMISSION.plugin_installation),
  };
  const canReadActivity = has("audit.read");

  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const setQuery = useCallback(
    (patch: Record<string, string | null>) => {
      const next = new URLSearchParams(params.toString());
      for (const [key, value] of Object.entries(patch)) {
        if (value) next.set(key, value);
        else next.delete(key);
      }
      const query = next.toString();
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    },
    [params, pathname, router],
  );

  const visibleTabs = (Object.keys(TAB_LABEL) as AccessTab[]).filter((id) => can[id]);
  const tab = visibleTabs.find((id) => id === params.get("tab")) ?? visibleTabs[0] ?? "members";

  /* ── Data. Each read runs only for a caller who may make it. ── */
  // Removing a member is API-pending: removals made in this browser are hidden from the list.
  const removeEnabled = usePendingFeature("workspace.member_remove");
  const members = useApiData(
    () =>
      can.members
        ? workspaceDirectoryApi.members().then((page) => {
            if (!removeEnabled) return page.items;
            const removed = new Set(listRemovedMembers().map((removal) => removal.user_id));
            return page.items.filter((member) => !removed.has(member.id));
          })
        : Promise.resolve(null),
    `members:${can.members}:${removeEnabled}`,
  );
  const groups = useApiData(
    () => (can.groups ? workspaceDirectoryApi.groups().then((page) => page.items) : Promise.resolve(null)),
    `groups:${can.groups}`,
  );
  const roles = useApiData(
    () => (can.roles ? workspaceDirectoryApi.roles().then((page) => page.items) : Promise.resolve(null)),
    `roles:${can.roles}`,
  );
  const catalogue = useApiData(
    () => (can.roles ? workspaceDirectoryApi.permissions().then((page) => page.items) : Promise.resolve(null)),
    `permissions:${can.roles}`,
  );
  const requests = useApiData(
    () =>
      can.requests
        ? approvalRequestsApi.list().then((page) =>
            // The server also lists the caller's own requests; only the reviewable ones belong here.
            page.items.filter((request) => callerPermissions.includes(REVIEW_PERMISSION[request.request_type])),
          )
        : Promise.resolve(null),
    `requests:${can.requests}:${callerPermissions.join(",")}`,
  );
  const collections = useApiData(
    () => (can.requests ? knowledgeAccessApi.collections().then((page) => page.items).catch(() => []) : Promise.resolve(null)),
    `collections:${can.requests}`,
  );
  const lastActive = useApiData(
    () =>
      can.members && canReadActivity
        ? workspaceDirectoryApi
            .activity("30d")
            .then((activity) => Object.fromEntries(activity.people.map((person) => [person.user_id, person.last_active_at])))
            .catch(() => null)
        : Promise.resolve(null),
    `activity:${can.members && canReadActivity}`,
  );
  // Knowledge access is a fan-out over collections, so it is read only while something shows it.
  const grantsWanted = tab === "groups" || Boolean(params.get("member")) || Boolean(params.get("group"));
  const grants = useApiData(
    () => (grantsWanted ? knowledgeAccessApi.grants() : Promise.resolve(null)),
    `grants:${grantsWanted}`,
  );
  /** Undefined while loading, null when the read failed. */
  const knowledgeGrants = grants.error ? null : grants.data ?? undefined;

  const choices = useMemo(() => roleChoices(roles.data, members.data), [roles.data, members.data]);
  /** Groups to offer: the full list with `group.manage`, otherwise the ones members already belong to. */
  const groupRefs = useMemo<GroupRef[]>(() => {
    if (groups.data) return groups.data.map((group) => ({ id: group.id, code: group.code, display_name: group.display_name }));
    const seen: Record<string, GroupRef> = {};
    for (const member of members.data ?? []) for (const group of member.groups) seen[group.id] ??= group;
    return Object.values(seen).sort((left, right) => left.display_name.localeCompare(right.display_name));
  }, [groups.data, members.data]);
  const pendingCount = requests.data?.filter((request) => request.status === "pending").length ?? 0;

  /* ── Page-level state shared across tabs ── */
  const [memberFilters, setMemberFilters] = useState<MemberFilters>(EMPTY_MEMBER_FILTERS);
  const [addOpen, setAddOpen] = useState(false);
  const [createGroupOpen, setCreateGroupOpen] = useState(false);
  const [createRoleOpen, setCreateRoleOpen] = useState(false);
  const [roleDirty, setRoleDirty] = useState(false);
  const [blockedSwitch, setBlockedSwitch] = useState<(() => void) | null>(null);

  // `?action=add` (setup checklist, command palette) opens Add member once.
  const action = params.get("action");
  useEffect(() => {
    if (action !== "add" || !can.members) return;
    setAddOpen(true);
    setQuery({ action: null });
  }, [action, can.members, setQuery]);

  /** Leaving the Roles tab with unsaved permission changes asks first. */
  const guarded = (go: () => void) => (roleDirty ? setBlockedSwitch(() => go) : go());
  const selectTab = (next: AccessTab) =>
    guarded(() => {
      setRoleDirty(false);
      setQuery({ tab: next === visibleTabs[0] ? null : next, ...Object.fromEntries(TAB_SCOPED.map((key) => [key, null])) });
    });

  const tabs: TabItem<AccessTab>[] = visibleTabs.map((id) => ({
    id,
    label: TAB_LABEL[id],
    count:
      id === "members" ? members.data?.length
        : id === "groups" ? groups.data?.length
          : id === "roles" ? roles.data?.length
            : pendingCount || undefined,
  }));

  const headerAction =
    tab === "members" && can.members ? (
      <Button icon={<UserPlus aria-hidden="true" size={16} />} onClick={() => setAddOpen(true)}>Add member</Button>
    ) : tab === "groups" && can.groups ? (
      <Button icon={<Plus aria-hidden="true" size={16} />} onClick={() => setCreateGroupOpen(true)}>Create group</Button>
    ) : tab === "roles" && can.roles ? (
      // The save bar owns the page's primary action while there are unsaved changes.
      <Button icon={<Plus aria-hidden="true" size={16} />} onClick={() => guarded(() => setCreateRoleOpen(true))} variant={roleDirty ? "secondary" : "primary"}>
        Create role
      </Button>
    ) : null;

  return (
    <>
      <PageHeader actions={headerAction} sub="Who can use this workspace and what they can do." title="People & access" />
      <Tabs activeTab={tab} ariaLabel="People and access sections" className="mb-5" idBase="access" onChange={selectTab} tabs={tabs} />
      <TabPanel idBase="access" tab={tab}>
        {tab === "members" && (
          <MembersTab
            addOpen={addOpen}
            callerId={callerId}
            callerPermissions={callerPermissions}
            filters={memberFilters}
            grants={knowledgeGrants}
            groups={groupRefs}
            lastActive={lastActive.data}
            members={members}
            onAddOpenChange={setAddOpen}
            onFiltersChange={setMemberFilters}
            openMemberId={params.get("member")}
            onOpenMember={(memberId) => setQuery({ member: memberId })}
            removeEnabled={removeEnabled}
            roles={choices}
          />
        )}
        {tab === "groups" && (
          <GroupsTab
            createOpen={createGroupOpen}
            grants={knowledgeGrants}
            groups={groups}
            members={members.data}
            onCreateOpenChange={setCreateGroupOpen}
            onOpenGroup={(groupId) => setQuery({ group: groupId })}
            openGroupId={params.get("group")}
            roles={choices}
          />
        )}
        {tab === "roles" && (
          <RolesTab
            callerPermissions={callerPermissions}
            callerRoleCodes={callerRoleCodes}
            canSeeMembers={can.members}
            catalogue={catalogue.data}
            createOpen={createRoleOpen}
            onCreateOpenChange={setCreateRoleOpen}
            onDirtyChange={setRoleDirty}
            onSelectRole={(roleId) => guarded(() => setQuery({ role: roleId }))}
            onShowMembers={(roleId) => {
              setMemberFilters({ ...EMPTY_MEMBER_FILTERS, role: roleId });
              selectTab("members");
            }}
            roles={roles}
            selectedRoleId={params.get("role")}
          />
        )}
        {tab === "requests" && (
          <RequestsTab
            callerId={callerId}
            collections={collections.data}
            focusRequestId={params.get("request")}
            members={members.data}
            requests={requests}
          />
        )}
      </TabPanel>
      <ConfirmDialog
        confirmLabel="Discard changes"
        description="Your changes to this role haven’t been saved."
        onClose={() => setBlockedSwitch(null)}
        onConfirm={() => {
          const go = blockedSwitch;
          setRoleDirty(false);
          go?.();
        }}
        open={Boolean(blockedSwitch)}
        title="Discard unsaved changes?"
      />
    </>
  );
}
