/**
 * Workspace settings (preview `features/settings.js`, `core/workspace.js`): identity
 * validation and the workspace setup — template defaults, modules, space types and
 * AI workflows — mapped onto `Workspace` and `WorkspaceSettings`. Pure; covered by
 * `tests/workspace-settings.test.mts`.
 */

import type { Schema } from "@/lib/api/client";

type Settings = Schema<"WorkspaceSettings">;
export type SpaceTypeEntry = NonNullable<Settings["spaceTypes"]>[number];
export type WorkflowKey = NonNullable<NonNullable<Settings["workflows"]>[number]["key"]>;
export type ModuleKey = "spaces" | "work" | "requests";
export type TemplateKey = "ENTERPRISE" | "CAMPUS";

export const MAX_NAME = 60;
/** The API's `Workspace.code` pattern; the preview splits it into length and character messages. */
export const CODE_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])$/;

export interface IdentityDraft {
  name: string;
  code: string;
}

export type IdentityErrors = Partial<Record<keyof IdentityDraft, string>>;

/** Field errors for General (preview `errors`); an unchanged code is never re-validated. */
export function identityErrors(draft: IdentityDraft, current: IdentityDraft): IdentityErrors {
  const errors: IdentityErrors = {};
  const name = draft.name.trim();
  const code = draft.code.trim();
  if (!name) errors.name = "Enter a workspace name.";
  else if (name.length > MAX_NAME) errors.name = `Keep the name to ${MAX_NAME} characters.`;
  if (!code) errors.code = "Enter a web address.";
  else if (code !== current.code) {
    if (code.length < 3 || code.length > 32) errors.code = "Use 3–32 characters.";
    else if (!CODE_RE.test(code)) errors.code = "Use lowercase letters, numbers and hyphens. Start and end with a letter or number.";
  }
  return errors;
}

export const identityDirty = (draft: IdentityDraft, current: IdentityDraft) =>
  draft.name.trim() !== current.name || draft.code.trim() !== current.code;

/** `UpdateWorkspace` body fields and mask for the changed identity fields. */
export function identityPatch(draft: IdentityDraft, current: IdentityDraft): { displayName?: string; code?: string; updateMask: string } {
  const patch: { displayName?: string; code?: string } = {};
  if (draft.name.trim() !== current.name) patch.displayName = draft.name.trim();
  if (draft.code.trim() !== current.code) patch.code = draft.code.trim();
  return { ...patch, updateMask: Object.keys(patch).join(",") };
}

/* ── Workspace setup ── */

export const MODULES: readonly { key: ModuleKey; label: string; desc: string }[] = [
  { key: "spaces", label: "Spaces", desc: "Organise people, materials and work by team, project, office or course." },
  { key: "work", label: "Work", desc: "AI workflows that produce reviews, drafts, study guides and quizzes." },
  { key: "requests", label: "Requests", desc: "People send requests to service teams and offices; staff work a queue." },
];

/** Known space type keys in preview order (`SPACE_TYPES`); custom keys follow. */
export const SPACE_TYPE_KEYS = ["course", "research", "office", "team", "project"] as const;
/** Workflow keys in preview order (learning first, then research). */
export const WORKFLOW_KEYS: readonly WorkflowKey[] = ["STUDY_GUIDE", "QUIZ", "EVIDENCE_REVIEW", "DRAFT"];

export interface Setup {
  modules: Record<ModuleKey, boolean>;
  /** Enabled space type keys. */
  spaceTypes: string[];
  /** Enabled workflow keys. */
  workflows: WorkflowKey[];
}

export interface Template extends Setup {
  label: string;
  desc: string;
}

/** Preview `TEMPLATES`: what a workspace starts with. The API stores the template, not its defaults. */
export const TEMPLATES: Readonly<Record<TemplateKey, Template>> = {
  ENTERPRISE: {
    label: "Enterprise",
    desc: "Company knowledge with governed sources and access.",
    modules: { spaces: false, work: false, requests: false },
    spaceTypes: ["team", "project"],
    workflows: ["EVIDENCE_REVIEW", "DRAFT"],
  },
  CAMPUS: {
    label: "Campus",
    desc: "Courses, research groups and offices: learning, research and student services in one workspace.",
    modules: { spaces: true, work: true, requests: true },
    spaceTypes: ["course", "research", "office"],
    workflows: ["STUDY_GUIDE", "QUIZ", "EVIDENCE_REVIEW", "DRAFT"],
  },
};

export const templateKey = (template: string | undefined): TemplateKey => (template === "CAMPUS" ? "CAMPUS" : "ENTERPRISE");

/** The effective setup the API reports (absent modules are on; an empty workflow list offers all of them). */
export function setupOf(settings: Settings | null | undefined): Setup {
  const m = settings?.modules ?? {};
  const flows = settings?.workflows ?? [];
  return {
    modules: { spaces: m.spaces !== false, work: m.work !== false, requests: m.requests !== false },
    spaceTypes: (settings?.spaceTypes ?? []).filter((t) => t.key && t.enabled !== false).map((t) => t.key!),
    workflows: flows.length ? WORKFLOW_KEYS.filter((k) => flows.some((w) => w.key === k && w.enabled !== false)) : [...WORKFLOW_KEYS],
  };
}

const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x) => b.includes(x));

/** Whether a module differs from the template default (preview "Changed from <template>"). */
export const moduleChanged = (setup: Setup, template: Template, key: ModuleKey) => setup.modules[key] !== template.modules[key];

/** Whether anything differs from the template defaults (shows "Reset to … defaults"). */
export function isOverridden(setup: Setup, template: Template): boolean {
  return (
    MODULES.some((m) => moduleChanged(setup, template, m.key)) ||
    (setup.modules.spaces && !sameSet(setup.spaceTypes, template.spaceTypes)) ||
    (setup.modules.work && !sameSet(setup.workflows, template.workflows))
  );
}

/** Space type keys to list: the known ones in preview order, then the workspace's custom keys. */
export function spaceTypeKeys(settings: Settings | null | undefined): string[] {
  const custom = (settings?.spaceTypes ?? []).map((t) => t.key ?? "").filter((k) => k && !(SPACE_TYPE_KEYS as readonly string[]).includes(k));
  return [...SPACE_TYPE_KEYS, ...custom];
}

/** The `spaceTypes` list with `enabled` set from `keys`; known types missing from the list are added. */
export function spaceTypesWith(
  settings: Settings | null | undefined,
  enabled: readonly string[],
  label: (key: string) => { displayName: string; icon: string },
): SpaceTypeEntry[] {
  const list = settings?.spaceTypes ?? [];
  return spaceTypeKeys(settings)
    .filter((key) => list.some((t) => t.key === key) || enabled.includes(key))
    .map((key) => {
      const entry = list.find((t) => t.key === key);
      return { key, displayName: entry?.displayName || label(key).displayName, icon: entry?.icon || label(key).icon, enabled: enabled.includes(key) };
    });
}

export const workflowsWith = (enabled: readonly WorkflowKey[]) => WORKFLOW_KEYS.map((key) => ({ key, enabled: enabled.includes(key) }));

/** Toggles `id` in an enabled list; `null` when the list would become empty (preview keeps at least one). */
export function toggled<T extends string>(current: readonly T[], id: T): T[] | null {
  const next = current.includes(id) ? current.filter((x) => x !== id) : [...current, id];
  return next.length ? next : null;
}

/** The settings body restoring exactly the setup fields of `snapshot` (Undo, Reset). */
export function setupBody(snapshot: Pick<Settings, "modules" | "spaceTypes" | "workflows">): {
  body: Pick<Settings, "modules" | "spaceTypes" | "workflows">;
  updateMask: string;
} {
  return {
    body: { modules: snapshot.modules ?? {}, spaceTypes: snapshot.spaceTypes ?? [], workflows: snapshot.workflows ?? [] },
    updateMask: "modules,spaceTypes,workflows",
  };
}

/** The settings body that resets modules, space types and workflows to the template defaults. */
export function resetBody(settings: Settings | null | undefined, template: Template, label: (key: string) => { displayName: string; icon: string }) {
  return setupBody({
    modules: { ...template.modules },
    spaceTypes: spaceTypesWith(settings, template.spaceTypes, label),
    workflows: workflowsWith(template.workflows),
  });
}
