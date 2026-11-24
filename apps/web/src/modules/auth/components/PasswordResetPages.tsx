"use client";

import { Alert, Button, Description, FieldError, Form, Input, Label, TextField } from "@heroui/react";
import { Clock, Mail } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useState, type FormEvent } from "react";

import { LinkButton, toast } from "@/components/ui";
import { ApiError, errorMessage } from "@/lib/api/client";
import { serverText } from "@/lib/i18n";
import { resetPassword, sendPasswordReset } from "@/modules/auth/api";
import { AuthLayout, AuthLink, AuthMark, PasswordInput, PasswordStrength } from "@/modules/auth/components/AuthLayout";
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
  const router = useRouter();
  const initialEmail = useSearchParams().get("email") ?? "";
  const [email, setEmail] = useState(initialEmail);
  const [error, setError] = useState<string>();
  const [formError, setFormError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    if (busy) return;
    if (!EMAIL_RE.test(email.trim())) return setError("Nhập email, ví dụ name@company.com.");
    setError(undefined);
    setFormError(undefined);
    setBusy(true);
    try {
      await sendPasswordReset(email);
      if (sentTo) toast("Đã gửi lại. Hãy dùng email mới nhất.", { tone: "accent" });
      setSentTo(email.trim());
    } catch (e) {
      setFormError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  if (sentTo) {
    return (
      <AuthLayout art>
        <AuthMark icon={Mail} />
        <h1 className="t-title au-title">Kiểm tra email</h1>
        <p className="muted au-sub">{`Nếu có tài khoản dùng ${sentTo}, chúng tôi đã gửi tới đó một liên kết để chọn mật khẩu mới. Liên kết chỉ dùng được một lần, trong 30 phút.`}</p>
        <div className="flex flex-col gap-16">
          {formError ? <FormAlert>{formError}</FormAlert> : null}
          <Button variant="primary" size="lg" fullWidth onPress={() => router.push("/signin")}>
            Quay lại đăng nhập
          </Button>
        </div>
        <p className="au-foot">
          Không thấy email? Hãy xem thư mục spam, hoặc <LinkButton onPress={() => void submit()}>gửi lại</LinkButton>
        </p>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout art>
      <h1 className="t-title au-title">Đặt lại mật khẩu</h1>
      <p className="muted au-sub">Nhập email bạn dùng để đăng nhập. Chúng tôi sẽ gửi cho bạn một liên kết để chọn mật khẩu mới.</p>
      <Form onSubmit={submit} method="post" validationBehavior="aria" className="au-form">
        <TextField
          className="field"
          type="email"
          value={email}
          onChange={(v) => {
            setEmail(v);
            setError(undefined);
          }}
          isInvalid={!!error}
          autoFocus
          autoComplete="email"
        >
          <Label>Email</Label>
          <Input placeholder="name@company.com" />
          <FieldError>{error}</FieldError>
        </TextField>
        {formError ? <FormAlert>{formError}</FormAlert> : null}
        <Button type="submit" variant="primary" size="lg" fullWidth isPending={busy}>
          Gửi liên kết đặt lại
        </Button>
      </Form>
      <p className="au-foot">
        <AuthLink href="/signin">Quay lại đăng nhập</AuthLink>
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
    if (!passwordAcceptable(pw)) return setError("Dùng ít nhất 8 ký tự gồm chữ và số.");
    setError(undefined);
    setFormError(undefined);
    setBusy(true);
    try {
      await resetPassword(token, pw);
      toast("Đã đổi mật khẩu. Hãy đăng nhập bằng mật khẩu mới.", { tone: "success" });
      router.replace("/signin");
    } catch (e) {
      setBusy(false);
      if (e instanceof ApiError && e.reason === "RESET_TOKEN_INVALID") setInvalidToken(true);
      else if (e instanceof ApiError && e.fieldViolations.length) setError(serverText(e.fieldViolations[0].description));
      else setFormError(errorMessage(e));
    }
  }

  if (invalidToken) {
    return (
      <AuthLayout art>
        <AuthMark icon={Clock} warn />
        <h1 className="t-title au-title">Liên kết này không còn dùng được</h1>
        <p className="muted au-sub">Liên kết đặt lại chỉ dùng được một lần, trong 30 phút. Hãy yêu cầu liên kết mới và dùng email mới nhất.</p>
        <Button variant="primary" size="lg" fullWidth onPress={() => router.push("/password-reset")}>
          Gửi liên kết mới
        </Button>
        <p className="au-foot">
          <AuthLink href="/signin">Quay lại đăng nhập</AuthLink>
        </p>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout art>
      <h1 className="t-title au-title">Chọn mật khẩu mới</h1>
      <p className="muted au-sub">Bạn sẽ bị đăng xuất ở mọi nơi và có thể đăng nhập bằng mật khẩu mới.</p>
      <Form onSubmit={submit} method="post" validationBehavior="aria" className="au-form">
        <TextField
          className="field"
          value={pw}
          onChange={(v) => {
            setPw(v);
            setError(undefined);
          }}
          isInvalid={!!error}
          autoFocus
        >
          <Label>Mật khẩu mới</Label>
          <PasswordInput autoComplete="new-password" />
          {pw ? <PasswordStrength value={pw} /> : error ? null : <Description>Ít nhất 8 ký tự, gồm chữ và số.</Description>}
          <FieldError>{error}</FieldError>
        </TextField>
        {formError ? <FormAlert>{formError}</FormAlert> : null}
        <Button type="submit" variant="primary" size="lg" fullWidth isPending={busy}>
          Đổi mật khẩu
        </Button>
      </Form>
      <p className="au-foot">
        <AuthLink href="/signin">Quay lại đăng nhập</AuthLink>
      </p>
    </AuthLayout>
  );
}
