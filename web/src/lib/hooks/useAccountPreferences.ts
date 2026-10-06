"use client";

import { useCallback, useSyncExternalStore } from "react";

import {
  APPEARANCE_CHANGE_EVENT,
  APPEARANCE_STORAGE_KEY,
  DEFAULT_APPEARANCE,
  parseAppearance,
  type AppearancePreferences,
} from "@/lib/appearance";
import { getAuthSession } from "@/lib/auth/session";

/** Chat behaviour; kept per signed-in user in this browser. */
interface ChatPreferences {
  enterToSend: boolean;
  showAgentActivity: boolean;
}

export type AccountPreferences = AppearancePreferences & ChatPreferences;

const chatDefaults: ChatPreferences = { enterToSend: true, showAgentActivity: true };
const defaults: AccountPreferences = { ...DEFAULT_APPEARANCE, ...chatDefaults };
const appearanceKeys = Object.keys(DEFAULT_APPEARANCE) as (keyof AppearancePreferences)[];
const chatChangeEvent = "bomesh-account-preferences";

function chatStorageKey() {
  return `bomesh.account.preferences.${getAuthSession()?.user_id ?? "anonymous"}`;
}

function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string | null) {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // Storage can be unavailable (private mode, quota); the change is not kept.
  }
}

// useSyncExternalStore needs a stable snapshot, so the parsed value is reused
// until either stored string (or the signed-in user) changes.
let cached: { source: string; value: AccountPreferences } | null = null;

function getSnapshot(): AccountPreferences {
  const chatKey = chatStorageKey();
  const chatRaw = readStorage(chatKey);
  const appearanceRaw = readStorage(APPEARANCE_STORAGE_KEY);
  const source = `${chatKey}\n${chatRaw}\n${appearanceRaw}`;
  if (cached?.source === source) return cached.value;
  let chat: Partial<ChatPreferences> = {};
  try {
    chat = JSON.parse(chatRaw ?? "{}") as Partial<ChatPreferences>;
  } catch {
    // A corrupt entry is ignored; the defaults apply.
  }
  const value: AccountPreferences = {
    ...parseAppearance(appearanceRaw),
    enterToSend: typeof chat.enterToSend === "boolean" ? chat.enterToSend : chatDefaults.enterToSend,
    showAgentActivity:
      typeof chat.showAgentActivity === "boolean" ? chat.showAgentActivity : chatDefaults.showAgentActivity,
  };
  cached = { source, value };
  return value;
}

function subscribe(onChange: () => void) {
  window.addEventListener(APPEARANCE_CHANGE_EVENT, onChange);
  window.addEventListener(chatChangeEvent, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(APPEARANCE_CHANGE_EVENT, onChange);
    window.removeEventListener(chatChangeEvent, onChange);
    window.removeEventListener("storage", onChange);
  };
}

function save(next: AccountPreferences | null) {
  if (next === null) {
    writeStorage(APPEARANCE_STORAGE_KEY, null);
    writeStorage(chatStorageKey(), null);
  } else {
    const appearance = Object.fromEntries(appearanceKeys.map((key) => [key, next[key]]));
    writeStorage(APPEARANCE_STORAGE_KEY, JSON.stringify(appearance));
    writeStorage(
      chatStorageKey(),
      JSON.stringify({ enterToSend: next.enterToSend, showAgentActivity: next.showAgentActivity }),
    );
  }
  // The boot script in app/layout.tsx listens for this and re-applies the
  // <html> attributes; subscribed hooks re-read their snapshot.
  window.dispatchEvent(new Event(APPEARANCE_CHANGE_EVENT));
  window.dispatchEvent(new Event(chatChangeEvent));
}

/**
 * The one preferences hook. Appearance (theme, accent, background, density,
 * reduced motion) is device-wide and painted on <html> before first render;
 * chat behaviour is kept per user. Option lists for the UI live in
 * `@/lib/appearance`.
 */
export function useAccountPreferences() {
  const preferences = useSyncExternalStore(subscribe, getSnapshot, () => defaults);

  const updatePreferences = useCallback((change: Partial<AccountPreferences>) => {
    save({ ...getSnapshot(), ...change });
  }, []);

  const resetPreferences = useCallback(() => save(null), []);

  return { preferences, resetPreferences, updatePreferences };
}
