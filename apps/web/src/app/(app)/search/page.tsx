import { Suspense } from "react";

import { SearchPage } from "@/modules/search/components/SearchPage";

export default function Page() {
  return (
    <Suspense>
      <SearchPage />
    </Suspense>
  );
}
