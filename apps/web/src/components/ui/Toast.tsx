"use client";

import { Toast, toast as heroToast } from "@heroui/react";
import { AlertCircle, CheckCircle2, Info, type LucideIcon } from "lucide-react";

/** Toast tone: `success` (default) confirms a change, `danger` reports a failure, `accent`/`warning` inform. */
export type ToastTone = "success" | "danger" | "accent" | "warning";

export interface ToastOptions {
  tone?: ToastTone;
  /** One action button (e.g. "View"). Pressing it runs `onPress` and dismisses the toast. */
  action?: { label: string; onPress: () => void };
  /** Cheap reversal: adds an "Undo" action (takes precedence over `action`). */
  undo?: () => void;
  /** Muted second line. */
  description?: string;
  /** Auto-dismiss after ms (default 8000 with an action, otherwise 4000; 0 keeps it open). Hover or focus pauses it. */
  duration?: number;
}

const TONE_ICON: Record<ToastTone, LucideIcon> = { success: CheckCircle2, danger: AlertCircle, accent: Info, warning: AlertCircle };

/**
 * Shows a toast (preview `toast(msg, { tone, action })`) through HeroUI's toast queue.
 * Mutations update data, then confirm with a toast; offer `undo` where the change is cheaply reversible.
 * Returns the toast id (`closeToast(id)` dismisses it).
 */
export function toast(message: string, options: ToastOptions = {}): string {
  const tone = options.tone ?? "success";
  const action = options.undo ? { label: "Undo", onPress: options.undo } : options.action;
  const Icon = TONE_ICON[tone];
  const id: string = heroToast(message, {
    variant: tone,
    description: options.description,
    indicator: <Icon className={`i toast__icon--${tone}`} aria-hidden />,
    timeout: options.duration ?? (action ? 8000 : 4000),
    actionProps: action
      ? {
          children: action.label,
          variant: "tertiary",
          size: "sm",
          onPress: () => {
            heroToast.close(id);
            action.onPress();
          },
        }
      : undefined,
  });
  return id;
}

/** Dismisses a toast returned by {@link toast}. */
export const closeToast = (id: string) => heroToast.close(id);

/**
 * Toast region; mount once in the root providers. A small note in the bottom-right corner, three visible, 360 px wide;
 * full width at the bottom on phones and above the chat composer on threads (components.css `.toast-region`).
 */
export function ToastHost() {
  return <Toast.Provider placement="bottom end" maxVisibleToasts={3} width={360} />;
}
