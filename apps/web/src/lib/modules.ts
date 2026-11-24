import type { WorkspaceModule } from "@/lib/workspace";

/**
 * Modules held back for a later phase (preview `LATER_PHASE_MODULES`). `hasModule` reports them off whatever the
 * workspace settings say, so their entry points and Settings switches hide; the sidebar keeps their row as "Sắp ra mắt"
 * and their addresses show the coming-soon page. Code and data stay: drop the id here to bring the module back.
 */
export const LATER_PHASE_MODULES: Readonly<Partial<Record<WorkspaceModule, true>>> = { work: true };
