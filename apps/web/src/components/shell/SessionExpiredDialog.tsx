"use client";

import { Modal } from "@heroui/react";
import { Clock } from "lucide-react";
import NextLink from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { toast } from "@/components/ui/Toast";
import type { StoredSession } from "@/lib/session";
import { signOut } from "@/modules/auth/api";
import { SignInForm } from "@/modules/auth/components/SignInForm";
import { signInHref } from "@/modules/auth/next";

/**
 * "Your session expired" over the page that stays open (preview `M.sessionExpired`).
 * Signing in stores the new session; `lib/session.ts` watchers do the rest: the same
 * person resumes here (queries refetch, the dialog closes), another account reloads
 * Home (ShellGate). Not dismissable: signing in, the full sign-in page (back to `href`
 * afterwards) or Sign out are the ways on.
 */
export function SessionExpiredDialog({ session, href }: { session: StoredSession | null; href: string }) {
  const router = useRouter();
  // The form stays filled in while the dialog animates closed after a successful sign-in.
  const [shown, setShown] = useState(session);
  if (session && session !== shown) setShown(session);

  function leave() {
    void signOut().then(() => {
      router.replace("/signin");
      toast("Signed out", { tone: "accent" });
    });
  }

  return (
    <Modal.Backdrop isOpen={session !== null} isDismissable={false} isKeyboardDismissDisabled>
      <Modal.Container size="sm" placement="auto">
        <Modal.Dialog className="au-reauth">
          <Modal.Header>
            <div className="row gap-12">
              <Modal.Icon className="au-reauth__icon">
                <Clock className="i" aria-hidden />
              </Modal.Icon>
              <div className="grow">
                <Modal.Heading>Your session expired</Modal.Heading>
                <p className="modal__description">Sign in again to pick up where you left off. This page stays open.</p>
              </div>
            </div>
          </Modal.Header>
          <Modal.Body>
            {shown ? (
              <SignInForm key={shown.name} initialId={shown.user.email || shown.user.username} onSignedIn={() => undefined} />
            ) : null}
            <p className="au-foot">
              <NextLink href={signInHref(href, "expired")} className="link link-button">
                Use the full sign-in page
              </NextLink>
              {" · "}
              <button type="button" className="link link-button" onClick={leave}>
                Sign out
              </button>
            </p>
          </Modal.Body>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
