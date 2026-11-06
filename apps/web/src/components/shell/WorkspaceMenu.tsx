"use client";

import { Dropdown, Header, Label, Separator } from "@heroui/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ChevronsUpDown, Layers, LayoutGrid } from "lucide-react";
import { useRouter } from "next/navigation";

import { toast } from "@/components/ui/Toast";
import { WorkspaceMark } from "@/components/ui/WorkspaceMark";
import { resourceId, type Schema } from "@/lib/api/client";
import { PLATFORM_CONSOLE, type ShellMode } from "@/lib/navigation";
import { isPlatformOperator, useSession } from "@/lib/session";
import { listMyWorkspaces, rememberedWorkspace, rememberWorkspace, useOptionalWorkspace } from "@/lib/workspace";
import { markWorkspaceOpened, useRoleDisplayName } from "@/modules/auth/api";

export interface ShellWorkspaces {
  workspaces: Schema<"Workspace">[];
  /** The workspace this device last opened (the console's "Back to …"). */
  current: Schema<"Workspace"> | null;
}

/** Workspaces and the remembered one, for the platform console (which has no active workspace context). */
export function useShellWorkspaces(enabled: boolean): ShellWorkspaces {
  const session = useSession();
  const { data } = useQuery({
    queryKey: ["shell", "my-workspaces", session?.user.name],
    queryFn: listMyWorkspaces,
    enabled: enabled && Boolean(session),
    staleTime: 5 * 60_000,
  });
  const workspaces = data ?? [];
  const remembered = data ? rememberedWorkspace() : null;
  return { workspaces, current: workspaces.find((w) => resourceId(w.name) === remembered) ?? workspaces[0] ?? null };
}

/** Sidebar header: workspace switcher (preview `MENUS.ws`). */
export function WorkspaceMenu({ mode }: { mode: ShellMode }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const session = useSession();
  const ctx = useOptionalWorkspace();
  const platform = mode === "platform";
  const fallback = useShellWorkspaces(!ctx);
  const workspaces = ctx?.workspaces ?? fallback.workspaces;
  const activeId = ctx?.id ?? null;
  const role = useRoleDisplayName(ctx?.id, ctx?.member.roles);

  const switchTo = (workspace: Schema<"Workspace">) => {
    const id = resourceId(workspace.name);
    if (!id || (!platform && id === activeId)) return;
    markWorkspaceOpened(id);
    if (ctx) ctx.switchTo(id);
    else
      void rememberWorkspace(id).then(() => {
        queryClient.clear();
        router.push("/home");
      });
    if (id !== activeId) toast(`Switched to ${workspace.displayName}`, { tone: "accent" });
  };

  return (
    <Dropdown>
      <Dropdown.Trigger className="ws-switch" aria-label="Switch workspace">
        {platform ? (
          <>
            <span className="ws-mark" style={{ background: "var(--foreground)", color: "var(--background)" }} aria-hidden>
              <Layers className="i i-sm" />
            </span>
            <span className="grow stack">
              <span className="ws-switch__name truncate">Platform console</span>
              <span className="ws-switch__meta">All workspaces</span>
            </span>
          </>
        ) : (
          <>
            <WorkspaceMark name={ctx?.workspace.displayName ?? ""} size={28} />
            <span className="grow stack">
              <span className="ws-switch__name truncate" translate="no">
                {ctx?.workspace.displayName}
              </span>
              <span className="ws-switch__meta truncate">{role}</span>
            </span>
          </>
        )}
        <ChevronsUpDown className="i i-sm" aria-hidden />
      </Dropdown.Trigger>
      <Dropdown.Popover placement="bottom start" offset={4} className="shell-menu">
        <Dropdown.Menu aria-label="Workspaces">
          <Dropdown.Section selectionMode="single" selectedKeys={!platform && activeId ? [activeId] : []}>
            <Header>Workspaces</Header>
            {workspaces.map((w) => (
              <Dropdown.Item key={w.name} id={resourceId(w.name)} textValue={w.displayName} onAction={() => switchTo(w)}>
                <WorkspaceMark name={w.displayName} size={22} />
                <Label className="grow truncate" translate="no">
                  {w.displayName}
                </Label>
                <Dropdown.ItemIndicator />
              </Dropdown.Item>
            ))}
          </Dropdown.Section>
          <Separator />
          <Dropdown.Section>
            {isPlatformOperator(session) ? (
              platform ? (
                <Dropdown.Item id="back" textValue="Back to workspace" onAction={() => router.push("/home")}>
                  <ArrowLeft className="i" aria-hidden />
                  <Label>Back to workspace</Label>
                </Dropdown.Item>
              ) : (
                <Dropdown.Item id="platform" textValue="Platform console" onAction={() => router.push(PLATFORM_CONSOLE.href)}>
                  <Layers className="i" aria-hidden />
                  <Label>Platform console</Label>
                </Dropdown.Item>
              )
            ) : null}
            <Dropdown.Item id="all" textValue="All workspaces" onAction={() => router.push("/workspaces")}>
              <LayoutGrid className="i" aria-hidden />
              <Label>All workspaces</Label>
            </Dropdown.Item>
          </Dropdown.Section>
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
}
