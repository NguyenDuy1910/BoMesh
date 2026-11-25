"use client";

import { Button, buttonVariants } from "@heroui/react";
import clsx from "clsx";
import { CircleAlert, Clock, Download, File, FileText, Info, LoaderCircle, Lock, Play, RotateCcw, X } from "lucide-react";
import NextLink from "next/link";
import { Fragment, useEffect, useState, type ReactNode, type RefObject } from "react";

import { PageChrome } from "@/components/shell/page-chrome";
import { EmptyState } from "@/components/ui/EmptyState";
import { FileIcon } from "@/components/ui/FileIcon";
import { IconButton } from "@/components/ui/IconButton";
import { SectionTabs } from "@/components/ui/SectionTabs";
import { relInline, fmtDateTime } from "@/lib/format";
import { useMessages } from "@/lib/i18n";

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

/**
 * Phones: the head slides away while reading down and comes back on the way up (preview
 * `headHidden`, applied by CSS on narrow screens only). Also marks `#main.is-past-hero` so the
 * top row shows the title while the head is away.
 */
export function useCollapsingHead(scroll: RefObject<HTMLElement | null>, head: RefObject<HTMLElement | null>, key: string): boolean {
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    const sc = scroll.current;
    const root = head.current?.parentElement;
    if (!sc) return;
    if (head.current && root) root.style.setProperty("--rdr-head-h", `${head.current.offsetHeight}px`);
    let last = sc.scrollTop;
    let state = false;
    const apply = (want: boolean) => {
      if (want === state) return;
      state = want;
      setHidden(want);
      document.getElementById("main")?.classList.toggle("is-past-hero", want);
    };
    const onScroll = () => {
      const top = sc.scrollTop;
      const dy = top - last;
      last = top;
      apply(top <= 48 ? false : dy > 4 ? true : dy < -4 ? false : state);
    };
    sc.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      sc.removeEventListener("scroll", onScroll);
      document.getElementById("main")?.classList.remove("is-past-hero");
      setHidden(false);
    };
  }, [scroll, head, key]);
  return hidden;
}

/** "Đã cập nhật 2 ngày trước" with the exact time on hover. */
export function Updated({ at, prefix = "Đã cập nhật" }: { at?: string; prefix?: string }) {
  return <span title={fmtDateTime(at)}>{`${prefix} ${relInline(at)}`}</span>;
}

/** Meta line items joined by the preview's dot. */
export function Meta({ parts, className = "rdr-head__meta" }: { parts: ReadonlyArray<ReactNode>; className?: string }) {
  const shown = parts.filter(Boolean);
  return (
    <span className={className}>
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
    </span>
  );
}

export interface ReaderHeadProps {
  resource: Resource;
  chips: ReactNode;
  meta: ReadonlyArray<ReactNode>;
  headRef?: RefObject<HTMLElement | null>;
  /** The Content | Original toggle, at the end of the identity row. */
  view?: ReactNode;
  /** The find-in-document bar (`.rdr-hits`). */
  children?: ReactNode;
}

/**
 * The document's identity under the top row (preview `.rdr-head`): file tile, title with chips, meta,
 * the view toggle and the find-in-document bar. Ask, Save and ⋯ sit in the top row with the trail.
 */
export function ReaderHead({ resource: r, chips, meta, headRef, view, children }: ReaderHeadProps) {
  return (
    <header className="rdr-head" id="rdr-head" ref={headRef}>
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
        {view ? <div className="rdr-head__view">{view}</div> : null}
      </div>
      {children}
    </header>
  );
}

export interface RailProps {
  /** Ask · About · Related; omitted for a single titled panel. */
  tabs?: { id: string; label: string }[];
  tab?: string;
  onTab?: (id: string) => void;
  /** Title of a panel without tabs. */
  title?: string;
  onClose: () => void;
  bodyRef?: RefObject<HTMLDivElement | null>;
  children: ReactNode;
  composer?: ReactNode;
}

/** Side panel (preview `.rdr-rail`) with its scrim for the overlay layout. */
export function Rail({ tabs, tab = "", onTab, title, onClose, bodyRef, children, composer }: RailProps) {
  return (
    <>
      <aside className="rdr-rail" aria-label={title ?? "Bảng tài liệu"}>
        <div className="rdr-rail__head">
          {tabs ? (
            <SectionTabs items={tabs} active={tab} onChange={(id) => onTab?.(id)} label="Bảng tài liệu" className="tabs" />
          ) : (
            <h2 className="rdr-rail__title">{title}</h2>
          )}
          <IconButton icon={X} tip="Đóng bảng" size="sm" onPress={onClose} />
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
    <div className="doc-page" aria-busy="true" aria-label="Đang tải">
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

/**
 * Not found or archived (preview `notAvailable`), or not visible to the caller (`locked`, preview
 * `noAccess` without a readable collection: the API answers 403 alike whether or not it exists).
 */
export function Unavailable({
  title = "Tài liệu này không khả dụng",
  description = "Tài liệu có thể đã được lưu trữ hoặc bị gỡ.",
  locked = false,
  actions,
}: {
  title?: string;
  description?: string;
  locked?: boolean;
  actions?: ReactNode;
}) {
  const msg = useMessages();
  return (
    <>
      <PageChrome crumbs={[{ label: msg.nav.knowledge, href: "/knowledge" }, { label: "Không khả dụng" }]} />
      <div className="rdr-msg">
        <EmptyState
          icon={locked ? Lock : File}
          title={title}
          description={description}
          actions={
            actions ?? (
              <NextLink href="/knowledge" className={buttonVariants({ variant: "primary" })}>
                Đến Tra cứu
              </NextLink>
            )
          }
          boxed
        />
      </div>
    </>
  );
}

export interface ProcessingNoteProps {
  resource: Resource;
  /** Processing error (`indexingError.message`). */
  error?: string;
  /** The caller may process it (`ingestionRuns.create`). */
  canProcess: boolean;
  processing: boolean;
  onProcess: () => void;
}

/**
 * Where processing stands, as a quiet line above the file (document_viewer.md: processing never
 * hides the file). Only what needs processing waits for it — search, Ask and citations — and an
 * editor gets the run action. Nothing for a processed document.
 */
export function ProcessingNote({ resource: r, error, canProcess, processing, onProcess }: ProcessingNoteProps) {
  const doc = r.item.document;
  const state = doc?.contentState === "FAILED" ? "FAILED" : doc?.indexingState;
  if (state === "SUCCEEDED" || state === "OUTDATED") return null;
  const action = (label: string, Icon: typeof Play) =>
    canProcess ? (
      <Button size="sm" variant="ghost" onPress={onProcess} isPending={processing}>
        <Icon className="i" aria-hidden />
        {label}
      </Button>
    ) : null;
  const note = (icon: ReactNode, title: string, detail: ReactNode, act: ReactNode = null, tone?: "danger") => (
    <div className={clsx("doc-proc", tone && `doc-proc--${tone}`)} role="status">
      {icon}
      <span className="doc-proc__text">
        <span className="doc-proc__title">{title}</span>
        <span>{detail}</span>
      </span>
      {act}
    </div>
  );
  switch (state) {
    case "RUNNING":
      return note(<LoaderCircle className="i i-sm spin" aria-hidden />, "Đang xử lý", "Sau vài phút, bạn có thể tìm kiếm và đặt câu hỏi về tài liệu này.");
    case "UNSUPPORTED":
      return note(<Info className="i i-sm" aria-hidden />, "Chưa tra cứu được", "Tìm kiếm và Hỏi không đọc được loại tệp này.");
    case "FAILED":
      return note(
        <CircleAlert className="i i-sm" aria-hidden />,
        "Không xử lý được",
        <>
          {error || "Không đọc được tệp để phục vụ tìm kiếm."}
          {canProcess ? "" : `Hãy nhờ chủ sở hữu ${r.base?.displayName || "kho tài liệu chứa tài liệu"} sửa lỗi.`}
        </>,
        action("Thử lại", RotateCcw),
        "danger",
      );
    default:
      return note(<Clock className="i i-sm" aria-hidden />, "Chưa xử lý", "Bạn có thể tìm kiếm và đặt câu hỏi về tài liệu này sau khi được xử lý.", action(r.isPersonal ? "Cho phép tra cứu" : "Xử lý", Play));
  }
}

/** A document (or one of its versions) with nothing to draw, and what to do instead. */
export function NothingToShow({ title = "Không có gì để hiển thị", description = "Tài liệu này chưa có nội dung đọc được.", actions }: { title?: string; description?: string; actions?: ReactNode }) {
  return (
    <div className="doc-state">
      <EmptyState icon={FileText} title={title} description={description} actions={actions} />
    </div>
  );
}

/** A representation cut at the engine's bounds: what is shown, and the original's download for the rest. */
export function CutNotice({ children, onDownload }: { children: ReactNode; onDownload: () => void }) {
  return (
    <p className="doc-gap doc-gap--action">
      <span>{children}</span>
      <Button size="sm" variant="ghost" onPress={onDownload}>
        <Download className="i" aria-hidden />
        Tải xuống
      </Button>
    </p>
  );
}
