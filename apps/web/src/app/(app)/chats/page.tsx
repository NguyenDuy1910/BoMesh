import { Suspense } from "react";

import { ChatsPage } from "@/modules/projects/components/ChatsPage";

export default function Page() {
  return (
    <Suspense>
      <ChatsPage />
    </Suspense>
  );
}
