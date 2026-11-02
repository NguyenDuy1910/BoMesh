"use client";

import { useEffect, useId, useRef, useState } from "react";

import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { ui } from "@/components/ui/design-system";
import { Drawer } from "@/components/ui/Drawer";
import { FormField } from "@/components/ui/FormField";
import { Input } from "@/components/ui/Input";
import { PreviewTag } from "@/components/ui/PreviewTag";
import { AppIcon } from "@/modules/ingestion/components/AppIcon";
import { updatePlatformConnector, type PlatformConnector } from "@/modules/platform/api";
import { formatDate } from "@/lib/format";

/** Where an operator copies the client from, by connector. */
const CONSOLE: Record<string, string> = {
  google_drive: "Google Cloud console",
  confluence: "Atlassian developer console",
};

function clientIdProblem(key: string, clientId: string, consoleName: string): string | null {
  if (!clientId) return "Enter the client ID.";
  if (key === "google_drive" && !clientId.endsWith(".apps.googleusercontent.com")) {
    return `Google client IDs end with .apps.googleusercontent.com. Copy it from the ${consoleName}.`;
  }
  if (!/^[A-Za-z0-9._-]{16,}$/.test(clientId)) return `This doesn’t look like a client ID. Copy the full value from the ${consoleName}.`;
  return null;
}

/**
 * The OAuth client every workspace uses to connect one app. The secret is
 * write-only: the drawer shows whether one is stored and offers to replace it,
 * never its value.
 */
export function ConnectorConfigureDrawer({
  connector,
  onClose,
  onSaved,
}: {
  connector: PlatformConnector | null;
  onClose: () => void;
  onSaved: (connector: PlatformConnector) => void;
}) {
  const formId = useId();
  const clientIdField = `${formId}-client-id`;
  const secretField = `${formId}-secret`;
  const [clientId, setClientId] = useState("");
  const [secret, setSecret] = useState("");
  const [replacing, setReplacing] = useState(false);
  const [touched, setTouched] = useState({ clientId: false, secret: false });
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const clientIdRef = useRef<HTMLInputElement | null>(null);
  const secretRef = useRef<HTMLInputElement | null>(null);
  const replaceRef = useRef<HTMLButtonElement | null>(null);

  const oauth = connector?.oauth_client ?? null;
  const hasSecret = Boolean(oauth?.has_secret);
  const editingSecret = replacing || !hasSecret;
  const consoleName = CONSOLE[connector?.key ?? ""] ?? "provider’s developer console";

  useEffect(() => {
    if (!connector) return;
    setClientId(connector.oauth_client?.client_id ?? "");
    setSecret("");
    setReplacing(false);
    setTouched({ clientId: false, secret: false });
    setSubmitted(false);
    setFailure(null);
  }, [connector]);

  let secretError: string | null = null;
  if (editingSecret) {
    const value = secret.trim();
    // Without a stored secret the deployment's own client may stand in, so a new one is optional there.
    const required = hasSecret || !oauth?.deployment_configured;
    if (!value && required) secretError = hasSecret ? "Paste the new client secret, or cancel replacing it." : "Paste the client secret.";
    else if (value && value.length < 16) secretError = "This secret looks too short. Copy the whole value.";
  }
  const errors = {
    clientId: connector ? clientIdProblem(connector.key, clientId.trim(), consoleName) : null,
    secret: secretError,
  };
  const visible = {
    clientId: submitted || touched.clientId ? errors.clientId : null,
    secret: submitted || touched.secret ? errors.secret : null,
  };

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!connector || busy) return;
    setSubmitted(true);
    setFailure(null);
    if (errors.clientId) return clientIdRef.current?.focus();
    if (errors.secret) return secretRef.current?.focus();
    setBusy(true);
    try {
      const updated = await updatePlatformConnector(connector.key, {
        oauth_client: { client_id: clientId.trim(), ...(editingSecret && secret.trim() ? { client_secret: secret.trim() } : {}) },
      });
      setBusy(false);
      onSaved(updated);
    } catch (cause) {
      setBusy(false);
      setFailure(cause instanceof Error ? cause.message : "The settings couldn’t be saved. Try again.");
    }
  };

  return (
    <Drawer
      busy={busy}
      description="Sign-in settings shared by every workspace."
      footer={(
        <>
          <Button disabled={busy} onClick={onClose} variant="secondary">Cancel</Button>
          <Button form={formId} loading={busy} type="submit">Save changes</Button>
        </>
      )}
      header={<div className="mt-2"><PreviewTag /></div>}
      icon={connector && <AppIcon connector={connector.key} />}
      onClose={onClose}
      open={Boolean(connector)}
      title={connector?.name ?? ""}
    >
      {connector && (
        <form className="grid gap-4" id={formId} noValidate onSubmit={save}>
          {failure && <Callout tone="err">{failure}</Callout>}
          {oauth?.deployment_configured && (
            <Callout tone="neutral">
              The deployment configuration already provides a client for {connector.name}. Fill this in only to use a different one.
            </Callout>
          )}
          <FormField error={visible.clientId} help={`Copy it from the ${consoleName}.`} htmlFor={clientIdField} label="OAuth client ID" required>
            <Input
              autoComplete="off"
              className="font-mono"
              onBlur={() => setTouched((current) => ({ ...current, clientId: true }))}
              onChange={(event) => setClientId(event.target.value)}
              ref={clientIdRef}
              spellCheck={false}
              value={clientId}
            />
          </FormField>
          {editingSecret ? (
            <FormField
              error={visible.secret}
              help={hasSecret ? "The current secret keeps working until you save." : "Stored encrypted. Nobody can read it back."}
              htmlFor={secretField}
              label="Client secret"
              required={hasSecret || !oauth?.deployment_configured}
              labelAction={hasSecret && (
                <Button
                  disabled={busy}
                  onClick={() => {
                    setReplacing(false);
                    setSecret("");
                    setTouched((current) => ({ ...current, secret: false }));
                    requestAnimationFrame(() => replaceRef.current?.focus());
                  }}
                  size="sm"
                  variant="ghost"
                >
                  Cancel replacing
                </Button>
              )}
            >
              <Input
                autoComplete="new-password"
                className="font-mono"
                onBlur={() => setTouched((current) => ({ ...current, secret: true }))}
                onChange={(event) => setSecret(event.target.value)}
                placeholder={hasSecret ? "Paste the new client secret" : "Paste the client secret"}
                ref={secretRef}
                type="password"
                value={secret}
              />
            </FormField>
          ) : (
            <div className="grid gap-1.5">
              <label className={ui.label} htmlFor={secretField}>Client secret</label>
              <div className="flex gap-2">
                <Input aria-describedby={`${secretField}-help`} className="flex-1 font-mono" id={secretField} readOnly value="••••••••••••••••" />
                <Button
                  onClick={() => {
                    setReplacing(true);
                    requestAnimationFrame(() => secretRef.current?.focus());
                  }}
                  ref={replaceRef}
                  variant="secondary"
                >
                  Replace secret
                </Button>
              </div>
              <p className={ui.helper} id={`${secretField}-help`}>Stored encrypted. It is never shown again.</p>
            </div>
          )}
          {oauth?.updated_at && (
            <p className="text-meta text-text-tertiary">
              Last changed{oauth.updated_by ? ` by ${oauth.updated_by}` : ""} on {formatDate(oauth.updated_at)}
            </p>
          )}
        </form>
      )}
    </Drawer>
  );
}
