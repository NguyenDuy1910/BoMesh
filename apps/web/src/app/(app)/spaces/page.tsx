import { RequireModule } from "@/components/shell/RequireModule";
import { SpacesPage } from "@/modules/spaces/components/SpacesPage";

export default function Page() {
  return (
    <RequireModule module="spaces">
      <SpacesPage />
    </RequireModule>
  );
}
