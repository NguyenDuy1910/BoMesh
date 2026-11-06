"use client";

import { Button, Description, Input, Label, Modal, TextField } from "@heroui/react";
import { useQuery } from "@tanstack/react-query";
import { Plug } from "lucide-react";
import { useState } from "react";

import { PageChrome } from "@/components/shell/page-chrome";
import {
  AppIcon,
  confirm,
  EmptyState,
  ErrorState,
  Gate,
  KeyValue,
  List,
  ListItem,
  Page,
  PageHeader,
  PreviewChip,
  SkeletonCards,
  SkeletonRows,
  StatusChip,
  SwitchRow,
  toast,
  WorkspaceMark,
} from "@/components/ui";
import { errorMessage } from "@/lib/api/client";
import { fmtDate, plural } from "@/lib/format";

import { disableConnector, enableConnector, listConnectorRequests, updateConnectorOauth, type Connector } from "../api";
import { AUTH_LABEL, connectorApp, connectorStatus, lastSegment } from "../model";
import { pk, useConnectors, useInvalidatePlatform, useIsPlatformAdmin, usePlatformWorkspaces } from "../queries";
import { PlatformDrawer, PREVIEW_TIP, useUrlState } from "./shared";

/** Enable / disable with the preview's confirm and Undo. */
function useConnectorToggle() {
  const invalidate = useInvalidatePlatform();
  const set = async (c: Connector, on: boolean, { undo = true } = {}) => {
    try {
      const updated = await (on ? enableConnector(c) : disableConnector(c));
      await invalidate(pk.connectors);
      toast(
        on ? `${c.displayName} is available to workspaces` : `Turned off ${c.displayName}`,
        undo ? { undo: () => void set(updated, !on, { undo: false }) } : {},
      );
    } catch (error) {
      toast(errorMessage(error), { tone: "danger" });
    }
  };
  const toggle = async (c: Connector) => {
    if (c.state !== "ACTIVE") return set(c, true);
    const ok = await confirm({
      title: `Turn off ${c.displayName}?`,
      description: `${plural(c.workspaceCount ?? 0, "workspace")} will stop syncing from it. Their documents stay searchable.`,
      confirmLabel: "Turn off",
      tone: "danger",
    });
    if (ok) await set(c, false, { undo: false });
  };
  return { set, toggle };
}

/** Shared OAuth client: client ID and a write-only secret. */
function OauthClientForm({ connector }: { connector: Connector }) {
  const invalidate = useInvalidatePlatform();
  const [clientId, setClientId] = useState(connector.oauthClient?.clientId ?? "");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const dirty = clientId.trim() !== (connector.oauthClient?.clientId ?? "") || secret.trim() !== "";
  const save = async () => {
    if (!clientId.trim()) {
      toast("Enter the client ID.", { tone: "danger" });
      return;
    }
    setBusy(true);
    try {
      await updateConnectorOauth(connector, clientId, secret);
      await invalidate(pk.connectors);
      setSecret("");
      toast(`Saved ${connector.displayName} sign-in settings`);
    } catch (error) {
      toast(errorMessage(error), { tone: "danger" });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="stack gap-16">
      <TextField fullWidth value={clientId} onChange={setClientId}>
        <Label>Client ID</Label>
        <Input className="mono" spellCheck={false} autoComplete="off" />
      </TextField>
      <TextField fullWidth value={secret} onChange={setSecret} type="password">
        <Label>Client secret</Label>
        <Input autoComplete="new-password" placeholder={connector.oauthClient?.secretConfigured ? "••••••••" : ""} />
        <Description>{connector.oauthClient?.secretConfigured ? "Stored encrypted. Leave empty to keep the current one." : "Required before workspaces can connect it."}</Description>
      </TextField>
      {dirty ? (
        <div className="row gap-8">
          <Button variant="primary" size="sm" isPending={busy} onPress={() => void save()}>
            Save sign-in settings
          </Button>
          <Button
            variant="ghost"
            size="sm"
            isDisabled={busy}
            onPress={() => {
              setClientId(connector.oauthClient?.clientId ?? "");
              setSecret("");
            }}
          >
            Discard
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** Preview `DR['pf-con']`: status, sign-in method, usage, availability switch (+ OAuth client). */
function ConnectorDrawer({ connectorId, connectors, onClose }: { connectorId: string | null; connectors: readonly Connector[] | undefined; onClose: () => void }) {
  const isAdmin = useIsPlatformAdmin();
  const { toggle } = useConnectorToggle();
  if (!connectorId) return <PlatformDrawer isOpen={false} onClose={onClose} title="">{null}</PlatformDrawer>;
  const c = connectors?.find((x) => lastSegment(x.name) === connectorId);
  if (!c) {
    return (
      <PlatformDrawer isOpen onClose={onClose} title={connectors ? "Connector not found" : "Loading connector"}>
        {connectors ? null : <SkeletonRows rows={3} />}
      </PlatformDrawer>
    );
  }
  const on = c.state === "ACTIVE";
  return (
    <PlatformDrawer
      isOpen
      onClose={onClose}
      lead={<AppIcon app={connectorApp(c.name)} size="lg" />}
      title={c.displayName}
      description={c.description}
      footer={
        <Button variant="tertiary" onPress={onClose}>
          Done
        </Button>
      }
    >
      <div className="drawer__section">
        <KeyValue
          pairs={[
            ["Status", <StatusChip key="s" kind="connector" value={connectorStatus(c.state)} />],
            ["Sign-in method", c.authenticationType ? AUTH_LABEL[c.authenticationType] : "—"],
            ["Used by", plural(c.workspaceCount ?? 0, "workspace")],
            c.authenticationType === "OAUTH" && ["Client secret", c.oauthClient?.secretConfigured ? "Stored" : "Not set"],
          ]}
        />
      </div>
      {isAdmin && c.state !== "UNSUPPORTED" ? (
        <div className="drawer__section">
          <SwitchRow
            title="Available to workspaces"
            description={on ? "Workspace admins can connect it as a source." : "Workspaces can’t connect it. Existing documents stay searchable."}
            isSelected={on}
            onChange={() => void toggle(c)}
          />
        </div>
      ) : null}
      {isAdmin && c.authenticationType === "OAUTH" && c.state !== "UNSUPPORTED" ? (
        <div className="drawer__section">
          <h3 className="drawer__section-title">Sign-in client</h3>
          <OauthClientForm key={c.etag} connector={c} />
        </div>
      ) : null}
    </PlatformDrawer>
  );
}

/** Preview `M['pf-con-demand']`: workspaces that asked for an unavailable connector. */
function DemandDialog({ connector, onClose }: { connector: Connector | null; onClose: () => void }) {
  const workspaces = usePlatformWorkspaces();
  const requests = useQuery({
    queryKey: ["platform", "connector-requests", connector?.name],
    queryFn: () => listConnectorRequests(connector as Connector, workspaces.data ?? []),
    enabled: Boolean(connector && workspaces.data),
  });
  const byId = new Map((workspaces.data ?? []).map((w) => [lastSegment(w.name), w]));
  const count = connector?.requestCount ?? 0;
  return (
    <Modal.Backdrop isOpen={Boolean(connector)} onOpenChange={(open) => !open && onClose()}>
      <Modal.Container size="md" scroll="inside">
        <Modal.Dialog>
          <Modal.CloseTrigger aria-label="Close" />
          <Modal.Header>
            <Modal.Heading>{connector?.displayName} requests</Modal.Heading>
            <p className="modal__description">{plural(count, "workspace")} asked for this connector.</p>
          </Modal.Header>
          <Modal.Body>
            {requests.isError ? (
              <ErrorState error={requests.error} onRetry={requests.refetch} compact />
            ) : !requests.data ? (
              <SkeletonRows rows={3} />
            ) : requests.data.length ? (
              <List>
                {requests.data.map(({ workspaceId, request }) => {
                  const w = byId.get(workspaceId);
                  return (
                    <ListItem
                      key={request.name}
                      lead={<WorkspaceMark name={w?.displayName ?? "?"} size={28} />}
                      title={<span translate="no">{w?.displayName ?? "Removed workspace"}</span>}
                      description={request.title || "Asked for this connector"}
                      meta={fmtDate(request.createTime)}
                    />
                  );
                })}
              </List>
            ) : (
              <EmptyState
                icon={Plug}
                title={count ? "These requests aren’t readable here" : "No requests yet"}
                description={count ? "They were filed in workspaces whose Requests module is off." : undefined}
                compact
              />
            )}
          </Modal.Body>
          <Modal.Footer>
            <Button slot="close" variant="primary">
              Done
            </Button>
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}

/** Preview `P.pConnectors`: one card per connector, one action per card. */
export function ConnectorsPage() {
  const url = useUrlState();
  const isAdmin = useIsPlatformAdmin();
  const connectors = useConnectors();
  const workspaces = usePlatformWorkspaces();
  const { set } = useConnectorToggle();
  const [demand, setDemand] = useState<Connector | null>(null);

  const open = (c: Connector) => url.set({ open: lastSegment(c.name) });

  const card = (c: Connector) => {
    const status = connectorStatus(c.state);
    const needsSecret = c.authenticationType === "OAUTH" && !c.oauthClient?.secretConfigured;
    const meta =
      status === "unavailable" ? (
        <button type="button" className="link-button t-sm" onClick={() => setDemand(c)}>
          Requested by {plural(c.requestCount ?? 0, "workspace")}
        </button>
      ) : (
        <span className="t-sm muted">{status === "disabled" ? "Workspaces can’t connect it" : `Used by ${plural(c.workspaceCount ?? 0, "workspace")}`}</span>
      );
    const action =
      status === "enabled" || (status === "disabled" && (needsSecret || !isAdmin)) ? (
        <Button size="sm" variant="tertiary" onPress={() => open(c)}>
          {isAdmin ? "Configure" : "View"}
        </Button>
      ) : status === "disabled" ? (
        <Button size="sm" variant="secondary" onPress={() => void set(c, true)}>
          Enable
        </Button>
      ) : null;
    return (
      <div key={c.name} className="card pf-con">
        <div className="row gap-12">
          <AppIcon app={connectorApp(c.name)} size="lg" />
          <div className="stack gap-4 grow">
            <span className="card__title truncate">{c.displayName}</span>
            <span>
              <StatusChip kind="connector" value={status} />
            </span>
          </div>
        </div>
        <div className="pf-con__foot">
          {meta}
          {action}
        </div>
      </div>
    );
  };

  return (
    <Page>
      <PageChrome crumbs={[{ label: "Connectors" }]} />
      <PageHeader title="Connectors" description="Apps that workspaces can connect." chips={<PreviewChip tooltip={PREVIEW_TIP} />} />
      <Gate
        query={connectors}
        skeleton={<SkeletonCards cards={6} />}
        isEmpty={(data) => data.length === 0}
        empty={<EmptyState icon={Plug} title="No connectors installed" description="Connectors appear once they’re part of this deployment." boxed />}
      >
        {(all) => (
          <div className="grid cols-3">
            <div className="card pf-con">
              <div className="row gap-12">
                <AppIcon app="upload" size="lg" />
                <div className="stack gap-4 grow">
                  <span className="card__title truncate">File upload</span>
                  <span>
                    <StatusChip kind="connector" value="builtin" />
                  </span>
                </div>
              </div>
              <div className="pf-con__foot">
                <span className="t-sm muted">{workspaces.data ? `Used by ${plural(workspaces.data.length, "workspace")}` : "Always available"}</span>
              </div>
            </div>
            {all.map(card)}
          </div>
        )}
      </Gate>
      <ConnectorDrawer connectorId={url.get("open") || null} connectors={connectors.data} onClose={() => url.set({ open: null })} />
      <DemandDialog connector={demand} onClose={() => setDemand(null)} />
    </Page>
  );
}
