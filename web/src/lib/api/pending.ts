import { ApiError } from "@/lib/api/request";
import { getStoredAuthSession, type AuthSession, type AuthWorkspace } from "@/lib/auth/session";
import { pendingConfig } from "@/lib/config/pending";

/**
 * "UI first, API pending": screens whose backend does not exist yet call a
 * typed client function that routes through `pendingApi`, backed by a local
 * implementation in `lib/api/pending/<feature>.ts`. When the endpoint ships,
 * only the client function body changes (see docs/ux-refactor-plan.md §7);
 * the proposed request/response shapes live in
 * `backend/docs_design/api_contract.md` under "Proposed — UI built, API
 * pending", at the anchor named by `docsAnchor`.
 */
export type PendingFeatureKey =
  | "auth.password_reset"
  | "artifact.manual_revision"
  | "artifact.rename"
  | "artifact.export_formats"
  | "chat.share"
  | "document.move"
  | "document.restore"
  | "collection.general_access"
  | "collection.discovery"
  | "analytics.knowledge_gaps"
  | "workspace.assistant_settings"
  | "audit.export"
  | "workspace.archive"
  | "workspace.branding"
  | "workspace.url_code"
  | "account.notification_prefs"
  | "notifications.inbox"
  | "platform.workspace_admin"
  | "platform.user_admin"
  | "platform.connectors"
  | "platform.capabilities"
  | "platform.usage"
  | "platform.health_history"
  | "platform.audit_export"
  | "workspace.member_remove";

export interface PendingFeature {
  key: PendingFeatureKey;
  title: string;
  proposedEndpoints: string[];
  /** The only module allowed to import this feature's local implementation. */
  module: string;
  /** Anchor of the proposed contract in backend/docs_design/api_contract.md. */
  docsAnchor: string;
}

/** Single source of truth for every pending feature. */
export const PENDING_FEATURES: Record<PendingFeatureKey, PendingFeature> = {
  "auth.password_reset": {
    key: "auth.password_reset",
    title: "Password reset",
    proposedEndpoints: ["POST /auth/password-resets", "POST /auth/password-resets/{token}/complete"],
    module: "modules/auth/api.ts",
    docsAnchor: "proposed-auth-password-reset",
  },
  "artifact.manual_revision": {
    key: "artifact.manual_revision",
    title: "Edit and restore artifact revisions",
    proposedEndpoints: ["POST /artifacts/{artifact_id}/revisions", "DELETE /artifacts/{artifact_id}/revisions/{revision}"],
    module: "modules/chat/api.ts",
    docsAnchor: "proposed-artifact-manual-revision",
  },
  "artifact.rename": {
    key: "artifact.rename",
    title: "Rename artifact",
    proposedEndpoints: ["PATCH /artifacts/{artifact_id}"],
    module: "modules/chat/api.ts",
    docsAnchor: "proposed-artifact-rename",
  },
  "artifact.export_formats": {
    key: "artifact.export_formats",
    title: "Export artifact as CSV, PDF or Markdown",
    proposedEndpoints: ["GET /artifacts/{artifact_id}/revisions/{revision}/export?format="],
    module: "modules/chat/api.ts",
    docsAnchor: "proposed-artifact-export-formats",
  },
  "chat.share": {
    key: "chat.share",
    title: "Share a conversation",
    proposedEndpoints: [
      "POST /conversations/{conversation_id}/shares",
      "GET /conversations/{conversation_id}/shares",
      "DELETE /conversations/{conversation_id}/shares/{share_id}",
      "GET /conversation-shares/{share_id}",
    ],
    module: "modules/chat/api.ts",
    docsAnchor: "proposed-chat-share",
  },
  "document.move": {
    key: "document.move",
    title: "Move documents between collections",
    proposedEndpoints: ["POST /documents/move"],
    module: "modules/knowledge/api.ts",
    docsAnchor: "proposed-document-move",
  },
  "document.restore": {
    key: "document.restore",
    title: "Restore a deleted document",
    proposedEndpoints: ["POST /documents/{document_id}/restore"],
    module: "modules/knowledge/api.ts",
    docsAnchor: "proposed-document-restore",
  },
  "collection.general_access": {
    key: "collection.general_access",
    title: "Knowledge base open to everyone in the workspace",
    proposedEndpoints: [
      "PUT /collections/{collection_id}/access/workspace/{workspace_id}",
      "DELETE /collections/{collection_id}/access/workspace/{workspace_id}",
    ],
    module: "modules/knowledge/api.ts",
    docsAnchor: "proposed-collection-general-access",
  },
  "collection.discovery": {
    key: "collection.discovery",
    title: "Knowledge bases you can ask to join",
    proposedEndpoints: ["GET /collections?visibility=discoverable"],
    module: "modules/knowledge/api.ts",
    docsAnchor: "proposed-collection-discovery",
  },
  "analytics.knowledge_gaps": {
    key: "analytics.knowledge_gaps",
    title: "Knowledge gaps",
    proposedEndpoints: ["GET /workspaces/{workspace_id}/knowledge-gaps?window=", "PATCH /workspaces/{workspace_id}/knowledge-gaps/{gap_id}"],
    module: "modules/manage/overview/api.ts",
    docsAnchor: "proposed-analytics-knowledge-gaps",
  },
  "workspace.assistant_settings": {
    key: "workspace.assistant_settings",
    title: "Assistant settings",
    proposedEndpoints: ["GET /workspaces/{workspace_id}/assistant-settings", "PATCH /workspaces/{workspace_id}/assistant-settings"],
    module: "modules/manage/assistant/api.ts",
    docsAnchor: "proposed-workspace-assistant-settings",
  },
  "audit.export": {
    key: "audit.export",
    title: "Export activity",
    proposedEndpoints: ["GET /audit-logs/export?format=csv"],
    module: "modules/manage/activity/api.ts",
    docsAnchor: "proposed-audit-export",
  },
  "workspace.archive": {
    key: "workspace.archive",
    title: "Archive workspace",
    proposedEndpoints: ["POST /workspaces/{workspace_id}/archive"],
    module: "modules/manage/settings/api.ts",
    docsAnchor: "proposed-workspace-archive",
  },
  "workspace.branding": {
    key: "workspace.branding",
    title: "Workspace accent colour",
    proposedEndpoints: ["GET /workspaces/{workspace_id}", "PATCH /workspaces/{workspace_id}"],
    module: "modules/manage/settings/api.ts",
    docsAnchor: "proposed-workspace-branding",
  },
  "workspace.url_code": {
    key: "workspace.url_code",
    title: "Change the workspace web address",
    proposedEndpoints: ["PATCH /workspaces/{workspace_id}"],
    module: "modules/manage/settings/api.ts",
    docsAnchor: "proposed-workspace-url-code",
  },
  "account.notification_prefs": {
    key: "account.notification_prefs",
    title: "Notification preferences",
    proposedEndpoints: ["GET /me/notification-preferences", "PATCH /me/notification-preferences"],
    module: "modules/account/api.ts",
    docsAnchor: "proposed-account-notification-prefs",
  },
  "notifications.inbox": {
    key: "notifications.inbox",
    title: "Notifications",
    proposedEndpoints: ["GET /notifications", "PATCH /notifications/{notification_id}", "POST /notifications/read-all"],
    module: "modules/notifications/api.ts",
    docsAnchor: "proposed-notifications-inbox",
  },
  "platform.workspace_admin": {
    key: "platform.workspace_admin",
    title: "Create and suspend workspaces",
    proposedEndpoints: ["POST /platform/workspaces", "PATCH /platform/workspaces/{workspace_id}"],
    module: "modules/platform/api.ts",
    docsAnchor: "proposed-platform-workspace-admin",
  },
  "platform.user_admin": {
    key: "platform.user_admin",
    title: "Manage platform users",
    proposedEndpoints: ["PATCH /platform/users/{user_id}"],
    module: "modules/platform/api.ts",
    docsAnchor: "proposed-platform-user-admin",
  },
  "platform.connectors": {
    key: "platform.connectors",
    title: "Connector availability",
    proposedEndpoints: ["GET /platform/connectors", "PATCH /platform/connectors/{connector_key}"],
    module: "modules/platform/api.ts",
    docsAnchor: "proposed-platform-connectors",
  },
  "platform.capabilities": {
    key: "platform.capabilities",
    title: "Platform capabilities",
    proposedEndpoints: ["GET /platform/capabilities"],
    module: "modules/platform/api.ts",
    docsAnchor: "proposed-platform-capabilities",
  },
  "platform.usage": {
    key: "platform.usage",
    title: "Platform usage",
    proposedEndpoints: ["GET /platform/usage?window="],
    module: "modules/platform/api.ts",
    docsAnchor: "proposed-platform-usage",
  },
  "platform.health_history": {
    key: "platform.health_history",
    title: "Platform health history",
    proposedEndpoints: ["GET /platform/health/history?days="],
    module: "modules/platform/api.ts",
    docsAnchor: "proposed-platform-health-history",
  },
  "platform.audit_export": {
    key: "platform.audit_export",
    title: "Platform audit log export",
    proposedEndpoints: ["GET /platform/audit-logs/export?format=csv"],
    module: "modules/platform/api.ts",
    docsAnchor: "proposed-platform-audit-export",
  },
  "workspace.member_remove": {
    key: "workspace.member_remove",
    title: "Remove a member from the workspace",
    proposedEndpoints: ["DELETE /users/{user_id}"],
    module: "modules/manage/access/api.ts",
    docsAnchor: "proposed-workspace-member-remove",
  },
};

/** Whether a pending feature's entry points are rendered in this build. */
export function isPendingFeatureEnabled(key: PendingFeatureKey): boolean {
  const { features } = pendingConfig;
  if (features === "all") return true;
  if (features === "none") return false;
  return features.has(key);
}

/**
 * Hook form of `isPendingFeatureEnabled`. The configuration is inlined at
 * build time, so server and client renders always agree.
 */
export function usePendingFeature(key: PendingFeatureKey): boolean {
  return isPendingFeatureEnabled(key);
}

const failSwitchKey = "bomesh.pending.fail";
const latencyRange = { min: 300, max: 900 } as const;
const isDevelopment = process.env.NODE_ENV !== "production";

declare global {
  // Test seam: a fixed latency in milliseconds (0 under test).
  var __BOMESH_PENDING_LATENCY__: number | undefined;
}

/** Fix the simulated latency (milliseconds); `null` restores 300–900 ms. */
export function setPendingLatency(milliseconds: number | null): void {
  globalThis.__BOMESH_PENDING_LATENCY__ = milliseconds ?? undefined;
}

function simulatedLatency(): number {
  const fixed = globalThis.__BOMESH_PENDING_LATENCY__;
  if (typeof fixed === "number") return fixed;
  return latencyRange.min + Math.round(Math.random() * (latencyRange.max - latencyRange.min));
}

function failureSwitchedOn(key: PendingFeatureKey): boolean {
  if (!isDevelopment) return false;
  const value = browserStorage()?.getItem(failSwitchKey)?.trim();
  if (!value) return false;
  return value === "all" || value.split(",").some((entry) => entry.trim() === key);
}

/**
 * Run a pending feature's local implementation the way a network call would
 * behave: asynchronously, with latency, and failing on demand. Development
 * builds fail every call listed in `localStorage["bomesh.pending.fail"]`
 * (`all` or a comma list of keys) so error states can be exercised.
 */
export async function pendingApi<T>(key: PendingFeatureKey, fn: () => T | Promise<T>): Promise<T> {
  if (isDevelopment) console.info("[pending-api]", key);
  const latency = simulatedLatency();
  if (latency > 0) await new Promise((resolve) => setTimeout(resolve, latency));
  if (failureSwitchedOn(key)) {
    throw new ApiError("This isn't available right now. Try again in a moment.", 503);
  }
  return fn();
}

function browserStorage(): Storage | null {
  try {
    return typeof globalThis.localStorage === "undefined" ? null : globalThis.localStorage;
  } catch {
    return null;
  }
}

/** Server renders and storage-less contexts keep pending state in memory. */
const memoryStorage = new Map<string, string>();

export interface PendingStore<T> {
  readonly storageKey: string;
  /** The stored value, or the deterministic seed when nothing is stored. */
  read(): T;
  write(value: T): T;
  update(change: (current: T) => T): T;
  clear(): void;
}

/**
 * Namespaced JSON store for one pending feature and one caller:
 * `bomesh.pending.<key>.<account>.<workspace>`. `seed` must be deterministic
 * so every reload of an untouched store shows the same data.
 */
export function pendingStore<T>(
  key: PendingFeatureKey,
  accountId: string | null,
  workspaceId: string | null,
  seed: () => T,
): PendingStore<T> {
  // `shared` = workspace-wide data (no account); `global` = not tied to a workspace.
  const storageKey = `bomesh.pending.${key}.${accountId ?? "shared"}.${workspaceId ?? "global"}`;
  const getItem = () => browserStorage()?.getItem(storageKey) ?? memoryStorage.get(storageKey) ?? null;
  const setItem = (serialized: string) => {
    const storage = browserStorage();
    if (storage) storage.setItem(storageKey, serialized);
    else memoryStorage.set(storageKey, serialized);
  };
  const store: PendingStore<T> = {
    storageKey,
    read() {
      const serialized = getItem();
      if (serialized !== null) {
        try {
          return JSON.parse(serialized) as T;
        } catch {
          // A corrupt entry falls back to the seed rather than breaking a screen.
        }
      }
      return seed();
    },
    write(value) {
      setItem(JSON.stringify(value));
      return value;
    },
    update(change) {
      return store.write(change(store.read()));
    },
    clear() {
      browserStorage()?.removeItem(storageKey);
      memoryStorage.delete(storageKey);
    },
  };
  return store;
}

export interface PendingCaller {
  session: AuthSession | null;
  accountId: string | null;
  /** The workspace the call targets (explicit id, else the active workspace). */
  workspaceId: string | null;
  /** The caller's membership in `workspaceId`; null when they are not a member. */
  workspace: AuthWorkspace | null;
  /** Workspace permissions the caller holds in `workspaceId`. */
  permissions: readonly string[];
  platformPermissions: readonly string[];
  displayName: string | null;
  email: string | null;
}

/** Who is calling, read from the signed-in session, for mirrored permission checks. */
export function pendingCaller(workspaceId?: string | null): PendingCaller {
  const session = getStoredAuthSession();
  const targetWorkspaceId = workspaceId ?? session?.active_workspace_id ?? null;
  const workspace = session?.workspaces.find((candidate) => candidate.id === targetWorkspaceId) ?? null;
  const isActive = Boolean(session && targetWorkspaceId === session.active_workspace_id);
  // The token resolves the active workspace's permissions; other memberships carry their own.
  const permissions = isActive ? session!.permissions : workspace?.permissions ?? [];
  return {
    session,
    accountId: session?.user_id ?? null,
    workspaceId: targetWorkspaceId,
    workspace: workspace ?? (isActive && session
      ? { id: session.active_workspace_id, code: "", name: "", role_codes: [], permissions: session.permissions }
      : null),
    permissions,
    platformPermissions: session?.platform_permissions ?? [],
    displayName: session?.display_name ?? null,
    email: session?.email ?? null,
  };
}

/**
 * Mirror the proposed contract's authorization: 401 signed out, 404 for a
 * workspace the caller is not a member of, 403 without the permission.
 */
export function requirePendingPermission(caller: PendingCaller, permission: string | null, message: string): void {
  if (!caller.session) throw new ApiError("Sign in to continue.", 401);
  if (caller.workspaceId && !caller.workspace) throw new ApiError("This workspace isn't available.", 404);
  if (permission && !caller.permissions.includes(permission)) throw new ApiError(message, 403);
}

/** Platform-scope twin of `requirePendingPermission`; workspace grants never imply it. */
export function requirePendingPlatformPermission(caller: PendingCaller, permission: string, message: string): void {
  if (!caller.session) throw new ApiError("Sign in to continue.", 401);
  if (!caller.platformPermissions.includes(permission)) throw new ApiError(message, 403);
}
