import { RequirePermission } from "@/components/shell/RequirePermission";
import { AssistantPage } from "@/modules/assistant-settings/components/AssistantPage";

export default function Page() {
  return (
    <RequirePermission permission="workspaces.updateAssistant">
      <AssistantPage />
    </RequirePermission>
  );
}
