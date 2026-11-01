"use client";

import { ChevronDown, ChevronRight, CircleAlert, CircleCheck, RefreshCw, Server } from "lucide-react";
import { useState } from "react";

import { Page } from "@/components/shell/Page";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { DataTable, type DataTableColumn } from "@/components/ui/DataTable";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/ui/PageHeader";
import { PreviewTag } from "@/components/ui/PreviewTag";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { Tag } from "@/components/ui/Tag";
import { useToast } from "@/components/ui/Toast";
import { usePendingFeature } from "@/lib/api/pending";
import { cn } from "@/lib/cn";
import { serviceStatusKey } from "@/lib/status";
import type { SystemHealth } from "@/modules/manage/access/directory";
import {
  getPlatformHealth,
  getPlatformHealthHistory,
  type PlatformHealthIncident,
  type PlatformHealthServiceHistory,
} from "@/modules/platform/api";
import { RowList, RowListItem } from "@/modules/platform/components/Facts";
import { formatDate, formatDateTime, formatRelative, formatSpan, titleCase } from "@/lib/format";
import { useApiData } from "@/lib/hooks/useApiData";

type Service = SystemHealth["services"][number];

/** Each probed dependency in the words of what it does, and what people notice when it fails. */
const SERVICES: Record<string, { name: string; impact: string }> = {
  api: { name: "Web & API", impact: "People can’t sign in or open any screen." },
  qdrant: { name: "Search index", impact: "Searching knowledge fails, so answers can’t cite documents." },
  openai_chat: { name: "Assistant", impact: "The assistant can’t write answers." },
  openrouter_embeddings: { name: "Search understanding", impact: "New documents can’t be made searchable, and search may fail." },
  langfuse: { name: "Answer tracing", impact: "Answers still work, but they aren’t traced for review." },
};

/** Why a check failed, as a person reads it. Categories never carry secrets or raw messages. */
const FAILURE: Record<string, string> = {
  timeout: "The check timed out.",
  connection_failed: "The service couldn’t be reached.",
  authentication_failed: "The service rejected the deployment’s credentials.",
  rate_limited: "The service is limiting requests.",
  resource_not_found: "The configured resource wasn’t found.",
  model_not_available: "The configured model isn’t available from the provider.",
  invalid_response: "The service answered with something unexpected.",
  incompatible_schema: "The search index is set up differently than expected.",
  incomplete_configuration: "The deployment configuration is incomplete.",
  no_project_access: "The deployment’s credentials can’t reach the project.",
  not_configured: "It isn’t set up in this deployment.",
  upstream_error: "The service reported an error.",
};

const serviceName = (name: string) => SERVICES[name]?.name ?? titleCase(name);

function UptimeStrip({ history }: { history: PlatformHealthServiceHistory | undefined }) {
  const days = history?.daily ?? [];
  const issues = days.filter((day) => day.status === "issues").length;
  const unchecked = days.filter((day) => day.status === "no_data").length;
  const summary = !days.length || unchecked === days.length
    ? "Not checked from this browser in the last 30 days"
    : `${issues ? `${issues} ${issues === 1 ? "day" : "days"} with issues` : "No issues"}, ${unchecked} ${unchecked === 1 ? "day" : "days"} not checked, in the last 30 days`;
  return (
    <span aria-label={summary} className="flex items-center gap-0.5" role="img">
      {(days.length ? days : Array.from({ length: 30 }, (_, index) => ({ date: String(index), status: "no_data" as const, checks: 0 }))).map((day) => (
        <i
          className={cn(
            "block h-[18px] w-1 rounded-xs",
            day.status === "healthy" && "bg-status-success-text opacity-80",
            day.status === "issues" && "bg-status-warning-text",
            day.status === "no_data" && "bg-border-default",
          )}
          key={day.date}
          title={days.length ? `${formatDate(`${day.date}T12:00:00Z`)} · ${day.status === "healthy" ? "No issues" : day.status === "issues" ? "Had issues" : "Not checked"}` : undefined}
        />
      ))}
    </span>
  );
}

function incidentDuration(incident: PlatformHealthIncident): string {
  if (!incident.resolved_at) return "Ongoing";
  return `Resolved in ${formatSpan(Date.parse(incident.resolved_at) - Date.parse(incident.started_at)).toLowerCase()}`;
}

/**
 * Platform → System health: the live `/platform/health` report in plain
 * service names, what a failing service means for people, and — through
 * `platform.health_history` — 30 days of status and the incidents in them.
 */
export function PlatformHealthPage() {
  const historyEnabled = usePendingFeature("platform.health_history");
  const toast = useToast();
  const [refreshing, setRefreshing] = useState(false);
  const [showIncidents, setShowIncidents] = useState(false);
  const health = useApiData(getPlatformHealth);
  // Refresh reads a new report itself; whichever report is newer is the one shown.
  const [fresh, setFresh] = useState<SystemHealth | null>(null);
  const report = fresh && (!health.data || fresh.checked_at >= health.data.checked_at) ? fresh : health.data;
  // Read after each report, so the history includes the check just made.
  const history = useApiData(
    () => (historyEnabled && report ? getPlatformHealthHistory({ days: 30 }) : Promise.resolve(null)),
    `${historyEnabled}:${report?.checked_at ?? ""}`,
  );
  const historyByService = new Map((history.data?.services ?? []).map((service) => [service.name, service]));
  const incidents = history.data?.incidents ?? [];

  const refresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      setFresh(await getPlatformHealth());
      toast.show({ message: "Status refreshed" });
    } catch {
      toast.show({ tone: "err", message: "Couldn’t refresh the status", description: "Try again in a moment." });
    } finally {
      setRefreshing(false);
    }
  };

  const failing = (report?.services ?? []).filter((service) => service.status === "unhealthy" || service.status === "degraded");

  const columns: DataTableColumn<Service>[] = [
    {
      id: "service",
      header: "Service",
      cell: (service) => (
        <span className="block min-w-0">
          <span className="flex items-center gap-2 font-medium text-text-primary">
            {serviceName(service.name)}
            {!service.required && <Tag>Optional</Tag>}
          </span>
          {service.status !== "healthy" && (
            <span className="mt-0.5 block max-w-[340px] text-meta text-text-tertiary">
              {[service.status === "not_configured" ? null : SERVICES[service.name]?.impact, service.error_category ? FAILURE[service.error_category] : null]
                .filter(Boolean)
                .join(" ")}
            </span>
          )}
        </span>
      ),
    },
    ...(historyEnabled
      ? [
        {
          id: "days",
          header: <span className="inline-flex items-center gap-2">Last 30 days <PreviewTag /></span>,
          hideBelow: 900 as const,
          width: 250,
          cell: (service: Service) => <UptimeStrip history={historyByService.get(service.name)} />,
        },
        {
          id: "uptime",
          header: "Uptime",
          align: "right" as const,
          width: 100,
          cell: (service: Service) => {
            const uptime = historyByService.get(service.name)?.uptime_percent;
            return uptime === null || uptime === undefined ? <span className="text-text-tertiary">—</span> : `${uptime.toFixed(2).replace(/\.00$/, "")}%`;
          },
        },
      ]
      : []),
    {
      id: "latency",
      header: "Response",
      align: "right",
      width: 110,
      // 0 means not measured: the API reports itself without a round trip.
      cell: (service) => (service.status === "healthy" && service.latency_ms
        ? <span className="whitespace-nowrap font-mono text-meta">{service.latency_ms} ms</span>
        : <span className="text-text-tertiary">—</span>),
    },
    {
      id: "status",
      header: "Status",
      width: 150,
      cell: (service) => <StatusBadge kind="service" value={serviceStatusKey(service.status)} />,
    },
  ];

  return (
    <Page>
      <PageHeader
        actions={(
          <Button icon={<RefreshCw aria-hidden="true" />} loading={refreshing} onClick={() => void refresh()} variant="secondary">
            Refresh
          </Button>
        )}
        sub={report ? <span title={formatDateTime(report.checked_at)}>Updated {formatRelative(report.checked_at)}</span> : "Checking every service…"}
        title="System health"
      />
      {report && (
        <div className="mb-4">
          {!failing.length ? (
            <Callout title="All systems operational" tone="ok">
              {report.services.some((service) => service.status === "not_configured")
                ? "Services that aren’t set up in this deployment are listed as not configured."
                : null}
            </Callout>
          ) : (
            <Callout
              title={failing.length === 1
                ? `${serviceName(failing[0].name)} ${failing[0].required ? "isn’t working" : "has a problem"}`
                : `${failing.length} services aren’t working`}
              tone={failing.some((service) => service.required) ? "err" : "warn"}
            >
              {failing.map((service) => SERVICES[service.name]?.impact ?? `${serviceName(service.name)} is failing its check.`).join(" ")}
            </Callout>
          )}
        </div>
      )}
      <DataTable
        ariaLabel="Services"
        columns={columns}
        data={report?.services ?? []}
        emptyState={<EmptyState description="Status appears once the deployment reports in." icon={<Server aria-hidden="true" />} title="No services reporting" />}
        error={health.error}
        getRowId={(service) => service.name}
        loading={!report && !health.error}
        onRetry={health.reload}
      />

      {historyEnabled && history.data && (
        <section className="mt-8">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <button
              aria-controls="platform-incidents"
              aria-expanded={showIncidents}
              className="-ml-1 inline-flex items-center gap-1.5 rounded-sm px-1 py-0.5 text-text-primary hover:text-text-accent focus-visible:shadow-(--shadow-focus) focus-visible:outline-none"
              onClick={() => setShowIncidents((open) => !open)}
              type="button"
            >
              {showIncidents ? <ChevronDown aria-hidden="true" className="size-4 text-text-tertiary" /> : <ChevronRight aria-hidden="true" className="size-4 text-text-tertiary" />}
              <span className="text-section font-semibold">Recent incidents</span>
            </button>
            <span className="inline-flex items-center gap-2 text-[0.8125rem] text-text-tertiary">
              {incidents.length
                ? `${incidents.filter((incident) => incident.resolved_at).length} resolved, ${incidents.filter((incident) => !incident.resolved_at).length} ongoing in the last 30 days`
                : "None in the last 30 days"}
              <PreviewTag />
            </span>
          </div>
          {showIncidents && (
            <div id="platform-incidents">
              {!incidents.length ? (
                <EmptyState
                  boxed
                  description="Incidents appear when a check fails, and close when the service passes again."
                  size="sm"
                  title="No incidents recorded"
                />
              ) : (
                <RowList label="Recent incidents">
                  {incidents.map((incident) => (
                    <RowListItem className="items-start" key={incident.id}>
                      {incident.resolved_at ? (
                        <CircleCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-status-success-text" />
                      ) : (
                        <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-status-danger-text" />
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="font-medium">
                          {serviceName(incident.service)} {incident.resolved_at ? "wasn’t working" : "isn’t working"}
                        </div>
                        <p className="text-[0.84375rem] text-text-secondary">
                          {[SERVICES[incident.service]?.impact, incident.error_category ? FAILURE[incident.error_category] : null].filter(Boolean).join(" ")}
                        </p>
                      </div>
                      <div className="flex shrink-0 flex-col items-end text-meta">
                        <span className="text-text-secondary" title={formatDateTime(incident.started_at)}>{formatDate(incident.started_at)}</span>
                        <span className="text-text-tertiary">{incidentDuration(incident)}</span>
                      </div>
                    </RowListItem>
                  ))}
                </RowList>
              )}
            </div>
          )}
        </section>
      )}
    </Page>
  );
}
