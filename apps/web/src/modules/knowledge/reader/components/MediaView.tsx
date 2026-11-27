"use client";

import { Button } from "@heroui/react";
import { Download } from "lucide-react";
import { useEffect, useState } from "react";

import { NothingToShow } from "./ReaderParts";
import type { ViewerProps } from "./viewer";

/**
 * The MEDIA representation: the original audio or video in the browser's own player. Only its metadata
 * is read until the reader presses play (`preload="metadata"`); the player streams the rest with `Range`.
 * A signed URL that stopped working is replaced once with a fresh one.
 */
export function MediaView({ representation, refresh, onMarks, onDownload }: ViewerProps) {
  const [src, setSrc] = useState(representation.uri);
  const [state, setState] = useState<"ok" | "retrying" | "failed">("ok");
  useEffect(() => onMarks({ total: 0, ready: true }), [onMarks]);
  if (state === "failed") {
    return (
      <NothingToShow
        title="Không phát được tệp đa phương tiện này"
        description="Hãy tải xuống để mở bằng ứng dụng phù hợp."
        actions={
          <Button variant="tertiary" onPress={onDownload}>
            <Download className="i" aria-hidden />
            Tải xuống
          </Button>
        }
      />
    );
  }
  const onError = () => {
    if (state !== "ok") return setState("failed");
    setState("retrying");
    void refresh().then((fresh) => {
      const next = fresh?.representation?.uri;
      if (next && next !== src) setSrc(next);
      else setState("failed");
    });
  };
  return (
    <div className="doc-viewer doc-viewer--media">
      {representation.mediaType === "AUDIO" ? (
        <audio className="doc-media doc-media--audio" src={src} controls preload="metadata" onError={onError} />
      ) : (
        <video className="doc-media" src={src} controls preload="metadata" playsInline onError={onError} />
      )}
    </div>
  );
}
