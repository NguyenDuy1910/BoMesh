"use client";

import { createContext, use } from "react";

export interface PaletteControls {
  /** Open the command palette, optionally with a query already typed. */
  open: (query?: string) => void;
}

export const PaletteContext = createContext<PaletteControls | null>(null);

/** The shell's one command palette (⌘K). `?action=search` on any product route opens it too. */
export function usePalette(): PaletteControls {
  const value = use(PaletteContext);
  if (!value) throw new Error("usePalette must be used inside the product shell.");
  return value;
}
