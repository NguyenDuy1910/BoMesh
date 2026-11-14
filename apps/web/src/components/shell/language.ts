"use client";

import { toast } from "@/components/ui/Toast";
import { getLanguage, setLanguage, type Language } from "@/lib/i18n";

/**
 * Switch the interface language with an Undo toast (preview `X.lang.change`).
 * The toast is written in English; the active dictionary localizes it like any other copy.
 * Kept apart from the pickers so menus can switch language without loading the Select.
 */
export function changeLanguage(code: Language): void {
  const before = getLanguage();
  if (code === before) return;
  void setLanguage(code).then(() => {
    toast(code === "vi" ? "Language changed to Tiếng Việt" : "Language changed to English", {
      tone: "accent",
      undo: () => void setLanguage(before),
    });
  });
}
