import { en } from "./en";
import { vi } from "./vi";

/**
 * The interface message catalog (localization-standards §3.2): Vietnamese first (`vi.ts`), English typed against it
 * (`en.ts`). Server-safe: the root layout resolves the language from the `bomesh.lang` cookie with it; client
 * components read the active catalog with `useMessages()` (`lib/i18n.ts`).
 */

export type Language = "en" | "vi";

/** The default interface language: new devices, new accounts, signed-out pages and unknown stored values. */
export const DEFAULT_LANGUAGE: Language = "vi";

/** Cookie that carries the interface language, so the server renders the right one. */
export const LANGUAGE_COOKIE = "bomesh.lang";

export const isLanguage = (v: unknown): v is Language => v === "en" || v === "vi";

/** A stored or requested value as a language; anything unknown is the default. */
export const languageOf = (v: unknown): Language => (isLanguage(v) ? v : DEFAULT_LANGUAGE);

/** The locale for Intl and React Aria (`vi-VN`, `en-US`). */
export const localeOf = (lang: Language): string => (lang === "vi" ? "vi-VN" : "en-US");

/** The Vietnamese catalog with literal strings widened: every language's shape, keys and parameters. */
type Widen<T> = T extends string
  ? string
  : T extends (...args: infer A) => string
    ? (...args: A) => string
    : { readonly [K in keyof T]: Widen<T[K]> };

export type Messages = Widen<typeof vi>;

/** A message picked from the catalog: what data modules (navigation, state tables) store instead of display text. */
export type Msg = (m: Messages) => string;

const CATALOGS: Readonly<Record<Language, Messages>> = { vi, en };

export function messagesFor(lang: Language): Messages {
  return CATALOGS[lang];
}
