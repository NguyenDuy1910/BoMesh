"use client";

import { buttonVariants } from "@heroui/react";
import { Pencil } from "lucide-react";
import NextLink from "next/link";
import { Fragment, useCallback, useState } from "react";

import { Page, PageHeader, WorkspaceMark } from "@/components/ui";
import { plural } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";
import { studioHref } from "@/modules/curation";
import { ResDot } from "@/modules/knowledge/components/ResourceRow";

import { KnowledgeAtlas, type AtlasStats } from "../atlas/KnowledgeAtlas";
import { useFreshCount } from "../atlas/queries";

/**
 * /home — the Knowledge Atlas (preview `features/home.js`, docs/HOME.md): the workspace's identity block, then one canvas
 * with every collection, folder and document the caller can read, drawn the way the organisation keeps them.
 */
export function HomePage() {
  const ws = useWorkspace();
  const [stats, setStats] = useState<AtlasStats | null>(null);
  const onStats = useCallback((s: AtlasStats) => setStats(s), []);
  const fresh = useFreshCount({ enabled: !!stats?.documents });
  const name = ws.workspace.displayName ?? "";
  const meta = stats?.documents
    ? [
        `${plural(stats.documents, "document")} you can read`,
        plural(stats.collections, "collection"),
        plural(stats.levels, "level"),
        ...(fresh ? [`${fresh} updated in the last 30 days`] : []),
      ]
    : [];
  return (
    <Page width="canvas" className="home">
      <PageHeader
        title={name}
        heading={<span translate="no">{name}</span>}
        lead={<WorkspaceMark name={name} size={40} />}
        meta={meta.map((m, i) => (
          <Fragment key={m}>
            {i ? <ResDot /> : null}
            <span>{m}</span>
          </Fragment>
        ))}
        actions={
          ws.can("items.create") ? (
            <NextLink href={studioHref("collections")} className={buttonVariants({ variant: "tertiary", size: "sm" })}>
              <Pencil className="i" aria-hidden />
              Edit structure
            </NextLink>
          ) : null
        }
      />
      <KnowledgeAtlas onStats={onStats} />
    </Page>
  );
}
