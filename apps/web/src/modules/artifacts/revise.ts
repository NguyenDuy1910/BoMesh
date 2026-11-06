"use client";

import type { QueryClient } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";

import { errorMessage } from "@/lib/api/client";
import { toast } from "@/components/ui";

import { getArtifact, reviseArtifact, waitForOperation } from "./api";
import { revisionNumber } from "./model";
import { showInPanel } from "./panel-bus";
import { artifactKeys } from "./queries";

/**
 * "Ask for changes" runs as an operation that outlives the panel: closing it
 * or switching files keeps the assistant working, and the result still
 * arrives as a toast (preview `afterStream` for an edit).
 */
const pending = new Map<string, number>();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The version number being written for `artifact`, or 0 when none. */
export function useRevising(artifact: string): number {
  return useSyncExternalStore(subscribe, () => pending.get(artifact) ?? 0, () => 0);
}

export async function askForChanges(
  qc: QueryClient,
  { workspace, artifact, title, etag, instructions, nextVersion }: { workspace: string; artifact: string; title: string; etag?: string; instructions: string; nextVersion: number },
): Promise<void> {
  pending.set(artifact, nextVersion);
  emit();
  try {
    const operation = await waitForOperation(await reviseArtifact(workspace, artifact, { instructions, etag }));
    await qc.invalidateQueries({ queryKey: artifactKeys.one(workspace, artifact) });
    if (operation.error) {
      toast(`Couldn’t update ${title}`, { tone: "danger", description: operation.error.message || "The assistant couldn’t finish this change. Try again." });
      return;
    }
    const updated = await getArtifact(workspace, artifact);
    const n = revisionNumber(updated.revision);
    showInPanel(artifact, { rev: n, tab: "changes" });
    toast(`${title} is on version ${n}`, { action: { label: "Review changes", onPress: () => showInPanel(artifact, { rev: n, tab: "changes" }) } });
  } catch (error) {
    toast(`Couldn’t update ${title}`, { tone: "danger", description: errorMessage(error) });
  } finally {
    pending.delete(artifact);
    emit();
  }
}
