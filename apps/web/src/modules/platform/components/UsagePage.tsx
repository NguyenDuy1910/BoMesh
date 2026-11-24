"use client";

import { Button } from "@heroui/react";
import { ChartColumn, Download } from "lucide-react";
import { useState } from "react";

import { DataTable, EmptyState, Gate, Page, PageHeader, PreviewChip, ProgressBar, Segmented, SkeletonRows, Tip, toast, WorkspaceMark } from "@/components/ui";
import { errorMessage } from "@/lib/api/client";
import { fmtNum } from "@/lib/format";
import { useMessages } from "@/lib/i18n";

import { exportUsage, type UsageWindow, type Workspace } from "../api";
import { lastSegment } from "../model";
import { useUsage, useWorkspaceIndex } from "../queries";
import { openDownload, PREVIEW_TIP, useUrlState } from "./shared";
import { WorkspaceDrawer } from "./WorkspaceDrawer";

/** Preview `WINDOWS`, limited to the windows `workspaces:summarizeUsage` supports. */
const WINDOWS = [
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
] as const;

const API_WINDOW: Record<string, UsageWindow> = { "7": "P7D", "30": "P30D" };

interface UsageRow {
  id: string;
  workspace?: Workspace;
  questions: number;
  active: number;
  processed: number;
}

/** Preview `P.pUsage`: the range with the totals it describes, then demand by workspace with share of questions. */
export function UsagePage() {
  const m = useMessages();
  const url = useUrlState();
  const win = API_WINDOW[url.get("win")] ? url.get("win") : "30";
  const usage = useUsage(API_WINDOW[win]);
  const workspaces = useWorkspaceIndex();
  const [exporting, setExporting] = useState(false);

  const exportCsv = async () => {
    setExporting(true);
    try {
      openDownload(await exportUsage(API_WINDOW[win]));
      toast(`Saved usage for the last ${win} days`);
    } catch (error) {
      toast(errorMessage(error), { tone: "danger" });
    } finally {
      setExporting(false);
    }
  };

  return (
    <Page>
      <PageHeader
        title={m.nav.usage}
        chips={<PreviewChip tooltip={PREVIEW_TIP} />}
        actions={
          <Button variant="tertiary" isPending={exporting} isDisabled={!usage.data} onPress={() => void exportCsv()}>
            <Download className="i" aria-hidden />
            Export CSV
          </Button>
        }
      />
      <Gate
        query={usage}
        skeleton={<SkeletonRows rows={6} />}
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
          return (
            <>
              {/* Totals are one sentence next to the range they describe; the table carries the detail. */}
              <div className="toolbar pf-usage-bar">
                <Segmented label="Time range" value={win} options={WINDOWS} onChange={(v) => url.set({ win: v === "30" ? null : v })} />
                <p className="pf-usage-sum">
                  <span>
                    <span className="medium num">{fmtNum(q)}</span> questions
                  </span>
                  <span aria-hidden>·</span>
                  <span>
                    <span className="medium num">{fmtNum(total("active"))}</span> active people
                  </span>
                  <span aria-hidden>·</span>
                  <span>
                    <span className="medium num">{fmtNum(total("processed"))}</span> documents processed
                  </span>
                </p>
              </div>
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
                            <ProgressBar value={share} label="Share of all questions" />
                          </span>
                        </Tip>
                      );
                    },
                  },
                  { id: "active", header: "Active people", align: "end", mobileLabel: "Active people", sortValue: (r) => r.active, cell: (r) => <span className="num">{fmtNum(r.active)}</span> },
                  { id: "processed", header: "Documents processed", align: "end", className: "hide-md", hideOnMobile: true, sortValue: (r) => r.processed, cell: (r) => <span className="num">{fmtNum(r.processed)}</span> },
                ]}
              />
            </>
          );
        }}
      </Gate>
      <WorkspaceDrawer workspaceId={url.get("open") || null} onClose={() => url.set({ open: null })} />
    </Page>
  );
}
