"use client";

import { Download, FileWarning } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { Skeleton } from "@/components/ui/Skeleton";
import { DocumentRenditionView } from "@/modules/knowledge/components/DocumentRenditionView";

import { IncrementalMarkdown } from "../IncrementalMarkdown";
import { DocPage } from "./DocPage";
import type { FileRevision } from "./file-model";
import { SheetGrid } from "./SheetGrid";
import { revisionKey, useAsync, type FileDetail, type LoadFailure, type RevisionContent, type RevisionContents as Contents } from "./useFileData";

export function PageSkeleton({ label }: { label: string }) {
  return (
    <div aria-busy="true" aria-label={label} className="p-4" role="status">
      <DocPage className="grid gap-3">
        <Skeleton className="h-6 w-2/5" />
        <Skeleton className="h-3.5 w-full" />
        <Skeleton className="h-3.5 w-11/12" />
        <Skeleton className="h-3.5 w-4/5" />
        <Skeleton className="mt-3 h-3.5 w-full" />
        <Skeleton className="h-3.5 w-3/4" />
      </DocPage>
    </div>
  );
}

export function LoadError({ failure, onRetry }: { failure: LoadFailure; onRetry: () => void }) {
  return (
    <div className="p-4">
      {failure.gone ? (
        <EmptyState
          description="It may have been removed, or you no longer have access to it."
          icon={<FileWarning />}
          size="sm"
          title="This version isn’t available"
        />
      ) : (
        <ErrorState description={failure.message} onAction={onRetry} />
      )}
    </div>
  );
}

function Shortened() {
  return (
    <Callout className="mb-3" tone="neutral">
      Only the first part of this file can be shown here. Download it to see the rest.
    </Callout>
  );
}

/** One version, shown the way its kind reads best. */
export function FilePreview({
  contents,
  detail,
  onDownload,
  revision,
}: {
  contents: Contents;
  detail: FileDetail;
  revision: FileRevision;
  onDownload: () => void;
}) {
  const key = revisionKey(detail.id, revision);
  const content = useAsync(key, () => contents.content(revision));
  const retry = () => {
    contents.forget(revision);
    content.retry();
  };

  if (content.failure) return <LoadError failure={content.failure} onRetry={retry} />;
  if (!content.value) return <PageSkeleton label={`Loading version ${revision.revision}`} />;
  const value = content.value;

  switch (detail.kind) {
    case "sheet":
      return <SheetPreview contents={contents} detail={detail} onDownload={onDownload} revision={revision} />;
    case "markdown":
      return (
        <div className="p-4">
          {value.truncated && <Shortened />}
          <DocPage>
            <IncrementalMarkdown isStreaming={false} text={value.text} />
          </DocPage>
        </div>
      );
    case "text":
      return (
        <div className="p-4">
          {value.truncated && <Shortened />}
          <DocPage className="whitespace-pre-wrap break-words font-mono text-[13px] leading-[1.6]">{value.text}</DocPage>
        </div>
      );
    case "image":
      return <ImagePreview content={value} onRetry={retry} title={detail.title} />;
    case "pdf":
      if (value.preview?.assets.length) return <PagePreview content={value} onRetry={retry} title={detail.title} />;
      return <RenditionPreview content={value} detail={detail} onDownload={onDownload} onRetry={retry} />;
    case "document":
      return <RenditionPreview content={value} detail={detail} onDownload={onDownload} onRetry={retry} />;
    default:
      return <NotShown onDownload={onDownload} />;
  }
}

function SheetPreview({ contents, detail, onDownload, revision }: { contents: Contents; detail: FileDetail; revision: FileRevision; onDownload: () => void }) {
  const model = useAsync(`${revisionKey(detail.id, revision)}:model`, () => contents.model(revision));
  if (model.failure) {
    return (
      <LoadError
        failure={model.failure}
        onRetry={() => {
          contents.forget(revision);
          model.retry();
        }}
      />
    );
  }
  if (!model.value) return <PageSkeleton label={`Loading version ${revision.revision}`} />;
  if (model.value.kind !== "sheets") return <NotShown onDownload={onDownload} />;
  return <SheetGrid key={revision.revision} sheets={model.value.sheets} title={detail.title} truncated={model.value.truncated} />;
}

function RenditionPreview({
  content,
  detail,
  onDownload,
  onRetry,
}: {
  content: RevisionContent;
  detail: FileDetail;
  onDownload: () => void;
  onRetry: () => void;
}) {
  const rendition = content.preview?.rendition;
  if (!rendition) return <NotShown onDownload={onDownload} />;
  return (
    <div className="p-4">
      <DocPage className="px-6 py-6">
        <DocumentRenditionView
          contentType={content.mimeType}
          itemId={`artifact:${detail.id}`}
          onRetry={onRetry}
          originalUrl={content.preview?.original.url}
          rendition={rendition}
        />
      </DocPage>
    </div>
  );
}

function PagePreview({ content, onRetry, title }: { content: RevisionContent; onRetry: () => void; title: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <ExpiredPreview onRetry={() => { setFailed(false); onRetry(); }} />;
  return (
    <div className="grid gap-4 p-4">
      {content.preview!.assets.map((asset, index) => (
        // eslint-disable-next-line @next/next/no-img-element -- short-lived signed page images
        <img
          alt={`${title}, page ${index + 1}`}
          className="mx-auto w-full max-w-[720px] rounded-[6px] border border-border-subtle bg-surface-base shadow-(--shadow-2)"
          height={asset.height}
          key={asset.url}
          loading="lazy"
          onError={() => setFailed(true)}
          src={asset.url}
          width={asset.width}
        />
      ))}
    </div>
  );
}

function ImagePreview({ content, onRetry, title }: { content: RevisionContent; onRetry: () => void; title: string }) {
  const [failed, setFailed] = useState(false);
  const url = content.preview?.original.url;
  if (!url) return <NotShown />;
  if (failed) return <ExpiredPreview onRetry={() => { setFailed(false); onRetry(); }} />;
  return (
    <div className="grid place-items-center p-4">
      {/* eslint-disable-next-line @next/next/no-img-element -- a short-lived signed URL */}
      <img
        alt={title}
        className="max-h-[70vh] max-w-full rounded-[6px] border border-border-subtle bg-surface-base shadow-(--shadow-2)"
        onError={() => setFailed(true)}
        src={url}
      />
    </div>
  );
}

function ExpiredPreview({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="p-4">
      <ErrorState
        actionLabel="Reload preview"
        description="The preview link may have expired. Reload it to get a fresh one."
        onAction={onRetry}
        title="The preview didn’t load"
      />
    </div>
  );
}

function NotShown({ onDownload }: { onDownload?: () => void }) {
  return (
    <div className="p-4">
      <EmptyState
        action={onDownload && (
          <Button icon={<Download aria-hidden="true" className="size-4" />} onClick={onDownload} size="sm" variant="secondary">
            Download
          </Button>
        )}
        description="Download it to open it on your computer."
        icon={<FileWarning />}
        size="sm"
        title="This file can’t be shown here"
      />
    </div>
  );
}
