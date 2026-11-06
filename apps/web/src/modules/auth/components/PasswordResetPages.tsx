"use client";

import { Alert, Button, FieldError, Form, Input, Label, TextField } from "@heroui/react";
import { Link2Off, MailCheck } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useState, type FormEvent } from "react";

import { EmptyState, toast } from "@/components/ui";
import { ApiError, errorMessage } from "@/lib/api/client";
import { resetPassword, sendPasswordReset } from "@/modules/auth/api";
import { AuthLayout, AuthLink, PasswordInput, PasswordStrength } from "@/modules/auth/components/AuthLayout";
import { EMAIL_RE, passwordAcceptable } from "@/modules/auth/validation";

function FormAlert({ children }: { children: string }) {
  return (
    <Alert status="danger">
      <Alert.Indicator />
      <Alert.Content>
        <Alert.Title>{children}</Alert.Title>
      </Alert.Content>
    </Alert>
  );
}

/** `/password-reset`: SendPasswordReset; the same confirmation whether or not the account exists. */
export function PasswordResetRequestPage() {
  const initialEmail = useSearchParams().get("email") ?? "";
  const [email, setEmail] = useState(initialEmail);
  const [error, setError] = useState<string>();
  const [formError, setFormError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (!EMAIL_RE.test(email.trim())) return setError("Enter an email like name@company.com.");
    setError(undefined);
    setFormError(undefined);
    setBusy(true);
    try {
      await sendPasswordReset(email);
      setSentTo(email.trim());
    } catch (e) {
      setFormError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout single innerClassName="au-narrow">
      {sentTo ? (
        <>
          <h1 className="t-title au-title">Check your email</h1>
          <EmptyState
            icon={MailCheck}
            title="If an account exists, we sent a reset link."
            description={`Open the link sent to ${sentTo} to choose a new password. It expires soon.`}
            boxed
          />
        </>
      ) : (
        <>
          <h1 className="t-title au-title">Reset your password</h1>
          <p className="muted au-sub">Enter your account email and we’ll send you a link to choose a new password.</p>
          <Form onSubmit={submit} method="post" validationBehavior="aria" className="flex flex-col gap-16">
            <TextField className="field" type="email" value={email} onChange={setEmail} isInvalid={!!error} autoFocus autoComplete="email">
              <Label>Work email</Label>
              <Input placeholder="name@company.com" />
              <FieldError>{error}</FieldError>
            </TextField>
            {formError ? <FormAlert>{formError}</FormAlert> : null}
            <Button type="submit" variant="primary" size="lg" fullWidth isPending={busy}>
              Send reset link
            </Button>
          </Form>
        </>
      )}
      <p className="au-foot">
        Remembered it? <AuthLink href="/signin">Sign in</AuthLink>
      </p>
    </AuthLayout>
  );
}

/** `/password-reset/[token]`: ResetPassword; every session of the account ends. */
export function PasswordResetCompletePage({ token }: { token: string }) {
  const router = useRouter();
  const [pw, setPw] = useState("");
  const [error, setError] = useState<string>();
  const [formError, setFormError] = useState<string>();
  const [invalidToken, setInvalidToken] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (!passwordAcceptable(pw)) return setError("Use at least 8 characters with letters and numbers.");
    setError(undefined);
    setFormError(undefined);
    setBusy(true);
    try {
      await resetPassword(token, pw);
      toast("Password changed. Sign in with your new password.", { tone: "success" });
      router.replace("/signin");
    } catch (e) {
      setBusy(false);
      if (e instanceof ApiError && e.reason === "RESET_TOKEN_INVALID") setInvalidToken(true);
      else if (e instanceof ApiError && e.fieldViolations.length) setError(e.fieldViolations[0].description);
      else setFormError(errorMessage(e));
    }
  }

  return (
    <AuthLayout single innerClassName="au-narrow">
      {invalidToken ? (
        <>
          <h1 className="t-title au-title">This link no longer works</h1>
          <EmptyState
            icon={Link2Off}
            title="The reset link is invalid, used or expired"
            description="Request a new link to choose a new password."
            actions={
              <Button variant="primary" onPress={() => router.push("/password-reset")}>
                Request a new link
              </Button>
            }
            boxed
          />
        </>
      ) : (
        <>
          <h1 className="t-title au-title">Choose a new password</h1>
          <p className="muted au-sub">You’ll be signed out everywhere and can sign in with the new password.</p>
          <Form onSubmit={submit} method="post" validationBehavior="aria" className="flex flex-col gap-16">
            <TextField className="field" value={pw} onChange={setPw} isInvalid={!!error} autoFocus>
              <Label>New password</Label>
              <PasswordInput autoComplete="new-password" />
              <PasswordStrength value={pw} />
              <FieldError>{error}</FieldError>
            </TextField>
            {formError ? <FormAlert>{formError}</FormAlert> : null}
            <Button type="submit" variant="primary" size="lg" fullWidth isPending={busy}>
              Change password
            </Button>
          </Form>
        </>
      )}
      <p className="au-foot">
        <AuthLink href="/signin">Back to sign in</AuthLink>
      </p>
    </AuthLayout>
  );
}
