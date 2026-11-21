/**
 * Shares (`database_architecture.md` "Resource shares"): pure helpers shared by the share and invite UI and tests.
 * A share's web address is `origin + Share.uri` (`/s/{share}`; an invite's `/s/{token}` exists only in the
 * CreateShare response) — never its API resource name.
 */

/** What a share's `target` resource name points at. */
export type ShareTarget =
  | { kind: "workspace"; workspace: string }
  | { kind: "item"; workspace: string; id: string }
  | { kind: "space"; workspace: string; id: string }
  | { kind: "conversation"; workspace: string; id: string };

/** `workspaces/{w}` · `workspaces/{w}/items/{i}` · `workspaces/{w}/spaces/{s}` · `workspaces/{w}/conversations/{c}`. */
export function parseTarget(target: string | undefined): ShareTarget | null {
  const parts = (target ?? "").split("/");
  if (parts[0] !== "workspaces" || !parts[1]) return null;
  const workspace = parts[1];
  if (parts.length === 2) return { kind: "workspace", workspace };
  if (parts.length !== 4 || !parts[3]) return null;
  if (parts[2] === "items") return { kind: "item", workspace, id: parts[3] };
  if (parts[2] === "spaces") return { kind: "space", workspace, id: parts[3] };
  if (parts[2] === "conversations") return { kind: "conversation", workspace, id: parts[3] };
  return null;
}

/** The URL people open: this site's origin + the share's `uri` (`/s/…`). Null without a `uri`. */
export function shareUrl(origin: string, uri: string | undefined): string | null {
  return uri?.startsWith("/s/") ? `${origin}${uri}` : null;
}

/** The token of a `/s/{token}` path (the last segment), or null. */
export function shareToken(pathname: string): string | null {
  const m = /^\/s\/([^/?#]+)\/?$/.exec(pathname);
  return m ? decodeURIComponent(m[1]) : null;
}

/** Is `next` a share landing (`/s/{token}`)? Signing in or up returns there directly, whatever the workspace. */
export const isShareNext = (next: string | null | undefined): next is string => !!next && shareToken(next.split(/[?#]/)[0]) !== null;

/** Lifetime choices of an invite, in days (`""` = no expiry), and the `expireTime` they give. */
export const INVITE_EXPIRY: readonly (readonly [string, string])[] = [["1", "1 day"], ["7", "7 days"], ["30", "30 days"], ["", "No expiry"]];
export const INVITE_USES: readonly (readonly [string, string])[] = [["", "No limit"], ["1", "1 person"], ["10", "10 people"], ["50", "50 people"]];
export function expireTimeAfter(days: string, now: number): string | undefined {
  return days ? new Date(now + Number(days) * 86_400_000).toISOString() : undefined;
}

/** "3 of 25 used" · "Used 4 times" · "Not used yet". */
export function usesLine(useCount: number | undefined, maxUses: number | undefined): string {
  const n = useCount ?? 0;
  if (maxUses) return `${n} of ${maxUses} used`;
  return n ? `Used ${n} ${n === 1 ? "time" : "times"}` : "Not used yet";
}

const ROLE_WORD: Readonly<Record<string, string>> = {
  workspaceAdmin: "Workspace admin",
  workspaceMember: "Member",
  collectionOwner: "Owner",
  collectionEditor: "Editor",
  collectionViewer: "Viewer",
  spaceLead: "Lead",
  spaceStaff: "Staff",
  spaceMember: "Member",
};
/** A role resource name in words: built-in roles by name, custom ones from their ID ("knowledgeManager" → "Knowledge manager"). */
export function roleWord(role: string | undefined): string {
  const id = (role ?? "").split("/").pop() ?? "";
  if (ROLE_WORD[id]) return ROLE_WORD[id];
  const words = id.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[-_]/g, " ").toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Member";
}
