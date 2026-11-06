import { Globe, Upload } from "lucide-react";
import clsx from "clsx";
import type { ReactNode } from "react";

interface AppMeta {
  /** Product name shown to people ("Google Drive"). */
  name: string;
  /** Who runs it, for copy like "Sign in with {provider}". */
  provider?: string;
  /** Brand glyph at `px` size. Brand colors are the vendors' own (not theme tokens). */
  glyph: (px: number) => ReactNode;
}

/** Connector registry (preview `APPS`): brand name and glyph per connector key. */
export const APPS = {
  gdrive: {
    name: "Google Drive",
    provider: "Google",
    glyph: (s) => (
      <svg width={s} height={s} viewBox="0 0 24 24">
        <path fill="#F5B400" d="M8.1 3h7.8l6.6 11.4h-7.8z" />
        <path fill="#2B7DE9" d="M22.5 14.4 18.6 21H5.4l3.9-6.6z" />
        <path fill="#1E9E5A" d="M8.1 3 1.5 14.4 5.4 21l6.6-11.4z" />
      </svg>
    ),
  },
  confluence: {
    name: "Confluence",
    provider: "Atlassian",
    glyph: (s) => (
      <svg width={s} height={s} viewBox="0 0 24 24">
        <path fill="#1868DB" d="M3.2 16.9c-.3.4-.6 1-.8 1.4-.2.4-.1.9.3 1.1l4 2.5c.4.3 1 .1 1.2-.3.2-.3.4-.8.7-1.3 1.6-2.7 3.3-2.4 6.3-1l4 1.9c.5.2 1 0 1.2-.5l1.9-4.3c.2-.4 0-1-.5-1.2-.9-.4-2.6-1.2-4.1-1.9-5.6-2.7-10.4-2.5-14.2 3.6z" />
        <path fill="#1868DB" opacity=".75" d="M20.8 7.1c.3-.4.6-1 .8-1.4.2-.4.1-.9-.3-1.1l-4-2.5c-.4-.3-1-.1-1.2.3-.2.3-.4.8-.7 1.3-1.6 2.7-3.3 2.4-6.3 1l-4-1.9c-.5-.2-1 0-1.2.5L2 7.6c-.2.4 0 1 .5 1.2.9.4 2.6 1.2 4.1 1.9 5.6 2.7 10.4 2.5 14.2-3.6z" />
      </svg>
    ),
  },
  upload: {
    name: "File upload",
    glyph: (s) => <Upload className="app-icon__lucide" style={{ width: Math.round(s * 0.8), height: Math.round(s * 0.8) }} aria-hidden />,
  },
  sharepoint: {
    name: "SharePoint",
    provider: "Microsoft",
    glyph: (s) => (
      <svg width={s} height={s} viewBox="0 0 24 24">
        <circle cx="11" cy="8" r="6" fill="#036C70" />
        <circle cx="16" cy="13" r="5" fill="#1A9BA1" />
        <circle cx="11.5" cy="17.5" r="4" fill="#37C6D0" />
      </svg>
    ),
  },
  notion: {
    name: "Notion",
    provider: "Notion",
    glyph: (s) => (
      <svg width={s} height={s} viewBox="0 0 24 24">
        <rect x="3" y="3" width="18" height="18" rx="3" fill="#fff" stroke="#111" strokeWidth="1.6" />
        <path d="M8 7.5v9M8 7.5l8 9M16 7.5v9" stroke="#111" strokeWidth="1.8" fill="none" />
      </svg>
    ),
  },
  slack: {
    name: "Slack",
    provider: "Slack",
    glyph: (s) => (
      <svg width={s} height={s} viewBox="0 0 24 24">
        <rect x="9.5" y="2" width="3.5" height="9" rx="1.75" fill="#36C5F0" />
        <rect x="13" y="9.5" width="9" height="3.5" rx="1.75" fill="#2EB67D" />
        <rect x="11" y="13" width="3.5" height="9" rx="1.75" fill="#ECB22E" />
        <rect x="2" y="11" width="9" height="3.5" rx="1.75" fill="#E01E5A" />
      </svg>
    ),
  },
  github: {
    name: "GitHub",
    provider: "GitHub",
    glyph: (s) => (
      <svg width={s} height={s} viewBox="0 0 24 24">
        <path
          className="app-icon__ink"
          d="M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.7c-2.78.6-3.37-1.34-3.37-1.34-.45-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.6.07-.6 1 .07 1.53 1.03 1.53 1.03.89 1.53 2.34 1.09 2.91.83.09-.65.35-1.09.63-1.34-2.22-.25-4.56-1.11-4.56-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.65 0 0 .84-.27 2.75 1.02a9.6 9.6 0 0 1 5 0c1.91-1.29 2.75-1.02 2.75-1.02.55 1.38.2 2.4.1 2.65.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.69-4.57 4.94.36.31.68.92.68 1.85v2.74c0 .27.18.58.69.48A10 10 0 0 0 12 2z"
        />
      </svg>
    ),
  },
  jira: {
    name: "Jira",
    provider: "Atlassian",
    glyph: (s) => (
      <svg width={s} height={s} viewBox="0 0 24 24">
        <path fill="#1868DB" d="M21.6 11.3 12.7 2.4 12 1.7 5.3 8.4 2.4 11.3a1 1 0 0 0 0 1.4l6.1 6.1L12 22.3l6.7-6.7.1-.1 2.8-2.8a1 1 0 0 0 0-1.4zM12 15l-3-3 3-3 3 3z" />
      </svg>
    ),
  },
  website: {
    name: "Website",
    provider: "the website",
    glyph: (s) => <Globe className="app-icon__lucide" style={{ width: Math.round(s * 0.8), height: Math.round(s * 0.8) }} aria-hidden />,
  },
} as const satisfies Record<string, AppMeta>;

export type AppKey = keyof typeof APPS;

/** Registry entry for a connector key; `undefined` for unknown keys. */
export function appOf(key: string): AppMeta | undefined {
  return (APPS as Record<string, AppMeta>)[key];
}

export interface AppIconProps {
  /** Connector key (`gdrive`, `confluence`, …). Unknown keys render an empty tile. */
  app: AppKey | (string & {});
  /** sm 24 · md 32 (default) · lg 40 px tile. */
  size?: "sm" | "md" | "lg";
  className?: string;
}

/** Connector brand glyph on a neutral tile (preview `appIcon(key, size)`). */
export function AppIcon({ app, size = "md", className }: AppIconProps) {
  const px = size === "lg" ? 24 : size === "sm" ? 16 : 20;
  return (
    <span className={clsx("app-icon", size !== "md" && `app-icon--${size}`, className)} aria-hidden>
      {appOf(app)?.glyph(px)}
    </span>
  );
}
