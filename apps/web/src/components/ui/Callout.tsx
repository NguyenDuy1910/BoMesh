"use client";

import { Alert } from "@heroui/react";
import { AlertCircle, AlertTriangle, CheckCircle2, Info, type LucideIcon } from "lucide-react";
import clsx from "clsx";
import type { ReactNode } from "react";
import type { Tone } from "./StatusChip";

const TONE_ICON: Record<Tone, LucideIcon> = { default: Info, accent: Info, success: CheckCircle2, warning: AlertTriangle, danger: AlertCircle };

export interface CalloutProps {
  tone?: Tone;
  title?: ReactNode;
  description?: ReactNode;
  /** The fix for the problem, as one or two buttons. */
  actions?: ReactNode;
  /** Overrides the tone's icon. */
  icon?: LucideIcon;
  /** Tinted background (default). `false` renders the surface-card look. */
  soft?: boolean;
  className?: string;
}

/**
 * Inline alert (preview `alertBox()`, HeroUI Alert): one alert per problem, with its fix as the action.
 * Danger alerts are announced (`role="alert"`), others are polite status.
 */
export function Callout({ tone = "default", title, description, actions, icon, soft = true, className }: CalloutProps) {
  const Icon = icon ?? TONE_ICON[tone];
  return (
    <Alert status={tone} className={clsx(soft && "alert--soft", className)} role={tone === "danger" ? "alert" : "status"}>
      <Alert.Indicator>
        <Icon className="i" aria-hidden />
      </Alert.Indicator>
      <Alert.Content>
        {title ? <Alert.Title>{title}</Alert.Title> : null}
        {description ? <Alert.Description>{description}</Alert.Description> : null}
      </Alert.Content>
      {actions ? <div className="alert__actions">{actions}</div> : null}
    </Alert>
  );
}
