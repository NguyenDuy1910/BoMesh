"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight } from "lucide-react";

import { Button } from "@/components/ui/Button";
import { ErrorState } from "@/components/ui/ErrorState";
import { PageLoadingSkeleton } from "@/components/ui/Skeleton";
import {
  changeLabel,
  Metric,
  MetricLedger,
  Panel,
  PanelRow,
  TrendChart,
} from "@/modules/workspace-control/components/dashboard";
import { SectionHeader } from "@/modules/workspace-control/components/SectionHeader";
import { workspaceDirectoryApi, type WorkspaceOverview } from "@/modules/workspace-control/directory";
import { useControlPlaneData } from "@/modules/workspace-control/queries";
import { describeAuditAction, formatDateTime, formatRelative, pluralize } from "@/modules/workspace-control/format";

/** The week the headline figures compare, against the week before it. */
const WEEK = "7 days";

export function WorkspaceOverviewPage() {
  const router = useRouter();
  const query = useControlPlaneData(() => workspaceDirectoryApi.overview());

  return (
    <>
      <SectionHeader
        actions={
          <Button
            iconAfter={<ArrowRight aria-hidden="true" size={16} />}
            onClick={() => router.push("/app")}
            variant="secondary"
          >
            Open workspace
          </Button>
        }
        section="overview"
      />
      {query.error ? (
        <ErrorState description={query.error} onAction={query.reload} />
      ) : query.data ? (
        <OverviewDashboard overview={query.data} />
      ) : (
        <PageLoadingSkeleton label="Loading workspace overview" />
      )}
    </>
  );
}

/**
 * The workspace on one screen: whether people use it, whether its knowledge
 * is ready to answer from, and the few things only an administrator can fix.
 */
function OverviewDashboard({ overview }: { overview: WorkspaceOverview }) {
  const { metrics, attention, knowledge, usage, recent_activity } = overview;
  const lastTwoWeeks = usage.buckets.slice(-14);
  const trend = (key: "active_users" | "questions") => lastTwoWeeks.map((bucket) => bucket[key]);
  // What only an administrator can fix. Indexing failures come from the same
  // counts as the Knowledge panel, so the two never disagree; `failed_items`
  // is content that never arrived, a different failure.
  const waiting = [
    { key: "requests", label: "Access requests waiting for review", href: "/workspace-control/access", value: attention.pending_approval_requests ?? 0 },
    { key: "indexing", label: "Documents that failed to index", href: "/workspace-control/knowledge", value: knowledge.failed },
    { key: "uploads", label: "Uploads whose file never arrived", href: "/workspace-control/knowledge", value: attention.failed_items ?? 0 },
  ].filter((item) => item.value > 0);

  return (
    <div className="ctl-dashboard">
      <MetricLedger label="Workspace at a glance">
        <Metric
          href="/workspace-control/access"
          label="Members"
          note={`${pluralize(metrics.active_groups ?? 0, "group")} · ${pluralize(metrics.active_roles ?? 0, "role")}`}
          value={metrics.active_users ?? 0}
        />
        <Metric
          change={changeLabel(usage.totals.active_users, usage.previous.active_users, WEEK)}
          href="/workspace-control/activity"
          label={`Active people · ${WEEK}`}
          trend={trend("active_users")}
          value={usage.totals.active_users}
        />
        <Metric
          change={changeLabel(usage.totals.questions, usage.previous.questions, WEEK)}
          href="/workspace-control/activity"
          label={`Questions asked · ${WEEK}`}
          trend={trend("questions")}
          value={usage.totals.questions}
        />
        <Metric
          href="/workspace-control/knowledge"
          label="Indexed documents"
          note={knowledge.documents
            ? `${Math.round((knowledge.indexed / knowledge.documents) * 100)}% of ${pluralize(knowledge.documents, "document")}`
            : "No documents yet"}
          value={knowledge.indexed}
        />
      </MetricLedger>

      <PanelRow>
        <Panel aside={`Last 30 days · times in ${usage.timezone}`} title="Usage">
          <TrendChart
            bucket="day"
            buckets={usage.buckets}
            label="Usage over the last 30 days"
            series={[
              { key: "questions", label: "Questions", kind: "bar", tone: "muted" },
              { key: "sign_ins", label: "Sign-ins", kind: "line", tone: "ink" },
              { key: "active_users", label: "Active people", kind: "detail", tone: "ink" },
            ]}
            timezone={usage.timezone}
          />
        </Panel>
        <KnowledgePanel knowledge={knowledge} connections={metrics.active_integration_connections ?? 0} />
      </PanelRow>

      <PanelRow layout="halves">
        <Panel title="Needs attention">
          {waiting.length ? (
            <dl className="ctl-keyfigures">
              {waiting.map((item) => (
                <div className="contents" key={item.key}>
                  <dt><Link href={item.href}>{item.label}</Link></dt>
                  <dd className="text-[var(--status-danger-text)]">{item.value.toLocaleString()}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className="ctl-muted">Nothing needs your attention. Access requests and indexing failures appear here.</p>
          )}
        </Panel>
        <Panel aside={<Link href="/workspace-control/activity">View activity</Link>} title="Recent changes">
          {recent_activity.length ? (
            <ul className="ctl-feed">
              {recent_activity.slice(0, 6).map((event) => (
                <li key={event.id}>
                  <span className="ctl-feed__mark" data-failed={event.outcome === "success" ? undefined : ""} />
                  <span className="min-w-0">
                    <span className="ctl-feed__what">{describeAuditAction(event.action)}</span>
                    <span className="ctl-feed__who">{event.actor.display_name ?? event.actor.email ?? "System"}</span>
                  </span>
                  <span className="ctl-feed__when" title={formatDateTime(event.created_at)}>{formatRelative(event.created_at)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="ctl-muted">No changes recorded yet, or you cannot read the audit log.</p>
          )}
        </Panel>
      </PanelRow>
    </div>
  );
}

function KnowledgePanel({
  knowledge,
  connections,
}: {
  knowledge: WorkspaceOverview["knowledge"];
  connections: number;
}) {
  const parts = [
    { key: "indexed", label: "Indexed", value: knowledge.indexed, tone: "ink" },
    { key: "indexing", label: "Indexing", value: knowledge.indexing, tone: "muted" },
    { key: "failed", label: "Failed", value: knowledge.failed, tone: "danger" },
  ] as const;
  const counted = parts.reduce((sum, part) => sum + part.value, 0);
  return (
    <Panel aside={<Link href="/workspace-control/knowledge">Open knowledge</Link>} title="Knowledge">
      <div>
        <div
          aria-label={parts.map((part) => `${part.value} ${part.label.toLowerCase()}`).join(", ")}
          className="ctl-split"
          role="img"
        >
          {counted > 0 && parts.map((part) => part.value > 0 && (
            <i data-tone={part.tone} key={part.key} style={{ width: `${(part.value / counted) * 100}%` }} />
          ))}
        </div>
      </div>
      <dl className="ctl-keyfigures">
        {parts.map((part) => (
          <div className="contents" key={part.key}>
            <dt><i className="ctl-swatch" data-tone={part.tone} />{part.label}</dt>
            <dd className={part.key === "failed" && part.value ? "text-[var(--status-danger-text)]" : undefined}>
              {part.value.toLocaleString()}
            </dd>
          </div>
        ))}
        <div className="contents">
          <dt>Collections</dt>
          <dd>{knowledge.collections.toLocaleString()}</dd>
        </div>
        <div className="contents">
          <dt>Connected accounts</dt>
          <dd>{connections.toLocaleString()}</dd>
        </div>
      </dl>
    </Panel>
  );
}
