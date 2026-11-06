"use client";

import { Button, Description, Input, Label, Modal, TextField } from "@heroui/react";
import { useQueryClient } from "@tanstack/react-query";
import { Palette } from "lucide-react";
import { useState } from "react";

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
            {MODE_LABEL[a.mode]} mode · {accentOf(a.look).label} accent · {fontById(a.look.font).label}
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

/** Mounted once the account preferences have loaded, so the switches start from the saved values. */
function PreferencesForm({ prefs }: { prefs: Schema<"UserPreferences"> | undefined }) {
  const session = useSession();
  const queryClient = useQueryClient();
  const ws = useOptionalWorkspace();
  const admin = ws?.can("workspaces.updateSettings") ?? false;
  const [name, setName] = useState(session?.user.displayName ?? "");
  const [steps, setSteps] = useState(prefs?.showWorkSteps !== false);
  const [notif, setNotif] = useState<Notifications>({
    sourceFailures: true,
    accessRequests: true,
    citedDocumentChanges: true,
    weeklySummary: true,
    ...prefs?.emailNotifications,
  });
  const [saving, setSaving] = useState(false);
  const [invalid, setInvalid] = useState(false);

  const toggle = (key: keyof Notifications) => (on: boolean) => setNotif((n) => ({ ...n, [key]: on }));

  const save = async () => {
    const displayName = name.trim();
    if (!displayName) {
      setInvalid(true);
      toast("Enter a display name.", { tone: "danger" });
      return;
    }
    setSaving(true);
    try {
      if (displayName !== session?.user.displayName) {
        const user = await call(
          api.PATCH("/api/v1/users/{user}", {
            params: { path: { user: "me" }, query: { updateMask: "displayName" } },
            // `email` is required by the schema; the mask limits the update to the display name.
            body: { email: session?.user.email ?? "", displayName },
          }),
        );
        updateSessionUser({ displayName: user.displayName ?? displayName });
      }
      await updateMyPreferences(queryClient, { showWorkSteps: steps, emailNotifications: notif }, "showWorkSteps,emailNotifications");
      closeOverlay();
      toast("Preferences saved");
    } catch (e) {
      toast(errorMessage(e), { tone: "danger" });
    } finally {
      setSaving(false);
    }
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
              setInvalid(false);
            }}
            isInvalid={invalid}
            autoFocus
          >
            <Label>Display name</Label>
            <Input />
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
          <SwitchRow
            title="Show how answers were found"
            description="Show the searches and analysis steps above each answer."
            isSelected={steps}
            onChange={setSteps}
          />
        </div>
        <h3 className="t-subheading mt-16">Email notifications</h3>
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
              description="For knowledge bases you own."
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
        <Button slot="close" variant="tertiary">
          Cancel
        </Button>
        <Button variant="primary" isPending={saving} onPress={() => void save()}>
          Save
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
            <Modal.Heading>Preferences</Modal.Heading>
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
