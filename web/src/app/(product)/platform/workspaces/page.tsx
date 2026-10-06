import { Suspense } from "react";

import { RequirePermission } from "@/components/shell/RequirePermission";
import { PlatformWorkspacesPage } from "@/modules/platform/components/PlatformWorkspacesPage";

export default function PlatformWorkspacesPageRoute() {
  return (
    <RequirePermission platformAnyOf={["platform.tenant.read"]}>
      {/* The page reads `?workspace=` to open a drawer. */}
      <Suspense>
        <PlatformWorkspacesPage />
      </Suspense>
    </RequirePermission>
  );
}
