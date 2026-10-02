"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight } from "lucide-react";

import { Button } from "@/components/ui/Button";
import { ErrorState } from "@/components/ui/ErrorState";
import { PageLoadingSkeleton } from "@/components/ui/Skeleton";
import { StatGrid, StatTile } from "@/components/ui/StatTile";
import { SectionHeader } from "@/modules/workspace-control/components/SectionHeader";
import { workspaceDirectoryApi, type WorkspaceOverview } from "@/modules/workspace-control/directory";
import { useControlPlaneData } from "@/modules/workspace-control/queries";
import { describeAuditAction, formatRelative } from "@/modules/workspace-control/format";

/* `items` counts every collection and document in the workspace — the backend
   keeps both in one table and does not split the count — so it is labelled as
   both rather than as documents. */
const METRICS: { key: string; label: string }[] = [
  { key: "active_users", label: "Members" },
  { key: "active_groups", label: "Groups" },
  { key: "active_roles", label: "Roles" },
  { key: "items", label: "Collections and documents" },
  { key: "active_integration_connections", label: "Connected accounts" },
];

const ATTENTION: { key: string; label: string; href: string }[] = [
  { key: "pending_approval_requests", label: "Pending access requests", href: "/workspace-control/access" },
  { key: "failed_items", label: "Failed documents", href: "/workspace-control/knowledge" },
];

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
        <OverviewContent overview={query.data} />
      ) : (
        <PageLoadingSkeleton label="Loading workspace overview" />
      )}
    </>
  );
}

function OverviewContent({ overview }: { overview: WorkspaceOverview }) {
  const { metrics, attention, recent_activity } = overview;
  return (
    <>
      <StatGrid>
        {METRICS.map((metric) => (
          <StatTile key={metric.key} label={metric.label} value={metrics[metric.key] ?? 0} />
        ))}
      </StatGrid>

      <div className="mt-[var(--section-gap)] grid gap-x-10 gap-y-[var(--section-gap)] md:grid-cols-2">
        <section aria-labelledby="overview-attention">
          <h2 className="configuration-heading" id="overview-attention">Needs attention</h2>
          <ul>
            {ATTENTION.map((item) => (
              <li key={item.key}>
                <Link
                  className="flex items-center justify-between gap-2 py-3 text-[length:var(--text-size-ui)] text-[var(--text-primary)] hover:text-[var(--text-accent)]"
                  href={item.href}
                >
                  <span>{item.label}</span>
                  <span className={attention[item.key] ? "text-[var(--status-danger-text)]" : "text-[var(--text-tertiary)]"}>
                    {attention[item.key] ?? 0}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>

        <section aria-labelledby="overview-activity">
          <div className="configuration-heading-row">
            <h2 className="configuration-heading" id="overview-activity">Recent activity</h2>
            <Link href="/workspace-control/activity">View all</Link>
          </div>
          {recent_activity.length ? (
            <ul>
              {recent_activity.slice(0, 5).map((event) => (
                <li className="py-3 text-[length:var(--text-size-ui)]" key={event.id}>
                  <p className="text-[var(--text-primary)]">{describeAuditAction(event.action)}</p>
                  <p className="mt-1 text-[length:var(--text-size-meta)] text-[var(--text-tertiary)]">
                    {event.actor.display_name ?? event.actor.email ?? "System"} · {formatRelative(event.created_at)}
                  </p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="py-3 text-[length:var(--text-size-ui)] text-[var(--text-tertiary)]">No activity yet.</p>
          )}
        </section>
      </div>
    </>
  );
}
