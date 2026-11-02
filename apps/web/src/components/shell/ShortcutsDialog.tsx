"use client";

import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Kbd } from "@/components/ui/Kbd";

const SHORTCUTS: readonly [string, readonly string[]][] = [
  ["Search everything", ["⌘", "K"]],
  ["New chat", ["⌘", "⇧", "O"]],
  ["Send message", ["Enter"]],
  ["New line", ["⇧", "Enter"]],
  ["Close dialog or panel", ["Esc"]],
];

/** Prototype `M.shortcuts`. On Windows and Linux, Ctrl stands in for ⌘. */
export function ShortcutsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog
      description="On Windows and Linux, use Ctrl instead of ⌘."
      footer={<Button onClick={onClose} variant="primary">Done</Button>}
      onClose={onClose}
      open={open}
      size="sm"
      title="Keyboard shortcuts"
    >
      <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-3">
        {SHORTCUTS.map(([action, keys]) => (
          <div className="contents" key={action}>
            <dt className="text-[var(--text-primary)]">{action}</dt>
            <dd className="flex items-center gap-1">
              {keys.map((key) => <Kbd key={key}>{key}</Kbd>)}
            </dd>
          </div>
        ))}
      </dl>
    </Dialog>
  );
}
