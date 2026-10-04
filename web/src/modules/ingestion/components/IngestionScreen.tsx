"use client";

import { Plus } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";

import { Button } from "@/components/ui/Button";
import { ErrorState } from "@/components/ui/ErrorState";
import { PageLoadingSkeleton } from "@/components/ui/Skeleton";
import { Tabs } from "@/components/ui/Tabs";
import { useToast } from "@/components/ui/Toast";
import { hasSessionPermission } from "@/lib/auth/session";
import { useAuthSession } from "@/lib/hooks/useAuthSession";
import { SectionHeader } from "@/modules/workspace-control/components/SectionHeader";
import { pluralize } from "@/modules/workspace-control/format";
import { useConnectorCatalogue, useSourceInventory } from "@/modules/ingestion/queries";
import type { ScopeNames } from "@/modules/ingestion/run-state";
import type { IngestionRun } from "@/modules/ingestion/runs-api";

import { NewRunDialog } from "./NewRunDialog";
import { RunDetailView } from "./RunDetailView";
import { RunsView } from "./RunsView";
import { SchedulesView } from "./SchedulesView";
import { sourceName } from "./SourceRow";
import { SourcesPanel } from "./SourcesPanel";

const TABS = [
  { id: "sources", label: "Sources" },
  { id: "runs", label: "Runs" },
  { id: "schedules", label: "Schedules" },
] as const;

type IngestionTab = (typeof TABS)[number]["id"];

/** Every address key this page reads; anything else in the query is left alone. */
type RouteKey = "tab" | "run" | "connection" | "collection";

/**
 * Sources are the first decision on this page: which account and content to
 * sync. Runs process the documents that arrive Pending; schedules automate
 * the same sync-then-process path.
 */
export function IngestionScreen() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const { toast } = useToast();
  const session = useAuthSession();
  const inventory = useSourceInventory();
  const catalogue = useConnectorCatalogue();
  const [creating, setCreating] = useState(false);
  const [scheduleSearch, setScheduleSearch] = useState("");

  const read = (key: RouteKey) => params.get(key) ?? "";
  /** Several keys at once: each setter alone would race the others' replace. */
  const navigate = (patch: Partial<Record<RouteKey, string>>) => {
    const next = new URLSearchParams(params.toString());
    for (const [key, value] of Object.entries(patch)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    if (next.get("tab") === "sources") next.delete("tab");
    router.replace(pathname + (next.size ? `?${next.toString()}` : ""), { scroll: false });
  };

  const runId = read("run");
  const tabParam = read("tab");
  const tab: IngestionTab = runId
    ? "runs"
    : TABS.some((item) => item.id === tabParam) ? (tabParam as IngestionTab) : "sources";

  const data = inventory.data;
  const names = useMemo<ScopeNames>(() => {
    const collections = new Map(data?.collections.map((item) => [item.id, item.title]));
    const sources = new Map(data?.sources.map((item) => [item.id, sourceName(item)]));
    return { collection: (id) => collections.get(id), source: (id) => sources.get(id) };
  }, [data]);

  const openRun = (id: string) => navigate({ tab: "runs", run: id });
  /** Started from elsewhere on the page: say so, and offer the way to it. */
  const runStarted = (run: IngestionRun) => {
    toast({
      action: { label: "View run", onClick: () => openRun(run.id) },
      title: `Processing ${pluralize(run.counts.total, "document")}`,
      description: "They show as Processing in Knowledge until they are ready.",
      variant: "success",
    });
  };

  const failedSyncs = data?.sources.filter((source) => source.sync?.status === "failed").length ?? 0;

  const inventorySurface = (render: (value: NonNullable<typeof data>) => React.ReactNode) =>
    inventory.error && !data ? (
      <ErrorState
        className="mt-[var(--space-4)]"
        description={inventory.error}
        layout="inline"
        onAction={inventory.reload}
        title="Sources couldn’t be loaded"
      />
    ) : data ? render(data) : (
      <PageLoadingSkeleton className="pt-[var(--space-4)]" controls label="Loading sources" />
    );

  return (
    <>
      <SectionHeader
        actions={tab === "runs" && !runId ? (
          <Button icon={<Plus size={16} />} onClick={() => setCreating(true)}>New run</Button>
        ) : undefined}
        section="ingestion"
      />
      <div className="tab-bar">
        <Tabs
          activeTab={tab}
          ariaLabel="Ingestion sections"
          idBase="ingestion"
          onChange={(next) => navigate({
            tab: next,
            run: "",
            connection: "",
            collection: "",
          })}
          tabs={TABS.map((item) => ({
            ...item,
            count: item.id === "sources" ? failedSyncs : undefined,
          }))}
          variant="underline"
        />
      </div>
      <div aria-labelledby={`ingestion-${tab}`} className="ingestion-panel" id={`ingestion-${tab}-panel`} role="tabpanel">
        {tab === "runs" && (runId ? (
          <RunDetailView
            key={runId}
            names={names}
            onBack={() => navigate({ run: "" })}
            onOpenRun={openRun}
            runId={runId}
          />
        ) : (
          <RunsView names={names} onOpenRun={openRun} />
        ))}

        {tab === "sources" && inventorySurface((value) => (
          <SourcesPanel
            canManageWorkspace={hasSessionPermission(session, "source.manage")}
            catalogue={catalogue}
            inventory={value}
            navigate={navigate}
            onRunCreated={runStarted}
            route={{
              connection: read("connection"),
              collection: read("collection"),
            }}
          />
        ))}

        {tab === "schedules" && inventorySurface((value) => (
          <SchedulesView
            canManage={hasSessionPermission(session, "source.manage")}
            collectionName={names.collection}
            onSearchChange={setScheduleSearch}
            search={scheduleSearch}
            sources={value.sources}
          />
        ))}
      </div>

      <NewRunDialog
        collections={data?.collections ?? []}
        onClose={() => setCreating(false)}
        onCreated={(run) => {
          setCreating(false);
          openRun(run.id);
        }}
        open={creating}
        sources={data?.sources ?? []}
      />
    </>
  );
}
