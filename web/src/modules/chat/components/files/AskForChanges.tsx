"use client";

import { ArrowUp, Loader2 } from "lucide-react";
import { useRef, useState } from "react";

import { Button } from "@/components/ui/Button";

/** Quick asks from the prototype, by what the file is. */
const SUGGESTIONS = {
  sheet: ["Sort by largest amount", "Add a total row", "Add a status column"],
  document: ["Make it shorter", "More formal tone", "Add an at-a-glance table"],
} as const;

/**
 * Ask the assistant for a new version in plain words. The request goes into
 * the conversation as a normal turn; the panel keeps showing the file while
 * the assistant works and switches to the new version when it lands.
 */
export function AskForChanges({
  isSheet,
  onAsk,
  title,
  working,
}: {
  title: string;
  isSheet: boolean;
  working: boolean;
  onAsk: (instruction: string) => void;
}) {
  const [text, setText] = useState("");
  const fieldRef = useRef<HTMLTextAreaElement>(null);

  const send = (value: string) => {
    const instruction = value.trim();
    if (!instruction) {
      fieldRef.current?.focus();
      return;
    }
    onAsk(instruction);
    setText("");
  };

  if (working) {
    return (
      <div className="shrink-0 border-t border-border-subtle bg-surface-base px-3.5 py-3">
        <p aria-live="polite" className="flex items-center gap-2 text-[13px] text-text-tertiary" role="status">
          <Loader2 aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" />
          Working on the next version… you can keep reviewing.
        </p>
      </div>
    );
  }

  return (
    <div className="shrink-0 border-t border-border-subtle bg-surface-base px-3.5 py-3">
      <form
        className="flex items-end gap-2 rounded-(--radius-sheet) border border-border-default bg-surface-base py-2 pl-3 pr-2 focus-within:border-accent-primary focus-within:shadow-(--shadow-focus)"
        onSubmit={(event) => {
          event.preventDefault();
          send(text);
        }}
      >
        <textarea
          aria-label="Ask for changes"
          className="max-h-[120px] min-h-[22px] flex-1 resize-none bg-transparent text-[length:var(--text-size-body)] leading-[1.45] text-text-primary outline-none [field-sizing:content] placeholder:text-text-tertiary"
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              send(text);
            }
          }}
          placeholder={`Ask for changes to ${title}…`}
          ref={fieldRef}
          rows={1}
          value={text}
        />
        <Button aria-label="Ask for changes" icon={<ArrowUp aria-hidden="true" className="size-4" />} iconOnly size="sm" type="submit" />
      </form>
      <div aria-label="Suggestions" className="mt-2 flex flex-wrap gap-1.5" role="group">
        {SUGGESTIONS[isSheet ? "sheet" : "document"].map((suggestion) => (
          <button
            className="h-[26px] rounded-full border border-border-default px-2.5 text-[12.5px] text-text-secondary hover:bg-surface-hover hover:text-text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
            key={suggestion}
            onClick={() => send(suggestion)}
            type="button"
          >
            {suggestion}
          </button>
        ))}
      </div>
    </div>
  );
}
