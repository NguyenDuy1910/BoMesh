import { Suspense } from "react";

import { LibraryPage } from "@/modules/knowledge/library/components/LibraryPage";

export default function Page() {
  return (
    <Suspense>
      <LibraryPage />
    </Suspense>
  );
}
