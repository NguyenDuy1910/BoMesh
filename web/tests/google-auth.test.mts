import assert from "node:assert/strict";
import test from "node:test";

import { renderGoogleSignInButton } from "../src/modules/auth/google.ts";

test("concurrent button renders initialize Google Identity once, avoid FedCM, and use current callbacks", async (context) => {
  let credentialCallback: ((response: { credential?: string }) => void) | undefined;
  let initializedWith: { use_fedcm_for_button?: boolean } | undefined;
  let initializeCalls = 0;
  let renderCalls = 0;
  const identity = {
    initialize(options: { callback: (response: { credential?: string }) => void; use_fedcm_for_button?: boolean }) {
      initializeCalls += 1;
      initializedWith = options;
      credentialCallback = options.callback;
    },
    renderButton() {
      renderCalls += 1;
    },
  };
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { google: { accounts: { id: identity } } },
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { documentElement: { lang: "en" } },
  });
  context.after(() => {
    if (windowDescriptor) Object.defineProperty(globalThis, "window", windowDescriptor);
    else Reflect.deleteProperty(globalThis, "window");
    if (documentDescriptor) Object.defineProperty(globalThis, "document", documentDescriptor);
    else Reflect.deleteProperty(globalThis, "document");
  });

  const host = {
    replaceChildren() {},
    getBoundingClientRect: () => ({ width: 360 }),
  } as unknown as HTMLElement;
  const credentials: string[] = [];

  await Promise.all([
    renderGoogleSignInButton(host, "client-id", (credential) => credentials.push(`first:${credential}`), assert.fail),
    renderGoogleSignInButton(host, "client-id", (credential) => credentials.push(`second:${credential}`), assert.fail),
  ]);
  credentialCallback?.({ credential: "token" });

  assert.equal(initializeCalls, 1);
  assert.equal(initializedWith?.use_fedcm_for_button, undefined);
  assert.equal(renderCalls, 2);
  assert.deepEqual(credentials, ["second:token"]);
});
