"use client";

import { useQuery } from "@tanstack/react-query";

import { AppIcon } from "@/components/ui/AppIcon";
import { api, call, resourceId } from "@/lib/api/client";
import { useWorkspace } from "@/lib/workspace";

import { useSource } from "../queries";

/** Connector key (`connectors/google_drive`) → AppIcon key. */
export function appKeyOf(connector: string | undefined): string {
  const id = resourceId(connector).toLowerCase();
  if (id.includes("drive")) return "gdrive";
  if (id.includes("confluence")) return "confluence";
  if (id.includes("sharepoint") || id.includes("onedrive")) return "sharepoint";
  if (id.includes("notion")) return "notion";
  if (id.includes("slack")) return "slack";
  if (id.includes("github")) return "github";
  if (id.includes("jira")) return "jira";
  return "website";
}

/** Where a resource came from: the source's connector glyph, or the upload glyph. */
export function useSourceApp(source: string | undefined): { app: string; name: string } {
  const { id } = useWorkspace();
  const src = useSource(source);
  const connection = useQuery({
    queryKey: [id, "connections", resourceId(src.data?.connection)],
    queryFn: () => call(api.GET("/api/v1/workspaces/{workspace}/connections/{connection}", { params: { path: { workspace: id, connection: resourceId(src.data?.connection) } } })),
    enabled: !!src.data?.connection,
    staleTime: 10 * 60_000,
    retry: false,
  });
  if (!source) return { app: "upload", name: "Uploaded file" };
  return { app: connection.data ? appKeyOf(connection.data.connector) : "website", name: src.data?.displayName || "Connected source" };
}

export function SourceIcon({ source, size = "sm" }: { source: string | undefined; size?: "sm" | "md" | "lg" }) {
  const { app } = useSourceApp(source);
  return <AppIcon app={app} size={size} />;
}
