/**
 * What the document surface draws for one `ItemPreview` (document_viewer.md "Reading (web)"): the
 * preview engine has already turned the file into one of six representations, so the only branches
 * are the preview's `state` and the representation's `kind` — never the file's name, MIME type or
 * encoding.
 */
import type { DocumentCover, ItemPreview } from "../api";
import type { DocFormat } from "./format.ts";

export type ItemRepresentation = NonNullable<ItemPreview["representation"]>;
export type RepresentationKind = NonNullable<ItemRepresentation["kind"]>;
export type UnavailableReason = NonNullable<ItemPreview["unavailableReason"]>;

/** The six viewers, one per representation kind. */
export type Viewer = "pdf" | "image" | "table" | "text" | "media" | "archive";

const VIEWERS: Readonly<Record<RepresentationKind, Viewer>> = {
  PDF: "pdf",
  IMAGE: "image",
  TABLE: "table",
  TEXT: "text",
  MEDIA: "media",
  ARCHIVE: "archive",
};

export type SurfaceView =
  | { state: "PREPARING" }
  | { state: "UNAVAILABLE"; reason: UnavailableReason }
  | { state: "READY"; viewer: Viewer; representation: ItemRepresentation & { uri: string } };

/**
 * The viewer for a preview. A READY preview without a representation the client knows (a kind added
 * later) reads as a format this client can't show.
 */
export function surfaceView(preview: ItemPreview): SurfaceView {
  if (preview.state === "PREPARING") return { state: "PREPARING" };
  const representation = preview.representation;
  const viewer = representation?.kind ? VIEWERS[representation.kind] : undefined;
  if (preview.state === "READY" && viewer && representation?.uri) return { state: "READY", viewer, representation: { ...representation, uri: representation.uri } };
  return { state: "UNAVAILABLE", reason: preview.unavailableReason ?? "FORMAT_NOT_SUPPORTED" };
}

/** Why a file has no preview, as the surface says it (each offers the original's download). */
export const UNAVAILABLE_COPY: Readonly<Record<UnavailableReason, { title: string; description: string }>> = {
  FORMAT_NOT_SUPPORTED: { title: "Không thể hiển thị loại tệp này tại đây", description: "Hãy tải xuống để mở bằng ứng dụng phù hợp." },
  TOO_LARGE: { title: "Tệp quá lớn để xem trước", description: "Hãy tải xuống để mở bằng ứng dụng phù hợp." },
  CONVERSION_FAILED: { title: "Không chuyển đổi được tệp để xem trước", description: "Hãy tải xuống để mở bằng ứng dụng phù hợp." },
};

/** The page chrome of a representation: PDF pages, a sheet grid, or one continuous Markdown / text page. */
export function viewerFormat(viewer: Viewer, representation: Pick<ItemRepresentation, "textFormat">): DocFormat {
  if (viewer === "pdf") return "pdf";
  if (viewer === "table") return "sheet";
  return viewer === "text" && representation.textFormat === "MARKDOWN" ? "markdown" : "text";
}

/** The page chrome a cover is drawn in while the representation is prepared. */
export function coverFormat(cover: Pick<DocumentCover, "kind"> | undefined): DocFormat {
  if (cover?.kind === "SLIDE") return "slide";
  if (cover?.kind === "SHEET") return "sheet";
  return cover?.kind === "TEXT" ? "text" : "pdf";
}
