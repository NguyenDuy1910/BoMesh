import { PasswordResetCompletePage } from "@/modules/auth/components/PasswordResetPages";

export default async function Page({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <PasswordResetCompletePage token={decodeURIComponent(token)} />;
}
