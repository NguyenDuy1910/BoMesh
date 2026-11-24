"use client";

import { Button } from "@heroui/react";
import { Building2, ChevronRight, Pause, Play, Shield, User as UserIcon, Users } from "lucide-react";

import {
  ClearFilters,
  confirm,
  DataTable,
  EmptyState,
  FilterButton,
  Gate,
  KeyValue,
  List,
  ListItem,
  NoMatches,
  Page,
  PageHeader,
  Pager,
  PreviewChip,
  SearchInput,
  SkeletonRows,
  StatusChip,
  SwitchRow,
  toast,
  UserAvatar,
  WorkspaceMark,
} from "@/components/ui";
import { errorMessage } from "@/lib/api/client";
import { SEARCH_PAUSE_MS, useDebounced } from "@/lib/debounce";
import { fmtNum, rel } from "@/lib/format";
import { useMessages } from "@/lib/i18n";
import { useSession } from "@/lib/session";

import { activateUser, suspendUser, updatePlatformRole, userFilter, type User } from "../api";
import { lastSegment, ROLE_OPTIONS, userName, type PlatformRole } from "../model";
import { pk, useInvalidatePlatform, useIsPlatformAdmin, usePlatformUser, useReadableMemberships, useUserPages } from "../queries";
import { MoreMenu, PlatformDrawer, PREVIEW_TIP, useUrlState, workspaceUrl } from "./shared";

const STATUS_OPTIONS = [
  { value: "ACTIVE", label: "Đang hoạt động" },
  { value: "SUSPENDED", label: "Đã tạm ngưng" },
];

/** Search and filters appear once the list is long enough to need them (preview `TOOLS_MIN`). */
const TOOLS_MIN = 7;
const PAGE = 50;

const lastActive = (u: User) => (u.lastActiveTime ? rel(u.lastActiveTime) : "Chưa bao giờ");

function RoleChip({ role }: { role: User["platformRole"] }) {
  if (role === "ADMIN") return <StatusChip label="Quản trị viên nền tảng" tone="accent" icon={Shield} size="sm" />;
  if (role === "OPERATOR") return <StatusChip label="Người vận hành nền tảng" tone="default" icon={Shield} size="sm" />;
  return null;
}

/**
 * Role and suspension changes (never on your own account). Granting platform admin is high-risk and asks once;
 * everything else is reversible and applies at once with Undo (preview `toggleAdmin` / `suspendUser`).
 */
function useUserActions() {
  const invalidate = useInvalidatePlatform();

  const run = async (work: () => Promise<User>, message: string, undo: (updated: User) => Promise<User>) => {
    try {
      const updated = await work();
      await invalidate(pk.users);
      toast(message, {
        undo: () =>
          void undo(updated)
            .then(() => invalidate(pk.users))
            .catch((error: unknown) => toast(errorMessage(error), { tone: "danger" })),
      });
    } catch (error) {
      toast(errorMessage(error), { tone: "danger" });
    }
  };

  const setRole = async (u: User, role: PlatformRole) => {
    const name = userName(u);
    const before = u.platformRole ?? "NONE";
    if (role === before) return;
    if (role === "ADMIN") {
      const ok = await confirm({
        title: `Đặt ${name} làm quản trị viên nền tảng?`,
        description: "Người này sẽ quản lý mọi không gian làm việc, người dùng và trình kết nối trên bản triển khai này.",
        confirmLabel: "Đặt làm quản trị viên nền tảng",
        tone: "accent",
      });
      if (!ok) return;
    }
    const message =
      role === "ADMIN"
        ? `${name} giờ là quản trị viên nền tảng`
        : role === "OPERATOR"
          ? before === "ADMIN"
            ? `${name} không còn là quản trị viên nền tảng`
            : `${name} giờ là người vận hành nền tảng`
          : `${name} không còn là ${before === "ADMIN" ? "quản trị viên" : "người vận hành"} nền tảng`;
    await run(() => updatePlatformRole(u, role), message, (updated) => updatePlatformRole(updated, before));
  };

  const toggleSuspend = (u: User) => {
    const name = userName(u);
    const on = u.state !== "SUSPENDED";
    return run(
      () => (on ? suspendUser(u) : activateUser(u)),
      on ? `Đã tạm ngưng ${name}. Họ không đăng nhập được vào không gian làm việc nào.` : `Đã kích hoạt lại ${name}`,
      (updated) => (on ? activateUser(updated) : suspendUser(updated)),
    );
  };

  return { setRole, toggleSuspend };
}

/** Preview `DR['pf-user']`: status, last active, workspaces, platform role; suspend in ⋯, reactivate in the footer. */
function UserDrawer({ userId, onClose }: { userId: string | null; onClose: () => void }) {
  const session = useSession();
  const isAdmin = useIsPlatformAdmin();
  const actions = useUserActions();
  const user = usePlatformUser(userId);
  const memberships = useReadableMemberships(userId);
  if (!userId) return <PlatformDrawer isOpen={false} onClose={onClose} title="">{null}</PlatformDrawer>;
  const u = user.data;
  if (!u) {
    return (
      <PlatformDrawer isOpen onClose={onClose} title={user.isPending ? "Đang tải tài khoản" : "Không tìm thấy tài khoản"}>
        {user.isPending ? <SkeletonRows rows={3} /> : <EmptyState icon={UserIcon} title="Tài khoản này không còn tồn tại" compact />}
      </PlatformDrawer>
    );
  }
  const self = u.name === session?.user.name;
  const name = userName(u);
  const role = u.platformRole ?? "NONE";
  const suspended = u.state === "SUSPENDED";
  const mships = memberships.data?.rows;
  const manage = isAdmin && !self;
  return (
    <PlatformDrawer
      isOpen
      onClose={onClose}
      lead={<UserAvatar name={name} size="lg" />}
      title={self ? `${name} (bạn)` : name}
      description={u.email}
      headActions={
        manage && !suspended ? <MoreMenu items={[{ id: "suspend", label: "Tạm ngưng tài khoản", icon: Pause, danger: true, onAction: () => void actions.toggleSuspend(u) }]} /> : null
      }
      footer={
        manage && suspended ? (
          <Button variant="primary" onPress={() => void actions.toggleSuspend(u)}>
            <Play className="i" aria-hidden />
            Kích hoạt lại tài khoản
          </Button>
        ) : null
      }
    >
      <div className="drawer__section">
        <KeyValue
          pairs={[
            ["Trạng thái", <StatusChip key="s" kind="member" value={suspended ? "suspended" : "active"} />],
            ["Hoạt động lần cuối", lastActive(u)],
            !isAdmin && role !== "NONE" && ["Vai trò nền tảng", <RoleChip key="r" role={role} />],
          ]}
        />
      </div>
      <div className="drawer__section">
        <div className="pf-sec-head">
          <h3 className="drawer__section-title">Không gian làm việc</h3>
          <span className="t-xs muted num">{mships ? fmtNum(mships.length) : ""}</span>
        </div>
        {memberships.isPending ? (
          <SkeletonRows rows={2} />
        ) : memberships.isError ? (
          <p className="t-sm muted">Không tải được các không gian làm việc.</p>
        ) : mships?.length ? (
          <List>
            {mships.map(({ workspace: w, roles, suspended: off }) => (
              <ListItem
                key={w.name}
                lead={<WorkspaceMark name={w.displayName ?? ""} logo={w.logoUri} size={28} />}
                title={<span translate="no">{w.displayName}</span>}
                label={w.displayName}
                description={<span className="mono">{workspaceUrl(w)}</span>}
                meta={off ? "Đã tạm ngưng" : roles.includes("roles/workspaceAdmin") ? "Quản trị" : "Thành viên"}
                actions={<ChevronRight className="i i-sm muted" aria-hidden />}
                href={`/p/workspaces?open=${lastSegment(w.name)}`}
              />
            ))}
          </List>
        ) : memberships.data?.hidden ? (
          <p className="t-sm muted">Không thuộc không gian làm việc nào mà bạn tham gia.</p>
        ) : (
          <EmptyState icon={Building2} title="Không thuộc không gian làm việc nào" description="Quản trị viên nền tảng có thể quản lý không gian làm việc mà không cần tham gia." compact boxed />
        )}
        {memberships.data?.hidden ? <p className="t-xs muted mt-8">Chỉ liệt kê các không gian làm việc bạn tham gia. Bảng điều khiển nền tảng không thấy thành viên của không gian làm việc khác.</p> : null}
      </div>
      {isAdmin ? (
        <div className="drawer__section">
          <SwitchRow
            title="Quản trị viên nền tảng"
            description={self ? "Bạn không thể thay đổi vai trò nền tảng của chính mình." : "Có thể quản lý mọi không gian làm việc, người dùng và trình kết nối."}
            isSelected={role === "ADMIN"}
            isDisabled={self}
            onChange={(on) => void actions.setRole(u, on ? "ADMIN" : "NONE")}
          />
          <SwitchRow
            title="Người vận hành nền tảng"
            description={role === "ADMIN" ? "Đã bao gồm trong quyền quản trị viên nền tảng." : "Có thể xem mọi không gian làm việc, người dùng và tác vụ lập chỉ mục mà không thay đổi chúng."}
            isSelected={role !== "NONE"}
            isDisabled={self || role === "ADMIN"}
            onChange={(on) => void actions.setRole(u, on ? "OPERATOR" : "NONE")}
          />
        </div>
      ) : null}
    </PlatformDrawer>
  );
}

/** Preview `P.pUsers`: every account on the deployment; status and platform role sit next to the name. */
export function UsersPage() {
  const m = useMessages();
  const url = useUrlState();
  const session = useSession();
  const q = url.get("q");
  const role = url.get("role");
  const status = url.get("status");
  const filtered = Boolean(q || role || status);
  const search = useDebounced(q, SEARCH_PAUSE_MS);
  const users = useUserPages(userFilter({ search, platformRole: role, state: status }), PAGE);

  return (
    <Page width="wide">
      <PageHeader title={m.nav.users} chips={<PreviewChip tooltip={PREVIEW_TIP} />} />
      <Gate
        query={users}
        skeleton={<SkeletonRows rows={8} />}
        isEmpty={(data) => !filtered && !data.users?.length}
        empty={<EmptyState icon={Users} title="Chưa có tài khoản" description="Mọi người sẽ hiển thị tại đây khi đăng ký hoặc được mời vào không gian làm việc." boxed />}
      >
        {(data) => {
          const rows = data.users ?? [];
          return (
            <>
              {(users.total ?? 0) >= TOOLS_MIN || users.hasNext || filtered ? (
                <div className="toolbar">
                  <SearchInput value={q} onChange={(v) => url.set({ q: v })} placeholder="Tìm theo tên hoặc email" />
                  <FilterButton label="Vai trò nền tảng" value={role} onChange={(v) => url.set({ role: v })} options={ROLE_OPTIONS} />
                  <FilterButton label="Trạng thái" value={status} onChange={(v) => url.set({ status: v })} options={STATUS_OPTIONS} />
                  <ClearFilters isActive={Boolean(role || status)} onClear={() => url.set({ role: null, status: null })} />
                </div>
              ) : null}
              {rows.length ? (
                <DataTable
                  label="Người dùng"
                  rows={rows}
                  getRowId={(u) => lastSegment(u.name)}
                  onRowAction={(u) => url.set({ open: lastSegment(u.name) })}
                  columns={[
                    {
                      id: "name",
                      header: "Người",
                      primary: true,
                      sortValue: (u) => userName(u).toLowerCase(),
                      cell: (u) => (
                        <div className="row gap-12">
                          <UserAvatar name={userName(u)} />
                          <div className="stack">
                            <span className="cell-title row gap-8 wrap">
                              <span className="truncate">
                                {userName(u)}
                                {u.name === session?.user.name ? <span className="muted t-sm"> (bạn)</span> : null}
                              </span>
                              {u.state === "SUSPENDED" ? <StatusChip kind="member" value="suspended" size="sm" /> : null}
                              <RoleChip role={u.platformRole} />
                            </span>
                            <span className="cell-sub truncate">{u.email}</span>
                          </div>
                        </div>
                      ),
                    },
                    {
                      id: "last",
                      header: "Hoạt động lần cuối",
                      className: "hide-md",
                      hideOnMobile: true,
                      sortValue: (u) => Date.parse(u.lastActiveTime ?? "") || 0,
                      cell: (u) => <span className="muted">{lastActive(u)}</span>,
                    },
                  ]}
                  footer={<Pager page={users.page} pageSize={PAGE} total={users.total} pageCount={rows.length} hasNext={users.hasNext} onPageChange={users.setPage} />}
                />
              ) : (
                <NoMatches what="người" onClear={() => url.set({ q: null, role: null, status: null })} />
              )}
            </>
          );
        }}
      </Gate>
      <UserDrawer userId={url.get("open") || null} onClose={() => url.set({ open: null })} />
    </Page>
  );
}
