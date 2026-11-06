"use client";

import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import { api, call, type Schema } from "@/lib/api/client";
import { hasStoredLanguage, onLanguageChange, setLanguage, type Language } from "@/lib/i18n";
import { useSession } from "@/lib/session";
import {
  fromRemoteAppearance,
  hasStoredAppearance,
  onAppearanceChange,
  setAppearance,
  toRemoteAppearance,
  type AppearanceState,
} from "@/lib/theme";

/**
 * The caller's account preferences (`users/me/preferences`): interface
 * language, appearance, work steps and email notifications. Language and
 * appearance apply on this device at once and are saved to the account, so
 * a new device starts with them.
 */
export type UserPreferences = Schema<"UserPreferences">;

export const preferencesQueryKey = ["users", "me", "preferences"] as const;

export function useMyPreferences() {
  const session = useSession();
  return useQuery({
    queryKey: [...preferencesQueryKey, session?.user.name],
    queryFn: () => call(api.GET("/api/v1/users/{user}/preferences", { params: { path: { user: "me" } } })),
    enabled: Boolean(session),
    staleTime: 5 * 60_000,
  });
}

/** Whether answers show their work steps (Preferences → "Show how answers were found"). Defaults to on. */
export function useShowWorkSteps(): boolean {
  return useMyPreferences().data?.showWorkSteps !== false;
}

/** PATCH with an explicit mask; the cached preferences take the response. */
export async function updateMyPreferences(
  queryClient: QueryClient,
  body: Partial<UserPreferences>,
  updateMask: string,
): Promise<UserPreferences> {
  const saved = await call(
    api.PATCH("/api/v1/users/{user}/preferences", { params: { path: { user: "me" }, query: { updateMask } }, body }),
  );
  queryClient.setQueriesData({ queryKey: preferencesQueryKey }, saved);
  return saved;
}

let appearanceTimer: number | undefined;

/**
 * Keeps device and account in step: a device without its own language or
 * appearance adopts the account's; changes the person makes are saved back
 * (appearance debounced, since the hue slider and theme cards change it often).
 */
export function usePreferencesSync(): void {
  const queryClient = useQueryClient();
  const { data } = useMyPreferences();

  useEffect(() => {
    if (!data) return;
    const lang = data.languageCode?.slice(0, 2);
    if (!hasStoredLanguage() && (lang === "en" || lang === "vi")) void setLanguage(lang, "sync");
    if (!hasStoredAppearance()) {
      const remote = fromRemoteAppearance(data.appearance);
      if (remote) setAppearance(remote, "sync");
    }
  }, [data]);

  useEffect(() => {
    const offLanguage = onLanguageChange((lang: Language) => {
      void updateMyPreferences(queryClient, { languageCode: lang }, "languageCode").catch(() => undefined);
    });
    const offAppearance = onAppearanceChange((next: AppearanceState) => {
      window.clearTimeout(appearanceTimer);
      appearanceTimer = window.setTimeout(() => {
        void updateMyPreferences(queryClient, { appearance: toRemoteAppearance(next) }, "appearance").catch(() => undefined);
      }, 800);
    });
    return () => {
      offLanguage();
      offAppearance();
    };
  }, [queryClient]);
}
