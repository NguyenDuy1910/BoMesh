import { ShareLandingPage } from "@/modules/shares/components/ShareLandingPage";

/** `/s/{token}`: a share (its ID) or an invite (its secret token); works signed out. */
export default async function Page({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <ShareLandingPage token={decodeURIComponent(token)} />;
}
