"use client";

import { Button, buttonVariants, Tooltip } from "@heroui/react";
import { ArrowLeft, CircleAlert, Clock, Download, File, FileText, LoaderCircle, Lock, PanelRight, Play, RotateCcw, X } from "lucide-react";
import NextLink from "next/link";
import { useRouter } from "next/navigation";
import { Fragment, useEffect, useState, type ReactNode, type RefObject } from "react";

import { PageChrome } from "@/components/shell/page-chrome";
import { EmptyState } from "@/components/ui/EmptyState";
import { FileIcon } from "@/components/ui/FileIcon";
import { IconButton } from "@/components/ui/IconButton";
import { SectionTabs } from "@/components/ui/SectionTabs";
import { rel, fmtDateTime } from "@/lib/format";

import type { Resource } from "../../model";

/** Below this reader width the rail overlays the page (preview `RAIL_MIN`). */
export const RAIL_MIN = 1024;

/** Width of the reader (`.rdr`), which is what the preview's container rules follow. */
export function useWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry?.contentRect.width ?? 0));
    observer.observe(el);
    setWidth(el.clientWidth);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

/** "Back": where the reader came from, else Browse (preview `rdr-back`). */
export function BackButton({ conversation }: { conversation?: string }) {
  const router = useRouter();
  if (conversation) {
    return (
      <NextLink className="link-button rdr-back" href={`/chat/${conversation}`}>
        <ArrowLeft className="i i-sm" aria-hidden />
        Back to conversation
      </NextLink>
    );
  }
  return (
    <button
      type="button"
      className="link-button rdr-back"
      onClick={() => (window.history.length > 1 ? router.back() : router.push("/knowledge"))}
    >
      <ArrowLeft className="i i-sm" aria-hidden />
      Back
    </button>
  );
}

/** "Updated 2 days ago" with the exact time on hover. */
export function Updated({ at, prefix = "Updated" }: { at?: string; prefix?: string }) {
  return <span title={fmtDateTime(at)}>{`${prefix} ${rel(at).replace(/^(Just now|Yesterday)$/, (m) => m.toLowerCase())}`}</span>;
}

/** Meta line items joined by the preview's dot. */
export function Meta({ parts }: { parts: ReadonlyArray<ReactNode> }) {
  const shown = parts.filter(Boolean);
  return (
    <div className="rdr-head__meta">
      {shown.map((p, i) => (
        <Fragment key={i}>
          {i ? (
            <span className="res-dot" aria-hidden>
              ·
            </span>
          ) : null}
          {p}
        </Fragment>
      ))}
    </div>
  );
}

export interface ReaderHeadProps {
  resource: Resource;
  conversation?: string;
  chips: ReactNode;
  meta: ReadonlyArray<ReactNode>;
  actions: ReactNode;
  children?: ReactNode;
}

/** Reader header (preview `.rdr-head`): back, file tile, title with chips, meta line, actions, optional hits bar. */
export function ReaderHead({ resource: r, conversation, chips, meta, actions, children }: ReaderHeadProps) {
  return (
    <header className="rdr-head">
      <BackButton conversation={conversation} />
      <div className="rdr-head__row">
        <FileIcon type={r.ext} mime={r.mime} name={r.fileName} size="lg" />
        <div className="rdr-head__main">
          <div className="rdr-head__title-row">
            <h1 className="rdr-head__title" title={r.title} translate="no">
              {r.title}
            </h1>
            {chips}
          </div>
          <Meta parts={meta} />
        </div>
        <div className="rdr-head__actions">{actions}</div>
      </div>
      {children}
    </header>
  );
}

/** The panel toggle (`aria-pressed`). */
export function PanelToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const label = open ? "Hide panel" : "Show panel";
  return (
    <Tooltip>
      <Button isIconOnly variant="ghost" className="button--muted" aria-label={label} aria-pressed={open} onPress={onToggle}>
        <PanelRight aria-hidden />
      </Button>
      <Tooltip.Content>{label}</Tooltip.Content>
    </Tooltip>
  );
}

export function DownloadButton({ onPress, className = "rdr-wide" }: { onPress: () => void; className?: string }) {
  return <IconButton icon={Download} tip="Download" onPress={onPress} className={className} />;
}

export interface RailProps {
  tabs: { id: string; label: string }[];
  tab: string;
  onTab: (id: string) => void;
  onClose: () => void;
  bodyRef?: RefObject<HTMLDivElement | null>;
  children: ReactNode;
  composer?: ReactNode;
}

/** Right rail (preview `.rdr-rail`) with its scrim for the overlay layout. */
export function Rail({ tabs, tab, onTab, onClose, bodyRef, children, composer }: RailProps) {
  return (
    <>
      <aside className="rdr-rail" aria-label="Document panel">
        <div className="rdr-rail__head">
          <SectionTabs items={tabs} active={tab} onChange={onTab} label="Document panel" className="tabs" />
          <IconButton icon={X} tip="Close panel" size="sm" onPress={onClose} />
        </div>
        <div className="rdr-rail__body" id="rdr-rail-body" ref={bodyRef}>
          {children}
        </div>
        {composer}
      </aside>
      <div className="rdr-scrim" onClick={onClose} aria-hidden />
    </>
  );
}

/* ═══════════════ States ═══════════════ */

export function SkeletonPage() {
  return (
    <div className="doc-page" aria-busy="true" aria-label="Loading">
      <div className="stack gap-12">
        <span className="skeleton skeleton--title" style={{ width: "55%" }} />
        {[92, 86, 95, 70, 0, 40, 90, 84, 60].map((w, i) =>
          w ? <span key={i} className="skeleton skeleton--line" style={{ width: `${w}%` }} /> : <span key={i} style={{ height: 12 }} />,
        )}
      </div>
    </div>
  );
}

export function RailSkeleton() {
  return (
    <div className="stack gap-12">
      {[80, 64, 92, 50].map((w) => (
        <span key={w} className="skeleton skeleton--line" style={{ width: `${w}%` }} />
      ))}
    </div>
  );
}

/** Not found or archived (preview `notAvailable`), or not shared with the caller (`locked`, preview `noAccess`). */
export function Unavailable({
  title = "This document isn’t available",
  description = "It may have been archived or removed.",
  locked = false,
  actions,
}: {
  title?: string;
  description?: string;
  locked?: boolean;
  actions?: ReactNode;
}) {
  return (
    <>
      <PageChrome crumbs={[{ label: "Knowledge", href: "/knowledge" }, { label: "Not available" }]} />
      <div className="rdr-msg">
        <EmptyState
          icon={locked || actions ? Lock : File}
          title={title}
          description={description}
          actions={
            actions ?? (
              <NextLink href="/knowledge" className={buttonVariants({ variant: "primary" })}>
                Go to Browse
              </NextLink>
            )
          }
          boxed
        />
      </div>
    </>
  );
}

export interface NotReadyProps {
  resource: Resource;
  /** Processing error (`indexingError.message`). */
  error?: string;
  /** The caller may process it (`ingestionRuns.create`). */
  canFix: boolean;
  fixing: boolean;
  onFix: () => void;
  onDownload: () => void;
}

/** Canvas state for a document that isn't readable yet (preview `notReady`). */
export function NotReady({ resource: r, error, canFix, fixing, onFix, onDownload }: NotReadyProps) {
  const doc = r.item.document;
  const state = doc?.contentState === "FAILED" ? "FAILED" : doc?.indexingState;
  const fix = (label: string, Icon: typeof Play) =>
    canFix ? (
      <Button variant="primary" onPress={onFix} isPending={fixing}>
        <Icon className="i" aria-hidden />
        {label}
      </Button>
    ) : null;
  const box = (node: ReactNode) => <div className="doc-state">{node}</div>;
  switch (state) {
    case "RUNNING":
      return box(<EmptyState icon={LoaderCircle} title="Getting this document ready" description="It will be readable and searchable in a few minutes." />);
    case "UNSUPPORTED":
      return box(
        <EmptyState
          icon={File}
          title="This file can’t be previewed"
          description="Images and some file types can’t be read or searched. Download it to view."
          actions={
            <Button variant="secondary" onPress={onDownload}>
              <Download className="i" aria-hidden />
              Download
            </Button>
          }
        />,
      );
    case "FAILED":
      return box(
        <EmptyState
          icon={CircleAlert}
          tone="danger"
          title="This document couldn’t be read"
          description={`${error || "The file couldn’t be opened."}${canFix ? "" : ` Ask an owner of ${r.base?.displayName || "its knowledge base"} to fix it.`}`}
          actions={fix("Try again", RotateCcw)}
        />,
      );
    default:
      return box(<EmptyState icon={Clock} title="Waiting to be processed" description="This document isn’t readable yet." actions={fix(r.isPersonal ? "Make searchable" : "Publish now", Play)} />);
  }
}

/** The rendition is missing for a revision that has no stored preview. */
export function NothingToShow({ title = "Nothing to show", description = "This document has no readable content yet.", actions }: { title?: string; description?: string; actions?: ReactNode }) {
  return (
    <div className="doc-state">
      <EmptyState icon={FileText} title={title} description={description} actions={actions} />
    </div>
  );
}
