/**
 * Local implementation of `workspace.assistant_settings` (proposed
 * `GET`/`PATCH /workspaces/{workspace_id}/assistant-settings`).
 *
 * Settings belong to the workspace, so the store is workspace-wide (not per
 * account). Reads need membership; writes need `tenant.manage`, as proposed.
 */
import { ApiError } from "@/lib/api/request";
import { pendingCaller, pendingStore, requirePendingPermission, type PendingCaller } from "@/lib/api/pending";
import {
  ASSISTANT_LIMITS,
  type AssistantAnswerLength,
  type AssistantSettings,
  type AssistantSettingsPatch,
  type AssistantStarterPrompt,
} from "@/modules/manage/assistant/api";

const ANSWER_LENGTHS: Record<AssistantAnswerLength, true> = { concise: true, balanced: true, detailed: true };

/** The prototype's defaults, addressed to the caller's workspace. */
function seed(caller: PendingCaller): AssistantSettings {
  const workspaceName = caller.workspace?.name.trim() || "your workspace";
  return {
    instructions: `You are ${workspaceName}’s internal assistant. Answer from company knowledge first and cite every factual claim. If the knowledge does not cover a question, say so and suggest who to ask. Keep answers short and use our product names exactly.`,
    answer_length: "balanced",
    capabilities: { web_search: false, file_work: true, charts: true },
    knowledge_search_always_on: true,
    welcome_message: "What can I help you find?",
    starter_prompts: [
      { title: "Find a policy", prompt: "What does our travel policy say about per diem?" },
      { title: "Summarize a document", prompt: "Summarize the latest release notes in five bullets." },
      { title: "Prepare for a customer", prompt: "Draft a one-page brief for my next Acme meeting." },
    ],
    updated_at: null,
    updated_by: null,
  };
}

function store(caller: PendingCaller) {
  return pendingStore<AssistantSettings>("workspace.assistant_settings", null, caller.workspaceId, () => seed(caller));
}

export function getAssistantSettings(workspaceId: string): AssistantSettings {
  const caller = pendingCaller(workspaceId);
  requirePendingPermission(caller, null, "");
  return store(caller).read();
}

export function updateAssistantSettings(workspaceId: string, patch: AssistantSettingsPatch): AssistantSettings {
  const caller = pendingCaller(workspaceId);
  requirePendingPermission(caller, "tenant.manage", "You don't have permission to change the assistant setup.");
  const current = store(caller).read();
  const next: AssistantSettings = {
    ...current,
    instructions: patch.instructions ?? current.instructions,
    answer_length: patch.answer_length ?? current.answer_length,
    capabilities: { ...current.capabilities, ...patch.capabilities },
    welcome_message: patch.welcome_message?.trim() ?? current.welcome_message,
    starter_prompts: patch.starter_prompts?.map(({ title, prompt }) => ({ title: title.trim(), prompt: prompt.trim() }))
      ?? current.starter_prompts,
    updated_at: new Date().toISOString(),
    updated_by: { id: caller.accountId!, display_name: caller.displayName ?? caller.email },
  };
  if ((patch as { knowledge_search_always_on?: unknown }).knowledge_search_always_on === false) {
    throw new ApiError("Searching company knowledge is always on.", 422);
  }
  validate(next);
  return store(caller).write(next);
}

function validate(settings: AssistantSettings): void {
  const limits = ASSISTANT_LIMITS;
  if (settings.instructions.length > limits.instructions) {
    throw new ApiError(`Keep the instructions to ${limits.instructions.toLocaleString("en-US")} characters.`, 422);
  }
  if (!ANSWER_LENGTHS[settings.answer_length]) throw new ApiError("Choose an answer length.", 422);
  for (const value of Object.values(settings.capabilities)) {
    if (typeof value !== "boolean") throw new ApiError("Turn each capability on or off.", 422);
  }
  if (!settings.welcome_message) throw new ApiError("Enter a welcome message.", 422);
  if (settings.welcome_message.length > limits.welcomeMessage) {
    throw new ApiError(`Keep the welcome message to ${limits.welcomeMessage} characters.`, 422);
  }
  if (settings.starter_prompts.length > limits.starterPrompts) {
    throw new ApiError(`Use up to ${limits.starterPrompts} starter prompts.`, 422);
  }
  settings.starter_prompts.forEach(validateStarter);
}

function validateStarter(starter: AssistantStarterPrompt, index: number): void {
  const position = `Starter ${index + 1}`;
  if (!starter.title) throw new ApiError(`${position}: add a title.`, 422);
  if (starter.title.length > ASSISTANT_LIMITS.starterTitle) {
    throw new ApiError(`${position}: keep the title to ${ASSISTANT_LIMITS.starterTitle} characters.`, 422);
  }
  if (!starter.prompt) throw new ApiError(`${position}: add the prompt it sends.`, 422);
  if (starter.prompt.length > ASSISTANT_LIMITS.starterPrompt) {
    throw new ApiError(`${position}: keep the prompt to ${ASSISTANT_LIMITS.starterPrompt} characters.`, 422);
  }
}
