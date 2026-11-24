"use client";

import clsx from "clsx";
import { AlertCircle, Pencil } from "lucide-react";
import { useId, useRef, useState, type KeyboardEvent } from "react";

export interface EditableTitleProps {
  value: string;
  /**
   * Applies a changed name (already trimmed, inner spaces collapsed; empty only with `emptyText`). Returning a message
   * keeps the field open with it (a name already taken); returning nothing closes it.
   */
  onCommit: (value: string) => string | void | Promise<string | void>;
  /** Accessible name and tooltip of the pencil ("Rename topic"). */
  label?: string;
  /** `span` inside a heading or description that is already one (a drawer's title, its description). */
  as?: "h1" | "h2" | "h3" | "span";
  className?: string;
  maxLength?: number;
  placeholder?: string;
  /** An optional value (a description): it may be emptied, and while empty reads as this quiet prompt (`is-empty`). */
  emptyText?: string;
}

/**
 * A heading that renames itself (preview `editableTitle()`, `.etitle`): the name with a quiet pencil; clicking it swaps in
 * a field with the same font and line box. Enter or clicking away applies, Escape cancels; an unchanged value, or an empty
 * one without `emptyText`, just closes. The caller applies the change at once (with Undo).
 */
export function EditableTitle({ value, onCommit, label = "Rename", as: Tag = "h2", className, maxLength = 80, placeholder, emptyText }: EditableTitleProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState("");
  // Enter commits, then the field unmounts and blurs: one commit per edit.
  const settled = useRef(false);
  const errId = useId();

  const open = () => {
    settled.current = false;
    setDraft(value);
    setError("");
    setEditing(true);
  };
  const close = () => {
    settled.current = true;
    setEditing(false);
    setError("");
  };
  const commit = async () => {
    if (settled.current) return;
    const next = draft.trim().replace(/\s+/g, " ");
    if ((!next && emptyText === undefined) || next === value) {
      close();
      return;
    }
    settled.current = true;
    const message = await onCommit(next);
    if (message) {
      settled.current = false;
      setError(message);
      return;
    }
    close();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void commit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };

  if (!editing) {
    return (
      <Tag className={clsx("etitle", !value && emptyText !== undefined && "is-empty", className)}>
        <button type="button" className="etitle__btn" title={label} onClick={open}>
          <span className="etitle__text" translate={value ? "no" : undefined}>
            {value || emptyText}
          </span>
          <Pencil className="etitle__pen" aria-hidden />
          <span className="sr-only">{label}</span>
        </button>
      </Tag>
    );
  }
  return (
    <>
      <Tag className={clsx("etitle", "is-editing", className)}>
        <input
          className="input etitle__input"
          value={draft}
          placeholder={placeholder}
          maxLength={maxLength}
          autoFocus
          autoComplete="off"
          spellCheck={false}
          aria-label={label}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errId : undefined}
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => {
            setDraft(e.target.value);
            if (error) setError("");
          }}
          onKeyDown={onKeyDown}
          onBlur={() => void commit()}
        />
      </Tag>
      {error ? (
        <div className="field-error etitle__err" id={errId} role="alert">
          <AlertCircle className="i" aria-hidden />
          <span>{error}</span>
        </div>
      ) : null}
    </>
  );
}
