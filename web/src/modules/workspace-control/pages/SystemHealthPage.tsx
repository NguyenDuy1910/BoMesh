"use client";

import { CheckCircle2, CircleAlert } from "lucide-react";

import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { ErrorState } from "@/components/ui/ErrorState";
import { PageLoadingSkeleton } from "@/components/ui/Skeleton";
import { StatusBadge, type StatusVocabulary } from "@/components/ui/StatusBadge";
import { StatGrid, StatTile } from "@/components/ui/StatTile";
import { SectionHeader } from "@/modules/workspace-control/components/SectionHeader";
import { workspaceDirectoryApi, type SystemHealth } from "@/modules/workspace-control/directory";
import { formatDateTime, formatRelative } from "@/modules/workspace-control/format";
import { useControlPlaneData } from "@/modules/workspace-control/queries";

/* The health probe's own words. `healthy` is not a lifecycle state, so the
   shared vocabulary would render it neutral. */
const HEALTH: StatusVocabulary = {
  healthy: { label: "Healthy", tone: "success" },
  degraded: { label: "Degraded", tone: "warning" },
  unhealthy: { label: "Unhealthy", tone: "danger" },
};

const TILE_TONE = { healthy: "default", degraded: "warning", unhealthy: "danger" } as const;

export function SystemHealthPage() {
  const health = useControlPlaneData(workspaceDirectoryApi.platform.health);
  return (
    <>
      <SectionHeader section="platform-system" />
      {health.error ? (
        <ErrorState description={health.error} onAction={health.reload} />
      ) : health.data ? (
        <HealthReport report={health.data} />
      ) : (
        <PageLoadingSkeleton label="Loading system health" />
      )}
    </>
  );
}

function HealthReport({ report }: { report: SystemHealth }) {
  const { services, status, checked_at, duration_ms } = report;
  const required = services.filter((service) => service.required);
  return (
    <>
      <StatGrid>
        <StatTile
          label="Overall status"
          note={<span title={formatDateTime(checked_at)}>Checked {formatRelative(checked_at)}</span>}
          tone={TILE_TONE[status]}
          value={HEALTH[status]?.label ?? status}
        />
        <StatTile
          label="Required services"
          note={`${required.length} checked`}
          value={`${required.filter((service) => service.status === "healthy").length}/${required.length} healthy`}
        />
        <StatTile label="Check duration" note="Round trip for this probe" value={`${duration_ms} ms`} />
      </StatGrid>
      <Card className="mt-[var(--section-gap)]">
        <CardHeader title="Services" />
        <CardBody>
          <ul className="divide-y divide-[var(--border-subtle)]">
            {services.map((service) => (
              <li className="flex min-h-14 items-center gap-3 py-3" key={service.name}>
                {service.status === "healthy" ? (
                  <CheckCircle2 aria-hidden="true" className="h-4 w-4 text-[var(--status-success-solid)]" />
                ) : (
                  <CircleAlert aria-hidden="true" className="h-4 w-4 text-[var(--status-warning-solid)]" />
                )}
                <span className="min-w-0 flex-1 text-[length:var(--text-size-ui)] font-medium text-[var(--text-primary)]">
                  {service.name}{service.required ? "" : " · optional"}
                </span>
                {service.latency_ms != null && (
                  <span className="text-[length:var(--text-size-meta)] text-[var(--text-tertiary)]">{service.latency_ms} ms</span>
                )}
                <StatusBadge status={service.status} vocabulary={HEALTH} />
              </li>
            ))}
          </ul>
        </CardBody>
      </Card>
    </>
  );
}
