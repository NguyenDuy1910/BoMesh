import { RequireModule } from "@/components/shell/RequireModule";
import { SpacePage } from "@/modules/spaces/components/SpacePage";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <RequireModule module="spaces">
      <SpacePage spaceId={id} />
    </RequireModule>
  );
}
