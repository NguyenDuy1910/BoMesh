import { RequireModule } from "@/components/shell/RequireModule";
import { NewWorkPage } from "@/modules/work/components/NewWorkPage";

export default function Page() {
  return (
    <RequireModule module="work">
      <NewWorkPage />
    </RequireModule>
  );
}
