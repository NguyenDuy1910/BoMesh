"use client";

import { getApiUrl } from "@/lib/api/config";

import { getConnection, type Connection } from "./api";

/**
 * Signing an account in, from the browser's side (api_design.md §6).
 *
 * The provider's consent screen runs in a popup so the wizard behind it keeps
 * its state. The popup is opened before any request (a popup opened after an
 * `await` is blocked), then pointed at the connection's `authorizationUri`.
 * Completion arrives two ways and the first wins: the OAuth callback page posts
 * `{source: "bomesh.connection", status, connection}` from the API origin, and
 * the connection is polled until it leaves AUTHORIZING. No token ever reaches
 * the browser.
 */

export class AuthorizationCancelled extends Error {
  constructor() {
    super("The sign-in window was closed before it finished.");
    this.name = "AuthorizationCancelled";
  }
}

export class PopupBlocked extends Error {
  constructor() {
    super("Allow pop-ups for this site, then try again. The sign-in opens in a new window.");
    this.name = "PopupBlocked";
  }
}

export interface PendingAuthorization {
  /** The connection once ACTIVE. Rejects with AuthorizationCancelled, or the provider's error. */
  done: Promise<Connection>;
  /** Close the window and stop waiting. */
  cancel: () => void;
}

interface CallbackMessage {
  source?: unknown;
  status?: unknown;
  connection?: unknown;
  message?: unknown;
}

const POPUP_FEATURES = "width=560,height=720,menubar=no,toolbar=no,location=yes";
const POLL_MS = 2000;

/**
 * Opens the consent window, then `start()` creates or reauthorizes the
 * connection (returning it with an `authorizationUri`).
 */
export function authorizeInPopup(workspace: string, start: () => Promise<Connection>): PendingAuthorization {
  const popup = window.open("", "bomesh-authorize", POPUP_FEATURES);
  if (!popup) throw new PopupBlocked();
  const origin = new URL(getApiUrl() ?? window.location.origin).origin;

  let finish: (outcome: () => void) => void = () => undefined;
  let fail: (error: Error) => void = () => undefined;
  const done = new Promise<Connection>((resolve, reject) => {
    let settled = false;
    let name = "";
    let poll = 0;
    const stop = () => {
      window.removeEventListener("message", onMessage);
      window.clearInterval(poll);
    };
    finish = (outcome) => {
      if (settled) return;
      settled = true;
      stop();
      outcome();
    };
    fail = (error) => finish(() => reject(error));
    const succeed = (connection: Connection) => {
      if (!popup.closed) popup.close();
      finish(() => resolve(connection));
    };

    // `popup.closed` is not evidence of a cancel: providers' sign-in pages send
    // Cross-Origin-Opener-Policy, which severs the popup and reports it closed
    // while the user is still signing in. Only Cancel stops the wait.
    async function check() {
      if (!name || settled) return;
      try {
        const connection = await getConnection(workspace, name);
        if (connection.state === "ACTIVE") succeed(connection);
        else if (connection.state === "FAILED") fail(new Error("The provider didn’t confirm the sign-in."));
      } catch {
        // Transient: the next poll tries again.
      }
    }

    function onMessage(event: MessageEvent) {
      if (event.origin !== origin) return;
      const data = event.data as CallbackMessage | null;
      if (!data || data.source !== "bomesh.connection") return;
      if (data.status === "connected" && typeof data.connection === "string") {
        getConnection(workspace, data.connection).then(succeed, (error: unknown) => fail(error instanceof Error ? error : new Error(String(error))));
      } else {
        fail(new Error(typeof data.message === "string" && data.message ? data.message : "The provider didn’t confirm the sign-in."));
      }
    }

    window.addEventListener("message", onMessage);
    poll = window.setInterval(() => void check(), POLL_MS);

    start().then(
      (connection) => {
        if (settled) return;
        name = connection.name ?? "";
        if (connection.state === "ACTIVE") return succeed(connection);
        if (!connection.authorizationUri) return fail(new Error("The provider didn’t return a sign-in address."));
        // Still blank and same-origin here, so `closed` is a real close.
        if (popup.closed) return fail(new AuthorizationCancelled());
        popup.location.replace(connection.authorizationUri);
      },
      (error: unknown) => {
        popup.close();
        fail(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });

  return {
    done,
    cancel: () => {
      if (!popup.closed) popup.close();
      fail(new AuthorizationCancelled());
    },
  };
}
