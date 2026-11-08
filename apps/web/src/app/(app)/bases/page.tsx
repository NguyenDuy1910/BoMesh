import { Suspense } from "react";

import { BasesPage } from "@/modules/knowledge/bases/components/BasesPage";

export default function Page() {
  return (
    <Suspense>
      <BasesPage />
    </Suspense>
  );
}
