import { RequirePermission } from "@/components/shell/RequirePermission";
import { ActivityPage } from "@/modules/activity/components/ActivityPage";

export default function Page() {
  return (
    <RequirePermission permission="auditEvents.list">
      <ActivityPage />
    </RequirePermission>
  );
}
