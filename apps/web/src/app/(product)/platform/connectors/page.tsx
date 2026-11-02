import { RequirePermission } from "@/components/shell/RequirePermission";
import { PlatformConnectorsPage } from "@/modules/platform/components/PlatformConnectorsPage";

export default function PlatformConnectorsPageRoute() {
  return (
    <RequirePermission platformAnyOf={["platform.tenant.read"]}>
      <PlatformConnectorsPage />
    </RequirePermission>
  );
}
