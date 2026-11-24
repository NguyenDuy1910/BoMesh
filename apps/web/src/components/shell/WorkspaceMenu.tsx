"use client";

import { Dropdown, Header, Label, Separator } from "@heroui/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ChevronsUpDown, Layers, LayoutGrid } from "lucide-react";
import { useRouter } from "next/navigation";

import { toast } from "@/components/ui/Toast";
import { WorkspaceMark } from "@/components/ui/WorkspaceMark";
import { resourceId, type Schema } from "@/lib/api/client";
import { useMessages } from "@/lib/i18n";
import { PLATFORM_CONSOLE, type ShellMode } from "@/lib/navigation";
import { isPlatformOperator, useSession } from "@/lib/session";
import { listMyWorkspaces, rememberedWorkspace, rememberWorkspace, useOptionalWorkspace } from "@/lib/workspace";
import { markWorkspaceOpened } from "@/modules/auth/api";

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
  const m = useMessages();
  const queryClient = useQueryClient();
  const session = useSession();
  const ctx = useOptionalWorkspace();
  const platform = mode === "platform";
  const fallback = useShellWorkspaces(!ctx);
  const workspaces = ctx?.workspaces ?? fallback.workspaces;
  const activeId = ctx?.id ?? null;
  const operator = isPlatformOperator(session);

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
    if (id !== activeId) toast(`Đã chuyển sang ${workspace.displayName}`, { tone: "accent" });
  };

  const name = platform ? "Bảng điều khiển nền tảng" : (ctx?.workspace.displayName ?? "");
  const ident = (
    <>
      {platform ? (
        <span className="ws-mark ws-mark--console" aria-hidden>
          <Layers className="i i-sm" />
        </span>
      ) : (
        <WorkspaceMark name={name} logo={ctx?.workspace.logoUri} size={24} />
      )}
      {/* The name alone, two lines before it ellipsizes: a "Workspace" caption under it only repeated the nav group below. */}
      <span className="grow ws-switch__text">
        <span className="ws-switch__name clamp-2" translate={platform ? undefined : "no"} title={name}>
          {name}
        </span>
      </span>
    </>
  );
  // One workspace and no console: a static identity row, not a switcher with a one-item menu.
  if (!platform && !operator && workspaces.length <= 1) return <div className="ws-switch ws-switch--static">{ident}</div>;

  return (
    <Dropdown>
      <Dropdown.Trigger className="ws-switch" aria-label={`Chuyển không gian làm việc: ${name}`}>
        {ident}
        <ChevronsUpDown className="i i-sm" aria-hidden />
      </Dropdown.Trigger>
      <Dropdown.Popover placement="bottom start" offset={4}>
        <Dropdown.Menu aria-label="Không gian làm việc">
          <Dropdown.Section selectionMode="single" selectedKeys={!platform && activeId ? [activeId] : []}>
            <Header>Không gian làm việc</Header>
            {workspaces.map((w) => (
              <Dropdown.Item key={w.name} id={resourceId(w.name)} textValue={w.displayName} onAction={() => switchTo(w)}>
                <WorkspaceMark name={w.displayName} logo={w.logoUri} size={22} />
                <Label className="grow clamp-2" translate="no">
                  {w.displayName}
                </Label>
                <Dropdown.ItemIndicator />
              </Dropdown.Item>
            ))}
          </Dropdown.Section>
          <Separator />
          <Dropdown.Section>
            {operator ? (
              platform ? (
                <Dropdown.Item id="back" textValue="Quay lại không gian làm việc" onAction={() => router.push("/home")}>
                  <ArrowLeft className="i" aria-hidden />
                  <Label>Quay lại không gian làm việc</Label>
                </Dropdown.Item>
              ) : (
                <Dropdown.Item id="platform" textValue={PLATFORM_CONSOLE.label(m)} onAction={() => router.push(PLATFORM_CONSOLE.href)}>
                  <Layers className="i" aria-hidden />
                  <Label>{PLATFORM_CONSOLE.label(m)}</Label>
                </Dropdown.Item>
              )
            ) : null}
            <Dropdown.Item id="all" textValue="Tất cả không gian làm việc" onAction={() => router.push("/workspaces")}>
              <LayoutGrid className="i" aria-hidden />
              <Label>Tất cả không gian làm việc</Label>
            </Dropdown.Item>
          </Dropdown.Section>
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
}
