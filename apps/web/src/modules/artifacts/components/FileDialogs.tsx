"use client";

import { Button, FieldError, Input, Label, ListBox, Select, TextField } from "@heroui/react";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { errorMessage, resourceId } from "@/lib/api/client";
import { useWorkspace } from "@/lib/workspace";
import { toast } from "@/components/ui";
import { updateItem } from "@/modules/knowledge/api";
import { KnowledgeModal } from "@/modules/knowledge/components/KnowledgeModal";
import { invalidateKnowledge } from "@/modules/knowledge/queries";

import { publishArtifact, updateArtifact, type Artifact } from "../api";
import { baseName, fileNameOf } from "../model";
import { artifactKeys, usePublishTargets } from "../queries";

/** Rename file (preview `wk-rename`), with Undo. */
export function RenameDialog({ artifact, isOpen, onClose }: { artifact: Artifact; isOpen: boolean; onClose: () => void }) {
  const { id } = useWorkspace();
  const qc = useQueryClient();
  const [value, setValue] = useState(artifact.displayName ?? "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const name = artifact.name ?? "";

  const rename = async (displayName: string, etag?: string) => {
    const updated = await updateArtifact(id, name, { displayName, etag }, ["displayName"]);
    qc.setQueryData(artifactKeys.one(id, name), updated);
    await qc.invalidateQueries({ queryKey: artifactKeys.all(id) });
    return updated;
  };

  const save = async () => {
    const v = value.trim();
    if (!v) {
      setError("Enter a name.");
      return;
    }
    if (v === artifact.displayName) {
      onClose();
      return;
    }
    setBusy(true);
    try {
      const before = artifact.displayName ?? "";
      const updated = await rename(v, artifact.etag);
      onClose();
      toast("File renamed", { undo: () => void rename(before, updated.etag).catch((e: unknown) => toast(errorMessage(e), { tone: "danger" })) });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <KnowledgeModal
      isOpen={isOpen}
      onClose={onClose}
      size="sm"
      title="Rename file"
      footer={
        <>
          <Button variant="tertiary" onPress={onClose}>
            Cancel
          </Button>
          <Button variant="primary" isPending={busy} onPress={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      <TextField
        value={value}
        onChange={(v) => {
          setValue(v);
          setError("");
        }}
        isInvalid={!!error}
        autoFocus
      >
        <Label>Name</Label>
        <Input
          translate="no"
          onKeyDown={(e) => {
            if (e.key === "Enter") void save();
          }}
        />
        <FieldError>{error}</FieldError>
      </TextField>
    </KnowledgeModal>
  );
}

/**
 * Save to knowledge (preview `wk-publish`): the current version becomes a new
 * published document in a knowledge base the caller can add to.
 */
export function PublishDialog({ artifact, version, isOpen, onClose }: { artifact: Artifact; version: number; isOpen: boolean; onClose: () => void }) {
  const { id } = useWorkspace();
  const qc = useQueryClient();
  const router = useRouter();
  const targets = usePublishTargets({ enabled: isOpen });
  const list = targets.data ?? [];
  const [picked, setPicked] = useState<string>("");
  const [docName, setDocName] = useState(baseName(fileNameOf(artifact)));
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const target = list.find((t) => t.item.name === picked) ?? list[0];

  const who = !target
    ? ""
    : target.personal
      ? "Only you can find it."
      : `People with access to ${target.item.displayName ?? "this knowledge base"} can find and cite it.`;

  const save = async () => {
    const name = docName.trim();
    if (!name) {
      setError("Enter a document name.");
      return;
    }
    if (!target?.item.name) return;
    setBusy(true);
    try {
      const item = await publishArtifact(id, artifact.name ?? "", target.item.name, artifact.etag);
      // PublishArtifact names the document after the file; a different name is a rename.
      if (item && name !== (artifact.displayName ?? "")) await updateItem(id, resourceId(item), { displayName: name }, ["displayName"]);
      invalidateKnowledge(qc, id);
      onClose();
      const kb = target.item.displayName ?? "knowledge";
      toast(`Saved to ${target.personal ? "My files" : kb}`, {
        action: { label: "Open", onPress: () => router.push(target.personal ? "/knowledge/library" : `/knowledge/${resourceId(target.item.name)}`) },
      });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <KnowledgeModal
      isOpen={isOpen}
      onClose={onClose}
      guard={busy}
      title="Save to knowledge"
      description={
        <span translate="no">
          {artifact.displayName} · version {version}
        </span>
      }
      footer={
        <>
          <Button variant="tertiary" onPress={onClose} isDisabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" isPending={busy} isDisabled={!target} onPress={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      <div className="stack gap-16">
        <Select value={target?.item.name ?? null} onChange={(v) => setPicked(String(v))} isDisabled={targets.isPending || !list.length}>
          <Label>Knowledge base</Label>
          <Select.Trigger>
            <Select.Value />
            <Select.Indicator />
          </Select.Trigger>
          <Select.Popover>
            <ListBox>
              {list.map((t) => (
                <ListBox.Item key={t.item.name} id={t.item.name ?? ""} textValue={t.item.displayName ?? ""}>
                  {t.personal ? "My files" : t.item.displayName}
                  <ListBox.ItemIndicator />
                </ListBox.Item>
              ))}
            </ListBox>
          </Select.Popover>
        </Select>
        <TextField
          value={docName}
          onChange={(v) => {
            setDocName(v);
            setError("");
          }}
          isInvalid={!!error}
        >
          <Label>Document name</Label>
          <Input translate="no" />
          <FieldError>{error}</FieldError>
        </TextField>
      </div>
      <p className="t-sm muted mt-16">{targets.isError ? errorMessage(targets.error) : who}</p>
    </KnowledgeModal>
  );
}
