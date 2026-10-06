"use client";

import { ArrowLeft, ChevronsUpDown, LayoutGrid, Layers, Settings } from "lucide-react";
import { useRouter } from "next/navigation";

import { RailTip } from "@/components/shell/RailTip";
import { useCurrentWorkspace } from "@/components/shell/useCurrentWorkspace";
import { WorkspaceMark } from "@/components/patterns/WorkspaceMark";
import { Menu, MenuItem, MenuLabel, MenuRadioItem, MenuSeparator } from "@/components/ui/Menu";
import { useToast } from "@/components/ui/Toast";
import { canAccessPlatformControl, hasSessionPermission } from "@/lib/auth/session";
import { useWorkspaceSwitch } from "@/modules/auth/queries";

/**
 * The sidebar head (prototype `MENUS.ws`): the workspace you are in, every
 * workspace you can switch to, the platform console for operators,
 * workspace settings for admins, and the full workspace list.
 */
export function WorkspaceMenu({ platform, collapsed }: { platform: boolean; collapsed: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const { session, workspace, viewer } = useCurrentWorkspace();
  const { switchingId, switchWorkspace } = useWorkspaceSwitch();
  const workspaces = session?.workspaces ?? [];
  const name = platform ? "Platform" : workspace?.name ?? "Workspace";
  const triggerLabel = platform ? "Platform console: switch workspace" : `${name}: switch workspace`;

  const choose = async (workspaceId: string, workspaceName: string) => {
    if (workspaceId === session?.active_workspace_id) {
      if (platform) router.push("/chat");
      return;
    }
    if (await switchWorkspace(workspaceId)) {
      toast.show({ tone: "info", message: `Switched to ${workspaceName}` });
      router.push("/chat");
    } else {
      toast.show({ tone: "err", message: `Couldn’t switch to ${workspaceName}. Try again.` });
    }
  };

  return (
    <Menu
      align="start"
      className="flex w-full"
      menuClassName="min-w-[248px]"
      trigger={(props) => (
        <RailTip enabled={collapsed} label={triggerLabel}>
          <button {...props} aria-label={triggerLabel} className="ws-switch">
            {platform ? (
              <span aria-hidden="true" className="grid size-7 shrink-0 place-items-center rounded-[7px] bg-[var(--surface-inverse)] text-[var(--text-inverse)]">
                <Layers className="size-4" />
              </span>
            ) : (
              <WorkspaceMark className="size-7 rounded-[7px] text-[length:var(--text-size-meta)] font-semibold" name={name} />
            )}
            <span className="side-grow hide-collapsed">
              {platform ? (
                <span className="ws-name flex items-center gap-2">Platform <span className="mode-chip">Console</span></span>
              ) : (
                <span className="ws-name">{name}</span>
              )}
              <span className="ws-meta">{platform ? "All workspaces" : viewer?.roleLabel ?? "Member"}</span>
            </span>
            <ChevronsUpDown aria-hidden="true" className="hide-collapsed size-4 shrink-0 text-[var(--text-tertiary)]" />
          </button>
        </RailTip>
      )}
    >
      <MenuLabel>Workspaces</MenuLabel>
      {workspaces.map((item) => (
        <MenuRadioItem
          checked={!platform && item.id === session?.active_workspace_id}
          disabled={Boolean(switchingId)}
          icon={<WorkspaceMark className="size-[22px] rounded-[6px] text-[10px] font-semibold" name={item.name} />}
          key={item.id}
          onSelect={() => void choose(item.id, item.name)}
          textValue={item.name}
        >
          <span className="block truncate">{switchingId === item.id ? `Switching to ${item.name}…` : item.name}</span>
        </MenuRadioItem>
      ))}
      <MenuSeparator />
      {canAccessPlatformControl(session) && (
        platform ? (
          <MenuItem href="/chat" icon={<ArrowLeft />}>Back to workspace</MenuItem>
        ) : (
          <MenuItem href="/platform" icon={<Layers />}>Platform console</MenuItem>
        )
      )}
      {!platform && hasSessionPermission(session, "tenant.manage") && (
        <MenuItem href="/manage/settings" icon={<Settings />}>Workspace settings</MenuItem>
      )}
      <MenuItem href="/workspaces" icon={<LayoutGrid />}>All workspaces</MenuItem>
    </Menu>
  );
}
