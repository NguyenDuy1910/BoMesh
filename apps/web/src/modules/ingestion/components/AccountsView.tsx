"use client";

import { Button, Spinner } from "@heroui/react";
import { KeyRound, LogIn, Plug, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";

import { AppIcon, confirm, DataTable, EmptyState, Gate, SkeletonRows, StatusChip, toast, type DataTableColumn, type RowAction } from "@/components/ui";
import { errorMessage } from "@/lib/api/client";
import { plural, rel } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";

import { deleteConnection, testConnection, type Connection } from "../api";
import { accountLabel, accountStatus, accountSub, appKey, appName, sourceName } from "../model";
import { openConnectAccount, openReconnect, openWizard } from "../overlays";
import { sourcesByConnection, useConnections, useInvalidateIngestion, useSources } from "../queries";
import { useParamState } from "./shared";

/**
 * Studio → Sources → Accounts (preview `X.acc.view`): the app sign-ins sources read with. Test, reconnect,
 * disconnect; ⋯ Add source with this account. Secrets are never shown; a token is sent once when connecting.
 */
export function AccountsView() {
  const { id, can } = useWorkspace();
  const { set } = useParamState();
  const connections = useConnections();
  const sources = useSources();
  const refresh = useInvalidateIngestion();
  const [checking, setChecking] = useState<ReadonlySet<string>>(new Set());
  const manage = can("connections.create");
  const canSources = can("sources.create");
  const used = useMemo(() => sourcesByConnection(sources.data), [sources.data]);
  /** Sources view searched for the account's sources. */
  const showSources = (c: Connection) => set({ view: null, q: accountLabel(c), status: null, source: null, page: null });

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
      // The API keeps a connection while sources read through it (a source's account is fixed).
      const go = await confirm({
        title: `Disconnect ${accountLabel(c)}?`,
        description: `${users.map(sourceName).join(", ")} ${users.length === 1 ? "syncs" : "sync"} with this account. Disconnect ${users.length === 1 ? "that source" : "those sources"} first; synced documents stay.`,
        confirmLabel: "Show sources",
        tone: "accent",
      });
      if (go) showSources(c);
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
          <button type="button" className="link-button" onClick={() => showSources(c)}>
            {plural(n, "source")}
          </button>
        ) : (
          <span className="muted">Not used</span>
        );
      },
    },
    { id: "checked", header: "Last checked", hideOnMobile: true, className: "muted", cell: (c) => rel(c.lastCheckTime ?? c.updateTime) },
  ];

  const menu = (c: Connection): RowAction[] => {
    const expired = c.state === "REAUTHORIZATION_REQUIRED";
    const reconnect: RowAction = { id: "reconnect", label: "Reconnect", icon: LogIn, onAction: () => openReconnect(c.name ?? "") };
    const testItem: RowAction = { id: "test", label: "Test connection", icon: RefreshCw, isDisabled: c.state !== "ACTIVE" || checking.has(c.name ?? ""), onAction: () => void test(c) };
    return [
      ...(expired ? [reconnect, testItem] : [testItem, reconnect]),
      ...(canSources
        ? [{ id: "source", label: "Add source with this account", icon: Plug, isDisabled: c.state !== "ACTIVE", onAction: () => openWizard({ connector: c.connector, connection: c.name }) }]
        : []),
      { id: "disconnect", label: "Disconnect", icon: Trash2, danger: true, onAction: () => void disconnect(c) },
    ];
  };

  const none = (
    <EmptyState
      icon={KeyRound}
      title="No accounts yet"
      description="An account is added the first time you add a source: sign in once, then pick what to sync."
      boxed
      actions={
        canSources ? (
          <Button variant="primary" onPress={() => openWizard()}>
            <Plus className="i" aria-hidden />
            Add source
          </Button>
        ) : undefined
      }
    />
  );

  return (
    <Gate query={connections} skeleton={<SkeletonRows rows={3} />} isEmpty={(d) => d.length === 0} empty={none}>
      {(data) => (
        <>
          {manage ? (
            <div className="toolbar">
              <div className="toolbar__end">
                <Button variant="ghost" size="sm" onPress={() => openConnectAccount()}>
                  <Plus className="i" aria-hidden />
                  Connect account
                </Button>
              </div>
            </div>
          ) : null}
          <DataTable label="Connected accounts" rows={data} columns={columns} getRowId={(c) => c.name ?? ""} rowActions={manage ? menu : undefined} actionsClassName="src-actions" />
        </>
      )}
    </Gate>
  );
}
