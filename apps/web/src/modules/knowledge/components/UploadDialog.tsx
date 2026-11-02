"use client";

import { AlertCircle, CheckCircle2, Upload, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Progress } from "@/components/ui/Progress";
import { cn } from "@/lib/cn";
import { FileTypeIcon, fileTypeOf } from "@/modules/knowledge/components/FileTypeIcon";
import { knowledgeApi } from "@/modules/knowledge/knowledge-api";
import { UPLOAD_ACCEPT, uploadProblem } from "@/modules/knowledge/model";
import { formatBytes, pluralize } from "@/lib/format";

interface QueuedFile {
  key: string;
  file: File;
  /** Why it will be skipped, found before anything is sent. */
  problem: string | null;
  /** 0–1 while sending. */
  progress: number;
  state: "ready" | "uploading" | "done" | "failed";
  /** What the server said when it refused the file. */
  error?: string;
}

/** Files sent at the same time. */
const CONCURRENCY = 3;

/**
 * Add files to a knowledge base: pick or drop several, see which will be
 * skipped and why, then watch each one upload. Uploaded files become pending
 * documents; `onUploaded` hands them on so processing can start.
 */
export function UploadDialog({
  open,
  onClose,
  collectionId,
  collectionTitle,
  personal,
  onUploaded,
}: {
  open: boolean;
  onClose: () => void;
  collectionId: string;
  collectionTitle: string;
  personal: boolean;
  onUploaded: (documents: { id: string; name: string }[]) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const hintId = useId();
  const [files, setFiles] = useState<QueuedFile[]>([]);
  const [busy, setBusy] = useState(false);
  const [finished, setFinished] = useState(false);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    if (!open) return;
    setFiles([]);
    setBusy(false);
    setFinished(false);
  }, [open]);

  const valid = files.filter((entry) => !entry.problem);
  const skipped = files.length - valid.length;

  const add = (picked: FileList | File[]) => {
    const known = new Set(files.map((entry) => `${entry.file.name}:${entry.file.size}`));
    const next = Array.from(picked)
      .filter((file) => !known.has(`${file.name}:${file.size}`))
      .map((file): QueuedFile => ({
        key: crypto.randomUUID(),
        file,
        problem: uploadProblem(file, { personal }),
        progress: 0,
        state: "ready",
      }));
    setFiles((current) => [...current, ...next]);
  };

  const patch = (key: string, change: Partial<QueuedFile>) =>
    setFiles((current) => current.map((entry) => (entry.key === key ? { ...entry, ...change } : entry)));

  const upload = async () => {
    if (!valid.length || busy) return;
    setBusy(true);
    const queue = [...valid];
    const uploaded: { id: string; name: string }[] = [];
    let failures = 0;
    const worker = async () => {
      for (let entry = queue.shift(); entry; entry = queue.shift()) {
        const { key, file } = entry;
        patch(key, { state: "uploading", progress: 0 });
        try {
          const result = await knowledgeApi.uploadDocument(collectionId, file, (fraction) => patch(key, { progress: fraction }));
          uploaded.push({ id: result.document.id, name: file.name });
          patch(key, { state: "done", progress: 1 });
        } catch (cause) {
          failures += 1;
          patch(key, { state: "failed", error: cause instanceof Error ? cause.message : "Upload failed." });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, valid.length) }, worker));
    setBusy(false);
    setFinished(true);
    if (uploaded.length) onUploaded(uploaded);
    // A refused file keeps the dialog open, so its reason can be read.
    if (!failures) onClose();
  };

  const dropZone = !busy && !finished && (
    <button
      aria-describedby={hintId}
      className={cn(
        "flex w-full flex-col items-center gap-2 rounded-[var(--radius-lg)] border-[1.5px] border-dashed px-4 py-7 text-center",
        "transition-[border-color,background-color] duration-[var(--duration-fast)]",
        "focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]",
        dragging
          ? "border-[var(--accent-primary)] bg-[var(--accent-soft)]"
          : "border-[var(--border-strong)] bg-[var(--surface-subtle)] hover:border-[var(--accent-primary)] hover:bg-[var(--accent-soft)]",
      )}
      onClick={() => inputRef.current?.click()}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
      }}
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        add(event.dataTransfer.files);
      }}
      type="button"
    >
      <span className="grid size-10 place-items-center rounded-[10px] bg-[var(--surface-base)] text-[var(--text-secondary)] shadow-[var(--shadow-1)]">
        <Upload aria-hidden="true" size={18} />
      </span>
      <span className="font-medium text-[var(--text-primary)]">
        Drop files here or <span className="text-[var(--text-accent)] underline underline-offset-2">choose files</span>
      </span>
      <span className="text-[length:var(--text-size-meta)] text-[var(--text-tertiary)]" id={hintId}>
        PDF, Word, Excel, PowerPoint, text{personal ? "" : " and ZIP"} up to 100 MB
      </span>
    </button>
  );

  return (
    <Dialog
      busy={busy}
      description={personal ? "Only you can see these files." : `To ${collectionTitle}`}
      footer={finished ? (
        <Button onClick={onClose} variant="primary">Done</Button>
      ) : (
        <>
          <Button disabled={busy} onClick={onClose} variant="secondary">Cancel</Button>
          <Button
            disabled={!valid.length}
            icon={<Upload aria-hidden="true" size={16} />}
            loading={busy}
            onClick={() => void upload()}
            variant="primary"
          >
            {valid.length ? `Upload ${pluralize(valid.length, "file")}` : "Upload"}
          </Button>
        </>
      )}
      footerStart={skipped > 0 && !finished ? `${pluralize(skipped, "file")} will be skipped` : undefined}
      onClose={onClose}
      open={open}
      size="lg"
      title={personal ? "Upload to My files" : "Upload files"}
    >
      {dropZone}
      <input
        accept={UPLOAD_ACCEPT}
        aria-label="Choose files to upload"
        className="hidden"
        multiple
        onChange={(event) => {
          if (event.target.files) add(event.target.files);
          event.target.value = "";
        }}
        ref={inputRef}
        type="file"
      />
      {files.length > 0 && (
        <ul
          aria-label="Files to upload"
          className={cn(
            "divide-y divide-[var(--border-subtle)] overflow-hidden rounded-[var(--radius-lg)] border border-[var(--border-subtle)]",
            dropZone && "mt-3.5",
          )}
        >
          {files.map((entry) => {
            const type = fileTypeOf(entry.file.type, entry.file.name);
            const error = entry.problem ?? entry.error;
            return (
              <li className="flex items-center gap-3 px-3 py-2.5" key={entry.key}>
                <FileTypeIcon decorative kind={type.kind} label={type.label} />
                <div className="min-w-0 flex-1">
                  <div className={cn("truncate font-medium", error ? "text-[var(--text-secondary)]" : "text-[var(--text-primary)]")}>
                    {entry.file.name}
                  </div>
                  {error ? (
                    <div className="mt-0.5 flex items-center gap-1.5 text-[length:var(--text-size-meta)] text-[var(--status-danger-text)]">
                      <AlertCircle aria-hidden="true" className="size-3.5 shrink-0" />
                      <span>{error}</span>
                    </div>
                  ) : entry.state === "ready" ? (
                    <div className="text-[length:var(--text-size-meta)] text-[var(--text-tertiary)]">{formatBytes(entry.file.size)}</div>
                  ) : (
                    <div className="mt-1.5 flex items-center gap-2">
                      <Progress
                        className="flex-1"
                        label={`Uploading ${entry.file.name}`}
                        tone={entry.state === "done" ? "ok" : "accent"}
                        value={Math.round(entry.progress * 100)}
                      />
                      <span className="w-9 text-right text-[length:var(--text-size-caption)] tabular-nums text-[var(--text-tertiary)]">
                        {Math.round(entry.progress * 100)}%
                      </span>
                    </div>
                  )}
                </div>
                {busy || finished ? (
                  entry.problem ? (
                    <span className="text-[length:var(--text-size-meta)] text-[var(--text-tertiary)]">Skipped</span>
                  ) : entry.state === "done" ? (
                    <CheckCircle2 aria-label="Uploaded" className="size-[18px] text-[var(--status-success-text)]" />
                  ) : null
                ) : (
                  <Button
                    aria-label={`Remove ${entry.file.name}`}
                    icon={<X size={16} />}
                    iconOnly
                    onClick={() => setFiles((current) => current.filter((candidate) => candidate.key !== entry.key))}
                    size="sm"
                    variant="ghost"
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Dialog>
  );
}
