"use client";

import { Alert, Button, Checkbox, Description, FieldError, Form, Input, Label, TextField } from "@heroui/react";
import { useQueryClient } from "@tanstack/react-query";
import { AlertCircle } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";

import { toast } from "@/components/ui";
import { ApiError, errorMessage } from "@/lib/api/client";
import { createAccount, emailInUse, routeAfterSignIn, signInWithGoogle } from "@/modules/auth/api";
import { AuthLayout, AuthLink, PasswordInput, PasswordStrength } from "@/modules/auth/components/AuthLayout";
import { GoogleSignInButton } from "@/modules/auth/components/GoogleSignInButton";
import { isLinkNext, safeNext } from "@/modules/auth/next";
import { EMAIL_RE, passwordAcceptable } from "@/modules/auth/validation";

interface Errors {
  name?: string;
  email?: string;
  dup?: boolean;
  pw?: string;
  terms?: string;
  form?: string;
}

export function SignUpPage() {
  const router = useRouter();
  // A link someone was sent (`/s/…`, `/w/…`): the new account goes straight back to it (an invite then offers Accept, a join link Join).
  const next = safeNext(useSearchParams().get("next"));
  const shareNext = isLinkNext(next) ? next : null;
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [terms, setTerms] = useState(false);
  const [errors, setErrors] = useState<Errors>({});
  const [busy, setBusy] = useState<"" | "form" | "google">("");
  const queryClient = useQueryClient();
  const googleClientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID?.trim() ?? "";
  const form = useRef<HTMLFormElement>(null);

  const focus = (field: string) => form.current?.querySelector<HTMLElement>(`[name="${field}"]`)?.focus();

  /** On leaving the email field: tell early when the address already has an account. */
  async function checkEmail() {
    const value = email.trim();
    if (!EMAIL_RE.test(value)) return;
    if (await emailInUse(value)) setErrors((e) => ({ ...e, email: "An account already uses this email.", dup: true }));
  }

  /** Google creates the account on first sign-in (auth_contract.md › Session creation), so sign-up offers it too; an email
      that already has an account just signs in. Either way the person goes on as after Sign in. */
  async function google(idToken: string) {
    setBusy("google");
    setErrors({});
    try {
      await signInWithGoogle(idToken);
      router.replace(await routeAfterSignIn(queryClient, shareNext));
    } catch (error) {
      setBusy("");
      setErrors({ form: errorMessage(error) });
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const e: Errors = {};
    if (!name.trim()) e.name = "Enter your name.";
    if (!EMAIL_RE.test(email.trim())) e.email = "Enter an email like name@company.com.";
    else if (errors.dup) Object.assign(e, { email: errors.email, dup: true });
    if (!passwordAcceptable(pw)) e.pw = "Use at least 8 characters with letters and numbers.";
    if (!terms) e.terms = "Accept the terms to continue.";
    setErrors(e);
    const first = e.name ? "name" : e.email ? "email" : e.pw ? "password" : e.terms ? "terms" : "";
    if (first) return focus(first);
    setBusy("form");
    try {
      await createAccount({ displayName: name, email, password: pw });
      router.replace(shareNext ?? "/workspaces");
      toast("Account created", { tone: "success" });
    } catch (error) {
      setBusy("");
      if (error instanceof ApiError && error.reason === "EMAIL_ALREADY_USED") {
        setErrors({ email: "An account already uses this email.", dup: true });
        focus("email");
      } else if (error instanceof ApiError && error.reason === "USERNAME_ALREADY_USED") {
        setErrors({ form: "That username is already taken." });
      } else if (error instanceof ApiError && error.fieldViolations.some((v) => v.field.includes("password"))) {
        setErrors({ pw: error.fieldViolations.find((v) => v.field.includes("password"))?.description });
        focus("password");
      } else {
        setErrors({ form: errorMessage(error) });
      }
    }
  }

  return (
    <AuthLayout single innerClassName="au-narrow">
      <h1 className="t-title au-title">Create your account</h1>
      <p className="muted au-sub">{shareNext ? "Create an account to open the link you were sent." : "Use your work email. If a workspace admin invited you, use the address the invite went to."}</p>
      <Form ref={form} onSubmit={submit} method="post" validationBehavior="aria" className="flex flex-col gap-16">
        <TextField
          className="field"
          name="name"
          value={name}
          onChange={(v) => {
            setName(v);
            if (errors.name) setErrors((e) => ({ ...e, name: undefined }));
          }}
          isInvalid={!!errors.name}
          autoFocus
          autoComplete="name"
        >
          <Label>Full name</Label>
          <Input placeholder="Kevin Ng" />
          <FieldError>{errors.name}</FieldError>
        </TextField>
        <TextField
          className="field"
          name="email"
          type="email"
          value={email}
          onChange={(v) => {
            setEmail(v);
            if (errors.email) setErrors((e) => ({ ...e, email: undefined, dup: false }));
          }}
          onBlur={() => void checkEmail()}
          isInvalid={!!errors.email}
          autoComplete="email"
        >
          <Label>Work email</Label>
          <Input placeholder="name@company.com" />
          <FieldError>
            {errors.email}{" "}
            {errors.dup ? (
              <AuthLink href={`/signin?email=${encodeURIComponent(email.trim())}`}>Sign in instead</AuthLink>
            ) : null}
          </FieldError>
        </TextField>
        <TextField
          className="field"
          name="password"
          value={pw}
          onChange={(v) => {
            setPw(v);
            if (errors.pw) setErrors((e) => ({ ...e, pw: undefined }));
          }}
          isInvalid={!!errors.pw}
        >
          <Label>Password</Label>
          <PasswordInput autoComplete="new-password" />
          {/* The checklist appears once there's a password to check; before that one line says what's needed. */}
          {pw ? <PasswordStrength value={pw} /> : errors.pw ? null : <Description>At least 8 characters, with letters and numbers.</Description>}
          <FieldError>{errors.pw}</FieldError>
        </TextField>
        <div className="au-terms">
          <Checkbox
            name="terms"
            isSelected={terms}
            onChange={(v) => {
              setTerms(v);
              if (errors.terms) setErrors((e) => ({ ...e, terms: undefined }));
            }}
            aria-describedby={errors.terms ? "su-terms-err" : undefined}
          >
            <Checkbox.Content>
              <Checkbox.Control>
                <Checkbox.Indicator />
              </Checkbox.Control>
              I agree to the terms of service and privacy policy
            </Checkbox.Content>
          </Checkbox>
          {errors.terms ? (
            <div className="field-error" id="su-terms-err" role="alert">
              <AlertCircle className="i" aria-hidden />
              <span>{errors.terms}</span>
            </div>
          ) : null}
        </div>
        {errors.form ? (
          <Alert status="danger">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Title>{errors.form}</Alert.Title>
            </Alert.Content>
          </Alert>
        ) : null}
        <Button type="submit" variant="primary" size="lg" fullWidth isPending={busy === "form"} isDisabled={busy === "google"}>
          Create account
        </Button>
      </Form>
      {googleClientId ? (
        <>
          <div className="au-or" role="separator">
            <span>or</span>
          </div>
          <GoogleSignInButton
            clientId={googleClientId}
            disabled={!!busy}
            onCredential={(credential) => void google(credential)}
            onError={(message) => setErrors({ form: message })}
          />
          <p className="t-xs muted au-google-terms">By continuing with Google, you agree to the terms of service and privacy policy.</p>
        </>
      ) : null}
      <p className="au-foot">
        Already have an account? <AuthLink href={shareNext ? `/signin?next=${encodeURIComponent(shareNext)}` : "/signin"}>Sign in</AuthLink>
      </p>
    </AuthLayout>
  );
}
