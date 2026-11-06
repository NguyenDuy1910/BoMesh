"use client";

import { Button } from "@heroui/react";
import type { ReactNode } from "react";

export interface SaveBarProps {
  /** Show only while the form has unsaved changes. */
  isDirty: boolean;
  onSave: () => void;
  onDiscard: () => void;
  isSaving?: boolean;
  /** Disables Save (e.g. invalid form) while keeping Discard. */
  isSaveDisabled?: boolean;
  /** Left text (default "Unsaved changes"; append " · 2 fields to fix" after a failed save). */
  message?: ReactNode;
  saveLabel?: string;
}

/** Sticky dirty-form bar (preview `.savebar`): message, Discard, Save; appears only when the form is dirty. */
export function SaveBar({ isDirty, onSave, onDiscard, isSaving, isSaveDisabled, message = "Unsaved changes", saveLabel = "Save changes" }: SaveBarProps) {
  if (!isDirty) return null;
  return (
    <div className="savebar" role="region" aria-label="Unsaved changes">
      <span className="savebar__text">{message}</span>
      <Button variant="ghost" onPress={onDiscard} isDisabled={isSaving}>
        Discard
      </Button>
      <Button variant="primary" onPress={onSave} isPending={isSaving} isDisabled={isSaveDisabled}>
        {saveLabel}
      </Button>
    </div>
  );
}
