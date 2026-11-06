"use client";

import { Button } from "@heroui/react";
import { ChevronRight, Plug } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo } from "react";

import { AppIcon } from "@/components/ui/AppIcon";
import { EmptyState } from "@/components/ui/EmptyState";
import { Gate } from "@/components/ui/Gate";
import { List, ListItem } from "@/components/ui/List";
import { SkeletonRows } from "@/components/ui/SkeletonRows";
import { StatusChip } from "@/components/ui/StatusChip";
import { resourceId, type Schema } from "@/lib/api/client";
import { plural, rel } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";
import { appKey, scopeText, sourceName, sourceStatus } from "@/modules/ingestion/model";
import { useConnections, useSources } from "@/modules/ingestion/queries";
import { scheduleText } from "@/modules/ingestion/schedule";

import type { Item } from "../model";

type Source = Schema<"Source">;

/** `/sources` wizard (SourcesAdmin) with this base preselected. */
export const connectHref = (base: Item) => `/sources?connect=1&kb=${resourceId(base.name)}`;

/** Preview `srcLine(s)`: last sync · schedule. */
function srcLine(s: Source) {
  if (s.lastSync?.state === "RUNNING") return "Syncing now";
  const last = s.lastSync?.endTime ? `Last synced ${rel(s.lastSync.endTime).toLowerCase()}` : "Not synced yet";
  const next = s.state === "PAUSED" || !s.schedule?.cron ? "Syncs manually" : scheduleText(s.schedule);
  return [last, next].filter(Boolean).join(" · ");
}

/** Sources tab (preview `sourcesTab(kb)`): what feeds the base; managing a source happens on /sources. */
export function SourcesTab({ base }: { base: Item }) {
  const router = useRouter();
  const { can } = useWorkspace();
  const sources = useSources();
  const connections = useConnections();
  const manage = can("sources.create");
  const list = useMemo(() => (sources.data ?? []).filter((s) => s.targetCollection === base.name), [sources.data, base.name]);
  const appOf = (s: Source) => appKey((connections.data ?? []).find((c) => c.name === s.connection)?.connector);
  const connect = (
    <Button variant="primary" onPress={() => router.push(connectHref(base))}>
      <Plug className="i" aria-hidden />
      Connect source
    </Button>
  );
  const empty = (
    <EmptyState
      icon={Plug}
      boxed
      title="No sources connected"
      description={manage ? "Connect Google Drive or Confluence to keep this knowledge base up to date." : "Documents here are added by hand. Ask an admin to connect a source."}
      actions={manage ? connect : null}
    />
  );

  if (!can("sources.list")) return empty;

  return (
    <Gate query={sources} skeleton={<SkeletonRows rows={3} />} isEmpty={() => !list.length} empty={empty}>
      <div className="toolbar">
        <span className="t-sm muted">
          {plural(list.length, "source")} {list.length === 1 ? "feeds" : "feed"} this knowledge base
        </span>
        {manage ? (
          <div className="toolbar__end">
            <Button size="sm" variant="secondary" onPress={() => router.push(connectHref(base))}>
              <Plug className="i" aria-hidden />
              Connect source
            </Button>
          </div>
        ) : null}
      </div>
      <List>
        {list.map((s) => (
          <ListItem
            key={s.name}
            lead={<AppIcon app={appOf(s)} size="lg" />}
            title={<span translate="no">{sourceName(s)}</span>}
            titleExtra={<StatusChip kind="source" value={sourceStatus(s)} size="sm" />}
            description={srcLine(s)}
            meta={<span translate="no">{scopeText(s)}</span>}
            actions={<ChevronRight className="i muted" aria-hidden />}
            href={`/sources?open=${resourceId(s.name)}`}
            label={sourceName(s)}
          />
        ))}
      </List>
    </Gate>
  );
}
