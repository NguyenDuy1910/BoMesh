"use client";

import { ArrowDown, ArrowUp, ClipboardList, Files, House, MessageSquare, Plus, RefreshCw, UserPlus, Users } from "lucide-react";
import { useRef } from "react";

import { BarsChart, EmptyState, ErrorState, Page, PageHeader, Section, SkeletonCards, SkeletonRows, StatCard } from "@/components/ui";
import { PageChrome } from "@/components/shell/page-chrome";
import { fmtDate, fmtNum, pct, plural } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";
import { LinkButton, PanelCard } from "@/modules/curation/components/parts";
import { useCuratedItems } from "@/modules/curation/queries";

import type { WorkspaceOverview } from "../api";
import { useOverview, useServiceRequests, useSources } from "../queries";
import { Attention } from "./Attention";
import { KnowledgeGaps } from "./KnowledgeGaps";

const kpi = (o: WorkspaceOverview | undefined, key: string) => o?.kpis?.find((k) => k.key === key);

/** Overview (preview `P.overview`): what needs me first, then how the week went and where knowledge falls short. */
export function OverviewPage() {
  const { workspace, can } = useWorkspace();
  const week = useOverview("P7D");
  const month = useOverview("P30D");
  const usageRef = useRef<HTMLDivElement>(null);

  const flashUsage = () => {
    const el = usageRef.current?.querySelector<HTMLElement>(".ov-usage");
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.remove("ov-flash");
    void el.offsetWidth;
    el.classList.add("ov-flash");
  };

  let body;
  if (week.isPending) {
    body = (
      <>
        <SkeletonRows rows={3} />
        <div className="mt-32">
          <SkeletonCards cards={3} />
        </div>
      </>
    );
  } else if (week.isError) {
    body = <ErrorState error={week.error} title="The overview didn’t load" onRetry={() => void week.refetch()} />;
  } else if (!kpi(week.data, "rootCollections")?.value) {
    body = (
      <EmptyState
        icon={House}
        boxed
        title="Your workspace is ready"
        description="Add knowledge and people. Activity and health show up here."
        actions={
          <>
            {can("items.create") ? (
              <LinkButton href="/knowledge/bases?new=1" variant="primary" size="md" icon={Plus}>
                Create knowledge base
              </LinkButton>
            ) : null}
            {can("members.create") ? (
              <LinkButton href="/people?add=1" variant="secondary" size="md" icon={UserPlus}>
                Add people
              </LinkButton>
            ) : null}
          </>
        }
      />
    );
  } else {
    body = (
      <>
        <Section title="Needs attention">
          <Attention overview={week.data} />
        </Section>
        <Section title="This week">
          <Kpis overview={week.data} onQuestions={flashUsage} />
        </Section>
        <div className="ov-split mt-16" ref={usageRef}>
          <UsageCard overview={month.data} isPending={month.isPending} />
          <KnowledgeGaps />
        </div>
      </>
    );
  }

  return (
    <Page>
      <PageChrome crumbs={[{ label: "Overview" }]} />
      <PageHeader title="Overview" description={<span translate="no">{workspace.displayName}</span>} />
      {body}
    </Page>
  );
}

function Delta({ now, prev }: { now: number; prev: number | undefined }) {
  const d = prev ? Math.round(((now - prev) / prev) * 100) : 0;
  const Icon = d < 0 ? ArrowDown : ArrowUp;
  return (
    <>
      <span className={`ov-delta${d < 0 ? " ov-delta--down" : ""}`}>
        <Icon className="i i-xs" aria-hidden />
        {Math.abs(d)}%
      </span>{" "}
      vs last week
    </>
  );
}

function Kpis({ overview, onQuestions }: { overview: WorkspaceOverview; onQuestions: () => void }) {
  const { hasModule, can } = useWorkspace();
  const items = useCuratedItems();
  const sources = useSources();
  const service = useServiceRequests();
  const questions = kpi(overview, "questions");
  const active = kpi(overview, "activeMembers");

  // Published documents in shared bases and how many of them are searchable.
  const published = (items.data ?? []).filter((d) => d.document?.publicationState === "PUBLISHED");
  const ready = published.filter((d) => d.document?.indexingState === "SUCCEEDED").length;

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
    const bad = (sources.data ?? []).filter((s) => s.state === "FAILED" || s.state === "REAUTHORIZATION_REQUIRED").length;
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
        href={can("sources.list") ? "/sources" : undefined}
      />
    );
  }

  return (
    <div className="grid cols-4">
      <StatCard icon={MessageSquare} label="Questions this week" value={fmtNum(questions?.value ?? 0)} meta={<Delta now={questions?.value ?? 0} prev={questions?.previousValue} />} tone="accent" onPress={onQuestions} />
      <StatCard icon={Users} label="Active people" value={fmtNum(active?.value ?? 0)} meta={<Delta now={active?.value ?? 0} prev={active?.previousValue} />} href="/people" />
      <StatCard
        icon={Files}
        label="Documents searchable"
        value={`${pct(ready, published.length)}%`}
        meta={`${fmtNum(ready)} of ${fmtNum(published.length)} published documents`}
        tone={ready < published.length ? "warning" : "success"}
        href="/documents?tab=all"
      />
      {last}
    </div>
  );
}

function UsageCard({ overview, isPending }: { overview: WorkspaceOverview | undefined; isPending: boolean }) {
  const days = overview?.dailyUsage ?? [];
  const values = days.map((d) => Number(d.questionCount ?? 0));
  const total = values.reduce((a, b) => a + b, 0);
  return (
    <PanelCard title="Questions, last 30 days" className="ov-usage">
      {isPending ? (
        <SkeletonRows rows={3} />
      ) : (
        <>
          <div className="stat__value">{fmtNum(total)}</div>
          <BarsChart values={values} height={140} labels={days.map((d) => fmtDate(d.date))} label="Questions per day" />
          <div className="row between t-xs muted">
            <span>{days[0] ? fmtDate(days[0].date) : ""}</span>
            <span>Today</span>
          </div>
        </>
      )}
    </PanelCard>
  );
}
