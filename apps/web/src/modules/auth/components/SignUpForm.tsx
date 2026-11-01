"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";

import { Button, ButtonLink } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { FormField } from "@/components/ui/FormField";
import { Input } from "@/components/ui/Input";
import { ApiError } from "@/lib/api/request";
import { createPasswordAccount } from "@/modules/auth/api";
import { AuthHeading, AuthScreen } from "@/modules/auth/components/AuthScreen";
import { PasswordInput, PasswordRules } from "@/modules/auth/components/PasswordInput";
import { currentSearchParam, destinationAfterSignIn, emailError, newPasswordError } from "@/modules/auth/validation";

interface Errors {
  name?: string;
  email?: React.ReactNode;
  password?: string;
  form?: string;
}

export function SignUpForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<Errors>({});
  const [busy, setBusy] = useState(false);
  const [signInHref, setSignInHref] = useState("/auth/login");
  const nameRef = useRef<HTMLInputElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const next = currentSearchParam("next");
    if (next) setSignInHref(`/auth/login?next=${encodeURIComponent(next)}`);
  }, []);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const next: Errors = {
      name: name.trim() ? undefined : "Enter your name.",
      email: emailError(email),
      password: newPasswordError(password),
    };
    setErrors(next);
    if (next.name) return nameRef.current?.focus();
    if (next.email) return emailRef.current?.focus();
    if (next.password) return passwordRef.current?.focus();
    setBusy(true);
    try {
      const session = await createPasswordAccount({ display_name: name, email, password });
      router.replace(destinationAfterSignIn(session, currentSearchParam("next")));
    } catch (error) {
      setBusy(false);
      if (error instanceof ApiError && error.status === 409) {
        setErrors({
          email: (
            <>
              An account already uses this email.{" "}
              <ButtonLink href={`/auth/login?email=${encodeURIComponent(email.trim())}`} size="sm" variant="link">
                Sign in instead
              </ButtonLink>
            </>
          ),
        });
        emailRef.current?.focus();
        return;
      }
      setErrors({
        form:
          error instanceof ApiError && error.status === 422
            ? "Check your details: use a valid email and a password of 8 to 128 characters."
            : error instanceof ApiError && error.status === undefined
              ? error.message
              : "Your account couldn’t be created. Try again in a moment.",
      });
    }
  };

  return (
    <AuthScreen>
      <form noValidate onSubmit={submit}>
        <AuthHeading
          sub="You start in a personal workspace. Your workspace admin adds you to your team’s workspace after this."
          title="Create your account"
        />
        <div className="grid gap-4">
          <FormField error={errors.name} htmlFor="signup-name" label="Full name" required>
            <Input
              autoComplete="name"
              autoFocus
              maxLength={255}
              onChange={(event) => setName(event.target.value)}
              placeholder="Kevin Ng"
              ref={nameRef}
              value={name}
            />
          </FormField>
          <FormField error={errors.email} htmlFor="signup-email" label="Work email" required>
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
          <div className="grid gap-2">
            <FormField error={errors.password} htmlFor="signup-password" label="Password" required>
              <PasswordInput
                aria-describedby="signup-password-rules"
                autoComplete="new-password"
                onChange={(event) => {
                  setPassword(event.target.value);
                  // The rules below tick live; a stale message would contradict them.
                  setErrors((current) => ({ ...current, password: undefined }));
                }}
                ref={passwordRef}
                value={password}
              />
            </FormField>
            <PasswordRules id="signup-password-rules" password={password} />
          </div>
          {errors.form && <Callout tone="err">{errors.form}</Callout>}
          <Button block loading={busy} size="lg" type="submit">
            Create account
          </Button>
        </div>
        <p className="mt-4 text-center text-[0.8125rem] text-text-tertiary">
          Already have an account?{" "}
          <ButtonLink href={signInHref} size="sm" variant="link">
            Sign in
          </ButtonLink>
        </p>
      </form>
    </AuthScreen>
  );
}
