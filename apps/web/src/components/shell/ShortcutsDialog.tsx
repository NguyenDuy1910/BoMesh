"use client";

import { Button, Kbd, Modal } from "@heroui/react";

import { closeOverlay, useShellOverlays } from "./overlays";

const SHORTCUTS: [string, string[]][] = [
  ["Search or ask", ["⌘", "K"]],
  ["New chat", ["⌘", "⇧", "O"]],
  ["Send message", ["↵"]],
  ["New line", ["⇧", "↵"]],
  ["Close dialog or panel", ["Esc"]],
];

/** Keyboard shortcuts (preview `M.shortcuts`). */
export function ShortcutsDialog() {
  const { open } = useShellOverlays();
  return (
    <Modal.Backdrop isOpen={open === "shortcuts"} onOpenChange={(o) => !o && closeOverlay()}>
      <Modal.Container size="sm">
        <Modal.Dialog>
          <Modal.CloseTrigger aria-label="Close" />
          <Modal.Header>
            <Modal.Heading>Keyboard shortcuts</Modal.Heading>
          </Modal.Header>
          <Modal.Body>
            <dl className="kv" style={{ gridTemplateColumns: "1fr auto", gap: "12px 16px" }}>
              {SHORTCUTS.map(([action, keys]) => (
                <div key={action} style={{ display: "contents" }}>
                  <dt className="fg">{action}</dt>
                  <dd className="row gap-4">
                    {keys.map((k) => (
                      <Kbd key={k}>
                        <Kbd.Content>{k}</Kbd.Content>
                      </Kbd>
                    ))}
                  </dd>
                </div>
              ))}
            </dl>
          </Modal.Body>
          <Modal.Footer>
            <Button slot="close" variant="primary">
              Done
            </Button>
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
