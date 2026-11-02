"use client";

import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import { renderGoogleSignInButton } from "@/modules/auth/google";

const clientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID?.trim() || null;

/** Whether this build can offer Google sign-in at all. */
export const googleSignInAvailable = Boolean(clientId);

/** Placeholder glyph in the text colour; Google's rendered button carries the brand colours. */
function GoogleGlyph() {
  return (
    <svg aria-hidden="true" fill="currentColor" height="18" viewBox="0 0 24 24" width="18">
      <path d="M12 10.2v3.9h5.5c-.2 1.3-1.6 3.9-5.5 3.9-3.3 0-6-2.7-6-6.1s2.7-6.1 6-6.1c1.9 0 3.1.8 3.8 1.5l2.6-2.5C16.8 3.3 14.6 2.3 12 2.3 6.6 2.3 2.3 6.6 2.3 12s4.3 9.7 9.7 9.7c5.6 0 9.3-3.9 9.3-9.5 0-.6-.1-1.1-.2-1.6H12z" />
    </svg>
  );
}

/**
 * Google's own button (Identity Services renders it, which FedCM requires for
 * user activation) inside a placeholder of the same size. The placeholder shows
 * while the script loads, when it cannot load, and with a spinner while the
 * credential is exchanged for a session.
 */
export function GoogleSignInButton({
  busy,
  disabled,
  onCredential,
  onError,
}: {
  busy: boolean;
  disabled: boolean;
  onCredential: (credential: string) => void;
  onError: (message: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  const callbacks = useRef({ onCredential, onError });
  callbacks.current = { onCredential, onError };

  useEffect(() => {
    const element = host.current;
    if (!clientId || !element) return;
    let mounted = true;
    renderGoogleSignInButton(
      element,
      clientId,
      (credential) => mounted && callbacks.current.onCredential(credential),
      (message) => mounted && callbacks.current.onError(message),
    )
      .then(() => mounted && setState("ready"))
      .catch(() => mounted && setState("failed"));
    return () => {
      mounted = false;
    };
  }, []);

  const showPlaceholder = state !== "ready" || busy;
  return (
    <div>
      <div className="relative min-h-(--control-lg)">
        <div
          aria-hidden={showPlaceholder || undefined}
          className={cn(
            "flex justify-center [&_iframe]:max-w-full",
            (showPlaceholder || disabled) && "pointer-events-none",
            showPlaceholder && "invisible",
          )}
          ref={host}
        />
        {showPlaceholder && (
          <Button
            block
            className="absolute inset-0"
            disabled={state !== "ready" || disabled}
            icon={<GoogleGlyph />}
            loading={busy || state === "loading"}
            size="lg"
            variant="secondary"
          >
            Continue with Google
          </Button>
        )}
      </div>
      {state === "failed" && (
        <p className="mt-2 text-meta text-text-tertiary" role="status">
          Google sign-in couldn’t load. Use your email and password instead.
        </p>
      )}
    </div>
  );
}
