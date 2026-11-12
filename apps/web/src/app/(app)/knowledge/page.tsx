import { Suspense } from "react";

import { BrowsePage } from "@/modules/knowledge/browse/BrowsePage";

export default function Page() {
  return (
    <Suspense>
      <BrowsePage />
    </Suspense>
  );
}
