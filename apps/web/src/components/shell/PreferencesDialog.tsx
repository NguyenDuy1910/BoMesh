"use client";

import { Button, Description, FieldError, Input, Label, Modal, TextField } from "@heroui/react";
import { useQueryClient } from "@tanstack/react-query";
import { Palette, Settings } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { SkeletonRows } from "@/components/ui/SkeletonRows";
import { SwitchRow } from "@/components/ui/SwitchRow";
import { toast } from "@/components/ui/Toast";
import { api, call, errorMessage, type Schema } from "@/lib/api/client";
import { updateSessionUser, useSession } from "@/lib/session";
import { accentColor, accentOf, fontById, MODE_LABEL, themeLabel } from "@/lib/theme";
import { useOptionalWorkspace } from "@/lib/workspace";

import { LanguageField } from "./LanguagePicker";
import { closeOverlay, openAppearance, useShellOverlays } from "./overlays";
import { updateMyPreferences, useMyPreferences } from "./preferences";
import { useAppearance } from "./useAppearance";

type Notifications = Schema<"UserEmailNotifications">;

/** Current theme summary with a Change button (opens the Appearance drawer). */
function AppearanceRow() {
  const a = useAppearance();
  return (
    <div className="field">
      <span className="label">Appearance</span>
      <div className="pref-look">
        <span className="theme-dot" style={{ background: accentColor(a.look, a.dark) }} aria-hidden />
        <span className="grow">
          <span className="medium">{themeLabel(a.look)}</span>
          <span className="t-xs muted" style={{ display: "block" }}>
            {`${MODE_LABEL[a.mode]} mode · ${accentOf(a.look).label} accent · ${fontById(a.look.font).label}`}
          </span>
        </span>
        <Button size="sm" variant="tertiary" onPress={openAppearance}>
          <Palette className="i" aria-hidden />
          Change
        </Button>
      </div>
    </div>
  );
}

/**
 * Mounted once the account preferences have loaded, so the switches start from the saved values. Everything applies
 * immediately (preview `M.prefs`): each switch saves at once with an Undo toast, the display name commits on Enter or
 * when the field loses focus, and the footer is a single Done. An uncommitted name draft is dropped on close.
 */
function PreferencesForm({ prefs }: { prefs: Schema<"UserPreferences"> | undefined }) {
  const session = useSession();
  const queryClient = useQueryClient();
  const ws = useOptionalWorkspace();
  const { prefsFocus } = useShellOverlays();
  const admin = ws?.can("workspaces.updateSettings") ?? false;
  const saved = session?.user.displayName ?? "";
  const [name, setName] = useState(saved);
  const [error, setError] = useState("");
  const [steps, setSteps] = useState(prefs?.showWorkSteps !== false);
  const [notif, setNotif] = useState<Notifications>({
    sourceFailures: true,
    accessRequests: true,
    citedDocumentChanges: true,
    weeklySummary: true,
    ...prefs?.emailNotifications,
  });
  const notifHead = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (prefsFocus === "notifications") requestAnimationFrame(() => notifHead.current?.scrollIntoView({ block: "start", behavior: "smooth" }));
  }, [prefsFocus]);

  const saveName = async (displayName: string) => {
    const user = await call(
      api.PATCH("/api/v1/users/{user}", {
        params: { path: { user: "me" }, query: { updateMask: "displayName" } },
        // `email` is required by the schema; the mask limits the update to the display name.
        body: { email: session?.user.email ?? "", displayName },
      }),
    );
    updateSessionUser({ displayName: user.displayName ?? displayName });
  };

  const commitName = () => {
    const displayName = name.trim();
    if (!displayName) {
      setError("Enter a display name.");
      return;
    }
    setError("");
    if (displayName === saved) return;
    const before = saved;
    saveName(displayName).then(
      () => toast("Display name updated", { undo: () => void saveName(before).then(() => setName(before), (e: unknown) => toast(errorMessage(e), { tone: "danger" })) }),
      (e: unknown) => toast(errorMessage(e), { tone: "danger" }),
    );
  };

  const flipSteps = (on: boolean) => {
    const save = (v: boolean) => {
      setSteps(v);
      return updateMyPreferences(queryClient, { showWorkSteps: v }, "showWorkSteps");
    };
    save(on).then(
      () => toast(on ? "Answer steps shown" : "Answer steps hidden", { undo: () => void save(!on).catch((e: unknown) => toast(errorMessage(e), { tone: "danger" })) }),
      (e: unknown) => {
        setSteps(!on);
        toast(errorMessage(e), { tone: "danger" });
      },
    );
  };

  const toggle = (key: keyof Notifications) => (on: boolean) => {
    const save = (v: boolean) => {
      const next = { ...notif, [key]: v };
      setNotif(next);
      return updateMyPreferences(queryClient, { emailNotifications: next }, "emailNotifications");
    };
    save(on).then(
      () => toast(on ? "Email notification turned on" : "Email notification turned off", { undo: () => void save(!on).catch((e: unknown) => toast(errorMessage(e), { tone: "danger" })) }),
      (e: unknown) => {
        setNotif((n) => ({ ...n, [key]: !on }));
        toast(errorMessage(e), { tone: "danger" });
      },
    );
  };

  return (
    <>
      <Modal.Body>
        <div className="stack gap-16">
          <TextField
            fullWidth
            value={name}
            onChange={(v) => {
              setName(v);
              if (error && v.trim()) setError("");
            }}
            onBlur={commitName}
            onKeyDown={(e) => {
              // React Aria stops keyboard propagation by default; let Esc reach the dialog so it closes from here too.
              if (e.key === "Enter") commitName();
              else e.continuePropagation();
            }}
            isInvalid={Boolean(error)}
            autoFocus={!prefsFocus}
          >
            <Label>Display name</Label>
            <Input autoComplete="name" />
            {error ? <FieldError>{error}</FieldError> : <Description>Press Enter to save.</Description>}
          </TextField>
          <TextField fullWidth value={session?.user.email ?? ""} isReadOnly>
            <Label>Email</Label>
            <Input translate="no" />
            <Description>Managed by your sign-in provider.</Description>
          </TextField>
          <AppearanceRow />
          <LanguageField />
        </div>
        <div className="mt-16">
          <SwitchRow title="Show how answers were found" description="Show the searches and analysis steps above each answer." isSelected={steps} onChange={flipSteps} />
        </div>
        <h3 className="t-subheading mt-16" id="pref-notif" ref={notifHead}>
          Email notifications
        </h3>
        {admin && (
          <>
            <SwitchRow
              title="A source stops syncing"
              description="So knowledge doesn’t go stale unnoticed."
              isSelected={notif.sourceFailures !== false}
              onChange={toggle("sourceFailures")}
            />
            <SwitchRow
              title="Someone requests access"
              description="For collections you own."
              isSelected={notif.accessRequests !== false}
              onChange={toggle("accessRequests")}
            />
          </>
        )}
        <SwitchRow
          title="Documents I rely on change"
          description="When a source cited in your chats is updated."
          isSelected={notif.citedDocumentChanges !== false}
          onChange={toggle("citedDocumentChanges")}
        />
        <SwitchRow
          title="Weekly summary"
          description={admin ? "Questions, knowledge gaps and sync health." : "New knowledge shared with you."}
          isSelected={notif.weeklySummary !== false}
          onChange={toggle("weeklySummary")}
        />
      </Modal.Body>
      <Modal.Footer>
        <Button slot="close" variant="primary">
          Done
        </Button>
      </Modal.Footer>
    </>
  );
}

/** Personal settings (preview `M.prefs`). */
export function PreferencesDialog() {
  const { open } = useShellOverlays();
  const prefs = useMyPreferences();
  const ready = !prefs.isPending || prefs.fetchStatus === "idle";
  return (
    <Modal.Backdrop isOpen={open === "preferences"} onOpenChange={(o) => !o && closeOverlay()}>
      <Modal.Container size="lg" scroll="inside">
        <Modal.Dialog>
          <Modal.CloseTrigger aria-label="Close" />
          <Modal.Header>
            <Modal.Icon aria-hidden>
              <Settings className="i" />
            </Modal.Icon>
            <div className="grow min-w-0">
              <Modal.Heading>Preferences</Modal.Heading>
              <p className="modal__description">Changes apply right away and are saved for you.</p>
            </div>
          </Modal.Header>
          {open === "preferences" &&
            (ready ? (
              <PreferencesForm prefs={prefs.data} />
            ) : (
              <Modal.Body>
                <SkeletonRows rows={4} />
              </Modal.Body>
            ))}
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
