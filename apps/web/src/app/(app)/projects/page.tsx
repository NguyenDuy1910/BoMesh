import { Suspense } from "react";

import { ProjectsPage } from "@/modules/projects/components/ProjectsPage";

export default function Page() {
  return (
    <Suspense>
      <ProjectsPage />
    </Suspense>
  );
}
