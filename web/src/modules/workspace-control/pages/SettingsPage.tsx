"use client";

import { useState } from "react";

import { SettingRow } from "@/components/patterns";
import { Button } from "@/components/ui/Button";
import { ErrorState } from "@/components/ui/ErrorState";
import { Input } from "@/components/ui/Input";
import { PageLoadingSkeleton } from "@/components/ui/Skeleton";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { useAuthSession } from "@/lib/hooks/useAuthSession";
import { SectionHeader } from "@/modules/workspace-control/components/SectionHeader";
import { workspaceDirectoryApi, type Workspace } from "@/modules/workspace-control/directory";
import { useControlPlaneData } from "@/modules/workspace-control/queries";

export function SettingsPage() {
  const session = useAuthSession();
  const tenantId = session?.active_workspace_id ?? null;
  const query = useControlPlaneData(
    async () => (tenantId ? workspaceDirectoryApi.workspace(tenantId) : null),
    tenantId ?? "",
  );

  return (
    <>
      <SectionHeader section="settings" />
      {query.error ? (
        <ErrorState description={query.error} onAction={query.reload} />
      ) : query.data ? (
        <WorkspaceSettings key={query.data.id} workspace={query.data} />
      ) : (
        <PageLoadingSkeleton label="Loading workspace settings" />
      )}
    </>
  );
}

function WorkspaceSettings({ workspace }: { workspace: Workspace }) {
  const [name, setName] = useState(workspace.name);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <form
      className="configuration"
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        setError(null);
        try {
          await workspaceDirectoryApi.saveWorkspace(workspace.id, { name });
          setNotice("Workspace settings saved");
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : "Could not save the workspace.");
        } finally {
          setBusy(false);
        }
      }}
    >
      <section aria-labelledby="settings-identity" className="configuration-section">
        <h2 className="configuration-heading" id="settings-identity">Workspace identity</h2>
        <label className="configuration-field">Name
          <Input onChange={(event) => setName(event.target.value)} required value={name} />
        </label>
        <label className="configuration-field">Code
          <Input readOnly value={workspace.code} />
          <span className="text-[length:var(--text-size-meta)] text-[var(--text-tertiary)]">Fixed at creation.</span>
        </label>
        <SettingRow
          control={<StatusBadge status={workspace.status} />}
          description="Set by platform control."
          title="Status"
        />
      </section>
      {error && <ErrorState description={error} layout="inline" />}
      <div className="unsaved-bar">
        <span role="status">{notice}</span>
        <Button disabled={!name.trim() || name === workspace.name} loading={busy} type="submit">
          Save changes
        </Button>
      </div>
    </form>
  );
}
