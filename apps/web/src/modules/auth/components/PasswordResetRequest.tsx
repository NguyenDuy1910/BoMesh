"use client";

import { ArrowLeft, MailCheck } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";

import { Button, ButtonLink } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { FormField } from "@/components/ui/FormField";
import { Input } from "@/components/ui/Input";
import { PreviewTag } from "@/components/ui/PreviewTag";
import { ApiError } from "@/lib/api/request";
import { isPendingMarkerEnabled } from "@/lib/config/pending";
import { requestPasswordReset } from "@/modules/auth/api";
import { AuthHeading, AuthScreen } from "@/modules/auth/components/AuthScreen";
import { currentSearchParam, emailError } from "@/modules/auth/validation";

/** Seconds before "Resend email" works again, so one click cannot flood an inbox. */
const RESEND_COOLDOWN_SECONDS = 30;

function requestFailure(error: unknown): string {
  if (error instanceof ApiError && error.status === 429) return "Too many requests. Wait a few minutes and try again.";
  if (error instanceof ApiError && error.status === 422) return "Enter an email like name@company.com.";
  return error instanceof Error ? error.message : "The email couldn’t be sent. Try again in a moment.";
}

/**
 * Forgot password: ask for the work email, then "Check your email" with a
 * resend that cools down. The answer never says whether an account exists.
 * API pending (`auth.password_reset`).
 */
export function PasswordResetRequest() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string>();
  const [formError, setFormError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<{ email: string; minutes: number } | null>(null);
  const [cooldown, setCooldown] = useState(0);
  const [resent, setResent] = useState(false);
  const emailRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const prefill = currentSearchParam("email");
    if (prefill) setEmail(prefill);
  }, []);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = window.setTimeout(() => setCooldown((seconds) => seconds - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [cooldown]);

  const send = async (address: string) => {
    setBusy(true);
    setFormError(undefined);
    try {
      const accepted = await requestPasswordReset({ email: address.trim() });
      setSent({ email: address.trim(), minutes: accepted.expires_in_minutes });
      setCooldown(RESEND_COOLDOWN_SECONDS);
      return true;
    } catch (cause) {
      setFormError(requestFailure(cause));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const invalid = emailError(email);
    setError(invalid);
    if (invalid) return emailRef.current?.focus();
    await send(email);
  };

  if (sent) {
    return (
      <AuthScreen>
        <span className="mb-5 grid size-12 place-items-center rounded-(--radius-sheet) bg-surface-selected text-text-accent">
          <MailCheck aria-hidden="true" className="size-5" />
        </span>
        <AuthHeading
          aside={<PreviewTag />}
          sub={
            <>
              If an account uses <strong className="font-semibold text-text-primary">{sent.email}</strong>, we sent it a
              link to set a new password. The link works for {sent.minutes} minutes.
            </>
          }
          title="Check your email"
        />
        {isPendingMarkerEnabled() && (
          <Callout className="mb-4" tone="neutral">
            Preview: no email is sent yet. The reset link is written to the browser console.
          </Callout>
        )}
        {formError && (
          <Callout className="mb-4" tone="err">
            {formError}
          </Callout>
        )}
        <div className="grid gap-3">
          <Button
            block
            disabled={cooldown > 0}
            loading={busy}
            onClick={async () => setResent(await send(sent.email))}
            size="lg"
            variant="secondary"
          >
            {cooldown > 0 ? `Resend email in ${cooldown}s` : "Resend email"}
          </Button>
          <p aria-live="polite" className="min-h-5 text-center text-meta text-text-tertiary">
            {resent && cooldown > 0 ? "Email sent again." : "Didn’t get it? Check your spam folder first."}
          </p>
        </div>
        <div className="mt-4 flex items-center justify-between gap-3">
          <ButtonLink href="/auth/login" icon={<ArrowLeft />} size="sm" variant="ghost">
            Back to sign in
          </ButtonLink>
          <Button
            onClick={() => {
              setSent(null);
              setResent(false);
              setCooldown(0);
            }}
            size="sm"
            variant="link"
          >
            Use a different email
          </Button>
        </div>
      </AuthScreen>
    );
  }

  return (
    <AuthScreen>
      <form noValidate onSubmit={submit}>
        <AuthHeading
          aside={<PreviewTag />}
          sub="Enter your work email and we’ll send you a link to set a new password."
          title="Reset your password"
        />
        <div className="grid gap-4">
          <FormField error={error} htmlFor="reset-email" label="Work email" required>
            <Input
              autoCapitalize="none"
              autoComplete="email"
              autoFocus
              inputMode="email"
              onBlur={() => email && setError(emailError(email))}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="name@company.com"
              ref={emailRef}
              type="email"
              value={email}
            />
          </FormField>
          {formError && <Callout tone="err">{formError}</Callout>}
          <Button block loading={busy} size="lg" type="submit">
            Send reset link
          </Button>
        </div>
        <div className="mt-4 flex justify-center">
          <ButtonLink href="/auth/login" icon={<ArrowLeft />} size="sm" variant="ghost">
            Back to sign in
          </ButtonLink>
        </div>
      </form>
    </AuthScreen>
  );
}
