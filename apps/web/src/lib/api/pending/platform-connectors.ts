/**
 * Local implementation of `platform.connectors`. Imported only by
 * `modules/platform/api.ts`.
 *
 * Rows come from the connector catalogue (`modules/ingestion/connectors.ts`)
 * plus the built-in file upload. When the REAL `/connections/providers` is
 * readable it decides which connectors this deployment supports, how each
 * authorizes, and whether its OAuth client is already configured; otherwise
 * the catalogue's implemented connectors stand in. Usage counts are seeded.
 *
 * A client secret is validated and then dropped: only `has_secret` is kept,
 * here as on the proposed server, so no secret is ever read back.
 */

import { ApiError } from "@/lib/api/request";
import { pendingCaller, pendingStore, requirePendingPlatformPermission } from "@/lib/api/pending";
import { knowledgeConnectors } from "@/modules/ingestion/connectors";
import { connectionsApi, type ConnectorCapability } from "@/modules/ingestion/integrations-api";
import type { PlatformConnector, PlatformConnectorUpdate } from "@/modules/platform/api";
import { seededInteger } from "@/lib/api/pending/seeded";

interface ConnectorOverride {
  available?: boolean;
  oauth_client?: { client_id: string; has_secret: boolean; updated_at: string; updated_by: string | null };
}

type ConnectorState = Record<string, ConnectorOverride>;

const UPLOAD = { key: "upload", name: "File upload", description: "PDF, Office, text and ZIP files uploaded directly." };

const FALLBACK_OAUTH: Record<string, true> = { google_drive: true, confluence: true };

function authorize() {
  const caller = pendingCaller(null);
  // Mirrors the proposed `platform.connector.manage`, which no session holds yet.
  requirePendingPlatformPermission(caller, "platform.tenant.read", "You need platform permission to manage connectors.");
  const store = pendingStore<ConnectorState>("platform.connectors", caller.accountId, null, () => ({}));
  return { caller, store };
}

async function providers(): Promise<Map<string, ConnectorCapability> | null> {
  try {
    const { items } = await connectionsApi.providers();
    return new Map(items.map((item) => [item.connector_key, item]));
  } catch {
    return null;
  }
}

function connectorRows(registry: Map<string, ConnectorCapability> | null, state: ConnectorState): PlatformConnector[] {
  const builtIn: PlatformConnector = {
    ...UPLOAD,
    built_in: true,
    supported: true,
    available: true,
    authentication: "none",
    workspace_count: 3 + (seededInteger(UPLOAD.key) % 6),
    request_count: 0,
    oauth_client: null,
  };
  const rows = knowledgeConnectors.map((connector): PlatformConnector => {
    const capability = registry?.get(connector.key);
    const supported = registry ? Boolean(capability) : Boolean(connector.overview);
    const authentication = capability
      ? capability.authentication_type === "oauth" || capability.authentication_type === "credentials"
        ? capability.authentication_type
        : "none"
      : FALLBACK_OAUTH[connector.key] ? "oauth" : "credentials";
    const override = state[connector.key] ?? {};
    const available = supported && (override.available ?? capability?.available ?? true);
    const seed = seededInteger(connector.key);
    return {
      key: connector.key,
      name: connector.name,
      description: connector.description,
      built_in: false,
      supported,
      available,
      authentication,
      workspace_count: available ? 1 + (seed % 5) : 0,
      request_count: supported ? 0 : seed % 8,
      oauth_client: supported && authentication === "oauth"
        ? {
          client_id: override.oauth_client?.client_id ?? null,
          has_secret: override.oauth_client?.has_secret ?? false,
          deployment_configured: capability?.authorization_available ?? false,
          updated_at: override.oauth_client?.updated_at ?? null,
          updated_by: override.oauth_client?.updated_by ?? null,
        }
        : null,
    };
  });
  return [builtIn, ...rows];
}

function clientIdProblem(key: string, clientId: string): string | null {
  if (!clientId) return "Enter the client ID.";
  if (key === "google_drive" && !clientId.endsWith(".apps.googleusercontent.com")) {
    return "Google client IDs end with .apps.googleusercontent.com. Copy it from the Google Cloud console.";
  }
  if (!/^[A-Za-z0-9._-]{16,}$/.test(clientId)) return "This doesn’t look like a client ID. Copy the full value.";
  return null;
}

export const pendingPlatformConnectors = {
  async list(): Promise<PlatformConnector[]> {
    const { store } = authorize();
    return connectorRows(await providers(), store.read());
  },

  async update(key: string, body: PlatformConnectorUpdate): Promise<PlatformConnector> {
    const { caller, store } = authorize();
    if (body?.available === undefined && body?.oauth_client === undefined) {
      throw new ApiError("Change availability, the sign-in settings, or both.", 422);
    }
    const state = store.read();
    const registry = await providers();
    const current = connectorRows(registry, state).find((row) => row.key === key);
    if (!current) throw new ApiError("This connector isn’t part of this deployment.", 404);
    if (current.built_in) throw new ApiError(`${current.name} is always available.`, 409);
    if (!current.supported) throw new ApiError(`${current.name} isn’t installed on this deployment yet.`, 409);

    const next: ConnectorOverride = { ...state[key] };
    if (body.available !== undefined) {
      if (typeof body.available !== "boolean") throw new ApiError("Say whether workspaces can connect it.", 422);
      next.available = body.available;
    }
    if (body.oauth_client !== undefined) {
      if (current.authentication !== "oauth") throw new ApiError(`${current.name} doesn’t use an OAuth client.`, 422);
      const clientId = body.oauth_client?.client_id?.trim() ?? "";
      const problem = clientIdProblem(key, clientId);
      if (problem) throw new ApiError(problem, 422);
      const secret = body.oauth_client.client_secret?.trim();
      if (secret !== undefined && secret.length < 16) throw new ApiError("This secret looks too short. Copy the whole value.", 422);
      next.oauth_client = {
        client_id: clientId,
        has_secret: secret ? true : state[key]?.oauth_client?.has_secret ?? false,
        updated_at: new Date().toISOString(),
        updated_by: caller.displayName ?? caller.email,
      };
    }
    const saved = store.write({ ...state, [key]: next });
    return connectorRows(registry, saved).find((row) => row.key === key)!;
  },
};
