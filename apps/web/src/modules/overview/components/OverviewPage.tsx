"use client";

import { ArrowDown, ArrowUp, ClipboardList, Files, MessageSquare, RefreshCw, UserPlus, Users } from "lucide-react";

import { ErrorState, Page, PageHeader, Section, SkeletonCards, SkeletonRows, Sparkline, StatCard } from "@/components/ui";
import { fmtNum, pct, plural } from "@/lib/format";
import { useMessages } from "@/lib/i18n";
import { useWorkspace } from "@/lib/workspace";
import { LinkButton } from "@/modules/curation/components/parts";

import type { WorkspaceOverview } from "../api";
import { useOverview, useSearchable, useServiceKpi, useSources } from "../queries";
import { AttentionList, useAttention } from "./Attention";
import { Health, healthDue, useHealthMetrics } from "./Health";
import { KnowledgeGaps } from "./KnowledgeGaps";
import { SetupGuide, isFreshWorkspace, setupNext, useSetupSteps } from "./Setup";

const kpi = (o: WorkspaceOverview | undefined, key: string) => o?.kpis?.find((k) => k.key === key);

/**
 * Overview (preview `P.overview`): what needs me first (operations), then Knowledge health (Studio → Documents' views),
 * knowledge gaps and how the week went. A workspace with nothing set up gets the setup checklist as the whole page.
 */
export function OverviewPage() {
  const m = useMessages();
  const { can } = useWorkspace();
  const week = useOverview("P7D");
  const steps = useSetupSteps(week.data);
  const fresh = isFreshWorkspace(steps);
  const items = useAttention(week.data, setupNext(steps));
  const health = useHealthMetrics();
  const n = items ? items.length + healthDue(health) : null;
  const meta = fresh || n === null ? undefined : n ? (n === 1 ? "1 việc cần bạn xử lý" : `${fmtNum(n)} việc cần bạn xử lý`) : "Hiện không có việc nào cần bạn";

  let body;
  if (week.isError) {
    body = <ErrorState error={week.error} title="Không tải được tổng quan" onRetry={() => void week.refetch()} />;
  } else if (fresh && steps) {
    body = (
      <>
        <SetupGuide steps={steps} />
        {can("members.create") ? (
          <div className="mt-16">
            <LinkButton href="/people?tab=members&add=1" variant="secondary" size="md" icon={UserPlus}>
              Thêm người
            </LinkButton>
          </div>
        ) : null}
      </>
    );
  } else if (!week.data || !items) {
    body = (
      <>
        <SkeletonRows rows={3} />
        <div className="mt-32">
          <SkeletonCards cards={3} />
        </div>
      </>
    );
  } else {
    body = (
      <>
        <Section title="Cần chú ý">
          <AttentionList items={items} />
        </Section>
        {health ? (
          <Section title="Tình trạng tài liệu">
            <Health metrics={health} />
          </Section>
        ) : null}
        <KnowledgeGaps />
        <Section title="Tuần này">
          <Kpis overview={week.data} />
        </Section>
      </>
    );
  }

  return (
    <Page>
      <PageHeader title={m.nav.overview} meta={meta} />
      {body}
    </Page>
  );
}

/** Change against last week; nothing when last week had none to compare with (a "↑0%" there would be wrong). */
function Delta({ now, prev }: { now: number; prev: number | undefined }) {
  if (!prev) return null;
  const d = Math.round(((now - prev) / prev) * 100);
  const Icon = d < 0 ? ArrowDown : ArrowUp;
  return (
    <>
      <span className={d < 0 ? "ov-delta ov-delta--down" : "ov-delta"}>
        <Icon className="i i-xs" aria-hidden />
        {Math.abs(d)}%
      </span>{" "}
      so với tuần trước
    </>
  );
}

/** This week (preview `kpis()`): every card opens where its number comes from; Questions carries its own 14-day trend. */
function Kpis({ overview }: { overview: WorkspaceOverview }) {
  const { hasModule } = useWorkspace();
  const month = useOverview("P30D");
  const searchable = useSearchable();
  const sources = useSources();
  const service = useServiceKpi();
  const questions = kpi(overview, "questions");
  const active = kpi(overview, "activeMembers");
  const trend = (month.data?.dailyUsage ?? []).slice(-14).map((d) => Number(d.questionCount ?? 0));
  const published = searchable.data?.published ?? 0;
  const ready = searchable.data?.ready ?? 0;

  let last;
  if (hasModule("requests")) {
    const { done = 0, onTime = 0, open = 0 } = service.data ?? {};
    const p = pct(onTime, done);
    last = (
      <StatCard
        icon={ClipboardList}
        label="Yêu cầu đúng hạn"
        value={done ? `${p}%` : "—"}
        meta={done ? `${fmtNum(onTime)}/${fmtNum(done)} xử lý đúng hạn · ${fmtNum(open)} đang mở` : `Chưa xử lý yêu cầu nào · ${fmtNum(open)} đang mở`}
        tone={!done ? undefined : p >= 90 ? "success" : "warning"}
        href="/requests?tab=queue"
      />
    );
  } else {
    const all = sources.data?.length ?? 0;
    const bad = (sources.data ?? []).filter((s) => s.state === "FAILED" || s.state === "REAUTHORIZATION_REQUIRED" || s.lastSync?.state === "FAILED").length;
    last = (
      <StatCard
        icon={RefreshCw}
        label="Nguồn dữ liệu hoạt động tốt"
        value={
          <>
            {all - bad}
            <span className="ov-of">/{all}</span>
          </>
        }
        meta={bad ? `${plural(bad, "source")} cần chú ý` : "Tất cả đang đồng bộ"}
        tone={bad ? "danger" : "success"}
        href={sources.data ? "/studio?tab=sources" : undefined}
      />
    );
  }

  return (
    <div className="grid cols-4">
      <StatCard icon={MessageSquare} label="Câu hỏi tuần này" value={fmtNum(questions?.value ?? 0)} meta={<Delta now={questions?.value ?? 0} prev={questions?.previousValue} />} tone="accent">
        {trend.length ? (
          <div className="ov-spark" aria-hidden>
            <Sparkline values={trend} height={28} />
          </div>
        ) : null}
      </StatCard>
      <StatCard icon={Users} label="Thành viên hoạt động" value={fmtNum(active?.value ?? 0)} meta={<Delta now={active?.value ?? 0} prev={active?.previousValue} />} href="/people" />
      <StatCard
        icon={Files}
        label="Tài liệu tra cứu được"
        value={`${pct(ready, published)}%`}
        meta={`${fmtNum(ready)}/${fmtNum(published)} tài liệu đã công bố`}
        tone={ready < published ? "warning" : "success"}
        href="/studio?tab=documents&view=all"
      />
      {last}
    </div>
  );
}
