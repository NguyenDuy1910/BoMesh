"use client";

import { Checkbox } from "@heroui/react";
import clsx from "clsx";
import { StickyNote } from "lucide-react";
import NextLink from "next/link";
import { useRouter } from "next/navigation";
import type { KeyboardEvent, ReactNode, SyntheticEvent } from "react";

import { FileIcon } from "@/components/ui/FileIcon";
import { StatusChip } from "@/components/ui/StatusChip";
import { rel } from "@/lib/format";

import { catalogHref, indexStatusOf, type Resource } from "../model";
import { useKnowledgeModel } from "../queries";
import { HighlightText } from "./HighlightText";
import { ResourceActions } from "./ResourceActions";
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
export const updatedLabel = (value?: string) => `Updated ${rel(value).replace(/^(Just now|Yesterday)$/, (m) => m.toLowerCase())}`;

/** Topic shortcuts (preview `topicChips`): links to Browse filtered by the topic. */
export function TopicChips({ topics, max = 2 }: { topics: readonly string[]; max?: number }) {
  const { ctx } = useKnowledgeModel();
  const shown = topics.slice(0, max);
  if (!shown.length) return null;
  return (
    <span className="res-topics" onClick={stop}>
      {shown.map((name) => (
        <NextLink key={name} className="res-topic" href={catalogHref({ filters: { topic: [name.slice(name.lastIndexOf("/") + 1)] } })}>
          {ctx.topicNames?.get(name) ?? "Untitled topic"}
        </NextLink>
      ))}
    </span>
  );
}

export interface ResourceRowProps {
  resource: Resource;
  /** Search query: highlights the title and passes `?q=` to the Reader. */
  q?: string;
  /** Matching text from search (snippet or passage), shown instead of the summary. */
  snippet?: string | null;
  /** What selecting the row does (default: open the Reader). */
  onOpen?: (resource: Resource) => void;
  active?: boolean;
  /** A collection note under the text. */
  note?: string;
  /** Extra trailing controls before Save. */
  trail?: ReactNode;
  /** Selection checkbox (bulk actions). */
  selected?: boolean;
  onSelectChange?: (selected: boolean) => void;
  /** One-line row without summary or topics. */
  compact?: boolean;
}

/** Rich list row (preview `X.res.row`): file tile, title + trust, type · base · updated, summary/snippet, topics, Save and ⋯. */
export function ResourceRow({ resource: r, q = "", snippet, onOpen, active, note, trail, selected, onSelectChange, compact }: ResourceRowProps) {
  const router = useRouter();
  const open = () => (onOpen ? onOpen(r) : router.push(`/doc/${r.id}${q ? `?q=${encodeURIComponent(q)}` : ""}`));
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      open();
    }
  };
  const status = indexStatusOf(r);
  const about = compact ? "" : snippet || r.summary;
  return (
    <div
      className={clsx("res-row", active && "is-active", compact && "res-row--compact")}
      role="button"
      tabIndex={0}
      aria-current={active || undefined}
      onClick={open}
      onKeyDown={onKeyDown}
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
        </span>
        <span className="res-row__meta">
          <SourceIcon source={r.source.isUpload ? undefined : r.source.key} />
          {r.kindMeta.label}
          {r.base?.displayName ? (
            <>
              <ResDot />
              <span className="truncate" translate="no">
                {r.base.displayName}
              </span>
            </>
          ) : null}
          <ResDot />
          {updatedLabel(r.updated)}
        </span>
        {about ? (
          <span className="res-row__summary" translate="no">
            <HighlightText text={about} q={q} />
          </span>
        ) : null}
        {note ? (
          <span className="res-row__note">
            <StickyNote className="i i-xs" aria-hidden />
            <span translate="no">{note}</span>
          </span>
        ) : null}
        {compact ? null : <TopicChips topics={r.topics} />}
      </span>
      <span className="res-row__trail" onClick={stop} onKeyDown={stop}>
        {trail}
        <ResourceActions resource={r} q={q} />
      </span>
    </div>
  );
}

/** A list of rows (`.res-list` surface). */
export function ResourceList({ children }: { children: ReactNode }) {
  return <div className="res-list">{children}</div>;
}
