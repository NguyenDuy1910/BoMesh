"use client";

import { ArrowRight, ArrowUpRight, Building2, MoreHorizontal, Pause, Play, Plus } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useRef, useState } from "react";

import { Page } from "@/components/shell/Page";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { CellTitle, DataTable, type DataTableColumn } from "@/components/ui/DataTable";
import { ui } from "@/components/ui/design-system";
import { Drawer, DrawerSection } from "@/components/ui/Drawer";
import { EmptyState } from "@/components/ui/EmptyState";
import { ClearFilters, FilterChip } from "@/components/ui/FilterChip";
import { Menu, MenuItem, MenuSeparator } from "@/components/ui/Menu";
import { PageHeader } from "@/components/ui/PageHeader";
import { PreviewTag } from "@/components/ui/PreviewTag";
import { SearchInput } from "@/components/ui/SearchInput";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { useToast } from "@/components/ui/Toast";
import { Toolbar } from "@/components/ui/Toolbar";
import { usePendingFeature } from "@/lib/api/pending";
import type { AuthSession } from "@/lib/auth/session";
import { cn } from "@/lib/cn";
import { useAuthSession } from "@/lib/hooks/useAuthSession";
import { workspaceStatusKey } from "@/lib/status";
import { useWorkspaceSwitch } from "@/modules/auth/queries";
import { listPlatformWorkspaces, updatePlatformWorkspace, type PlatformWorkspace } from "@/modules/platform/api";
import { CreateWorkspaceDialog } from "@/modules/platform/components/CreateWorkspaceDialog";
import { Facts } from "@/modules/platform/components/Facts";
import { useOriginHost, WorkspaceMark } from "@/modules/platform/components/WorkspaceMark";
import { formatDate, formatDateTime, pluralize } from "@/lib/format";
import { useApiData } from "@/lib/hooks/useApiData";

const STATUS_OPTIONS = [
  { value: "active", label: "Active" },
  { value: "suspended", label: "Suspended" },
  { value: "new", label: "Setting up" },
];

const count = (value: number | null | undefined) => (typeof value === "number" ? value.toLocaleString() : "—");

const ownerName = (workspace: PlatformWorkspace) =>
  workspace.owner ? workspace.owner.display_name?.trim() || workspace.owner.email : null;

/** Rows this browser made or changed say so; they are not on the server. */
function localHint(workspace: PlatformWorkspace): string | null {
  if (workspace.source === "local") return "Created in this browser";
  return workspace.changed_locally ? "Changed in this browser" : null;
}

function membershipOf(session: AuthSession | null, workspaceId: string) {
  return session?.workspaces.find((membership) => membership.id === workspaceId) ?? null;
}

/**
 * Platform → Workspaces: every workspace on this deployment, its owner and
 * size, with create and suspend while `platform.workspace_admin` is on.
 * `?workspace=<id>` opens that workspace's drawer.
 */
export function PlatformWorkspacesPage() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const openId = params.get("workspace");
  const canAdmin = usePendingFeature("platform.workspace_admin");
  const session = useAuthSession();
  const toast = useToast();
  const host = useOriginHost();
  const { switchWorkspace, switchingId, error: switchError } = useWorkspaceSwitch();

  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [creating, setCreating] = useState(false);
  const [confirming, setConfirming] = useState<PlatformWorkspace | null>(null);
  const query = useApiData(() => listPlatformWorkspaces({ search }), search);
  const all = query.data ?? [];
  const rows = all.filter((row) => !status || workspaceStatusKey(row.status) === status);
  const filtered = Boolean(search || status);

  // The drawer keeps showing its workspace while a search hides the row.
  const remembered = useRef<PlatformWorkspace | null>(null);
  const found = openId ? all.find((row) => row.id === openId) ?? null : null;
  if (found) remembered.current = found;
  const selected = found ?? (remembered.current?.id === openId ? remembered.current : null);

  const setOpen = useCallback((workspaceId: string | null) => {
    const next = new URLSearchParams(params.toString());
    if (workspaceId) next.set("workspace", workspaceId);
    else next.delete("workspace");
    const queryString = next.toString();
    router.replace(queryString ? `${pathname}?${queryString}` : pathname, { scroll: false });
  }, [params, pathname, router]);

  const address = (workspace: PlatformWorkspace) => `${host ? `${host}/` : ""}${workspace.code}`;

  const openWorkspace = async (workspace: PlatformWorkspace) => {
    const membership = membershipOf(session, workspace.id);
    if (!membership) return;
    if (await switchWorkspace(workspace.id)) {
      toast.show({ tone: "info", message: `Switched to ${workspace.name}` });
      router.push(membership.permissions.includes("tenant.read") ? "/manage/overview" : "/chat");
    }
  };

  const changeStatus = async (workspace: PlatformWorkspace) => {
    const suspending = workspaceStatusKey(workspace.status) !== "suspended";
    await updatePlatformWorkspace(workspace.id, { status: suspending ? "suspended" : "active" });
    toast.show({ message: `${suspending ? "Suspended" : "Reactivated"} ${workspace.name}` });
  };

  const columns: DataTableColumn<PlatformWorkspace>[] = [
    {
      id: "name",
      header: "Workspace",
      sortable: true,
      sortValue: (row) => row.name.toLowerCase(),
      cell: (row) => {
        const hint = localHint(row);
        return (
          <CellTitle
            icon={<WorkspaceMark name={row.name} size="lg" />}
            subtitle={hint ? `${address(row)} · ${hint}` : address(row)}
            title={<span className="inline-flex max-w-full items-center gap-2"><span className="truncate">{row.name}</span>{hint && <PreviewTag />}</span>}
          />
        );
      },
    },
    {
      id: "owner",
      header: "Owner",
      hideBelow: 900,
      sortable: true,
      sortValue: (row) => ownerName(row)?.toLowerCase() ?? "",
      cell: (row) => ownerName(row) ?? <span className="text-text-tertiary">—</span>,
    },
    {
      id: "member_count",
      header: "Members",
      align: "right",
      width: 110,
      sortable: true,
      sortValue: (row) => row.member_count ?? -1,
      cell: (row) => count(row.member_count),
    },
    {
      id: "connection_count",
      header: "Connected accounts",
      align: "right",
      width: 170,
      hideBelow: 1080,
      sortable: true,
      sortValue: (row) => row.connection_count ?? -1,
      cell: (row) => count(row.connection_count),
    },
    {
      id: "status",
      header: "Status",
      width: 130,
      cell: (row) => <StatusBadge kind="ws" value={workspaceStatusKey(row.status)} />,
    },
    {
      id: "created_at",
      header: "Created",
      width: 130,
      hideBelow: 1080,
      sortable: true,
      sortValue: (row) => row.created_at ?? "",
      cell: (row) => <span className="text-text-secondary" title={formatDateTime(row.created_at, "")}>{formatDate(row.created_at, "—")}</span>,
    },
  ];

  const rowMenu = (row: PlatformWorkspace) => {
    const member = Boolean(membershipOf(session, row.id));
    const suspended = workspaceStatusKey(row.status) === "suspended";
    return (
      <Menu
        align="end"
        trigger={(props) => (
          <button {...props} aria-label={`More actions for ${row.name}`} className={cn(ui.iconButton, "size-8")}>
            <MoreHorizontal aria-hidden="true" size={16} />
          </button>
        )}
      >
        <MenuItem icon={<Building2 size={16} />} onSelect={() => setOpen(row.id)}>View details</MenuItem>
        <MenuItem
          disabled={!member || row.source === "local"}
          icon={<ArrowUpRight size={16} />}
          onSelect={() => void openWorkspace(row)}
          shortcut={member ? undefined : "Not a member"}
        >
          Open workspace
        </MenuItem>
        {canAdmin && (
          <>
            <MenuSeparator />
            <MenuItem
              danger={!suspended}
              icon={suspended ? <Play size={16} /> : <Pause size={16} />}
              onSelect={() => setConfirming(row)}
            >
              {suspended ? "Reactivate" : "Suspend workspace"}
            </MenuItem>
          </>
        )}
      </Menu>
    );
  };

  const confirmingSuspended = confirming ? workspaceStatusKey(confirming.status) === "suspended" : false;
  const confirmingIsMine = confirming ? Boolean(membershipOf(session, confirming.id)) : false;

  return (
    <Page>
      <PageHeader
        actions={canAdmin && (
          <Button icon={<Plus aria-hidden="true" />} onClick={() => setCreating(true)}>Create workspace</Button>
        )}
        sub="Every workspace on this deployment."
        title="Workspaces"
      />
      <Toolbar
        end={query.data && <span className="text-meta text-text-tertiary">{pluralize(rows.length, "workspace")}</span>}
        filters={(
          <>
            <FilterChip label="Status" onChange={setStatus} options={STATUS_OPTIONS} value={status} />
            <ClearFilters active={Boolean(status)} onClear={() => setStatus("")} />
          </>
        )}
        search={<SearchInput ariaLabel="Search workspaces" onChange={setSearch} placeholder="Search workspaces" value={search} />}
      />
      <DataTable
        activeRowId={selected?.id ?? null}
        ariaLabel="Workspaces"
        columns={columns}
        data={rows}
        emptyState={(
          <EmptyState
            description="Create a workspace for each customer or team. Its first admin sets up the rest."
            icon={<Building2 aria-hidden="true" />}
            title="No workspaces yet"
          />
        )}
        error={query.error}
        filtered={filtered}
        loading={!query.data && !query.error}
        onClearFilters={() => {
          setSearch("");
          setStatus("");
        }}
        onRetry={query.reload}
        onRowClick={(row) => setOpen(row.id)}
        rowActions={rowMenu}
      />

      <Drawer
        description={selected ? <span className="font-mono text-meta">{address(selected)}</span> : undefined}
        footer={selected && (
          <WorkspaceDrawerFooter
            canAdmin={canAdmin}
            member={Boolean(membershipOf(session, selected.id))}
            onOpen={() => void openWorkspace(selected)}
            onStatus={() => setConfirming(selected)}
            switching={switchingId === selected.id}
            workspace={selected}
          />
        )}
        header={selected && (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <StatusBadge kind="ws" value={workspaceStatusKey(selected.status)} />
            {localHint(selected) && <PreviewTag />}
          </div>
        )}
        icon={selected && <WorkspaceMark name={selected.name} size="xl" />}
        onClose={() => setOpen(null)}
        open={Boolean(openId)}
        title={selected?.name ?? (query.data ? "Workspace not found" : "Loading workspace")}
      >
        {selected ? (
          <>
            {localHint(selected) && (
              <Callout className="mb-5" tone="neutral">
                {selected.source === "local"
                  ? "This workspace was created in this browser only. It isn’t on the server yet, so nobody can sign in to it."
                  : "Its status was changed in this browser only. The server still reports the original status."}
              </Callout>
            )}
            {switchError && <Callout className="mb-5" tone="err">{switchError}</Callout>}
            <DrawerSection title="Details">
              <Facts
                items={[
                  ["Owner", selected.owner ? (
                    <span>
                      {ownerName(selected)}
                      {selected.owner.display_name && <span className="block text-meta text-text-tertiary">{selected.owner.email}</span>}
                    </span>
                  ) : "None assigned"],
                  ["Created", formatDate(selected.created_at, "—")],
                  ["Members", count(selected.member_count)],
                  ["Connected accounts", count(selected.connection_count)],
                  ["Web address", <span className="font-mono text-meta" key="address">{address(selected)}</span>],
                ]}
              />
            </DrawerSection>
          </>
        ) : query.data ? (
          <EmptyState description="It may have been removed, or the link is wrong." icon={<Building2 aria-hidden="true" />} size="sm" title="This workspace doesn’t exist" />
        ) : (
          <p className="text-text-tertiary">Loading…</p>
        )}
      </Drawer>

      <CreateWorkspaceDialog
        existing={all}
        onClose={() => setCreating(false)}
        onCreated={(created) => {
          setCreating(false);
          setSearch("");
          setStatus("");
          toast.show({
            message: `Created ${created.name}`,
            description: created.owner ? `${created.owner.email} is its first admin.` : undefined,
          });
        }}
        open={creating}
      />

      <ConfirmDialog
        confirmLabel={confirmingSuspended ? "Reactivate" : "Suspend workspace"}
        description={confirming && (confirmingSuspended
          ? `Members of ${confirming.name} can sign in again right away.`
          : `Members of ${confirming.name} can’t sign in while it’s suspended. Nothing is deleted.${confirmingIsMine ? " You’ll lose access too until it’s reactivated." : ""}`)}
        destructive={!confirmingSuspended}
        onClose={() => setConfirming(null)}
        onConfirm={() => (confirming ? changeStatus(confirming) : undefined)}
        open={Boolean(confirming)}
        title={confirming ? `${confirmingSuspended ? "Reactivate" : "Suspend"} ${confirming.name}?` : ""}
      />
    </Page>
  );
}

function WorkspaceDrawerFooter({
  workspace,
  member,
  canAdmin,
  switching,
  onOpen,
  onStatus,
}: {
  workspace: PlatformWorkspace;
  member: boolean;
  canAdmin: boolean;
  switching: boolean;
  onOpen: () => void;
  onStatus: () => void;
}) {
  const suspended = workspaceStatusKey(workspace.status) === "suspended";
  return (
    <>
      {!member && <span className="mr-auto text-meta text-text-tertiary">You’re not a member of this workspace.</span>}
      {canAdmin && (
        <Button onClick={onStatus} variant={suspended ? "secondary" : "danger-ghost"}>
          {suspended ? "Reactivate" : "Suspend"}
        </Button>
      )}
      {member && workspace.source === "server" && (
        <Button iconAfter={<ArrowRight aria-hidden="true" />} loading={switching} onClick={onOpen}>Open workspace</Button>
      )}
    </>
  );
}
