"use client";

import { useEffect, useState } from "react";

import { usePendingFeature } from "@/lib/api/pending";
import { subscribeApiData } from "@/lib/api/revision";
import { getAssistantSettings, type AssistantStarterPrompt } from "@/modules/manage/assistant/api";

export interface HomeContent {
  welcome: string;
  starters: AssistantStarterPrompt[];
  /** True once the workspace's own settings were read (not the built-in copy). */
  fromWorkspace: boolean;
}

/** Shown when the workspace's assistant settings are unavailable. */
const BUILT_IN: HomeContent = {
  welcome: "What can I help you find?",
  starters: [
    { title: "Find a policy", prompt: "What does our travel policy say about per diem?" },
    { title: "Summarize a document", prompt: "Summarize the latest release notes in five bullets." },
    { title: "Prepare for a meeting", prompt: "Draft a one-page brief for my next customer meeting." },
  ],
  fromWorkspace: false,
};

const MAX_STARTERS = 3;

/**
 * The chat home's welcome and starter prompts, as the workspace set them in
 * Assistant setup (`workspace.assistant_settings`, API pending). Falls back to
 * built-in copy while that is disabled or unreadable; re-reads after a save.
 */
export function useHomeContent(workspaceId: string | null | undefined): { content: HomeContent; loading: boolean } {
  const enabled = usePendingFeature("workspace.assistant_settings");
  const [state, setState] = useState<{ content: HomeContent; loading: boolean }>({
    content: BUILT_IN,
    loading: Boolean(enabled && workspaceId),
  });

  useEffect(() => {
    if (!enabled || !workspaceId) {
      setState({ content: BUILT_IN, loading: false });
      return;
    }
    let cancelled = false;
    const read = () => {
      getAssistantSettings(workspaceId)
        .then((settings) => {
          if (cancelled) return;
          setState({
            content: {
              welcome: settings.welcome_message.trim() || BUILT_IN.welcome,
              starters: settings.starter_prompts.slice(0, MAX_STARTERS),
              fromWorkspace: true,
            },
            loading: false,
          });
        })
        .catch(() => {
          if (!cancelled) setState({ content: BUILT_IN, loading: false });
        });
    };
    read();
    const stop = subscribeApiData(read);
    return () => {
      cancelled = true;
      stop();
    };
  }, [enabled, workspaceId]);

  return state;
}
