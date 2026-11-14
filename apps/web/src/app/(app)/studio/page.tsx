import { Suspense } from "react";

import { StudioPage } from "@/modules/curation/components/StudioPage";

export default function Page() {
  return (
    <Suspense>
      <StudioPage />
    </Suspense>
  );
}
