"use client";

import { BookOpen, ChevronRight, FileText, Folder, Pause, Play, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Drawer, DrawerSection } from "@/components/ui/Drawer";
import { EmptyState } from "@/components/ui/EmptyState";
import { Progress } from "@/components/ui/Progress";
import { Skeleton } from "@/components/ui/Skeleton";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { useToast } from "@/components/ui/Toast";
import { runStatusKey } from "@/lib/status";
import {
  accountLine,
  connectionState,
  needsReconnect,
  sourceName,
  syncChangesText,
} from "@/modules/ingestion/connection-state";
import type { Source } from "@/modules/ingestion/integrations-api";
import { ingestionActions } from "@/modules/ingestion/queries";
import { runProgress } from "@/modules/ingestion/run-state";
import {
  browserTimezone,
  describeDraft,
  describeSchedule,
  draftFromSchedule,
  nextSyncPhrase,
  parseCron,
  timezoneLabel,
  validateDraft,
  type ScheduleDraft,
  type ScheduleErrors,
} from "@/modules/ingestion/schedule";
import { errorMessage, formatDateTime, formatRelative, pluralize } from "@/lib/format";

import { AppIcon } from "./AppIcon";
import { ScheduleFields } from "./ScheduleFields";
import { SourceMenu } from "./SourcesTable";
import type { SourcesModel } from "./SourcesScreen";
import { RunDocuments } from "./SyncHistory";

/** What a provider resource is, in words. */
const RESOURCE_KIND: Record<string, string> = {
  space: "Confluence space and its pages",
  page: "Page and its subpages",
  drive: "Drive and its folders",
  shared_drive: "Shared drive and its folders",
  folder: "Folder and its subfolders",
};

const RECENT_SYNCS = 5;

/** One source (`?source=<id>`): its standing, what it syncs, where to, when, with which account, and lately. */
export function SourceDrawer({
  sourceId,
  model,
  editSchedule,
  onClose,
  onScheduleEditDone,
}: {
  sourceId: string | null;
  model: SourcesModel;
  /** Opened from "Edit schedule": start in the editor. */
  editSchedule: boolean;
  onClose: () => void;
  onScheduleEditDone: () => void;
}) {
  const source = model.data?.sources.find((item) => item.id === sourceId) ?? null;

  if (!sourceId) return null;
  if (!source) {
    return (
      <Drawer onClose={onClose} open title={model.data ? "Source not found" : "Loading source"}>
        {model.data ? (
          <EmptyState
            description="Documents it synced stay in their knowledge base."
            icon={<BookOpen />}
            size="md"
            title="This source was disconnected"
          />
        ) : (
          <div aria-busy="true" className="grid gap-3">
            <span className="sr-only">Loading</span>
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        )}
      </Drawer>
    );
  }
  return (
    <SourceDetail
      editSchedule={editSchedule}
      key={source.id}
      model={model}
      onClose={onClose}
      onScheduleEditDone={onScheduleEditDone}
      source={source}
    />
  );
}

function SourceDetail({
  source,
  model,
  editSchedule,
  onClose,
  onScheduleEditDone,
}: {
  source: Source;
  model: SourcesModel;
  editSchedule: boolean;
  onClose: () => void;
  onScheduleEditDone: () => void;
}) {
  const toast = useToast();
  const connection = model.connection(source.connection_id);
  const kb = model.knowledgeBase(source.collection_id);
  const app = connection ? model.connectorName(connection.connector_key) : "The app";
  const canManage = model.canManageSource(source);
  const key = model.status(source);
  const name = sourceName(source);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<ScheduleDraft | null>(null);
  const [errors, setErrors] = useState<ScheduleErrors>({});
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const startEditing = () => {
    setDraft(draftFromSchedule(source.schedule, browserTimezone()).draft);
    setErrors({});
    setSaveError(null);
    setEditing(true);
  };

  useEffect(() => {
    if (!editSchedule) return;
    if (canManage) {
      setDraft(draftFromSchedule(source.schedule, browserTimezone()).draft);
      setEditing(true);
    }
    onScheduleEditDone();
    // Only the arrival of the deep link starts the editor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editSchedule]);

  const save = async () => {
    if (!draft) return;
    const found = validateDraft(draft);
    setErrors(found);
    if (found.day || found.time) return;
    setSaving(true);
    setSaveError(null);
    try {
      await ingestionActions.saveSchedule(source, draft);
      toast.show({ message: `Schedule saved — ${describeDraft(draft)}` });
      setEditing(false);
    } catch (cause) {
      setSaveError(errorMessage(cause, "The schedule"));
    } finally {
      setSaving(false);
    }
  };

  const runs = (model.data?.runs ?? []).filter((run) => run.scope.source_id === source.id);
  const paused = key === "paused";
  const custom = source.schedule && !parseCron(source.schedule.cron_expression) ? describeSchedule(source.schedule) : undefined;

  const footer = !canManage ? undefined : editing ? (
    <>
      <Button disabled={saving} onClick={() => setEditing(false)} variant="secondary">
        Cancel
      </Button>
      <Button loading={saving} onClick={() => void save()}>
        Save schedule
      </Button>
    </>
  ) : (
    <>
      <Button
        disabled={key === "syncing"}
        icon={paused ? <Play /> : <Pause />}
        onClick={() => void model.act.setPaused(source, !paused)}
        variant="secondary"
      >
        {paused ? "Resume" : "Pause"}
      </Button>
      <Button
        disabled={key === "syncing" || key === "reconnect" || paused}
        icon={<RefreshCw />}
        onClick={() => void model.act.sync(source)}
        variant={key === "reconnect" ? "secondary" : "primary"}
      >
        Sync now
      </Button>
    </>
  );

  return (
    <Drawer
      busy={saving}
      description={[app, kb?.title].filter(Boolean).join(" · ")}
      footer={footer}
      headerActions={canManage && <SourceMenu inDrawer model={model} source={source} />}
      icon={<AppIcon connector={connection?.connector_key ?? "unknown"} />}
      onClose={onClose}
      open
      title={name}
    >
      <SourceStatusBlock model={model} source={source} />

      <DrawerSection title="What’s synced">
        <div className="flex items-center gap-3 rounded-lg border border-border-subtle px-3.5 py-2.5">
          {source.resource_type === "page" ? (
            <FileText aria-hidden="true" className="size-4 shrink-0 text-text-tertiary" />
          ) : source.resource_type === "space" ? (
            <BookOpen aria-hidden="true" className="size-4 shrink-0 text-text-tertiary" />
          ) : (
            <Folder aria-hidden="true" className="size-4 shrink-0 text-text-tertiary" />
          )}
          <span className="min-w-0 flex-1">
            <span className="block truncate">{name}</span>
            <span className="block text-meta text-text-tertiary">
              {RESOURCE_KIND[source.resource_type ?? ""] ?? "Everything this source reads"}
            </span>
          </span>
        </div>
        {canManage && (
          <p className="mt-2 text-meta text-text-tertiary">To sync something else, connect another source.</p>
        )}
      </DrawerSection>

      <DrawerSection title="Destination">
        {kb ? (
          <div className="flex flex-wrap items-center gap-2">
            <Link
              className="inline-flex items-center gap-2 rounded-xs font-medium text-text-primary hover:text-text-accent focus-visible:shadow-(--shadow-focus) focus-visible:outline-none"
              href={`/knowledge/${kb.id}`}
            >
              <BookOpen aria-hidden="true" className="size-4 text-text-tertiary" />
              {kb.title}
            </Link>
            {kb.documentCount !== null && (
              <span className="text-text-tertiary">· {pluralize(kb.documentCount, "document")}</span>
            )}
          </div>
        ) : (
          <p className="text-text-tertiary">You can’t open this knowledge base.</p>
        )}
      </DrawerSection>

      <DrawerSection
        actions={
          canManage && !editing && (
            <Button onClick={startEditing} size="sm" variant="ghost">
              Edit
            </Button>
          )
        }
        title="Schedule"
      >
        {editing && draft ? (
          <div className="grid gap-3">
            <ScheduleFields
              draft={draft}
              errors={errors}
              idBase={`schedule-${source.id}`}
              label="How often to sync"
              onChange={(next) => {
                setDraft(next);
                setErrors({});
              }}
              replaces={custom}
            />
            {saveError && <Callout tone="err">{saveError}</Callout>}
          </div>
        ) : (
          <div>
            <div>
              {describeSchedule(source.schedule)}
              {source.schedule?.timezone && (
                <span className="text-text-tertiary"> ({timezoneLabel(source.schedule.timezone)})</span>
              )}
            </div>
            <div className="mt-0.5 text-meta text-text-tertiary">
              {paused
                ? "Scheduled syncs are off while paused."
                : !source.schedule
                  ? "Syncs when someone clicks Sync now."
                  : !source.schedule.enabled
                    ? "The schedule is off."
                    : key === "reconnect"
                      ? "Scheduled syncs resume after you reconnect."
                      : nextSyncPhrase(source.schedule.next_run_at) ?? ""}
            </div>
          </div>
        )}
      </DrawerSection>

      <DrawerSection title="Account">
        {connection ? (
          <div className="flex items-center gap-3 rounded-lg border border-border-subtle px-3.5 py-2.5">
            <AppIcon connector={connection.connector_key} size="sm" />
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{accountLine(connection)}</span>
              <span className="block text-meta text-text-tertiary">
                {connection.last_checked_at ? `Checked ${formatRelative(connection.last_checked_at)}` : app}
              </span>
            </span>
            <StatusBadge kind="account" value={connectionState(connection).value} />
            {canManage && needsReconnect(connection) && key !== "reconnect" && (
              <Button onClick={() => model.open.reconnect(connection.id)} size="sm" variant="secondary">
                Reconnect
              </Button>
            )}
          </div>
        ) : (
          <p className="text-text-tertiary">The account behind this source was removed.</p>
        )}
      </DrawerSection>

      <DrawerSection
        actions={
          <Button onClick={() => model.open.history(source.id)} size="sm" variant="ghost">
            View all
          </Button>
        }
        title="Recent syncs"
      >
        {source.sync?.last_synced_at && (
          <p className="mb-2 text-meta text-text-secondary">
            Last checked for changes {formatRelative(source.sync.last_synced_at)}: {syncChangesText(source.sync).toLowerCase()}.
          </p>
        )}
        {runs.length ? (
          <ul className="overflow-hidden rounded-lg border border-border-subtle">
            {runs.slice(0, RECENT_SYNCS).map((run) => (
              <li className="border-b border-border-subtle last:border-b-0" key={run.id}>
                <button
                  className="flex w-full items-center gap-3 px-3.5 py-2.5 text-left hover:bg-surface-hover focus-visible:shadow-[inset_0_0_0_2px_var(--focus-ring)] focus-visible:outline-none"
                  onClick={() => model.open.run(run.id)}
                  type="button"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block tabular-nums">{formatDateTime(run.created_at)}</span>
                    <span className="block text-meta text-text-tertiary">
                      <RunDocuments run={run} />
                    </span>
                  </span>
                  <StatusBadge kind="run" value={runStatusKey(run)} />
                  <ChevronRight aria-hidden="true" className="size-4 text-text-tertiary" />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-text-tertiary">No syncs yet.</p>
        )}
      </DrawerSection>
    </Drawer>
  );
}

/** The one thing to know about this source right now, with what fixes it. */
function SourceStatusBlock({ model, source }: { model: SourcesModel; source: Source }) {
  const connection = model.connection(source.connection_id);
  const kb = model.knowledgeBase(source.collection_id);
  const app = connection ? model.connectorName(connection.connector_key) : "The app";
  const canManage = model.canManageSource(source);
  const key = model.status(source);
  const name = sourceName(source);
  const run = model.activeRun(source);

  let main: React.ReactNode = null;
  if (key === "reconnect") {
    main = (
      <Callout
        actions={
          canManage && (
            <Button onClick={() => model.open.reconnect(source.connection_id)} size="sm">
              Reconnect
            </Button>
          )
        }
        title={`${app} access expired`}
        tone="err"
      >
        Reconnect {connection ? accountLine(connection) : "the account"} to resume syncing. Documents already in{" "}
        {kb?.title ?? "the knowledge base"} stay searchable.
      </Callout>
    );
  } else if (key === "syncing") {
    const progress = run ? runProgress(run) : null;
    main = (
      <Callout
        actions={
          run && model.canCancelRun(run) && (
            <Button onClick={() => model.act.cancelRun(run, name)} size="sm" variant="secondary">
              Stop sync
            </Button>
          )
        }
        title={
          progress && progress.total
            ? `Syncing — ${progress.done.toLocaleString()} of ${pluralize(progress.total, "document")}`
            : "Syncing — finding what changed"
        }
        tone="info"
      >
        <Progress
          className="mt-2"
          label={`${name} sync progress`}
          value={progress && progress.total ? progress.percent : undefined}
        />
      </Callout>
    );
  } else if (key === "failed") {
    main = (
      <Callout title="Last sync failed" tone="err">
        {source.sync?.error || "Try syncing again."}
      </Callout>
    );
  } else if (key === "paused") {
    main = (
      <Callout title="Paused" tone="neutral">
        New changes won’t sync until you resume.
      </Callout>
    );
  } else {
    const partial = (model.data?.runs ?? []).find(
      (item) => item.scope.source_id === source.id && runStatusKey(item) === "partial",
    );
    const latest = (model.data?.runs ?? []).find((item) => item.scope.source_id === source.id);
    if (latest && partial && latest.id === partial.id) {
      main = (
        <Callout
          actions={
            <Button onClick={() => model.open.run(partial.id)} size="sm" variant="secondary">
              View details
            </Button>
          }
          title={`${pluralize(partial.counts.failed, "document")} couldn’t be processed`}
          tone="warn"
        />
      );
    } else if (source.sync && source.sync.status === "succeeded" && source.sync.failed > 0) {
      main = (
        <Callout title={`${pluralize(source.sync.failed, "document")} couldn’t be fetched`} tone="warn">
          {source.sync.error || "They are tried again at the next sync."}
        </Callout>
      );
    }
  }

  const waiting =
    key !== "syncing" && key !== "reconnect" && source.pending_documents > 0 && (canManage || model.canRetry) ? (
      <Callout
        actions={
          <Button onClick={() => void model.act.process(source)} size="sm" variant="secondary">
            Process now
          </Button>
        }
        title={`${pluralize(source.pending_documents, "document")} waiting to be made searchable`}
        tone="info"
      >
        They were synced but not processed yet.
      </Callout>
    ) : null;

  if (!main && !waiting) return null;
  return (
    <div className="mb-6 grid gap-2">
      {main}
      {waiting}
    </div>
  );
}
