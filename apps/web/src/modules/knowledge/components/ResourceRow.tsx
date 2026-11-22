"use client";

import { Checkbox } from "@heroui/react";
import clsx from "clsx";
import { Check } from "lucide-react";
import NextLink from "next/link";
import type { KeyboardEvent, ReactNode, SyntheticEvent } from "react";

import { FileIcon } from "@/components/ui/FileIcon";
import { StatusChip } from "@/components/ui/StatusChip";
import { relInline } from "@/lib/format";

import { catalogHref, indexStatusOf, type Resource } from "../model";
import { openDocumentPreview } from "../preview/store";
import { useKnowledgeModel } from "../queries";
import { HighlightText } from "./HighlightText";
import { ResourceMenu, SaveButton } from "./ResourceActions";
import { SourceIcon } from "./SourceIcon";
import { TrustChip } from "./TrustChip";

/** The middle dot between meta parts. */
export function ResDot() {
  return (
    <span className="res-dot" aria-hidden>
      ·
    </span>
  );
}

/** Interactive children never trigger the row/card. */
export const stop = (e: SyntheticEvent) => e.stopPropagation();

/** "Updated just now" / "Updated yesterday" / "Updated 3 days ago" (preview lower-cases the first two). */
export const updatedLabel = (value?: string) => `Updated ${relInline(value)}`;

/** Enter/Space on the row or card itself (not on a control inside it) opens it. */
export function onActivateKey(open: () => void) {
  return (e: KeyboardEvent) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      open();
    }
  };
}

/** Topic shortcuts (preview `topicChips`): links to Browse filtered by the topic. */
export function TopicChips({ topics, max = 2 }: { topics: readonly string[]; max?: number }) {
  const { ctx } = useKnowledgeModel();
  const shown = topics.slice(0, max);
  if (!shown.length) return null;
  return (
    <span className="res-topics" onClick={stop}>
      {shown.map((name) => {
        const label = ctx.topicNames?.get(name) ?? "Untitled topic";
        return (
          <NextLink key={name} className="res-topic" title={label} href={catalogHref({ filters: { topic: [name.slice(name.lastIndexOf("/") + 1)] } })}>
            {label}
          </NextLink>
        );
      })}
    </span>
  );
}

export interface ResourceRowProps {
  resource: Resource;
  /** Search query: highlights the title and summary, and is passed to the preview. */
  q?: string;
  /** Matching text from search (snippet or passage), shown instead of the summary. */
  snippet?: string | null;
  /** What selecting the row does (default: the shared document preview). */
  onOpen?: (resource: Resource) => void;
  /** Where the row lives (`originParam`), so the preview's Open full document leads back here. */
  from?: string;
  active?: boolean;
  /** Always-visible next step before Save and ⋯ (e.g. Revise, Process). */
  trail?: ReactNode;
  /** Secondary actions shown with Save and ⋯ on hover or keyboard focus. */
  reveal?: ReactNode;
  /** Selection checkbox (bulk actions). */
  selected?: boolean;
  onSelectChange?: (selected: boolean) => void;
  /** Already opened: a quiet "Read" check. */
  read?: boolean;
  /** Context every row in the list shares (a collection's own page, My files), so it isn't repeated: `["kb"]`. */
  hide?: readonly "kb"[];
  /** One-line row without summary or topics. */
  compact?: boolean;
}

/**
 * Rich list row (preview `X.res.row`): file tile, title + trust, type · collection · updated, summary or
 * search snippet, topics. Save and ⋯ appear on hover or keyboard focus (always on touch); a saved bookmark
 * stays visible. The whole row opens the preview, Enter/Space too.
 */
export function ResourceRow({
  resource: r,
  q = "",
  snippet,
  onOpen,
  from,
  active,
  trail,
  reveal,
  selected,
  onSelectChange,
  read,
  hide = [],
  compact,
}: ResourceRowProps) {
  const open = () => (onOpen ? onOpen(r) : openDocumentPreview({ item: r.name, listed: r.item, q: q || undefined, from }));
  const status = indexStatusOf(r);
  const about = compact ? "" : snippet || r.summary;
  const base = hide.includes("kb") ? "" : (r.base?.displayName ?? "");
  return (
    <div
      className={clsx("res-row", active && "is-active", compact && "res-row--compact")}
      role="button"
      tabIndex={0}
      aria-current={active || undefined}
      onClick={open}
      onKeyDown={onActivateKey(open)}
    >
      {onSelectChange ? (
        <span className="res-row__check" onClick={stop} onKeyDown={stop}>
          <Checkbox aria-label={`Select ${r.title}`} isSelected={!!selected} onChange={onSelectChange}>
            <Checkbox.Content>
              <Checkbox.Control>
                <Checkbox.Indicator />
              </Checkbox.Control>
            </Checkbox.Content>
          </Checkbox>
        </span>
      ) : null}
      <span className="res-row__lead">
        <FileIcon type={r.ext} mime={r.mime} />
      </span>
      <span className="res-row__body">
        <span className="res-row__title">
          <span className="truncate" translate="no">
            <HighlightText text={r.title} q={q} />
          </span>
          <TrustChip resource={r} quiet />
          {status ? <StatusChip kind="doc" value={status} size="sm" /> : null}
          {read ? (
            <span className="res-row__read">
              <Check className="i i-xs" aria-hidden />
              Read
            </span>
          ) : null}
        </span>
        <span className="res-row__meta">
          {/* The source glyph says where a document comes from; for an upload it adds nothing, so it's left out. */}
          {r.source.isUpload ? null : <SourceIcon source={r.source.key} />}
          {r.typeMeta.label}
          {base ? (
            <>
              <ResDot />
              <span className="truncate" translate={r.base?.personal ? undefined : "no"}>
                {base}
              </span>
            </>
          ) : null}
          <ResDot />
          <span className="truncate">{updatedLabel(r.updated)}</span>
        </span>
        {about ? (
          <span className="res-row__summary" translate="no">
            <HighlightText text={about} q={q} />
          </span>
        ) : null}
        {compact ? null : <TopicChips topics={r.topics} />}
      </span>
      <span className="res-row__trail" onClick={stop} onKeyDown={stop}>
        {trail}
        <span className="reveal-on-hover">
          {reveal}
          <SaveButton resource={r} />
          <ResourceMenu resource={r} q={q} />
        </span>
      </span>
    </div>
  );
}

/** A list of rows (`.res-list` surface). */
export function ResourceList({ children }: { children: ReactNode }) {
  return <div className="res-list">{children}</div>;
}
