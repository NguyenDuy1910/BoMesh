import { Suspense } from "react";

import { SignUpPage } from "@/modules/auth/components/SignUpPage";

export default function Page() {
  return (
    <Suspense>
      <SignUpPage />
    </Suspense>
  );
}
