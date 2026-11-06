"use client";

import { Button, Card, Dropdown } from "@heroui/react";
import { ArrowUpRight, BookOpen, ChevronRight, Folder, History, MoreHorizontal, Pause, Play, Plug, RefreshCw, Trash2 } from "lucide-react";
import NextLink from "next/link";
import { useEffect, useState } from "react";

import { Callout, ChoiceGroup, EmptyState, IconButton, KeyValue, List, ListItem, SkeletonRows, StatusChip } from "@/components/ui";
import { resourceId } from "@/lib/api/client";
import { fmtDateTime, plural, rel, relFuture } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";
import { baseColor } from "@/modules/knowledge/bases/model";
import { useItem } from "@/modules/knowledge/queries";

import type { SourceActions } from "../actions";
import type { Connection, Source, Sync } from "../api";
import { accountLabel, accountStatus, accountUser, appName, canTogglePause, lastSyncText, POLICY, POLICY_CHOICES, policyOf, scopeText, sourceName, sourceStatus, syncDeltaText, syncStatus } from "../model";
import { openReconnect } from "../overlays";
import { useSource, useSyncs } from "../queries";
import { draftDirty, draftFrom, nextSyncAt, tzShort, type ScheduleDraft } from "../schedule";
import { ScheduleFields } from "./ScheduleFields";
import { Sheet, SheetSection } from "./Sheet";
import { SourceAppIcon, SourceStatusChip, useParamState } from "./shared";

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
        {query.isError ? <EmptyState icon={Plug} title="This source was disconnected" description="Documents it synced stay in their knowledge base." /> : <SkeletonRows rows={5} />}
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
  const { set } = useParamState();
  const manage = can("sources.create");
  const connection = connections.get(source.connection);
  const kb = useItem(source.targetCollection);
  const kbName = kb.data?.displayName;
  const status = sourceStatus(source);
  const syncing = status === "syncing";
  const paused = status === "paused";

  useEffect(() => {
    if (focus !== "schedule") return;
    const frame = requestAnimationFrame(() => {
      const section = document.getElementById("src-sched");
      section?.scrollIntoView({ block: "start" });
      section?.querySelector<HTMLElement>("[aria-checked='true'],[aria-pressed='true'],[data-selected='true']")?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [focus]);

  const menu = manage ? (
    <Dropdown>
      <IconButton icon={MoreHorizontal} tip="More actions" showTip={false} />
      <Dropdown.Popover placement="bottom end">
        <Dropdown.Menu
          aria-label="Source actions"
          onAction={(key) => {
            if (key === "history") set({ tab: "history", source: resourceId(source.name), status: null, page: null, open: null, focus: null });
            if (key === "disconnect") void actions.disconnect(source, kbName).then((done) => done && onClose());
          }}
        >
          <Dropdown.Item id="history" textValue="View sync history">
            <History className="i" aria-hidden />
            View sync history
          </Dropdown.Item>
          <Dropdown.Item id="disconnect" textValue="Disconnect" variant="danger">
            <Trash2 className="i" aria-hidden />
            Disconnect
          </Dropdown.Item>
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  ) : null;

  let footer = null;
  if (manage) {
    if (status === "reconnect")
      footer = (
        <Button variant="primary" onPress={() => openReconnect(source.connection)}>
          Reconnect
        </Button>
      );
    else
      footer = (
        <>
          <Button variant="secondary" isDisabled={syncing || !canTogglePause(source)} onPress={() => void actions.togglePause(source)}>
            {paused ? <Play className="i" aria-hidden /> : <Pause className="i" aria-hidden />}
            {paused ? "Resume" : "Pause"}
          </Button>
          <Button variant="primary" isDisabled={!connection || paused} isPending={syncing} onPress={() => void actions.syncNow(source)}>
            <RefreshCw className="i" aria-hidden />
            {syncing ? "Syncing…" : "Sync now"}
          </Button>
        </>
      );
  }

  const app = connection?.connector;
  return (
    <Sheet
      isOpen
      onClose={onClose}
      lead={<SourceAppIcon source={source} connections={connections} size="lg" />}
      title={sourceName(source)}
      description={`${appName(app)}${connection ? ` · ${accountLabel(connection)}` : ""}`}
      headActions={menu}
      footer={footer}
    >
      <Summary source={source} connection={connection} kbName={kbName} actions={actions} manage={manage} />
      <SheetSection title="What it syncs">
        <List>
          <ListItem lead={app === "connectors/google_drive" ? <Folder className="i muted" aria-hidden /> : <BookOpen className="i muted" aria-hidden />} title={scopeText(source)} contentTitle />
        </List>
      </SheetSection>
      <SheetSection title="Destination">
        <List>
          <ListItem
            lead={<span className="src-kb__dot src-kb__dot--lg" style={{ background: baseColor(source.targetCollection) }} aria-hidden />}
            title={kbName ?? (kb.isError ? "Removed knowledge base" : "Knowledge base")}
            contentTitle
            description={kb.data?.collection?.childCount != null ? plural(kb.data.collection.childCount, "item") : undefined}
            actions={kb.data ? <ChevronRight className="i muted" aria-hidden /> : undefined}
            href={kb.data ? `/knowledge/${resourceId(source.targetCollection)}?tab=documents` : undefined}
          />
        </List>
      </SheetSection>
      <SheetSection title="New and changed files" id="src-policy">
        <PolicyForm source={source} manage={manage} actions={actions} />
      </SheetSection>
      {manage ? (
        <SheetSection title="Schedule" id="src-sched">
          <ScheduleForm key={`${source.name}-${source.etag}`} source={source} actions={actions} />
        </SheetSection>
      ) : null}
      <RecentSyncs source={source} onOpenSync={onOpenSync} />
      {manage ? (
        <SheetSection title="Disconnect">
          <div className="src-danger">
            <p className="description grow">Stops syncing. Documents already in {kbName || "the knowledge base"} stay.</p>
            <Button variant="danger-soft" size="sm" onPress={() => void actions.disconnect(source, kbName).then((done) => done && onClose())}>
              Disconnect
            </Button>
          </div>
        </SheetSection>
      ) : null}
    </Sheet>
  );
}

function Summary({ source, connection, kbName, actions, manage }: { source: Source; connection: Connection | undefined; kbName: string | undefined; actions: SourceActions; manage: boolean }) {
  const status = sourceStatus(source);
  const lastError = useSyncs(source.name, 5).data?.find((x) => x.name === source.lastSync?.sync)?.error?.message;
  const app = appName(connection?.connector);
  let top = null;
  if (status === "reconnect")
    top = <Callout tone="danger" title={`${app} access expired`} description={`Sign in again as ${accountUser(connection)}. Documents in ${kbName || "the knowledge base"} stay searchable.`} />;
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
  const waiting = source.pendingDocumentCount ?? 0;
  if (!top && waiting)
    top = (
      <Callout
        tone="accent"
        title={`${plural(waiting, "document")} waiting to publish`}
        description="Synced into the knowledge base. Publish them to make them searchable."
        actions={
          manage ? (
            <Button size="sm" variant="primary" onPress={() => void actions.publish([source])}>
              <Play className="i" aria-hidden />
              Publish
            </Button>
          ) : null
        }
      />
    );

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
      {top ? <div className="mb-16">{top}</div> : null}
      <KeyValue
        pairs={[
          ["Status", <SourceStatusChip key="s" source={source} />],
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
    </section>
  );
}

function PolicyForm({ source, manage, actions }: { source: Source; manage: boolean; actions: SourceActions }) {
  const { can } = useWorkspace();
  const current = policyOf(source);
  const inReview = source.inReviewCount ?? 0;
  const queue = inReview ? (
    <div className="row gap-8 wrap mt-8">
      <span className="t-sm muted">{`${plural(inReview, "file")} from this source waiting in review`}</span>
      {can("contributions.review") ? (
        <NextLink href="/documents?tab=review" className="link-button">
          Open review
          <ArrowUpRight className="i i-sm" aria-hidden />
        </NextLink>
      ) : null}
    </div>
  ) : null;
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
        {queue}
      </>
    );
  }
  return (
    <>
      <ChoiceGroup label="New and changed files" value={current} options={POLICY_CHOICES} onChange={(v) => void actions.setPolicy(source, v)} />
      <p className="description mt-8">Applies from the next sync. Files already published stay published.</p>
      {queue}
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

function RecentSyncs({ source, onOpenSync }: { source: Source; onOpenSync: (sync: Sync) => void }) {
  const { set } = useParamState();
  const syncs = useSyncs(source.name, 5);
  const list = syncs.data ?? [];
  return (
    <SheetSection
      title="Recent syncs"
      actions={
        list.length ? (
          <Button variant="ghost" size="sm" onPress={() => set({ tab: "history", source: resourceId(source.name), status: null, page: null, open: null, focus: null })}>
            View all
          </Button>
        ) : null
      }
    >
      {syncs.isPending ? (
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

