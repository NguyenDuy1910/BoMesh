interface GoogleCredentialResponse {
  credential?: string;
}

interface GoogleIdentityApi {
  initialize(options: {
    client_id: string;
    callback: (response: GoogleCredentialResponse) => void;
    auto_select: boolean;
    cancel_on_tap_outside: boolean;
  }): void;
  renderButton(
    parent: HTMLElement,
    options: {
      type: "standard";
      theme: "outline";
      size: "large";
      text: "continue_with";
      shape: "rectangular";
      logo_alignment: "left";
      width: number;
      locale: string;
    },
  ): void;
}

declare global {
  interface Window {
    google?: { accounts?: { id?: GoogleIdentityApi } };
  }
}

const scriptId = "google-identity-services";

interface GoogleCallbacks {
  onCredential: (credential: string) => void;
  onError: (message: string) => void;
}

let initialization: { clientId: string; promise: Promise<GoogleIdentityApi> } | null = null;
let currentCallbacks: GoogleCallbacks | null = null;

/** Render Google's supported button while sharing its page-global client.
 * React Strict Mode and route remounts may render more than once, but GIS must
 * be initialized once. The default popup UX avoids requiring optional FedCM. */
export async function renderGoogleSignInButton(
  host: HTMLElement,
  clientId: string,
  onCredential: (credential: string) => void,
  onError: (message: string) => void,
): Promise<void> {
  const identity = await initializeGoogleIdentity(clientId);
  currentCallbacks = { onCredential, onError };
  host.replaceChildren();
  identity.renderButton(host, {
    type: "standard",
    theme: "outline",
    size: "large",
    text: "continue_with",
    shape: "rectangular",
    logo_alignment: "left",
    width: Math.min(400, Math.max(240, Math.floor(host.getBoundingClientRect().width))),
    // The product is written in English; Google would otherwise follow the browser.
    locale: document.documentElement.lang || "en",
  });
}

async function initializeGoogleIdentity(clientId: string): Promise<GoogleIdentityApi> {
  if (initialization) {
    if (initialization.clientId !== clientId) {
      throw new Error("Google Identity cannot use multiple client IDs on the same page.");
    }
    return initialization.promise;
  }

  const promise = loadGoogleIdentity()
    .then((identity) => {
      identity.initialize({
        client_id: clientId,
        auto_select: false,
        cancel_on_tap_outside: true,
        callback: (response) => {
          if (response.credential) {
            currentCallbacks?.onCredential(response.credential);
            return;
          }
          currentCallbacks?.onError("Google did not return a sign-in credential. Please try again.");
        },
      });
      return identity;
    })
    .catch((error: unknown) => {
      if (initialization?.promise === promise) initialization = null;
      throw error;
    });
  initialization = { clientId, promise };
  return promise;
}

async function loadGoogleIdentity(): Promise<GoogleIdentityApi> {
  const current = window.google?.accounts?.id;
  if (current) return current;
  await new Promise<void>((resolve, reject) => {
    const existing = document.getElementById(scriptId) as HTMLScriptElement | null;
    if (existing) {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error("Google sign-in could not be loaded.")), { once: true });
      return;
    }
    const script = document.createElement("script");
    script.id = scriptId;
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Google sign-in could not be loaded."));
    document.head.append(script);
  });
  const identity = window.google?.accounts?.id;
  if (!identity) throw new Error("Google sign-in is unavailable in this browser.");
  return identity;
}
