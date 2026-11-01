import { Suspense } from "react";

import { ActivityPage } from "@/modules/manage/activity/ActivityPage";

export default function ManageActivityRoute() {
  // Tabs, window, filters and the open event live in the query string.
  return (
    <Suspense>
      <ActivityPage />
    </Suspense>
  );
}
