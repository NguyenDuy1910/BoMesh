"use client";

import { ErrorState } from "@/components/ui/ErrorState";

export default function WorkspaceControlRouteError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <ErrorState
      actionLabel="Try again"
      description="Your navigation and workspace controls are still available."
      onAction={reset}
      title="This page could not be opened"
    />
  );
}
