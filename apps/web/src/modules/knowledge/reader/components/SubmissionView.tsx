"use client";

import { Button, buttonVariants } from "@heroui/react";
import clsx from "clsx";
import { CheckCheck, Download, EyeOff, History, Pencil } from "lucide-react";
import NextLink from "next/link";
import { useRef, useState } from "react";

import { PageChrome } from "@/components/shell/page-chrome";
import { Callout } from "@/components/ui/Callout";
import { ErrorState } from "@/components/ui/ErrorState";
import { FileIcon } from "@/components/ui/FileIcon";
import { KeyValue } from "@/components/ui/KeyValue";
import { StatusChip } from "@/components/ui/StatusChip";
import { ApiError, resourceId } from "@/lib/api/client";
import { fmtDateTime, fmtSize, plural } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";

import type { Contribution } from "../../api";
import { LifecycleChip } from "../../components/LifecycleChip";
import { ContributionTimeline } from "../../library/components/ContributionTimeline";
import { contributionHref, lastEvent, type ContributionEventView } from "../../library/contributions";
import { lifecycleKey, type Resource } from "../../model";
import { useDocumentOperations } from "../../operations";
import { useItem, useMemberNames } from "../../queries";
import { NO_MARKS } from "../marks";
import { isSpreadsheetType } from "../rendition";
import { useReaderContent } from "../queries";
import { RailSection } from "./AboutPane";
import { BackButton, DownloadButton, Meta, NothingToShow, PanelToggle, RAIL_MIN, Rail, SkeletonPage, Updated, useWidth } from "./ReaderParts";
import { RenditionView } from "./RenditionView";
import { useRendition } from "./useRendition";

const NO_PREVIEW: Readonly<Record<string, true>> = { zip: true, png: true, jpg: true, jpeg: true };

/**
 * A document that isn't knowledge yet (preview `submissionView`): in review, changes requested,
 * not approved or unpublished. Seen only by its contributor and the base's reviewers: a preview
 * with its lifecycle and who can see it — no Ask, no saving or collecting.
 */
export function SubmissionView({ resource: r, contribution: c }: { resource: Resource; contribution: Contribution | null }) {
  const { member, can, workspace } = useWorkspace();
  const ops = useDocumentOperations();
  const me = member.name ?? "";
  const contributor = c?.contributor || r.owner || "";
  const mine = !!contributor && contributor === me;
  const reviewer = can("contributions.review") && !r.isPersonal;
  const names = useMemberNames([contributor, c?.decision?.reviewer, ...(c?.events ?? []).map((e) => e.actor)]);
  const target = useItem(c?.targetCollection || c?.suggestions?.collection || null);
  const original = useItem(c?.replacesItem || null);
  const base = target.data?.displayName || (r.isPersonal ? "" : r.base?.displayName) || "its knowledge base";
  const life = lifecycleKey({ item: r.item, contribution: c });
  const stage = life === "analyzing" || life === "review" ? "review" : life;
  const track = contributionHref(c ? resourceId(c.name) : null);
  const contributorName = mine ? "you" : names.get(contributor) || "the contributor";

  /* Preview of the file as submitted */
  const preview = !NO_PREVIEW[r.ext];
  const content = useReaderContent(r.id, undefined, { enabled: preview });
  const rendition = useRendition(r.id, content.data);
  const rd = rendition.doc;
  const sheet = isSpreadsheetType(r.mime);
  const pageCount = Math.max(content.data?.pageAssets?.length ?? 0, ...(rd?.blocks.map((b) => b.page ?? 0) ?? [0]));
  const cantPreview = (
    <NothingToShow
      title="This file can’t be previewed"
      description="Download it to view."
      actions={
        <Button variant="secondary" onPress={() => void ops.download(r)}>
          <Download className="i" aria-hidden />
          Download
        </Button>
      }
    />
  );
  let canvas: React.ReactNode;
  if (!preview || (content.error instanceof ApiError && content.error.code === "FAILED_PRECONDITION")) canvas = cantPreview;
  else if (content.isPending || rendition.loading) canvas = <SkeletonPage />;
  else if (content.isError || rendition.failed)
    canvas = (
      <ErrorState
        title="This document didn’t load"
        error={content.error ?? undefined}
        onRetry={() => {
          rendition.reset();
          void content.refetch();
        }}
      />
    );
  else if (!rd?.blocks.length) canvas = <NothingToShow />;
  else canvas = <RenditionView rendition={rd} marks={NO_MARKS} sheet={sheet} pageCount={pageCount} />;

  /* Layout */
  const rootRef = useRef<HTMLDivElement>(null);
  const width = useWidth(rootRef);
  const [railPref, setRailPref] = useState<boolean | null>(null);
  const open = railPref ?? (width === 0 || width >= RAIL_MIN);

  /* Header */
  const meta = [
    r.kindMeta.label,
    base !== "its knowledge base" && <span translate="no">{base}</span>,
    mine ? "Contributed by you" : <span>Contributed by {names.get(contributor) || "someone"}</span>,
    c?.createTime && <Updated key="s" at={c.createTime} prefix="Submitted" />,
    preview && !sheet && pageCount > 0 && plural(pageCount, "page"),
  ];
  const main =
    reviewer && stage === "review" && c ? (
      <NextLink href={`/documents?tab=review&sel=${resourceId(c.name)}`} className={buttonVariants({ variant: "primary" })}>
        <CheckCheck className="i" aria-hidden />
        Review
      </NextLink>
    ) : mine && stage === "changes" ? (
      <NextLink href={track} className={buttonVariants({ variant: "primary" })}>
        <Pencil className="i" aria-hidden />
        Revise
      </NextLink>
    ) : null;

  /* Banner: why only some people can see it, and what happens next */
  const byName = (e?: ContributionEventView) => (e?.by === me && me ? "You" : (e?.by && names.get(e.by)) || "A reviewer");
  const quote = (e?: ContributionEventView) =>
    e?.text ? (
      <blockquote className="rdr-sub-quote" translate="no">
        {e.text}
      </blockquote>
    ) : null;
  const audience = (
    <>
      Only {mine ? "you" : <span translate="no">{contributorName}</span>} and the reviewers of <span translate="no">{base}</span> can see it.
    </>
  );
  let banner: React.ReactNode;
  if (stage === "review") {
    banner = <Callout tone="accent" icon={EyeOff} title={life === "analyzing" ? "In review · the assistant is reading it" : "In review"} description={<>{audience} It isn’t searchable yet.</>} />;
  } else if (stage === "changes") {
    const e = c ? lastEvent(c, "changes") : undefined;
    banner = (
      <Callout
        tone="warning"
        title={`${byName(e)} asked for changes`}
        description={
          <>
            {quote(e)}
            {audience} It isn’t searchable yet.
          </>
        }
      />
    );
  } else if (stage === "rejected") {
    const e = c ? lastEvent(c, "rejected") : undefined;
    banner = (
      <Callout
        tone="danger"
        title="Not approved"
        description={
          <>
            {quote(e)}
            It won’t be published. {audience}
          </>
        }
      />
    );
  } else if (stage === "unpublished") {
    banner = <Callout tone="default" icon={EyeOff} title="Unpublished" description={<>A reviewer removed it from search and answers. {audience}</>} />;
  } else {
    banner = <Callout tone="default" title={<LifecycleChip lifecycle={life} noTip />} description={audience} />;
  }

  const crumbs =
    mine || !reviewer
      ? [{ label: "Knowledge", href: "/knowledge" }, { label: "My library", href: "/knowledge/library?tab=contributions" }, { label: r.title }]
      : [{ label: "Documents", href: "/documents?tab=review" }, { label: r.title }];

  return (
    <div className="rdr rdr--sub" ref={rootRef}>
      <PageChrome crumbs={crumbs} />
      <header className="rdr-head">
        <BackButton />
        <div className="rdr-head__row">
          <FileIcon type={r.ext} mime={r.mime} name={r.fileName} size="lg" />
          <div className="rdr-head__main">
            <div className="rdr-head__title-row">
              <h1 className="rdr-head__title" title={r.title} translate="no">
                {r.title}
              </h1>
              <LifecycleChip lifecycle={life} />
              {workspace.demo ? <StatusChip label="Demo data" tone="default" dot={false} size="sm" tooltip="This workspace holds fictional demo content." /> : null}
            </div>
            <Meta parts={meta} />
          </div>
          <div className="rdr-head__actions">
            {main}
            {mine ? (
              <NextLink href={track} className={clsx(buttonVariants({ variant: main ? "secondary" : "primary" }), main && "rdr-wide")}>
                <History className="i" aria-hidden />
                Track
              </NextLink>
            ) : null}
            <DownloadButton onPress={() => void ops.download(r)} />
            <PanelToggle open={open} onToggle={() => setRailPref(!open)} />
          </div>
        </div>
      </header>
      <div className={clsx("rdr-body", open && "has-rail")}>
        <div className="rdr-canvas" id="rdr-scroll">
          <div className="rdr-banners">{banner}</div>
          {canvas}
        </div>
        {open ? (
          <Rail tabs={[{ id: "about", label: "About" }]} tab="about" onTab={() => undefined} onClose={() => setRailPref(false)}>
            <RailSection title="Contribution">
              <KeyValue
                pairs={[
                  ["Status", <LifecycleChip key="s" lifecycle={life} size="sm" />],
                  ["Knowledge base", <span translate="no">{base}</span>],
                  ["Contributed by", mine ? "You" : <span translate="no">{names.get(contributor) || "Someone"}</span>],
                  c?.createTime ? ["Submitted", fmtDateTime(c.createTime)] : null,
                  c?.replacesItem
                    ? [
                        "New version of",
                        original.data ? (
                          <NextLink className="link" href={`/doc/${resourceId(original.data.name)}`} translate="no">
                            {original.data.displayName}
                          </NextLink>
                        ) : (
                          "An earlier document"
                        ),
                      ]
                    : null,
                  ["File", `${(r.ext || "file").toUpperCase()} · ${fmtSize(r.sizeBytes)}`],
                ]}
              />
            </RailSection>
            {c ? (
              <RailSection title="History">
                <ContributionTimeline contribution={c} compact />
              </RailSection>
            ) : null}
          </Rail>
        ) : null}
      </div>
    </div>
  );
}
