"use client";

import { AlertCircle, ChevronRight, X } from "lucide-react";

import { Button } from "@/components/ui/Button";
import { Tooltip } from "@/components/ui/Tooltip";
import { cn } from "@/lib/cn";
import { FileTypeIcon, fileTypeOf } from "@/modules/knowledge/components/FileTypeIcon";

import { artifactFormatLabel, artifactSizeLabel } from "../../artifacts";
import type { ConversationFile } from "./conversation-files";

/**
 * Every file in this chat, in one place: what the assistant made (each at
 * its newest version) and what the person shared.
 */
export function FilesInChatPanel({
  files,
  onClose,
  onOpen,
}: {
  files: readonly ConversationFile[];
  onOpen: (file: ConversationFile) => void;
  onClose?: () => void;
}) {
  const made = files.filter((file) => file.kind === "made");
  const attached = files.filter((file) => file.kind === "attached");
  return (
    <aside
      aria-label="Files in this chat"
      className={cn(
        "flex h-full min-h-0 w-[420px] max-w-full shrink-0 flex-col border-l border-border-subtle bg-surface-base text-text-primary",
        "motion-safe:animate-ui-slide-in",
      )}
    >
      <div className="flex h-[52px] shrink-0 items-center gap-2 border-b border-border-subtle pl-[18px] pr-3">
        <h2 className="flex-1 text-[length:var(--text-size-section)] font-semibold">Files in this chat</h2>
        {onClose && (
          <Tooltip label="Close" side="bottom">
            <Button aria-label="Close files" icon={<X aria-hidden="true" className="size-4" />} iconOnly onClick={onClose} size="sm" variant="ghost" />
          </Tooltip>
        )}
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-auto p-4">
        <section aria-labelledby="files-made">
          <h3 className="mb-2 text-[12.5px] font-semibold text-text-tertiary" id="files-made">Made by the assistant</h3>
          {made.length ? (
            <ul className="flex flex-col gap-2">
              {made.map((file) => {
                const type = fileTypeOf(file.artifact.mimeType, file.artifact.fileName);
                return (
                  <li key={file.id}>
                    <button
                      aria-label={`Open ${file.artifact.title}`}
                      className="group flex w-full min-w-0 items-center gap-3 rounded-(--radius-sheet) border border-border-subtle bg-surface-base py-2.5 pl-3 pr-2.5 text-left transition-[border-color,box-shadow] duration-(--duration-fast) hover:border-border-default hover:shadow-(--shadow-2) focus-visible:outline-none focus-visible:shadow-(--shadow-focus)"
                      onClick={() => onOpen(file)}
                      type="button"
                    >
                      <FileTypeIcon decorative kind={type.kind} label={type.label} size="lg" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">{file.artifact.title}</span>
                        <span className="mt-px block truncate text-[length:var(--text-size-caption)] text-text-tertiary">
                          {[
                            file.artifact.revision > 1 ? `Version ${file.artifact.revision}` : null,
                            artifactFormatLabel(file.artifact.mimeType),
                            file.artifact.sizeBytes > 0 ? artifactSizeLabel(file.artifact.sizeBytes) : null,
                          ].filter(Boolean).join(" · ")}
                        </span>
                      </span>
                      <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-text-tertiary group-hover:text-text-primary" />
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-[13px] text-text-tertiary">Files the assistant makes appear here.</p>
          )}
        </section>
        <section aria-labelledby="files-shared">
          <h3 className="mb-2 text-[12.5px] font-semibold text-text-tertiary" id="files-shared">Shared by you</h3>
          {attached.length ? (
            <ul className="flex flex-wrap gap-1.5">
              {attached.map((file) => {
                const { document } = file;
                const type = fileTypeOf(document.contentType, document.fileName);
                const failed = document.status === "failed";
                return (
                  <li className="min-w-0 max-w-full" key={file.id}>
                    <button
                      aria-label={`${failed ? "" : "Open "}${document.fileName}${failed ? ", couldn’t attach" : ""}`}
                      className={cn(
                        "inline-flex h-[30px] max-w-[280px] items-center gap-1.5 rounded-md pl-1 pr-2 text-[12.5px] text-text-secondary",
                        "hover:shadow-[inset_0_0_0_1px_var(--border-default)] focus-visible:outline-none focus-visible:shadow-(--shadow-focus)",
                        failed ? "bg-status-danger-bg text-status-danger-text" : "bg-surface-inset",
                      )}
                      disabled={failed}
                      onClick={() => onOpen(file)}
                      type="button"
                    >
                      {failed ? <AlertCircle aria-hidden="true" className="size-4 shrink-0" /> : <FileTypeIcon decorative kind={type.kind} label={type.label} size="xs" />}
                      <span className="truncate text-text-primary">{document.fileName}</span>
                      {failed && <span className="shrink-0">· Couldn’t attach</span>}
                      {!failed && document.origin === "reference" && (
                        <span className="shrink-0 text-text-tertiary">· From knowledge</span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-[13px] text-text-tertiary">Nothing attached yet.</p>
          )}
          <p className="mt-2 text-[12.5px] leading-[1.45] text-text-tertiary">
            Files you upload stay private to you. Documents added from knowledge are read in place, not copied.
          </p>
        </section>
      </div>
    </aside>
  );
}
