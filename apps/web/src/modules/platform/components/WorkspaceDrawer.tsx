"use client";

import { Button } from "@heroui/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Building2, Copy, GraduationCap, Pause, Play } from "lucide-react";
import { useRouter } from "next/navigation";

import { useShellWorkspaces } from "@/components/shell/WorkspaceMenu";
import { Callout, confirm, EmptyState, KeyValue, List, ListItem, SkeletonRows, StatusChip, toast, UserAvatar, WorkspaceMark } from "@/components/ui";
import { errorMessage, resourceId } from "@/lib/api/client";
import { fmtDate, fmtNum } from "@/lib/format";
import { rememberWorkspace } from "@/lib/workspace";
import { markWorkspaceOpened } from "@/modules/auth/api";

import { activateWorkspace, listWorkspaceAdmins, suspendWorkspace, type Workspace } from "../api";
import { lastSegment, TEMPLATES, workspaceStatus } from "../model";
import { pk, useInvalidatePlatform, useIsPlatformAdmin, usePlatformWorkspaces, useUsage } from "../queries";
import { PlatformDrawer, workspaceUrl } from "./shared";

/** Template chip (preview `tplChip`). */
export function TemplateChip({ workspace }: { workspace: Workspace }) {
  const t = TEMPLATES[workspace.template ?? "ENTERPRISE"];
  return <StatusChip label={t.label} icon={workspace.template === "CAMPUS" ? GraduationCap : Building2} tooltip={t.description} size="sm" />;
}

/** Workspace status chip: preview `status('ws', …)`; ARCHIVED has no preview entry and reads "Archived". */
export function WorkspaceStatusChip({ workspace }: { workspace: Workspace }) {
  const status = workspaceStatus(workspace.state);
  if (status === "archived") return <StatusChip label="Archived" tone="default" />;
  return <StatusChip kind="ws" value={status} />;
}

/** Open, copy the address of, suspend or reactivate a workspace (preview `openWs` / `suspendWs`). */
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

  const copyUrl = async (w: Workspace) => {
    try {
      await navigator.clipboard.writeText(`${window.location.protocol}//${workspaceUrl(w)}`);
      toast("Copied workspace URL");
    } catch {
      toast("Couldn’t copy. Select the address and copy it instead.", { tone: "danger" });
    }
  };

  const toggleSuspend = async (w: Workspace) => {
    const suspended = w.state === "SUSPENDED" || w.state === "ARCHIVED";
    const ok = suspended
      ? await confirm({ title: `Reactivate ${w.displayName}?`, description: "Members can sign in again right away.", confirmLabel: "Reactivate", tone: "accent" })
      : await confirm({
          title: `Suspend ${w.displayName}?`,
          description: `Members can’t sign in while it’s suspended. Nothing is deleted.${isMember(w) ? " You’ll lose access too." : ""}`,
          confirmLabel: "Suspend workspace",
          tone: "danger",
        });
    if (!ok) return;
    try {
      await (suspended ? activateWorkspace(w) : suspendWorkspace(w));
      await invalidate(pk.workspaces);
      toast(suspended ? `Reactivated ${w.displayName}` : `Suspended ${w.displayName}`);
    } catch (error) {
      toast(errorMessage(error), { tone: "danger" });
    }
  };

  return { open, copyUrl, toggleSuspend, isMember };
}

/** Preview `DR['pf-ws']`: status, usage, admins; suspend or reactivate; copy URL; open. */
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

  const usageOf = (rows: typeof month.data) => rows?.find((u) => u.workspace === w.name);
  const m = usageOf(month.data);
  const wk = usageOf(week.data);
  const off = w.state === "SUSPENDED" || w.state === "ARCHIVED";
  const num = (v: string | undefined, loaded: boolean) => (loaded ? <span className="num">{fmtNum(Number(v ?? 0))}</span> : <span className="muted">—</span>);

  return (
    <PlatformDrawer
      isOpen
      onClose={onClose}
      lead={<WorkspaceMark name={w.displayName ?? ""} size={40} />}
      title={<span translate="no">{w.displayName}</span>}
      description={<span className="mono">{workspaceUrl(w)}</span>}
      footerStart={
        isAdmin && w.state !== "CREATING" ? (
          off ? (
            <Button variant="tertiary" onPress={() => void actions.toggleSuspend(w)}>
              <Play className="i" aria-hidden />
              Reactivate
            </Button>
          ) : (
            <Button variant="danger-soft" onPress={() => void actions.toggleSuspend(w)}>
              <Pause className="i" aria-hidden />
              Suspend
            </Button>
          )
        ) : null
      }
      footer={
        <>
          <Button variant="tertiary" onPress={() => void actions.copyUrl(w)}>
            <Copy className="i" aria-hidden />
            Copy URL
          </Button>
          <Button variant="primary" onPress={() => actions.open(w)}>
            Open workspace
            <ArrowRight className="i" aria-hidden />
          </Button>
        </>
      }
    >
      {w.state === "ARCHIVED" ? (
        <div className="drawer__section">
          <Callout tone="warning" title="Archived" description="This workspace is read-only. Reactivate it to make changes." />
        </div>
      ) : null}
      <div className="drawer__section">
        <KeyValue
          pairs={[
            ["Status", <WorkspaceStatusChip key="s" workspace={w} />],
            ["Template", <TemplateChip key="t" workspace={w} />],
            ["Created", fmtDate(w.createTime)],
            ["Members", <span key="m" className="num">{fmtNum(w.memberCount ?? 0)}</span>],
            ["Active people", <span key="a">{num(m?.activeMemberCount, Boolean(month.data))}<span className="muted"> · 30 days</span></span>],
            ["Documents", <span key="d">{num(m?.processedDocumentCount, Boolean(month.data))}<span className="muted"> processed · 30 days</span></span>],
            ["Indexing", w.ingestionState === "PAUSED" ? "Paused" : "Running"],
          ]}
        />
      </div>
      <div className="drawer__section">
        <div className="pf-sec-head">
          <h3 className="drawer__section-title">Questions, last 30 days</h3>
          <span className="t-xs muted num">{month.data ? fmtNum(Number(m?.questionCount ?? 0)) : ""}</span>
        </div>
        <p className="t-sm muted">
          {off ? "No questions while suspended." : week.data ? `${fmtNum(Number(wk?.questionCount ?? 0))} in the last 7 days.` : "—"}
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
