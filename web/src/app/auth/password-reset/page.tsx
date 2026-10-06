import { notFound } from "next/navigation";

import { isPendingFeatureEnabled } from "@/lib/api/pending";
import { PasswordResetRequest } from "@/modules/auth/components/PasswordResetRequest";

/** API pending (`auth.password_reset`): the route exists only while the feature is switched on. */
export default function PasswordResetPage() {
  if (!isPendingFeatureEnabled("auth.password_reset")) notFound();
  return <PasswordResetRequest />;
}
