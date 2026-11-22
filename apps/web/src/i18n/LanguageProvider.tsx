"use client";

import type { ReactNode } from "react";

import type { Language } from "@/i18n/messages";
import { LanguageContext } from "@/lib/i18n";

/** The language the server rendered (the root layout reads the `bomesh.lang` cookie); hydration renders it too. */
export function LanguageProvider({ language, children }: { language: Language; children: ReactNode }) {
  return <LanguageContext.Provider value={language}>{children}</LanguageContext.Provider>;
}
