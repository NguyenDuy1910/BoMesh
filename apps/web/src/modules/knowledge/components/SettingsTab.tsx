"use client";

import { Archive } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useId, useState } from "react";

import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { FormField } from "@/components/ui/FormField";
import { Input } from "@/components/ui/Input";
import { Textarea } from "@/components/ui/Textarea";
import { useToast } from "@/components/ui/Toast";
import { invalidateApiData } from "@/lib/api/revision";
import { knowledgeApi, type Collection } from "@/modules/knowledge/knowledge-api";
import { DESCRIPTION_LIMIT, NAME_LIMIT, nameError } from "@/modules/knowledge/model";
import { pluralize } from "@/lib/format";

const counter = (used: number, limit: number) => (
  <span className="text-[length:var(--text-size-caption)] tabular-nums text-[var(--text-tertiary)]">{used}/{limit}</span>
);

/** A knowledge base's name and description, and archiving it. */
export function SettingsTab({
  collection,
  existing,
  canEdit,
  canDelete,
  documentCount,
}: {
  collection: Collection;
  existing: readonly Pick<Collection, "id" | "title">[];
  canEdit: boolean;
  canDelete: boolean;
  documentCount: number;
}) {
  const router = useRouter();
  const toast = useToast();
  const nameId = useId();
  const descriptionId = useId();
  const savedName = collection.title;
  const savedDescription = collection.description ?? "";
  const [name, setName] = useState(savedName);
  const [description, setDescription] = useState(savedDescription);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [archiving, setArchiving] = useState(false);

  // A save elsewhere (or this one) moves the saved values; an untouched form follows them.
  useEffect(() => {
    setName(savedName);
    setDescription(savedDescription);
    setTouched(false);
  }, [savedName, savedDescription]);

  const nameChanged = name.trim() !== savedName;
  const descriptionChanged = description.trim() !== savedDescription.trim();
  const dirty = nameChanged || descriptionChanged;
  const error = nameChanged ? nameError(name, existing, collection.id) : null;
  const descriptionError = descriptionChanged && description.trim().length > DESCRIPTION_LIMIT
    ? `Use ${DESCRIPTION_LIMIT} characters or fewer.`
    : null;
  const shownError = touched ? error : null;

  const save = async () => {
    setTouched(true);
    if (error || descriptionError || !dirty) return;
    setBusy(true);
    setFailure(null);
    try {
      await knowledgeApi.updateCollection(collection.id, {
        ...(nameChanged ? { title: name.trim() } : {}),
        ...(descriptionChanged ? { description: description.trim() || null } : {}),
      });
      invalidateApiData();
      toast.show({ message: "Saved changes" });
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : "Your changes couldn’t be saved. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const archive = async () => {
    await knowledgeApi.deleteCollection(collection.id);
    invalidateApiData();
    router.push("/knowledge");
    toast.show({ message: `Archived “${collection.title}”` });
  };

  return (
    <div className="grid max-w-[760px] gap-6">
      {canEdit && (
        <section aria-labelledby="kb-details-heading" className="rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-[var(--surface-base)] p-5">
          <h2 className="mb-3.5 text-[length:var(--text-size-section)] font-semibold text-[var(--text-primary)]" id="kb-details-heading">Details</h2>
          <form
            className="grid gap-4"
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <FormField error={shownError} htmlFor={nameId} label="Name" labelAction={counter(name.length, NAME_LIMIT)} required>
              <Input
                disabled={busy}
                error={Boolean(shownError)}
                id={nameId}
                maxLength={Math.max(NAME_LIMIT, savedName.length)}
                onBlur={() => setTouched(true)}
                onChange={(event) => setName(event.target.value)}
                value={name}
              />
            </FormField>
            <FormField error={descriptionError} htmlFor={descriptionId} label="Description" labelAction={counter(description.length, DESCRIPTION_LIMIT)}>
              <Textarea
                disabled={busy}
                id={descriptionId}
                onChange={(event) => setDescription(event.target.value)}
                rows={3}
                value={description}
              />
            </FormField>
            {failure && <p className="text-[length:var(--text-size-meta)] text-[var(--status-danger-text)]" role="alert">{failure}</p>}
            <div
              aria-live="polite"
              className="flex flex-wrap items-center justify-end gap-2"
            >
              {dirty && <span className="mr-auto text-[length:var(--text-size-meta)] text-[var(--text-tertiary)]">You have unsaved changes</span>}
              {dirty && (
                <Button
                  disabled={busy}
                  onClick={() => {
                    setName(savedName);
                    setDescription(savedDescription);
                    setTouched(false);
                    setFailure(null);
                  }}
                  variant="ghost"
                >
                  Discard
                </Button>
              )}
              <Button disabled={!dirty || Boolean(shownError || descriptionError)} loading={busy} type="submit" variant="primary">
                Save changes
              </Button>
            </div>
          </form>
        </section>
      )}

      {canDelete && (
        <section
          aria-labelledby="kb-archive-heading"
          className="flex flex-wrap items-center justify-between gap-4 rounded-[var(--radius-lg)] border border-[var(--status-danger-border)] bg-[var(--surface-base)] p-5"
        >
          <div className="min-w-[240px] flex-1">
            <h2 className="text-[length:var(--text-size-section)] font-semibold text-[var(--text-primary)]" id="kb-archive-heading">Archive knowledge base</h2>
            <p className="mt-1 text-[13.5px] text-[var(--text-secondary)]">
              {documentCount
                ? `Removes it and its ${pluralize(documentCount, "document")} from answers for everyone.`
                : "Removes it from the Knowledge page for everyone."}
            </p>
          </div>
          <Button icon={<Archive aria-hidden="true" size={16} />} onClick={() => setArchiving(true)} variant="danger-ghost">
            Archive knowledge base
          </Button>
        </section>
      )}

      <ConfirmDialog
        confirmLabel="Archive knowledge base"
        confirmText={collection.title}
        description={`${documentCount ? `Its ${pluralize(documentCount, "document")} will stop appearing in answers for everyone.` : "It will disappear for everyone."} This can’t be undone here. Type its name to confirm.`}
        onClose={() => setArchiving(false)}
        onConfirm={archive}
        open={archiving}
        title={`Archive ${collection.title}?`}
      />
    </div>
  );
}
