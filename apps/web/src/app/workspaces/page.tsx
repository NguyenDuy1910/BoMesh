import { WorkspacePicker } from "@/modules/auth/components/WorkspacePicker";

/** Outside the product shell: choosing a workspace comes before the sidebar exists. */
export default function WorkspacesPage() {
  return <WorkspacePicker />;
}
