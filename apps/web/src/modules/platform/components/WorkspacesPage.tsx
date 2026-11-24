"use client";

import { Button } from "@heroui/react";
import { Building2, Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { ClearFilters, DataTable, EmptyState, FilterButton, Gate, NoMatches, Page, PageHeader, PreviewChip, SearchInput, SkeletonRows, toast, WorkspaceMark } from "@/components/ui";
import { fmtNum, plural } from "@/lib/format";
import { useMessages } from "@/lib/i18n";

import type { Workspace } from "../api";
import { lastSegment, TEMPLATES, WORKSPACE_STATUS_OPTIONS, workspaceStatus, type TemplateId, type WorkspaceStatus } from "../model";
import { useIsPlatformAdmin, usePlatformWorkspaces, useUsage } from "../queries";
import { CreateWorkspaceDialog } from "./CreateWorkspaceDialog";
import { PREVIEW_TIP, useUrlState, workspaceUrl } from "./shared";
import { TemplateChip, WorkspaceDrawer, WorkspaceStatusChip } from "./WorkspaceDrawer";

/** Search and filters appear once the list is long enough to need them (preview `TOOLS_MIN`). */
const TOOLS_MIN = 7;

/** What needs an operator first: setting up, then suspended, then the steady state, archived last. */
const RANK: Record<WorkspaceStatus, number> = { new: 1, suspended: 2, active: 3, archived: 4 };

/** Preview `wsSummary`: how many workspaces, and which ones aren't simply active. */
function summary(all: readonly Workspace[]): string {
  const count = (s: WorkspaceStatus) => all.filter((w) => workspaceStatus(w.state) === s).length;
  const suspended = count("suspended");
  const fresh = count("new");
  const archived = count("archived");
  const parts = [plural(all.length, "workspace")];
  if (suspended) parts.push(`${fmtNum(suspended)} suspended`);
  if (fresh) parts.push(`${fmtNum(fresh)} setting up`);
  if (archived) parts.push(`${fmtNum(archived)} archived`);
  if (parts.length === 1) parts.push("all active");
  return parts.join(" · ");
}

/** Preview `P.pWorkspaces`: one table of workspaces (what needs an operator first), drawer, create. */
export function WorkspacesPage() {
  const m = useMessages();
  const url = useUrlState();
  const isAdmin = useIsPlatformAdmin();
  const workspaces = usePlatformWorkspaces();
  const usage = useUsage("P30D");
  const [creating, setCreating] = useState(false);
  const [fresh, setFresh] = useState<string | null>(null);
  const pending = useRef(new Set<string>());
  const { refetch } = workspaces;

  const q = url.get("q");
  const status = url.get("status");
  const template = url.get("template");

  // A new workspace is CREATING until provisioning finishes; poll and announce when it's ready.
  const settingUp = (workspaces.data ?? []).filter((w) => w.state === "CREATING");
  useEffect(() => {
    if (!settingUp.length) return;
    const t = setInterval(() => void refetch(), 2000);
    return () => clearInterval(t);
  }, [settingUp.length, refetch]);
  useEffect(() => {
    for (const id of [...pending.current]) {
      const w = workspaces.data?.find((x) => lastSegment(x.name) === id);
      if (w && w.state !== "CREATING") {
        pending.current.delete(id);
        toast(`${w.displayName} is ready`, { action: { label: "Open", onPress: () => url.set({ open: id }) } });
      }
    }
  });

  const questionsBy = new Map((usage.data ?? []).map((u) => [lastSegment(u.workspace), Number(u.questionCount ?? 0)]));
  const questions = (w: Workspace) => questionsBy.get(lastSegment(w.name)) ?? 0;

  const createButton = (variant: "primary" | "tertiary") => (
    <Button variant={variant} onPress={() => setCreating(true)}>
      <Plus className="i" aria-hidden />
      Create workspace
    </Button>
  );

  const onCreated = (w: Workspace) => {
    const id = lastSegment(w.name);
    url.set({ q: null, status: null, template: null });
    if (w.state === "CREATING") pending.current.add(id);
    setFresh(id);
    setTimeout(() => setFresh((cur) => (cur === id ? null : cur)), 2600);
  };

  const all = workspaces.data ?? [];
  // Templates only help when workspaces differ; otherwise the chip and filter are noise.
  const mixed = new Set(all.map((w) => w.template ?? "ENTERPRISE")).size > 1;
  const filtered = Boolean(q || status || template);

  return (
    <Page width="wide">
      <PageHeader
        title={m.nav.workspaces}
        chips={<PreviewChip tooltip={PREVIEW_TIP} />}
        meta={workspaces.data?.length ? summary(workspaces.data) : undefined}
        actions={isAdmin ? createButton("primary") : null}
      />
      <Gate
        query={workspaces}
        skeleton={<SkeletonRows rows={7} />}
        isEmpty={(data) => data.length === 0}
        empty={
          <EmptyState
            icon={Building2}
            title="No workspaces yet"
            description="Create one for each customer or team. Its first admin sets up the rest."
            actions={isAdmin ? createButton("tertiary") : undefined}
            boxed
          />
        }
      >
        {(data) => {
          const needle = q.trim().toLowerCase();
          const rows = data
            .filter(
              (w) =>
                (!needle || [w.displayName, w.code].some((v) => v?.toLowerCase().includes(needle))) &&
                (!status || workspaceStatus(w.state) === status) &&
                (!template || w.template === template),
            )
            .sort((a, b) => RANK[workspaceStatus(a.state)] - RANK[workspaceStatus(b.state)] || Date.parse(b.createTime ?? "") - Date.parse(a.createTime ?? ""));
          return (
            <>
              {data.length >= TOOLS_MIN || filtered ? (
                <div className="toolbar">
                  <SearchInput value={q} onChange={(v) => url.set({ q: v })} placeholder="Search workspaces" />
                  <FilterButton label="Status" value={status} onChange={(v) => url.set({ status: v })} options={WORKSPACE_STATUS_OPTIONS} />
                  {mixed || template ? (
                    <FilterButton
                      label="Template"
                      value={template}
                      onChange={(v) => url.set({ template: v })}
                      options={(Object.keys(TEMPLATES) as TemplateId[]).map((id) => ({ value: id, label: TEMPLATES[id].label }))}
                    />
                  ) : null}
                  <ClearFilters isActive={Boolean(status || template)} onClear={() => url.set({ status: null, template: null })} />
                </div>
              ) : null}
              {rows.length ? (
                <DataTable
                  label="Workspaces"
                  rows={rows}
                  getRowId={(w) => lastSegment(w.name)}
                  onRowAction={(w) => url.set({ open: lastSegment(w.name) })}
                  rowClassName={(w) => (lastSegment(w.name) === fresh ? "table__row--new" : undefined)}
                  columns={[
                    {
                      id: "name",
                      header: "Workspace",
                      primary: true,
                      sortValue: (w) => w.displayName?.toLowerCase(),
                      cell: (w) => (
                        <div className="row gap-12">
                          <WorkspaceMark name={w.displayName ?? ""} logo={w.logoUri} size={32} />
                          <div className="stack">
                            <span className="cell-title row gap-8">
                              <span className="truncate" translate="no">
                                {w.displayName}
                              </span>
                              {mixed ? <TemplateChip workspace={w} /> : null}
                            </span>
                            <span className="cell-sub mono truncate">{workspaceUrl(w)}</span>
                          </div>
                        </div>
                      ),
                    },
                    { id: "members", header: "Members", align: "end", mobileLabel: "Members", sortValue: (w) => w.memberCount ?? 0, cell: (w) => <span className="num">{fmtNum(w.memberCount ?? 0)}</span> },
                    {
                      id: "questions",
                      header: "Questions, 30 days",
                      align: "end",
                      mobileLabel: "Questions",
                      sortValue: questions,
                      cell: (w) => (usage.data ? <span className="num">{fmtNum(questions(w))}</span> : <span className="muted">—</span>),
                    },
                    { id: "status", header: "Status", cell: (w) => <WorkspaceStatusChip workspace={w} /> },
                  ]}
                  footer={
                    filtered ? (
                      <div className="table-foot">
                        <span className="num">{plural(rows.length, "workspace")}</span>
                      </div>
                    ) : undefined
                  }
                />
              ) : (
                <NoMatches what="workspaces" onClear={() => url.set({ q: null, status: null, template: null })} />
              )}
            </>
          );
        }}
      </Gate>
      <CreateWorkspaceDialog isOpen={creating} onClose={() => setCreating(false)} onCreated={onCreated} />
      <WorkspaceDrawer workspaceId={url.get("open") || null} onClose={() => url.set({ open: null })} />
    </Page>
  );
}
