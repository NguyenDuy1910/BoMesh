"use client";

import { Button } from "@heroui/react";
import { Building2, FileText, MessageSquare, Plus, Users } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { PageChrome } from "@/components/shell/page-chrome";
import {
  ClearFilters,
  DataTable,
  EmptyState,
  FilterButton,
  Gate,
  NoMatches,
  Page,
  PageHeader,
  PreviewChip,
  SearchInput,
  SkeletonRows,
  StatCard,
  toast,
  WorkspaceMark,
} from "@/components/ui";
import { fmtCompact, fmtNum, plural } from "@/lib/format";

import type { Workspace } from "../api";
import { lastSegment, TEMPLATES, WORKSPACE_STATUS_OPTIONS, workspaceStatus, type TemplateId } from "../model";
import { useIsPlatformAdmin, usePlatformWorkspaces, useUsage } from "../queries";
import { CreateWorkspaceDialog } from "./CreateWorkspaceDialog";
import { PREVIEW_TIP, useUrlState, workspaceUrl } from "./shared";
import { TemplateChip, WorkspaceDrawer, WorkspaceStatusChip } from "./WorkspaceDrawer";

/** Preview `P.pWorkspaces`: KPIs, search, status and template filters, table, drawer, create. */
export function WorkspacesPage() {
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
        toast(`${w.displayName} is ready`, { action: { label: "View", onPress: () => url.set({ open: id }) } });
      }
    }
  });

  const usageBy = new Map((usage.data ?? []).map((u) => [lastSegment(u.workspace), u]));
  const questions = (w: Workspace) => Number(usageBy.get(lastSegment(w.name))?.questionCount ?? 0);
  const processed = (w: Workspace) => Number(usageBy.get(lastSegment(w.name))?.processedDocumentCount ?? 0);
  const usageCell = (v: number) => (usage.data ? fmtNum(v) : <span className="muted">—</span>);

  const create = isAdmin ? (
    <Button variant="primary" onPress={() => setCreating(true)}>
      <Plus className="i" aria-hidden />
      Create workspace
    </Button>
  ) : null;

  const onCreated = (w: Workspace) => {
    const id = lastSegment(w.name);
    url.set({ q: null, status: null, template: null });
    if (w.state === "CREATING") pending.current.add(id);
    setFresh(id);
    setTimeout(() => setFresh((cur) => (cur === id ? null : cur)), 2600);
  };

  return (
    <Page>
      <PageChrome crumbs={[{ label: "Workspaces" }]} />
      <PageHeader title="Workspaces" chips={<PreviewChip tooltip={PREVIEW_TIP} />} actions={create} />
      <Gate
        query={workspaces}
        skeleton={<SkeletonRows rows={7} />}
        isEmpty={(data) => data.length === 0}
        empty={
          <EmptyState
            icon={Building2}
            title="No workspaces yet"
            description="Create one for each customer or team. Its first admin sets up the rest."
            actions={
              isAdmin ? (
                <Button variant="tertiary" onPress={() => setCreating(true)}>
                  <Plus className="i" aria-hidden />
                  Create workspace
                </Button>
              ) : undefined
            }
            boxed
          />
        }
      >
        {(all) => {
          const sum = (f: (w: Workspace) => number) => all.reduce((a, w) => a + f(w), 0);
          const needle = q.trim().toLowerCase();
          const rows = all
            .filter(
              (w) =>
                (!needle || [w.displayName, w.code].some((v) => v?.toLowerCase().includes(needle))) &&
                (!status || workspaceStatus(w.state) === status) &&
                (!template || w.template === template),
            )
            .sort((a, b) => Date.parse(b.createTime ?? "") - Date.parse(a.createTime ?? ""));
          return (
            <>
              <div className="grid cols-4 pf-kpis">
                <StatCard icon={Building2} label="Active workspaces" value={fmtNum(all.filter((w) => w.state === "ACTIVE").length)} meta={`of ${fmtNum(all.length)}`} />
                <StatCard icon={Users} label="Members" value={fmtNum(sum((w) => w.memberCount ?? 0))} />
                <StatCard icon={FileText} label="Documents processed, 30 days" value={usage.data ? fmtCompact(sum(processed)) : "—"} />
                <StatCard icon={MessageSquare} label="Questions, 30 days" value={usage.data ? fmtCompact(sum(questions)) : "—"} />
              </div>
              <div className="toolbar">
                <SearchInput value={q} onChange={(v) => url.set({ q: v })} placeholder="Search workspaces" />
                <FilterButton label="Status" value={status} onChange={(v) => url.set({ status: v })} options={WORKSPACE_STATUS_OPTIONS} />
                <FilterButton
                  label="Template"
                  value={template}
                  onChange={(v) => url.set({ template: v })}
                  options={(Object.keys(TEMPLATES) as TemplateId[]).map((id) => ({ value: id, label: TEMPLATES[id].label }))}
                />
                <ClearFilters isActive={Boolean(status || template)} onClear={() => url.set({ status: null, template: null })} />
              </div>
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
                          <WorkspaceMark name={w.displayName ?? ""} size={32} />
                          <div className="stack">
                            <span className="cell-title truncate" translate="no">
                              {w.displayName}
                            </span>
                            <span className="cell-sub mono truncate">{workspaceUrl(w)}</span>
                          </div>
                        </div>
                      ),
                    },
                    { id: "template", header: "Template", mobileLabel: "Template", cell: (w) => <TemplateChip workspace={w} /> },
                    { id: "members", header: "Members", align: "end", mobileLabel: "Members", sortValue: (w) => w.memberCount ?? 0, cell: (w) => <span className="num">{fmtNum(w.memberCount ?? 0)}</span> },
                    { id: "processed", header: "Documents processed, 30 days", align: "end", hideOnMobile: true, className: "hide-md", sortValue: processed, cell: (w) => <span className="num">{usageCell(processed(w))}</span> },
                    { id: "questions", header: "Questions, 30 days", align: "end", mobileLabel: "Questions", sortValue: questions, cell: (w) => <span className="num">{usageCell(questions(w))}</span> },
                    { id: "status", header: "Status", cell: (w) => <WorkspaceStatusChip workspace={w} /> },
                  ]}
                  footer={
                    <div className="table-foot">
                      <span className="num">{plural(rows.length, "workspace")}</span>
                    </div>
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
