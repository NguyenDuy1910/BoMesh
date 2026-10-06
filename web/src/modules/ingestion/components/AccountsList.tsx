"use client";

import { KeyRound, LoaderCircle, MoreHorizontal, RefreshCw, Trash2 } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { Menu, MenuItem, MenuSeparator } from "@/components/ui/Menu";
import { SkeletonRows } from "@/components/ui/Skeleton";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { useToast } from "@/components/ui/Toast";
import { needsReauthorization } from "@/lib/api/request";
import { cn } from "@/lib/cn";
import { connectionState, needsReconnect } from "@/modules/ingestion/connection-state";
import type { Connection } from "@/modules/ingestion/integrations-api";
import { ingestionActions } from "@/modules/ingestion/queries";
import { formatDate, pluralize } from "@/lib/format";

import { AppIcon } from "./AppIcon";
import type { SourcesModel } from "./SourcesScreen";

/** The Accounts tab: each signed-in account, whether it still works, and what uses it. */
export function AccountsList({ model, highlightId }: { model: SourcesModel; highlightId: string | null }) {
  const toast = useToast();
  const [checking, setChecking] = useState<string | null>(null);

  if (!model.data) {
    return model.error ? (
      <ErrorState description={model.error} onAction={model.reload} />
    ) : (
      <SkeletonRows columns={4} label="Loading accounts" rows={2} />
    );
  }
  const connections = model.data.connections;
  if (!connections.length) {
    return (
      <EmptyState
        boxed
        description="Accounts are added when you connect a source."
        icon={<KeyRound />}
        title="No accounts connected"
      />
    );
  }

  const check = async (connection: Connection) => {
    const app = model.connectorName(connection.connector_key);
    const expired = () =>
      toast.show({
        tone: "err",
        message: `${app} access expired. Reconnect to resume syncing.`,
        action: { label: "Reconnect", onClick: () => model.open.reconnect(connection.id) },
      });
    setChecking(connection.id);
    try {
      const result = await ingestionActions.checkConnection(connection.id);
      if (result.valid) toast.show({ message: "Connection works" });
      else expired();
    } catch (cause) {
      // 409 is the API saying only a new sign-in fixes it; anything else is
      // the provider not answering, whose raw detail is not written for people.
      if (needsReauthorization(cause)) expired();
      else toast.show({ tone: "err", message: `Couldn’t reach ${app}. Try again in a moment.` });
    } finally {
      setChecking(null);
    }
  };

  return (
    <ul aria-label="Connected accounts" className="overflow-hidden rounded-lg border border-border-subtle bg-surface-base">
      {connections.map((connection) => {
        const used = model.data!.sources.filter((source) => source.connection_id === connection.id).length;
        const label = connection.account.label || connection.display_name;
        const detail = [model.connectorName(connection.connector_key), connection.account.resource_label]
          .filter((value) => value && value !== label)
          .join(" · ");
        const canManage = model.canManageConnection(connection);
        return (
          <li
            aria-current={highlightId === connection.id ? "true" : undefined}
            className={cn(
              "flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border-subtle px-4 py-3 last:border-b-0",
              highlightId === connection.id && "bg-surface-selected",
            )}
            key={connection.id}
          >
            <AppIcon connector={connection.connector_key} />
            <span className="min-w-0 flex-1 basis-[200px]">
              <span className="block truncate font-medium">{label}</span>
              <span className="block truncate text-meta text-text-tertiary">
                {detail}
                {connection.owner_type === "user" && " · Personal"}
              </span>
            </span>
            <span className="w-[150px] shrink-0">
              {checking === connection.id ? (
                <span className="inline-flex items-center gap-1.5 text-meta text-text-tertiary" role="status">
                  <LoaderCircle aria-hidden="true" className="size-4 motion-safe:animate-spin" />
                  Checking…
                </span>
              ) : (
                <StatusBadge kind="account" value={connectionState(connection).value} />
              )}
            </span>
            <span className="w-[130px] shrink-0 text-text-secondary max-[900px]:hidden">
              {used ? `Used by ${pluralize(used, "source")}` : "Not used"}
            </span>
            <span className="w-[170px] shrink-0 whitespace-nowrap text-text-tertiary max-[1080px]:hidden">
              {connection.connected_at ? `Connected ${formatDate(connection.connected_at)}` : "Not verified"}
            </span>
            <span className="flex w-[132px] shrink-0 items-center justify-end gap-1">
              {canManage && needsReconnect(connection) && (
                <Button onClick={() => model.open.reconnect(connection.id)} size="sm" variant="secondary">
                  Reconnect
                </Button>
              )}
              {canManage && (
                <Menu
                  align="end"
                  ariaLabel={`More actions for ${label}`}
                  label={<MoreHorizontal className="size-4" />}
                  showChevron={false}
                  tooltip="More actions"
                  triggerClassName="h-[var(--control-sm)] w-[var(--control-sm)] bg-transparent px-0 shadow-none hover:bg-surface-hover"
                >
                  <MenuItem disabled={checking === connection.id} icon={<RefreshCw />} onSelect={() => void check(connection)}>
                    Check connection
                  </MenuItem>
                  <MenuSeparator />
                  <MenuItem danger icon={<Trash2 />} onSelect={() => model.act.disconnectAccount(connection)}>
                    Disconnect
                  </MenuItem>
                </Menu>
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
