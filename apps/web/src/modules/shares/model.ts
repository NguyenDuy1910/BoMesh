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

/** Lifetime choices of an invite, in days (`""` = no expiry), and the `expireTime` they give. */
export const INVITE_EXPIRY: readonly (readonly [string, string])[] = [["1", "1 ngày"], ["7", "7 ngày"], ["30", "30 ngày"], ["", "Không hết hạn"]];
export const INVITE_USES: readonly (readonly [string, string])[] = [["", "Không giới hạn"], ["1", "1 người"], ["10", "10 người"], ["50", "50 người"]];
export function expireTimeAfter(days: string, now: number): string | undefined {
  return days ? new Date(now + Number(days) * 86_400_000).toISOString() : undefined;
}

/** "Đã dùng 3/25" · "Đã dùng 4 lần" · "Chưa được dùng". */
export function usesLine(useCount: number | undefined, maxUses: number | undefined): string {
  const n = useCount ?? 0;
  if (maxUses) return `Đã dùng ${n}/${maxUses}`;
  return n ? `Đã dùng ${n} lần` : "Chưa được dùng";
}

const ROLE_WORD: Readonly<Record<string, string>> = {
  workspaceAdmin: "Quản trị viên",
  workspaceMember: "Thành viên",
  collectionOwner: "Chủ sở hữu",
  collectionEditor: "Người chỉnh sửa",
  collectionViewer: "Người xem",
  spaceLead: "Trưởng nhóm",
  spaceStaff: "Nhân viên",
  spaceMember: "Thành viên",
};
/** A role resource name in words: built-in roles by name, custom ones from their ID ("knowledgeManager" → "Knowledge manager"). */
export function roleWord(role: string | undefined): string {
  const id = (role ?? "").split("/").pop() ?? "";
  if (ROLE_WORD[id]) return ROLE_WORD[id];
  const words = id.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[-_]/g, " ").toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Thành viên";
}
