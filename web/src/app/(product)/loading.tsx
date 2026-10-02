import { PageLoadingSkeleton } from "@/components/ui/Skeleton";

/** Shared by every product route; the rail around it is already real. */
export default function ProductLoading() {
  return (
    <PageLoadingSkeleton
      className="mx-auto w-full max-w-3xl px-[var(--page-gutter)] pt-[var(--space-5)]"
      controls
      heading
      label="Loading page"
    />
  );
}
