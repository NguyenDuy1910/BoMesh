"use client";

import { Button } from "@heroui/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, ArrowRight, Building2, Copy, GraduationCap, Pause, Play, Undo2 } from "lucide-react";
import { useRouter } from "next/navigation";

import { useShellWorkspaces } from "@/components/shell/WorkspaceMenu";
import { Callout, EmptyState, KeyValue, List, ListItem, SkeletonRows, StatusChip, toast, UserAvatar, WorkspaceMark } from "@/components/ui";
import { errorMessage, resourceId } from "@/lib/api/client";
import { fmtDate, fmtNum, rel } from "@/lib/format";
import { rememberWorkspace } from "@/lib/workspace";
import { markWorkspaceOpened } from "@/modules/auth/api";

import { activateWorkspace, archiveWorkspace, listWorkspaceAdmins, suspendWorkspace, type Workspace } from "../api";
import { lastSegment, TEMPLATES, workspaceStatus } from "../model";
import { pk, useInvalidatePlatform, useIsPlatformAdmin, usePlatformWorkspaces, useUsage } from "../queries";
import { copyText, MoreMenu, PlatformDrawer, workspaceUrl } from "./shared";

/** Template chip (preview `tplChip`). */
export function TemplateChip({ workspace }: { workspace: Workspace }) {
  const t = TEMPLATES[workspace.template ?? "ENTERPRISE"];
  return <StatusChip label={t.label} icon={workspace.template === "CAMPUS" ? GraduationCap : Building2} tooltip={t.description} size="sm" />;
}

/** Workspace status chip: preview `status('ws', …)` plus "Archived". */
export function WorkspaceStatusChip({ workspace }: { workspace: Workspace }) {
  const status = workspaceStatus(workspace.state);
  if (status === "archived") return <StatusChip label="Archived" tone="default" />;
  return <StatusChip kind="ws" value={status} />;
}

/**
 * Open, copy the address of, suspend, reactivate or restore a workspace (preview `openWs` / `suspendWs` /
 * `restoreWs`). Suspending deletes nothing and restoring is reversible: both apply at once with Undo.
 */
export function useWorkspaceActions() {
  const router = useRouter();
  const client = useQueryClient();
  const invalidate = useInvalidatePlatform();
  const { workspaces: mine } = useShellWorkspaces(true);

  const isMember = (w: Workspace) => mine.some((m) => m.name === w.name);

  const open = (w: Workspace) => {
    if (!isMember(w)) {
      toast(`You’re not a member of ${w.displayName}`, { tone: "accent" });
      return;
    }
    const id = lastSegment(w.name);
    markWorkspaceOpened(id);
    void rememberWorkspace(id).then(() => {
      client.clear();
      router.push("/overview");
      toast(`Switched to ${w.displayName}`, { tone: "accent" });
    });
  };

  const copyUrl = (w: Workspace) => void copyText(`${window.location.protocol}//${workspaceUrl(w)}`, "Copied workspace URL");

  // The shell's own workspace list follows too (switcher, and "Open workspace" needs it for membership).
  const refresh = () => invalidate(pk.workspaces, ["shell", "my-workspaces"]);

  const run = async (work: () => Promise<Workspace>, message?: string, undo?: (updated: Workspace) => Promise<unknown>) => {
    try {
      const updated = await work();
      await refresh();
      if (message) {
        toast(message, undo ? { undo: () => void undo(updated).then(refresh).catch((error: unknown) => toast(errorMessage(error), { tone: "danger" })) } : {});
      }
    } catch (error) {
      toast(errorMessage(error), { tone: "danger" });
    }
  };

  /** Suspend an active workspace or reactivate a suspended one. */
  const toggleSuspend = (w: Workspace) => {
    const on = w.state !== "SUSPENDED";
    return run(
      () => (on ? suspendWorkspace(w) : activateWorkspace(w)),
      on ? `Suspended ${w.displayName}. Members can’t sign in.` : `Reactivated ${w.displayName}`,
      (updated) => (on ? activateWorkspace(updated) : suspendWorkspace(updated)),
    );
  };

  /** Restore an archived workspace (`:activate` also unarchives); Undo archives it again. */
  const restore = (w: Workspace) => run(() => activateWorkspace(w), `Restored ${w.displayName}`, (updated) => archiveWorkspace(updated));

  return { open, copyUrl, toggleSuspend, restore, isMember };
}

/** Preview `DR['pf-ws']`: status, questions, admins; one way forward per status in the footer; rare actions in ⋯. */
export function WorkspaceDrawer({ workspaceId, onClose }: { workspaceId: string | null; onClose: () => void }) {
  const workspaces = usePlatformWorkspaces();
  const isAdmin = useIsPlatformAdmin();
  const actions = useWorkspaceActions();
  const w = workspaceId ? workspaces.data?.find((x) => lastSegment(x.name) === workspaceId) : undefined;
  const week = useUsage("P7D");
  const month = useUsage("P30D");
  const admins = useQuery({
    queryKey: ["platform", "workspace-admins", workspaceId],
    queryFn: () => listWorkspaceAdmins(workspaceId ?? ""),
    enabled: Boolean(w),
    staleTime: 60_000,
  });

  if (!workspaceId) return <PlatformDrawer isOpen={false} onClose={onClose} title="">{null}</PlatformDrawer>;

  if (!w) {
    return (
      <PlatformDrawer isOpen onClose={onClose} title={workspaces.isPending ? "Loading workspace" : "Workspace not found"}>
        {workspaces.isPending ? <SkeletonRows rows={4} /> : <EmptyState icon={Building2} title="This workspace no longer exists" compact />}
      </PlatformDrawer>
    );
  }

  const status = workspaceStatus(w.state);
  const off = status === "suspended" || status === "archived";
  const questions = (rows: typeof month.data) => Number(rows?.find((u) => u.workspace === w.name)?.questionCount ?? 0);

  // One way forward per status: restore an archived one, reactivate a suspended one, otherwise open it (members only).
  const footer =
    status === "archived" && isAdmin ? (
      <Button variant="primary" onPress={() => void actions.restore(w)}>
        <Undo2 className="i" aria-hidden />
        Restore workspace
      </Button>
    ) : status === "suspended" && isAdmin ? (
      <Button variant="primary" onPress={() => void actions.toggleSuspend(w)}>
        <Play className="i" aria-hidden />
        Reactivate
      </Button>
    ) : !off && actions.isMember(w) ? (
      <Button variant="primary" onPress={() => actions.open(w)}>
        Open workspace
        <ArrowRight className="i" aria-hidden />
      </Button>
    ) : null;

  return (
    <PlatformDrawer
      isOpen
      onClose={onClose}
      lead={<WorkspaceMark name={w.displayName ?? ""} size={40} />}
      title={<span translate="no">{w.displayName}</span>}
      description={<span className="mono">{workspaceUrl(w)}</span>}
      headActions={
        <MoreMenu
          items={[
            { id: "copy", label: "Copy URL", icon: Copy, onAction: () => actions.copyUrl(w) },
            ...(isAdmin && w.state === "ACTIVE" ? [{ id: "suspend", label: "Suspend workspace", icon: Pause, danger: true, separator: true, onAction: () => void actions.toggleSuspend(w) }] : []),
          ]}
        />
      }
      footer={footer}
    >
      {status === "archived" ? (
        <div className="drawer__section">
          <Callout
            tone="default"
            icon={Archive}
            title="Archived"
            description={`Archived ${rel(w.updateTime).toLowerCase()}. Members can’t open it until it’s restored.`}
          />
        </div>
      ) : null}
      <div className="drawer__section">
        <KeyValue
          pairs={[
            ["Status", <WorkspaceStatusChip key="s" workspace={w} />],
            ["Template", <TemplateChip key="t" workspace={w} />],
            ["Created", fmtDate(w.createTime)],
            ["Members", <span key="m" className="num">{fmtNum(w.memberCount ?? 0)}</span>],
          ]}
        />
      </div>
      <div className="drawer__section">
        <div className="pf-sec-head">
          <h3 className="drawer__section-title">Questions, last 30 days</h3>
          <span className="t-xs muted num">{month.data ? fmtNum(questions(month.data)) : ""}</span>
        </div>
        <p className="t-sm muted">
          {off
            ? `No questions while ${status === "archived" ? "archived" : "suspended"}.`
            : week.data
              ? `${fmtNum(questions(week.data))} in the last 7 days.`
              : "—"}
        </p>
      </div>
      <div className="drawer__section">
        <h3 className="drawer__section-title">Admins</h3>
        {admins.isPending ? (
          <SkeletonRows rows={2} />
        ) : admins.data === null ? (
          <p className="t-sm muted">Only members of this workspace can see its admins.</p>
        ) : admins.isError ? (
          <p className="t-sm muted">Admins didn’t load.</p>
        ) : admins.data?.length ? (
          <List>
            {admins.data.map((a) => (
              <ListItem
                key={a.name}
                lead={<UserAvatar name={a.displayName ?? a.email ?? ""} size="sm" />}
                title={a.displayName ?? a.email ?? resourceId(a.user)}
                description={a.email}
              />
            ))}
          </List>
        ) : (
          <p className="t-sm muted">No admins yet. The first admin’s invite is pending.</p>
        )}
      </div>
    </PlatformDrawer>
  );
}
