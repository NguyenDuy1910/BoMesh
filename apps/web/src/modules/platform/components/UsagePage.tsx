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
  { value: "7", label: "7 ngày" },
  { value: "30", label: "30 ngày" },
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
      toast(`Đã lưu mức sử dụng của ${win} ngày qua`);
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
            Xuất CSV
          </Button>
        }
      />
      <Gate
        query={usage}
        skeleton={<SkeletonRows rows={6} />}
        isEmpty={(data) => data.length === 0}
        empty={<EmptyState icon={ChartColumn} title="Chưa có mức sử dụng" description="Mức sử dụng sẽ hiển thị khi mọi người bắt đầu đặt câu hỏi." boxed />}
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
                <Segmented label="Khoảng thời gian" value={win} options={WINDOWS} onChange={(v) => url.set({ win: v === "30" ? null : v })} />
                <p className="pf-usage-sum">
                  <span>
                    <span className="medium num">{fmtNum(q)}</span> câu hỏi
                  </span>
                  <span aria-hidden>·</span>
                  <span>
                    <span className="medium num">{fmtNum(total("active"))}</span> người hoạt động
                  </span>
                  <span aria-hidden>·</span>
                  <span>
                    <span className="medium num">{fmtNum(total("processed"))}</span> tài liệu đã xử lý
                  </span>
                </p>
              </div>
              <DataTable
                label="Mức sử dụng theo không gian làm việc"
                rows={rows}
                getRowId={(r) => r.id}
                defaultSort={{ column: "questions", direction: "descending" }}
                onRowAction={(r) => url.set({ open: r.id })}
                columns={[
                  {
                    id: "name",
                    header: "Không gian làm việc",
                    primary: true,
                    sortValue: (r) => r.workspace?.displayName?.toLowerCase(),
                    cell: (r) => (
                      <div className="row gap-8">
                        <WorkspaceMark name={r.workspace?.displayName ?? "?"} logo={r.workspace?.logoUri} size={24} />
                        <span className="cell-title truncate" translate="no">
                          {r.workspace?.displayName ?? "Không gian làm việc đã gỡ"}
                        </span>
                      </div>
                    ),
                  },
                  {
                    id: "questions",
                    header: "Câu hỏi",
                    align: "end",
                    sortValue: (r) => r.questions,
                    cell: (r) => {
                      const share = q ? (r.questions / q) * 100 : 0;
                      return (
                        <Tip content={`${share.toLocaleString("vi-VN", { maximumFractionDigits: 1, minimumFractionDigits: 1 })}% tổng số câu hỏi`}>
                          <span className="pf-share">
                            <span className="num">{fmtNum(r.questions)}</span>
                            <ProgressBar value={share} label="Tỷ lệ trên tổng số câu hỏi" />
                          </span>
                        </Tip>
                      );
                    },
                  },
                  { id: "active", header: "Người dùng hoạt động", align: "end", mobileLabel: "Người dùng hoạt động", sortValue: (r) => r.active, cell: (r) => <span className="num">{fmtNum(r.active)}</span> },
                  { id: "processed", header: "Tài liệu đã xử lý", align: "end", className: "hide-md", hideOnMobile: true, sortValue: (r) => r.processed, cell: (r) => <span className="num">{fmtNum(r.processed)}</span> },
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
