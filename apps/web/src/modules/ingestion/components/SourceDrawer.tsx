"use client";

import { Button, Card, Dropdown, Separator } from "@heroui/react";
import { ArrowUpRight, BookOpen, Clock, Folder, History, MoreHorizontal, Pause, Play, Plug, RefreshCw, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { Callout, ChoiceGroup, Disclosure, EmptyState, IconButton, KeyValue, LinkButton, List, ListItem, SkeletonRows, StatusChip } from "@/components/ui";
import { resourceId } from "@/lib/api/client";
import { fmtDateTime, fmtNum, plural, rel, relFuture } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";
import { useItem } from "@/modules/knowledge/queries";

import type { SourceActions } from "../actions";
import type { Connection, Source, Sync } from "../api";
import { accountLabel, accountStatus, accountUser, appName, canTogglePause, lastSyncText, POLICY, POLICY_CHOICES, policyOf, scopeText, sourceName, sourceStatus, syncDeltaText, syncedWithIssues, syncStatus } from "../model";
import { openReconnect } from "../overlays";
import { useSource, useSyncs } from "../queries";
import { draftDirty, draftFrom, nextSyncAt, scheduleText, tzShort, type ScheduleDraft } from "../schedule";
import { ScheduleFields } from "./ScheduleFields";
import { Sheet, SheetSection } from "./Sheet";
import { CollectionLink, SourceAppIcon, SourceStatusChip, useParamState, useSyncIndex } from "./shared";

/** Studio → Sync history filtered to one source. */
export const historyHref = (source: string | undefined) => `/studio?tab=sources&view=history&source=${resourceId(source)}`;

/** The source drawer (preview `DR['src-source']`), opened by `?open=<source id>`. */
export function SourceDrawer({
  sourceId,
  focus,
  connections,
  actions,
  onOpenSync,
}: {
  sourceId: string | null;
  focus: string | null;
  connections: ReadonlyMap<string, Connection>;
  actions: SourceActions;
  onOpenSync: (sync: Sync) => void;
}) {
  const { set } = useParamState();
  const { name: workspace } = useWorkspace();
  const query = useSource(sourceId ? `${workspace}/sources/${sourceId}` : null);
  const close = () => set({ open: null, focus: null });
  const source = query.data;

  if (!sourceId) return <Sheet isOpen={false} onClose={close} title="">{null}</Sheet>;
  if (!source) {
    return (
      <Sheet isOpen onClose={close} title={query.isError ? "Source disconnected" : "Source"}>
        {query.isError ? <EmptyState icon={Plug} title="This source was disconnected" description="Documents it synced stay in their collection." /> : <SkeletonRows rows={5} />}
      </Sheet>
    );
  }
  return <SourceSheet source={source} focus={focus} connections={connections} actions={actions} onClose={close} onOpenSync={onOpenSync} />;
}

function SourceSheet({
  source,
  focus,
  connections,
  actions,
  onClose,
  onOpenSync,
}: {
  source: Source;
  focus: string | null;
  connections: ReadonlyMap<string, Connection>;
  actions: SourceActions;
  onClose: () => void;
  onOpenSync: (sync: Sync) => void;
}) {
  const { can } = useWorkspace();
  const router = useRouter();
  const manage = can("sources.create");
  const connection = connections.get(source.connection);
  const collection = useItem(source.targetCollection);
  const collectionName = collection.data?.displayName;
  const syncs = useSyncs(source.name, 5);
  const status = sourceStatus(source);
  const syncing = status === "syncing";
  const paused = status === "paused";
  const waiting = source.pendingDocumentCount ?? 0;
  const [policyOpen, setPolicyOpen] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(focus === "schedule");

  useEffect(() => {
    if (focus !== "schedule") return;
    setScheduleOpen(true);
    const frame = requestAnimationFrame(() => document.getElementById("src-sched")?.scrollIntoView({ block: "start" }));
    return () => cancelAnimationFrame(frame);
  }, [focus]);

  const menu = manage ? (
    <Dropdown>
      <IconButton icon={MoreHorizontal} tip="More actions" showTip={false} />
      <Dropdown.Popover placement="bottom end">
        <Dropdown.Menu
          aria-label="Source actions"
          onAction={(key) => {
            if (key === "history") router.push(historyHref(source.name));
            if (key === "disconnect") void actions.disconnect(source, collectionName).then((done) => done && onClose());
          }}
        >
          <Dropdown.Item id="history" textValue="View sync history">
            <History className="i" aria-hidden />
            View sync history
          </Dropdown.Item>
          <Separator />
          <Dropdown.Item id="disconnect" textValue="Disconnect" variant="danger">
            <Trash2 className="i" aria-hidden />
            Disconnect
          </Dropdown.Item>
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  ) : null;

  // One primary: the state's fix (Reconnect when expired, Publish when files wait), else Sync now.
  let footer = null;
  if (manage) {
    const syncNow = (primary: boolean) => (
      <Button variant={primary ? "primary" : "secondary"} isDisabled={!connection || paused} isPending={syncing} onPress={() => void actions.syncNow(source)}>
        <RefreshCw className="i" aria-hidden />
        {syncing ? "Syncing…" : "Sync now"}
      </Button>
    );
    if (status === "reconnect")
      footer = (
        <Button variant="primary" onPress={() => openReconnect(source.connection)}>
          Reconnect
        </Button>
      );
    else if (waiting && !syncing)
      footer = (
        <>
          {syncNow(false)}
          <Button variant="primary" onPress={() => void actions.publish([source])}>
            <Play className="i" aria-hidden />
            {`Publish ${fmtNum(waiting)}`}
          </Button>
        </>
      );
    else
      footer = (
        <>
          <Button variant="secondary" isDisabled={syncing || !canTogglePause(source)} onPress={() => void actions.togglePause(source)}>
            {paused ? <Play className="i" aria-hidden /> : <Pause className="i" aria-hidden />}
            {paused ? "Resume" : "Pause"}
          </Button>
          {syncNow(true)}
        </>
      );
  }

  const app = connection?.connector;
  const policy = POLICY[policyOf(source)];
  return (
    <Sheet
      isOpen
      onClose={onClose}
      lead={<SourceAppIcon source={source} connections={connections} size="lg" />}
      title={sourceName(source)}
      description={appName(app)}
      headActions={menu}
      footer={footer}
    >
      <Summary source={source} connection={connection} collectionName={collectionName} syncs={syncs.data} onOpenSync={onOpenSync} documents={collection.data?.collection?.documentCount} />
      <SheetSection title="What it syncs">
        <List>
          <ListItem lead={app === "connectors/google_drive" ? <Folder className="i muted" aria-hidden /> : <BookOpen className="i muted" aria-hidden />} title={scopeText(source)} contentTitle />
        </List>
      </SheetSection>
      {manage ? (
        <SheetSection title="Settings" id="src-sched">
          <div className="stack gap-8">
            <Disclosure icon={policy.icon} title="New and changed files" summary={policy.label} isOpen={policyOpen} onOpenChange={setPolicyOpen}>
              <PolicyForm source={source} manage actions={actions} />
            </Disclosure>
            <Disclosure icon={Clock} title="Sync schedule" summary={scheduleText(source.schedule)} isOpen={scheduleOpen} onOpenChange={setScheduleOpen}>
              <ScheduleForm key={`${source.name}-${source.etag}`} source={source} actions={actions} />
            </Disclosure>
          </div>
        </SheetSection>
      ) : (
        <SheetSection title="New and changed files" id="src-policy">
          <PolicyForm source={source} manage={false} actions={actions} />
        </SheetSection>
      )}
      <RecentSyncs source={source} syncs={syncs.data} isPending={syncs.isPending} onOpenSync={onOpenSync} />
    </Sheet>
  );
}

function Summary({
  source,
  connection,
  collectionName,
  documents,
  syncs,
  onOpenSync,
}: {
  source: Source;
  connection: Connection | undefined;
  collectionName: string | undefined;
  documents: number | undefined;
  syncs: readonly Sync[] | undefined;
  onOpenSync: (sync: Sync) => void;
}) {
  const status = sourceStatus(source);
  const byName = useSyncIndex(syncs);
  const lastError = byName.get(source.lastSync?.sync ?? "")?.error?.message;
  const app = appName(connection?.connector);
  const waiting = source.pendingDocumentCount ?? 0;
  let top = null;
  if (status === "reconnect")
    top = <Callout tone="danger" title={`${app} access expired`} description={`Sign in again as ${accountUser(connection)}. Documents in ${collectionName || "the collection"} stay searchable.`} />;
  else if (status === "failed") top = <Callout tone="danger" title="Last sync failed" description={lastError || "Try syncing again."} />;
  else if (!connection) top = <Callout tone="warning" title="No account" description="The account this source used is no longer connected." />;
  else if (status === "paused") top = <Callout title="Paused" description="Scheduled syncs are off until you resume." />;
  else if (status === "syncing") {
    const n = (source.lastSync?.addedCount ?? 0) + (source.lastSync?.updatedCount ?? 0);
    top = (
      <Card variant="secondary" className="src-live">
        <span className="medium">Syncing · {plural(n, "document")} so far</span>
      </Card>
    );
  }
  // The fix (Publish) is the footer's primary; the alert only explains.
  if (!top && waiting) top = <Callout tone="accent" title={`${plural(waiting, "document")} waiting to publish`} description="They synced into the collection but aren’t searchable yet." />;
  // Files that couldn't be read are their own problem, shown beside any other note.
  let issues = null;
  if (syncedWithIssues(source)) {
    const run = byName.get(source.lastSync?.sync ?? "");
    issues = (
      <Callout
        tone="warning"
        title={`${plural(source.lastSync?.failedCount ?? 0, "file")} couldn’t be read in the last sync`}
        description="Everything else synced."
        actions={
          run ? (
            <Button size="sm" variant="secondary" onPress={() => onOpenSync(run)}>
              See files
            </Button>
          ) : null
        }
      />
    );
  }

  const last = source.lastSync;
  const draft = draftFrom(source.schedule);
  const next = nextSyncAt(draft.draft);
  const nextCell =
    status === "paused" ? (
      "Paused"
    ) : status === "reconnect" ? (
      "After you reconnect"
    ) : draft.draft.freq === "manual" && !draft.custom ? (
      "When someone clicks Sync now"
    ) : next && !draft.custom ? (
      <>
        {relFuture(next)} <span className="muted">· {fmtDateTime(next)}</span>
      </>
    ) : (
      "—"
    );

  return (
    <section className="drawer__section">
      {top || issues ? (
        <div className="stack gap-8 mb-16">
          {top}
          {issues}
        </div>
      ) : null}
      <KeyValue
        pairs={[
          ["Status", <SourceStatusChip key="s" source={source} syncs={byName} />],
          [
            "Last sync",
            last && last.state !== "RUNNING" ? (
              <>
                {rel(last.endTime)} · <span className={last.state === "FAILED" ? "text-danger" : last.failedCount ? "text-warning" : undefined}>{lastSyncText(source).toLowerCase()}</span>
              </>
            ) : last ? (
              "Syncing now"
            ) : (
              "Never"
            ),
          ],
          ["Next sync", nextCell],
          [
            "Collection",
            <div key="c" className="row gap-8 src-min">
              <CollectionLink name={source.targetCollection} label={collectionName} />
              {documents != null ? <span className="t-sm muted none">{plural(documents, "document")}</span> : null}
            </div>,
          ],
          [
            "Account",
            <div key="a" className="row gap-8 wrap">
              {connection ? (
                <>
                  <span className="truncate" translate="no">
                    {accountLabel(connection)}
                  </span>
                  {accountStatus(connection) !== "connected" ? <StatusChip kind="account" value={accountStatus(connection)} /> : null}
                </>
              ) : (
                <span className="muted">None</span>
              )}
            </div>,
          ],
        ]}
      />
      <ReviewLine source={source} />
    </section>
  );
}

/** Synced files from this source that wait for a reviewer (review-first policy). */
function ReviewLine({ source }: { source: Source }) {
  const { can } = useWorkspace();
  const inReview = source.inReviewCount ?? 0;
  if (!inReview) return null;
  return (
    <div className="row gap-8 wrap mt-12">
      <span className="t-sm muted">{`${plural(inReview, "file")} from this source waiting in review`}</span>
      {can("contributions.review") ? (
        <LinkButton href="/studio?tab=review&queue=submissions" icon={ArrowUpRight}>
          Open review
        </LinkButton>
      ) : null}
    </div>
  );
}

function PolicyForm({ source, manage, actions }: { source: Source; manage: boolean; actions: SourceActions }) {
  const current = policyOf(source);
  if (!manage) {
    const meta = POLICY[current];
    const Icon = meta.icon;
    return (
      <>
        <div className="row gap-8">
          <Icon className="i i-sm muted" aria-hidden />
          <span className="medium">{meta.label}</span>
        </div>
        <p className="description mt-4">{meta.desc}</p>
      </>
    );
  }
  return (
    <>
      <ChoiceGroup label="New and changed files" value={current} options={POLICY_CHOICES} onChange={(v) => void actions.setPolicy(source, v)} />
      <p className="description mt-8">Applies from the next sync. Files already published stay published.</p>
    </>
  );
}

function ScheduleForm({ source, actions }: { source: Source; actions: SourceActions }) {
  const saved = draftFrom(source.schedule);
  const [form, setForm] = useState<ScheduleDraft>(saved.draft);
  const [saving, setSaving] = useState(false);
  const next = nextSyncAt(form);
  const dirty = draftDirty(form, saved.draft) || (saved.custom && form.freq !== "manual");
  const hint = form.freq === "manual" ? "Syncs only when someone clicks Sync now." : next ? `Next sync ${relFuture(next)} (${tzShort(form.tz)}).` : "";
  return (
    <div className="stack gap-12">
      {saved.custom ? <p className="description">This source uses a custom schedule. Saving replaces it.</p> : null}
      <ScheduleFields label="How often to sync" draft={form} onChange={setForm} />
      <div className="row between gap-12">
        <span className="description">{hint}</span>
        <Button
          variant="secondary"
          size="sm"
          isDisabled={!dirty}
          isPending={saving}
          onPress={async () => {
            setSaving(true);
            await actions.saveSchedule(source, form);
            setSaving(false);
          }}
        >
          Save schedule
        </Button>
      </div>
    </div>
  );
}

function RecentSyncs({ source, syncs, isPending, onOpenSync }: { source: Source; syncs: readonly Sync[] | undefined; isPending: boolean; onOpenSync: (sync: Sync) => void }) {
  const router = useRouter();
  const list = syncs ?? [];
  return (
    <SheetSection
      title="Recent syncs"
      actions={
        list.length ? (
          <Button variant="ghost" size="sm" onPress={() => router.push(historyHref(source.name))}>
            View all
          </Button>
        ) : null
      }
    >
      {isPending ? (
        <SkeletonRows rows={2} />
      ) : list.length ? (
        <List>
          {list.map((sync) => (
            <ListItem
              key={sync.name}
              title={fmtDateTime(sync.startTime)}
              description={syncDeltaText(sync)}
              actions={<StatusChip kind="run" value={syncStatus(sync)} />}
              onPress={() => onOpenSync(sync)}
            />
          ))}
        </List>
      ) : (
        <p className="muted">No syncs yet.</p>
      )}
    </SheetSection>
  );
}
