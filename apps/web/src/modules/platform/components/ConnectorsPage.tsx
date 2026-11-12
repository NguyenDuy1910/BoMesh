"use client";

import { Button, Description, FieldError, Input, Label, Modal, TextField } from "@heroui/react";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, Plug } from "lucide-react";
import { useState, type ReactNode } from "react";

import {
  AppIcon,
  appOf,
  EmptyState,
  ErrorState,
  Gate,
  KeyValue,
  List,
  ListItem,
  Page,
  PageHeader,
  PreviewChip,
  Section,
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
import { WorkspaceDrawer } from "./WorkspaceDrawer";

/** The built-in upload "connector": every workspace has it; it isn't in the connector catalog. */
const UPLOAD = "upload";

/** On/off is reversible (documents stay searchable): at once, with Undo (preview `setConnector`). */
function useConnectorToggle() {
  const invalidate = useInvalidatePlatform();
  return async (c: Connector) => {
    const on = c.state !== "ACTIVE";
    try {
      const updated = await (on ? enableConnector(c) : disableConnector(c));
      await invalidate(pk.connectors);
      toast(on ? `${c.displayName} is available to workspaces` : `Turned off ${c.displayName}. Workspaces stop syncing from it.`, {
        undo: () =>
          void (on ? disableConnector(updated) : enableConnector(updated))
            .then(() => invalidate(pk.connectors))
            .catch((error: unknown) => toast(errorMessage(error), { tone: "danger" })),
      });
    } catch (error) {
      toast(errorMessage(error), { tone: "danger" });
    }
  };
}

/** Shared OAuth client: client ID and a write-only secret. */
function OauthClientForm({ connector }: { connector: Connector }) {
  const invalidate = useInvalidatePlatform();
  const [clientId, setClientId] = useState(connector.oauthClient?.clientId ?? "");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [idError, setIdError] = useState<string>();
  const dirty = clientId.trim() !== (connector.oauthClient?.clientId ?? "") || secret.trim() !== "";
  const save = async () => {
    if (!clientId.trim()) {
      setIdError("Enter the client ID.");
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
      <TextField
        fullWidth
        value={clientId}
        onChange={(v) => {
          setClientId(v);
          setIdError(undefined);
        }}
        isInvalid={Boolean(idError)}
      >
        <Label>Client ID</Label>
        <Input className="mono" spellCheck={false} autoComplete="off" />
        <FieldError>{idError}</FieldError>
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
              setIdError(undefined);
            }}
          >
            Discard
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** Preview `DR['pf-con']`: status, sign-in method, usage and the "Available to workspaces" switch (+ OAuth client). */
function ConnectorDrawer({ connectorId, connectors, onClose }: { connectorId: string | null; connectors: readonly Connector[] | undefined; onClose: () => void }) {
  const isAdmin = useIsPlatformAdmin();
  const toggle = useConnectorToggle();
  if (!connectorId) return <PlatformDrawer isOpen={false} onClose={onClose} title="">{null}</PlatformDrawer>;

  if (connectorId === UPLOAD) {
    return (
      <PlatformDrawer isOpen onClose={onClose} lead={<AppIcon app="upload" size="lg" />} title="File upload" description="PDF, Office, text and ZIP files uploaded directly.">
        <div className="drawer__section">
          <KeyValue pairs={[["Status", <StatusChip key="s" kind="connector" value="builtin" />]]} />
        </div>
        <div className="drawer__section">
          <SwitchRow title="Available to workspaces" description="Built in. Every workspace can upload files, so it can’t be turned off." isSelected isDisabled onChange={() => undefined} />
        </div>
      </PlatformDrawer>
    );
  }

  const c = connectors?.find((x) => lastSegment(x.name) === connectorId);
  if (!c) {
    return (
      <PlatformDrawer isOpen onClose={onClose} title={connectors ? "Connector not found" : "Loading connector"}>
        {connectors ? null : <SkeletonRows rows={3} />}
      </PlatformDrawer>
    );
  }
  const on = c.state === "ACTIVE";
  const used = plural(c.workspaceCount ?? 0, "workspace");
  return (
    <PlatformDrawer isOpen onClose={onClose} lead={<AppIcon app={connectorApp(c.name)} size="lg" />} title={c.displayName} description={c.description}>
      <div className="drawer__section">
        <KeyValue
          pairs={[
            ["Status", <StatusChip key="s" kind="connector" value={connectorStatus(c.state)} />],
            c.authenticationType && c.authenticationType !== "NONE" && ["Sign-in method", AUTH_LABEL[c.authenticationType]],
            ["Used by", used],
          ]}
        />
      </div>
      <div className="drawer__section">
        <SwitchRow
          title="Available to workspaces"
          description={on ? "Workspace admins can connect it as a source." : `Workspaces can’t connect it. ${used} stopped syncing; their documents stay searchable.`}
          isSelected={on}
          isDisabled={!isAdmin}
          onChange={() => void toggle(c)}
        />
      </div>
      {isAdmin && c.authenticationType === "OAUTH" ? (
        <div className="drawer__section">
          <h3 className="drawer__section-title">Sign-in client</h3>
          <OauthClientForm key={c.etag} connector={c} />
        </div>
      ) : null}
    </PlatformDrawer>
  );
}

/** Preview `M['pf-con-demand']`: workspaces that asked for a connector this deployment doesn't have. */
function DemandDialog({ connector, onClose, onOpenWorkspace }: { connector: Connector | null; onClose: () => void; onOpenWorkspace: (id: string) => void }) {
  const workspaces = usePlatformWorkspaces();
  const requests = useQuery({
    queryKey: ["platform", "connector-requests", connector?.name],
    queryFn: () => listConnectorRequests(connector as Connector, workspaces.data ?? []),
    enabled: Boolean(connector && workspaces.data),
  });
  const byId = new Map((workspaces.data ?? []).map((w) => [lastSegment(w.name), w]));
  const count = requests.data?.length ?? connector?.requestCount ?? 0;
  return (
    <Modal.Backdrop isOpen={Boolean(connector)} onOpenChange={(open) => !open && onClose()}>
      <Modal.Container size="md" scroll="inside">
        <Modal.Dialog>
          <Modal.CloseTrigger aria-label="Close" />
          <Modal.Header>
            <div className="row gap-12">
              <Modal.Icon className="modal__icon--default" aria-hidden>
                {appOf(connectorApp(connector?.name))?.glyph(20) ?? <Plug className="i" />}
              </Modal.Icon>
              <div className="grow">
                <Modal.Heading>{connector?.displayName} requests</Modal.Heading>
                <p className="modal__description">{`${plural(count, "workspace")} asked for this connector. It isn’t on this deployment yet.`}</p>
              </div>
            </div>
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
                      label={w?.displayName}
                      description={request.title || "Asked for this connector"}
                      meta={fmtDate(request.createTime)}
                      actions={w ? <ChevronRight className="i i-sm muted" aria-hidden /> : undefined}
                      onPress={w ? () => onOpenWorkspace(workspaceId) : undefined}
                    />
                  );
                })}
              </List>
            ) : (
              <EmptyState icon={Plug} title="No requests yet" description="Workspaces that ask for it appear here." compact />
            )}
          </Modal.Body>
          <Modal.Footer>
            <span className="modal__footer-start t-xs muted">Connectors are added in the deployment configuration.</span>
            <Button slot="close" variant="primary">
              Done
            </Button>
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}

/** One card pattern for every connector: the whole card opens its drawer (or, for requested ones, who asked). */
function ConnectorCard({ app, name, status, foot, onPress }: { app: string; name: ReactNode; status: ReactNode; foot: string; onPress: () => void }) {
  return (
    <button type="button" className="card card--action pf-con" onClick={onPress}>
      <span className="row gap-12 pf-con__head">
        <AppIcon app={app} size="lg" />
        <span className="stack gap-4 grow">
          <span className="card__title truncate">{name}</span>
          <span className="pf-con__sub">{status}</span>
        </span>
        <ChevronRight className="i pf-con__chev" aria-hidden />
      </span>
      <span className="pf-con__foot t-sm muted">{foot}</span>
    </button>
  );
}

/** Preview `P.pConnectors`: available connectors (incl. built-in upload), then the requested ones. */
export function ConnectorsPage() {
  const url = useUrlState();
  const connectors = useConnectors();
  const [demand, setDemand] = useState<Connector | null>(null);

  return (
    <Page>
      <PageHeader title="Connectors" chips={<PreviewChip tooltip={PREVIEW_TIP} />} />
      <Gate
        query={connectors}
        skeleton={<SkeletonCards cards={6} />}
        isEmpty={(data) => data.length === 0}
        empty={<EmptyState icon={Plug} title="No connectors installed" description="Connectors appear once they’re part of this deployment." boxed />}
      >
        {(all) => {
          const available = all.filter((c) => c.state !== "UNSUPPORTED");
          const asked = all.filter((c) => c.state === "UNSUPPORTED").sort((a, b) => (b.requestCount ?? 0) - (a.requestCount ?? 0));
          return (
            <>
              <Section title="Available to workspaces" description="Workspace admins can connect these as sources. Open one to turn it on or off.">
                <div className="grid cols-3">
                  <ConnectorCard app="upload" name="File upload" status={<StatusChip kind="connector" value="builtin" />} foot="Always on" onPress={() => url.set({ open: UPLOAD })} />
                  {available.map((c) => (
                    <ConnectorCard
                      key={c.name}
                      app={connectorApp(c.name)}
                      name={c.displayName}
                      status={<StatusChip kind="connector" value={connectorStatus(c.state)} />}
                      foot={c.state === "DISABLED" ? "Workspaces can’t connect it" : `Used by ${plural(c.workspaceCount ?? 0, "workspace")}`}
                      onPress={() => url.set({ open: lastSegment(c.name) })}
                    />
                  ))}
                </div>
              </Section>
              {asked.length ? (
                <Section title="Requested" description="Not on this deployment yet. Open one to see who asked.">
                  <div className="grid cols-3">
                    {asked.map((c) => (
                      <ConnectorCard
                        key={c.name}
                        app={connectorApp(c.name)}
                        name={c.displayName}
                        status={<StatusChip kind="connector" value="unavailable" />}
                        foot={`Requested by ${plural(c.requestCount ?? 0, "workspace")}`}
                        onPress={() => setDemand(c)}
                      />
                    ))}
                  </div>
                </Section>
              ) : null}
            </>
          );
        }}
      </Gate>
      <ConnectorDrawer connectorId={url.get("open") || null} connectors={connectors.data} onClose={() => url.set({ open: null })} />
      <DemandDialog
        connector={demand}
        onClose={() => setDemand(null)}
        onOpenWorkspace={(id) => {
          setDemand(null);
          url.set({ workspace: id });
        }}
      />
      <WorkspaceDrawer workspaceId={url.get("workspace") || null} onClose={() => url.set({ workspace: null })} />
    </Page>
  );
}
