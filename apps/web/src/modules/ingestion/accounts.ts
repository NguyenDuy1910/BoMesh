"use client";

import { ApiError } from "@/lib/api/client";

import { createConnection, deleteConnection, reauthorizeConnection, testConnection, type Connection } from "./api";
import { confluenceSite, type ConfluenceInput } from "./connect-form";
import { AuthorizationCancelled, authorizeInPopup, type PendingAuthorization } from "./oauth";

/**
 * Connecting accounts (preview `X.acc`): OAuth sign-in in a popup for a new or
 * expired account, and Confluence with an API token, verified with `:test`.
 * A connection that never finished signing in is deleted, so nothing
 * half-made is left behind. Tokens are sent once and never read back.
 */

/** A token the provider refused. */
export class TokenRejected extends Error {
  constructor(message = "Confluence rejected this token. Check it and try again.") {
    super(message);
    this.name = "TokenRejected";
  }
}

/** New workspace-owned connection through the provider's sign-in. */
export function signInNew(workspace: string, connector: string): PendingAuthorization {
  let created: Connection | null = null;
  const pending = authorizeInPopup(workspace, async () => {
    // The server names it ("Google Drive", "Google Drive (2)"): display names stay taken after a delete.
    created = await createConnection(workspace, { connector });
    return created;
  });
  const cleanup = () => {
    if (created?.name) void deleteConnection(workspace, created.name).catch(() => undefined);
  };
  return {
    done: pending.done.catch((error: unknown) => {
      cleanup();
      throw error;
    }),
    cancel: pending.cancel,
  };
}

/** Sign in again to an existing connection. */
export function signInAgain(workspace: string, connection: Connection): PendingAuthorization {
  return authorizeInPopup(workspace, () => reauthorizeConnection(workspace, connection.name ?? ""));
}

/** Confluence with an API token: created ACTIVE, then tested; a refused token removes it. */
export async function connectConfluence(workspace: string, input: ConfluenceInput): Promise<Connection> {
  const site = confluenceSite(input.site);
  if (!site) throw new TokenRejected("Use just the site name, like “northwind”.");
  const body = {
    connector: "connectors/confluence",
    displayName: site.host,
    apiToken: input.token.trim(),
    config: { wiki_base: site.wikiBase, username: input.email.trim() },
  };
  // Names of deleted connections stay taken: a site connected before gets a server-made name instead.
  const connection = await createConnection(workspace, body).catch((error: unknown) => {
    if (error instanceof ApiError && error.status === 409) return createConnection(workspace, { ...body, displayName: undefined });
    throw error;
  });
  let ok = false;
  let message = "";
  try {
    const result = await testConnection(workspace, connection.name ?? "");
    ok = !!result.ok;
    message = result.message ?? "";
  } catch (error) {
    message = error instanceof ApiError ? error.message : "";
  }
  if (ok) return connection;
  await deleteConnection(workspace, connection.name ?? "").catch(() => undefined);
  throw new TokenRejected(message ? `Confluence rejected this token. ${message}` : undefined);
}

export const isCancelled = (error: unknown) => error instanceof AuthorizationCancelled;
