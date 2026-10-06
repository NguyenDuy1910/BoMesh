"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";

import { Button, ButtonLink } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { FormField } from "@/components/ui/FormField";
import { Input } from "@/components/ui/Input";
import { usePendingFeature } from "@/lib/api/pending";
import { ApiError } from "@/lib/api/request";
import type { AuthSession } from "@/lib/auth/session";
import { completeGoogleSignIn, completePasswordSignIn } from "@/modules/auth/api";
import { AuthHeading, AuthScreen } from "@/modules/auth/components/AuthScreen";
import { GoogleSignInButton, googleSignInAvailable } from "@/modules/auth/components/GoogleSignInButton";
import { PasswordInput } from "@/modules/auth/components/PasswordInput";
import { currentSearchParam, destinationAfterSignIn, emailError } from "@/modules/auth/validation";

type Busy = "" | "google" | "password";

interface Errors {
  email?: string;
  password?: string;
  form?: string;
}

/** What a failed sign-in means to the person, read from the status (the API's detail is operator-facing). */
function signInFailure(error: unknown, method: "google" | "password", email: string): string {
  if (!(error instanceof ApiError) || error.status === undefined) {
    return error instanceof Error ? error.message : "Sign-in didn’t work. Try again in a moment.";
  }
  switch (error.status) {
    case 401:
      return method === "password"
        ? "That email and password don’t match. Check them and try again."
        : "Google sign-in didn’t work. Try again, or use your email and password.";
    case 403:
      return `Your account isn’t in a workspace yet. Ask your workspace admin to add ${email.trim() || "your account"}, then sign in again.`;
    case 429:
      return "Too many attempts. Wait a few minutes and try again.";
    default:
      return "Sign-in didn’t work. Try again in a moment.";
  }
}

export function SignInForm() {
  const router = useRouter();
  const resetAvailable = usePendingFeature("auth.password_reset");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<Errors>({});
  const [busy, setBusy] = useState<Busy>("");
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const [signupHref, setSignupHref] = useState("/auth/signup");

  // `?email=` arrives from "Sign in instead" and a finished password reset;
  // `?next=` is carried to account creation so it lands on the same page.
  useEffect(() => {
    const prefill = currentSearchParam("email");
    if (prefill) setEmail(prefill);
    const next = currentSearchParam("next");
    if (next) setSignupHref(`/auth/signup?next=${encodeURIComponent(next)}`);
  }, []);

  const enter = (session: AuthSession) => {
    router.replace(destinationAfterSignIn(session, currentSearchParam("next")));
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const next: Errors = { email: emailError(email), password: password ? undefined : "Enter your password." };
    setErrors(next);
    if (next.email) return emailRef.current?.focus();
    if (next.password) return passwordRef.current?.focus();
    setBusy("password");
    try {
      enter(await completePasswordSignIn(email, password));
    } catch (error) {
      setBusy("");
      setPassword("");
      setErrors({ form: signInFailure(error, "password", email) });
      passwordRef.current?.focus();
    }
  };

  const signInWithGoogle = async (credential: string) => {
    setBusy("google");
    setErrors({});
    try {
      enter(await completeGoogleSignIn(credential));
    } catch (error) {
      setBusy("");
      setErrors({ form: signInFailure(error, "google", "") });
    }
  };

  const forgotHref = `/auth/password-reset${email.trim() ? `?email=${encodeURIComponent(email.trim())}` : ""}`;

  return (
    <AuthScreen>
      <form noValidate onSubmit={submit}>
        <AuthHeading sub="Use your work account." title="Sign in" />
        {googleSignInAvailable && (
          <>
            <GoogleSignInButton
              busy={busy === "google"}
              disabled={busy === "password"}
              onCredential={(credential) => void signInWithGoogle(credential)}
              onError={(message) => setErrors({ form: message })}
            />
            <div aria-hidden="true" className="my-[18px] flex items-center gap-3 text-meta text-text-tertiary before:h-px before:flex-1 before:bg-border-subtle after:h-px after:flex-1 after:bg-border-subtle">
              or
            </div>
          </>
        )}
        <div className="grid gap-4">
          <FormField error={errors.email} htmlFor="signin-email" label="Work email" required>
            <Input
              autoCapitalize="none"
              autoComplete="email"
              inputMode="email"
              onBlur={() => {
                if (!email) return;
                setErrors((current) => ({ ...current, email: emailError(email) }));
              }}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="name@company.com"
              ref={emailRef}
              type="email"
              value={email}
            />
          </FormField>
          <FormField
            error={errors.password}
            htmlFor="signin-password"
            label="Password"
            labelAction={
              resetAvailable ? (
                <ButtonLink href={forgotHref} size="sm" variant="link">
                  Forgot password?
                </ButtonLink>
              ) : undefined
            }
            required
          >
            <PasswordInput
              autoComplete="current-password"
              onChange={(event) => setPassword(event.target.value)}
              ref={passwordRef}
              value={password}
            />
          </FormField>
          {errors.form && <Callout tone="err">{errors.form}</Callout>}
          <Button block disabled={busy === "google"} loading={busy === "password"} size="lg" type="submit">
            Sign in
          </Button>
        </div>
        <p className="mt-4 text-center text-[0.8125rem] text-text-tertiary">
          New to BoMesh?{" "}
          <ButtonLink href={signupHref} size="sm" variant="link">
            Create an account
          </ButtonLink>
        </p>
        <p className="mt-7 text-center text-meta text-text-tertiary">Trouble signing in? Contact your IT admin.</p>
      </form>
    </AuthScreen>
  );
}
