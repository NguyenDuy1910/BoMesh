"use client";

import { buttonVariants } from "@heroui/react";
import { ImageIcon, Pencil } from "lucide-react";
import NextLink from "next/link";
import { Fragment, useCallback, useState } from "react";

import { IconButton, Page, PageHeader, WorkspaceMark } from "@/components/ui";
import { plural } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";
import { studioHref } from "@/modules/curation";

import { ResDot } from "../components/ResourceRow";
import { KnowledgeAtlas, type AtlasStats } from "./KnowledgeAtlas";
import { MapBackgroundDialog } from "./MapBackground";
import { useFreshCount } from "./queries";

/**
 * /knowledge/map — Knowledge › Map (preview `features/atlas.js` `P.atlas`, docs/KNOWLEDGE_MAP.md): the workspace's mark and
 * what the map holds, then one canvas with every collection, folder and document the caller can read, drawn the way the
 * organisation keeps them. Opened from Browse's header.
 */
export function MapPage() {
  const ws = useWorkspace();
  const [stats, setStats] = useState<AtlasStats | null>(null);
  const onStats = useCallback((s: AtlasStats) => setStats(s), []);
  const [bgOpen, setBgOpen] = useState(false);
  const fresh = useFreshCount({ enabled: !!stats?.documents });
  const meta = stats?.documents
    ? [
        `${plural(stats.documents, "document")} you can read`,
        plural(stats.collections, "collection"),
        plural(stats.levels, "level"),
        ...(fresh ? [`${fresh} updated in the last 30 days`] : []),
      ]
    : [];
  return (
    <Page width="canvas" className="atlas-page">
      <PageHeader
        title="Knowledge map"
        heading="Knowledge map"
        lead={<WorkspaceMark name={ws.workspace.displayName ?? ""} size={40} />}
        meta={meta.map((m, i) => (
          <Fragment key={m}>
            {i ? <ResDot /> : null}
            <span>{m}</span>
          </Fragment>
        ))}
        actions={
          <>
            {ws.can("workspaces.updateSettings") ? <IconButton icon={ImageIcon} tip="Map background" size="sm" onPress={() => setBgOpen(true)} /> : null}
            {ws.can("items.create") ? (
              <NextLink href={studioHref("collections")} className={buttonVariants({ variant: "tertiary", size: "sm" })}>
                <Pencil className="i" aria-hidden />
                Edit structure
              </NextLink>
            ) : null}
          </>
        }
      />
      <KnowledgeAtlas onStats={onStats} />
      <MapBackgroundDialog isOpen={bgOpen} onClose={() => setBgOpen(false)} />
    </Page>
  );
}
