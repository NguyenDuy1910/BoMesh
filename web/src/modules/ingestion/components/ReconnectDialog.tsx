"use client";

import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Dialog } from "@/components/ui/Dialog";
import { FormField } from "@/components/ui/FormField";
import { Input } from "@/components/ui/Input";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { useToast } from "@/components/ui/Toast";
import { ApiError } from "@/lib/api/request";
import {
  AuthorizationCancelled,
  beginAuthorization,
  PopupBlocked,
  type PendingAuthorization,
} from "@/modules/ingestion/authorize";
import { connectionState, sourceName } from "@/modules/ingestion/connection-state";
import type { Connection, Source } from "@/modules/ingestion/integrations-api";
import { ingestionActions } from "@/modules/ingestion/queries";
import { errorMessage } from "@/lib/format";

import { AppIcon } from "./AppIcon";
import { providerOf, ProviderButton } from "./ProviderButton";
import { SignInWaiting } from "./SignInWaiting";
import type { SourcesModel } from "./SourcesScreen";

/** "Google Drive reconnected. Syncing Sales Enablement and 1 more…" */
export function reconnectedMessage(app: string, started: readonly Source[]): string {
  if (!started.length) return `${app} reconnected`;
  const rest = started.length > 1 ? ` and ${started.length - 1} more` : "";
  return `${app} reconnected. Syncing ${sourceName(started[0])}${rest}…`;
}

/** A connection that signs in with a secret typed here, rather than through a provider window. */
export function usesCredentials(connection: Connection, model: SourcesModel): boolean {
  if (typeof connection.config?.wiki_base === "string") return true;
  const capability = model.catalogue.find((entry) => entry.connector.key === connection.connector_key)?.capability;
  return capability ? !capability.authorization_available && capability.accepts_credentials : false;
}

/** Sign an account in again (`?reconnect=<connection_id>`), then resume the sources it stopped. */
export function ReconnectDialog({
  connectionId,
  model,
  onClose,
}: {
  connectionId: string | null;
  model: SourcesModel;
  onClose: () => void;
}) {
  if (!connectionId || !model.data) return null;
  const connection = model.connection(connectionId);
  if (!connection) {
    return (
      <Dialog
        footer={<Button onClick={onClose} variant="secondary">Close</Button>}
        onClose={onClose}
        open
        size="sm"
        title="Account not found"
      >
        This account was disconnected, or you can’t manage it.
      </Dialog>
    );
  }
  return <ReconnectAccount connection={connection} key={connection.id} model={model} onClose={onClose} />;
}

function ReconnectAccount({
  connection,
  model,
  onClose,
}: {
  connection: Connection;
  model: SourcesModel;
  onClose: () => void;
}) {
  const toast = useToast();
  const app = model.connectorName(connection.connector_key);
  const entry = model.catalogue.find((item) => item.connector.key === connection.connector_key);
  const provider = providerOf(connection.connector_key, entry);
  const credentials = usesCredentials(connection, model);
  const label = connection.account.label || connection.display_name;
  const users = (model.data?.sources ?? []).filter((source) => source.connection_id === connection.id);

  const [phase, setPhase] = useState<"idle" | "waiting" | "busy">("idle");
  const [error, setError] = useState<string | null>(null);
  const pending = useRef<PendingAuthorization | null>(null);
  const [email, setEmail] = useState(label.includes("@") ? label : "");
  const [token, setToken] = useState("");
  const [fieldErrors, setFieldErrors] = useState<{ email?: string; token?: string }>({});
  // A dialog that goes away while a sign-in window is open must not leave it orphaned.
  useEffect(() => () => pending.current?.cancel(), []);

  const finish = async () => {
    setPhase("busy");
    const started = await ingestionActions.resumeAfterReconnect(connection.id, model.data?.sources ?? []);
    toast.show({ message: reconnectedMessage(app, started) });
    onClose();
  };

  const signIn = () => {
    setError(null);
    let session: PendingAuthorization;
    try {
      session = beginAuthorization({
        connectorKey: connection.connector_key,
        ownerType: connection.owner_type === "workspace" ? "tenant" : "user",
        connectionId: connection.id,
      });
    } catch (cause) {
      setError(cause instanceof PopupBlocked ? cause.message : "The sign-in window could not be opened.");
      return;
    }
    pending.current = session;
    setPhase("waiting");
    session.completed.then(
      () => {
        pending.current = null;
        void finish();
      },
      (cause: unknown) => {
        pending.current = null;
        setPhase("idle");
        // Closing the window is a decision, not a failure.
        if (!(cause instanceof AuthorizationCancelled)) {
          setError(`${provider.name} didn’t confirm the sign-in. Try again, or use a different account.`);
        }
      },
    );
  };

  const verify = async () => {
    const errors = {
      email: email.trim() ? undefined : "Enter the email you use for Confluence.",
      token: token.trim() ? undefined : "Paste your API token.",
    };
    setFieldErrors(errors);
    if (errors.email || errors.token) return;
    setPhase("busy");
    setError(null);
    try {
      const result = await ingestionActions.replaceCredentials(connection.id, {
        confluence_username: email.trim(),
        confluence_access_token: token.trim(),
      });
      if (!result.valid) throw new ApiError("rejected", 409);
      await finish();
    } catch (cause) {
      setPhase("idle");
      if (cause instanceof ApiError && cause.status !== undefined && cause.status !== 403 && cause.status !== 404) {
        setFieldErrors({ token: `${app} rejected this token. Check it and try again.` });
      } else {
        setError(errorMessage(cause, "Reconnecting"));
      }
    }
  };

  const close = () => {
    if (phase === "waiting") {
      // Escape while a sign-in window is open stops waiting rather than
      // leaving that window behind with nothing listening.
      pending.current?.cancel();
      return;
    }
    if (phase !== "busy") onClose();
  };

  const footer =
    phase === "waiting" ? (
      <Button onClick={() => pending.current?.cancel()} variant="secondary">
        Cancel
      </Button>
    ) : (
      <>
        <Button disabled={phase === "busy"} onClick={onClose} variant="secondary">
          Cancel
        </Button>
        {credentials ? (
          <Button loading={phase === "busy"} onClick={() => void verify()}>
            Verify and reconnect
          </Button>
        ) : (
          <ProviderButton
            connectorKey={connection.connector_key}
            label={error ? "Try again" : undefined}
            loading={phase === "busy"}
            onClick={signIn}
            provider={provider}
          />
        )}
      </>
    );

  return (
    <Dialog busy={phase === "busy"} footer={footer} onClose={close} open size="sm" title={`Reconnect ${app}`}>
      {phase === "waiting" ? (
        <SignInWaiting
          description={`Sign in as ${label}, then come back here.`}
          onFocus={() => pending.current?.focus()}
          provider={provider.name}
        />
      ) : (
        <div className="grid grid-cols-[minmax(0,1fr)] gap-3">
          {error && <Callout tone="err">{error}</Callout>}
          <div className="flex items-center gap-3 rounded-lg border border-border-subtle px-3.5 py-2.5">
            <AppIcon connector={connection.connector_key} />
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{label}</span>
              <span className="block truncate text-meta text-text-tertiary">
                {users.length ? `Used by ${users.map(sourceName).join(", ")}` : app}
              </span>
            </span>
            <StatusBadge kind="account" value={connectionState(connection).value} />
          </div>
          {credentials ? (
            <>
              <p className="text-text-secondary">
                Enter a new API token for {connection.account.resource_label || label}. Nothing already synced was removed.
              </p>
              <FormField error={fieldErrors.email} htmlFor="reconnect-email" label="Email" required>
                <Input
                  autoComplete="username"
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="you@company.com"
                  type="email"
                  value={email}
                />
              </FormField>
              <FormField error={fieldErrors.token} htmlFor="reconnect-token" label="API token" required>
                <Input
                  autoComplete="new-password"
                  onChange={(event) => setToken(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void verify();
                  }}
                  placeholder="Paste your token"
                  type="password"
                  value={token}
                />
              </FormField>
            </>
          ) : (
            <p className="text-text-secondary">Sign in as {label} to resume syncing. Nothing already synced was removed.</p>
          )}
        </div>
      )}
    </Dialog>
  );
}
