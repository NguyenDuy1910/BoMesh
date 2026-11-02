"use client";

import { useEffect, useId, useState } from "react";

import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Dialog } from "@/components/ui/Dialog";
import { FormField } from "@/components/ui/FormField";
import { Input } from "@/components/ui/Input";
import { PreviewTag } from "@/components/ui/PreviewTag";
import { Select } from "@/components/ui/Select";
import { Skeleton } from "@/components/ui/Skeleton";

import { listCollections, publishArtifact, renameArtifact, type ArtifactPublishResult, type Collection } from "../../api";
import type { FileRevision } from "./file-model";

const message = (cause: unknown, fallback: string) => (cause instanceof Error && cause.message ? cause.message : fallback);

/**
 * Save to knowledge: publish the file's current server version into a
 * knowledge base the person picks, under a document name they can change.
 */
export function PublishDialog({
  artifactId,
  latest,
  onClose,
  onPublished,
  open,
  serverLatest,
  title,
}: {
  open: boolean;
  onClose: () => void;
  artifactId: string;
  title: string;
  /** The newest version, wherever it is kept. */
  latest: FileRevision;
  /** The newest version the server has — the one publishing saves. */
  serverLatest: FileRevision | undefined;
  onPublished: (result: ArtifactPublishResult, collection: Collection) => void;
}) {
  const fieldId = useId();
  const [collections, setCollections] = useState<Collection[]>();
  const [loadError, setLoadError] = useState<string>();
  const [collectionId, setCollectionId] = useState("");
  const [name, setName] = useState(title);
  const [nameError, setNameError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setCollections(undefined);
    setLoadError(undefined);
    setError(undefined);
    setNameError(undefined);
    setName(title);
    listCollections(controller.signal)
      .then((items) => {
        setCollections(items);
        setCollectionId((current) => (items.some((item) => item.id === current) ? current : items[0]?.id ?? ""));
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setLoadError(message(cause, "Your knowledge bases didn’t load."));
      });
    return () => controller.abort();
  }, [attempt, open, title]);

  const collection = collections?.find((candidate) => candidate.id === collectionId);
  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setNameError("Enter a document name.");
      return;
    }
    if (!collection) return;
    setBusy(true);
    setError(undefined);
    try {
      const result = await publishArtifact(artifactId, collection.id, { title: trimmed });
      onPublished(result, collection);
    } catch (cause) {
      setError(`Nothing was saved. ${message(cause, "Try again in a moment.")}`);
    } finally {
      setBusy(false);
    }
  };

  const savedVersion = serverLatest?.revision ?? latest.revision;
  return (
    <Dialog
      busy={busy}
      description={`${title} · version ${savedVersion}`}
      footer={
        <>
          <Button disabled={busy} onClick={onClose} variant="secondary">
            Cancel
          </Button>
          <Button disabled={!collection || !serverLatest} loading={busy} onClick={() => void submit()}>
            Save to knowledge
          </Button>
        </>
      }
      onClose={onClose}
      open={open}
      title="Save to knowledge"
    >
      <form
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {loadError ? (
          <Callout
            actions={<Button onClick={() => setAttempt((value) => value + 1)} size="sm" variant="secondary">Try again</Button>}
            tone="err"
          >
            {loadError}
          </Callout>
        ) : !collections ? (
          <div aria-busy="true" aria-label="Loading knowledge bases" className="grid gap-2" role="status">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-9 w-full" />
          </div>
        ) : collections.length ? (
          <FormField htmlFor={`${fieldId}-collection`} label="Knowledge base" required>
            <Select
              onChange={(event) => setCollectionId(event.target.value)}
              options={collections.map((item) => ({ value: item.id, label: item.title }))}
              value={collectionId}
            />
          </FormField>
        ) : (
          <Callout tone="neutral">You can’t save to any knowledge base yet. Ask a workspace admin for access.</Callout>
        )}
        <FormField error={nameError} htmlFor={`${fieldId}-name`} label="Document name" required>
          <Input
            maxLength={200}
            onChange={(event) => {
              setName(event.target.value);
              setNameError(undefined);
            }}
            value={name}
          />
        </FormField>
        {latest.local && serverLatest && (
          <Callout title={`Version ${latest.revision} is kept in this browser only`} tone="warn">
            Saving to knowledge saves version {serverLatest.revision}, the newest version on the server.
          </Callout>
        )}
        {!serverLatest && (
          <Callout tone="warn">Only versions kept in this browser exist, so there is nothing to save yet.</Callout>
        )}
        {collection && (
          <Callout tone="neutral">
            People who can open {collection.title} can find and cite it. It’s ready to search in a few minutes.
          </Callout>
        )}
        {error && <Callout tone="err">{error}</Callout>}
      </form>
    </Dialog>
  );
}

/** Rename the file's display name (the file name and its versions stay). */
export function RenameDialog({
  artifactId,
  onClose,
  onRenamed,
  open,
  title,
}: {
  open: boolean;
  onClose: () => void;
  artifactId: string;
  title: string;
  onRenamed: (title: string) => void;
}) {
  const fieldId = useId();
  const [value, setValue] = useState(title);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setValue(title);
    setError(undefined);
  }, [open, title]);

  const submit = async () => {
    const trimmed = value.trim();
    if (!trimmed) {
      setError("Enter a name.");
      return;
    }
    if (trimmed === title) {
      onClose();
      return;
    }
    setBusy(true);
    try {
      const renamed = await renameArtifact(artifactId, { title: trimmed });
      onRenamed(renamed.title);
    } catch (cause) {
      setError(`Nothing was saved. ${message(cause, "Try again in a moment.")}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      busy={busy}
      footer={
        <>
          <Button disabled={busy} onClick={onClose} variant="secondary">
            Cancel
          </Button>
          <Button loading={busy} onClick={() => void submit()}>
            Rename
          </Button>
        </>
      }
      onClose={onClose}
      open={open}
      size="sm"
      title={<span className="inline-flex items-center gap-2">Rename file <PreviewTag /></span>}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <FormField error={error} htmlFor={`${fieldId}-name`} label="Name" required>
          <Input
            data-autofocus
            maxLength={200}
            onChange={(event) => {
              setValue(event.target.value);
              setError(undefined);
            }}
            value={value}
          />
        </FormField>
      </form>
    </Dialog>
  );
}
