"use client";

import { useCallback, useEffect, useState } from "react";

import { subscribeApiData } from "@/lib/api/revision";
import { listCollections, type Collection } from "../api";

interface CollectionsState {
  collections: Collection[];
  loading: boolean;
  error: string | null;
}

/**
 * The knowledge bases the caller can read — the scope chip's choices and the
 * picker's groups. Re-read when the session or workspace changes; a stored
 * scope is always checked against this list, so a URL or an old chat never
 * grants access.
 */
export function useReadableCollections(enabled = true) {
  const [state, setState] = useState<CollectionsState>({ collections: [], loading: enabled, error: null });

  const reload = useCallback(async (signal?: AbortSignal) => {
    setState((current) => ({ ...current, loading: true, error: null }));
    try {
      const collections = await listCollections(signal);
      if (!signal?.aborted) setState({ collections, loading: false, error: null });
    } catch (cause) {
      if (signal?.aborted) return;
      setState({ collections: [], loading: false, error: cause instanceof Error ? cause.message : "Knowledge couldn’t be loaded." });
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    void reload(controller.signal);
    const stop = subscribeApiData(() => void reload());
    return () => {
      controller.abort();
      stop();
    };
  }, [enabled, reload]);

  return { ...state, reload };
}
