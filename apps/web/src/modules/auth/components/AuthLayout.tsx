"use client";

import { Button, InputGroup } from "@heroui/react";
import { CheckCircle, CircleDashed, Eye, EyeOff, Layers, type LucideIcon } from "lucide-react";
import NextLink from "next/link";
import { useState, type ReactNode } from "react";

import { ProgressBar } from "@/components/ui/ProgressBar";
import { AuthAside } from "@/modules/auth/components/AuthArt";
import { PASSWORD_RULES, passwordStrength } from "@/modules/auth/validation";

/**
 * Every auth page (preview `shell()` in features/auth.js): the brand bar, the centred content and a footer; `art` adds
 * the brand panel beside it (sign in, create account, password reset). Link landings and the workspace chooser are one
 * column.
 */
export function AuthLayout({
  art,
  innerClassName,
  children,
}: {
  art?: boolean;
  innerClassName?: string;
  children: ReactNode;
}) {
  return (
    <div className={art ? "auth au-page" : "auth auth--single au-page"}>
      <main className="auth__form">
        <div className="au-brand">
          <div className="brand">
            <span className="brand__mark">
              <Layers className="i i-sm" aria-hidden />
            </span>
            BoMesh
          </div>
        </div>
        <div className={innerClassName ? `auth__form-inner ${innerClassName}` : "auth__form-inner"}>{children}</div>
        <footer className="au-legal">© {new Date().getFullYear()} BoMesh</footer>
      </main>
      {art ? <AuthAside /> : null}
    </div>
  );
}

/** The status mark above a landing's title (`.au-mark`): accent, or warning when something didn't work. */
export function AuthMark({ icon: Icon, warn }: { icon: LucideIcon; warn?: boolean }) {
  return (
    <span className={warn ? "au-mark au-mark--warn" : "au-mark"}>
      <Icon className="i" aria-hidden />
    </span>
  );
}

/** In-app link styled as HeroUI's link (preview link button). */
export function AuthLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <NextLink href={href} className="link link-button">
      {children}
    </NextLink>
  );
}

/** Password input with a show/hide icon button (`.au-pw`); render inside a HeroUI TextField. */
export function PasswordInput({ autoComplete, autoFocus }: { autoComplete: string; autoFocus?: boolean }) {
  const [show, setShow] = useState(false);
  return (
    <InputGroup className="au-pw" fullWidth>
      <InputGroup.Input type={show ? "text" : "password"} autoComplete={autoComplete} autoFocus={autoFocus} />
      <InputGroup.Suffix>
        <Button
          isIconOnly
          size="sm"
          variant="ghost"
          className="button--muted"
          aria-label={show ? "Ẩn mật khẩu" : "Hiện mật khẩu"}
          onPress={() => setShow((s) => !s)}
        >
          {show ? <EyeOff className="i" aria-hidden /> : <Eye className="i" aria-hidden />}
        </Button>
      </InputGroup.Suffix>
    </InputGroup>
  );
}

/** Strength meter + rules under a new-password input (`.au-strength`); render inside its TextField once there's a password. */
export function PasswordStrength({ value }: { value: string }) {
  const strength = passwordStrength(value);
  return (
    <div className="au-strength" aria-live="polite">
      {strength ? (
        <div className="row gap-8">
          <ProgressBar value={strength.value} tone={strength.tone} label="Độ mạnh mật khẩu" />
          <span className="t-xs medium au-strength__label">{strength.label}</span>
        </div>
      ) : null}
      <ul className="au-rules">
        {PASSWORD_RULES.map((rule) => {
          const ok = rule.test(value);
          return (
            <li key={rule.label} className={ok ? "is-ok" : undefined}>
              {ok ? <CheckCircle className="i i-sm" aria-hidden /> : <CircleDashed className="i i-sm" aria-hidden />}
              {rule.label}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
