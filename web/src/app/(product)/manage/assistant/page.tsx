import { Suspense } from "react";

import { AssistantSetupPage } from "@/modules/manage/assistant/AssistantSetupPage";

export default function ManageAssistantRoute() {
  // The tabs live in `?tab=`, which needs a Suspense boundary to render statically.
  return (
    <Suspense>
      <AssistantSetupPage />
    </Suspense>
  );
}
