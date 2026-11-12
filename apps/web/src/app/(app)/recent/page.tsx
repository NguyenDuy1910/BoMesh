import { Suspense } from "react";

import { RecentPage } from "@/modules/knowledge/library/components/RecentPage";

export default function Page() {
  return (
    <Suspense>
      <RecentPage />
    </Suspense>
  );
}
