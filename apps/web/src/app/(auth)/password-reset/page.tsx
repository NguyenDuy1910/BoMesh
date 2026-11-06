import { Suspense } from "react";

import { PasswordResetRequestPage } from "@/modules/auth/components/PasswordResetPages";

export default function Page() {
  return (
    <Suspense>
      <PasswordResetRequestPage />
    </Suspense>
  );
}
