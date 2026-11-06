import { RequireModule } from "@/components/shell/RequireModule";
import { WorkListPage } from "@/modules/work/components/WorkListPage";

export default function Page() {
  return (
    <RequireModule module="work">
      <WorkListPage />
    </RequireModule>
  );
}
