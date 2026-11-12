"use client";

import { ArrowDown, ArrowUp, ClipboardList, Files, MessageSquare, RefreshCw, UserPlus, Users } from "lucide-react";

import { ErrorState, Page, PageHeader, Section, SkeletonCards, SkeletonRows, Sparkline, StatCard } from "@/components/ui";
import { fmtNum, pct, plural } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";
import { LinkButton } from "@/modules/curation/components/parts";

import type { WorkspaceOverview } from "../api";
import { useOverview, useSearchable, useServiceRequests, useSources } from "../queries";
import { AttentionList, useAttention } from "./Attention";
import { Health, healthDue, useHealthMetrics } from "./Health";
import { KnowledgeGaps } from "./KnowledgeGaps";
import { SetupGuide, isFreshWorkspace, setupNext, useSetupSteps } from "./Setup";

const kpi = (o: WorkspaceOverview | undefined, key: string) => o?.kpis?.find((k) => k.key === key);

/**
 * Overview (preview `P.overview`): what needs me first (operations), then Knowledge health (the Review queues),
 * knowledge gaps and how the week went. A workspace with nothing set up gets the setup checklist as the whole page.
 */
export function OverviewPage() {
  const { can } = useWorkspace();
  const week = useOverview("P7D");
  const steps = useSetupSteps(week.data);
  const fresh = isFreshWorkspace(steps);
  const items = useAttention(week.data, setupNext(steps));
  const health = useHealthMetrics();
  const n = items ? items.length + healthDue(health) : null;
  const meta = fresh || n === null ? undefined : n ? (n === 1 ? "1 thing needs you" : `${fmtNum(n)} things need you`) : "Nothing needs you right now";

  let body;
  if (week.isError) {
    body = <ErrorState error={week.error} title="The overview didn’t load" onRetry={() => void week.refetch()} />;
  } else if (fresh && steps) {
    body = (
      <>
        <SetupGuide steps={steps} />
        {can("members.create") ? (
          <div className="mt-16">
            <LinkButton href="/people?tab=members&add=1" variant="secondary" size="md" icon={UserPlus}>
              Add people
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
        <Section title="Needs attention">
          <AttentionList items={items} />
        </Section>
        {health ? (
          <Section title="Knowledge health">
            <Health metrics={health} />
          </Section>
        ) : null}
        <KnowledgeGaps />
        <Section title="This week">
          <Kpis overview={week.data} />
        </Section>
      </>
    );
  }

  return (
    <Page>
      <PageHeader title="Overview" meta={meta} />
      {body}
    </Page>
  );
}

function Delta({ now, prev }: { now: number; prev: number | undefined }) {
  const d = prev ? Math.round(((now - prev) / prev) * 100) : 0;
  const Icon = d < 0 ? ArrowDown : ArrowUp;
  return (
    <>
      <span className={d < 0 ? "ov-delta ov-delta--down" : "ov-delta"}>
        <Icon className="i i-xs" aria-hidden />
        {Math.abs(d)}%
      </span>{" "}
      vs last week
    </>
  );
}

/** This week (preview `kpis()`): every card opens where its number comes from; Questions carries its own 14-day trend. */
function Kpis({ overview }: { overview: WorkspaceOverview }) {
  const { hasModule } = useWorkspace();
  const month = useOverview("P30D");
  const searchable = useSearchable();
  const sources = useSources();
  const service = useServiceRequests();
  const questions = kpi(overview, "questions");
  const active = kpi(overview, "activeMembers");
  const trend = (month.data?.dailyUsage ?? []).slice(-14).map((d) => Number(d.questionCount ?? 0));
  const published = searchable.data?.published ?? 0;
  const ready = searchable.data?.ready ?? 0;

  let last;
  if (hasModule("requests")) {
    const all = service.data ?? [];
    const done = all.filter((r) => r.closeTime && ["APPROVED", "DENIED", "ANSWERED", "CLOSED"].includes(r.state ?? ""));
    const onTime = done.filter((r) => !r.dueTime || Date.parse(r.closeTime!) <= Date.parse(r.dueTime)).length;
    const open = all.filter((r) => r.state === "OPEN" || r.state === "NEEDS_INFO").length;
    const p = pct(onTime, done.length);
    last = (
      <StatCard
        icon={ClipboardList}
        label="Requests on time"
        value={done.length ? `${p}%` : "—"}
        meta={done.length ? `${fmtNum(onTime)} of ${fmtNum(done.length)} resolved within SLA · ${fmtNum(open)} open` : `No requests resolved yet · ${fmtNum(open)} open`}
        tone={!done.length ? undefined : p >= 90 ? "success" : "warning"}
        href="/requests?tab=queue"
      />
    );
  } else {
    const all = sources.data?.length ?? 0;
    const bad = (sources.data ?? []).filter((s) => s.state === "FAILED" || s.state === "REAUTHORIZATION_REQUIRED" || s.lastSync?.state === "FAILED").length;
    last = (
      <StatCard
        icon={RefreshCw}
        label="Sources healthy"
        value={
          <>
            {all - bad}
            <span className="ov-of">/{all}</span>
          </>
        }
        meta={bad ? `${plural(bad, "source")} need${bad === 1 ? "s" : ""} attention` : "All syncing"}
        tone={bad ? "danger" : "success"}
        href={sources.data ? "/studio?tab=sources" : undefined}
      />
    );
  }

  return (
    <div className="grid cols-4">
      <StatCard icon={MessageSquare} label="Questions this week" value={fmtNum(questions?.value ?? 0)} meta={<Delta now={questions?.value ?? 0} prev={questions?.previousValue} />} tone="accent">
        {trend.length ? (
          <div className="ov-spark" aria-hidden>
            <Sparkline values={trend} height={28} />
          </div>
        ) : null}
      </StatCard>
      <StatCard icon={Users} label="Active people" value={fmtNum(active?.value ?? 0)} meta={<Delta now={active?.value ?? 0} prev={active?.previousValue} />} href="/people" />
      <StatCard
        icon={Files}
        label="Documents searchable"
        value={`${pct(ready, published)}%`}
        meta={`${fmtNum(ready)} of ${fmtNum(published)} published documents`}
        tone={ready < published ? "warning" : "success"}
        href="/studio?tab=documents"
      />
      {last}
    </div>
  );
}
