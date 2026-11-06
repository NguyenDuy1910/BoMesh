"use client";

import { Button, InputGroup, ProgressBar } from "@heroui/react";
import { CheckCircle, CircleDashed, Eye, EyeOff, Layers } from "lucide-react";
import NextLink from "next/link";
import { useState, type ReactNode } from "react";

import { LanguagePicker } from "@/components/shell/LanguagePicker";
import { PASSWORD_RULES, passwordStrength } from "@/modules/auth/validation";

/** `.auth` page: form column (+ optional aside), as in the preview's auth layout. */
export function AuthLayout({
  single,
  innerClassName,
  aside,
  children,
}: {
  single?: boolean;
  innerClassName?: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className={single ? "auth auth--single au-page" : "auth au-page"}>
      <main className="auth__form">
        <div className={innerClassName ? `auth__form-inner ${innerClassName}` : "auth__form-inner"}>
          <div className="row au-brand">
            <div className="brand grow">
              <span className="brand__mark">
                <Layers className="i i-sm" aria-hidden />
              </span>
              BoMesh
            </div>
            <LanguagePicker />
          </div>
          {children}
        </div>
      </main>
      {aside ? <aside className="auth__aside au-aside">{aside}</aside> : null}
    </div>
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
export function PasswordInput({ autoComplete }: { autoComplete: string }) {
  const [show, setShow] = useState(false);
  return (
    <InputGroup className="au-pw" fullWidth>
      <InputGroup.Input type={show ? "text" : "password"} autoComplete={autoComplete} />
      <InputGroup.Suffix>
        <Button
          isIconOnly
          size="sm"
          variant="ghost"
          className="button--muted"
          aria-label={show ? "Hide password" : "Show password"}
          onPress={() => setShow((s) => !s)}
        >
          {show ? <EyeOff className="i" aria-hidden /> : <Eye className="i" aria-hidden />}
        </Button>
      </InputGroup.Suffix>
    </InputGroup>
  );
}

/** Strength meter + rules under a new-password input (`.au-strength`); render inside its TextField. */
export function PasswordStrength({ value }: { value: string }) {
  const strength = passwordStrength(value);
  return (
    <div className="au-strength" aria-live="polite">
      {strength ? (
        <div className="row gap-8">
          <ProgressBar aria-label="Password strength" value={strength.value} color={strength.tone} size="sm">
            <ProgressBar.Track>
              <ProgressBar.Fill />
            </ProgressBar.Track>
          </ProgressBar>
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
