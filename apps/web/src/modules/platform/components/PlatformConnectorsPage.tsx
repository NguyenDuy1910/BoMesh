"use client";

import { Plug } from "lucide-react";
import { useEffect, useState } from "react";

import { Page } from "@/components/shell/Page";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { ui } from "@/components/ui/design-system";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { PageHeader } from "@/components/ui/PageHeader";
import { PreviewTag } from "@/components/ui/PreviewTag";
import { SkeletonCards } from "@/components/ui/Skeleton";
import { Switch } from "@/components/ui/Switch";
import { useToast } from "@/components/ui/Toast";
import { usePendingFeature } from "@/lib/api/pending";
import { cn } from "@/lib/cn";
import { AppIcon } from "@/modules/ingestion/components/AppIcon";
import { listPlatformConnectors, updatePlatformConnector, type PlatformConnector } from "@/modules/platform/api";
import { ConnectorConfigureDrawer } from "@/modules/platform/components/ConnectorConfigureDrawer";
import { ConnectorRequestsDialog } from "@/modules/platform/components/ConnectorRequestsDialog";
import { pluralize } from "@/lib/format";
import { useApiData } from "@/lib/hooks/useApiData";

function statusLine(connector: PlatformConnector): string {
  if (connector.built_in) return `Built in · used by ${pluralize(connector.workspace_count, "workspace")}`;
  if (!connector.supported) return `Not available · ${pluralize(connector.request_count, "workspace request")}`;
  return connector.available
    ? `Available · used by ${pluralize(connector.workspace_count, "workspace")}`
    : "Turned off · workspaces can’t connect it";
}

/**
 * Platform → Connectors: which apps workspaces may connect, the sign-in
 * settings they share, and demand for the ones this deployment lacks. All of
 * it is `platform.connectors` until the API serves it.
 */
export function PlatformConnectorsPage() {
  const enabled = usePendingFeature("platform.connectors");
  const toast = useToast();
  const query = useApiData(() => (enabled ? listPlatformConnectors() : Promise.resolve([])), String(enabled));
  // The saved row until the list is read again, so a switch never flips back while the list refreshes.
  const [saved, setSaved] = useState<Record<string, PlatformConnector>>({});
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [turningOff, setTurningOff] = useState<PlatformConnector | null>(null);
  const [configuring, setConfiguring] = useState<PlatformConnector | null>(null);
  const [requests, setRequests] = useState<PlatformConnector | null>(null);

  useEffect(() => setSaved({}), [query.data]);

  const connectors = (query.data ?? []).map((connector) => saved[connector.key] ?? connector);

  const setAvailable = async (connector: PlatformConnector, available: boolean) => {
    setBusyKey(connector.key);
    try {
      const updated = await updatePlatformConnector(connector.key, { available });
      setSaved((current) => ({ ...current, [updated.key]: updated }));
      toast.show({ message: `${available ? "Turned on" : "Turned off"} ${connector.name}` });
    } finally {
      setBusyKey(null);
    }
  };

  const toggle = (connector: PlatformConnector, next: boolean) => {
    if (!next) {
      setTurningOff(connector);
      return;
    }
    setAvailable(connector, true).catch((cause: unknown) => {
      toast.show({ tone: "err", message: `Couldn’t turn on ${connector.name}`, description: cause instanceof Error ? cause.message : undefined });
    });
  };

  if (!enabled) {
    return (
      <Page>
        <PageHeader sub="Apps workspaces can connect." title="Connectors" />
        <EmptyState
          description="Connector settings aren’t part of this deployment yet."
          icon={<Plug aria-hidden="true" />}
          title="Connectors aren’t available here"
        />
      </Page>
    );
  }

  return (
    <Page>
      <PageHeader sub="Apps workspaces can connect." title="Connectors" titleExtra={<PreviewTag />} />
      {query.error ? (
        <ErrorState onAction={query.reload} />
      ) : !query.data ? (
        <SkeletonCards count={6} label="Loading connectors" />
      ) : !connectors.length ? (
        <EmptyState
          boxed
          description="Connectors appear here once they’re part of this deployment."
          icon={<Plug aria-hidden="true" />}
          title="No connectors installed"
        />
      ) : (
        <ul className="m-0 grid list-none grid-cols-3 gap-3 p-0 max-[1180px]:grid-cols-2 max-[700px]:grid-cols-1" aria-label="Connectors">
          {connectors.map((connector) => {
            const switchId = `connector-available-${connector.key}`;
            return (
              <li className={cn(ui.card, ui.cardPadding, "flex flex-col gap-3")} key={connector.key}>
                <AppIcon connector={connector.key} fallback={connector.built_in ? "upload" : "unknown"} />
                <div>
                  <h2 className={ui.sectionTitle}>{connector.name}</h2>
                  <p className="mt-0.5 text-[0.84375rem] text-text-secondary">{connector.description}</p>
                  <p className="mt-2 text-[0.8125rem] text-text-tertiary">{statusLine(connector)}</p>
                </div>
                <div className="mt-auto flex min-h-[43px] items-center justify-between gap-2 border-t border-border-subtle pt-3">
                  {connector.built_in ? (
                    <span className="text-[0.8125rem] text-text-tertiary">Always available</span>
                  ) : !connector.supported ? (
                    <>
                      <span />
                      <Button onClick={() => setRequests(connector)} size="sm" variant="secondary">View requests</Button>
                    </>
                  ) : (
                    <>
                      <span className="flex items-center gap-2">
                        <Switch
                          checked={connector.available}
                          disabled={busyKey === connector.key}
                          id={switchId}
                          onChange={(next) => toggle(connector, next)}
                        />
                        <label className="cursor-pointer text-[0.8125rem] text-text-secondary" htmlFor={switchId}>
                          Available to workspaces
                        </label>
                      </span>
                      {connector.authentication === "oauth" && (
                        <Button onClick={() => setConfiguring(connector)} size="sm" variant="secondary">Configure</Button>
                      )}
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <ConfirmDialog
        confirmLabel="Turn off"
        description={turningOff
          ? `${pluralize(turningOff.workspace_count, "workspace")} will stop syncing from it. Their documents stay searchable.`
          : ""}
        onClose={() => setTurningOff(null)}
        onConfirm={() => (turningOff ? setAvailable(turningOff, false) : undefined)}
        open={Boolean(turningOff)}
        title={turningOff ? `Turn off ${turningOff.name}?` : ""}
      />
      <ConnectorConfigureDrawer
        connector={configuring}
        onClose={() => setConfiguring(null)}
        onSaved={(updated) => {
          setSaved((current) => ({ ...current, [updated.key]: updated }));
          setConfiguring(null);
          toast.show({ message: `Saved ${updated.name} settings` });
        }}
      />
      <ConnectorRequestsDialog connector={requests} onClose={() => setRequests(null)} />
    </Page>
  );
}
