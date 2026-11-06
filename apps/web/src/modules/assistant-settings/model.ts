/**
 * Assistant setup draft (preview `features/assistant.js`): the editable shape,
 * validation, dirtiness and the mapping to/from `WorkspaceAssistant`. Pure;
 * covered by `tests/assistant-settings.test.mts`.
 */

export const MAX_INSTRUCTIONS = 2000;
export const MAX_WELCOME = 60;
export const MAX_STARTERS = 3;

export type AnswerLength = "CONCISE" | "BALANCED" | "DETAILED";

export const STYLES: readonly { value: AnswerLength; title: string; description: string }[] = [
  { value: "CONCISE", title: "Short", description: "A few sentences for quick lookups." },
  { value: "BALANCED", title: "Balanced", description: "The answer first, then key details." },
  { value: "DETAILED", title: "Detailed", description: "Thorough, with steps and context." },
];

export interface Starter {
  title: string;
  prompt: string;
}

/** `WorkspaceAssistant` as the API returns it (the fields this page edits). */
export interface AssistantLike {
  instructions?: string;
  answerLength?: AnswerLength;
  capabilities?: { webSearch?: boolean; fileWork?: boolean; charts?: boolean };
  welcomeMessage?: string;
  starterPrompts?: { title?: string; prompt?: string; roles?: string[] }[];
  etag?: string;
}

export interface AssistantDraft {
  instructions: string;
  style: AnswerLength;
  fileWork: boolean;
  welcome: string;
  /** One shared list (`""` key) or one list per role name. */
  starters: Record<string, Starter[]>;
}

/** Roles with their own starters, or null when everyone shares one list. */
export const rolesOf = (d: AssistantDraft): string[] | null => {
  const keys = Object.keys(d.starters).filter((k) => k !== "");
  return keys.length ? keys : null;
};

export function toDraft(a: AssistantLike): AssistantDraft {
  const starters: Record<string, Starter[]> = {};
  for (const s of a.starterPrompts ?? []) {
    const keys = s.roles?.length ? s.roles : [""];
    for (const key of keys) (starters[key] ??= []).push({ title: s.title ?? "", prompt: s.prompt ?? "" });
  }
  if (!Object.keys(starters).length) starters[""] = [];
  return {
    instructions: a.instructions ?? "",
    style: a.answerLength ?? "BALANCED",
    fileWork: a.capabilities?.fileWork ?? true,
    welcome: a.welcomeMessage ?? "",
    starters,
  };
}

/** Body for UpdateWorkspaceAssistant (trimmed), plus its update mask. */
export function toPatch(d: AssistantDraft, current: AssistantLike): { body: AssistantLike; updateMask: string } {
  const starterPrompts = Object.entries(d.starters).flatMap(([role, list]) =>
    list.map((s) => ({ title: s.title.trim(), prompt: s.prompt.trim(), roles: role ? [role] : [] })),
  );
  return {
    body: {
      instructions: d.instructions,
      answerLength: d.style,
      capabilities: { webSearch: current.capabilities?.webSearch ?? false, charts: current.capabilities?.charts ?? true, fileWork: d.fileWork },
      welcomeMessage: d.welcome.trim(),
      starterPrompts,
      etag: current.etag,
    },
    updateMask: "instructions,answerLength,capabilities,welcomeMessage,starterPrompts",
  };
}

/** Error/touched key of a starter field (`role-st0t`). */
export const starterKey = (role: string, i: number, field: "t" | "p") => `${role ? `${role}-` : ""}st${i}${field}`;

export function draftErrors(d: AssistantDraft): Record<string, string> {
  const e: Record<string, string> = {};
  if (d.instructions.length > MAX_INSTRUCTIONS) e.instructions = `Shorten by ${(d.instructions.length - MAX_INSTRUCTIONS).toLocaleString("en-US")} characters.`;
  if (!d.welcome.trim()) e.welcome = "Enter a welcome message.";
  else if (d.welcome.length > MAX_WELCOME) e.welcome = `Keep it to ${MAX_WELCOME} characters.`;
  for (const [role, list] of Object.entries(d.starters)) {
    list.forEach((s, i) => {
      if (!s.title.trim()) e[starterKey(role, i, "t")] = "Add a title.";
      if (!s.prompt.trim()) e[starterKey(role, i, "p")] = "Add the prompt it sends.";
    });
  }
  return e;
}

/** Stable comparison key (trimmed starters compare as published). */
export const draftKey = (d: AssistantDraft) =>
  JSON.stringify([
    d.instructions,
    d.style,
    d.fileWork,
    d.welcome,
    Object.entries(d.starters)
      .filter(([, l]) => l.length)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([r, l]) => [r, l.map((s) => [s.title, s.prompt])]),
  ]);

/** Moves starter `i` by `delta` (±1) within its list; out of range is a no-op. */
export function moveStarter(list: readonly Starter[], i: number, delta: number): Starter[] {
  const j = i + delta;
  if (j < 0 || j >= list.length) return [...list];
  const next = [...list];
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}
