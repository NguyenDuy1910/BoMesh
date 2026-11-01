import { Suspense } from "react";

import { KnowledgeBasePage } from "@/modules/knowledge/components/KnowledgeBasePage";

export default async function KnowledgeBaseRoute({ params }: { params: Promise<{ collectionId: string }> }) {
  const { collectionId } = await params;
  return (
    <Suspense>
      <KnowledgeBasePage collectionId={collectionId} />
    </Suspense>
  );
}
