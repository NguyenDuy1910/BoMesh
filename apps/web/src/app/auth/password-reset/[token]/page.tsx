import { notFound } from "next/navigation";

import { isPendingFeatureEnabled } from "@/lib/api/pending";
import { PasswordResetComplete } from "@/modules/auth/components/PasswordResetComplete";

/** The link a reset email opens. API pending (`auth.password_reset`). */
export default async function PasswordResetTokenPage({ params }: { params: Promise<{ token: string }> }) {
  if (!isPendingFeatureEnabled("auth.password_reset")) notFound();
  const { token } = await params;
  return <PasswordResetComplete token={token} />;
}
