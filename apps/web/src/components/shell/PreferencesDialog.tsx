"use client";

import { Check } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useCurrentWorkspace } from "@/components/shell/useCurrentWorkspace";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Dialog } from "@/components/ui/Dialog";
import { Avatar } from "@/components/ui/Avatar";
import { PreviewTag } from "@/components/ui/PreviewTag";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Skeleton } from "@/components/ui/Skeleton";
import { Switch } from "@/components/ui/Switch";
import { useToast } from "@/components/ui/Toast";
import { Tooltip } from "@/components/ui/Tooltip";
import {
  ACCENT_OPTIONS,
  BACKGROUND_OPTIONS,
  DENSITY_OPTIONS,
  THEME_OPTIONS,
  WORKSPACE_ACCENT_KEY_PREFIX,
  type AccentPreference,
} from "@/lib/appearance";
import { usePendingFeature } from "@/lib/api/pending";
import { hasSessionPermission } from "@/lib/auth/session";
import { cn } from "@/lib/cn";
import { useAccountPreferences } from "@/lib/hooks/useAccountPreferences";
import {
  getNotificationPreferences,
  updateNotificationPreferences,
  type EmailNotificationPreferences,
} from "@/modules/account/api";

type NotificationKey = keyof EmailNotificationPreferences;

/**
 * Profile & preferences (prototype `M.prefs`). Appearance applies the moment
 * it is chosen (stored on this device); email notifications are saved with
 * "Save changes".
 */
export function PreferencesDialog({
  open,
  onClose,
  section,
}: {
  open: boolean;
  onClose: () => void;
  /** Opened from the inbox's "Notification settings": scroll to that section. */
  section: "profile" | "notifications";
}) {
  const toast = useToast();
  const { viewer, workspace, session } = useCurrentWorkspace();
  const { preferences, updatePreferences } = useAccountPreferences();
  const notificationsEnabled = usePendingFeature("account.notification_prefs");
  const [notifications, setNotifications] = useState<EmailNotificationPreferences | null>(null);
  const [saved, setSaved] = useState<EmailNotificationPreferences | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [brandSwatch, setBrandSwatch] = useState("var(--accent-swatch-indigo)");
  const notificationsRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setSaveError(null);
    try {
      const cached = workspace ? window.localStorage.getItem(WORKSPACE_ACCENT_KEY_PREFIX + workspace.id) : null;
      setBrandSwatch(`var(--accent-swatch-${ACCENT_OPTIONS.some((option) => option.value === cached) ? cached : "indigo"})`);
    } catch {
      setBrandSwatch("var(--accent-swatch-indigo)");
    }
    if (!notificationsEnabled) return;
    let cancelled = false;
    setLoadError(false);
    setNotifications(null);
    getNotificationPreferences()
      .then((value) => {
        if (cancelled) return;
        setNotifications(value.email);
        setSaved(value.email);
      })
      .catch(() => {
        if (!cancelled) setLoadError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [open, notificationsEnabled, workspace]);

  useEffect(() => {
    if (open && section === "notifications" && notifications) {
      notificationsRef.current?.scrollIntoView({ block: "start" });
    }
  }, [open, section, notifications]);

  const dirty = Boolean(notifications && saved && (Object.keys(notifications) as NotificationKey[]).some((key) => notifications[key] !== saved[key]));

  const save = async () => {
    if (!notifications || !dirty) {
      onClose();
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const next = await updateNotificationPreferences({ email: notifications });
      setSaved(next.email);
      toast.show({ message: "Preferences saved" });
      onClose();
    } catch {
      setSaveError("Your notification choices weren’t saved. Try again.");
    } finally {
      setSaving(false);
    }
  };

  const reviewsSources = hasSessionPermission(session, "source.manage");
  const reviewsAccess = hasSessionPermission(session, "access.manage");
  const rows: { key: NotificationKey; title: string; hint: string; show: boolean }[] = [
    { key: "source_sync_failures", title: "A source stops syncing", hint: "So knowledge doesn’t go stale unnoticed.", show: reviewsSources },
    { key: "access_requests", title: "Someone requests access", hint: "For knowledge bases you own.", show: reviewsAccess },
    { key: "cited_document_changes", title: "Documents I rely on change", hint: "When a source cited in your chats is updated or removed.", show: true },
    {
      key: "weekly_summary",
      title: "Weekly summary",
      hint: reviewsSources || reviewsAccess ? "Questions asked, knowledge gaps and sync health." : "New knowledge shared with you.",
      show: true,
    },
  ];

  const accentChoices: { value: AccentPreference; label: string; swatch: string }[] = [
    { value: "workspace", label: `${workspace?.name ?? "Workspace"} brand`, swatch: brandSwatch },
    ...ACCENT_OPTIONS,
  ];

  return (
    <Dialog
      busy={saving}
      footer={notificationsEnabled ? (
        <>
          <Button onClick={onClose} variant="secondary">Cancel</Button>
          <Button loading={saving} onClick={() => void save()} variant="primary">Save changes</Button>
        </>
      ) : (
        <Button onClick={onClose} variant="primary">Done</Button>
      )}
      onClose={onClose}
      open={open}
      size="lg"
      title="Profile & preferences"
    >
      <div className="flex items-center gap-3">
        <Avatar name={viewer?.name ?? "Signed in"} size="lg" />
        <div className="min-w-0">
          <p className="truncate font-semibold text-[var(--text-primary)]">{viewer?.name}</p>
          <p className="truncate text-[length:var(--text-size-meta)] text-[var(--text-secondary)]">{viewer?.email}</p>
        </div>
        <p className="ml-auto max-w-[220px] text-right text-[length:var(--text-size-meta)] text-[var(--text-tertiary)]">
          Your name and email are managed by your sign-in provider.
        </p>
      </div>

      <hr className="my-5 border-[var(--border-subtle)]" />
      <div className="mb-3 flex items-center justify-between gap-4">
        <h3 className="text-[length:var(--text-size-section)] font-semibold text-[var(--text-primary)]">Appearance</h3>
        <span className="text-[length:var(--text-size-meta)] text-[var(--text-tertiary)]">Changes apply right away</span>
      </div>

      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <span className="text-[length:var(--text-size-meta)] font-medium text-[var(--text-primary)]">Mode</span>
          <SegmentedControl ariaLabel="Mode" onChange={(theme) => updatePreferences({ theme })} options={THEME_OPTIONS} value={preferences.theme} />
        </div>

        <fieldset className="flex flex-col gap-1.5">
          <legend className="mb-1.5 text-[length:var(--text-size-meta)] font-medium text-[var(--text-primary)]">Accent color</legend>
          <div className="flex flex-wrap items-center gap-2">
            {accentChoices.map((choice) => {
              const checked = preferences.accent === choice.value;
              return (
                <Tooltip key={choice.value} label={choice.label}>
                  <label
                    className={cn(
                      "relative grid size-8 cursor-pointer place-items-center rounded-full text-[var(--text-on-accent)]",
                      "has-[:focus-visible]:shadow-(--shadow-focus)",
                      choice.value === "workspace" && "ring-2 ring-[var(--border-default)] ring-offset-2 ring-offset-[var(--surface-raised)]",
                    )}
                    style={{ background: choice.swatch }}
                  >
                    <input
                      aria-label={choice.label}
                      checked={checked}
                      className="sr-only"
                      name="pref-accent"
                      onChange={() => updatePreferences({ accent: choice.value })}
                      type="radio"
                      value={choice.value}
                    />
                    {checked && <Check aria-hidden="true" className="size-4" />}
                  </label>
                </Tooltip>
              );
            })}
          </div>
          <p className="text-[length:var(--text-size-meta)] text-[var(--text-tertiary)]">
            Buttons, selection and links. Status colors and evidence highlights never change.
          </p>
        </fieldset>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <span className="text-[length:var(--text-size-meta)] font-medium text-[var(--text-primary)]">Background</span>
            <SegmentedControl ariaLabel="Background" onChange={(background) => updatePreferences({ background })} options={BACKGROUND_OPTIONS} value={preferences.background} />
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-[length:var(--text-size-meta)] font-medium text-[var(--text-primary)]">Density</span>
            <SegmentedControl ariaLabel="Density" onChange={(density) => updatePreferences({ density })} options={DENSITY_OPTIONS} value={preferences.density} />
          </div>
        </div>

        <div className="flex items-center justify-between gap-4 pt-1">
          <div>
            <div className="font-medium text-[var(--text-primary)]" id="pref-activity-title">Show how answers were found</div>
            <div className="text-[length:var(--text-size-meta)] text-[var(--text-tertiary)]" id="pref-activity-hint">
              Display searches and analysis steps above each answer.
            </div>
          </div>
          <Switch
            aria-labelledby="pref-activity-title"
            checked={preferences.showAgentActivity}
            describedBy="pref-activity-hint"
            onChange={(showAgentActivity) => updatePreferences({ showAgentActivity })}
          />
        </div>
      </div>

      {notificationsEnabled && (
        <section aria-labelledby="pref-notifications" className="scroll-mt-4" ref={notificationsRef}>
          <hr className="my-5 border-[var(--border-subtle)]" />
          <h3 className="mb-1 flex items-center gap-2 text-[length:var(--text-size-section)] font-semibold text-[var(--text-primary)]" id="pref-notifications">
            Email notifications <PreviewTag />
          </h3>
          {loadError ? (
            <Callout tone="err">Your notification choices didn’t load. Close this and try again.</Callout>
          ) : !notifications ? (
            <div aria-label="Loading notification choices" className="flex flex-col gap-3 py-2" role="status">
              <Skeleton className="h-10" />
              <Skeleton className="h-10" />
            </div>
          ) : (
            rows.filter((row) => row.show).map((row) => (
              <div className="flex items-center justify-between gap-4 py-2" key={row.key}>
                <div>
                  <div className="font-medium text-[var(--text-primary)]" id={`pref-n-${row.key}`}>{row.title}</div>
                  <div className="text-[length:var(--text-size-meta)] text-[var(--text-tertiary)]" id={`pref-n-${row.key}-hint`}>{row.hint}</div>
                </div>
                <Switch
                  aria-labelledby={`pref-n-${row.key}`}
                  checked={notifications[row.key]}
                  describedBy={`pref-n-${row.key}-hint`}
                  onChange={(checked) => setNotifications({ ...notifications, [row.key]: checked })}
                />
              </div>
            ))
          )}
          {saveError && <Callout className="mt-3" tone="err">{saveError}</Callout>}
        </section>
      )}
    </Dialog>
  );
}
