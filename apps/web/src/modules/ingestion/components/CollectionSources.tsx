"use client";

import { ChevronRight, Plug } from "lucide-react";
import { useMemo } from "react";

import { EmptyState, Gate, List, ListItem, SkeletonRows } from "@/components/ui";
import { resourceId } from "@/lib/api/client";
import { relInline } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";

import type { Source } from "../api";
import { scopeText, sourceName } from "../model";
import { useConnections, useRunningSyncs, useSources } from "../queries";
import { scheduleText } from "../schedule";
import { AddSourceButton } from "./AddSourceButton";
import { SourceAppIcon, SourceStatusChip, useParamState, useSyncIndex } from "./shared";
import { SourceOverlays } from "./SourceOverlays";

/** Preview `srcLine(s)`: last sync · schedule. */
function sourceLine(s: Source) {
  if (s.lastSync?.state === "RUNNING") return "Đang đồng bộ";
  const last = s.lastSync?.endTime ? `Đồng bộ lần cuối ${relInline(s.lastSync.endTime)}` : "Chưa đồng bộ";
  const next = s.state === "PAUSED" || !s.schedule?.cron ? "Đồng bộ thủ công" : scheduleText(s.schedule);
  return `${last} · ${next}`;
}

/**
 * A collection's Sources tab (preview `sourcesTab(kb)`): the sources that feed it, each opening the source
 * drawer in place. Add source reuses a connected account with this collection preselected (a source's
 * collection is fixed when it is created, so a collection never picks an existing source).
 */
export function CollectionSources({ collection }: { collection: string }) {
  const { can } = useWorkspace();
  const { set } = useParamState();
  const sources = useSources();
  const connections = useConnections();
  const syncs = useSyncIndex(useRunningSyncs().data);
  const manage = can("sources.create");
  const list = useMemo(() => (sources.data ?? []).filter((s) => s.targetCollection === collection), [sources.data, collection]);

  const empty = (
    <EmptyState
      icon={Plug}
      boxed
      title="Chưa có nguồn dữ liệu"
      description={manage ? "Giữ kho tài liệu này đồng bộ với Google Drive hoặc Confluence." : "Tài liệu ở đây được thêm thủ công. Hãy nhờ quản trị viên thêm nguồn dữ liệu."}
      actions={manage ? <AddSourceButton collection={collection} /> : null}
    />
  );

  if (!can("sources.list")) return empty;

  return (
    <>
      <Gate query={sources} skeleton={<SkeletonRows rows={3} />} isEmpty={() => !list.length} empty={empty}>
        {manage ? (
          <div className="toolbar">
            <div className="toolbar__end">
              <AddSourceButton collection={collection} variant="secondary" size="sm" />
            </div>
          </div>
        ) : null}
        <List>
          {list.map((s) => (
            <ListItem
              key={s.name}
              lead={<SourceAppIcon source={s} connections={connections.byName} size="lg" />}
              title={<span translate="no">{sourceName(s)}</span>}
              titleExtra={<SourceStatusChip source={s} syncs={syncs} size="sm" />}
              description={sourceLine(s)}
              meta={<span translate="no">{scopeText(s)}</span>}
              actions={manage ? <ChevronRight className="i muted" aria-hidden /> : undefined}
              onPress={manage ? () => set({ open: resourceId(s.name), focus: null, sync: null }) : undefined}
              label={sourceName(s)}
            />
          ))}
        </List>
      </Gate>
      <SourceOverlays />
    </>
  );
}
