"use client";

import { CalendarClock } from "lucide-react";
import { useEffect, useId, useState } from "react";

import { CommandBar } from "@/components/layout/CommandBar";
import { Button } from "@/components/ui/Button";
import { CellTitle, DataTable, type Column } from "@/components/ui/DataTable";
import { Dialog } from "@/components/ui/Dialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { FormField } from "@/components/ui/FormField";
import { Select } from "@/components/ui/Select";
import { StatusPill } from "@/components/ui/StatusPill";
import { useToast } from "@/components/ui/Toast";
import { invalidateApiData } from "@/lib/api/revision";
import {
  scheduleCadence,
  scheduleFor,
  scheduleValue,
  sourcesApi,
  SYNC_SCHEDULES,
  type Source,
  type SyncScheduleValue,
} from "@/modules/ingestion/integrations-api";
import { formatDateTime, formatRelative, pluralize } from "@/modules/workspace-control/format";

import { sourceName } from "./SourceRow";

/**
 * When each source syncs on its own.
 *
 * A schedule is a promise about freshness: every firing syncs the source, then
 * processes whatever the sync added or changed, so its documents are searchable
 * without anyone starting a run. Pausing keeps the cadence for later.
 */
export function SchedulesView({
  sources,
  collectionName,
  canManage,
  search,
  onSearchChange,
}: {
  sources: Source[];
  collectionName: (id: string) => string | undefined;
  /** Changing a schedule is source management; others may only read it. */
  canManage: boolean;
  search: string;
  onSearchChange: (value: string) => void;
}) {
  const { toast } = useToast();
  const [editing, setEditing] = useState<Source | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const needle = search.trim().toLowerCase();
  const rows = sources
    .filter((source) => sourceName(source).toLowerCase().includes(needle))
    // Scheduled first: those are what this page is about.
    .sort((left, right) =>
      Number(Boolean(right.schedule)) - Number(Boolean(left.schedule))
      || sourceName(left).localeCompare(sourceName(right)));
  const scheduled = sources.filter((source) => source.schedule).length;

  const toggle = async (source: Source) => {
    if (!source.schedule) return;
    setBusyId(source.id);
    setError(null);
    try {
      await sourcesApi.setScheduleEnabled(source.id, !source.schedule.enabled);
      invalidateApiData();
      toast({
        title: source.schedule.enabled ? `${sourceName(source)} paused` : `${sourceName(source)} resumed`,
        description: source.schedule.enabled
          ? "It keeps its schedule and syncs only when you ask, until you resume it."
          : "It syncs and processes on its schedule again.",
        variant: "success",
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The schedule couldn’t be changed.");
    } finally {
      setBusyId(null);
    }
  };

  const columns: Column<Source>[] = [
    {
      key: "source",
      label: "Source",
      primary: true,
      render: (source) => (
        <CellTitle subtitle={collectionName(source.collection_id)} title={sourceName(source)} />
      ),
    },
    {
      key: "cadence",
      label: "Schedule",
      width: 210,
      render: (source) => source.schedule
        ? scheduleCadence(source.schedule)
        : <span className="text-[var(--text-tertiary)]">Not scheduled</span>,
    },
    {
      key: "state",
      label: "Status",
      width: 120,
      render: (source) => !source.schedule
        ? "—"
        : source.schedule.enabled
          ? <StatusPill tone="success">Active</StatusPill>
          : <StatusPill tone="neutral">Paused</StatusPill>,
    },
    {
      key: "next",
      label: "Next run",
      width: 190,
      priority: "medium",
      render: (source) => source.schedule?.enabled && source.schedule.next_run_at
        ? <span title={formatRelative(source.schedule.next_run_at)}>{formatDateTime(source.schedule.next_run_at)}</span>
        : "—",
    },
  ];

  return (
    <>
      <p className="ingestion-intro">
        A schedule syncs its source, then processes whatever the sync added or changed.
      </p>
      <CommandBar
        count={`${pluralize(scheduled, "schedule")} · ${pluralize(sources.length, "source")}`}
        search={{ value: search, onChange: onSearchChange, placeholder: "Search sources…", label: "Search sources" }}
      />
      {error && (
        <ErrorState
          actionLabel="Dismiss"
          className="mb-[var(--space-3)]"
          description={error}
          layout="inline"
          onAction={() => setError(null)}
        />
      )}
      <DataTable
        ariaLabel="Source schedules"
        columns={columns}
        data={rows}
        emptyState={(
          <EmptyState
            description={search
              ? "Try a different search."
              : "Connect a source first; then choose how often it syncs and processes."}
            icon={<CalendarClock size={20} />}
            size="sm"
            title={search ? "No matching sources" : "No sources to schedule"}
          />
        )}
        rowActions={canManage ? (source) => (
          <>
            {source.schedule && (
              <Button
                loading={busyId === source.id}
                onClick={() => void toggle(source)}
                size="sm"
                variant="ghost"
              >
                {source.schedule.enabled ? "Pause" : "Resume"}
              </Button>
            )}
            <Button onClick={() => setEditing(source)} size="sm" variant="ghost">
              {source.schedule ? "Edit" : "Schedule"}
            </Button>
          </>
        ) : undefined}
      />
      <ScheduleDialog onClose={() => setEditing(null)} source={editing} />
    </>
  );
}

/** Choosing how often one source syncs and processes. */
function ScheduleDialog({ source, onClose }: { source: Source | null; onClose: () => void }) {
  const fieldId = useId();
  const { toast } = useToast();
  const [value, setValue] = useState<SyncScheduleValue | "custom">("daily");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!source) return;
    const current = scheduleValue(source.schedule);
    setValue(current === "manual" ? "daily" : current);
    setBusy(false);
    setError(null);
  }, [source]);

  if (!source) return null;
  const existing = source.schedule;

  const save = async () => {
    // A cron written elsewhere is shown, never rewritten by accident.
    if (value === "custom") return;
    setBusy(true);
    setError(null);
    try {
      const next = scheduleFor(value);
      if (!next) {
        if (existing) await sourcesApi.removeSchedule(source.id);
      } else {
        // Changing the cadence keeps the timezone and paused state it had.
        await sourcesApi.putSchedule(source.id, {
          ...next,
          timezone: existing?.timezone ?? next.timezone,
          enabled: existing?.enabled ?? true,
        });
      }
      invalidateApiData();
      toast({
        title: next ? "Schedule saved" : "Schedule removed",
        description: next
          ? `${sourceName(source)}: ${scheduleCadence(next).toLowerCase()}, then its changes are processed.`
          : `${sourceName(source)} syncs only when someone asks.`,
        variant: "success",
      });
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The schedule couldn’t be saved.");
    } finally {
      setBusy(false);
    }
  };

  const options = [
    ...SYNC_SCHEDULES.map((item) => ({
      value: item.value,
      label: item.value === "manual" ? "Not scheduled" : item.label,
    })),
    ...(value === "custom" && existing ? [{ value: "custom", label: scheduleCadence(existing) }] : []),
  ];

  return (
    <Dialog
      footer={(
        <>
          <Button disabled={busy} onClick={onClose} variant="ghost">Cancel</Button>
          <Button disabled={value === "custom"} loading={busy} onClick={() => void save()}>Save</Button>
        </>
      )}
      onClose={onClose}
      open
      title={`Schedule for ${sourceName(source)}`}
    >
      <div className="grid gap-4">
        {error && <ErrorState description={error} layout="inline" />}
        <FormField
          helperText="Each run syncs the source, then processes what changed."
          htmlFor={`${fieldId}-cadence`}
          label="How often"
          required
        >
          <Select
            id={`${fieldId}-cadence`}
            onChange={(event) => setValue(event.target.value as SyncScheduleValue | "custom")}
            options={options}
            value={value}
          />
        </FormField>
      </div>
    </Dialog>
  );
}
