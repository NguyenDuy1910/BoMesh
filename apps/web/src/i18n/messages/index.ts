import { vi } from "./vi";

/**
 * The interface message catalog: Vietnamese only for now (a later phase designs multilingual support). Server-safe;
 * client components read it with `useMessages()` (`lib/i18n.ts`).
 */

/** The interface locale, for Intl and React Aria. */
export const LOCALE = "vi-VN";

/** The catalog with literal strings widened: its shape, keys and parameters. */
type Widen<T> = T extends string
  ? string
  : T extends (...args: infer A) => string
    ? (...args: A) => string
    : { readonly [K in keyof T]: Widen<T[K]> };

export type Messages = Widen<typeof vi>;

/** A message picked from the catalog: what data modules (navigation, state tables) store instead of display text. */
export type Msg = (m: Messages) => string;

export const messages: Messages = vi;
