"use client";

import { useWorkspace } from "@/lib/workspace";
import { errorMessage } from "@/lib/api/client";
import { plural } from "@/lib/format";
import { confirm, toast } from "@/components/ui";

import { activateMember, addToGroup, createMember, deleteMember, suspendMember } from "../api";
import { accountGuard, leavesNoAdmin, roleGuard } from "../model";
import { applyRoles, usePeopleClient, type Directory, type Person } from "../queries";

const fail = (error: unknown) => toast(errorMessage(error), { tone: "danger" });

/** Membership actions shared by the Members table, bulk bar and member drawer (preview setRole/suspend/reactivate/remove). */
export function useMemberActions(dir: Directory | undefined) {
  const { refresh, ws } = usePeopleClient();
  const { workspace } = useWorkspace();
  const roleNames = new Set(dir?.roles.map((r) => r.name) ?? []);

  /** Change role for one or more members; guarded (self, last admin) and undoable. */
  async function setRole(all: readonly Person[], role: string, after?: () => void) {
    if (!dir) return;
    const target = dir.roleByName.get(role);
    if (!target) return;
    const blocked = all.filter((p) => roleGuard(p, dir.admins, dir.self) && p.role !== role);
    const changing = all.filter((p) => !roleGuard(p, dir.admins, dir.self) && p.role !== role);
    if (leavesNoAdmin(changing, role, dir.admins)) {
      toast("Cần giữ ít nhất một quản trị viên không gian làm việc", { tone: "danger" });
      return;
    }
    after?.();
    if (!changing.length) {
      if (blocked.length) toast(blocked.some((p) => p.user === dir.self) ? "Bạn không thể đổi vai trò của chính mình" : "Quản trị viên không gian làm việc cuối cùng phải giữ vai trò này", { tone: "danger" });
      return;
    }
    const prev = new Map(changing.map((p) => [p.user, p.role]));
    try {
      await applyRoles(ws, new Map(changing.map((p) => [p.user, role])), roleNames);
    } catch (error) {
      fail(error);
      refresh();
      return;
    }
    refresh();
    const msg = changing.length > 1 ? `${changing.length} người giờ là ${target.label}` : `${changing[0].displayName} hiện là ${target.label}`;
    toast(msg + (blocked.length ? `· đã bỏ qua ${plural(blocked.length, "person")}` : ""), {
      undo: () => {
        void applyRoles(ws, prev, roleNames)
          .then(() => toast("Đã hoàn tác thay đổi vai trò", { tone: "accent" }))
          .catch(fail)
          .finally(refresh);
      },
    });
  }

  /** Suspend one or more members (preview `suspend`): applies at once with Undo; you and the last admin are skipped. */
  async function suspend(people: readonly Person[], after?: () => void) {
    if (!dir) return;
    const all = people.filter((p) => p.state !== "SUSPENDED");
    const ms = all.filter((p) => !accountGuard(p, dir.admins, dir.self, "suspend"));
    if (!ms.length) {
      toast(all.length ? accountGuard(all[0], dir.admins, dir.self, "suspend") : "Tất cả người được chọn đã bị tạm ngưng", { tone: "danger" });
      return;
    }
    const one = ms.length === 1;
    const skipped = all.length - ms.length;
    try {
      await Promise.all(ms.map((p) => suspendMember(ws, p.name)));
    } catch (error) {
      fail(error);
      refresh();
      return;
    }
    after?.();
    refresh();
    toast((one ? `Đã tạm ngưng ${ms[0].displayName}` : `Đã tạm ngưng ${ms.length} người`) + (skipped ? `· đã bỏ qua ${plural(skipped, "person")}` : ""), {
      undo: () => void Promise.all(ms.map((p) => activateMember(ws, p.name))).catch(fail).finally(refresh),
    });
  }

  async function reactivate(person: Person) {
    try {
      await activateMember(ws, person.name);
    } catch (error) {
      fail(error);
      return;
    }
    refresh();
    toast(`${person.displayName} có thể đăng nhập lại`, {
      undo: () => void suspendMember(ws, person.name).catch(fail).finally(refresh),
    });
  }

  /** Remove from the workspace; Undo adds the account back with its role and groups. */
  async function remove(person: Person, after?: () => void) {
    if (!dir || accountGuard(person, dir.admins, dir.self, "remove")) return;
    const ok = await confirm({
      title: `Gỡ ${person.displayName}?`,
      description: `Họ mất quyền truy cập ${workspace.displayName} ngay lập tức. Các cuộc trò chuyện của họ sẽ bị xóa sau 30 ngày.`,
      confirmLabel: "Gỡ",
      tone: "danger",
    });
    if (!ok) return;
    try {
      await deleteMember(ws, person.name);
    } catch (error) {
      fail(error);
      return;
    }
    after?.();
    refresh();
    toast(`Đã gỡ ${person.displayName}`, {
      undo: () =>
        void createMember(ws, person.user, [person.role])
          .then((m) => Promise.all(person.groups.map((g) => addToGroup(ws, g, m.name ?? person.name))))
          .catch(fail)
          .finally(refresh),
    });
  }

  return { setRole, suspend, reactivate, remove };
}
