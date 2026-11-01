/**
 * Local implementation of `platform.capabilities`. Imported only by
 * `modules/platform/api.ts`.
 *
 * The rows are fixed: which capabilities exist and which deployment setting
 * chooses each model. Status and model name come from the REAL
 * `/platform/health` report when the caller may read it
 * (`platform.health.read`); the browser never reads deployment values itself.
 * Capabilities no health probe covers yet say `not_checked`.
 */

import { pendingCaller, requirePendingPlatformPermission } from "@/lib/api/pending";
import { workspaceDirectoryApi, type SystemHealth } from "@/modules/manage/access/directory";
import type { PlatformCapability, PlatformCapabilityKey, PlatformCapabilityStatus } from "@/modules/platform/api";

interface CapabilityRow {
  key: PlatformCapabilityKey;
  name: string;
  description: string;
  setting: string;
  /** The `/platform/health` service that probes it, when one does. */
  probe: string | null;
}

const CAPABILITIES: readonly CapabilityRow[] = [
  {
    key: "chat",
    name: "Answers and reasoning",
    description: "Writes answers and decides when to search knowledge.",
    setting: "OPENROUTER_MODEL",
    probe: "openai_chat",
  },
  {
    key: "embeddings",
    name: "Search understanding",
    description: "Turns passages into searchable meaning.",
    setting: "EMBEDDING_MODEL",
    probe: "openrouter_embeddings",
  },
  {
    key: "vision_parsing",
    name: "Document reading",
    description: "Reads layouts, tables and scanned pages.",
    setting: "BOMESH_DOCLING_MODEL",
    probe: null,
  },
  {
    key: "contextualization",
    name: "Passage context",
    description: "Adds surrounding context to each passage before it is indexed.",
    setting: "BOMESH_CONTEXTUALIZATION_MODEL",
    probe: null,
  },
];

/** The health report also carries the model it probed (OpenAPI omits it from `SystemHealth`). */
type ProbedService = SystemHealth["services"][number] & { model?: string | null };

const STATUS_BY_PROBE: Record<string, PlatformCapabilityStatus> = {
  healthy: "operational",
  degraded: "degraded",
  unhealthy: "down",
  not_configured: "not_configured",
};

export const pendingPlatformCapabilities = {
  async list(): Promise<PlatformCapability[]> {
    const caller = pendingCaller(null);
    requirePendingPlatformPermission(caller, "platform.tenant.read", "You need platform permission to see AI capabilities.");
    let health: SystemHealth | null = null;
    if (caller.platformPermissions.includes("platform.health.read")) {
      try {
        health = await workspaceDirectoryApi.platform.health();
      } catch {
        health = null;
      }
    }
    return CAPABILITIES.map(({ probe, ...row }) => {
      const service = probe
        ? (health?.services.find((candidate) => candidate.name === probe) as ProbedService | undefined)
        : undefined;
      return {
        ...row,
        status: service ? STATUS_BY_PROBE[service.status] ?? "not_checked" : "not_checked",
        model: service?.model ?? null,
        checked_at: service ? health!.checked_at : null,
      };
    });
  },
};
