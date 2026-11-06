import { BookOpen, CircleCheck, List, Pencil, Sparkles, Table, type LucideIcon } from "lucide-react";

import type { Schema } from "@/lib/api/client";
import { isStaffRole } from "@/modules/spaces/types";

/**
 * Work kinds and workflows (preview `WORK_KINDS`, `WORKFLOWS`, `workflowsFor`).
 * A workflow is what a person starts ("Evidence review"); it produces an
 * Artifact of the matching `kind`. The workspace turns workflows on in
 * `WorkspaceSettings.workflows`; spaces narrow them by space type and role.
 */

export type ArtifactKind = NonNullable<Schema<"Artifact">["kind"]>;
export type WorkKind = Exclude<ArtifactKind, "FILE">;
export type WorkflowId = NonNullable<NonNullable<Schema<"WorkspaceSettings">["workflows"]>[number]["key"]>;

type Tone = "accent" | "success" | "warning" | "default";

export interface KindMeta {
  /** Label in lists and the Type filter. */
  label: string;
  icon: LucideIcon;
  tone: Tone;
  /** "Drafting the {noun}" while generating. */
  noun: string;
  /** Page layout of `/work/[id]`. */
  layout: "narrow" | "wide" | "doc";
}

export const WORK_KINDS: Readonly<Record<WorkKind, KindMeta>> = {
  EVIDENCE_REVIEW: { label: "Literature review", icon: Table, tone: "warning", noun: "review", layout: "wide" },
  DRAFT: { label: "Draft", icon: Pencil, tone: "default", noun: "draft", layout: "doc" },
  STUDY_GUIDE: { label: "Study guide", icon: BookOpen, tone: "success", noun: "study guide", layout: "narrow" },
  QUIZ: { label: "Quiz", icon: CircleCheck, tone: "accent", noun: "questions", layout: "narrow" },
};

const FALLBACK_KIND: KindMeta = { label: "Work", icon: Sparkles, tone: "accent", noun: "work", layout: "narrow" };

export const isWorkKind = (kind: string | undefined | null): kind is WorkKind => !!kind && kind in WORK_KINDS;
export const kindMeta = (kind: string | undefined | null): KindMeta => (isWorkKind(kind) ? WORK_KINDS[kind] : FALLBACK_KIND);

export interface Workflow {
  id: WorkflowId;
  kind: WorkKind;
  label: string;
  desc: string;
  icon: LucideIcon;
  /** Preview space types the workflow belongs to; null = any space or none. */
  spaceTypes: readonly string[] | null;
  /** True when the workflow can run without a space ("No space — any knowledge I can read"). */
  allowsNoSpace: boolean;
}

const WORKFLOW_DEFS: Readonly<Record<WorkflowId, Omit<Workflow, "id">>> = {
  STUDY_GUIDE: {
    kind: "STUDY_GUIDE",
    label: "Study guide",
    desc: "A summary, key terms and self-check questions from the materials you pick.",
    icon: BookOpen,
    spaceTypes: ["course"],
    allowsNoSpace: false,
  },
  QUIZ: {
    kind: "QUIZ",
    label: "Practice quiz",
    desc: "Test yourself on chosen materials. Every answer explains itself with a source.",
    icon: CircleCheck,
    spaceTypes: ["course"],
    allowsNoSpace: false,
  },
  EVIDENCE_REVIEW: {
    kind: "EVIDENCE_REVIEW",
    label: "Evidence review",
    desc: "Compare papers, vendors or options side by side; every cell cites its evidence.",
    icon: Table,
    spaceTypes: ["research", "project", "team"],
    allowsNoSpace: false,
  },
  DRAFT: {
    kind: "DRAFT",
    label: "Draft a document",
    desc: "A first draft grounded in your sources — proposals, decision records, announcements.",
    icon: Pencil,
    spaceTypes: null,
    allowsNoSpace: true,
  },
};

/** The staff variant of QUIZ inside a space the caller runs (preview workflow `quiz`). */
const STAFF_QUIZ = {
  label: "Quiz for students",
  desc: "Generate questions with an answer key and sources, edit, then publish to the course.",
  icon: List,
} as const;

/** Preview order: learning first, then research. */
const ORDER: readonly WorkflowId[] = ["STUDY_GUIDE", "QUIZ", "EVIDENCE_REVIEW", "DRAFT"];

type Space = Schema<"Space">;
type Settings = Schema<"WorkspaceSettings"> | null | undefined;

/** The caller runs the space (lead or staff): answers questions, publishes work. */
export const isSpaceStaff = (space: Space | null | undefined) => isStaffRole(space?.callerRole);

/**
 * Workflows the workspace turns on (`settings.workflows[].enabled`). A workspace that never
 * configured workflows (empty list) offers all of them, like the preview's template default.
 */
export function enabledWorkflowIds(settings: Settings): WorkflowId[] {
  const list = settings?.workflows ?? [];
  if (!list.length) return [...ORDER];
  const on = new Set(list.filter((w) => w.enabled !== false && w.key).map((w) => w.key as WorkflowId));
  return ORDER.filter((id) => on.has(id));
}

/** Whether a space type key is one the workflow is scoped to. Unknown (custom) space types accept every workflow. */
function fitsSpaceType(def: Omit<Workflow, "id">, spaceType: string | undefined): boolean {
  if (!def.spaceTypes || !spaceType) return true;
  const known = new Set(Object.values(WORKFLOW_DEFS).flatMap((d) => d.spaceTypes ?? []));
  return !known.has(spaceType) || def.spaceTypes.includes(spaceType);
}

/** Whether `space` can host the workflow: a member, a fitting space type, and the right role (study guides are for learners). */
export function spaceFits(id: WorkflowId, space: Space): boolean {
  if (!space.callerRole || !fitsSpaceType(WORKFLOW_DEFS[id], space.spaceType)) return false;
  return id !== "STUDY_GUIDE" || !isSpaceStaff(space);
}

export interface WorkflowScope {
  /** The caller's spaces; without a `space`, a space-scoped workflow needs one that fits. */
  mySpaces?: readonly Space[];
  /** Spaces module on; when off, every workflow runs without a space. */
  spacesOn?: boolean;
}

/**
 * Workflows the caller can start, optionally inside `space` (preview `workflowsFor`).
 * Inside a space the caller must be a member; QUIZ reads "Quiz for students" for staff.
 * Without a space, pass `scope` to keep only workflows the caller has somewhere to run.
 */
export function workflowsFor(settings: Settings, space?: Space | null, scope?: WorkflowScope): Workflow[] {
  return enabledWorkflowIds(settings)
    .filter((id) => {
      if (space) return spaceFits(id, space);
      if (!scope || scope.spacesOn === false || !WORKFLOW_DEFS[id].spaceTypes) return true;
      return (scope.mySpaces ?? []).some((s) => spaceFits(id, s));
    })
    .flatMap((id) => workflowOf(id, space, scope) ?? []);
}

/**
 * The workflow definition for an id (regardless of whether it is on). QUIZ is "Quiz for students"
 * in a space the caller runs, or — without a space — when every fitting space is one they run.
 */
export function workflowOf(id: string | undefined | null, space?: Space | null, scope?: WorkflowScope): Workflow | null {
  if (!id || !(id in WORKFLOW_DEFS)) return null;
  const key = id as WorkflowId;
  const def = WORKFLOW_DEFS[key];
  const fitting = (scope?.mySpaces ?? []).filter((s) => spaceFits(key, s));
  const staff = space ? isSpaceStaff(space) : fitting.length > 0 && fitting.every(isSpaceStaff);
  return key === "QUIZ" && staff ? { id: key, ...def, ...STAFF_QUIZ } : { id: key, ...def };
}

/** Whether the workflow may run without a space ("No space — any knowledge I can read"). */
export const runsWithoutSpace = (id: WorkflowId, spacesOn: boolean) => !spacesOn || WORKFLOW_DEFS[id].allowsNoSpace;

/** Shared URL: `/work/new?workflow=&space=&docs=` (wave-2 contract). IDs are bare. */
export function newWorkHref({ workflow, space, docs, title }: { workflow?: WorkflowId; space?: string | null; docs?: readonly string[]; title?: string } = {}): string {
  const q = new URLSearchParams();
  if (workflow) q.set("workflow", workflow);
  if (space) q.set("space", space.split("/").pop() ?? space);
  if (docs?.length) q.set("docs", docs.map((d) => d.split("/").pop() ?? d).join(","));
  if (title) q.set("title", title);
  const s = q.toString();
  return s ? `/work/new?${s}` : "/work/new";
}
