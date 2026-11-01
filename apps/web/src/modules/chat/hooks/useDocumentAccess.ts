"use client";

import { useEffect, useMemo, useSyncExternalStore } from "react";

import { getApiConfiguration } from "@/lib/api/config";
import { getDocumentAccess } from "../api";

export type DocumentAccess = "checking" | "readable" | "unreadable";

/**
 * Whether the caller can still open each cited document. A saved chat
 * outlives access changes, so its citations are re-checked once per document
 * per session; a failed check counts as readable rather than hiding an
 * answer on a network error.
 */
const known = new Map<string, Exclude<DocumentAccess, "checking">>();
const inFlight = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;
let namespace = "";

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function settle(documentId: string, access: Exclude<DocumentAccess, "checking">) {
  inFlight.delete(documentId);
  known.set(documentId, access);
  version += 1;
  for (const listener of listeners) listener();
}

export function useDocumentAccess(documentIds: readonly string[]): ReadonlyMap<string, DocumentAccess> {
  const current = useSyncExternalStore(subscribe, () => version, () => 0);
  const key = [...new Set(documentIds)].sort().join(",");

  useEffect(() => {
    const configuration = getApiConfiguration();
    const caller = `${configuration?.userId ?? ""}:${configuration?.tenantId ?? ""}`;
    if (caller !== namespace) {
      namespace = caller;
      known.clear();
      inFlight.clear();
    }
    for (const documentId of key ? key.split(",") : []) {
      if (known.has(documentId) || inFlight.has(documentId)) continue;
      inFlight.add(documentId);
      getDocumentAccess(documentId)
        .then((access) => settle(documentId, access))
        .catch(() => settle(documentId, "readable"));
    }
  }, [key]);

  return useMemo(() => {
    void current;
    return new Map((key ? key.split(",") : []).map((documentId) => [documentId, known.get(documentId) ?? "checking"]));
  }, [current, key]);
}
