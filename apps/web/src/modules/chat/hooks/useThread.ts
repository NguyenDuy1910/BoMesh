"use client";

import { useEffect, useSyncExternalStore } from "react";

import { getThreadSnapshot, loadThread, subscribeThreads, type ThreadSnapshot } from "../chat-runtime";

/** One chat thread from the client runtime, loaded from this device on first use. */
export function useThread(conversationId: string): ThreadSnapshot {
  const snapshot = useSyncExternalStore(
    subscribeThreads,
    () => getThreadSnapshot(conversationId),
    () => getThreadSnapshot(conversationId),
  );
  useEffect(() => {
    void loadThread(conversationId);
  }, [conversationId]);
  return snapshot;
}
