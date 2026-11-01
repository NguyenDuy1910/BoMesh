import { Suspense } from "react";

import { KnowledgeList } from "@/modules/knowledge/components/KnowledgeList";

export default function KnowledgePage() {
  return (
    <Suspense>
      <KnowledgeList />
    </Suspense>
  );
}
