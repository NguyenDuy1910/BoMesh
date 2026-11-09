"use client";

import { Card } from "@heroui/react";
import { useQueryClient } from "@tanstack/react-query";
import { Clock, Sparkles } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

import { Callout } from "@/components/ui/Callout";
import { getSession, sessionTransition, useSession, useSessionExpired, type StoredSession } from "@/lib/session";
import { routeAfterSignIn } from "@/modules/auth/api";
import { AuthLayout, AuthLink } from "@/modules/auth/components/AuthLayout";
import { SignInForm } from "@/modules/auth/components/SignInForm";

/** One product proof: a grounded answer with sources (hidden on phones by layout.css). */
function Proof() {
  return (
    <figure className="au-proof">
      <Card className="au-proof__card" aria-hidden="true">
        <div className="au-proof__q">What’s the meal allowance for international travel?</div>
        <div className="au-proof__a">
          <span className="au-proof__ai">
            <Sparkles className="i i-sm" />
          </span>
          <p>
            The allowance is <strong>USD 75 per day</strong>
            <span className="cite">1</span>. Keep receipts for lodging and transport<span className="cite">2</span>.
          </p>
        </div>
        <div className="row gap-8 wrap au-proof__sources">
          <span className="au-source">
            <span className="file-icon file-icon--pdf file-icon--sm">PDF</span>
            <span className="truncate">Travel Policy.pdf</span>
            <span className="muted">p. 8</span>
          </span>
          <span className="au-source">
            <span className="file-icon file-icon--sheet file-icon--sm">XLSX</span>
            <span className="truncate">Expense limits.xlsx</span>
          </span>
        </div>
      </Card>
      <figcaption className="au-proof__caption">
        Answers from your company’s knowledge, with sources you can check.
      </figcaption>
    </figure>
  );
}

export function SignInPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const params = useSearchParams();
  const next = params.get("next");
  const session = useSession();
  const expired = useSessionExpired();
  // The person whose session expired; kept after their sign-in replaces it.
  const [previous, setPrevious] = useState<StoredSession | null>(null);
  if (expired && session && previous?.name !== session.name) setPrevious(session);

  // Already signed in: continue to the workspace instead of showing the form.
  useEffect(() => {
    if (!getSession()) return;
    routeAfterSignIn(queryClient, next).then((to) => router.replace(to), () => undefined);
  }, [next, router, queryClient]);

  async function signedIn(fresh: StoredSession) {
    // `next` is the expired person's page: anyone else starts from their own workspace.
    const back = !previous || sessionTransition(previous, fresh) === "renewed" ? next : null;
    router.replace(await routeAfterSignIn(queryClient, back));
  }

  return (
    <AuthLayout aside={<Proof />}>
      <h1 className="t-title au-title">Sign in</h1>
      {params.get("reason") === "expired" ? (
        <Callout
          className="au-notice"
          tone="accent"
          icon={Clock}
          title="Your session expired"
          description="Sign in again to go back to where you were."
        />
      ) : null}
      <SignInForm
        key={previous?.name}
        initialId={previous ? previous.user.email || previous.user.username : (params.get("email") ?? undefined)}
        showForgot
        onSignedIn={signedIn}
      />
      <p className="au-foot">
        New to BoMesh? <AuthLink href="/signup">Create account</AuthLink>
      </p>
    </AuthLayout>
  );
}
