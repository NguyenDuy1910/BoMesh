"use client";

import { useState } from "react";

/**
 * A Select's options, built only while it is open; closed, only the chosen one (what the trigger shows). A Select
 * builds its whole collection on every render, so a list of roles per table row, or of every topic beside a form,
 * would otherwise cost each render of the page around it. Pass the returned handler to `onOpenChange`.
 */
export function useLazyOptions<T>(options: readonly T[], isChosen: (option: T) => boolean): [readonly T[], (open: boolean) => void] {
  const [open, setOpen] = useState(false);
  return [open ? options : options.filter(isChosen), setOpen];
}
