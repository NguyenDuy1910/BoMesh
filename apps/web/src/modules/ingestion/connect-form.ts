/**
 * What the connect wizard checks before it asks the server anything.
 *
 * The server still decides (a token is only good once Confluence says so), but
 * a missing field or a site typed as a sentence is answered at once, beside
 * the field, in the words a person would use.
 */

export interface ConfluenceCredentialInput {
  site: string;
  email: string;
  token: string;
}

export type ConfluenceField = keyof ConfluenceCredentialInput;
export type ConfluenceErrors = Partial<Record<ConfluenceField, string>>;

export interface ConfluenceSite {
  /** "northwind.atlassian.net" — how the account is named. */
  host: string;
  /** Atlassian Cloud, as opposed to Confluence Server or Data Center. */
  cloud: boolean;
  /** The connector's `wiki_base`. */
  wikiBase: string;
}

const HOST_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Reads what someone typed as their site: "northwind",
 * "northwind.atlassian.net", or a full address such as
 * "https://wiki.company.com/confluence" for a self-hosted Confluence.
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
  const cloud = host.endsWith(".atlassian.net");
  if (cloud) return { host, cloud, wikiBase: `https://${host}/wiki` };
  const path = url.pathname.replace(/\/+$/, "");
  return { host, cloud, wikiBase: `${url.protocol}//${url.host}${path}` };
}

/** Field errors for the credentials form. `connectedHosts` are sites this workspace already uses. */
export function confluenceErrors(
  values: ConfluenceCredentialInput,
  connectedHosts: readonly string[] = [],
): ConfluenceErrors {
  const errors: ConfluenceErrors = {};
  if (!values.site.trim()) errors.site = "Enter your Confluence site.";
  else {
    const site = confluenceSite(values.site);
    if (!site) errors.site = "Enter a site like northwind.atlassian.net.";
    else if (connectedHosts.some((host) => host.toLowerCase() === site.host)) {
      errors.site = "This site is already connected. Choose it above.";
    }
  }
  if (!values.email.trim()) errors.email = "Enter the email you use for Confluence.";
  else if (!EMAIL.test(values.email.trim())) errors.email = "Enter a valid email, like you@company.com.";
  if (!values.token.trim()) errors.token = "Paste your API token.";
  return errors;
}

/** Why a new knowledge base name cannot be used, or "" when it can. */
export function knowledgeBaseNameError(name: string, existingTitles: readonly string[]): string {
  const trimmed = name.trim();
  if (!trimmed) return "Name the new knowledge base.";
  if (trimmed.length > 200) return "Use 200 characters or fewer.";
  const lower = trimmed.toLowerCase();
  if (existingTitles.some((title) => title.trim().toLowerCase() === lower)) {
    return "A knowledge base with this name already exists.";
  }
  return "";
}
