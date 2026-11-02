"use client";

import { Page } from "@/components/shell/Page";
import { ErrorState } from "@/components/ui/ErrorState";

/** A page that failed to render; the sidebar around the sheet stays usable. */
export default function ProductRouteError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <Page width="narrow">
      <ErrorState
        actionLabel="Try again"
        description="The rest of your workspace is still available."
        onAction={reset}
        title="This page could not be opened"
      />
    </Page>
  );
}
