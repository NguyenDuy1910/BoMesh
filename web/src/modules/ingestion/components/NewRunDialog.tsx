"use client";

import { useEffect, useId, useState } from "react";

import { AccessOption } from "@/components/patterns/AccessOption";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { ErrorState } from "@/components/ui/ErrorState";
import { FormField } from "@/components/ui/FormField";
import { Select } from "@/components/ui/Select";
import { ingestionActions, type CollectionName } from "@/modules/ingestion/queries";
import type { Source } from "@/modules/ingestion/integrations-api";
import type { IngestionRun, RunSelectableState } from "@/modules/ingestion/runs-api";

/**
 * The three things a person asks to process. "Pending" is everything waiting
 * — new, changed, or processed with settings that have since changed — which
 * is also what a source's pending count and its Process action mean.
 */
const WHAT: readonly { id: string; title: string; description: string; states: RunSelectableState[] }[] = [
  {
    id: "pending",
    title: "All pending",
    description: "New and changed documents, and those processed with older settings.",
    states: ["pending", "outdated"],
  },
  {
    id: "outdated",
    title: "Outdated only",
    description: "Ready documents that were processed with older settings.",
    states: ["outdated"],
  },
  {
    id: "failed",
    title: "Failed",
    description: "Documents whose last processing failed.",
    states: ["failed"],
  },
];

/**
 * Start processing: what, and from where.
 *
 * Defaults to everything pending in the workspace, which is the answer to
 * "make what I added searchable". Documents already being processed by another
 * run are left out by the server, so starting twice never doubles the work.
 */
export function NewRunDialog({
  open,
  collections,
  sources,
  onClose,
  onCreated,
}: {
  open: boolean;
  collections: readonly CollectionName[];
  sources: readonly Source[];
  onClose: () => void;
  onCreated: (run: IngestionRun) => void;
}) {
  const fieldId = useId();
  const [what, setWhat] = useState(WHAT[0].id);
  const [where, setWhere] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setWhat(WHAT[0].id);
    setWhere("");
    setBusy(false);
    setError(null);
  }, [open]);

  const start = async () => {
    const [kind, id] = where.split(":");
    setBusy(true);
    setError(null);
    try {
      const run = await ingestionActions.createRun({
        states: WHAT.find((option) => option.id === what)?.states ?? WHAT[0].states,
        collection_id: kind === "collection" ? id : undefined,
        source_id: kind === "source" ? id : undefined,
        trigger: "manual",
      });
      onCreated(run);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Processing couldn’t be started. Try again in a moment.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      className="max-w-xl"
      footer={(
        <>
          <Button disabled={busy} onClick={onClose} variant="ghost">Cancel</Button>
          <Button loading={busy} onClick={() => void start()}>Start processing</Button>
        </>
      )}
      onClose={onClose}
      open={open}
      title="New run"
    >
      <div className="grid gap-5">
        {error && <ErrorState description={error} layout="inline" title="Nothing was started" />}
        <fieldset className="grid gap-2">
          <legend className="mb-2 text-[length:var(--text-size-ui)] font-medium text-[var(--text-primary)]">
            What to process
          </legend>
          {WHAT.map((option) => (
            <AccessOption
              description={option.description}
              key={option.id}
              name={`${fieldId}-what`}
              onSelect={() => setWhat(option.id)}
              selected={what === option.id}
              title={option.title}
            />
          ))}
        </fieldset>
        <FormField
          helperText="Documents another run is already processing are left out."
          htmlFor={`${fieldId}-where`}
          label="From"
          required
        >
          <Select
            id={`${fieldId}-where`}
            onChange={(event) => setWhere(event.target.value)}
            options={[
              { value: "", label: "The whole workspace" },
              ...collections.map((collection) => ({
                value: `collection:${collection.id}`,
                label: `Collection: ${collection.title}`,
              })),
              ...sources.map((source) => ({
                value: `source:${source.id}`,
                label: `Source: ${source.display_name ?? source.external_resource_id ?? "Unnamed source"}`,
              })),
            ]}
            value={where}
          />
        </FormField>
      </div>
    </Dialog>
  );
}
