"use client";

import { useState, type ReactNode } from "react";

import type { Item } from "@/modules/knowledge/api";
import { useKnowledgeModel, useMemberNames } from "@/modules/knowledge/queries";

import { rowOf } from "../../model";
import { useCuratedItems } from "../../queries";
import { DocumentDrawer } from "../DocumentDrawer";

/** The document drawer for queues whose rows are published documents (preview: every row opens `cur-doc`). */
export function useDocDrawer(): { open: (item: Item) => void; node: ReactNode } {
  const [picked, setPicked] = useState<Item | null>(null);
  const items = useCuratedItems();
  const { ctx } = useKnowledgeModel();
  // Follow the document as it changes (verify, tag, publish) while the drawer is open.
  const item = picked ? (items.data?.find((it) => it.name === picked.name) ?? picked) : null;
  const row = item ? rowOf(item, null, ctx.collectionNames ?? new Map()) : null;
  const names = useMemberNames([row?.contributor]);
  return {
    open: setPicked,
    node: <DocumentDrawer row={row} onClose={() => setPicked(null)} contributorName={row?.source ? "" : names.get(row?.contributor ?? "") || ""} />,
  };
}
