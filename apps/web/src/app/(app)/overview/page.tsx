import { RequirePermission } from "@/components/shell/RequirePermission";
import { OverviewPage } from "@/modules/overview/components/OverviewPage";

export default function Page() {
  return (
    <RequirePermission permission="workspaces.getOverview">
      <OverviewPage />
    </RequirePermission>
  );
}
