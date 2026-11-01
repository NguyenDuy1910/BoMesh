import { Suspense } from "react";

import { Page } from "@/components/shell/Page";
import { RequirePermission } from "@/components/shell/RequirePermission";
import { PageLoadingSkeleton } from "@/components/ui/Skeleton";
import { ACCESS_PERMISSIONS } from "@/modules/manage/access/access-model";
import { AccessPage } from "@/modules/manage/access/AccessPage";

export default function ManageAccessRoute() {
  return (
    <RequirePermission anyOf={ACCESS_PERMISSIONS}>
      <Page>
        <Suspense fallback={<PageLoadingSkeleton controls heading label="Loading people and access" />}>
          <AccessPage />
        </Suspense>
      </Page>
    </RequirePermission>
  );
}
