"use client";

import { createOverlayStore } from "./dialog-store";

export interface ContributeOptions {
  /** `share` = Share as knowledge (review first, default for contributors); `private` = Keep private in My files. */
  mode?: "share" | "private";
  /** Preselected knowledge base (item name or ID). The caller's personal collection means My files. */
  collection?: string;
  /** Submit a new version of this published document (item name or ID). */
  item?: string;
}

const store = createOverlayStore<ContributeOptions>();

/** Opens the Contribute dialog (preview `A['contribute']`). Rendered by `<ContributeHost/>`, which loads the dialog on first open. */
export function openContribute(options: ContributeOptions = {}) {
  store.open(options);
}

/** Current Contribute request (for `<ContributeHost/>`). */
export const useContributeRequest = store.useCurrent;
export const closeContribute = store.close;
