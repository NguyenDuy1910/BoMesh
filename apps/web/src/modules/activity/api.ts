import { api, call, requestId, resourceId, type Schema } from "@/lib/api/client";

export type AuditEvent = Schema<"AuditEvent">;

/** One page of events matching `filter`, in `orderBy` (`createTime` or `createTime desc`). */
export function listAuditEventPage(workspace: string, filter: string, orderBy: string, pageSize: number, pageToken?: string) {
  return call(
    api.GET("/api/v1/workspaces/{workspace}/auditEvents", {
      params: { path: { workspace }, query: { filter, orderBy, pageSize, pageToken } },
    }),
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
  if (operation.error) throw new Error(operation.error.message || "Không xuất được dữ liệu.");
  const uri = (operation.response as { downloadUri?: string } | undefined)?.downloadUri;
  if (!operation.done || !uri) throw new Error("Tệp xuất vẫn đang được chuẩn bị. Hãy thử lại sau giây lát.");
  return uri;
}
