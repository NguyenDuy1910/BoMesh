import { RequireModule } from "@/components/shell/RequireModule";
import { WorkItemPage } from "@/modules/work/components/WorkItemPage";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <RequireModule module="work">
      <WorkItemPage id={id} />
    </RequireModule>
  );
}
