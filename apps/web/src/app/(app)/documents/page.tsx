import { RequirePermission } from "@/components/shell/RequirePermission";
import { DocumentsPage } from "@/modules/curation/components/DocumentsPage";

export default function Page() {
  return (
    <RequirePermission permission="contributions.review">
      <DocumentsPage />
    </RequirePermission>
  );
}
