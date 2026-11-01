import { invalidateApiData } from "@/lib/api/revision";
import { pendingApi } from "@/lib/api/pending";
import * as pendingAssistant from "@/lib/api/pending/assistant-settings";

export type AssistantAnswerLength = "concise" | "balanced" | "detailed";

export interface AssistantCapabilities {
  web_search: boolean;
  /** Read spreadsheets and data, calculate, and create files. */
  file_work: boolean;
  charts: boolean;
}

export interface AssistantStarterPrompt {
  title: string;
  prompt: string;
}

/** How the workspace's assistant answers and what people see on a new chat. */
export interface AssistantSettings {
  instructions: string;
  answer_length: AssistantAnswerLength;
  capabilities: AssistantCapabilities;
  /** Answers always come from company knowledge first; not switchable. */
  knowledge_search_always_on: true;
  welcome_message: string;
  /** At most `ASSISTANT_LIMITS.starterPrompts`, shown in this order. */
  starter_prompts: AssistantStarterPrompt[];
  /** Null until someone saves the settings for the first time. */
  updated_at: string | null;
  updated_by: { id: string; display_name: string | null } | null;
}

/** Omitted fields are kept; `starter_prompts` replaces the whole list. */
export interface AssistantSettingsPatch {
  instructions?: string;
  answer_length?: AssistantAnswerLength;
  capabilities?: Partial<AssistantCapabilities>;
  welcome_message?: string;
  starter_prompts?: AssistantStarterPrompt[];
}

/** Server-enforced limits; forms show them as counters. */
export const ASSISTANT_LIMITS = {
  instructions: 2000,
  welcomeMessage: 60,
  starterPrompts: 3,
  starterTitle: 40,
  starterPrompt: 160,
} as const;

/** API pending: `GET /workspaces/{workspace_id}/assistant-settings` (any member). */
export async function getAssistantSettings(workspaceId: string): Promise<AssistantSettings> {
  return pendingApi("workspace.assistant_settings", () => pendingAssistant.getAssistantSettings(workspaceId));
}

/** API pending: `PATCH /workspaces/{workspace_id}/assistant-settings` (`tenant.manage`). */
export async function updateAssistantSettings(
  workspaceId: string,
  patch: AssistantSettingsPatch,
): Promise<AssistantSettings> {
  const saved = await pendingApi("workspace.assistant_settings", () => pendingAssistant.updateAssistantSettings(workspaceId, patch));
  // The chat home reads the welcome message and starters through the same GET.
  invalidateApiData();
  return saved;
}
