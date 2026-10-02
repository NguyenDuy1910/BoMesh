"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { DirectoryRow } from "@/components/patterns";
import { CommandBar } from "@/components/layout/CommandBar";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { PageHeader } from "@/components/ui/PageHeader";
import { PageLoadingSkeleton } from "@/components/ui/Skeleton";
import { useWorkspaces, useWorkspaceSwitch } from "@/modules/auth/queries";
import { pluralize } from "@/modules/workspace-control/format";

/**
 * The workspaces this person can open.
 *
 * Only memberships appear: the API issues a session for the workspaces someone
 * actually belongs to, and there is no notion of a workspace being listed to
 * people outside it. Showing a workspace nobody could then enter would be an
 * invitation the server refuses.
 */
export function WorkspaceDiscovery() {
  const router = useRouter();
  const query = useWorkspaces();
  const [search, setSearch] = useState("");
  const { error: switchError, switchingId, switchWorkspace } = useWorkspaceSwitch();
  const term = search.trim().toLowerCase();
  const rows = (query.data ?? []).filter(
    (item) => !term || `${item.name} ${item.code}`.toLowerCase().includes(term),
  );

  const openWorkspace = async (workspaceId: string) => {
    if (await switchWorkspace(workspaceId)) {
      router.replace("/app?action=new");
    }
  };

  // `shell__page` gives this page the control pages' geometry: the same
  // gutter, top offset and maximum width, so its title and list start on the
  // same left edge as theirs.
  return (
    <section aria-label="Your workspaces" className="shell__page">
      <PageHeader description="The workspaces you're a member of." title="Your workspaces" />
      <CommandBar
        count={query.data ? pluralize(rows.length, "workspace") : undefined}
        search={{
          value: search,
          onChange: setSearch,
          placeholder: "Search workspaces…",
          label: "Search workspaces",
        }}
      />
      {query.error ? (
        <ErrorState
          actionLabel="Retry"
          description={query.error}
          onAction={query.reload}
          title="Workspaces could not be loaded"
        />
      ) : !query.data ? (
        <PageLoadingSkeleton label="Loading workspaces" />
      ) : (
        <>
          {switchError && <ErrorState className="mb-[var(--space-3)]" description={switchError} layout="inline" />}
          {!rows.length ? (
            <EmptyState
              description={term ? "Try a different search." : "An administrator can add you to one."}
              size="sm"
              title={term ? "No matching workspaces" : "No workspaces yet"}
            />
          ) : (
            // Rows keep their hover surface but pull it into the gutter, so
            // their text lines up with the title above.
            <div className="-mx-3 divide-y divide-[var(--border-subtle)]">
              {rows.map((item) => (
                <DirectoryRow
                  // What this person may do there, read from the permissions
                  // the session grants — never the role codes behind them.
                  description={item.permissions.includes("tenant.manage") ? "Can manage this workspace" : "Member"}
                  disabled={Boolean(switchingId)}
                  key={item.id}
                  loading={switchingId === item.id}
                  onOpen={() => void openWorkspace(item.id)}
                  provider={`Workspace code ${item.code}`}
                  title={item.name}
                />
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}
