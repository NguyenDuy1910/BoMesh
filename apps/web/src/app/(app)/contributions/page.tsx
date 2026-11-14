import { Suspense } from "react";

import { ContributionsPage } from "@/modules/knowledge/library/components/ContributionsPage";

export default function Page() {
  return (
    <Suspense>
      <ContributionsPage />
    </Suspense>
  );
}
