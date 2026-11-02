import { Page } from "@/components/shell/Page";
import { PageLoadingSkeleton } from "@/components/ui/Skeleton";

/** Shared by every product route; the sidebar around the sheet is already real. */
export default function ProductLoading() {
  return (
    <Page>
      <PageLoadingSkeleton controls heading label="Loading page" />
    </Page>
  );
}
