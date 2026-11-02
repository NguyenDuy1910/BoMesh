"use client";

import { CheckCircle2, Eye, EyeOff, Info } from "lucide-react";
import { forwardRef, useState } from "react";

import { Button } from "@/components/ui/Button";
import { Input, type InputProps } from "@/components/ui/Input";
import { cn } from "@/lib/cn";
import { passwordRules } from "@/modules/auth/validation";

/** A password field with a show/hide toggle inside its right edge. */
export const PasswordInput = forwardRef<HTMLInputElement, Omit<InputProps, "type" | "suffix">>(
  function PasswordInput(props, ref) {
    const [visible, setVisible] = useState(false);
    return (
      <Input
        {...props}
        ref={ref}
        suffix={
          <Button
            aria-label={visible ? "Hide password" : "Show password"}
            aria-pressed={visible}
            className="-mr-1"
            icon={visible ? <EyeOff /> : <Eye />}
            iconOnly
            onClick={() => setVisible((value) => !value)}
            size="sm"
            variant="ghost"
          />
        }
        type={visible ? "text" : "password"}
      />
    );
  },
);

/** The new-password rules, ticking off as they are met. */
export function PasswordRules({ password, id }: { password: string; id?: string }) {
  return (
    <ul aria-live="polite" className="grid gap-1 text-meta text-text-tertiary" id={id}>
      {passwordRules(password).map((rule) => (
        <li className={cn("flex items-center gap-1.5", rule.met && "text-status-success")} key={rule.label}>
          {rule.met ? (
            <CheckCircle2 aria-hidden="true" className="size-3.5 shrink-0" />
          ) : (
            <Info aria-hidden="true" className="size-3.5 shrink-0" />
          )}
          {rule.label}
          <span className="sr-only">{rule.met ? "(met)" : "(not met yet)"}</span>
        </li>
      ))}
    </ul>
  );
}
