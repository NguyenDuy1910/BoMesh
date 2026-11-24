"use client";

import { File, Folder } from "lucide-react";
import { useEffect, useMemo, type CSSProperties } from "react";

import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { fmtNum, fmtSize } from "@/lib/format";

import { archiveRows, parseArchivePayload } from "../archive";
import { CutNotice, SkeletonPage } from "./ReaderParts";
import { useRepresentationBody, type ViewerProps } from "./viewer";

const readArchive = async (response: Response) => parseArchivePayload(await response.json());

/**
 * The ARCHIVE representation: the archive's listing (central directory only, nothing extracted) as a
 * compact tree of folders and files with their sizes.
 */
export function ArchiveView({ fileKey, representation, refresh, onMarks, onDownload }: ViewerProps) {
  const body = useRepresentationBody({ fileKey, representation, refresh }, readArchive);
  const rows = useMemo(() => (body.data ? archiveRows(body.data.entries) : []), [body.data]);
  const done = !body.isPending;
  useEffect(() => {
    if (done) onMarks({ total: 0, unresolved: 0, ready: true });
  }, [done, onMarks]);

  if (body.isPending) return <SkeletonPage />;
  if (body.isError) return <ErrorState title="Không tải được tệp này" error={body.error} onRetry={() => void body.refetch()} />;
  if (!rows.length) {
    return (
      <div className="doc-state">
        <EmptyState title="Tệp nén này trống" />
      </div>
    );
  }
  const { entries, totalEntries, truncated } = body.data;
  return (
    <article className="doc-viewer doc-viewer--flow doc-viewer--archive">
      <ul className="doc-archive" translate="no">
        {rows.map((row) => (
          <li key={row.path} className="doc-archive__row" style={{ "--depth": row.depth } as CSSProperties} title={row.path}>
            {row.directory ? <Folder className="i i-sm" aria-hidden /> : <File className="i i-sm" aria-hidden />}
            <span className="doc-archive__name">{row.name}</span>
            <span className="doc-archive__size num">{fmtSize(row.sizeBytes)}</span>
          </li>
        ))}
      </ul>
      {truncated || representation.truncated ? (
        <CutNotice onDownload={onDownload}>{`Đang hiển thị ${fmtNum(entries.length)} trong số ${fmtNum(totalEntries)} mục — tải xuống để xem phần còn lại.`}</CutNotice>
      ) : null}
    </article>
  );
}
