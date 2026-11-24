"use client";

import { Button } from "@heroui/react";
import { Copy, Sparkles } from "lucide-react";
import { useEffect, useState, type RefObject } from "react";

import { toast } from "@/components/ui/Toast";

const MIN = 12;
const MAX = 800;

interface Selected {
  text: string;
  /** Viewport coordinates: the toolbar is fixed-positioned and dismissed on scroll. */
  left: number;
  top: number;
}

/**
 * Selection toolbar (preview `#doc-sel`): after selecting 12–800 characters on a page, Ask (answers
 * in the side panel; absent on an older version or a document that can't be asked) or Copy.
 * Scrolling, Escape or a new address dismisses it.
 */
export function SelectionToolbar({ root, onAsk }: { root: RefObject<HTMLElement | null>; onAsk?: (text: string) => void }) {
  const [sel, setSel] = useState<Selected | null>(null);

  useEffect(() => {
    const host = root.current;
    if (!host) return;
    const onUp = (e: MouseEvent) => {
      if ((e.target as Element | null)?.closest?.(".doc-sel")) return;
      window.setTimeout(() => {
        const s = window.getSelection();
        const text = s ? String(s).trim() : "";
        const node = s?.anchorNode?.parentElement;
        if (!s || !s.rangeCount || text.length < MIN || text.length > MAX || !node?.closest(".doc-page") || !host.contains(node)) {
          setSel(null);
          return;
        }
        const r = s.getRangeAt(0).getBoundingClientRect();
        const frame = host.getBoundingClientRect();
        // Centered over the selection, kept inside the reader (toolbar is about 220 px wide).
        const left = Math.max(frame.left + 8, Math.min(frame.right - 228, r.left + r.width / 2 - 110));
        setSel({ text, left, top: Math.max(frame.top + 8, r.top - 44) });
      }, 0);
    };
    const onScroll = (e: Event) => {
      if (!(e.target as Element | null)?.closest?.(".doc-sel")) setSel(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSel(null);
    };
    document.addEventListener("mouseup", onUp);
    document.addEventListener("scroll", onScroll, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mouseup", onUp);
      document.removeEventListener("scroll", onScroll, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [root]);

  if (!sel) return null;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(sel.text);
      toast("Đã sao chép");
      setSel(null);
    } catch {
      toast("Không sao chép được", { tone: "danger" });
    }
  };
  return (
    <div
      className="doc-sel"
      role="toolbar"
      aria-label="Thao tác với vùng chọn"
      style={{ position: "fixed", left: sel.left, top: sel.top }}
    >
      {onAsk ? (
        <Button
          size="sm"
          variant="ghost"
          aria-label="Hỏi về đoạn này"
          onPress={() => {
            onAsk(sel.text);
            setSel(null);
          }}
        >
          <Sparkles className="i" aria-hidden />
          Hỏi
        </Button>
      ) : null}
      <Button size="sm" variant="ghost" onPress={() => void copy()}>
        <Copy className="i" aria-hidden />
        Sao chép
      </Button>
    </div>
  );
}
