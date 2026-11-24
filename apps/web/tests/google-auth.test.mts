import assert from "node:assert/strict";
import test from "node:test";

import { renderGoogleSignInButton } from "../src/modules/auth/google.ts";

test("concurrent button renders initialize Google Identity once, avoid FedCM, render in Vietnamese, and use current callbacks", async (context) => {
  let credentialCallback: ((response: { credential?: string }) => void) | undefined;
  let initializedWith: { use_fedcm_for_button?: boolean } | undefined;
  let initializeCalls = 0;
  let renderCalls = 0;
  const locales: (string | undefined)[] = [];
  const identity = {
    initialize(options: { callback: (response: { credential?: string }) => void; use_fedcm_for_button?: boolean }) {
      initializeCalls += 1;
      initializedWith = options;
      credentialCallback = options.callback;
    },
    renderButton(_host: HTMLElement, options: { locale?: string }) {
      renderCalls += 1;
      locales.push(options.locale);
    },
  };
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { google: { accounts: { id: identity } } },
  });
  context.after(() => {
    if (windowDescriptor) Object.defineProperty(globalThis, "window", windowDescriptor);
    else Reflect.deleteProperty(globalThis, "window");
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
  assert.deepEqual(locales, ["vi", "vi"]);
  assert.deepEqual(credentials, ["second:token"]);
});
