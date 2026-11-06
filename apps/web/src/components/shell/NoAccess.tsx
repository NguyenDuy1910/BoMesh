"use client";

import { buttonVariants } from "@heroui/react";
import { Lock } from "lucide-react";
import Link from "next/link";

import { EmptyState } from "@/components/ui/EmptyState";
import { Page } from "@/components/ui/Page";

/** A screen the caller may not open (preview `noAccessPage`, also used for the platform console). Renders no data. */
export function NoAccess() {
  return (
    <Page>
      <EmptyState
        icon={Lock}
        title="You don’t have access to this page"
        description="Ask a workspace admin if you need it. Everything you can use is in the sidebar."
        actions={
          <>
            <Link href="/home" className={buttonVariants({ variant: "primary" })}>
              Go home
            </Link>
            <Link href="/knowledge" className={buttonVariants({ variant: "tertiary" })}>
              Browse knowledge
            </Link>
          </>
        }
      />
    </Page>
  );
}
