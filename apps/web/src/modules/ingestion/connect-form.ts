/**
 * The Confluence API-token form (preview `X.acc.confForm` / `confErrors`):
 * what someone typed as their site, and field errors answered before the
 * server is asked. The server still decides whether the token works (`:test`).
 */

export interface ConfluenceInput {
  site: string;
  email: string;
  token: string;
}

export type ConfluenceField = keyof ConfluenceInput;
export type ConfluenceErrors = Partial<Record<ConfluenceField, string>>;

export const EMPTY_CONFLUENCE: ConfluenceInput = { site: "", email: "", token: "" };

export interface ConfluenceSite {
  /** "northwind.atlassian.net" — how the account is named. */
  host: string;
  /** The connector's `wiki_base` config. */
  wikiBase: string;
}

const HOST_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * "northwind", "northwind.atlassian.net" or a full address such as
 * "https://wiki.company.com/confluence" (self-hosted).
 */
export function confluenceSite(input: string): ConfluenceSite | null {
  const raw = input.trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  let host = url.hostname.toLowerCase();
  if (!host.includes(".")) host = `${host}.atlassian.net`;
  if (!host.split(".").every((label) => HOST_LABEL.test(label))) return null;
  if (host.endsWith(".atlassian.net")) return { host, wikiBase: `https://${host}/wiki` };
  const path = url.pathname.replace(/\/+$/, "");
  return { host, wikiBase: `${url.protocol}//${url.host}${path}` };
}

/** Field errors. `connectedHosts` are sites this workspace already connected. */
export function confluenceErrors(values: ConfluenceInput, connectedHosts: readonly string[] = []): ConfluenceErrors {
  const errors: ConfluenceErrors = {};
  if (!values.site.trim()) errors.site = "Enter your Confluence site.";
  else {
    const site = confluenceSite(values.site);
    if (!site) errors.site = "Use just the site name, like “northwind”.";
    else if (connectedHosts.some((host) => host.toLowerCase() === site.host)) errors.site = "This site is already connected.";
  }
  if (!values.email.trim()) errors.email = "Enter the email you use for Confluence.";
  else if (!EMAIL.test(values.email.trim())) errors.email = "Enter a valid email, like you@company.com.";
  if (!values.token.trim()) errors.token = "Paste your API token.";
  return errors;
}

/** Hosts of the Confluence connections already in the workspace (from their `wiki_base`). */
export function connectedConfluenceHosts(connections: readonly { connector: string; config?: Record<string, string> }[]): string[] {
  return connections
    .filter((c) => c.connector === "connectors/confluence" && c.config?.wiki_base)
    .map((c) => confluenceSite(c.config?.wiki_base ?? "")?.host ?? "")
    .filter(Boolean);
}
