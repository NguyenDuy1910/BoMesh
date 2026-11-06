"use client";

import { Button } from "@heroui/react";
import { AlertCircle, ArrowUpRight, CheckCircle2, ChevronDown, ChevronUp, Cpu, FileText, Layers, RefreshCw, Search, Server, Sparkles } from "lucide-react";
import NextLink from "next/link";
import { useState, type ReactNode } from "react";

import { PageChrome } from "@/components/shell/page-chrome";
import { Callout, DataTable, EmptyState, ErrorState, ItemIcon, List, ListItem, Page, PageHeader, PreviewChip, Section, SkeletonRows, StatusChip, toast } from "@/components/ui";
import { fmtDate, plural, rel } from "@/lib/format";

import type { Component, Incident } from "../api";
import { errorCategoryLabel, fmtIncidentDuration, serviceStatus, unhealthyComponents } from "../model";
import { useComponents, useIncidents } from "../queries";
import { PREVIEW_TIP } from "./shared";

/** Preview `D.pModels` names and descriptions, keyed by the deployment setting that configures each model. */
const MODEL_COPY: Record<string, { name: string; description: string; icon: typeof Sparkles }> = {
  OPENROUTER_MODEL: { name: "Answers & reasoning", description: "Writes answers and decides when to search.", icon: Sparkles },
  EMBEDDING_MODEL: { name: "Search understanding", description: "Turns passages into searchable meaning.", icon: Search },
  BOMESH_DOCLING_MODEL: { name: "Document reading", description: "Reads layouts, tables and scanned pages.", icon: FileText },
  BOMESH_CONTEXTUALIZATION_MODEL: { name: "Passage context", description: "Adds surrounding context to each passage before indexing.", icon: Layers },
};

function ServiceChip({ state }: { state: Component["state"] }) {
  const s = serviceStatus(state);
  if (s === "not_configured") return <StatusChip label="Not configured" tone="default" dot={false} />;
  return <StatusChip kind="service" value={s} />;
}

/** What an ongoing incident says about a component (expandable service note). */
function noteFor(component: Component, incidents: readonly Incident[]): string | null {
  const ongoing = incidents.find((i) => i.component === component.name && i.state === "ONGOING");
  if (ongoing) return `${errorCategoryLabel(ongoing.errorCategory)} since ${rel(ongoing.startTime).toLowerCase()}.`;
  if (component.state === "NOT_CONFIGURED") return component.setting ? `Set ${component.setting} in the deployment configuration.` : "Not set up in this deployment.";
  return null;
}

/** Preview `P.pHealth`: service health and impact, AI capabilities (read-only settings), incidents. */
export function HealthPage() {
  const components = useComponents();
  const incidents = useIncidents();
  const [showIncidents, setShowIncidents] = useState(false);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [refreshing, setRefreshing] = useState(false);

  const refresh = async () => {
    setRefreshing(true);
    try {
      await Promise.all([components.refetch(), incidents.refetch()]);
      toast("Status refreshed");
    } finally {
      setRefreshing(false);
    }
  };

  const updated = components.dataUpdatedAt ? `Updated ${rel(components.dataUpdatedAt).toLowerCase()}` : undefined;
  const all = components.data ?? [];
  const incidentList = incidents.data ?? [];
  const services = all.filter((c) => c.kind === "SERVICE");
  const models = all.filter((c) => c.kind === "AI_MODEL");
  const bad = unhealthyComponents(all);
  const nameOf = (name: string | undefined) => all.find((c) => c.name === name)?.displayName ?? "A service";

  const banner = (): ReactNode => {
    if (!bad.length) return <Callout tone="success" title="All systems operational" />;
    const tone = bad.some((c) => c.state === "DOWN") ? "danger" : "warning";
    if (bad.length > 1) return <Callout tone={tone} title={`${plural(bad.length, "service")} need attention`} description={bad.map((c) => c.displayName).join(", ")} />;
    const c = bad[0];
    return <Callout tone={tone} title={`${c.displayName} is ${c.state === "DOWN" ? "down" : "degraded"}`} description={noteFor(c, incidentList) ?? undefined} />;
  };

  const resolved = incidentList.filter((i) => i.state === "RESOLVED");
  const ongoing = incidentList.filter((i) => i.state === "ONGOING");

  return (
    <Page>
      <PageChrome crumbs={[{ label: "System health" }]} />
      <PageHeader
        title="System health"
        description={updated}
        chips={<PreviewChip tooltip={PREVIEW_TIP} />}
        actions={
          <Button variant="tertiary" isPending={refreshing} onPress={() => void refresh()}>
            <RefreshCw className="i" aria-hidden />
            Refresh
          </Button>
        }
      />
      {components.isError && !components.data ? (
        <ErrorState error={components.error} onRetry={components.refetch} />
      ) : components.isPending ? (
        <SkeletonRows rows={7} />
      ) : !all.length ? (
        <EmptyState icon={Server} title="No services reporting" description="Status appears once the deployment reports in." boxed />
      ) : (
        <>
          <div className="pf-banner">{banner()}</div>
          <Section
            title="Services"
            actions={
              <NextLink className="link-button" href="/p/indexing">
                Indexing by workspace
                <ArrowUpRight className="i i-sm" aria-hidden />
              </NextLink>
            }
          >
            <DataTable
              label="Services"
              rows={services}
              getRowId={(c) => c.name ?? ""}
              onRowAction={(c) => {
                if (!noteFor(c, incidentList)) return;
                const key = c.name ?? "";
                setOpen((o) => ({ ...o, [key]: !(o[key] ?? c.state !== "HEALTHY") }));
              }}
              columns={[
                {
                  id: "name",
                  header: "Service",
                  primary: true,
                  cell: (c) => {
                    const note = noteFor(c, incidentList);
                    const expanded = Boolean(note) && (open[c.name ?? ""] ?? c.state !== "HEALTHY");
                    return (
                      <div className="stack">
                        <span className="cell-title pf-svc" aria-expanded={note ? expanded : undefined}>
                          {c.displayName}
                          {note ? expanded ? <ChevronUp className="i i-sm muted" aria-hidden /> : <ChevronDown className="i i-sm muted" aria-hidden /> : null}
                        </span>
                        {expanded ? <span className="pf-note">{note}</span> : null}
                      </div>
                    );
                  },
                },
                { id: "status", header: "Status", cell: (c) => <ServiceChip state={c.state} /> },
                {
                  id: "checked",
                  header: "Last checked",
                  align: "end",
                  mobileLabel: "Checked",
                  className: "pf-nowrap",
                  cell: (c) => <span className="muted num pf-checked">{c.checkTime ? rel(c.checkTime) : "—"}</span>,
                },
              ]}
            />
          </Section>
          <Section title="AI capabilities" description="Models are set in the deployment configuration and change on restart.">
            <List className="pf-models">
              {models.map((m) => {
                const copy = m.setting ? MODEL_COPY[m.setting] : undefined;
                return (
                  <ListItem
                    key={m.name}
                    lead={<ItemIcon icon={copy?.icon ?? Cpu} tone={m.state === "HEALTHY" ? undefined : "warning"} size="sm" />}
                    title={copy?.name ?? m.displayName}
                    description={
                      <>
                        {copy?.description ?? m.displayName}
                        {m.setting ? (
                          <span className="pf-setting">
                            Configured via <code className="mono">{m.setting}</code>
                          </span>
                        ) : null}
                      </>
                    }
                    actions={
                      <span className="pf-model-trail">
                        <ServiceChip state={m.state} />
                        {m.model ? (
                          <span className="t-xs muted mono" translate="no">
                            {m.model}
                          </span>
                        ) : null}
                      </span>
                    }
                  />
                );
              })}
            </List>
          </Section>
          <Section
            title="Recent incidents"
            description={
              ongoing.length
                ? `${plural(ongoing.length, "incident")} ongoing · ${plural(resolved.length, "incident")} resolved in the last 30 days`
                : `${plural(resolved.length, "incident")} resolved in the last 30 days`
            }
            actions={
              <Button variant="ghost" size="sm" aria-expanded={showIncidents} onPress={() => setShowIncidents((v) => !v)}>
                {showIncidents ? "Hide" : "Show"}
                {showIncidents ? <ChevronUp className="i" aria-hidden /> : <ChevronDown className="i" aria-hidden />}
              </Button>
            }
          >
            {showIncidents ? (
              incidents.isError && !incidents.data ? (
                <ErrorState error={incidents.error} onRetry={incidents.refetch} compact />
              ) : incidentList.length ? (
                <List>
                  {incidentList.map((i) => {
                    const end = i.endTime ? Date.parse(i.endTime) : Date.now();
                    const dur = end - Date.parse(i.startTime ?? "");
                    return (
                      <ListItem
                        key={i.name}
                        lead={<ItemIcon icon={i.state === "RESOLVED" ? CheckCircle2 : AlertCircle} tone={i.state === "RESOLVED" ? "success" : "warning"} size="sm" />}
                        title={`${nameOf(i.component)}: ${errorCategoryLabel(i.errorCategory).toLowerCase()}`}
                        description={i.state === "RESOLVED" ? "Resolved." : "Still going on."}
                        meta={`${fmtDate(i.startTime)} · ${Number.isFinite(dur) ? fmtIncidentDuration(dur) : "—"}`}
                      />
                    );
                  })}
                </List>
              ) : (
                <p className="t-sm muted">No incidents in the last 30 days.</p>
              )
            ) : null}
          </Section>
        </>
      )}
    </Page>
  );
}
