import { api, call, listAll, requestId, resourceId, type Schema } from "@/lib/api/client";

export type AuditEvent = Schema<"AuditEvent">;

/** Events matching `filter`, newest first (capped; the window keeps lists bounded). */
export function listAuditEvents(workspace: string, filter: string, limit = 1000): Promise<AuditEvent[]> {
  return listAll(
    (pageToken) =>
      call(
        api.GET("/api/v1/workspaces/{workspace}/auditEvents", {
          params: { path: { workspace }, query: { filter, orderBy: "createTime desc", pageSize: 200, pageToken } },
        }),
      ),
    (page) => page.auditEvents,
    limit,
  );
}

export function getAuditEvent(workspace: string, event: string): Promise<AuditEvent> {
  return call(api.GET("/api/v1/workspaces/{workspace}/auditEvents/{auditEvent}", { params: { path: { workspace, auditEvent: resourceId(event) } } }));
}

/** Counts per category over the window (Area filter counts). */
export async function summarizeAuditEvents(workspace: string, window: "P1D" | "P7D" | "P30D"): Promise<Map<string, number>> {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const summary = await call(api.GET("/api/v1/workspaces/{workspace}/auditEvents:summarize", { params: { path: { workspace }, query: { window, timeZone } } }));
  const counts = new Map<string, number>();
  for (const b of summary.buckets ?? []) if (b.category) counts.set(b.category, (counts.get(b.category) ?? 0) + Number(b.eventCount ?? 0));
  return counts;
}

/** ExportAuditEvents → the CSV download URI (the operation completes within the request). */
export async function exportAuditEvents(workspace: string, filter: string): Promise<string> {
  const operation = await call(
    api.POST("/api/v1/workspaces/{workspace}/auditEvents:export", {
      params: { path: { workspace }, query: { requestId: requestId() } },
      body: { filter },
    }),
  );
  if (operation.error) throw new Error(operation.error.message || "The export failed.");
  const uri = (operation.response as { downloadUri?: string } | undefined)?.downloadUri;
  if (!operation.done || !uri) throw new Error("The export is still being prepared. Try again in a moment.");
  return uri;
}
