import { Suspense } from "react";

import { PersonalKnowledgeRedirect } from "@/modules/knowledge/components/PersonalKnowledgeRedirect";

export default function PersonalKnowledgeRoute() {
  return (
    <Suspense>
      <PersonalKnowledgeRedirect />
    </Suspense>
  );
}
