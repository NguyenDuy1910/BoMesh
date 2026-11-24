"use client";

import { Button } from "@heroui/react";
import { Download } from "lucide-react";
import { useEffect, useState } from "react";

import { NothingToShow } from "./ReaderParts";
import type { ViewerProps } from "./viewer";

/**
 * The IMAGE representation: a picture browsers draw (the original, or the engine's PNG of it), fitted to
 * the width. A signed URL that stopped working is replaced once with a fresh one.
 */
export function ImageView({ representation, refresh, onMarks, onDownload }: ViewerProps) {
  const [src, setSrc] = useState(representation.uri);
  const [state, setState] = useState<"ok" | "retrying" | "failed">("ok");
  useEffect(() => onMarks({ total: 0, unresolved: 0, ready: true }), [onMarks]);
  if (state === "failed") {
    return (
      <NothingToShow
        title="Không tải được ảnh này"
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
  return (
    <div className="doc-viewer doc-viewer--image">
      {/* Not next/image: a signed URL on the storage host, which the optimizer cannot cache. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        className="doc-image"
        src={src}
        alt=""
        decoding="async"
        onError={() => {
          if (state !== "ok") return setState("failed");
          setState("retrying");
          void refresh().then((fresh) => {
            const next = fresh?.representation?.uri;
            if (next && next !== src) setSrc(next);
            else setState("failed");
          });
        }}
      />
    </div>
  );
}
