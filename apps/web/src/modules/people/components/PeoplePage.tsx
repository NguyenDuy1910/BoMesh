"use client";

import { Button } from "@heroui/react";
import { UserPlus } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { PageChrome } from "@/components/shell/page-chrome";
import { Page, PageHeader, SectionTabs } from "@/components/ui";
import { resourceId } from "@/lib/api/client";
import { useWorkspace } from "@/lib/workspace";

import { useAccessRequestsQuery, useDirectory } from "../queries";
import { AddPeopleDialog } from "./AddPeopleDialog";
import { GroupDrawer } from "./GroupDrawer";
import { CreateGroupDialog, GroupsTab } from "./GroupsTab";
import { MemberDrawer } from "./MemberDrawer";
import { MembersTab, type MemberFilters } from "./MembersTab";
import { RequestsTab, isPending } from "./RequestsTab";
import { RolesTab, roleParam } from "./RolesTab";

const TABS = ["members", "groups", "roles", "requests"] as const;
type Tab = (typeof TABS)[number];

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
 * People (preview `P.people`, `/people?tab=members|groups|roles|requests`).
 * Deep links: `?tab=members&open=<memberId>`, `?tab=groups&open=<groupId>`, `?tab=roles&role=<roleId>`.
 */
export function PeoplePage() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const { can, id: ws } = useWorkspace();
  const dir = useDirectory();
  const requests = useAccessRequestsQuery();
  const tab: Tab = (TABS as readonly string[]).includes(params.get("tab") ?? "") ? (params.get("tab") as Tab) : "members";
  const open = params.get("open");
  const [filters, setFilters] = useState<MemberFilters>({ q: "", role: "", status: "" });
  const [adding, setAdding] = useState(false);
  const [creatingGroup, setCreatingGroup] = useState(false);
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

  const pending = requests.data?.filter(isPending).length ?? 0;
  const groupName = tab === "groups" && open ? `workspaces/${ws}/groups/${open}` : null;
  const memberId = tab === "members" && open ? open : null;

  return (
    <Page>
      <PageChrome crumbs={[{ label: "People" }]} />
      <PageHeader
        title="People"
        actions={
          can("members.create") ? (
            <Button variant="primary" onPress={() => setAdding(true)}>
              <UserPlus className="i" aria-hidden />
              Add people
            </Button>
          ) : null
        }
      >
        <SectionTabs
          base="/people"
          active={tab}
          items={[
            { id: "members", label: "Members", count: dir.data?.people.length },
            { id: "groups", label: "Groups", count: dir.data?.groups.length },
            { id: "roles", label: "Roles", count: dir.data?.roles.length },
            { id: "requests", label: "Requests", count: pending || null, alert: true },
          ]}
        />
      </PageHeader>
      {tab === "members" ? (
        <MembersTab
          query={dir}
          filters={filters}
          onFiltersChange={setFilters}
          fresh={freshMembers}
          canAdd={can("members.create")}
          onAdd={() => setAdding(true)}
          onOpen={(p) => go({ open: p.id })}
        />
      ) : tab === "groups" ? (
        <GroupsTab query={dir} fresh={freshGroups} onOpen={(g) => go({ open: resourceId(g.name) })} onCreate={() => setCreatingGroup(true)} />
      ) : tab === "roles" ? (
        <RolesTab
          query={dir}
          selected={params.get("role") ?? roleParam("roles/workspaceAdmin")}
          onSelect={(role) => go({ role })}
          onShowMembers={(role) => {
            setFilters({ q: "", role, status: "" });
            router.replace("/people?tab=members", { scroll: false });
          }}
        />
      ) : (
        <RequestsTab dir={dir.data} />
      )}
      <MemberDrawer dir={dir.data} memberId={memberId} onClose={() => go({ open: null })} />
      <GroupDrawer dir={dir.data} groupName={groupName} onClose={() => go({ open: null })} />
      <AddPeopleDialog
        isOpen={adding}
        onClose={() => setAdding(false)}
        dir={dir.data}
        onAdded={(ids) => {
          setFilters({ q: "", role: "", status: "" });
          markMembers(ids);
          if (tab !== "members") router.replace("/people?tab=members", { scroll: false });
        }}
      />
      <CreateGroupDialog
        isOpen={creatingGroup}
        onClose={() => setCreatingGroup(false)}
        dir={dir.data}
        onCreated={(g) => {
          markGroups([g.name ?? ""]);
          router.replace(`/people?tab=groups&open=${resourceId(g.name)}`, { scroll: false });
        }}
      />
    </Page>
  );
}
