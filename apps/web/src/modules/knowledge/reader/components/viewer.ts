"use client";

import { useQuery } from "@tanstack/react-query";

import type { ItemPreview } from "../../api";
import type { ItemRepresentation } from "../preview";
import type { SurfaceHighlight } from "./DocumentSurface";

/** What a viewer has marked: counts, and whether it is drawn (so the counts are final). */
export interface ViewerMarks {
  total: number;
  ready: boolean;
  /** Where the focused mark is when it isn't drawn yet (a PDF page far from the view). */
  focusPage?: number;
}

/** What every one of the six viewers is given: a representation (a signed URL) and the marks to draw. */
export interface ViewerProps {
  /** Cache identity of the file shown (`item:revision`). */
  fileKey: string;
  representation: ItemRepresentation & { uri: string };
  /** Reads the preview again (a freshly signed URL) when storage refuses the current one. */
  refresh: () => Promise<ItemPreview | undefined>;
  highlight?: SurfaceHighlight;
  focusHit: number;
  onMarks: (marks: ViewerMarks) => void;
  onDownload: () => void;
}

/** A representation's object couldn't be read; `status` 403 means its signed URL expired. */
export class RepresentationLoadError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "RepresentationLoadError";
    this.status = status;
  }
}

async function readObject<T>(uri: string, read: (response: Response) => Promise<T>, signal: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetch(uri, { signal });
  } catch (cause) {
    if (signal.aborted) throw cause;
    throw new RepresentationLoadError("Không truy cập được tệp.");
  }
  if (!response.ok) throw new RepresentationLoadError(`Không đọc được tệp (${response.status}).`, response.status);
  return read(response);
}

/**
 * The body of a representation (TABLE, TEXT, ARCHIVE), read once per revision: the object is
 * immutable, so it is cached for the session. A 403 re-reads the preview and tries the fresh URL once.
 * Gzip-encoded objects are stored with `Content-Encoding: gzip`, so the browser decompresses them.
 */
export function useRepresentationBody<T>({ fileKey, representation, refresh }: Pick<ViewerProps, "fileKey" | "representation" | "refresh">, read: (response: Response) => Promise<T>) {
  return useQuery({
    queryKey: ["representation", fileKey, representation.kind],
    queryFn: async ({ signal }) => {
      try {
        return await readObject(representation.uri, read, signal);
      } catch (error) {
        if (!(error instanceof RepresentationLoadError && error.status === 403)) throw error;
        const fresh = (await refresh())?.representation?.uri;
        if (!fresh || fresh === representation.uri) throw error;
        return readObject(fresh, read, signal);
      }
    },
    staleTime: Infinity,
    retry: false,
  });
}
