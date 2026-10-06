/**
 * What one chat turn may carry, mirrored from the backend so the composer can
 * refuse a file with a reason before uploading it. The API still enforces
 * every limit; change these only together with their source.
 */
export const CHAT_LIMITS = {
  /** `ChatRequest.message` max_length (backend/api/routers/__init__.py; openapi `ChatRequest`). */
  messageCharacters: 4_000,
  /** `ChatRequest.attachment_ids` max_length. */
  attachments: 10,
  /** `ChatRequest.collection_ids` max_length. */
  collections: 20,
  /**
   * `BOMESH_DOCUMENT_MAX_UPLOAD_BYTES`, default `DEFAULT_MAX_UPLOAD_BYTES`
   * (backend/bomesh/services/__init__.py) = 100 MiB.
   */
  uploadBytes: 100 * 1024 * 1024,
} as const;

/**
 * Extensions a conversation attachment may have: `_validate_supported_file`
 * in backend/bomesh/services/documents.py accepts knowledge files
 * (`FinxFileExtensions.KNOWLEDGE_EXTENSIONS`) and, for conversations only,
 * images (`IMAGE_EXTENSIONS`). Archives go to a knowledge base, never a chat.
 */
const TEXT_EXTENSIONS = [".csv", ".htm", ".html", ".json", ".jsonl", ".log", ".markdown", ".md", ".rst", ".sql", ".tsv", ".txt", ".xml", ".yaml", ".yml"];
const OFFICE_EXTENSIONS = [".docx", ".pptx", ".xlsx"];
const IMAGE_EXTENSIONS = [".avif", ".bmp", ".gif", ".jpeg", ".jpg", ".png", ".tif", ".tiff", ".webp"];
export const ATTACHMENT_EXTENSIONS: readonly string[] = [...TEXT_EXTENSIONS, ...OFFICE_EXTENSIONS, ".pdf", ...IMAGE_EXTENSIONS];

/** The file input's `accept` list. */
export const ATTACHMENT_ACCEPT = ATTACHMENT_EXTENSIONS.join(",");

/** One line for the drop target and the upload menu. */
export const ATTACHMENT_HINT = "PDF, Office, text, CSV and images · up to 100 MB";

const VIDEO_EXTENSIONS = /\.(mp4|m4v|mov|avi|mkv|webm|wmv|flv|mpe?g|3gp)$/i;
const APP_EXTENSIONS = /\.(exe|msi|dmg|pkg|app|apk|ipa|deb|rpm|bin|iso|jar|bat|cmd|com|sh)$/i;
const ARCHIVE_EXTENSIONS = /\.(zip|rar|7z|tar|gz|tgz|bz2|xz)$/i;

/**
 * Why a picked file can't be attached, in the reader's words, or null when it
 * can. Video and app files are refused outright; everything else follows the
 * backend's type and size rules.
 */
export function attachmentRefusal(file: { name: string; size: number; type?: string }): string | null {
  const name = file.name.trim();
  if (VIDEO_EXTENSIONS.test(name) || file.type?.startsWith("video/")) return "Video files can’t be attached";
  if (APP_EXTENSIONS.test(name)) return "App files can’t be attached";
  if (ARCHIVE_EXTENSIONS.test(name)) return "Add archives to a knowledge base, not a chat";
  const extension = name.match(/\.[^.\s]+$/)?.[0]?.toLowerCase();
  if (!extension || !ATTACHMENT_EXTENSIONS.includes(extension)) return "This file type can’t be read";
  if (file.size <= 0) return "This file is empty";
  if (file.size > CHAT_LIMITS.uploadBytes) return "Larger than 100 MB";
  return null;
}
