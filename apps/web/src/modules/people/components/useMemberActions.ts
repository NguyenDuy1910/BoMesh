"use client";

import { useWorkspace } from "@/lib/workspace";
import { errorMessage } from "@/lib/api/client";
import { plural } from "@/lib/format";
import { confirm, toast } from "@/components/ui";

import { activateMember, addToGroup, createMember, deleteMember, suspendMember } from "../api";
import { accountGuard, firstName, leavesNoAdmin, roleGuard } from "../model";
import { applyRoles, usePeopleClient, type Directory, type Person } from "../queries";

const fail = (error: unknown) => toast(errorMessage(error), { tone: "danger" });

/** Membership actions shared by the Members table, bulk bar and member drawer (preview setRole/suspend/reactivate/remove). */
export function useMemberActions(dir: Directory | undefined) {
  const { refresh, ws } = usePeopleClient();
  const { workspace } = useWorkspace();
  const roleNames = new Set(dir?.roles.map((r) => r.name) ?? []);

  /** Change role for one or more members; guarded (self, last admin) and undoable. */
  async function setRole(ids: readonly string[], role: string, after?: () => void) {
    if (!dir) return;
    const target = dir.roleByName.get(role);
    if (!target) return;
    const all = ids.map((id) => dir.personById.get(id)).filter((p): p is Person => Boolean(p));
    const blocked = all.filter((p) => roleGuard(p, dir.people, dir.self) && p.role !== role);
    const changing = all.filter((p) => !roleGuard(p, dir.people, dir.self) && p.role !== role);
    if (leavesNoAdmin(changing, role, dir.people)) {
      toast("Keep at least one workspace admin", { tone: "danger" });
      return;
    }
    after?.();
    if (!changing.length) {
      if (blocked.length) toast(blocked.some((p) => p.user === dir.self) ? "You can’t change your own role" : "The last workspace admin keeps this role", { tone: "danger" });
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
    const msg = changing.length > 1 ? `${changing.length} people are now ${target.label}` : `${changing[0].displayName} is now ${target.label}`;
    toast(msg + (blocked.length ? ` · ${plural(blocked.length, "person", "people")} skipped` : ""), {
      undo: () => {
        void applyRoles(ws, prev, roleNames)
          .then(() => toast("Role change undone", { tone: "accent" }))
          .catch(fail)
          .finally(refresh);
      },
    });
  }

  async function suspend(ids: readonly string[], after?: () => void) {
    if (!dir) return;
    const all = ids.map((id) => dir.personById.get(id)).filter((p): p is Person => Boolean(p) && p!.state !== "SUSPENDED");
    const ms = all.filter((p) => !accountGuard(p, dir.people, dir.self, "suspend"));
    if (!ms.length) {
      toast(all.length ? accountGuard(all[0], dir.people, dir.self, "suspend") : "Everyone selected is already suspended", { tone: "danger" });
      return;
    }
    const one = ms.length === 1;
    const ok = await confirm({
      title: one ? `Suspend ${ms[0].displayName}?` : `Suspend ${ms.length} people?`,
      description: `${one ? firstName(ms[0].displayName) : "They"} won’t be able to sign in until reactivated. Nothing they own is deleted.${all.length > ms.length ? " You and the last admin are skipped." : ""}`,
      confirmLabel: "Suspend",
      tone: "danger",
    });
    if (!ok) return;
    try {
      await Promise.all(ms.map((p) => suspendMember(ws, p.name)));
    } catch (error) {
      fail(error);
      refresh();
      return;
    }
    after?.();
    refresh();
    toast(one ? `Suspended ${ms[0].displayName}` : `Suspended ${ms.length} people`, {
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
    toast(`${firstName(person.displayName)} can sign in again`, {
      undo: () => void suspendMember(ws, person.name).catch(fail).finally(refresh),
    });
  }

  /** Remove from the workspace; Undo adds the account back with its role and groups. */
  async function remove(person: Person, after?: () => void) {
    if (!dir || accountGuard(person, dir.people, dir.self, "remove")) return;
    const ok = await confirm({
      title: `Remove ${person.displayName}?`,
      description: `They lose access to ${workspace.displayName} right away. Their chats are deleted after 30 days.`,
      confirmLabel: "Remove",
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
    toast(`Removed ${person.displayName}`, {
      undo: () =>
        void createMember(ws, person.user, [person.role])
          .then((m) => Promise.all(person.groups.map((g) => addToGroup(ws, g, m.name ?? person.name))))
          .catch(fail)
          .finally(refresh),
    });
  }

  return { setRole, suspend, reactivate, remove };
}
