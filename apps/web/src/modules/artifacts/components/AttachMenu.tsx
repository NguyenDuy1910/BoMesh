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
        <Button isIconOnly size="sm" variant="ghost" className="button--muted" aria-label="Đính kèm tệp">
          <Paperclip aria-hidden />
        </Button>
        <Dropdown.Popover placement="bottom start">
          <Dropdown.Menu
            aria-label="Đính kèm tệp"
            onAction={(key) => {
              if (key === "upload") input.current?.click();
              else setPicking(true);
            }}
          >
            <Dropdown.Section>
              <Header>Thêm vào tin nhắn này</Header>
              <Dropdown.Item id="upload" textValue="Tải lên từ máy tính…">
                <Upload className="i" aria-hidden />
                <Label>Tải lên từ máy tính…</Label>
                <span className="t-xs muted ms-auto">Vào Tệp của tôi</span>
              </Dropdown.Item>
              <Dropdown.Item id="knowledge" textValue="Thêm từ kho tài liệu…">
                <BookOpen className="i" aria-hidden />
                <Label>Thêm từ kho tài liệu…</Label>
                <span className="t-xs muted ms-auto">Đọc tại chỗ</span>
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
        aria-label="Chọn tệp để đính kèm"
        onChange={(e) => {
          const files = e.target.files ? Array.from(e.target.files) : [];
          e.target.value = "";
          if (files.length) composer.addFiles(files);
        }}
      />
      <KnowledgePicker
        isOpen={picking}
        onOpenChange={setPicking}
        title="Thêm từ kho tài liệu"
        description="Trợ lý đọc các tài liệu này ngay tại chỗ. Không có gì bị sao chép; quy tắc truy cập vẫn được áp dụng."
        exclude={composer.files.map((f) => resourceId(f.item)).filter(Boolean)}
        room={MAX_ATTACHMENTS - composer.count}
        roomFullText={`Tin nhắn này đã có ${MAX_ATTACHMENTS} tệp.`}
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
        <span className="medium">Thả tệp để đính kèm</span>
        <span className="t-xs muted">PDF, Office, văn bản và CSV · tối đa 100 MB</span>
      </div>
    ) : null,
  };
}
