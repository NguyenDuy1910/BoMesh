import { RequirePermission } from "@/components/shell/RequirePermission";
import { SourcesPage } from "@/modules/ingestion/components/SourcesPage";

export default function Page() {
  return (
    <RequirePermission permission="sources.list">
      <SourcesPage />
    </RequirePermission>
  );
}
