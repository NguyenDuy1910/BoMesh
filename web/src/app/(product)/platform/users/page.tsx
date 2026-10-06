import { RequirePermission } from "@/components/shell/RequirePermission";
import { PlatformUsersPage } from "@/modules/platform/components/PlatformUsersPage";

export default function PlatformUsersPageRoute() {
  return (
    <RequirePermission platformAnyOf={["platform.user.read"]}>
      <PlatformUsersPage />
    </RequirePermission>
  );
}
