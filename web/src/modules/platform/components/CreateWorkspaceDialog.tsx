"use client";

import { TriangleAlert } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Dialog } from "@/components/ui/Dialog";
import { FormField } from "@/components/ui/FormField";
import { Input } from "@/components/ui/Input";
import { PreviewTag } from "@/components/ui/PreviewTag";
import { ApiError } from "@/lib/api/request";
import { hasPlatformPermission } from "@/lib/auth/session";
import { useAuthSession } from "@/lib/hooks/useAuthSession";
import { workspaceDirectoryApi } from "@/modules/manage/access/directory";
import { createPlatformWorkspace, type PlatformWorkspace } from "@/modules/platform/api";
import { useOriginHost } from "@/modules/platform/components/WorkspaceMark";
import { workspaceCodeProblem } from "@/modules/platform/workspace-code";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

type Field = "name" | "code" | "email";

/** A web address suggested from the name: accents folded, words joined by hyphens. */
function suggestCode(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/, "");
}

/**
 * Create a workspace for a customer or team. The web address follows the
 * name until it is edited; the first admin's email is checked against existing
 * accounts when the caller may read them, so a typo shows before submitting.
 */
export function CreateWorkspaceDialog({
  open,
  onClose,
  existing,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  /** Workspaces already listed, so a taken address is caught before the server says so. */
  existing: readonly PlatformWorkspace[];
  onCreated: (workspace: PlatformWorkspace) => void;
}) {
  const formId = useId();
  const ids = { name: `${formId}-name`, code: `${formId}-code`, email: `${formId}-email` };
  const host = useOriginHost();
  const session = useAuthSession();
  const canReadAccounts = hasPlatformPermission(session, "platform.user.read");

  const [name, setName] = useState("");
  const [codeDraft, setCodeDraft] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [touched, setTouched] = useState<Record<Field, boolean>>({ name: false, code: false, email: false });
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<{ field: Field | null; message: string } | null>(null);
  const [accountKnown, setAccountKnown] = useState<boolean | null>(null);
  const fields = useRef<Record<Field, HTMLInputElement | null>>({ name: null, code: null, email: null });

  const code = codeDraft ?? suggestCode(name);
  const trimmedEmail = email.trim().toLowerCase();
  const emailValid = EMAIL_PATTERN.test(trimmedEmail);

  useEffect(() => {
    if (!open) return;
    setName("");
    setCodeDraft(null);
    setEmail("");
    setTouched({ name: false, code: false, email: false });
    setSubmitted(false);
    setServerError(null);
    setAccountKnown(null);
  }, [open]);

  useEffect(() => {
    setAccountKnown(null);
    if (!open || !emailValid || !canReadAccounts) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      workspaceDirectoryApi.platform.users(trimmedEmail)
        .then((page) => {
          if (!controller.signal.aborted) setAccountKnown(page.items.some((user) => user.email.toLowerCase() === trimmedEmail));
        })
        .catch(() => {
          if (!controller.signal.aborted) setAccountKnown(null);
        });
    }, 400);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [canReadAccounts, emailValid, open, trimmedEmail]);

  const taken = existing.find((workspace) => workspace.code === code);
  const errors: Partial<Record<Field, string>> = {};
  if (!name.trim()) errors.name = "Enter a name for the workspace.";
  else if (name.trim().length < 2) errors.name = "Use at least 2 characters.";
  const codeProblem = workspaceCodeProblem(code);
  if (codeProblem) errors.code = codeProblem;
  else if (taken) errors.code = `${host ? `${host}/` : ""}${code} is already used by ${taken.name}. Try another.`;
  else if (serverError?.field === "code") errors.code = serverError.message;
  if (!trimmedEmail) errors.email = "Enter the email of the person who will run this workspace.";
  else if (!emailValid) errors.email = "Enter a full email address, like sam@company.com.";

  const visible: Partial<Record<Field, string>> = {
    name: submitted || touched.name ? errors.name : undefined,
    code: submitted || touched.code || touched.name || taken || serverError?.field === "code" ? errors.code : undefined,
    email: submitted || touched.email ? errors.email : undefined,
  };

  const touch = (field: Field) => setTouched((current) => (current[field] ? current : { ...current, [field]: true }));

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setSubmitted(true);
    setServerError(null);
    const firstInvalid = (["name", "code", "email"] as const).find((field) => errors[field]);
    if (firstInvalid) {
      fields.current[firstInvalid]?.focus();
      return;
    }
    setBusy(true);
    try {
      const created = await createPlatformWorkspace({ name: name.trim(), code, owner_email: trimmedEmail });
      setBusy(false);
      onCreated(created);
    } catch (cause) {
      setBusy(false);
      const message = cause instanceof Error ? cause.message : "The workspace couldn’t be created. Try again.";
      if (cause instanceof ApiError && cause.status === 409) {
        setServerError({ field: "code", message });
        fields.current.code?.focus();
      } else {
        setServerError({ field: null, message });
      }
    }
  };

  const emailHelp = accountKnown === false ? (
    <span className="inline-flex items-start gap-1.5 text-status-warning">
      <TriangleAlert aria-hidden="true" className="mt-px size-3.5 shrink-0" />
      <span>No BoMesh account uses this email yet. They become the admin when they sign up.</span>
    </span>
  ) : "They become the workspace’s first admin and can add everyone else.";

  return (
    <Dialog
      busy={busy}
      description="Set up a workspace for a customer or team."
      footer={(
        <>
          <Button disabled={busy} onClick={onClose} variant="secondary">Cancel</Button>
          <Button form={formId} loading={busy} type="submit">Create workspace</Button>
        </>
      )}
      onClose={onClose}
      open={open}
      title={<span className="inline-flex items-center gap-2">Create workspace <PreviewTag /></span>}
    >
      <form className="grid gap-4" id={formId} noValidate onSubmit={submit}>
        {serverError && !serverError.field && <Callout tone="err">{serverError.message}</Callout>}
        <FormField error={visible.name} htmlFor={ids.name} label="Workspace name" required>
          <Input
            autoComplete="off"
            onBlur={() => touch("name")}
            onChange={(event) => setName(event.target.value)}
            placeholder="e.g. Litware Labs"
            ref={(element) => { fields.current.name = element; }}
            value={name}
          />
        </FormField>
        <FormField
          error={visible.code}
          help={codeDraft === null ? "Filled in from the name. You can change it." : "People sign in at this address."}
          htmlFor={ids.code}
          label="Web address"
          required
        >
          <Input
            autoComplete="off"
            className="font-mono"
            onBlur={() => touch("code")}
            onChange={(event) => {
              const next = event.target.value;
              setCodeDraft(next.trim() ? next : null);
              if (serverError?.field === "code") setServerError(null);
            }}
            placeholder="litware"
            prefix={host ? `${host}/` : undefined}
            ref={(element) => { fields.current.code = element; }}
            spellCheck={false}
            value={code}
          />
        </FormField>
        <FormField error={visible.email} help={emailHelp} htmlFor={ids.email} label="First admin email" required>
          <Input
            autoComplete="off"
            inputMode="email"
            onBlur={() => touch("email")}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="name@company.com"
            ref={(element) => { fields.current.email = element; }}
            spellCheck={false}
            type="email"
            value={email}
          />
        </FormField>
      </form>
    </Dialog>
  );
}
