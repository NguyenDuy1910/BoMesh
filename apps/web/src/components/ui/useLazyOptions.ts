"use client";

import { useState } from "react";

/**
 * A Select's options, built only while it is open; closed, only the chosen one (what the trigger shows). A Select
 * builds its whole collection on every render, so a list of roles per table row, or of every concept beside a form,
 * would otherwise cost each render of the page around it. With nothing chosen, the first option stays in the closed
 * list: a Select whose collection is empty can't be opened. Pass the returned handler to `onOpenChange`.
 */
export function useLazyOptions<T>(options: readonly T[], isChosen: (option: T) => boolean): [readonly T[], (open: boolean) => void] {
  const [open, setOpen] = useState(false);
  if (open) return [options, setOpen];
  const chosen = options.filter(isChosen);
  return [chosen.length ? chosen : options.slice(0, 1), setOpen];
}
