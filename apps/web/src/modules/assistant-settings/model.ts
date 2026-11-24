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
  { value: "CONCISE", title: "Ngắn gọn", description: "Vài câu, phù hợp để tra nhanh." },
  { value: "BALANCED", title: "Cân bằng", description: "Câu trả lời trước, sau đó là chi tiết chính." },
  { value: "DETAILED", title: "Chi tiết", description: "Đầy đủ, kèm các bước và bối cảnh." },
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

/** The list an audience sees: its own, else Everyone's (`""`). Resolution is role → Everyone. */
export const startersFor = (d: AssistantDraft, audience: string): Starter[] => (audience && d.starters[audience] ? d.starters[audience] : (d.starters[""] ?? []));

export function toDraft(a: AssistantLike): AssistantDraft {
  // Everyone's list always exists; a role's own list only when it has starters.
  const starters: Record<string, Starter[]> = { "": [] };
  for (const s of a.starterPrompts ?? []) {
    const keys = s.roles?.length ? s.roles : [""];
    for (const key of keys) (starters[key] ??= []).push({ title: s.title ?? "", prompt: s.prompt ?? "" });
  }
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
  if (d.instructions.length > MAX_INSTRUCTIONS) e.instructions = `Rút ngắn ${(d.instructions.length - MAX_INSTRUCTIONS).toLocaleString("vi")} ký tự.`;
  if (!d.welcome.trim()) e.welcome = "Nhập lời chào.";
  else if (d.welcome.length > MAX_WELCOME) e.welcome = `Tối đa ${MAX_WELCOME} ký tự.`;
  for (const [role, list] of Object.entries(d.starters)) {
    list.forEach((s, i) => {
      if (!s.title.trim()) e[starterKey(role, i, "t")] = "Thêm tiêu đề.";
      if (!s.prompt.trim()) e[starterKey(role, i, "p")] = "Thêm nội dung câu hỏi sẽ được gửi.";
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
