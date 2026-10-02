"use client";

import { ErrorState } from "@/components/ui/ErrorState";

/* Product routes (chat, library) are full-bleed, so the boundary supplies the
   page gutter itself. */
export default function ProductRouteError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="mx-auto w-full max-w-[var(--chat-max)] px-[var(--page-gutter)] pt-[var(--space-8)]">
      <ErrorState
        actionLabel="Try again"
        description="The rest of your workspace is still available."
        onAction={reset}
        title="This page could not be opened"
      />
    </div>
  );
}
