/**
 * pdf.js, loaded only when a PDF is opened (one lazy chunk, cached for every document after;
 * document_viewer.md "Performance"). The legacy build carries its own polyfills: the modern one
 * calls APIs only the newest browsers ship (`Map.prototype.getOrInsertComputed`, `Math.sumPrecise`).
 *
 * The worker is the package's prebuilt file, emitted by the bundler as a static asset through
 * `new URL(…, import.meta.url)` (Turbopack in dev, `next build` in production), so parsing runs off
 * the main thread and no copy of the worker lives in `public/`.
 */
import type * as PdfJs from "pdfjs-dist/legacy/build/pdf.mjs";

export type PdfJsModule = typeof PdfJs;
export type PdfDocument = PdfJs.PDFDocumentProxy;
export type PdfPage = PdfJs.PDFPageProxy;
export type PdfLoadingTask = PdfJs.PDFDocumentLoadingTask;

let loading: Promise<PdfJsModule> | undefined;

export function loadPdfJs(): Promise<PdfJsModule> {
  loading ??= import("pdfjs-dist/legacy/build/pdf.mjs").then(
    (pdfjs) => {
      pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/legacy/build/pdf.worker.min.mjs", import.meta.url).toString();
      return pdfjs;
    },
    (error: unknown) => {
      loading = undefined;
      throw error;
    },
  );
  return loading;
}

/** Bytes per ranged read (document_viewer.md "Performance"): few round trips to the first page, little read past it. */
const RANGE_CHUNK_BYTES = 1024 * 1024;
/** Below this size one whole read is faster than ranged reads. */
const WHOLE_FILE_BYTES = 4 * 1024 * 1024;

/** How pdf.js reads a PDF representation: ranged reads (no streaming, no prefetch), or the whole file when it is small. */
export function pdfSource(uri: string, sizeBytes: string | number | undefined): Parameters<PdfJsModule["getDocument"]>[0] {
  const size = Number(sizeBytes);
  return { url: uri, disableAutoFetch: true, disableStream: true, rangeChunkSize: RANGE_CHUNK_BYTES, disableRange: size > 0 && size < WHOLE_FILE_BYTES };
}

/** pdf.js reports a failed storage read with the HTTP status (`ResponseException.status`). */
export function storageStatus(error: unknown): number | undefined {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" && status > 0 ? status : undefined;
}

/** A render or text layer stopped because the page left the view (not a failure). */
export function isCancelled(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name;
  return name === "RenderingCancelledException" || name === "AbortException";
}
