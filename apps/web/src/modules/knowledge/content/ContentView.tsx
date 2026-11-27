"use client";

import { Button } from "@heroui/react";
import { ChevronDown, Clock, FileText, History, Info, Lock } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { ApiError } from "@/lib/api/client";

import type { ContentNode } from "./api";
import { DocumentRenderer } from "./DocumentRenderer";
import { useContentWindows } from "./queries";

export interface ContentViewProps {
  /** Item name or bare ID. */
  item: string;
  /** Revision number; default the document's indexed revision. */
  revision?: number;
  /** Structure version; default the revision's current one. */
  version?: string;
}

function ContentSkeleton() {
  return (
    <div className="cv-doc cv-doc--busy" aria-busy="true" aria-label="Đang tải">
      <span className="skeleton cv-skeleton cv-skeleton--title" />
      {[94, 88, 97, 72, 0, 90, 84, 61].map((w, i) => (w ? <span key={i} className="skeleton cv-skeleton" style={{ width: `${w}%` }} /> : <span key={i} className="cv-gap" />))}
    </div>
  );
}

/**
 * Content view of an artifact revision (document_viewer.md "Content view: artifact revisions"): the revision's
 * Structured Document (GetItemContent) drawn by `DocumentRenderer`, from the start, "Xem phần sau" reading the next
 * window. A version that is gone or a revision not processed yet says so. Knowledge documents are read in their
 * Original, never here. Callers key it by the revision and version they show.
 */
export function ContentView({ item, revision, version }: ContentViewProps) {
  // "Đọc phiên bản hiện tại" drops the pinned version.
  const [current, setCurrent] = useState(false);
  const windows = useContentWindows(item, { revision: current ? undefined : revision, version: current ? undefined : version });

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

  let body: ReactNode;
  if (windows.isPending) body = <ContentSkeleton />;
  else if (windows.isError) {
    const e = windows.error;
    const reason = e instanceof ApiError ? e.reason : undefined;
    if (reason === "CONTENT_NOT_PROCESSED") {
      body = <EmptyState compact icon={Clock} title="Tài liệu chưa được xử lý" description="Nội dung sẽ đọc được ở đây khi tài liệu được xử lý xong." />;
    } else if (reason === "CONTENT_VERSION_UNAVAILABLE") {
      body = (
        <EmptyState
          compact
          icon={History}
          title="Phiên bản nội dung này không còn"
          description="Tài liệu đã được xử lý lại. Bạn có thể đọc phiên bản nội dung hiện tại."
          actions={
            <Button variant="secondary" onPress={() => setCurrent(true)}>
              <FileText className="i" aria-hidden />
              Đọc phiên bản hiện tại
            </Button>
          }
        />
      );
    } else if (e instanceof ApiError && e.isNotFound) {
      body = <EmptyState compact icon={Lock} title="Không có tài liệu" description="Tài liệu đã bị gỡ hoặc chưa được chia sẻ với bạn." />;
    } else body = <ErrorState compact boxed={false} title="Không tải được nội dung" error={e} onRetry={() => void windows.refetch()} />;
  } else if (!nodes.length) {
    body = <EmptyState compact icon={FileText} title="Không có nội dung để hiển thị" description="Tài liệu này không có nội dung đọc được." />;
  } else {
    body = (
      <>
        <p className="cv-note">
          <Info className="i i-xs" aria-hidden />
          <span>Nội dung trích xuất — có thể khác bố cục bản gốc</span>
        </p>
        <DocumentRenderer nodes={nodes} />
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

  return <div className="cv cv--pane">{body}</div>;
}
