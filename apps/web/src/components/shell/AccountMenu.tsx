"use client";

import { Dropdown, Header, Label, Separator } from "@heroui/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronsUpDown, CircleHelp, CircleX, Command, LogOut, Moon, Route, Settings, Sun } from "lucide-react";
import { useRouter } from "next/navigation";

import { confirm } from "@/components/ui/Confirm";
import { toast } from "@/components/ui/Toast";
import { UserAvatar } from "@/components/ui/UserAvatar";
import { api, ApiError, call, errorMessage, resourceId } from "@/lib/api/client";
import type { ShellMode } from "@/lib/navigation";
import { useSession } from "@/lib/session";
import { MODE_LABEL, themeLabel } from "@/lib/theme";
import { leaveWorkspace, useOptionalWorkspace, type WorkspaceContextValue } from "@/lib/workspace";
import { signOut, useRoleDisplayName } from "@/modules/auth/api";
import { canLeaveWorkspace } from "@/modules/workspace-settings/model";

import { openAppearance, openPreferences, openShortcuts, startTour } from "./overlays";
import { useAppearance } from "./useAppearance";

/** The signed-in person's role line: workspace role, or platform role in the console. */
export function useRoleLine(mode: ShellMode): string {
  const session = useSession();
  const ctx = useOptionalWorkspace();
  const role = useRoleDisplayName(ctx?.id, ctx?.member.roles);
  if (mode === "platform" || !ctx) return session?.user.platformRole === "ADMIN" ? "Quản trị viên nền tảng" : "Người vận hành nền tảng";
  return role;
}

/**
 * Can the caller leave the active workspace (preview `canLeave`)? Any member, except the last active workspace admin. Only an
 * admin needs more: a two-row page of the active admins tells whether another one exists. Null while unknown.
 */
function useCanLeave(ctx: WorkspaceContextValue | null): boolean | null {
  const roles = ctx?.member.roles;
  const admin = Boolean(roles?.includes("roles/workspaceAdmin"));
  const admins = useQuery({
    queryKey: [ctx?.id, "members", "active-admins"],
    enabled: Boolean(ctx) && admin,
    staleTime: 60_000,
    queryFn: () =>
      call(
        api.GET("/api/v1/workspaces/{workspace}/members", {
          params: { path: { workspace: ctx!.id }, query: { filter: 'state = ACTIVE AND roles:"roles/workspaceAdmin"', pageSize: 2 } },
        }),
      ),
  });
  return canLeaveWorkspace(roles, admins.data ? (admins.data.members ?? []).length : undefined);
}

/** Leaving can take away private materials shared with you here, so it asks once; then the next workspace you're in opens. */
function useLeave(ctx: WorkspaceContextValue | null) {
  const router = useRouter();
  const queryClient = useQueryClient();
  return async () => {
    if (!ctx) return;
    const name = ctx.workspace.displayName;
    const ok = await confirm({
      title: `Rời ${name}?`,
      tone: "danger",
      confirmLabel: "Rời khỏi",
      description: (
        <>
          <span>Bạn sẽ mất quyền truy cập tài liệu và các cuộc trò chuyện của mình ở đó, kể cả những gì chỉ được chia sẻ riêng với bạn.</span>{" "}
          <span>{ctx.workspace.visibility === "PUBLIC" ? "Bạn có thể tham gia lại bất cứ lúc nào khi không gian làm việc còn công khai." : "Để quay lại, quản trị viên phải thêm hoặc mời bạn lần nữa."}</span>
        </>
      ),
    });
    if (!ok) return;
    try {
      await leaveWorkspace(ctx.id);
    } catch (error) {
      const lastAdmin = error instanceof ApiError && error.reason === "LAST_ADMIN";
      toast(lastAdmin ? "Bạn là quản trị viên cuối cùng của không gian làm việc. Hãy đặt người khác làm quản trị viên trước khi rời đi." : errorMessage(error), { tone: "danger" });
      return;
    }
    const next = ctx.workspaces.find((w) => w.name !== ctx.name && w.state !== "ARCHIVED");
    if (next) ctx.switchTo(resourceId(next.name));
    else {
      queryClient.clear();
      router.replace("/workspaces");
    }
    toast(`Bạn đã rời ${name}`, { tone: "accent" });
  };
}

/** Sidebar footer: account and preferences (preview `MENUS.me`). */
export function AccountMenu({ mode }: { mode: ShellMode }) {
  const router = useRouter();
  const session = useSession();
  const appearance = useAppearance();
  const role = useRoleLine(mode);
  const name = session?.user.displayName || session?.user.email || "";
  const platform = mode === "platform";
  const ctx = useOptionalWorkspace();
  const leaveable = useCanLeave(platform ? null : ctx);
  const leave = useLeave(ctx);

  const onSignOut = () => {
    void signOut().then(() => {
      router.replace("/signin");
      toast("Đã đăng xuất", { tone: "accent" });
    });
  };

  const coarse = typeof window !== "undefined" && window.matchMedia("(hover: none), (pointer: coarse)").matches;
  const help = [!coarse && "shortcuts", !platform && "tour"].filter(Boolean);
  const ModeIcon = appearance.dark ? Moon : Sun;

  // Who you are (opens Preferences), Appearance with its current value, Help, Sign out — Sign out is always visible.
  // Mode and theme live in the Appearance drawer; the console in the workspace switcher.
  return (
    <Dropdown>
      <Dropdown.Trigger className="user-button" aria-label="Tài khoản và tùy chọn">
        <UserAvatar name={name} />
        <span className="grow stack user-button__text">
          <span className="user-button__name truncate" translate="no" title={name}>
            {name}
          </span>
          <span className="user-button__meta truncate" title={role}>
            {role}
          </span>
        </span>
        <ChevronsUpDown className="i i-sm" aria-hidden />
      </Dropdown.Trigger>
      <Dropdown.Popover placement="top start" offset={4}>
        <Dropdown.Menu aria-label="Tài khoản">
          <Dropdown.Section>
            <Dropdown.Item id="me" textValue={name} onAction={() => openPreferences()}>
              <UserAvatar name={name} size="lg" />
              <span className="stack grow" style={{ minWidth: 0 }}>
                <span className="medium truncate" translate="no">
                  {name}
                </span>
                <span className="t-xs muted truncate" translate="no">
                  {session?.user.email}
                </span>
              </span>
              <Settings className="i menu-item__trail" aria-hidden />
            </Dropdown.Item>
          </Dropdown.Section>
          <Separator />
          <Dropdown.Section>
            <Dropdown.Item id="appearance" textValue="Giao diện" onAction={openAppearance}>
              <ModeIcon className="i" aria-hidden />
              <Label className="grow">Giao diện</Label>
              <span className="menu-item__meta">
                {MODE_LABEL[appearance.mode]} · {themeLabel(appearance.look)}
              </span>
            </Dropdown.Item>
            {help.length ? (
              <Dropdown.SubmenuTrigger>
                <Dropdown.Item id="help" textValue="Trợ giúp">
                  <CircleHelp className="i" aria-hidden />
                  <Label className="grow">Trợ giúp</Label>
                  <Dropdown.SubmenuIndicator />
                </Dropdown.Item>
                <Dropdown.Popover>
                  <Dropdown.Menu aria-label="Trợ giúp">
                    <Dropdown.Section>
                      <Header>Trợ giúp</Header>
                      {!coarse ? (
                        <Dropdown.Item id="shortcuts" textValue="Phím tắt" onAction={openShortcuts}>
                          <Command className="i" aria-hidden />
                          <Label>Phím tắt</Label>
                        </Dropdown.Item>
                      ) : null}
                      {!platform ? (
                        <Dropdown.Item id="tour" textValue="Hướng dẫn sản phẩm" onAction={startTour}>
                          <Route className="i" aria-hidden />
                          <Label>Hướng dẫn sản phẩm</Label>
                        </Dropdown.Item>
                      ) : null}
                    </Dropdown.Section>
                  </Dropdown.Menu>
                </Dropdown.Popover>
              </Dropdown.SubmenuTrigger>
            ) : null}
          </Dropdown.Section>
          <Separator />
          <Dropdown.Section>
            {!platform && ctx && leaveable ? (
              <Dropdown.Item id="leave" textValue={`Rời ${ctx.workspace.displayName}`} onAction={() => void leave()}>
                <CircleX className="i" aria-hidden />
                <Label>{`Rời ${ctx.workspace.displayName}`}</Label>
              </Dropdown.Item>
            ) : null}
            <Dropdown.Item id="signout" textValue="Đăng xuất" onAction={onSignOut}>
              <LogOut className="i" aria-hidden />
              <Label>Đăng xuất</Label>
            </Dropdown.Item>
          </Dropdown.Section>
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
}
