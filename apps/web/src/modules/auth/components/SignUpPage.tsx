"use client";

import { Alert, Button, Checkbox, FieldError, Form, Input, Label, TextField } from "@heroui/react";
import { AlertCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";

import { toast } from "@/components/ui";
import { ApiError, errorMessage } from "@/lib/api/client";
import { createAccount, emailInUse } from "@/modules/auth/api";
import { AuthLayout, AuthLink, PasswordInput, PasswordStrength } from "@/modules/auth/components/AuthLayout";
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
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [terms, setTerms] = useState(false);
  const [errors, setErrors] = useState<Errors>({});
  const [busy, setBusy] = useState(false);
  const form = useRef<HTMLFormElement>(null);

  const focus = (field: string) => form.current?.querySelector<HTMLElement>(`[name="${field}"]`)?.focus();

  /** On leaving the email field: tell early when the address already has an account. */
  async function checkEmail() {
    const value = email.trim();
    if (!EMAIL_RE.test(value)) return;
    if (await emailInUse(value)) setErrors((e) => ({ ...e, email: "An account already uses this email.", dup: true }));
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
    setBusy(true);
    try {
      await createAccount({ displayName: name, email, password: pw });
      router.replace("/workspaces");
      toast("Account created", { tone: "success" });
    } catch (error) {
      setBusy(false);
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
      <p className="muted au-sub">Your workspace admin adds you to a workspace afterwards.</p>
      <Form ref={form} onSubmit={submit} method="post" validationBehavior="aria" className="flex flex-col gap-16">
        <TextField className="field" name="name" value={name} onChange={setName} isInvalid={!!errors.name} autoFocus autoComplete="name">
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
        <TextField className="field" name="password" value={pw} onChange={setPw} isInvalid={!!errors.pw}>
          <Label>Password</Label>
          <PasswordInput autoComplete="new-password" />
          <PasswordStrength value={pw} />
          <FieldError>{errors.pw}</FieldError>
        </TextField>
        <div className="au-terms" style={{ margin: "4px 0 8px" }}>
          <Checkbox name="terms" isSelected={terms} onChange={setTerms} aria-describedby={errors.terms ? "su-terms-err" : undefined}>
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
        <Button type="submit" variant="primary" size="lg" fullWidth isPending={busy}>
          Create account
        </Button>
      </Form>
      <p className="au-foot">
        Already have an account? <AuthLink href="/signin">Sign in</AuthLink>
      </p>
    </AuthLayout>
  );
}
