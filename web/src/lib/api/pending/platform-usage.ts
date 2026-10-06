/**
 * Local implementation of `platform.usage`. Imported only by
 * `modules/platform/api.ts`.
 *
 * The rows are the REAL workspaces from `/platform/workspaces` (names, member
 * counts, status); the numbers on them are seeded from each workspace's id,
 * so they are stable across reloads. Totals and the daily series are sums of
 * those rows, so every figure on the page agrees. A suspended workspace has no
 * activity. When the workspace list cannot be read, there are no rows and
 * every figure is zero.
 */

import { pendingCaller, requirePendingPlatformPermission } from "@/lib/api/pending";
import { ApiError } from "@/lib/api/request";
import { seededUnit } from "@/lib/api/pending/seeded";
import { workspaceDirectoryApi, type WorkspaceHealth } from "@/modules/manage/access/directory";
import type { PlatformUsage, PlatformUsageTotals, PlatformUsageWindow, PlatformUsageWorkspace } from "@/modules/platform/api";

const DAYS: Record<PlatformUsageWindow, number> = { "7d": 7, "30d": 30, "90d": 90 };
const DAY = 86_400_000;

/** Questions one workspace gets on day `offset` (0 = today, counting back). */
function questionsOn(workspace: WorkspaceHealth, offset: number, today: number): number {
  const members = Math.max(1, workspace.member_count ?? 0);
  // One to four questions per member per working day, as the prototype's workspaces show.
  const perPerson = 1 + 3 * seededUnit(`${workspace.id}:rate`);
  const weekday = new Date(today - offset * DAY).getUTCDay();
  const weekend = weekday === 0 || weekday === 6 ? 0.35 : 1;
  const jitter = 0.7 + 0.6 * seededUnit(`${workspace.id}:${Math.floor((today - offset * DAY) / DAY)}`);
  return Math.round(members * perPerson * weekend * jitter);
}

function span(workspace: WorkspaceHealth, firstOffset: number, days: number, today: number): PlatformUsageTotals & { daily: number[] } {
  const members = workspace.member_count ?? 0;
  if (workspace.status === "suspended") {
    return { questions: 0, active_people: 0, documents_processed: 0, daily: Array(days).fill(0) };
  }
  // Oldest first.
  const daily = Array.from({ length: days }, (_, index) => questionsOn(workspace, firstOffset + days - 1 - index, today));
  const questions = daily.reduce((sum, value) => sum + value, 0);
  const reach = days <= 7 ? 0.6 : days <= 30 ? 0.85 : 1;
  const active = Math.min(members, Math.round(members * (0.35 + 0.4 * seededUnit(`${workspace.id}:${firstOffset}:active`)) * reach));
  const processed = Math.round(days * (0.5 + 4 * seededUnit(`${workspace.id}:${firstOffset}:docs`)));
  return { questions, active_people: questions ? Math.max(1, active) : 0, documents_processed: processed, daily };
}

function sum(rows: readonly PlatformUsageTotals[]): PlatformUsageTotals {
  return rows.reduce(
    (total, row) => ({
      questions: total.questions + row.questions,
      active_people: total.active_people + row.active_people,
      documents_processed: total.documents_processed + row.documents_processed,
    }),
    { questions: 0, active_people: 0, documents_processed: 0 },
  );
}

export const pendingPlatformUsage = {
  async get(window: PlatformUsageWindow): Promise<PlatformUsage> {
    requirePendingPlatformPermission(pendingCaller(null), "platform.tenant.read", "You need platform permission to see usage.");
    const days = DAYS[window];
    if (!days) throw new ApiError("Choose a window of 7, 30 or 90 days.", 422);

    let workspaces: WorkspaceHealth[] = [];
    try {
      workspaces = (await workspaceDirectoryApi.platform.workspaces()).items;
    } catch {
      workspaces = [];
    }
    const now = Date.now();
    const today = Math.floor(now / DAY) * DAY;
    const current = workspaces.map((workspace) => ({ workspace, usage: span(workspace, 0, days, today) }));
    const previous = workspaces.map((workspace) => span(workspace, days, days, today));

    const rows: PlatformUsageWorkspace[] = current
      .map(({ workspace, usage }) => ({
        workspace_id: workspace.id,
        name: workspace.name,
        questions: usage.questions,
        active_people: usage.active_people,
        documents_processed: usage.documents_processed,
      }))
      .sort((left, right) => right.questions - left.questions);

    const daily = Array.from({ length: days }, (_, index) => ({
      date: new Date(today - (days - 1 - index) * DAY).toISOString().slice(0, 10),
      questions: current.reduce((total, { usage }) => total + usage.daily[index], 0),
    }));

    return {
      window,
      start: daily[0].date,
      generated_at: new Date(now).toISOString(),
      totals: sum(rows),
      previous: sum(previous),
      daily,
      workspaces: rows,
    };
  },
};
