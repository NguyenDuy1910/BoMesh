"use client";

import { Button, Spinner } from "@heroui/react";
import { KeyRound, LogIn, Plug, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import { PageChrome } from "@/components/shell/page-chrome";
import { AppIcon, confirm, DataTable, EmptyState, Gate, Page, PageHeader, SkeletonRows, StatusChip, toast, type DataTableColumn, type RowAction } from "@/components/ui";
import { errorMessage } from "@/lib/api/client";
import { plural, rel } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";

import { deleteConnection, testConnection, type Connection } from "../api";
import { accountLabel, accountStatus, accountSub, appKey, appName, sourceName } from "../model";
import { openConnectAccount, openReconnect, openWizard } from "../overlays";
import { sourcesByConnection, useConnections, useInvalidateIngestion, useSources } from "../queries";
import { IngestionDialogs } from "./IngestionDialogs";

/**
 * `/connections` (preview `P.connections`): the app accounts BoMesh signs in
 * with. Test, reconnect, connect and disconnect accounts. Secrets are never
 * shown; a token is sent once when connecting.
 */
export function ConnectionsPage() {
  const { id, can } = useWorkspace();
  const router = useRouter();
  const connections = useConnections();
  const sources = useSources();
  const refresh = useInvalidateIngestion();
  const [checking, setChecking] = useState<ReadonlySet<string>>(new Set());
  const manage = can("connections.create");
  const canSources = can("sources.create");
  const used = useMemo(() => sourcesByConnection(sources.data), [sources.data]);

  const list = connections.data ?? [];
  const empty = !!connections.data && list.length === 0;
  const broken = list.some((c) => c.state === "REAUTHORIZATION_REQUIRED");

  async function test(c: Connection) {
    const name = c.name ?? "";
    if (checking.has(name)) return;
    setChecking((s) => new Set(s).add(name));
    try {
      const result = await testConnection(id, name);
      if (result.ok) toast(`${accountLabel(c)} works`);
      else if (result.connection?.state === "REAUTHORIZATION_REQUIRED")
        toast(`${appName(c.connector)} access expired. Reconnect to resume syncing.`, {
          tone: "danger",
          action: { label: "Reconnect", onPress: () => openReconnect(name) },
        });
      else toast(result.message || `BoMesh can’t reach ${appName(c.connector)} right now.`, { tone: "danger" });
    } catch (error) {
      toast(errorMessage(error), { tone: "danger" });
    } finally {
      setChecking((s) => {
        const next = new Set(s);
        next.delete(name);
        return next;
      });
      refresh();
    }
  }

  async function disconnect(c: Connection) {
    const users = used.get(c.name ?? "") ?? [];
    if (users.length) {
      // The API keeps a connection while sources read through it.
      const go = await confirm({
        title: `Disconnect ${accountLabel(c)}?`,
        description: `${users.map(sourceName).join(", ")} ${users.length === 1 ? "syncs" : "sync"} with this account. Disconnect ${users.length === 1 ? "that source" : "those sources"} first; synced documents stay.`,
        confirmLabel: "Open sources",
        tone: "accent",
      });
      if (go) router.push(`/sources?q=${encodeURIComponent(accountLabel(c))}`);
      return;
    }
    const ok = await confirm({ title: `Disconnect ${accountLabel(c)}?`, description: "BoMesh stops using this sign-in. You can connect it again anytime.", confirmLabel: "Disconnect", tone: "danger" });
    if (!ok) return;
    try {
      await deleteConnection(id, c.name ?? "");
      toast(`Disconnected ${accountLabel(c)}`);
    } catch (error) {
      toast(errorMessage(error), { tone: "danger" });
    } finally {
      refresh();
    }
  }

  const columns: DataTableColumn<Connection>[] = [
    {
      id: "account",
      header: "Account",
      primary: true,
      cell: (c) => (
        <div className="row gap-12">
          <AppIcon app={appKey(c.connector)} />
          <div className="stack src-min">
            <span className="cell-title truncate" translate="no">
              {accountLabel(c)}
            </span>
            <span className="cell-sub truncate" translate="no">
              {accountSub(c)}
            </span>
          </div>
        </div>
      ),
    },
    {
      id: "status",
      header: "Status",
      cell: (c) =>
        checking.has(c.name ?? "") ? (
          <span className="row gap-6 t-sm muted">
            <Spinner size="sm" />
            Checking…
          </span>
        ) : accountStatus(c) === "authorizing" ? (
          <StatusChip label="Waiting for sign-in" tone="accent" />
        ) : (
          <StatusChip kind="account" value={accountStatus(c)} />
        ),
    },
    {
      id: "used",
      header: "Used by",
      cell: (c) => {
        const n = used.get(c.name ?? "")?.length ?? 0;
        return n ? (
          <button type="button" className="link-button" onClick={() => router.push(`/sources?q=${encodeURIComponent(accountLabel(c))}`)}>
            {plural(n, "source")}
          </button>
        ) : (
          <span className="muted">Not used</span>
        );
      },
    },
    { id: "checked", header: "Last checked", hideOnMobile: true, className: "muted", cell: (c) => rel(c.lastCheckTime ?? c.updateTime) },
  ];

  const lead = (c: Connection) =>
    c.state === "ACTIVE" ? (
      <Button size="sm" variant="secondary" className="acc-test-inline" isDisabled={checking.has(c.name ?? "")} onPress={() => void test(c)}>
        Test connection
      </Button>
    ) : (
      <Button size="sm" variant="primary" onPress={() => openReconnect(c.name ?? "")}>
        Reconnect
      </Button>
    );

  const menu = (c: Connection): RowAction[] => [
    { id: "test", label: "Test connection", icon: RefreshCw, isDisabled: c.state !== "ACTIVE" || checking.has(c.name ?? ""), onAction: () => void test(c) },
    { id: "reconnect", label: "Reconnect", icon: LogIn, onAction: () => openReconnect(c.name ?? "") },
    ...(canSources ? [{ id: "source", label: "Connect a source", icon: Plug, isDisabled: c.state !== "ACTIVE", onAction: () => openWizard({ connector: c.connector, connection: c.name }) }] : []),
    { id: "disconnect", label: "Disconnect", icon: Trash2, danger: true, onAction: () => void disconnect(c) },
  ];

  const none = (
    <EmptyState
      icon={KeyRound}
      title="No accounts connected"
      description="Connect Google Drive or Confluence so sources can sync."
      boxed
      actions={
        manage ? (
          <Button variant="primary" onPress={() => openConnectAccount()}>
            <Plus className="i" aria-hidden />
            Connect account
          </Button>
        ) : undefined
      }
    />
  );

  return (
    <Page>
      <PageChrome crumbs={[{ label: "Connections" }]} />
      <PageHeader
        title="Connections"
        description="Accounts BoMesh uses to read your apps."
        actions={
          manage && !empty ? (
            <Button variant={broken ? "secondary" : "primary"} onPress={() => openConnectAccount()}>
              <Plus className="i" aria-hidden />
              Connect account
            </Button>
          ) : null
        }
      />
      <Gate query={connections} skeleton={<SkeletonRows rows={3} />} isEmpty={(d) => d.length === 0} empty={none}>
        {(data) => (
          <DataTable
            label="Connected accounts"
            rows={data}
            columns={columns}
            getRowId={(c) => c.name ?? ""}
            rowActions={manage ? menu : undefined}
            rowActionLead={manage ? lead : undefined}
            actionsClassName="src-actions"
          />
        )}
      </Gate>
      <IngestionDialogs />
    </Page>
  );
}
