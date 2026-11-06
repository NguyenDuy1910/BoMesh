"use client";

import { Spinner } from "@heroui/react";
import { useEffect, useRef, useState } from "react";

import { useAppearance } from "@/components/shell/useAppearance";
import { useLanguage } from "@/lib/i18n";
import { renderGoogleSignInButton } from "@/modules/auth/google";

/**
 * "Continue with Google": Google Identity Services renders its own button (the
 * only supported way to obtain an ID token without One Tap); the credential is
 * exchanged through CreateSession `credential.google.idToken`.
 */
export function GoogleSignInButton({
  clientId,
  disabled,
  onCredential,
  onError,
}: {
  clientId: string;
  disabled?: boolean;
  onCredential: (idToken: string) => void;
  onError: (message: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  const [language] = useLanguage();
  const { dark } = useAppearance();
  const callbacks = useRef({ onCredential, onError });
  callbacks.current = { onCredential, onError };

  useEffect(() => {
    if (!host.current) return;
    let live = true;
    renderGoogleSignInButton(
      host.current,
      clientId,
      (credential) => callbacks.current.onCredential(credential),
      (message) => callbacks.current.onError(message),
      dark,
    ).then(
      () => live && setReady(true),
      (error: unknown) => {
        if (live) callbacks.current.onError(error instanceof Error ? error.message : "Google sign-in could not be loaded.");
      },
    );
    return () => {
      live = false;
    };
    // Google's button is an iframe the DOM localizer and theme tokens cannot reach: re-render it in the interface
    // language and the light/dark mode.
  }, [clientId, language, dark]);

  return (
    <div className={disabled ? "au-google pointer-events-none opacity-60" : "au-google"} aria-busy={!ready}>
      {!ready ? (
        <div className="row center" style={{ height: 40 }}>
          <Spinner size="sm" />
        </div>
      ) : null}
      <div ref={host} className="flex justify-center" />
    </div>
  );
}
