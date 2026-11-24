import { JoinWorkspacePage } from "@/modules/auth/components/JoinWorkspacePage";

/** `/w/{code}`: a public workspace's join link; works signed out (Sign in or Create account, then back here). */
export default async function Page({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  return <JoinWorkspacePage code={decodeURIComponent(code)} />;
}
