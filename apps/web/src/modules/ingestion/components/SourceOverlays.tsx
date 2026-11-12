"use client";

import { resourceId } from "@/lib/api/client";

import { useSourceActions } from "../actions";
import { sourceOfSync, type Sync } from "../api";
import { useConnections } from "../queries";
import { IngestionDialogs } from "./IngestionDialogs";
import { useParamState } from "./shared";
import { SourceDrawer } from "./SourceDrawer";
import { SyncDrawer } from "./SyncDrawer";

/** `?sync=` value for a sync: `<source id>.<sync id>`. */
export const syncParam = (sync: Sync) => `${resourceId(sourceOfSync(sync))}.${resourceId(sync.name)}`;

/**
 * The source drawer (`?open=<source id>&focus=schedule`), the sync run drawer (`?sync=<source id>.<sync id>`)
 * and the ingestion dialogs, wherever sources are listed (Studio → Sources, a collection's Sources tab).
 */
export function SourceOverlays() {
  const { params, set } = useParamState();
  const connections = useConnections();
  const actions = useSourceActions(connections.byName);
  const openSync = (sync: Sync) => set({ open: null, focus: null, sync: syncParam(sync) });
  return (
    <>
      <SourceDrawer sourceId={params.get("open")} focus={params.get("focus")} connections={connections.byName} actions={actions} onOpenSync={openSync} />
      <SyncDrawer param={params.get("sync")} connections={connections.byName} actions={actions} />
      <IngestionDialogs />
    </>
  );
}
