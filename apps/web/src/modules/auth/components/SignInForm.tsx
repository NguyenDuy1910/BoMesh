"use client";

import { Alert, Button, FieldError, Form, Input, Label, TextField } from "@heroui/react";
import NextLink from "next/link";
import { useRef, useState, type FormEvent } from "react";

import { ApiError, errorMessage } from "@/lib/api/client";
import type { StoredSession } from "@/lib/session";
import { signInWithGoogle, signInWithPassword } from "@/modules/auth/api";
import { PasswordInput } from "@/modules/auth/components/AuthLayout";
import { GoogleSignInButton } from "@/modules/auth/components/GoogleSignInButton";
import { validateIdentifier } from "@/modules/auth/validation";

interface Errors {
  id?: string;
  pw?: string;
  form?: string;
}

function signInError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.reason === "INVALID_CREDENTIALS" || error.status === 401) return "Email hoặc mật khẩu không đúng";
    if (error.reason === "USER_SUSPENDED") return "Tài khoản này đã bị tạm ngưng. Hãy liên hệ quản trị viên.";
  }
  return errorMessage(error);
}

/**
 * Password and Google sign-in (CreateSession), shared by the Sign in page and the
 * session-expired dialog. The session is stored before `onSignedIn` runs; a failure
 * in either is shown in the form.
 */
export function SignInForm({
  initialId = "",
  showForgot = false,
  googleLast = false,
  onSignedIn,
}: {
  /** Prefilled email or username; the password field takes focus when given. */
  initialId?: string;
  showForgot?: boolean;
  /** Sign in page: the password form first, then "or" and Google (preview `P.signin`). The dialog leads with Google. */
  googleLast?: boolean;
  onSignedIn: (session: StoredSession) => Promise<void> | void;
}) {
  const [id, setId] = useState(initialId);
  const [pw, setPw] = useState("");
  const [errors, setErrors] = useState<Errors>({});
  const [busy, setBusy] = useState<"" | "pw" | "google">("");
  const idRef = useRef<HTMLInputElement>(null);
  const pwRef = useRef<HTMLDivElement>(null);
  const googleClientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID?.trim() ?? "";

  async function enter(signIn: () => Promise<StoredSession>, kind: "pw" | "google") {
    setBusy(kind);
    setErrors({});
    try {
      await onSignedIn(await signIn());
    } catch (error) {
      setBusy("");
      setPw("");
      setErrors({ form: signInError(error) });
      pwRef.current?.querySelector("input")?.focus();
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const e: Errors = { id: validateIdentifier(id), pw: pw ? undefined : "Nhập mật khẩu." };
    if (e.id || e.pw) {
      setErrors(e);
      (e.id ? idRef.current : pwRef.current?.querySelector("input"))?.focus();
      return;
    }
    void enter(() => signInWithPassword(id, pw), "pw");
  }

  const forgotHref = id.includes("@") ? `/password-reset?email=${encodeURIComponent(id.trim())}` : "/password-reset";

  const google = googleClientId ? (
    <GoogleSignInButton
      clientId={googleClientId}
      disabled={!!busy}
      onCredential={(credential) => void enter(() => signInWithGoogle(credential), "google")}
      onError={(message) => setErrors({ form: message })}
    />
  ) : null;
  const or = googleClientId ? (
    <div className="au-or" role="separator">
      <span>hoặc</span>
    </div>
  ) : null;

  return (
    <>
      {googleLast ? null : (
        <>
          {google}
          {or}
        </>
      )}
      {/* POST: a submit before hydration must never put the password in the address bar. */}
      <Form onSubmit={submit} method="post" validationBehavior="aria" className="au-form">
        <TextField
          className="field"
          value={id}
          onChange={(v) => {
            setId(v);
            if (errors.id) setErrors((e) => ({ ...e, id: undefined }));
          }}
          isInvalid={!!errors.id}
          autoComplete="username"
          name="username"
          autoFocus={!initialId}
        >
          <Label>Email hoặc tên người dùng</Label>
          <Input ref={idRef} placeholder="name@company.com" />
          <FieldError>{errors.id}</FieldError>
        </TextField>
        <TextField
          ref={pwRef}
          className={showForgot ? "field au-pwfield" : "field"}
          value={pw}
          onChange={(v) => {
            setPw(v);
            if (errors.pw) setErrors((e) => ({ ...e, pw: undefined }));
          }}
          isInvalid={!!errors.pw}
          name="password"
        >
          <Label>Mật khẩu</Label>
          <PasswordInput autoComplete="current-password" autoFocus={!!initialId} />
          {/* After the input, so Tab goes email → password; the grid shows it at the end of the label row. */}
          {showForgot ? (
            <NextLink href={forgotHref} className="link link-button au-forgot">
              Quên mật khẩu?
            </NextLink>
          ) : null}
          <FieldError>{errors.pw}</FieldError>
        </TextField>
        {errors.form ? (
          <div className="au-form-error">
            <Alert status="danger">
              <Alert.Indicator />
              <Alert.Content>
                <Alert.Title>{errors.form}</Alert.Title>
              </Alert.Content>
            </Alert>
          </div>
        ) : null}
        <Button type="submit" variant="primary" size="lg" fullWidth isPending={busy === "pw"} isDisabled={!!busy && busy !== "pw"}>
          Đăng nhập
        </Button>
      </Form>
      {googleLast ? (
        <>
          {or}
          {google}
        </>
      ) : null}
    </>
  );
}
