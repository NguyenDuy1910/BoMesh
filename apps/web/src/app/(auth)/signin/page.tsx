import { Suspense } from "react";

import { SignInPage } from "@/modules/auth/components/SignInPage";

export default function Page() {
  return (
    <Suspense>
      <SignInPage />
    </Suspense>
  );
}
