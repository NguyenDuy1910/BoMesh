"use client";

import { Button, Description, FieldError, Input, Label, ListBox, Select, TextField } from "@heroui/react";
import { useQueryClient } from "@tanstack/react-query";
import { BookOpen, Lock, Pencil, Users } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { errorMessage, resourceId } from "@/lib/api/client";
import { useWorkspace } from "@/lib/workspace";
import { FileIcon, toast } from "@/components/ui";
import { updateItem } from "@/modules/knowledge/api";
import { isEditor } from "@/modules/knowledge/bases/model";
import { catalogHref } from "@/modules/knowledge/model";
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
      icon={Pencil}
      title="Rename file"
      footer={
        <>
          <Button variant="ghost" onPress={onClose}>
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
 * published document in a collection the caller can add to.
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

  const WhoIcon = target?.personal ? Lock : Users;
  const who = !target
    ? ""
    : target.personal
      ? "Only you can find it."
      : `People with access to ${target.item.displayName ?? "this collection"} can find and cite it.`;

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
      /* Editors manage the collection in Studio; everyone else meets it as a Browse filter. */
      const href = target.personal
        ? "/knowledge/library?tab=files"
        : isEditor(target.item)
          ? `/studio/collections/${resourceId(target.item.name)}`
          : catalogHref({ filters: { kb: [resourceId(target.item.name)] } });
      toast(`Saved to ${target.personal ? "My files" : kb}`, { action: { label: "Open", onPress: () => router.push(href) } });
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
      icon={BookOpen}
      title="Save to knowledge"
      description="Turn this file into a document people can find, read and ask about."
      footer={
        <>
          <Button variant="ghost" onPress={onClose} isDisabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" isPending={busy} isDisabled={!target} onPress={() => void save()}>
            <BookOpen aria-hidden />
            Save to knowledge
          </Button>
        </>
      }
    >
      <div className="chat-ctx">
        <FileIcon name={fileNameOf(artifact)} />
        <div className="grow">
          <div className="chat-ctx__title truncate" translate="no">
            {artifact.displayName}
          </div>
          <div className="t-xs muted truncate">Version {version}</div>
        </div>
      </div>
      <div className="stack gap-16">
        <Select value={target?.item.name ?? null} onChange={(v) => setPicked(String(v))} isDisabled={targets.isPending || !list.length}>
          <Label>Collection</Label>
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
          {targets.isError ? (
            <Description>{errorMessage(targets.error)}</Description>
          ) : who ? (
            <Description className="wk-pub__who">
              <WhoIcon className="i i-xs" aria-hidden />
              <span>{who}</span>
            </Description>
          ) : null}
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
    </KnowledgeModal>
  );
}
