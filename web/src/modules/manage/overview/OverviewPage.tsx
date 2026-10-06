"use client";

import { CircleAlert, CircleCheck, FileText, Plug, Upload, UserPlus } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import { Page } from "@/components/shell/Page";
import { RequirePermission } from "@/components/shell/RequirePermission";
import { useCurrentWorkspace } from "@/components/shell/useCurrentWorkspace";
import { BarsChart } from "@/components/ui/BarsChart";
import { ButtonLink } from "@/components/ui/Button";
import { ui } from "@/components/ui/design-system";
import { ErrorState } from "@/components/ui/ErrorState";
import { Meter } from "@/components/ui/Meter";
import { PageHeader } from "@/components/ui/PageHeader";
import { SkeletonCards, SkeletonRows } from "@/components/ui/Skeleton";
import { isPendingFeatureEnabled, usePendingFeature } from "@/lib/api/pending";
import { hasSessionPermission, type AuthSession } from "@/lib/auth/session";
import { cn } from "@/lib/cn";
import { workspaceDirectoryApi, type WorkspaceOverview } from "@/modules/manage/access/directory";
import { ActorAvatar } from "@/modules/manage/activity/Actor";
import { auditActorName, auditTargetName, describeAuditAction } from "@/modules/manage/activity/audit-actions";
import { getAssistantSettings } from "@/modules/manage/assistant/api";
import { documentAttention, loadAttention, type AttentionIcon, type AttentionItem, type AttentionTone } from "@/modules/manage/overview/attention";
import { KnowledgeGaps } from "@/modules/manage/overview/KnowledgeGaps";
import { SetupChecklist, type SetupStep } from "@/modules/manage/overview/SetupChecklist";
import { knowledgeApi } from "@/modules/knowledge/knowledge-api";
import { formatDateTime, formatRelative, pluralize } from "@/lib/format";
import { useApiData } from "@/lib/hooks/useApiData";

export function OverviewPage() {
  return (
    <RequirePermission anyOf={["tenant.read"]}>
      <Overview />
    </RequirePermission>
  );
}

function greeting(hour: number) {
  if (hour < 12) return "Good morning";
  return hour < 18 ? "Good afternoon" : "Good evening";
}

function Overview() {
  const { workspace, viewer, session } = useCurrentWorkspace();
  const workspaceId = workspace?.id ?? "";
  const overview = useApiData(
    async () => (workspaceId ? workspaceDirectoryApi.overview(workspaceId) : null),
    workspaceId,
  );
  const firstName = (viewer?.name ?? "").split(/[\s@]/)[0];

  return (
    <Page className="max-w-[1080px]">
      <PageHeader sub={workspace?.name} title={firstName ? `${greeting(new Date().getHours())}, ${firstName}` : greeting(new Date().getHours())} />
      {overview.error ? (
        <ErrorState description={overview.error} onAction={overview.reload} title="The overview didn’t load" />
      ) : !overview.data || !session || !workspace ? (
        <div aria-busy="true">
          <SectionHead title="Needs attention" />
          <SkeletonRows columns={2} label="Loading what needs attention" rows={2} />
          <div className="mt-7"><SectionHead title="This week" /></div>
          <SkeletonCards count={3} label="Loading this week’s numbers" />
        </div>
      ) : (
        <OverviewBody overview={overview.data} session={session} workspace={workspace} />
      )}
    </Page>
  );
}

function OverviewBody({
  overview,
  session,
  workspace,
}: {
  overview: WorkspaceOverview;
  session: AuthSession;
  workspace: { id: string; name: string };
}) {
  const can = (permission: string) => hasSessionPermission(session, permission);
  const gapsEnabled = usePendingFeature("analytics.knowledge_gaps");
  const assistantEnabled = usePendingFeature("workspace.assistant_settings");
  const live = useApiData(() => loadAttention(session), workspace.id);
  // Personal "My files" collections are collections too; the first step asks for a shared one.
  const home = useApiData(() => knowledgeApi.home(), workspace.id);
  const assistant = useApiData(
    async () => (assistantEnabled && can("tenant.manage") ? getAssistantSettings(workspace.id) : null),
    workspace.id,
  );

  const sharedCollections = home.data
    ? home.data.collections.filter((collection) => collection.id !== home.data?.personal_collection_id).length
    : overview.knowledge.collections;
  const firstCollection = home.data?.collections.find((collection) => collection.id !== home.data?.personal_collection_id);
  const steps = setupSteps({
    can,
    overview,
    sharedCollections,
    firstCollectionId: firstCollection?.id ?? null,
    assistantCustomized: assistant.data ? assistant.data.updated_at !== null : null,
  });
  const setupOpen = steps.some((step) => !step.done && !step.preview);
  const brandNew = overview.knowledge.documents === 0;
  const attention = [...(live.data ?? []), ...documentAttention(session, overview)];

  if (brandNew) {
    return (
      <>
        <SetupChecklist primary steps={steps} workspaceName={workspace.name} />
        {attention.length > 0 && <NeedsAttention items={attention} primary={false} />}
      </>
    );
  }

  return (
    <>
      {setupOpen && <SetupChecklist primary steps={steps} workspaceName={workspace.name} />}
      <section aria-labelledby="overview-attention">
        <SectionHead id="overview-attention" title="Needs attention" />
        {live.error ? (
          <ErrorState description={live.error} layout="inline" onAction={live.reload} title="Some checks didn’t load" />
        ) : !live.data ? (
          <SkeletonRows columns={2} label="Loading what needs attention" rows={2} />
        ) : (
          <AttentionList items={attention} primary={!setupOpen} />
        )}
      </section>
      {gapsEnabled && can("tenant.manage") && <KnowledgeGaps workspaceId={workspace.id} />}
      <ThisWeek overview={overview} />
      <KnowledgeHealth collections={sharedCollections} overview={overview} />
      {can("audit.read") && <RecentActivity overview={overview} />}
    </>
  );
}

function setupSteps({
  can,
  overview,
  sharedCollections,
  firstCollectionId,
  assistantCustomized,
}: {
  can: (permission: string) => boolean;
  overview: WorkspaceOverview;
  sharedCollections: number;
  firstCollectionId: string | null;
  /** Null when the caller cannot read or change the assistant. */
  assistantCustomized: boolean | null;
}): SetupStep[] {
  const steps: SetupStep[] = [
    {
      id: "knowledge-base",
      title: "Create a knowledge base",
      description: "A home for one team’s or topic’s documents.",
      done: sharedCollections > 0,
      action: can("knowledge.manage") ? { label: "Create knowledge base", href: "/knowledge?action=create" } : null,
      view: "/knowledge",
    },
    {
      id: "content",
      title: "Add documents or connect a source",
      description: "Upload files, or keep Google Drive and Confluence in sync.",
      done: overview.knowledge.documents > 0,
      action: can("source.manage")
        ? { label: "Add content", href: "/manage/sources?connect=1" }
        : firstCollectionId
          ? { label: "Add content", href: `/knowledge/${encodeURIComponent(firstCollectionId)}?action=upload` }
          : null,
      view: "/knowledge",
    },
    {
      id: "team",
      title: "Add your team",
      description: "People need a BoMesh account before you add them.",
      done: (overview.metrics.active_users ?? 0) > 1,
      action: can("user.manage") ? { label: "Add members", href: "/manage/access?tab=members&action=add" } : null,
      view: can("user.manage") ? "/manage/access?tab=members" : undefined,
    },
  ];
  if (assistantCustomized !== null && isPendingFeatureEnabled("workspace.assistant_settings")) {
    steps.push({
      id: "assistant",
      title: "Customize the assistant",
      description: "Set its instructions and the starters people see first.",
      done: assistantCustomized,
      action: { label: "Customize", href: "/manage/assistant" },
      view: "/manage/assistant",
      preview: true,
    });
  }
  return steps;
}

function SectionHead({ id, title, action }: { id?: string; title: string; action?: ReactNode }) {
  return (
    <div className="mb-3 flex items-center justify-between gap-3">
      <h2 className={ui.sectionTitle} id={id}>{title}</h2>
      {action}
    </div>
  );
}

const TONE_TILE: Record<AttentionTone | "ok", string> = {
  err: "bg-status-danger-bg text-status-danger",
  warn: "bg-status-warning-bg text-status-warning",
  info: "bg-status-info-bg text-status-info",
  ok: "bg-status-success-bg text-status-success",
};

const ICON: Record<AttentionIcon, ReactNode> = {
  plug: <Plug />,
  alert: <CircleAlert />,
  people: <UserPlus />,
  document: <FileText />,
  upload: <Upload />,
};

function ToneTile({ tone, children }: { tone: AttentionTone | "ok"; children: ReactNode }) {
  return (
    <span aria-hidden="true" className={cn("grid size-8 shrink-0 place-items-center rounded-md [&_svg]:size-4", TONE_TILE[tone])}>
      {children}
    </span>
  );
}

function NeedsAttention({ items, primary }: { items: readonly AttentionItem[]; primary: boolean }) {
  return (
    <section aria-labelledby="overview-attention">
      <SectionHead id="overview-attention" title="Needs attention" />
      <AttentionList items={items} primary={primary} />
    </section>
  );
}

function AttentionList({ items, primary }: { items: readonly AttentionItem[]; primary: boolean }) {
  if (!items.length) {
    return (
      <div className={cn(ui.card, "flex items-center gap-3 px-4 py-3.5")}>
        <ToneTile tone="ok"><CircleCheck /></ToneTile>
        <div className="min-w-0">
          <p className="text-body font-medium text-text-primary">Everything is running smoothly</p>
          <p className="text-meta text-text-tertiary">Sources are syncing and no one is waiting on you.</p>
        </div>
      </div>
    );
  }
  return (
    <ul className={cn(ui.card, "divide-y divide-border-subtle overflow-hidden")}>
      {items.map((item, index) => (
        <li className="flex items-center gap-3 px-4 py-3.5" key={item.id}>
          <ToneTile tone={item.tone}>{ICON[item.icon]}</ToneTile>
          <div className="min-w-0 flex-1">
            <p className="truncate text-body font-medium text-text-primary">{item.title}</p>
            <p className="truncate text-meta text-text-tertiary">{item.detail}</p>
          </div>
          <ButtonLink href={item.action.href} size="sm" variant={primary && index === 0 ? "primary" : "secondary"}>
            {item.action.label}
          </ButtonLink>
        </li>
      ))}
    </ul>
  );
}

function Delta({ current, previous }: { current: number; previous: number }) {
  if (!previous) return <>{current ? "None the week before" : "No change from last week"}</>;
  const change = Math.round(((current - previous) / previous) * 100);
  return (
    <>
      <span className={cn("font-medium", change >= 0 ? "text-status-success" : "text-text-secondary")}>
        {change >= 0 ? "+" : "−"}{Math.abs(change)}%
      </span>{" "}
      vs last week
    </>
  );
}

function StatCard({ label, value, foot }: { label: string; value: number; foot: ReactNode }) {
  return (
    <div className={cn(ui.card, "px-4.5 py-3.5")}>
      <p className="text-meta text-text-secondary">{label}</p>
      <p className="mt-1 text-title font-semibold tabular-nums tracking-tight text-text-primary">{value.toLocaleString()}</p>
      <p className="mt-0.5 text-caption text-text-tertiary">{foot}</p>
    </div>
  );
}

const dayLabel = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

function ThisWeek({ overview }: { overview: WorkspaceOverview }) {
  const { usage, knowledge } = overview;
  const buckets = usage.buckets;
  const totalQuestions = buckets.reduce((sum, bucket) => sum + bucket.questions, 0);
  const searchable = knowledge.documents ? Math.round((knowledge.ready / knowledge.documents) * 100) : 0;
  return (
    <section aria-labelledby="overview-week" className="mt-7">
      <SectionHead id="overview-week" title="This week" />
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-3 max-[1100px]:grid-cols-1">
        <div className="grid grid-cols-1 gap-3 max-[1100px]:grid-cols-3 max-[640px]:grid-cols-1">
          <StatCard
            foot={<Delta current={usage.totals.questions} previous={usage.previous.questions} />}
            label="Questions asked"
            value={usage.totals.questions}
          />
          <StatCard
            foot={<Delta current={usage.totals.active_users} previous={usage.previous.active_users} />}
            label="Active people"
            value={usage.totals.active_users}
          />
          <StatCard
            foot={`of ${knowledge.documents.toLocaleString()} · ${searchable}% searchable`}
            label="Documents ready"
            value={knowledge.ready}
          />
        </div>
        <div className={cn(ui.card, "flex flex-col px-4.5 pt-4 pb-3")}>
          <p className="text-meta text-text-secondary">Questions, last 30 days</p>
          <p className="mt-1 text-title font-semibold tabular-nums tracking-tight text-text-primary">{totalQuestions.toLocaleString()}</p>
          <BarsChart
            className="mt-auto pt-4"
            data={buckets.map((bucket, index) => ({
              label: index === buckets.length - 1 ? "Today" : dayLabel.format(new Date(bucket.start)),
              value: bucket.questions,
            }))}
            height={150}
            label="Questions per day, last 30 days"
          />
        </div>
      </div>
    </section>
  );
}

function KnowledgeHealth({ overview, collections }: { overview: WorkspaceOverview; collections: number }) {
  const { knowledge } = overview;
  const total = knowledge.ready + knowledge.processing + knowledge.pending + knowledge.outdated + knowledge.failed;
  const share = total ? Math.round((knowledge.ready / total) * 100) : 0;
  return (
    <section aria-labelledby="overview-health" className="mt-7">
      <SectionHead
        action={<ButtonLink href="/knowledge" size="sm" variant="link">View knowledge</ButtonLink>}
        id="overview-health"
        title="Knowledge health"
      />
      <div className={cn(ui.card, "px-4.5 py-4")}>
        <p className="mb-3 flex flex-wrap items-baseline gap-2.5">
          <span className="text-title font-semibold tabular-nums tracking-tight text-text-primary">{share}%</span>
          <span className="text-body text-text-secondary">
            of {pluralize(knowledge.documents, "document")} in {pluralize(collections, "knowledge base")} are ready to answer questions
          </span>
        </p>
        <Meter
          formatValue={(value) => value.toLocaleString()}
          label="Documents by state"
          segments={[
            { label: "Ready", value: knowledge.ready, tone: "ok" },
            { label: "Processing", value: knowledge.processing, tone: "info" },
            { label: "Waiting", value: knowledge.pending, tone: "neutral" },
            { label: "Needs update", value: knowledge.outdated, tone: "warn" },
            { label: "Failed", value: knowledge.failed, tone: "err" },
          ]}
        />
      </div>
    </section>
  );
}

function RecentActivity({ overview }: { overview: WorkspaceOverview }) {
  const events = overview.recent_activity.slice(0, 5);
  return (
    <section aria-labelledby="overview-activity" className="mt-7">
      <SectionHead
        action={<ButtonLink href="/manage/activity" size="sm" variant="link">View all activity</ButtonLink>}
        id="overview-activity"
        title="Recent activity"
      />
      {!events.length ? (
        <p className={cn(ui.card, "px-4 py-3.5 text-body text-text-tertiary")}>
          Changes to knowledge, sources, people and settings will appear here.
        </p>
      ) : (
        <ul className={cn(ui.card, "divide-y divide-border-subtle overflow-hidden")}>
          {events.map((event) => {
            const target = auditTargetName(event);
            const sentence = describeAuditAction(event.action, event.details);
            return (
              <li key={event.id}>
                <Link
                  className={cn("flex items-center gap-3 px-4 py-2.5 hover:bg-surface-hover", ui.focus)}
                  href={`/manage/activity?event=${encodeURIComponent(event.id)}`}
                >
                  <ActorAvatar actor={event.actor} size="md" />
                  <span className="min-w-0 flex-1 truncate text-body text-text-primary">
                    <strong className="font-medium">{auditActorName(event.actor)}</strong>{" "}
                    {sentence.charAt(0).toLowerCase() + sentence.slice(1)}
                    {target && <span className="text-text-secondary"> · {target}</span>}
                  </span>
                  <time
                    className="whitespace-nowrap text-meta tabular-nums text-text-tertiary"
                    dateTime={event.created_at ?? undefined}
                    title={formatDateTime(event.created_at)}
                  >
                    {formatRelative(event.created_at)}
                  </time>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
