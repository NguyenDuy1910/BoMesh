import { ApiError } from "@/lib/api/request";
import { getStoredAuthSession, type AuthSession, type AuthWorkspace } from "@/lib/auth/session";
import { pendingConfig } from "@/lib/config/pending";

/**
 * "UI first, API pending": screens whose backend does not exist yet call a
 * typed client function that routes through `pendingApi`, backed by a local
 * implementation in `lib/api/pending/<feature>.ts`. When the v2 method ships,
 * only the client function body changes (see apps/ux_preview/ux-refactor-plan.md §7);
 * the request/response shapes are the v2 operations named by `operationIds`
 * in `backend/docs_design/openapi.yaml` (method catalogue and rules:
 * `backend/docs_design/api_design.md`).
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
  /** The only module allowed to import this feature's local implementation. */
  module: string;
  /** The v2 methods that will serve the feature: `operationId`s in backend/docs_design/openapi.yaml. */
  operationIds: string[];
}

/** Single source of truth for every pending feature. */
export const PENDING_FEATURES: Record<PendingFeatureKey, PendingFeature> = {
  "auth.password_reset": {
    key: "auth.password_reset",
    title: "Password reset",
    module: "modules/auth/api.ts",
    operationIds: ["SendPasswordReset", "ResetPassword"],
  },
  "artifact.manual_revision": {
    key: "artifact.manual_revision",
    title: "Edit and restore artifact revisions",
    module: "modules/chat/api.ts",
    operationIds: ["CommitArtifact", "RollbackArtifact", "DeleteArtifactRevision"],
  },
  "artifact.rename": {
    key: "artifact.rename",
    title: "Rename artifact",
    module: "modules/chat/api.ts",
    operationIds: ["UpdateArtifact"],
  },
  "artifact.export_formats": {
    key: "artifact.export_formats",
    title: "Export artifact as CSV, PDF or Markdown",
    module: "modules/chat/api.ts",
    operationIds: ["ExportArtifact"],
  },
  "chat.share": {
    key: "chat.share",
    title: "Share a conversation",
    module: "modules/chat/api.ts",
    operationIds: ["CreateShare", "ListShares", "GetShare", "DeleteShare"],
  },
  "document.move": {
    key: "document.move",
    title: "Move documents between collections",
    module: "modules/knowledge/api.ts",
    operationIds: ["MoveItem"],
  },
  "document.restore": {
    key: "document.restore",
    title: "Restore a deleted document",
    module: "modules/knowledge/api.ts",
    operationIds: ["UndeleteItem"],
  },
  "collection.general_access": {
    key: "collection.general_access",
    title: "Knowledge base open to everyone in the workspace",
    module: "modules/knowledge/api.ts",
    operationIds: ["GetItemIamPolicy", "SetItemIamPolicy"],
  },
  "collection.discovery": {
    key: "collection.discovery",
    title: "Knowledge bases you can ask to join",
    module: "modules/knowledge/api.ts",
    operationIds: ["ListItems"],
  },
  "analytics.knowledge_gaps": {
    key: "analytics.knowledge_gaps",
    title: "Knowledge gaps",
    module: "modules/manage/overview/api.ts",
    operationIds: ["ListKnowledgeGaps", "DismissKnowledgeGap", "ReopenKnowledgeGap"],
  },
  "workspace.assistant_settings": {
    key: "workspace.assistant_settings",
    title: "Assistant settings",
    module: "modules/manage/assistant/api.ts",
    operationIds: ["GetWorkspaceAssistant", "UpdateWorkspaceAssistant"],
  },
  "audit.export": {
    key: "audit.export",
    title: "Export activity",
    module: "modules/manage/activity/api.ts",
    operationIds: ["ExportAuditEvents"],
  },
  "workspace.archive": {
    key: "workspace.archive",
    title: "Archive workspace",
    module: "modules/manage/settings/api.ts",
    operationIds: ["ArchiveWorkspace", "GetWorkspace"],
  },
  "workspace.branding": {
    key: "workspace.branding",
    title: "Workspace accent colour",
    module: "modules/manage/settings/api.ts",
    operationIds: ["GetWorkspaceSettings", "UpdateWorkspaceSettings"],
  },
  "workspace.url_code": {
    key: "workspace.url_code",
    title: "Change the workspace web address",
    module: "modules/manage/settings/api.ts",
    operationIds: ["GetWorkspace", "UpdateWorkspace"],
  },
  "account.notification_prefs": {
    key: "account.notification_prefs",
    title: "Notification preferences",
    module: "modules/account/api.ts",
    operationIds: ["GetUserPreferences", "UpdateUserPreferences"],
  },
  "notifications.inbox": {
    key: "notifications.inbox",
    title: "Notifications",
    module: "modules/notifications/api.ts",
    operationIds: ["ListNotifications", "UpdateNotification", "MarkNotificationsRead"],
  },
  "platform.workspace_admin": {
    key: "platform.workspace_admin",
    title: "Create and suspend workspaces",
    module: "modules/platform/api.ts",
    operationIds: ["ListWorkspaces", "CreateWorkspace", "SuspendWorkspace", "ActivateWorkspace"],
  },
  "platform.user_admin": {
    key: "platform.user_admin",
    title: "Manage platform users",
    module: "modules/platform/api.ts",
    operationIds: ["ListUsers", "UpdateUser", "SuspendUser", "ActivateUser"],
  },
  "platform.connectors": {
    key: "platform.connectors",
    title: "Connector availability",
    module: "modules/platform/api.ts",
    operationIds: ["ListConnectors", "UpdateConnector", "EnableConnector", "DisableConnector"],
  },
  "platform.capabilities": {
    key: "platform.capabilities",
    title: "Platform capabilities",
    module: "modules/platform/api.ts",
    operationIds: ["ListComponents"],
  },
  "platform.usage": {
    key: "platform.usage",
    title: "Platform usage",
    module: "modules/platform/api.ts",
    operationIds: ["SummarizeWorkspaceUsage"],
  },
  "platform.health_history": {
    key: "platform.health_history",
    title: "Platform health history",
    module: "modules/platform/api.ts",
    operationIds: ["ListComponents", "ListIncidents"],
  },
  "platform.audit_export": {
    key: "platform.audit_export",
    title: "Platform audit log export",
    module: "modules/platform/api.ts",
    operationIds: ["ExportAuditEvents", "ExportPlatformAuditEvents"],
  },
  "workspace.member_remove": {
    key: "workspace.member_remove",
    title: "Remove a member from the workspace",
    module: "modules/manage/access/api.ts",
    operationIds: ["DeleteMember", "CreateMember"],
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
 * Mirror the v2 method's authorization: 401 signed out, 404 for a
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
