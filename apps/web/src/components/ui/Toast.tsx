"use client";

import { CheckCircle2, Info, X, XCircle } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { cn } from "@/lib/cn";

export type ToastTone = "ok" | "err" | "info" | "neutral";

export interface ToastOptions {
  /** Repeat the verb of the button that caused it: "Workspace archived". */
  message: string;
  /** An optional quiet second line. */
  description?: string;
  /** Defaults to `ok`. */
  tone?: ToastTone;
  /** One follow-up, e.g. Undo or "View run". Running it dismisses the toast. */
  action?: { label: string; onClick: () => void };
  /** Milliseconds on screen. Defaults to 4 s, 6.5 s with an action, 8 s for errors. */
  duration?: number;
}

interface ToastItem extends ToastOptions {
  id: string;
  tone: ToastTone;
}

interface ToastApi {
  /** Shows a toast and returns its id. */
  show: (options: ToastOptions) => string;
  dismiss: (id: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const context = useContext(ToastContext);
  if (!context) throw new Error("useToast must be used within ToastProvider");
  return context;
}

/** At most this many toasts are on screen; older ones give way. */
const MAX_VISIBLE = 3;

const toneIcon: Record<ToastTone, React.ReactNode> = {
  ok: <CheckCircle2 aria-hidden="true" className="h-[17px] w-[17px] shrink-0 text-[var(--status-success-on-inverse)]" />,
  err: <XCircle aria-hidden="true" className="h-[17px] w-[17px] shrink-0 text-[var(--status-danger-on-inverse)]" />,
  info: <Info aria-hidden="true" className="h-[17px] w-[17px] shrink-0 text-[var(--status-info-on-inverse)]" />,
  neutral: null,
};

function lifetime({ duration, action, tone }: ToastItem) {
  return duration ?? (tone === "err" ? 8000 : action ? 6500 : 4000);
}

interface Timer {
  handle: number;
  remaining: number;
  startedAt: number;
}

/**
 * Brief confirmations at the bottom centre of the screen, announced through a
 * polite live region. Hovering or focusing the stack pauses every timer, so a
 * person reaching for Undo never loses it. The region sits outside the app
 * root so a dialog making the page inert does not swallow it.
 */
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [mounted, setMounted] = useState(false);
  const timers = useRef(new Map<string, Timer>());
  const paused = useRef(false);
  const counter = useRef(0);

  useEffect(() => setMounted(true), []);

  const dismiss = useCallback((id: string) => {
    const timer = timers.current.get(id);
    if (timer) window.clearTimeout(timer.handle);
    timers.current.delete(id);
    setToasts((current) => current.filter((entry) => entry.id !== id));
  }, []);

  const schedule = useCallback(
    (id: string, remaining: number) => {
      const handle = paused.current ? 0 : window.setTimeout(() => dismiss(id), remaining);
      timers.current.set(id, { handle, remaining, startedAt: Date.now() });
    },
    [dismiss],
  );

  const show = useCallback(
    (options: ToastOptions) => {
      counter.current += 1;
      const item: ToastItem = { ...options, tone: options.tone ?? "ok", id: `toast-${counter.current}` };
      setToasts((current) => {
        const kept = current.slice(-(MAX_VISIBLE - 1));
        for (const dropped of current.slice(0, current.length - kept.length)) {
          window.clearTimeout(timers.current.get(dropped.id)?.handle);
          timers.current.delete(dropped.id);
        }
        return [...kept, item];
      });
      schedule(item.id, lifetime(item));
      return item.id;
    },
    [schedule],
  );

  const pause = useCallback(() => {
    if (paused.current) return;
    paused.current = true;
    const now = Date.now();
    for (const timer of timers.current.values()) {
      window.clearTimeout(timer.handle);
      timer.remaining = Math.max(0, timer.remaining - (now - timer.startedAt));
    }
  }, []);

  const resume = useCallback(() => {
    if (!paused.current) return;
    paused.current = false;
    for (const [id, timer] of timers.current) schedule(id, Math.max(timer.remaining, 1500));
  }, [schedule]);

  useEffect(() => {
    const active = timers.current;
    return () => {
      for (const timer of active.values()) window.clearTimeout(timer.handle);
    };
  }, []);

  const api = useMemo(() => ({ show, dismiss }), [show, dismiss]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      {mounted &&
        createPortal(
          <div
            aria-label="Notifications"
            aria-live="polite"
            className="pointer-events-none fixed bottom-5 left-1/2 z-[90] flex w-max max-w-[calc(100vw-24px)] -translate-x-1/2 flex-col items-center gap-2"
            data-layer-persistent=""
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) resume();
            }}
            onFocus={pause}
            onPointerEnter={pause}
            onPointerLeave={resume}
            role="status"
          >
            {toasts.map((entry) => (
              <div
                className={cn(
                  "pointer-events-auto flex w-full min-w-[min(280px,calc(100vw-24px))] max-w-[480px] items-center gap-2.5 py-2.5 pl-3.5 pr-2.5",
                  "rounded-[var(--radius-sheet)] bg-[var(--surface-inverse)] text-[length:var(--text-size-body)] text-[var(--text-inverse)] shadow-[var(--shadow-pop)]",
                  "motion-safe:animate-ui-pop",
                )}
                key={entry.id}
              >
                {toneIcon[entry.tone]}
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{entry.message}</p>
                  {entry.description && (
                    <p className="mt-0.5 text-[length:var(--text-size-meta)] opacity-80">{entry.description}</p>
                  )}
                </div>
                {entry.action && (
                  <button
                    className={toastButton}
                    onClick={() => {
                      entry.action?.onClick();
                      dismiss(entry.id);
                    }}
                    type="button"
                  >
                    {entry.action.label}
                  </button>
                )}
                <button
                  aria-label="Dismiss notification"
                  className={cn(toastButton, "px-1.5")}
                  onClick={() => dismiss(entry.id)}
                  type="button"
                >
                  <X aria-hidden="true" className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>,
          document.body,
        )}
    </ToastContext.Provider>
  );
}

const toastButton = cn(
  "shrink-0 rounded-[var(--radius-sm)] px-2 py-1 font-semibold text-inherit opacity-90",
  "transition-[background-color,opacity] duration-[var(--duration-fast)] hover:bg-[var(--surface-inverse-hover)] hover:opacity-100",
  "focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)] focus-visible:opacity-100",
);
