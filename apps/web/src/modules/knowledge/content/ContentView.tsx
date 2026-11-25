"use client";

import { Button } from "@heroui/react";
import { ChevronDown, ChevronUp, Clock, File, FileText, History, Info, Lock } from "lucide-react";
import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { ApiError } from "@/lib/api/client";

import type { ContentNode } from "./api";
import { DocumentRenderer } from "./DocumentRenderer";
import { citedBlocks } from "./highlight";
import { useContentWindows } from "./queries";
import { locationLabel, type Reference } from "./reference";
import { scrollParent } from "./scroll";

export type ContentViewVariant = "preview" | "reader" | "pane";

export interface ContentViewProps {
  /** Item name or bare ID. */
  item: string;
  /** Revision number (a reference's revision); default the document's indexed revision. */
  revision?: number;
  /** Structure version (a reference's `structureVersion`); default the revision's current one. */
  version?: string;
  /** The cited blocks: the window opens around the first, which is scrolled into view; all are highlighted. */
  refs?: readonly string[];
  /** Other blocks of this document to highlight (the other citations of the same answer). */
  cited?: readonly string[];
  /** A block to open the window at and bring into view instead of the first cited one (an outline heading). */
  anchor?: string;
  /** The citation's own words, shown while the blocks load and when they can't be shown. */
  quote?: Pick<Reference, "quote" | "location" | "pageNumber">;
  /** Shows the Original: offered when the content can't be shown here. */
  onOriginal?: () => void;
  variant?: ContentViewVariant;
}

/** The quote of a citation (preview content.js `quoteCard`): what was cited, before and instead of the blocks. */
function QuoteCard({ quote }: { quote: ContentViewProps["quote"] }) {
  if (!quote?.quote) return null;
  const where = locationLabel(quote);
  return (
    <figure className="cv-quote">
      <blockquote translate="no">{quote.quote}</blockquote>
      {where ? <figcaption translate="no">{where}</figcaption> : null}
    </figure>
  );
}

function ContentSkeleton() {
  return (
    <div className="cv-doc cv-doc--busy" aria-busy="true" aria-label="Đang tải">
      <span className="skeleton cv-skeleton cv-skeleton--title" />
      {[94, 88, 97, 72, 0, 90, 84, 61].map((w, i) => (w ? <span key={i} className="skeleton cv-skeleton" style={{ width: `${w}%` }} /> : <span key={i} className="cv-gap" />))}
    </div>
  );
}

/** Where the next render keeps the reader's place: the block that was first in view, and its offset in the scroller. */
interface Kept {
  ref: string;
  top: number;
}

/**
 * Content View (preview content.js, UNIFIED_DOCUMENT_DESIGN.md §10): a window of the document's Structured Document
 * (GetItemContent) around the cited blocks, drawn by `DocumentRenderer`, the cited blocks highlighted by ref and the
 * first scrolled into view; "Xem phần trước / Xem phần sau" read the windows around it. A version that is gone, a
 * document not processed yet or a passage that isn't there says so and offers the Original. Callers key it by the
 * reference they show, so a step to another citation starts afresh.
 */
export function ContentView({ item, revision, version, refs = [], cited = [], anchor: jump, quote, onOriginal, variant = "preview" }: ContentViewProps) {
  // "Đọc phiên bản hiện tại" / "Đọc từ đầu" drop the pinned version / the anchor (and so the highlight).
  const [fallback, setFallback] = useState<"current" | "start" | null>(null);
  const pinned = fallback !== "current";
  const anchor = fallback ? undefined : (jump ?? refs[0]);
  const windows = useContentWindows(item, { revision: pinned ? revision : undefined, version: pinned ? version : undefined, anchor });

  const nodes = useMemo(() => {
    const seen = new Set<string>();
    const out: ContentNode[] = [];
    for (const page of windows.data?.pages ?? []) {
      for (const node of page.nodes ?? []) {
        if (seen.has(node.ref)) continue;
        seen.add(node.ref);
        out.push(node);
      }
    }
    return out;
  }, [windows.data]);
  const focus = useMemo(() => (fallback ? "" : citedBlocks(nodes, refs).first), [fallback, nodes, refs]);
  const marked = useMemo(() => (fallback === "current" ? new Set<string>() : citedBlocks(nodes, [...refs, ...cited]).marked), [fallback, nodes, refs, cited]);

  /* ── Scroll: the focused block once it's drawn; the reader's place when a part is added above ── */
  const rootRef = useRef<HTMLDivElement>(null);
  const scrolled = useRef("");
  const kept = useRef<Kept | null>(null);
  useLayoutEffect(() => {
    const root = rootRef.current;
    const scroller = scrollParent(root);
    if (!root || !scroller) return;
    if (kept.current) {
      const el = root.querySelector<HTMLElement>(`[data-ref="${CSS.escape(kept.current.ref)}"]`);
      if (el) scroller.scrollTop += el.getBoundingClientRect().top - scroller.getBoundingClientRect().top - kept.current.top;
      kept.current = null;
      return;
    }
    const target = (fallback ? "" : jump) || focus;
    const key = `${item}:${target}`;
    if (!nodes.length || scrolled.current === key) return;
    scrolled.current = key;
    const el = target ? root.querySelector<HTMLElement>(`[data-ref="${CSS.escape(target)}"]`) : null;
    if (!el) {
      if (variant !== "reader") scroller.scrollTop = 0;
      return;
    }
    const top = scroller.scrollTop + el.getBoundingClientRect().top - scroller.getBoundingClientRect().top - (target === focus ? scroller.clientHeight / 3 : 16);
    scroller.scrollTo({ top: Math.max(0, top), behavior: "auto" });
  }, [item, focus, jump, fallback, nodes, variant]);

  const earlier = () => {
    const root = rootRef.current;
    const scroller = scrollParent(root);
    const first = root?.querySelector<HTMLElement>(".cv-doc > [data-ref]");
    if (first && scroller) kept.current = { ref: first.dataset.ref ?? "", top: first.getBoundingClientRect().top - scroller.getBoundingClientRect().top };
    void windows.fetchPreviousPage();
  };

  const originalButton = (primary: boolean) =>
    onOriginal ? (
      <Button variant={primary ? "secondary" : "ghost"} onPress={onOriginal}>
        <File className="i" aria-hidden />
        Bản gốc
      </Button>
    ) : null;

  let body: ReactNode;
  if (windows.isPending) body = <ContentSkeleton />;
  else if (windows.isError) {
    const e = windows.error;
    const reason = e instanceof ApiError ? e.reason : undefined;
    if (reason === "CONTENT_NOT_PROCESSED") {
      body = <EmptyState compact icon={Clock} title="Tài liệu chưa được xử lý" description="Nội dung sẽ đọc được ở đây khi tài liệu được xử lý xong. Bạn có thể mở bản gốc ngay." actions={originalButton(true)} />;
    } else if (reason === "CONTENT_VERSION_UNAVAILABLE") {
      body = (
        <EmptyState
          compact
          icon={History}
          title="Phiên bản nội dung được trích dẫn không còn"
          description="Tài liệu đã được xử lý lại sau khi được trích dẫn. Đoạn trích ở trên là nội dung đã được trích dẫn."
          actions={
            <>
              <Button variant="secondary" onPress={() => setFallback("current")}>
                <FileText className="i" aria-hidden />
                Đọc phiên bản hiện tại
              </Button>
              {originalButton(false)}
            </>
          }
        />
      );
    } else if (e instanceof ApiError && e.isNotFound) {
      body = <EmptyState compact icon={Lock} title="Không có tài liệu" description="Tài liệu đã bị gỡ hoặc chưa được chia sẻ với bạn." />;
    } else if (e instanceof ApiError && e.code === "INVALID_ARGUMENT" && anchor) {
      body = (
        <EmptyState
          compact
          icon={FileText}
          title="Không tìm thấy đoạn được trích dẫn trong tài liệu này"
          description="Hãy đọc tài liệu từ đầu, hoặc mở bản gốc."
          actions={
            <>
              <Button variant="secondary" onPress={() => setFallback("start")}>
                Đọc từ đầu
              </Button>
              {originalButton(false)}
            </>
          }
        />
      );
    } else body = <ErrorState compact boxed={false} title="Không tải được nội dung" error={e} onRetry={() => void windows.refetch()} />;
  } else if (!nodes.length) {
    body = <EmptyState compact icon={FileText} title="Không có nội dung để hiển thị" description="Tài liệu này không có nội dung đọc được." actions={originalButton(true)} />;
  } else {
    body = (
      <>
        <p className="cv-note">
          <Info className="i i-xs" aria-hidden />
          <span>Nội dung trích xuất — có thể khác bố cục bản gốc</span>
        </p>
        {windows.hasPreviousPage ? (
          <div className="cv-more">
            <Button variant="ghost" size="sm" isPending={windows.isFetchingPreviousPage} onPress={earlier}>
              <ChevronUp className="i" aria-hidden />
              Xem phần trước
            </Button>
          </div>
        ) : null}
        <DocumentRenderer nodes={nodes} marked={marked} focus={focus} />
        {windows.hasNextPage ? (
          <div className="cv-more">
            <Button variant="ghost" size="sm" isPending={windows.isFetchingNextPage} onPress={() => void windows.fetchNextPage()}>
              <ChevronDown className="i" aria-hidden />
              Xem phần sau
            </Button>
          </div>
        ) : null}
      </>
    );
  }

  const showQuote = !!quote?.quote && (windows.isPending || windows.isError);
  return (
    <div ref={rootRef} className={`cv cv--${variant}`}>
      {showQuote ? <QuoteCard quote={quote} /> : null}
      {body}
    </div>
  );
}
