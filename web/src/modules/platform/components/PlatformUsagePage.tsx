"use client";

import { ChartColumn } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Page } from "@/components/shell/Page";
import { BarsChart } from "@/components/ui/BarsChart";
import { CellTitle, DataTable, type DataTableColumn } from "@/components/ui/DataTable";
import { ui } from "@/components/ui/design-system";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { PageHeader } from "@/components/ui/PageHeader";
import { PreviewTag } from "@/components/ui/PreviewTag";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Skeleton, SkeletonRows } from "@/components/ui/Skeleton";
import { usePendingFeature } from "@/lib/api/pending";
import { cn } from "@/lib/cn";
import {
  getPlatformUsage,
  type PlatformUsageTotals,
  type PlatformUsageWindow,
  type PlatformUsageWorkspace,
} from "@/modules/platform/api";
import { WorkspaceMark } from "@/modules/platform/components/WorkspaceMark";
import { useApiData } from "@/lib/hooks/useApiData";

const WINDOWS: { value: PlatformUsageWindow; label: string }[] = [
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
  { value: "90d", label: "90 days" },
];

const STATS: { key: keyof PlatformUsageTotals; label: string }[] = [
  { key: "questions", label: "Questions" },
  { key: "active_people", label: "Active people" },
  { key: "documents_processed", label: "Documents processed" },
];

const dayLabel = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", timeZone: "UTC" });

function change(current: number, previous: number, windowLabel: string): string {
  if (!previous) return current ? `None in the previous ${windowLabel}` : `Same as the previous ${windowLabel}`;
  const percent = Math.round(((current - previous) / previous) * 100);
  return `${percent >= 0 ? "+" : "−"}${Math.abs(percent)}% vs previous ${windowLabel}`;
}

/**
 * Platform → Usage: demand across every workspace for one window — three
 * totals against the window before, questions per day, and a sortable table
 * per workspace. All figures come from `platform.usage`.
 */
export function PlatformUsagePage() {
  const enabled = usePendingFeature("platform.usage");
  const router = useRouter();
  const [period, setPeriod] = useState<PlatformUsageWindow>("30d");
  const query = useApiData(
    () => (enabled ? getPlatformUsage({ window: period }) : Promise.resolve(null)),
    `${enabled}:${period}`,
  );
  const windowLabel = WINDOWS.find((option) => option.value === period)!.label;
  // A refetch for another window keeps the old figures on screen; only show them when they match.
  const usage = query.data?.window === period ? query.data : null;

  if (!enabled) {
    return (
      <Page>
        <PageHeader sub="Demand across every workspace." title="Usage" />
        <EmptyState
          description="Usage reporting isn’t part of this deployment yet."
          icon={<ChartColumn aria-hidden="true" />}
          title="Usage isn’t available here"
        />
      </Page>
    );
  }

  const columns: DataTableColumn<PlatformUsageWorkspace>[] = [
    {
      id: "name",
      header: "Workspace",
      sortable: true,
      sortValue: (row) => row.name.toLowerCase(),
      cell: (row) => <CellTitle icon={<WorkspaceMark name={row.name} size="sm" />} title={row.name} />,
    },
    {
      id: "questions",
      header: "Questions",
      align: "right",
      width: 170,
      sortable: true,
      cell: (row) => {
        const share = usage?.totals.questions ? (row.questions / usage.totals.questions) * 100 : 0;
        return (
          <div className="ml-auto w-full max-w-[120px]">
            <div>{row.questions.toLocaleString()}</div>
            <div className="mt-1.5 h-[3px] overflow-hidden rounded-xs bg-surface-inset" title={`${share.toFixed(1)}% of all questions`}>
              <span className="block h-full rounded-xs bg-accent-primary" style={{ width: `${share ? Math.max(1.5, share) : 0}%` }} />
            </div>
          </div>
        );
      },
    },
    {
      id: "active_people",
      header: "Active people",
      align: "right",
      width: 150,
      sortable: true,
      cell: (row) => row.active_people.toLocaleString(),
    },
    {
      id: "documents_processed",
      header: "Documents processed",
      align: "right",
      width: 190,
      hideBelow: 900,
      sortable: true,
      cell: (row) => row.documents_processed.toLocaleString(),
    },
  ];

  return (
    <Page>
      <PageHeader
        actions={<SegmentedControl ariaLabel="Time window" onChange={setPeriod} options={WINDOWS} value={period} />}
        sub="Demand across every workspace."
        title="Usage"
        titleExtra={<PreviewTag />}
      />
      {query.error ? (
        <ErrorState onAction={query.reload} />
      ) : !usage ? (
        <>
          <div className="grid grid-cols-3 gap-3 max-[700px]:grid-cols-1" aria-hidden="true">
            {STATS.map((stat) => (
              <div className={cn(ui.card, ui.cardPadding, "grid gap-2")} key={stat.key}>
                <Skeleton className="h-3 w-2/5" />
                <Skeleton className="h-7 w-3/5" />
              </div>
            ))}
          </div>
          <SkeletonRows className="mt-3" columns={4} label="Loading usage" rows={6} />
        </>
      ) : !usage.totals.questions && !usage.workspaces.length ? (
        <EmptyState
          boxed
          description="Usage appears once people start asking questions."
          icon={<ChartColumn aria-hidden="true" />}
          title="No usage yet"
        />
      ) : (
        <>
          <div className="grid grid-cols-3 gap-3 max-[700px]:grid-cols-1">
            {STATS.map((stat) => (
              <section aria-label={stat.label} className={cn(ui.card, ui.cardPadding)} key={stat.key}>
                <h2 className="text-[0.8125rem] text-text-tertiary">{stat.label}</h2>
                <p className="mt-1 text-[1.625rem] font-semibold leading-tight tracking-[-0.02em] tabular-nums">
                  {usage.totals[stat.key].toLocaleString()}
                </p>
                <p className="mt-1 text-meta text-text-tertiary">{change(usage.totals[stat.key], usage.previous[stat.key], windowLabel)}</p>
              </section>
            ))}
          </div>
          <section className={cn(ui.card, "mt-3")}>
            <div className="flex items-center justify-between gap-3 border-b border-border-subtle px-(--card-px) py-3.5">
              <h2 className={ui.sectionTitle}>Questions per day</h2>
              <span className="text-[0.8125rem] tabular-nums text-text-tertiary">
                {usage.totals.questions.toLocaleString()} in {windowLabel}
              </span>
            </div>
            <div className={ui.cardPadding}>
              <BarsChart
                data={usage.daily.map((day) => ({ label: dayLabel.format(Date.parse(`${day.date}T00:00:00Z`)), value: day.questions }))}
                height={140}
                label={`Questions per day, last ${windowLabel}`}
              />
            </div>
          </section>
          <h2 className={cn(ui.sectionTitle, "mb-3 mt-8")}>By workspace</h2>
          <DataTable
            ariaLabel="Usage by workspace"
            columns={columns}
            data={usage.workspaces}
            emptyState={<EmptyState description="No workspace could be read for this window." size="sm" title="No workspaces to show" />}
            getRowId={(row) => row.workspace_id}
            onRowClick={(row) => router.push(`/platform/workspaces?workspace=${encodeURIComponent(row.workspace_id)}`)}
          />
        </>
      )}
    </Page>
  );
}
