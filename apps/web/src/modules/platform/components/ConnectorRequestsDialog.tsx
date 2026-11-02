"use client";

import { Button } from "@/components/ui/Button";
import { Avatar } from "@/components/ui/Avatar";
import { Callout } from "@/components/ui/Callout";
import { Dialog } from "@/components/ui/Dialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { PreviewTag } from "@/components/ui/PreviewTag";
import { SkeletonRows } from "@/components/ui/Skeleton";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { useApiQuery } from "@/lib/hooks/useApiQuery";
import { useAuthSession } from "@/lib/hooks/useAuthSession";
import { approvalRequestsApi, memberName } from "@/modules/manage/access/directory";
import type { PlatformConnector } from "@/modules/platform/api";
import { RowList, RowListItem } from "@/modules/platform/components/Facts";
import { formatDate, pluralize } from "@/lib/format";

/**
 * Demand for a connector this deployment lacks. The count across workspaces
 * is part of `platform.connectors`; the requests listed are the REAL
 * `plugin_installation` requests the caller can read, which the API scopes to
 * the active workspace.
 */
export function ConnectorRequestsDialog({ connector, onClose }: { connector: PlatformConnector | null; onClose: () => void }) {
  const session = useAuthSession();
  const workspaceName = session?.workspaces.find((workspace) => workspace.id === session.active_workspace_id)?.name ?? "your current workspace";
  const key = connector?.key ?? "";
  const requests = useApiQuery(async () => {
    if (!key) return { key, items: [] };
    const page = await approvalRequestsApi.list({ request_type: "plugin_installation", search: key });
    const items = page.items
      .filter((request) => request.request_type === "plugin_installation" && request.target_id === key)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
    return { key, items };
  }, key);
  // A previous connector's answer is not this one's.
  const items = requests.data?.key === key ? requests.data.items : null;

  return (
    <Dialog
      description={connector && (
        <span className="inline-flex flex-wrap items-center gap-2">
          {pluralize(connector.request_count, "workspace")} asked for this connector. <PreviewTag />
        </span>
      )}
      footer={<Button onClick={onClose}>Done</Button>}
      onClose={onClose}
      open={Boolean(connector)}
      title={connector ? `${connector.name} requests` : ""}
    >
      <h3 className="mb-2.5 text-meta font-semibold text-text-primary">In {workspaceName}</h3>
      {requests.error ? (
        <Callout tone="neutral">
          Requests appear here for workspaces where you manage sources. Switch to a workspace you manage to see who asked.
        </Callout>
      ) : !items ? (
        <SkeletonRows columns={2} label="Loading requests" rows={3} />
      ) : !items.length ? (
        <EmptyState
          boxed
          description="When someone asks to add it from Sources, their request shows here."
          size="sm"
          title={`Nobody in ${workspaceName} has asked for it`}
        />
      ) : (
        <RowList label={`${connector?.name ?? "Connector"} requests`}>
          {items.map((request) => {
            const name = memberName({ display_name: request.requester.display_name, email: request.requester.email });
            return (
              <RowListItem className="items-start" key={request.id}>
                <Avatar name={name} size="md" />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{name}</div>
                  {request.reason && <p className="mt-0.5 text-[0.8125rem] text-text-secondary">“{request.reason}”</p>}
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  <StatusBadge kind="request" value={request.status} />
                  <span className="text-meta tabular-nums text-text-tertiary">{formatDate(request.created_at)}</span>
                </div>
              </RowListItem>
            );
          })}
        </RowList>
      )}
    </Dialog>
  );
}
