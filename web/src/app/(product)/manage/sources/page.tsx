import { Suspense } from "react";

import { Page } from "@/components/shell/Page";
import { RequirePermission } from "@/components/shell/RequirePermission";
import { PageLoadingSkeleton } from "@/components/ui/Skeleton";
import { SourcesScreen } from "@/modules/ingestion/components/SourcesScreen";

export default function ManageSourcesRoute() {
  return (
    <RequirePermission anyOf={["source.manage", "ingestion.read"]}>
      <Page>
        <Suspense fallback={<PageLoadingSkeleton controls heading label="Loading sources" />}>
          <SourcesScreen />
        </Suspense>
      </Page>
    </RequirePermission>
  );
}
