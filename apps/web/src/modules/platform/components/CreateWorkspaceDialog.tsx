"use client";

import { Button, Description, FieldError, Input, Label, Modal, TextField } from "@heroui/react";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

import { ChoiceGroup, toast, UserAvatar } from "@/components/ui";
import { ApiError, errorMessage } from "@/lib/api/client";

import { createWorkspace, findUserByEmail, type Workspace } from "../api";
import { EMAIL_RE, newWorkspaceErrors, slugify, TEMPLATES, userName, type NewWorkspaceErrors, type TemplateId } from "../model";
import { pk, useInvalidatePlatform, usePlatformWorkspaces } from "../queries";

const FIELDS = ["name", "code", "email"] as const;

/** Debounced value (account lookup while typing the first admin's email). */
function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

/** Preview `M['pf-ws-new']`: name → web address (auto, editable, unique) → first admin → template. */
function CreateWorkspaceForm({ onCreated, onClose }: { onCreated: (w: Workspace) => void; onClose: () => void }) {
  const workspaces = usePlatformWorkspaces();
  const invalidate = useInvalidatePlatform();
  const [name, setName] = useState("");
  const [codeInput, setCodeInput] = useState("");
  const [codeEdited, setCodeEdited] = useState(false);
  const [email, setEmail] = useState("");
  const [template, setTemplate] = useState<TemplateId>("ENTERPRISE");
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [serverErrors, setServerErrors] = useState<NewWorkspaceErrors>({});
  const refs = { name: useRef<HTMLInputElement>(null), code: useRef<HTMLInputElement>(null), email: useRef<HTMLInputElement>(null) };

  const code = codeEdited ? codeInput : slugify(name);
  const taken = workspaces.data?.find((w) => w.code === code.trim()) ?? null;
  const all = newWorkspaceErrors({ name, code, email }, taken);
  // Errors show after the first submit; an address that's taken shows right away.
  const visible: NewWorkspaceErrors = { ...(submitted ? all : taken && code.trim() ? { code: all.code } : {}), ...serverErrors };

  const lookupEmail = useDebounced(email.trim().toLowerCase(), 350);
  const account = useQuery({
    queryKey: ["platform", "user-by-email", lookupEmail],
    queryFn: () => findUserByEmail(lookupEmail),
    enabled: EMAIL_RE.test(lookupEmail),
    staleTime: 60_000,
  });
  const validEmail = EMAIL_RE.test(email.trim());
  const acct = validEmail && account.data && account.data.email === email.trim().toLowerCase() ? account.data : null;
  const emailDescription = !validEmail ? (
    "They become the first admin and invite everyone else."
  ) : acct ? (
    <span className="row gap-6">
      <UserAvatar name={userName(acct)} size="xs" />
      {userName(acct)} already has an account.
    </span>
  ) : (
    "We’ll email them an invite to create an account."
  );

  const submit = async () => {
    if (busy) return;
    setSubmitted(true);
    setServerErrors({});
    const first = FIELDS.find((f) => all[f]);
    if (first) {
      refs[first].current?.focus();
      return;
    }
    setBusy(true);
    try {
      const created = await createWorkspace({ displayName: name.trim(), code: code.trim(), initialAdminEmail: email.trim().toLowerCase(), template });
      await invalidate(pk.workspaces, pk.users, pk.memberships);
      onCreated(created);
      onClose();
      toast(acct ? `Created ${created.displayName}. ${userName(acct)} is its first admin.` : `Created ${created.displayName}. Invite sent to ${email.trim().toLowerCase()}.`);
    } catch (error) {
      if (error instanceof ApiError && error.reason === "WORKSPACE_CODE_TAKEN") {
        setServerErrors({ code: "Already used by another workspace. Try another." });
        refs.code.current?.focus();
      } else if (error instanceof ApiError && error.fieldViolations.length) {
        const next: NewWorkspaceErrors = {};
        for (const v of error.fieldViolations) {
          if (v.field === "displayName") next.name = v.description;
          else if (v.field === "code") next.code = v.description;
          else if (v.field === "initialAdminEmail") next.email = v.description;
        }
        setServerErrors(next);
        if (!Object.keys(next).length) toast(errorMessage(error), { tone: "danger" });
      } else {
        toast(errorMessage(error), { tone: "danger" });
      }
    } finally {
      setBusy(false);
    }
  };

  const onEnter = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") void submit();
  };

  return (
    <>
      <Modal.Body>
        <div className="stack gap-16">
          <TextField
            fullWidth
            isRequired
            value={name}
            onChange={(v) => {
              setName(v);
              setServerErrors({});
            }}
            isInvalid={Boolean(visible.name)}
            autoFocus
          >
            <Label>Name</Label>
            <Input ref={refs.name} placeholder="Litware Labs" onKeyDown={onEnter} />
            <FieldError>{visible.name}</FieldError>
          </TextField>
          <TextField
            fullWidth
            isRequired
            value={code}
            onChange={(v) => {
              setCodeInput(v);
              setCodeEdited(v.trim() !== "");
              setServerErrors({});
            }}
            isInvalid={Boolean(visible.code)}
          >
            <Label>Web address</Label>
            <div className="pf-prefix">
              <span className="pf-prefix__text" aria-hidden>
                {typeof window === "undefined" ? "bomesh.app" : window.location.host}/
              </span>
              <Input ref={refs.code} placeholder="litware" className="mono" spellCheck={false} onKeyDown={onEnter} />
            </div>
            {visible.code ? null : <Description>{codeEdited ? "People sign in at this address." : "Filled in from the name. You can change it."}</Description>}
            <FieldError>{visible.code}</FieldError>
          </TextField>
          <TextField
            fullWidth
            isRequired
            value={email}
            onChange={(v) => {
              setEmail(v);
              setServerErrors({});
            }}
            isInvalid={Boolean(visible.email)}
          >
            <Label>First admin email</Label>
            <Input ref={refs.email} placeholder="name@company.com" inputMode="email" spellCheck={false} autoCapitalize="off" onKeyDown={onEnter} />
            {visible.email ? null : <Description>{emailDescription}</Description>}
            <FieldError>{visible.email}</FieldError>
          </TextField>
          <div className="field">
            <span className="label">Template</span>
            <div className="pf-tpl">
              <ChoiceGroup
                label="Template"
                value={template}
                onChange={setTemplate}
                columns={2}
                options={(Object.keys(TEMPLATES) as TemplateId[]).map((id) => ({ value: id, title: TEMPLATES[id].label, description: TEMPLATES[id].description }))}
              />
            </div>
            <div className="description mt-4">Decides the modules it starts with. The admin can change it in Settings.</div>
          </div>
        </div>
      </Modal.Body>
      <Modal.Footer>
        <Button slot="close" variant="tertiary" isDisabled={busy}>
          Cancel
        </Button>
        <Button variant="primary" isPending={busy} onPress={() => void submit()}>
          Create workspace
        </Button>
      </Modal.Footer>
    </>
  );
}

export function CreateWorkspaceDialog({ isOpen, onClose, onCreated }: { isOpen: boolean; onClose: () => void; onCreated: (w: Workspace) => void }) {
  return (
    <Modal.Backdrop isOpen={isOpen} onOpenChange={(open) => !open && onClose()}>
      <Modal.Container size="md" scroll="inside">
        <Modal.Dialog>
          <Modal.CloseTrigger aria-label="Close" />
          <Modal.Header>
            <Modal.Heading>Create workspace</Modal.Heading>
          </Modal.Header>
          {isOpen ? <CreateWorkspaceForm onCreated={onCreated} onClose={onClose} /> : null}
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
