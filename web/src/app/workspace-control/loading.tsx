import { PageLoadingSkeleton } from "@/components/ui/Skeleton";

/** Renders inside the control-plane shell: rail and page gutter are already real. */
export default function ControlPlaneLoading() {
  return <PageLoadingSkeleton controls heading label="Loading workspace control" />;
}
