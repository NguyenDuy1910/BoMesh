"use client";

import { Alert, Button, Card, FieldError, Form, Input, Label, TextField } from "@heroui/react";
import { Sparkles } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";

import { ApiError, errorMessage } from "@/lib/api/client";
import { getSession } from "@/lib/session";
import { routeAfterSignIn, signInWithGoogle, signInWithPassword } from "@/modules/auth/api";
import { AuthLayout, AuthLink, PasswordInput } from "@/modules/auth/components/AuthLayout";
import { GoogleSignInButton } from "@/modules/auth/components/GoogleSignInButton";
import { validateIdentifier } from "@/modules/auth/validation";

interface Errors {
  id?: string;
  pw?: string;
  form?: string;
}

function signInError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.reason === "INVALID_CREDENTIALS" || error.status === 401) return "Email or password is incorrect";
    if (error.reason === "USER_SUSPENDED") return "This account is suspended. Contact your administrator.";
  }
  return errorMessage(error);
}

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
  const params = useSearchParams();
  const next = params.get("next");
  const [id, setId] = useState(() => params.get("email") ?? "");
  const [pw, setPw] = useState("");
  const [errors, setErrors] = useState<Errors>({});
  const [busy, setBusy] = useState<"" | "pw" | "google">("");
  const idRef = useRef<HTMLInputElement>(null);
  const pwRef = useRef<HTMLDivElement>(null);
  const googleClientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID?.trim() ?? "";

  // Already signed in: continue to the workspace instead of showing the form.
  useEffect(() => {
    if (!getSession()) return;
    routeAfterSignIn(next).then((to) => router.replace(to), () => undefined);
  }, [next, router]);

  async function enter(signIn: () => Promise<unknown>, kind: "pw" | "google") {
    setBusy(kind);
    setErrors({});
    try {
      await signIn();
      router.replace(await routeAfterSignIn(next));
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
    const e: Errors = { id: validateIdentifier(id), pw: pw ? undefined : "Enter your password." };
    if (e.id || e.pw) {
      setErrors(e);
      (e.id ? idRef.current : pwRef.current?.querySelector("input"))?.focus();
      return;
    }
    void enter(() => signInWithPassword(id, pw), "pw");
  }

  const forgotHref = id.includes("@") ? `/password-reset?email=${encodeURIComponent(id.trim())}` : "/password-reset";

  return (
    <AuthLayout aside={<Proof />}>
      <h1 className="t-title au-title">Sign in</h1>
      {googleClientId ? (
        <>
          <GoogleSignInButton
            clientId={googleClientId}
            disabled={!!busy}
            onCredential={(credential) => void enter(() => signInWithGoogle(credential), "google")}
            onError={(message) => setErrors({ form: message })}
          />
          <div className="au-or" role="separator">
            <span>or</span>
          </div>
        </>
      ) : null}
      {/* POST: a submit before hydration must never put the password in the address bar. */}
      <Form onSubmit={submit} method="post" validationBehavior="aria" className="flex flex-col">
        <TextField
          className="field"
          value={id}
          onChange={setId}
          isInvalid={!!errors.id}
          autoComplete="username"
          name="username"
          autoFocus
        >
          <Label>Email or username</Label>
          <Input ref={idRef} placeholder="name@company.com" />
          <FieldError>{errors.id}</FieldError>
        </TextField>
        <TextField
          ref={pwRef}
          className="field mt-16"
          value={pw}
          onChange={setPw}
          isInvalid={!!errors.pw}
          name="password"
        >
          <Label>Password</Label>
          <PasswordInput autoComplete="current-password" />
          <FieldError>{errors.pw}</FieldError>
        </TextField>
        <div className="row end au-forgot">
          <AuthLink href={forgotHref}>Forgot password?</AuthLink>
        </div>
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
          Sign in
        </Button>
      </Form>
      <p className="au-foot">
        New to BoMesh? <AuthLink href="/signup">Create account</AuthLink>
      </p>
    </AuthLayout>
  );
}
