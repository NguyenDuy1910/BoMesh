"use client";

import { CheckCircle2, LinkIcon } from "lucide-react";
import { useRef, useState, type FormEvent } from "react";

import { Button, ButtonLink } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { EmptyState } from "@/components/ui/EmptyState";
import { FormField } from "@/components/ui/FormField";
import { PreviewTag } from "@/components/ui/PreviewTag";
import { ApiError } from "@/lib/api/request";
import { completePasswordReset } from "@/modules/auth/api";
import { AuthHeading, AuthScreen } from "@/modules/auth/components/AuthScreen";
import { PasswordInput, PasswordRules } from "@/modules/auth/components/PasswordInput";
import { newPasswordError } from "@/modules/auth/validation";

interface Errors {
  password?: string;
  confirm?: string;
  form?: string;
}

/**
 * The page an emailed reset link opens: a new password with its rules and a
 * confirmation. Success ends every session of the account (proposed contract),
 * so the next step is signing in. API pending (`auth.password_reset`).
 */
export function PasswordResetComplete({ token }: { token: string }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [errors, setErrors] = useState<Errors>({});
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<"done" | "invalid" | null>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLInputElement>(null);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const next: Errors = {
      password: newPasswordError(password),
      confirm: !confirm ? "Enter the password again." : confirm !== password ? "The passwords don’t match." : undefined,
    };
    setErrors(next);
    if (next.password) return passwordRef.current?.focus();
    if (next.confirm) return confirmRef.current?.focus();
    setBusy(true);
    try {
      await completePasswordReset(token, { password });
      setOutcome("done");
    } catch (error) {
      setBusy(false);
      if (error instanceof ApiError && error.status === 404) return setOutcome("invalid");
      setErrors({
        form:
          error instanceof ApiError && error.status === 422
            ? `Use 8 to 128 characters with letters and numbers.`
            : error instanceof Error
              ? error.message
              : "Your password couldn’t be changed. Try again in a moment.",
      });
    }
  };

  if (outcome === "done") {
    return (
      <AuthScreen>
        <EmptyState
          action={
            <ButtonLink href="/auth/login" size="lg" variant="primary">
              Sign in
            </ButtonLink>
          }
          description="You were signed out everywhere. Sign in with your new password."
          icon={<CheckCircle2 />}
          size="md"
          title="Password updated"
          tone="ok"
        />
      </AuthScreen>
    );
  }

  if (outcome === "invalid") {
    return (
      <AuthScreen>
        <EmptyState
          action={
            <>
              <ButtonLink href="/auth/password-reset" size="lg" variant="primary">
                Request a new link
              </ButtonLink>
              <ButtonLink href="/auth/login" size="lg" variant="secondary">
                Back to sign in
              </ButtonLink>
            </>
          }
          description="Reset links work once and for 30 minutes. Request a new one to continue."
          icon={<LinkIcon />}
          size="md"
          title="This link has expired or was already used"
        />
      </AuthScreen>
    );
  }

  return (
    <AuthScreen>
      <form noValidate onSubmit={submit}>
        <AuthHeading aside={<PreviewTag />} sub="Choose a password you don’t use anywhere else." title="Set a new password" />
        <div className="grid gap-4">
          <div className="grid gap-2">
            <FormField error={errors.password} htmlFor="reset-password" label="New password" required>
              <PasswordInput
                aria-describedby="reset-password-rules"
                autoComplete="new-password"
                autoFocus
                onChange={(event) => {
                  setPassword(event.target.value);
                  // The rules below tick live; a stale message would contradict them.
                  setErrors((current) => ({ ...current, password: undefined }));
                }}
                ref={passwordRef}
                value={password}
              />
            </FormField>
            <PasswordRules id="reset-password-rules" password={password} />
          </div>
          <FormField error={errors.confirm} htmlFor="reset-confirm" label="Confirm new password" required>
            <PasswordInput
              autoComplete="new-password"
              onBlur={() => {
                if (!confirm) return;
                setErrors((current) => ({
                  ...current,
                  confirm: confirm !== password ? "The passwords don’t match." : undefined,
                }));
              }}
              onChange={(event) => {
                setConfirm(event.target.value);
                if (event.target.value === password) setErrors((current) => ({ ...current, confirm: undefined }));
              }}
              ref={confirmRef}
              value={confirm}
            />
          </FormField>
          {errors.form && <Callout tone="err">{errors.form}</Callout>}
          <Button block loading={busy} size="lg" type="submit">
            Update password
          </Button>
        </div>
      </form>
    </AuthScreen>
  );
}
