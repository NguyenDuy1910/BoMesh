import { RequirePermission } from "@/components/shell/RequirePermission";
import { PeoplePage } from "@/modules/people/components/PeoplePage";

export default function Page() {
  return (
    <RequirePermission permission="members.create">
      <PeoplePage />
    </RequirePermission>
  );
}
