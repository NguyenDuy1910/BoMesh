import { RequireModule } from "@/components/shell/RequireModule";
import { RequestDetailPage } from "@/modules/requests/components/RequestDetailPage";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <RequireModule module="requests">
      <RequestDetailPage key={id} requestId={id} />
    </RequireModule>
  );
}
