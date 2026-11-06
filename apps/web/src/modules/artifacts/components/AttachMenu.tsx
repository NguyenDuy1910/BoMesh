"use client";

import { Button, Dropdown, Header, Label } from "@heroui/react";
import { BookOpen, Paperclip, Upload } from "lucide-react";
import { useRef, useState, type DragEvent, type ReactNode } from "react";

import { resourceId } from "@/lib/api/client";

import { MAX_ATTACHMENTS, type ComposerAttachments } from "../attachments";
import { KnowledgePicker } from "./KnowledgePicker";

/** Paperclip menu of the composer (preview `wk-attach`): upload from computer, or add from knowledge. */
export function AttachMenu({ composer }: { composer: ComposerAttachments }) {
  const input = useRef<HTMLInputElement>(null);
  const [picking, setPicking] = useState(false);
  return (
    <>
      <Dropdown>
        <Button isIconOnly size="sm" variant="ghost" className="button--muted" aria-label="Attach files">
          <Paperclip aria-hidden />
        </Button>
        <Dropdown.Popover placement="top start">
          <Dropdown.Menu
            aria-label="Attach files"
            onAction={(key) => {
              if (key === "upload") input.current?.click();
              else setPicking(true);
            }}
          >
            <Dropdown.Section>
              <Header>Add to this message</Header>
              <Dropdown.Item id="upload" textValue="Upload from computer…">
                <Upload className="i" aria-hidden />
                <Label>Upload from computer…</Label>
                <span className="t-xs muted ms-auto">To My files</span>
              </Dropdown.Item>
              <Dropdown.Item id="knowledge" textValue="Add from knowledge…">
                <BookOpen className="i" aria-hidden />
                <Label>Add from knowledge…</Label>
                <span className="t-xs muted ms-auto">Read in place</span>
              </Dropdown.Item>
            </Dropdown.Section>
          </Dropdown.Menu>
        </Dropdown.Popover>
      </Dropdown>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        aria-label="Choose files to attach"
        onChange={(e) => {
          const files = e.target.files ? Array.from(e.target.files) : [];
          e.target.value = "";
          if (files.length) composer.addFiles(files);
        }}
      />
      <KnowledgePicker
        isOpen={picking}
        onOpenChange={setPicking}
        title="Add from knowledge"
        description="The assistant reads these where they are. Nothing is copied, and access rules still apply."
        exclude={composer.files.map((f) => resourceId(f.item)).filter(Boolean)}
        room={MAX_ATTACHMENTS - composer.count}
        roomFullText={`This message already has ${MAX_ATTACHMENTS} files`}
        onAdd={composer.addRefs}
      />
    </>
  );
}

/**
 * Drag and drop files onto the chat (preview `.chat-drop` + `.wk-drop`):
 * spread `dropProps` on the drop zone and render `overlay` inside it.
 */
export function useFileDrop(composer: ComposerAttachments): {
  dropProps: { onDragOver: (e: DragEvent) => void; onDragLeave: (e: DragEvent) => void; onDrop: (e: DragEvent) => void };
  overlay: ReactNode;
} {
  const [over, setOver] = useState(false);
  const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
  return {
    dropProps: {
      onDragOver: (e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        if (!over) setOver(true);
      },
      onDragLeave: (e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
      },
      onDrop: (e) => {
        setOver(false);
        if (!hasFiles(e)) return;
        e.preventDefault();
        const files = Array.from(e.dataTransfer.files);
        if (files.length) composer.addFiles(files);
      },
    },
    overlay: over ? (
      <div className="wk-drop" aria-hidden="true">
        <Upload className="i i-lg" />
        <span className="medium">Drop files to attach</span>
        <span className="t-xs muted">PDF, Office, text and CSV · up to 100 MB</span>
      </div>
    ) : null,
  };
}
