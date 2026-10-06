import { RequirePermission } from "@/components/shell/RequirePermission";
import { PlatformCapabilitiesPage } from "@/modules/platform/components/PlatformCapabilitiesPage";

export default function PlatformCapabilitiesPageRoute() {
  return (
    <RequirePermission platformAnyOf={["platform.tenant.read"]}>
      <PlatformCapabilitiesPage />
    </RequirePermission>
  );
}
