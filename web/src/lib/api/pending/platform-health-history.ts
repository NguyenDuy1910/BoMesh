/**
 * Local implementation of `platform.health_history`. Imported only by
 * `modules/platform/api.ts`.
 *
 * The proposed server keeps every periodic probe of `/platform/health`. Until
 * it does, this browser keeps the REAL health reports it has read (each time
 * someone opens or refreshes System health here) and derives the same answer
 * from them: per-day status, uptime and incidents. Nothing is invented: a day
 * nobody checked from this browser is `no_data`.
 */

import { pendingCaller, pendingStore, requirePendingPlatformPermission } from "@/lib/api/pending";
import type { SystemHealth } from "@/modules/manage/access/directory";
import type {
  PlatformHealthDay,
  PlatformHealthHistory,
  PlatformHealthIncident,
  PlatformHealthServiceHistory,
} from "@/modules/platform/api";

interface RecordedCheck {
  checked_at: string;
  services: { name: string; status: string; error_category: string | null }[];
}

interface HistoryState {
  checks: RecordedCheck[];
}

const DAY = 86_400_000;
/** The longest window the proposed endpoint serves. */
const MAX_DAYS = 90;
/** Enough for several checks a day over the longest window. */
const MAX_CHECKS = 2_000;

function store(accountId: string | null) {
  return pendingStore<HistoryState>("platform.health_history", accountId, null, () => ({ checks: [] }));
}

function authorize() {
  const caller = pendingCaller(null);
  requirePendingPlatformPermission(caller, "platform.health.read", "You need platform permission to see system health.");
  return store(caller.accountId);
}

/** A check counts towards uptime only when the service was probed; `not_configured` is a setting, not an outage. */
const counted = (status: string) => status === "healthy" || status === "unhealthy" || status === "degraded";

function serviceHistory(name: string, checks: RecordedCheck[], dates: string[]): PlatformHealthServiceHistory {
  const byDay = new Map<string, { healthy: number; issues: number }>();
  let healthy = 0;
  let total = 0;
  for (const check of checks) {
    const service = check.services.find((candidate) => candidate.name === name);
    if (!service || !counted(service.status)) continue;
    const day = byDay.get(check.checked_at.slice(0, 10)) ?? { healthy: 0, issues: 0 };
    if (service.status === "healthy") {
      day.healthy += 1;
      healthy += 1;
    } else {
      day.issues += 1;
    }
    total += 1;
    byDay.set(check.checked_at.slice(0, 10), day);
  }
  const daily: PlatformHealthDay[] = dates.map((date) => {
    const day = byDay.get(date);
    return { date, status: !day ? "no_data" : day.issues ? "issues" : "healthy", checks: day ? day.healthy + day.issues : 0 };
  });
  return {
    name,
    checks: total,
    uptime_percent: total ? Math.round((healthy / total) * 10_000) / 100 : null,
    daily,
  };
}

/** A run of failed checks for one service, closed by the next healthy check. */
function incidents(checks: RecordedCheck[]): PlatformHealthIncident[] {
  const open = new Map<string, PlatformHealthIncident>();
  const found: PlatformHealthIncident[] = [];
  for (const check of checks) {
    for (const service of check.services) {
      if (!counted(service.status)) continue;
      const current = open.get(service.name);
      if (service.status === "healthy") {
        if (current) {
          current.resolved_at = check.checked_at;
          open.delete(service.name);
        }
      } else if (!current) {
        const incident: PlatformHealthIncident = {
          id: `${service.name}:${check.checked_at}`,
          service: service.name,
          status: service.status === "degraded" ? "degraded" : "unhealthy",
          error_category: service.error_category,
          started_at: check.checked_at,
          resolved_at: null,
        };
        open.set(service.name, incident);
        found.push(incident);
      } else if (service.status === "unhealthy") {
        current.status = "unhealthy";
      }
    }
  }
  return found.sort((a, b) => b.started_at.localeCompare(a.started_at));
}

export const pendingPlatformHealthHistory = {
  /** Keep one real report. Synchronous; called by the client after every `/platform/health` read. */
  record(report: SystemHealth): void {
    const caller = pendingCaller(null);
    if (!caller.platformPermissions.includes("platform.health.read")) return;
    const checkedAt = Date.parse(report.checked_at);
    if (Number.isNaN(checkedAt)) return;
    const cutoff = Date.now() - MAX_DAYS * DAY;
    const checked_at = new Date(checkedAt).toISOString();
    store(caller.accountId).update((state) => {
      if (state.checks.some((check) => check.checked_at === checked_at)) return state;
      const next: RecordedCheck = {
        checked_at,
        services: report.services.map((service) => ({
          name: service.name,
          status: service.status,
          error_category: service.error_category ?? null,
        })),
      };
      const checks = [...state.checks, next]
        .filter((check) => Date.parse(check.checked_at) >= cutoff)
        .sort((a, b) => a.checked_at.localeCompare(b.checked_at))
        .slice(-MAX_CHECKS);
      return { checks };
    });
  },

  async get(days: number): Promise<PlatformHealthHistory> {
    const history = authorize();
    const span = Math.min(Math.max(Math.trunc(days) || 30, 1), MAX_DAYS);
    const today = Date.now();
    // UTC calendar days, oldest first, as the proposed endpoint reports them.
    const dates = Array.from({ length: span }, (_, index) =>
      new Date(today - (span - 1 - index) * DAY).toISOString().slice(0, 10));
    const start = dates[0];
    const checks = history.read().checks.filter((check) => check.checked_at.slice(0, 10) >= start);
    const names = [...new Set(checks.flatMap((check) => check.services.map((service) => service.name)))];
    return {
      days: span,
      start,
      generated_at: new Date(today).toISOString(),
      services: names.map((name) => serviceHistory(name, checks, dates)),
      incidents: incidents(checks),
    };
  },
};
