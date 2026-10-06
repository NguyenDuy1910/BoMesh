import { RequirePermission } from "@/components/shell/RequirePermission";
import { PlatformUsagePage } from "@/modules/platform/components/PlatformUsagePage";

export default function PlatformUsagePageRoute() {
  return (
    <RequirePermission platformAnyOf={["platform.tenant.read"]}>
      <PlatformUsagePage />
    </RequirePermission>
  );
}
