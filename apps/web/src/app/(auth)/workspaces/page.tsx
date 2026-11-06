import { Suspense } from "react";

import { WorkspaceChooserPage } from "@/modules/auth/components/WorkspaceChooserPage";

export default function Page() {
  return (
    <Suspense>
      <WorkspaceChooserPage />
    </Suspense>
  );
}
