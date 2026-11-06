"use client";

import { Button, ProgressBar } from "@heroui/react";
import { ChartColumn, Download, FileText, MessageSquare, Users } from "lucide-react";
import { useState } from "react";

import { PageChrome } from "@/components/shell/page-chrome";
import { DataTable, EmptyState, Gate, Page, PageHeader, PreviewChip, Section, Segmented, SkeletonCards, SkeletonRows, StatCard, Tip, toast, WorkspaceMark } from "@/components/ui";
import { errorMessage } from "@/lib/api/client";
import { fmtNum } from "@/lib/format";

import { exportUsage, type UsageWindow, type Workspace } from "../api";
import { lastSegment } from "../model";
import { useUsage, useWorkspaceIndex } from "../queries";
import { openDownload, PREVIEW_TIP, useUrlState } from "./shared";
import { WorkspaceDrawer } from "./WorkspaceDrawer";

/** Preview `WINDOWS`; the API summarizes 1, 7 or 30 days, so 90 days is shown but unavailable. */
const WINDOWS: { value: string; label: string; isDisabled?: boolean }[] = [
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days", isDisabled: true },
];

const API_WINDOW: Record<string, UsageWindow> = { "7": "P7D", "30": "P30D" };

interface UsageRow {
  id: string;
  workspace?: Workspace;
  questions: number;
  active: number;
  processed: number;
}

/** Preview `P.pUsage`: demand by workspace for a window, sortable, with share of total; CSV export. */
export function UsagePage() {
  const url = useUrlState();
  const win = API_WINDOW[url.get("win")] ? url.get("win") : "30";
  const n = Number(win);
  const usage = useUsage(API_WINDOW[win]);
  const workspaces = useWorkspaceIndex();
  const [exporting, setExporting] = useState(false);

  const exportCsv = async () => {
    setExporting(true);
    try {
      openDownload(await exportUsage(API_WINDOW[win]));
      toast(`Saved usage for the last ${n} days`);
    } catch (error) {
      toast(errorMessage(error), { tone: "danger" });
    } finally {
      setExporting(false);
    }
  };

  const actions = (
    <>
      <Segmented label="Time range" value={win} options={WINDOWS} onChange={(v) => url.set({ win: v === "30" ? null : v })} />
      <Button variant="tertiary" isPending={exporting} onPress={() => void exportCsv()}>
        <Download className="i" aria-hidden />
        Export CSV
      </Button>
    </>
  );

  return (
    <Page>
      <PageChrome crumbs={[{ label: "Usage" }]} />
      <PageHeader title="Usage" chips={<PreviewChip tooltip={PREVIEW_TIP} />} actions={actions} />
      <Gate
        query={usage}
        skeleton={
          <>
            <SkeletonCards cards={3} />
            <div className="mt-16">
              <SkeletonRows rows={6} />
            </div>
          </>
        }
        isEmpty={(data) => data.length === 0}
        empty={<EmptyState icon={ChartColumn} title="No usage yet" description="Usage appears once people start asking questions." boxed />}
      >
        {(data) => {
          const rows: UsageRow[] = data.map((u) => {
            const id = lastSegment(u.workspace);
            return {
              id,
              workspace: workspaces.get(id),
              questions: Number(u.questionCount ?? 0),
              active: Number(u.activeMemberCount ?? 0),
              processed: Number(u.processedDocumentCount ?? 0),
            };
          });
          const total = (k: "questions" | "active" | "processed") => rows.reduce((a, r) => a + r[k], 0);
          const q = total("questions");
          const meta = `Last ${n} days`;
          return (
            <>
              <div className="grid cols-3">
                <StatCard icon={MessageSquare} label="Questions" value={fmtNum(q)} meta={meta} />
                <StatCard icon={Users} label="Active people" value={fmtNum(total("active"))} meta={meta} />
                <StatCard icon={FileText} label="Documents processed" value={fmtNum(total("processed"))} meta={meta} />
              </div>
              <Section title="By workspace">
                <DataTable
                  label="Usage by workspace"
                  rows={rows}
                  getRowId={(r) => r.id}
                  defaultSort={{ column: "questions", direction: "descending" }}
                  onRowAction={(r) => url.set({ open: r.id })}
                  columns={[
                    {
                      id: "name",
                      header: "Workspace",
                      primary: true,
                      sortValue: (r) => r.workspace?.displayName?.toLowerCase(),
                      cell: (r) => (
                        <div className="row gap-8">
                          <WorkspaceMark name={r.workspace?.displayName ?? "?"} size={24} />
                          <span className="cell-title truncate" translate="no">
                            {r.workspace?.displayName ?? "Removed workspace"}
                          </span>
                        </div>
                      ),
                    },
                    {
                      id: "questions",
                      header: "Questions",
                      align: "end",
                      sortValue: (r) => r.questions,
                      cell: (r) => {
                        const share = q ? (r.questions / q) * 100 : 0;
                        return (
                          <Tip content={`${share.toFixed(1)}% of all questions`}>
                            <span className="pf-share">
                              <span className="num">{fmtNum(r.questions)}</span>
                              <ProgressBar aria-label="Share of all questions" value={share} size="sm">
                                <ProgressBar.Track>
                                  <ProgressBar.Fill />
                                </ProgressBar.Track>
                              </ProgressBar>
                            </span>
                          </Tip>
                        );
                      },
                    },
                    { id: "active", header: "Active people", align: "end", mobileLabel: "Active people", sortValue: (r) => r.active, cell: (r) => <span className="num">{fmtNum(r.active)}</span> },
                    { id: "processed", header: "Documents processed", align: "end", className: "hide-md", hideOnMobile: true, sortValue: (r) => r.processed, cell: (r) => <span className="num">{fmtNum(r.processed)}</span> },
                  ]}
                />
              </Section>
            </>
          );
        }}
      </Gate>
      <WorkspaceDrawer workspaceId={url.get("open") || null} onClose={() => url.set({ open: null })} />
    </Page>
  );
}
