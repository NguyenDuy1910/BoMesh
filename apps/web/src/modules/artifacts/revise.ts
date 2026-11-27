"use client";

import type { QueryClient } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";

import { toast } from "@/components/ui";

import { getArtifact } from "./api";
import { fileNameOf, revisionNumber } from "./model";
import { showInPanel } from "./panel-bus";
import { artifactKeys } from "./queries";

/**
 * Asking for changes to a file is a turn of its conversation (ConverseConversation `editArtifact`): the
 * assistant writes the file's next version. While that turn runs, the file's panel says which version is
 * being written (preview "Working on version N… you can keep reviewing").
 */
const pending = new Map<string, number>();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The version number a turn is writing for `artifact`, or 0 when none. */
export function useRevising(artifact: string): number {
  return useSyncExternalStore(subscribe, () => pending.get(artifact) ?? 0, () => 0);
}

/** Mark `artifact` as having `version` written by a running turn; the returned function clears it. */
export function startRevising(artifact: string, version: number): () => void {
  pending.set(artifact, version);
  emit();
  return () => {
    if (pending.get(artifact) !== version) return;
    pending.delete(artifact);
    emit();
  };
}

/**
 * After a turn wrote a new version of `artifact`: refresh it, switch an open panel to its changes, and say
 * which version it is on.
 */
export async function showNewVersion(qc: QueryClient, workspace: string, artifact: string): Promise<void> {
  await qc.invalidateQueries({ queryKey: artifactKeys.one(workspace, artifact) });
  const updated = await getArtifact(workspace, artifact);
  const n = revisionNumber(updated.revision);
  const title = fileNameOf(updated);
  showInPanel(artifact, { rev: n, tab: "changes" });
  toast(`${title} đang ở phiên bản ${n}`, { action: { label: "Xem lại thay đổi", onPress: () => showInPanel(artifact, { rev: n, tab: "changes" }) } });
}
