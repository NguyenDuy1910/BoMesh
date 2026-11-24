"use client";

import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import { api, call, type Schema } from "@/lib/api/client";
import { useSession } from "@/lib/session";
import {
  fromRemoteAppearance,
  hasStoredAppearance,
  onAppearanceChange,
  setAppearance,
  toRemoteAppearance,
  type AppearanceState,
} from "@/lib/theme";
import { preferencesQuery, preferencesQueryKey } from "@/lib/workspace";

/**
 * The caller's account preferences (`users/me/preferences`): appearance, work steps and email notifications.
 * Appearance applies on this device at once and is saved to the account, so a new device starts with it. The
 * interface is Vietnamese only for now, so `languageCode` is neither read nor written here.
 */
export type UserPreferences = Schema<"UserPreferences">;

/** Shares its cache entry with workspace resolution (`lib/workspace`), so the shell reads it once. */
export function useMyPreferences() {
  const session = useSession();
  return useQuery({ ...preferencesQuery(session?.user.name), enabled: Boolean(session) });
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
 * Keeps device and account in step: a device without its own appearance adopts the account's; changes the person
 * makes are saved back (debounced, since the hue slider and theme cards change it often).
 */
export function usePreferencesSync(): void {
  const queryClient = useQueryClient();
  const { data } = useMyPreferences();

  useEffect(() => {
    if (!data || hasStoredAppearance()) return;
    const remote = fromRemoteAppearance(data.appearance);
    if (remote) setAppearance(remote, "sync");
  }, [data]);

  useEffect(
    () =>
      onAppearanceChange((next: AppearanceState) => {
        window.clearTimeout(appearanceTimer);
        appearanceTimer = window.setTimeout(() => {
          void updateMyPreferences(queryClient, { appearance: toRemoteAppearance(next) }, "appearance").catch(() => undefined);
        }, 800);
      }),
    [queryClient],
  );
}
