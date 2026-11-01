"use client";

import { Bold, Heading, Italic, List, ListOrdered, Undo2 } from "lucide-react";
import { useLayoutEffect, useRef } from "react";

import { Button } from "@/components/ui/Button";
import { PreviewTag } from "@/components/ui/PreviewTag";
import { Tooltip } from "@/components/ui/Tooltip";

import { IncrementalMarkdown } from "../IncrementalMarkdown";
import { DocPage } from "./DocPage";
import { htmlToMarkdown } from "./html-markdown";

/** What the editor holds right now, in the file's own format. */
export function editorText(editor: HTMLElement, format: "markdown" | "text"): string {
  if (format === "text") return editor.innerText.replace(/\n+$/, "") + "\n";
  return htmlToMarkdown(editor);
}

const COMMANDS = [
  { label: "Bold", icon: Bold, run: () => document.execCommand("bold") },
  { label: "Italic", icon: Italic, run: () => document.execCommand("italic") },
  {
    label: "Heading",
    icon: Heading,
    run: () => {
      const current = String(document.queryCommandValue("formatBlock")).toLowerCase();
      document.execCommand("formatBlock", false, current === "h3" ? "<p>" : "<h3>");
    },
  },
  { label: "Bulleted list", icon: List, run: () => document.execCommand("insertUnorderedList") },
  { label: "Numbered list", icon: ListOrdered, run: () => document.execCommand("insertOrderedList") },
  { label: "Undo", icon: Undo2, run: () => document.execCommand("undo") },
] as const;

/**
 * Edit a Markdown or text version in place, on the same page it is read on.
 *
 * The page is an uncontrolled `contenteditable`: React renders the starting
 * content once (from the same Markdown renderer the preview uses) and never
 * re-renders over the person's typing. Saving reads it back as Markdown.
 */
export function FileEditor({
  editorRef,
  format,
  label,
  nextVersion,
  onChange,
  onEscape,
  text,
}: {
  editorRef: React.RefObject<HTMLDivElement | null>;
  format: "markdown" | "text";
  /** The file's title, naming the text box. */
  label: string;
  nextVersion: number;
  text: string;
  /** Called on every edit with whether the content differs from where it started. */
  onChange: (dirty: boolean) => void;
  onEscape: () => void;
}) {
  const sourceRef = useRef<HTMLDivElement>(null);
  const startRef = useRef("");

  // Fill the page once, before paint, from the hidden rendering of the starting text.
  useLayoutEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    if (format === "text") {
      editor.textContent = text;
      startRef.current = editorText(editor, format);
    } else if (sourceRef.current) {
      const copy = sourceRef.current.cloneNode(true) as HTMLElement;
      // Controls the renderer draws (copy buttons, icons) are not content.
      copy.querySelectorAll("button, svg, [aria-hidden='true']").forEach((node) => node.remove());
      editor.innerHTML = copy.innerHTML;
      startRef.current = editorText(editor, format);
    }
    editor.focus();
  }, [editorRef, format, text]);

  return (
    <div>
      {format === "markdown" && (
        <div hidden ref={sourceRef}>
          <IncrementalMarkdown isStreaming={false} text={text} />
        </div>
      )}
      <div
        aria-label="Formatting"
        className="sticky top-0 z-[3] flex items-center gap-0.5 border-b border-border-subtle bg-surface-base px-2.5 py-1.5"
        role="toolbar"
      >
        {format === "markdown" &&
          COMMANDS.map(({ icon: Icon, label: commandLabel, run }) => (
            <Tooltip key={commandLabel} label={commandLabel} side="bottom">
              <Button
                aria-label={commandLabel}
                icon={<Icon aria-hidden="true" className="size-4" />}
                iconOnly
                onClick={() => {
                  run();
                  const editor = editorRef.current;
                  if (editor) onChange(editorText(editor, format) !== startRef.current);
                }}
                // Keep the selection in the page while a command runs.
                onMouseDown={(event) => event.preventDefault()}
                size="sm"
                variant="ghost"
              />
            </Tooltip>
          ))}
        <span className="ml-auto flex items-center gap-2 text-[length:var(--text-size-caption)] text-text-tertiary">
          Editing creates version {nextVersion}
          <PreviewTag />
        </span>
      </div>
      <div className="p-4">
        <DocPage
          aria-label={`Edit ${label}`}
          aria-multiline="true"
          className={
            format === "text"
              ? "whitespace-pre-wrap break-words font-mono text-[13px] leading-[1.6] shadow-[0_0_0_2px_var(--accent-primary),var(--shadow-2)] outline-none"
              : "shadow-[0_0_0_2px_var(--accent-primary),var(--shadow-2)] outline-none"
          }
          contentEditable={format === "text" ? "plaintext-only" : true}
          onInput={(event) => onChange(editorText(event.currentTarget, format) !== startRef.current)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              onEscape();
            }
          }}
          ref={editorRef}
          role="textbox"
          spellCheck
          suppressContentEditableWarning
        />
      </div>
    </div>
  );
}
