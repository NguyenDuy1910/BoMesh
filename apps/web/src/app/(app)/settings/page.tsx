import { RequirePermission } from "@/components/shell/RequirePermission";
import { SettingsPage } from "@/modules/workspace-settings/components/SettingsPage";

export default function Page() {
  return (
    <RequirePermission permission="workspaces.updateSettings">
      <SettingsPage />
    </RequirePermission>
  );
}
