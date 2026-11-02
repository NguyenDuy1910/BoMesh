"use client";

import { connectionsApi } from "@/modules/ingestion/integrations-api";
import { getApiUrl } from "@/lib/api/config";

/**
 * Authorizing an account, from the browser's side.
 *
 * The provider's consent screen runs in a popup so the workspace behind it
 * keeps its state — a half-filled resource picker survives someone signing in.
 * Nothing about the grant comes back this way: the popup returns a connection
 * id, and the token it was issued for never leaves the server.
 */

export interface AuthorizationResult {
  connectionId: string;
  connectorKey: string;
}

/**
 * A consent window that is currently open.
 *
 * The caller gets the handle, not just the promise, because a popup that has
 * slipped behind the main window looks to the reader like nothing happened —
 * and the only thing that fixes it is focusing the window they already have.
 */
export interface PendingAuthorization {
  completed: Promise<AuthorizationResult>;
  /** Bring the consent window back to the front. */
  focus: () => void;
  /** Close it and reject as cancelled. */
  cancel: () => void;
}

interface CompletionMessage {
  source?: unknown;
  status?: unknown;
  nonce?: unknown;
  connection_id?: unknown;
  connector_key?: unknown;
  message?: unknown;
}

const POPUP_FEATURES = "width=640,height=780,menubar=no,toolbar=no,location=yes";
/** How often to notice that the window was closed without finishing. */
const CLOSE_POLL_MS = 400;

export class AuthorizationCancelled extends Error {
  constructor() {
    super("The authorization window was closed before it finished.");
    this.name = "AuthorizationCancelled";
  }
}

export class PopupBlocked extends Error {
  constructor() {
    super(
      "Allow pop-ups for this site, then try connecting again. The provider's sign-in opens in a new window.",
    );
    this.name = "PopupBlocked";
  }
}

export interface AuthorizationRequest {
  connectorKey: string;
  ownerType: "tenant" | "user";
  /** Set to renew an existing connection instead of adding another. */
  connectionId?: string;
}

/**
 * Open the consent window and resolve once the provider has answered.
 *
 * The window is opened synchronously, before any request: a popup opened after
 * an `await` is no longer attributable to the click that asked for it and
 * browsers block it, so the person would press Connect and see nothing happen.
 */
export function beginAuthorization(request: AuthorizationRequest): PendingAuthorization {
  const popup = window.open("", "bomesh-authorize", POPUP_FEATURES);
  if (!popup) throw new PopupBlocked();

  let stopWatching: () => void = () => undefined;
  let cancel: () => void = () => undefined;
  const completed = new Promise<AuthorizationResult>((resolve, reject) => {
    let done = false;
    const finish = (outcome: () => void) => {
      if (done) return;
      done = true;
      stopWatching();
      outcome();
    };
    cancel = () => finish(() => reject(new AuthorizationCancelled()));

    void (async () => {
      let started: { authorization_url: string; nonce: string };
      try {
        started = await connectionsApi.startAuthorization({
          connector_key: request.connectorKey,
          owner_type: request.ownerType === "tenant" ? "workspace" : "user",
          connection_id: request.connectionId,
        });
      } catch (cause) {
        popup.close();
        finish(() => reject(cause));
        return;
      }
      if (done) return;
      if (popup.closed) {
        finish(() => reject(new AuthorizationCancelled()));
        return;
      }
      popup.location.replace(started.authorization_url);
      stopWatching = watch(popup, started.nonce, finish, resolve, reject);
    })();
  });

  return {
    completed,
    focus: () => {
      if (!popup.closed) popup.focus();
    },
    cancel: () => {
      popup.close();
      cancel();
    },
  };
}

/** Listens for the provider's answer; returns the function that stops listening. */
function watch(
  popup: Window,
  nonce: string,
  finish: (outcome: () => void) => void,
  resolve: (value: AuthorizationResult) => void,
  reject: (reason: Error) => void,
): () => void {
  const origin = new URL(getApiUrl() ?? window.location.origin).origin;

  function onMessage(event: MessageEvent) {
    // Three checks, and all three are needed: the origin proves the API sent
    // it, the marker separates it from any other postMessage traffic on the
    // page, and the nonce ties it to this authorization rather than an earlier
    // one the reader abandoned.
    if (event.origin !== origin) return;
    const payload = event.data as CompletionMessage | null;
    if (!payload || payload.source !== "bomesh.connection") return;
    if (payload.nonce !== nonce) return;

    if (payload.status === "connected" && typeof payload.connection_id === "string") {
      const connectionId = payload.connection_id;
      const connectorKey = String(payload.connector_key ?? "");
      finish(() => resolve({ connectionId, connectorKey }));
      return;
    }
    const message = typeof payload.message === "string"
      ? payload.message
      : "The provider did not complete the authorization.";
    finish(() => reject(new Error(message)));
  }

  const closeTimer = window.setInterval(() => {
    if (popup.closed) finish(() => reject(new AuthorizationCancelled()));
  }, CLOSE_POLL_MS);

  window.addEventListener("message", onMessage);
  return () => {
    window.removeEventListener("message", onMessage);
    window.clearInterval(closeTimer);
  };
}
