import type { Ingestion } from "@/modules/knowledge/ingestions-api";
import { ingestionFileKind } from "@/modules/knowledge/ingestion-state";
import { fileKind } from "@/modules/workspace-control/format";

import { AppIcon } from "./AppIcon";
import { FileTypeIcon } from "./FileTypeIcon";

/**
 * What an ingestion took in, as a mark: the file's format for a document, the
 * provider's logo for a source sync — the same marks the document list and the
 * sources list already use, so a row here is recognisable from either.
 */
export function IngestionIcon({ ingestion }: { ingestion: Ingestion }) {
  if (ingestion.kind === "source") {
    return (
      <span aria-label="Source sync" className="inline-flex shrink-0" role="img">
        <AppIcon connector={ingestion.connector_key ?? ""} size="sm" />
      </span>
    );
  }
  return (
    <FileTypeIcon
      className="shrink-0"
      kind={ingestionFileKind(ingestion)}
      label={fileKind(ingestion.title)}
    />
  );
}
