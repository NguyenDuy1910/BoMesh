import { RequirePermission } from "@/components/shell/RequirePermission";
import { ConnectionsPage } from "@/modules/ingestion/components/ConnectionsPage";

export default function Page() {
  return (
    <RequirePermission permission="sources.list">
      <ConnectionsPage />
    </RequirePermission>
  );
}
