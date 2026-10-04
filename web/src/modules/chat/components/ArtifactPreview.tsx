"use client";

import { Download, FileWarning, LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";

import { DocumentRenditionView } from "@/modules/knowledge/components/DocumentRenditionView";
import { getArtifactContent, type ArtifactContent } from "../api";
import { IncrementalMarkdown } from "./IncrementalMarkdown";

/**
 * One revision of a produced document, rendered beside the conversation.
 *
 * The content comes from the authorized artifact API on demand, so a card that
 * was restored from an old conversation never shows stale or leaked content.
 * Markdown is rendered as Markdown; a Word, Excel, PDF or CSV file is shown
 * through the same rendition view Knowledge documents use, and an image as
 * itself.
 */
export function ArtifactPreview({
  artifactId,
  revision,
}: {
  artifactId: string;
  revision: number;
}) {
  const [content, setContent] = useState<ArtifactContent>();
  const [error, setError] = useState<string>();
  // Preview URLs are short-lived; a failed download re-reads them.
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setError(undefined);
    void getArtifactContent(artifactId, revision, controller.signal)
      .then(setContent)
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setError(cause instanceof Error ? cause.message : "Could not open this document.");
      });
    return () => controller.abort();
  }, [artifactId, revision, refresh]);

  if (error) {
    return (
      <div className="artifact-preview">
        <div className="artifact-preview__notice" role="alert">
          <FileWarning aria-hidden="true" size={16} />
          <span>{error}</span>
        </div>
      </div>
    );
  }
  if (!content) {
    return (
      <div className="artifact-preview">
        <div className="artifact-preview__notice" role="status">
          <LoaderCircle aria-hidden="true" className="artifact-preview__spinner" size={16} />
          <span>Opening document…</span>
        </div>
      </div>
    );
  }
  return (
    <div className="artifact-preview">
      <div className="artifact-preview__meta">
        <span>Revision {content.revision}</span>
        {content.truncated && <span>Preview shortened</span>}
      </div>
      <ArtifactBody content={content} onRetry={() => setRefresh((value) => value + 1)} />
    </div>
  );
}

function ArtifactBody({ content, onRetry }: { content: ArtifactContent; onRetry: () => void }) {
  const preview = content.preview;
  if (content.mime_type === "text/markdown") {
    return (
      <div className="artifact-preview__body assistant-content">
        <IncrementalMarkdown isStreaming={false} text={content.content} />
      </div>
    );
  }
  if (preview?.rendition) {
    return (
      <div className="artifact-preview__document">
        <DocumentRenditionView
          contentType={content.mime_type}
          itemId={content.artifact_id}
          onRetry={onRetry}
          originalUrl={preview.original.url}
          rendition={preview.rendition}
        />
      </div>
    );
  }
  if (preview && content.mime_type.startsWith("image/")) {
    return (
      <div className="artifact-preview__body">
        {/* eslint-disable-next-line @next/next/no-img-element -- a short-lived signed URL */}
        <img alt={preview.original.file_name} className="artifact-preview__image" src={preview.original.url} />
      </div>
    );
  }
  if (content.mime_type.startsWith("text/")) {
    // Text the viewer could not lay out keeps its own lines.
    return <pre className="artifact-preview__body artifact-preview__text">{content.content}</pre>;
  }
  return (
    <div className="artifact-preview__notice" role="status">
      <FileWarning aria-hidden="true" size={16} />
      <span>This file can’t be shown here. Download it to open it.</span>
      {preview && (
        <a className="artifact-preview__download" download href={preview.original.url}>
          <Download aria-hidden="true" size={14} />
          Download
        </a>
      )}
    </div>
  );
}
