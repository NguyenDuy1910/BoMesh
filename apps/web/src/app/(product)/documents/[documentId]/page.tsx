import { Suspense } from "react";

import { DocumentViewer } from "@/modules/knowledge/components/DocumentViewer";

/** `/documents/[documentId]` (`?chunk=<chunk_id>` focuses a cited passage). */
export default async function DocumentPage({ params }: { params: Promise<{ documentId: string }> }) {
  const { documentId } = await params;
  return (
    <Suspense>
      <DocumentViewer documentId={decodeURIComponent(documentId)} key={documentId} />
    </Suspense>
  );
}
