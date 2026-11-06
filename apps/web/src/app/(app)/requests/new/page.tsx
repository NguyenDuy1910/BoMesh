import { RequireModule } from "@/components/shell/RequireModule";
import { NewRequestPage } from "@/modules/requests/components/NewRequestPage";

export default function Page() {
  return (
    <RequireModule module="requests">
      <NewRequestPage />
    </RequireModule>
  );
}
