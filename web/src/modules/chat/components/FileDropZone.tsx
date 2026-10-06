"use client";

import { Upload } from "lucide-react";
import { type DragEvent, type ReactNode, useRef, useState } from "react";

import { cn } from "@/lib/cn";
import { ATTACHMENT_HINT } from "../attachments";

/** Files dropped anywhere on the chat column are added to the next message. */
export function FileDropZone({
  onFiles,
  disabled,
  className,
  children,
}: {
  onFiles: (files: File[]) => void;
  disabled?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);
  const carriesFiles = (event: DragEvent) => !disabled && Array.from(event.dataTransfer.types).includes("Files");

  return (
    <div
      className={cn("relative", className)}
      onDragEnter={(event) => {
        if (!carriesFiles(event)) return;
        event.preventDefault();
        depth.current += 1;
        setDragging(true);
      }}
      onDragLeave={(event) => {
        if (!carriesFiles(event)) return;
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current === 0) setDragging(false);
      }}
      onDragOver={(event) => {
        if (!carriesFiles(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }}
      onDrop={(event) => {
        if (!carriesFiles(event)) return;
        event.preventDefault();
        depth.current = 0;
        setDragging(false);
        const files = Array.from(event.dataTransfer.files);
        if (files.length) onFiles(files);
      }}
    >
      {children}
      {dragging && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-2 z-30 grid place-items-center rounded-xl border-2 border-dashed border-accent-primary bg-surface-selected/90 text-center motion-safe:animate-ui-fade"
        >
          <div className="flex flex-col items-center gap-2 text-text-accent">
            <Upload size={28} />
            <b className="text-section">Drop files to add them</b>
            <span className="text-meta text-text-secondary">{ATTACHMENT_HINT}</span>
          </div>
        </div>
      )}
    </div>
  );
}
