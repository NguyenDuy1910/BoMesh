"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";

import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { ChoiceCard } from "@/components/ui/ChoiceCard";
import { Dialog } from "@/components/ui/Dialog";
import { FormField } from "@/components/ui/FormField";
import { Input } from "@/components/ui/Input";
import { PreviewTag } from "@/components/ui/PreviewTag";
import { Textarea } from "@/components/ui/Textarea";
import { useToast } from "@/components/ui/Toast";
import { usePendingFeature } from "@/lib/api/pending";
import { invalidateApiData } from "@/lib/api/revision";
import { setCollectionGeneralAccess, type GeneralAccess } from "@/modules/knowledge/api";
import { knowledgeApi, type Collection } from "@/modules/knowledge/knowledge-api";
import { DESCRIPTION_LIMIT, NAME_LIMIT, nameError } from "@/modules/knowledge/model";

const counter = (used: number, limit: number) => (
  <span className="text-[length:var(--text-size-caption)] tabular-nums text-[var(--text-tertiary)]">{used}/{limit}</span>
);

/**
 * Create a knowledge base: a name, what it is for, and who can see it. The
 * creator becomes its owner on the server; "Everyone" also opens it to the
 * whole workspace (`collection.general_access`, pending).
 */
export function CreateKnowledgeBaseDialog({
  open,
  onClose,
  existing,
  workspaceName,
}: {
  open: boolean;
  onClose: () => void;
  /** Knowledge bases the caller can see, for the duplicate-name check. */
  existing: readonly Pick<Collection, "id" | "title">[];
  workspaceName: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const generalAccessEnabled = usePendingFeature("collection.general_access");
  const nameId = useId();
  const descriptionId = useId();
  const nameRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [access, setAccess] = useState<GeneralAccess>("restricted");
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName("");
    setDescription("");
    setAccess("restricted");
    setTouched(false);
    setFailure(null);
  }, [open]);

  const error = nameError(name, existing);
  // A duplicate is worth saying at once; "too short" waits until the field is left.
  const shownError = touched || (error && name.trim() && error.includes("already exists")) ? error : null;
  const descriptionError = description.trim().length > DESCRIPTION_LIMIT ? `Use ${DESCRIPTION_LIMIT} characters or fewer.` : null;

  const submit = async () => {
    setTouched(true);
    if (error || descriptionError) {
      nameRef.current?.focus();
      return;
    }
    setBusy(true);
    setFailure(null);
    try {
      const created = await knowledgeApi.createCollection({
        title: name.trim(),
        description: description.trim() || null,
      });
      let opened = true;
      if (generalAccessEnabled && access === "workspace") {
        opened = await setCollectionGeneralAccess(created.id, { general_access: "workspace" }).then(() => true, () => false);
      }
      invalidateApiData();
      onClose();
      router.push(`/knowledge/${encodeURIComponent(created.id)}`);
      toast.show(opened
        ? {
            message: `Created “${created.title}”`,
            action: access === "restricted" ? { label: "Share", onClick: () => router.push(`/knowledge/${encodeURIComponent(created.id)}?tab=access`) } : undefined,
          }
        : { tone: "err", message: `Created “${created.title}”, but it isn’t open to everyone yet`, description: "Change it in the Access tab." });
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : "The knowledge base couldn’t be created. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      busy={busy}
      footer={(
        <>
          <Button disabled={busy} onClick={onClose} variant="secondary">Cancel</Button>
          <Button disabled={Boolean(touched && error)} loading={busy} onClick={() => void submit()} variant="primary">
            Create knowledge base
          </Button>
        </>
      )}
      initialFocusRef={nameRef}
      onClose={onClose}
      open={open}
      size="sm"
      title="Create knowledge base"
    >
      <form
        className="grid gap-4"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {failure && <Callout tone="err">{failure}</Callout>}
        <FormField error={shownError} htmlFor={nameId} label="Name" labelAction={counter(name.length, NAME_LIMIT)} required>
          <Input
            autoComplete="off"
            disabled={busy}
            error={Boolean(shownError)}
            id={nameId}
            maxLength={NAME_LIMIT}
            onBlur={() => setTouched(true)}
            onChange={(event) => setName(event.target.value)}
            placeholder="e.g. Customer Support"
            ref={nameRef}
            value={name}
          />
        </FormField>
        <FormField
          error={descriptionError}
          help="Tells people what they can ask about."
          htmlFor={descriptionId}
          label="Description"
          labelAction={counter(description.length, DESCRIPTION_LIMIT)}
        >
          <Textarea
            disabled={busy}
            id={descriptionId}
            maxLength={DESCRIPTION_LIMIT}
            onChange={(event) => setDescription(event.target.value)}
            rows={2}
            value={description}
          />
        </FormField>
        {generalAccessEnabled && (
          <fieldset className="grid gap-2">
            <legend className="mb-2 flex items-center gap-2 text-[length:var(--text-size-meta)] font-medium text-[var(--text-primary)]">
              Who can see it <PreviewTag />
            </legend>
            <ChoiceCard
              checked={access === "workspace"}
              description="Anyone in the workspace can find it and ask about it."
              disabled={busy}
              name="kb-access"
              onChange={() => setAccess("workspace")}
              title={`Everyone in ${workspaceName || "the workspace"}`}
              value="workspace"
            />
            <ChoiceCard
              checked={access === "restricted"}
              description="You choose who can see it after it’s created."
              disabled={busy}
              name="kb-access"
              onChange={() => setAccess("restricted")}
              title="Only people I add"
              value="restricted"
            />
          </fieldset>
        )}
      </form>
    </Dialog>
  );
}
