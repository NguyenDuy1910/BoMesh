import { RequirePermission } from "@/components/shell/RequirePermission";
import { PlatformHealthPage } from "@/modules/platform/components/PlatformHealthPage";

export default function PlatformHealthPageRoute() {
  return (
    <RequirePermission platformAnyOf={["platform.health.read"]}>
      <PlatformHealthPage />
    </RequirePermission>
  );
}
