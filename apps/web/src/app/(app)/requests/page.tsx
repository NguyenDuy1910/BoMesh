import { RequireModule } from "@/components/shell/RequireModule";
import { RequestsPage } from "@/modules/requests/components/RequestsPage";

export default function Page() {
  return (
    <RequireModule module="requests">
      <RequestsPage />
    </RequireModule>
  );
}
