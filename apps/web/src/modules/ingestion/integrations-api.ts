"use client";

import { apiRequest, queryString, type Paginated } from "@/lib/api/request";

/**
 * Connections and Sources.
 *
 * Three things are kept apart here because they are kept apart everywhere else:
 *
 *   a **connector** is what this deployment can integrate with;
 *   a **connection** is one external account someone authorized;
 *   a **source** is one resource that connection synchronizes.
 *
 * Connecting an account and choosing what to read from it are separate steps,
 * so one Atlassian authorization can feed five spaces into three collections
 * without anyone signing in five times. Nothing here ever handles a token: a
 * connection is identified by its id, and the secret behind it never leaves
 * the server.
 *
 * A source's sync only changes the knowledge inventory: it registers, updates
 * and removes Documents, which then wait as pending until an Ingestion Run
 * processes them.
 */

/** Why a connection cannot be used, in the connection's own words. */
export type ConnectionStatus =
  | "draft"
  | "connected"
  | "expired"
  | "reauth_required"
  | "revoked"
  | "error"
  | "disconnected";

/**
 * Enablement and health. Whether a sync is running right now is `Source.sync`.
 */
export type SourceStatus =
  | "ready"
  | "paused"
  | "failed"
  | "connection_required"
  | "disabled";

/** Connection states that only a person completing a provider flow can clear. */
export const RECONNECT_STATUSES: readonly ConnectionStatus[] = [
  "expired",
  "reauth_required",
  "revoked",
  "disconnected",
];

export interface ConnectorCapability {
  connector_key: string;
  display_name: string;
  authentication_type: "credentials" | "oauth" | "none" | string;
  capabilities: string[];
  /** Whether a secret can be entered directly for this connector. */
  accepts_credentials: boolean;
  /** The identity system behind it, when one authorizes it. */
  provider_key: string | null;
  provider_display_name: string | null;
  /** Everything one authorization of that provider can feed. */
  provider_capabilities: {
    connector_key: string;
    display_name: string;
    resource_type: string;
  }[];
  /** Registered is not the same as configured in this deployment. */
  authorization_available: boolean;
  available: boolean;
}

/** Whose account a connection uses (OpenAPI `Connection.account`). */
export interface ConnectionAccount {
  label: string | null;
  resource_label: string | null;
}

/** A connection exactly as `/connections` returns it (OpenAPI `Connection`). */
export interface Connection {
  id: string;
  connector_key: string;
  display_name: string;
  owner_type: "workspace" | "user";
  owner_user_id: string | null;
  status: ConnectionStatus;
  source_count: number;
  config: Record<string, unknown>;
  account: ConnectionAccount;
  /** Its contents can be listed for a resource picker. */
  browsable: boolean;
  status_detail: string | null;
  connected_at: string | null;
  last_checked_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProviderResource {
  resource_type: string;
  external_id: string;
  name: string;
  parent_id: string | null;
  has_children: boolean;
  url: string | null;
}

/** A schedule as it is written (OpenAPI `SchedulePut`). */
export interface SourceSchedule {
  schedule_type: "cron" | "interval";
  cron_expression: string;
  timezone: string | null;
  enabled: boolean;
  overlap_policy: "skip" | "queue" | "replace";
}

/**
 * A schedule as the API answers it (OpenAPI `Schedule`). Each firing syncs the
 * source, then processes whatever the sync left pending or outdated.
 */
export interface Schedule extends SourceSchedule {
  id: string;
  next_run_at: string | null;
  last_run_at: string | null;
}

/** The latest sync (OpenAPI `SourceSync`). It never processes anything. */
export interface SourceSync {
  status: "running" | "succeeded" | "failed";
  last_synced_at: string | null;
  /** Why it failed, written for people. */
  error: string | null;
  added: number;
  updated: number;
  removed: number;
  failed: number;
}

/** A source exactly as `/sources` returns it (OpenAPI `Source`). */
export interface Source {
  id: string;
  connection_id: string;
  collection_id: string;
  sync_mode: "manual" | "scheduled";
  status: SourceStatus;
  display_name: string | null;
  resource_type: string | null;
  external_resource_id: string | null;
  schedule: Schedule | null;
  /** Null until the first sync starts. */
  sync: SourceSync | null;
  /** Its Documents waiting for processing (pending or outdated). */
  pending_documents: number;
}

export const connectionsApi = {
  /** What this deployment can connect, and how each one is authorized. */
  providers: () =>
    apiRequest<{ items: ConnectorCapability[] }>("/connections/providers"),

  list: (params: { connector_key?: string; status?: string; owner_type?: string } = {}) =>
    apiRequest<Paginated<Connection>>(
      `/connections${queryString({ page_size: 100, ...params })}`,
    ),

  get: (id: string) => apiRequest<Connection>(`/connections/${id}`),

  /**
   * Begin a provider authorization.
   *
   * Nothing is written until the provider hands back a grant, so abandoning
   * the consent screen leaves no half-made connection behind. Pass
   * `connection_id` to renew an existing account rather than add
   * a second one.
   */
  startAuthorization: (body: {
    connector_key: string;
    owner_type: "workspace" | "user";
    connection_id?: string;
  }) =>
    apiRequest<{ authorization_url: string; nonce: string }>(
      "/connections/authorizations",
      { method: "POST", body: JSON.stringify(body) },
    ),

  /** For connectors with no authorization flow, such as a Confluence API token. */
  createWithCredentials: (body: {
    connector_key: string;
    display_name: string;
    config: Record<string, unknown>;
    credentials?: Record<string, unknown>;
    owner_type?: "workspace" | "user";
  }) =>
    apiRequest<Connection>("/connections", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  /** Replaces a credential-backed connection's secret, e.g. a new Confluence API token. */
  updateCredentials: (id: string, credentials: Record<string, unknown>) =>
    apiRequest<Connection>(`/connections/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ credentials }),
    }),

  /** Throws with the provider's own reason when the account can no longer be read. */
  validate: (id: string) =>
    apiRequest<{ valid: boolean; status: ConnectionStatus }>(
      `/connections/${id}/validate`,
      { method: "POST" },
    ),

  remove: (id: string) =>
    apiRequest<void>(`/connections/${id}`, { method: "DELETE" }),

  /** What the authorized account can reach. `parent_id` walks into a container. */
  resources: (
    id: string,
    params: { connector_key?: string; parent_id?: string; search?: string } = {},
  ) =>
    apiRequest<{ items: ProviderResource[] }>(
      `/connections/${id}/resources${queryString(params)}`,
    ),

  createSource: (
    connectionId: string,
    body: {
      collection_id: string;
      display_name?: string;
      resource_type?: string;
      external_resource_id?: string;
      config?: Record<string, unknown>;
      schedule?: SourceSchedule | null;
    },
  ) =>
    apiRequest<Source>(`/connections/${connectionId}/sources`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
};

const sourcePath = (id: string) => `/sources/${encodeURIComponent(id)}`;

export const sourcesApi = {
  list: (params: { connection_id?: string; status?: string } = {}) =>
    apiRequest<Paginated<Source>>(`/sources${queryString({ page_size: 100, ...params })}`),

  get: (id: string) => apiRequest<Source>(sourcePath(id)),

  update: (id: string, body: { display_name?: string; status?: "ready" | "paused" | "disabled" }) =>
    apiRequest<Source>(sourcePath(id), {
      method: "PATCH",
      body: JSON.stringify(body),
    }),

  remove: (id: string) => apiRequest<void>(sourcePath(id), { method: "DELETE" }),

  /** Starts a sync now (409 while one is running). It registers Documents; it processes none. */
  sync: (id: string) =>
    apiRequest<Source>(`${sourcePath(id)}/syncs`, { method: "POST" }),

  /** Creates or replaces the source's schedule. */
  putSchedule: (id: string, body: SourceSchedule) =>
    apiRequest<Schedule>(`${sourcePath(id)}/schedule`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),

  /** Pauses or resumes the schedule without changing its cadence. */
  setScheduleEnabled: (id: string, enabled: boolean) =>
    apiRequest<Schedule>(`${sourcePath(id)}/schedule`, {
      method: "PATCH",
      body: JSON.stringify({ enabled }),
    }),

  removeSchedule: (id: string) =>
    apiRequest<void>(`${sourcePath(id)}/schedule`, { method: "DELETE" }),
};

/** Destination collections. A source has to land in one. */
export const collectionsApi = {
  list: () =>
    apiRequest<Paginated<KnowledgeItem>>(
      `/collections${queryString({ page_size: 100 })}`,
    ),

  create: (title: string) =>
    apiRequest<KnowledgeItem>("/collections", {
      method: "POST",
      body: JSON.stringify({ title }),
    }),
};

/** The collection view `GET /collections` returns, as the destination picker reads it. */
interface ExternalResource {
  id: string;
  external_id: string;
  source_url: string | null;
  ingestion_source_id: string;
  integration_connection: {
    id: string;
    display_name: string;
    connector_key: string;
  };
}

export interface KnowledgeItem {
  [key: string]: unknown;
  id: string;
  item_type: "collection" | "document";
  document_type: string | null;
  title: string;
  mime_type: string | null;
  size_bytes: number | null;
  parent_item_id: string | null;
  parent_relation: string | null;
  status: "pending" | "processing" | "ready" | "failed" | "unsupported";
  indexed: boolean;
  item_count?: number;
  source_count?: number;
  created_by_user_id: string | null;
  created_at: string;
  updated_at: string;
  external_resources: ExternalResource[];
  metadata?: Record<string, unknown>;
  inherit_access?: boolean;
  role_assignments?: CollectionGrant[];
}

interface CollectionGrant {
  [key: string]: unknown;
  item_id?: string | null;
  principal_type: "user" | "group";
  principal_id: string;
  role_id?: string;
  role_code: "collection_owner" | "collection_editor" | "collection_viewer";
  role_display_name?: string;
  created_at?: string;
  updated_at?: string;
}
