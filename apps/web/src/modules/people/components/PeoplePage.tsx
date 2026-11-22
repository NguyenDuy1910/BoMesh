"use client";

import { Button } from "@heroui/react";
import { Link, Plus, UserPlus } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { Page, PageHeader, toast } from "@/components/ui";
import { resourceId } from "@/lib/api/client";
import { useMessages } from "@/lib/i18n";
import { peopleSections, sectionTitle, useSection } from "@/lib/navigation";
import { useWorkspace } from "@/lib/workspace";
import { workspaceTarget } from "@/modules/shares/api";
import { InviteLinksDialog } from "@/modules/shares/components/InviteLinksDialog";

import type { Group } from "../api";
import { MEMBER_ROLE } from "../model";
import { useDirectory } from "../queries";
import { AddPeopleDialog } from "./AddPeopleDialog";
import { GroupDrawer } from "./GroupDrawer";
import { GroupFormDialog, GroupsTab } from "./GroupsTab";
import { MemberDrawer } from "./MemberDrawer";
import { MembersTab, type MemberFilters } from "./MembersTab";
import { RequestsTab } from "./RequestsTab";
import { RolesTab, roleParam } from "./RolesTab";

const NO_FILTERS: MemberFilters = { q: "", role: "", status: "" };

/** Rows/cards that just appeared flash for a moment (preview `markFresh`). */
function useFresh() {
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const mark = useCallback((ids: string[]) => {
    setFresh(new Set(ids));
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setFresh(new Set()), 2600);
  }, []);
  return [fresh, mark] as const;
}

/**
 * People (preview `P.people`): sections Members · Groups · Roles · Access requests are sidebar sub-rows
 * (`?tab=`); each section is titled by its name and has its one header action.
 * Deep links: `?tab=members&open=<memberId>` (`&add=1` opens Add people), `?tab=groups&open=<groupId>`, `?tab=roles&role=<roleId>`.
 */
export function PeoplePage() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const { can, id: ws, workspace } = useWorkspace();
  const dir = useDirectory();
  const tab = useSection(peopleSections);
  const m = useMessages();
  const open = params.get("open");
  const [filters, setFilters] = useState<MemberFilters>(NO_FILTERS);
  const [groupForm, setGroupForm] = useState<{ group: Group | null } | null>(null);
  const [creatingRole, setCreatingRole] = useState(false);
  const [inviting, setInviting] = useState(false);
  const [freshMembers, markMembers] = useFresh();
  const [freshGroups, markGroups] = useFresh();

  const go = useCallback(
    (patch: Record<string, string | null>) => {
      const next = new URLSearchParams(params.toString());
      for (const [key, value] of Object.entries(patch)) {
        if (value) next.set(key, value);
        else next.delete(key);
      }
      router.replace(`${pathname}?${next.toString()}`, { scroll: false });
    },
    [params, pathname, router],
  );

  const adding = tab === "members" && params.get("add") === "1" && can("members.create");
  const groupName = tab === "groups" && open ? `workspaces/${ws}/groups/${open}` : null;
  // `member=` is the command palette's link to one person; `open=` the table's.
  const memberId = tab === "members" ? (open ?? params.get("member")) : null;

  const actions =
    tab === "members" && can("members.create") ? (
      <>
        <Button variant="ghost" onPress={() => setInviting(true)}>
          <Link className="i" aria-hidden />
          Invite link
        </Button>
        <Button variant="primary" onPress={() => go({ add: "1" })}>
          <UserPlus className="i" aria-hidden />
          Add people
        </Button>
      </>
    ) : tab === "groups" && can("groups.create") ? (
      <Button variant="primary" onPress={() => setGroupForm({ group: null })}>
        <Plus className="i" aria-hidden />
        New group
      </Button>
    ) : tab === "roles" && can("roles.create") ? (
      <Button variant="primary" onPress={() => setCreatingRole(true)}>
        <Plus className="i" aria-hidden />
        New role
      </Button>
    ) : null;

  return (
    <Page width="wide">
      <PageHeader title={sectionTitle(peopleSections, tab, m)} actions={actions} />
      {tab === "members" ? (
        <MembersTab query={dir} filters={filters} onFiltersChange={setFilters} fresh={freshMembers} canAdd={can("members.create")} onOpen={(p) => go({ open: p.id })} />
      ) : tab === "groups" ? (
        <GroupsTab query={dir} fresh={freshGroups} onOpen={(g) => go({ open: resourceId(g.name) })} />
      ) : tab === "roles" ? (
        <RolesTab
          query={dir}
          selected={params.get("role") ?? roleParam("roles/workspaceAdmin")}
          onSelect={(role) => go({ role })}
          creating={creatingRole}
          onCreatingChange={setCreatingRole}
          onShowMembers={(role, fromBlocked) => {
            setFilters({ ...NO_FILTERS, role });
            router.replace("/people?tab=members", { scroll: false });
            if (fromBlocked) toast("Select them, then use Change role to move them", { tone: "accent" });
          }}
        />
      ) : (
        <RequestsTab dir={dir.data} />
      )}
      <MemberDrawer dir={dir.data} memberId={memberId} onClose={() => go({ open: null, member: null })} />
      <GroupDrawer dir={dir.data} groupName={groupName} onClose={() => go({ open: null })} onEdit={(group) => setGroupForm({ group })} />
      <AddPeopleDialog
        isOpen={adding}
        onClose={() => go({ add: null })}
        dir={dir.data}
        onAdded={(ids) => {
          setFilters(NO_FILTERS);
          markMembers(ids);
        }}
      />
      {can("members.create") ? (
        <InviteLinksDialog
          target={workspaceTarget(ws)}
          scopeName={workspace.displayName ?? ""}
          roles={dir.data?.roles ?? []}
          defaultRole={MEMBER_ROLE}
          isOpen={inviting}
          onClose={() => setInviting(false)}
        />
      ) : null}
      <GroupFormDialog
        state={groupForm}
        dir={dir.data}
        onClose={() => setGroupForm(null)}
        onCreated={(g) => {
          markGroups([g.name ?? ""]);
          router.replace(`/people?tab=groups&open=${resourceId(g.name)}`, { scroll: false });
        }}
      />
    </Page>
  );
}
