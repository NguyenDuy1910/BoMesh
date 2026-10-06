"use client";

import { useCallback, useSyncExternalStore } from "react";

import { ARTIFACT_RENAMED_EVENT, localArtifactTitle } from "../api";
import type { TurnArtifact } from "../artifacts";

let version = 0;

function subscribe(listener: () => void) {
  const onRename = () => {
    version += 1;
    listener();
  };
  window.addEventListener(ARTIFACT_RENAMED_EVENT, onRename);
  return () => window.removeEventListener(ARTIFACT_RENAMED_EVENT, onRename);
}

/**
 * A file as the thread should name it: the title it was renamed to in this
 * browser (`artifact.rename`, API pending) wins over the one its answer recorded.
 */
export function useArtifactTitles(): (artifact: TurnArtifact) => TurnArtifact {
  const current = useSyncExternalStore(subscribe, () => version, () => 0);
  return useCallback((artifact: TurnArtifact) => {
    void current;
    const title = localArtifactTitle(artifact.id);
    return title && title !== artifact.title ? { ...artifact, title } : artifact;
  }, [current]);
}
