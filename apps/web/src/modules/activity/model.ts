/**
 * Activity log vocabulary (preview `features/activity.js`): plain-language
 * sentences for AuditEvent `action` codes, areas for `category`, time windows
 * and the target kind of a resource name. Pure; covered by `tests/activity-model.test.mts`.
 */

export type Category = "KNOWLEDGE" | "FILES" | "SOURCES" | "PEOPLE" | "SETTINGS" | "SPACES" | "REQUESTS" | "SIGN_IN";

export const AREAS: readonly { value: Category; label: string; module?: "spaces" | "requests" }[] = [
  { value: "KNOWLEDGE", label: "Knowledge" },
  { value: "FILES", label: "Files" },
  { value: "SOURCES", label: "Sources" },
  { value: "PEOPLE", label: "People & access" },
  { value: "SETTINGS", label: "Settings" },
  { value: "SPACES", label: "Spaces", module: "spaces" },
  { value: "REQUESTS", label: "Requests", module: "requests" },
  { value: "SIGN_IN", label: "Sign-in" },
];

export const areaLabel = (category: string | undefined) => AREAS.find((a) => a.value === category)?.label ?? "Other";

export type Window = "24h" | "7d" | "30d";
export const WINDOWS: readonly { value: Window; label: string; ms: number; summary: "P1D" | "P7D" | "P30D" }[] = [
  { value: "24h", label: "24 hours", ms: 86_400_000, summary: "P1D" },
  { value: "7d", label: "7 days", ms: 7 * 86_400_000, summary: "P7D" },
  { value: "30d", label: "30 days", ms: 30 * 86_400_000, summary: "P30D" },
];

/** Escapes a value for an AIP-160 string literal. */
export const quote = (value: string) => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** ListAuditEvents filter for the window and server-side facets. */
export function auditFilter({ since, category, actor, outcome }: { since: Date; category?: string; actor?: string; outcome?: string }): string {
  const parts = [`createTime >= ${quote(since.toISOString())}`];
  if (category) parts.push(`category = ${quote(category)}`);
  if (actor) parts.push(`actor = ${quote(actor)}`);
  if (outcome) parts.push(`outcome = ${quote(outcome)}`);
  return parts.join(" AND ");
}

/** Sentences for actions whose generic reading would be unclear. */
const SPECIAL: Record<string, string> = {
  CreateSession: "Signed in",
  DeleteSession: "Signed out",
  CreateItemMedia: "Uploaded a file",
  CompleteItemUpload: "Finished an upload",
  CreateMember: "Added a member",
  DeleteMember: "Removed a member",
  SuspendMember: "Suspended a member",
  ActivateMember: "Reactivated a member",
  CreateMembership: "Added someone to a group",
  DeleteMembership: "Removed someone from a group",
  SetWorkspaceIamPolicy: "Changed workspace roles",
  SetItemIamPolicy: "Changed who can open a knowledge base",
  SetSpaceIamPolicy: "Changed space roles",
  UpdateWorkspace: "Changed the workspace name or address",
  UpdateWorkspaceSettings: "Changed the workspace setup",
  UpdateWorkspaceAssistant: "Updated assistant setup",
  ArchiveWorkspace: "Archived the workspace",
  CreateIngestionRun: "Started processing documents",
  CancelIngestionRun: "Cancelled a processing run",
  CreateSync: "Started a sync",
  CreateItem: "Created an item",
  VerifyItem: "Marked a document as verified",
  PublishItem: "Published a document",
  UnpublishItem: "Unpublished a document",
  ApproveContribution: "Approved a contribution",
  RejectContribution: "Declined a contribution",
  RequestContributionChanges: "Asked for changes to a contribution",
  AnalyzeContribution: "Analyzed a contribution",
  ApproveRequest: "Approved a request",
  DenyRequest: "Denied a request",
  ExportAuditEvents: "Exported the activity log",
};

const PAST: Record<string, string> = {
  Create: "Created",
  Update: "Updated",
  Delete: "Deleted",
  Undelete: "Restored",
  Set: "Changed",
  Add: "Added",
  Remove: "Removed",
  Move: "Moved",
  Publish: "Published",
  Unpublish: "Unpublished",
  Verify: "Verified",
  Approve: "Approved",
  Deny: "Denied",
  Reject: "Declined",
  Accept: "Accepted",
  Merge: "Merged",
  Archive: "Archived",
  Suspend: "Suspended",
  Activate: "Activated",
  Pause: "Paused",
  Resume: "Resumed",
  Cancel: "Cancelled",
  Retry: "Retried",
  Enable: "Enabled",
  Disable: "Disabled",
  Export: "Exported",
  Import: "Imported",
  Answer: "Answered",
  Close: "Closed",
  Withdraw: "Withdrew",
  Resubmit: "Resubmitted",
  Revise: "Revised",
  Commit: "Saved",
  Rollback: "Rolled back",
  Dismiss: "Dismissed",
  Reopen: "Reopened",
  Join: "Joined",
  Leave: "Left",
  Test: "Tested",
  Reauthorize: "Reconnected",
  Complete: "Completed",
  Send: "Sent",
  Reset: "Reset",
  Submit: "Submitted",
  Copy: "Copied",
  Mark: "Marked",
  Clear: "Cleared",
};

/** Internal nouns people never see, in product words. */
const NOUN: Record<string, string> = {
  item: "item",
  ingestion: "processing",
  iam: "access",
  policy: "",
  tenant: "workspace",
  collection: "knowledge base",
};

const article = (word: string) => (/^[aeiou]/i.test(word) ? "an" : "a");

/** Plain sentence for an audit `action` (`CreateSpace` → "Created a space"). Never returns the raw code. */
export function describeAction(action: string | undefined | null): string {
  const code = String(action ?? "").trim();
  if (!code) return "Did something";
  if (SPECIAL[code]) return SPECIAL[code];
  const words = code.match(/[A-Z]?[a-z0-9]+|[A-Z]+(?![a-z])/g);
  if (!words?.length) return code[0].toUpperCase() + code.slice(1);
  const [verb, ...rest] = words;
  const past = PAST[verb];
  const noun = rest
    .map((w) => w.toLowerCase())
    .map((w) => NOUN[w] ?? w)
    .filter(Boolean)
    .join(" ");
  if (!past) return [verb[0].toUpperCase() + verb.slice(1).toLowerCase(), noun].filter(Boolean).join(" ");
  return noun ? `${past} ${article(noun)} ${noun}` : past;
}

export type TargetKind = "member" | "user" | "group" | "role" | "item" | "space" | "source" | "connection" | "settings" | "assistant" | "workspace" | "session" | "request" | "topic" | "contribution" | "readingList" | "other";

/** What a target resource name points at, and its bare ID. */
export function targetOf(name: string | undefined | null): { kind: TargetKind; id: string } {
  const parts = String(name ?? "").split("/");
  const id = parts[parts.length - 1] ?? "";
  if (!name) return { kind: "other", id: "" };
  if (parts[0] === "sessions") return { kind: "session", id };
  if (parts[0] === "users") return { kind: "user", id };
  if (parts[0] !== "workspaces") return { kind: "other", id };
  if (parts.length === 2) return { kind: "workspace", id };
  const KINDS: Record<string, TargetKind> = {
    members: "member",
    groups: "group",
    roles: "role",
    items: "item",
    spaces: "space",
    sources: "source",
    connections: "connection",
    settings: "settings",
    assistant: "assistant",
    requests: "request",
    topics: "topic",
    contributions: "contribution",
    readingLists: "readingList",
  };
  return { kind: KINDS[parts[2]] ?? "other", id: parts.length > 3 ? parts[3] : id };
}
