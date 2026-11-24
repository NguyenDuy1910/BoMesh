"use client";

import { Button, Kbd, Modal } from "@heroui/react";

import { closeOverlay, useShellOverlays } from "./overlays";

const SHORTCUTS: [string, string[]][] = [
  ["Tìm kiếm hoặc hỏi", ["⌘", "K"]],
  ["Trò chuyện mới", ["⌘", "⇧", "O"]],
  ["Thu gọn hoặc mở rộng thanh bên", ["⌘", "\\"]],
  ["Gửi tin nhắn", ["↵"]],
  ["Xuống dòng", ["⇧", "↵"]],
  ["Đóng hộp thoại hoặc bảng", ["Esc"]],
];

/** Keyboard shortcuts (preview `M.shortcuts`). */
export function ShortcutsDialog() {
  const { open } = useShellOverlays();
  return (
    <Modal.Backdrop isOpen={open === "shortcuts"} onOpenChange={(o) => !o && closeOverlay()}>
      <Modal.Container size="sm">
        <Modal.Dialog>
          <Modal.CloseTrigger aria-label="Đóng" />
          <Modal.Header>
            <Modal.Heading>Phím tắt</Modal.Heading>
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
              Xong
            </Button>
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
