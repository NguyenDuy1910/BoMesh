"use client";

import { Tooltip } from "@heroui/react";
import clsx from "clsx";
import { AlertCircle, Lock, X } from "lucide-react";
import NextLink from "next/link";
import type { ReactNode } from "react";

import { resourceId } from "@/lib/api/client";
import { FileIcon, Tip } from "@/components/ui";

import type { ChipFile } from "../attachments";

/**
 * An attached file (preview `chipHtml`): in the composer with progress and a
 * remove button (`onRemove`), or on a sent message as a link to the document.
 */
export function AttachmentChip({ file, onRemove }: { file: ChipFile; onRemove?: () => void }) {
  const inComposer = !!onRemove;
  const remove =
    inComposer && (file.ready !== false || file.error) ? (
      <Tooltip>
        <button type="button" className="wk-chip__x" aria-label={`Remove ${file.name}`} onClick={onRemove}>
          <X className="i i-xs" aria-hidden />
        </button>
        <Tooltip.Content>Remove</Tooltip.Content>
      </Tooltip>
    ) : null;

  if (file.error) {
    return (
      <Tip content={file.error}>
        <span className="wk-chip is-err" role="group" aria-label={`${file.name}: ${file.error}`}>
          <AlertCircle className="i i-sm" aria-hidden />
          <span className="wk-chip__name truncate" translate="no">
            {file.name}
          </span>
          <span className="wk-chip__meta">Can’t attach</span>
          {remove}
        </span>
      </Tip>
    );
  }

  const uploading = file.progress != null && file.progress < 100;
  const reading = inComposer && file.ready === false && !uploading;
  const inner = (
    <>
      {file.locked ? <Lock className="i i-sm" aria-hidden /> : <FileIcon size="sm" mime={file.mime} name={file.name} />}
      <span className="wk-chip__name truncate" translate="no">
        {file.name}
      </span>
      {file.kind === "ref" ? (
        <span className="wk-chip__meta truncate" translate="no">
          {file.locked ? "No access" : file.base || "Knowledge"}
        </span>
      ) : null}
      {uploading ? <span className="wk-chip__meta num">{Math.round(file.progress!)}%</span> : reading ? <span className="wk-chip__meta">Reading…</span> : null}
      {remove}
      {uploading ? <span className="wk-chip__bar" style={{ width: `${file.progress}%` }} /> : null}
    </>
  );
  const className = clsx("wk-chip", file.kind === "ref" && "is-ref", file.locked && "is-locked");
  const tip = file.kind === "ref" ? "From knowledge — read in place, not copied" : "Saved to My files";

  let chip: ReactNode;
  if (!inComposer && file.item && !file.locked) {
    chip = (
      <NextLink className={className} href={`/doc/${resourceId(file.item)}`}>
        {inner}
      </NextLink>
    );
  } else {
    chip = (
      <span className={className}>{inner}</span>
    );
  }
  if (file.ready === false || file.locked) return chip;
  return <Tip content={tip}>{chip}</Tip>;
}
