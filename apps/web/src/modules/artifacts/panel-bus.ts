/**
 * Coordination between the open file panel and the rest of the chat:
 * - a leave guard, so closing the panel or switching it to a citation asks
 *   before discarding unsaved edits (preview `leaveEdit`);
 * - "Review changes" toasts that move the open panel to a version.
 */
export type PanelTab = "preview" | "changes" | "history";
export interface PanelView {
  rev?: number;
  tab?: PanelTab;
}

let leaveGuard: (() => Promise<boolean>) | null = null;

/** The panel installs this while it holds unsaved edits; `null` clears it. */
export function setLeaveGuard(guard: (() => Promise<boolean>) | null) {
  leaveGuard = guard;
}

/**
 * Call before closing the file panel or replacing it (e.g. with a citation).
 * Resolves `false` when the person keeps their unsaved edits.
 */
export function confirmLeaveFileEdit(): Promise<boolean> {
  return leaveGuard ? leaveGuard() : Promise.resolve(true);
}

const panels = new Map<string, (view: PanelView) => void>();

/** The open panel listens for its artifact (resource name). Returns the unsubscribe. */
export function listenPanel(artifact: string, show: (view: PanelView) => void): () => void {
  panels.set(artifact, show);
  return () => {
    if (panels.get(artifact) === show) panels.delete(artifact);
  };
}

/** Moves the open panel of `artifact` to a version/tab; `false` when no panel shows it. */
export function showInPanel(artifact: string, view: PanelView): boolean {
  const show = panels.get(artifact);
  if (!show) return false;
  show(view);
  return true;
}

/** Whether a panel currently shows `artifact`. */
export function isPanelOpen(artifact: string): boolean {
  return panels.has(artifact);
}
