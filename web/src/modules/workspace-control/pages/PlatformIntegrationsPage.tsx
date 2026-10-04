"use client";

import { Plug } from "lucide-react";
import { useMemo, useState } from "react";

import { CommandBar } from "@/components/layout/CommandBar";
import { Badge } from "@/components/ui/Badge";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { PageLoadingSkeleton } from "@/components/ui/Skeleton";
import { SectionHeader } from "@/modules/workspace-control/components/SectionHeader";
import { pluralize, titleCase } from "@/modules/workspace-control/format";
import { useConnectorCatalogue, type ConnectorEntry } from "@/modules/ingestion/queries";

/* The registry's keys, in the short words a table column has room for. A key
   added to the backend without a word here is shown title-cased, not raw. */
const AUTHORIZATION_LABELS: Record<string, string> = {
  oauth: "Account sign-in",
  credentials: "API credentials",
  none: "None",
};

const CAPABILITY_LABELS: Record<string, string> = {
  knowledge_ingestion: "Document sync",
  resource_discovery: "Content browsing",
};

const columns: Column<ConnectorEntry>[] = [
  {
    key: "connector",
    label: "Connector",
    primary: true,
    render: (entry) => <span className="font-medium text-[var(--text-primary)]">{entry.connector.name}</span>,
  },
  {
    key: "authentication",
    label: "Authorization",
    width: 180,
    render: (entry) => {
      const type = entry.capability?.authentication_type;
      return type ? AUTHORIZATION_LABELS[type] ?? titleCase(type) : "Not available here";
    },
  },
  {
    key: "capabilities",
    label: "Capabilities",
    priority: "medium",
    render: (entry) => {
      const capabilities = entry.capability?.capabilities ?? [];
      return capabilities.length ? (
        <span className="flex flex-wrap gap-1">
          {capabilities.map((capability) => (
            <Badge key={capability} tone="neutral">{CAPABILITY_LABELS[capability] ?? titleCase(capability)}</Badge>
          ))}
        </span>
      ) : "—";
    },
  },
];

/**
 * What this deployment can connect.
 *
 * The registry is the authority: a connector appears here because the running
 * backend implements it, not because a catalogue lists it. Turning a connector
 * on or off per workspace is a policy no endpoint stores yet, so the table
 * reports availability rather than offering a switch that would not hold.
 */
export function PlatformIntegrationsPage() {
  const { data, error, reload } = useConnectorCatalogue();
  const [search, setSearch] = useState("");
  const rows = useMemo(() => {
    const term = search.trim().toLowerCase();
    return (data ?? []).filter((entry) =>
      !term || entry.connector.name.toLowerCase().includes(term),
    );
  }, [data, search]);

  return <>
    <SectionHeader section="platform-integrations" />
    {error ? (
      <ErrorState description={error} onAction={reload} title="Connectors could not be loaded" />
    ) : !data ? (
      <PageLoadingSkeleton controls label="Loading connectors" />
    ) : <>
      <CommandBar
        count={pluralize(rows.length, "connector")}
        search={{ value: search, onChange: setSearch, placeholder: "Search connectors…", label: "Search connectors" }}
      />
      <DataTable
        ariaLabel="Available connectors"
        columns={columns}
        data={rows}
        emptyState={
          <EmptyState
            description={search ? "Try a different search." : "This deployment doesn't register any connectors."}
            icon={<Plug size={20} />}
            size="sm"
            title={search ? "No matching connectors" : "No connectors available"}
          />
        }
        getRowId={(entry) => entry.connector.key}
      />
    </>}
  </>;
}
