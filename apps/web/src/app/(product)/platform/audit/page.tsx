import { RequirePermission } from "@/components/shell/RequirePermission";
import { PlatformAuditPage } from "@/modules/platform/components/PlatformAuditPage";

export default function PlatformAuditPageRoute() {
  return (
    <RequirePermission platformAnyOf={["platform.audit.read"]}>
      <PlatformAuditPage />
    </RequirePermission>
  );
}
