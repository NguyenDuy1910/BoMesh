"use client";

import { buttonVariants } from "@heroui/react";
import { Search } from "lucide-react";
import Link from "next/link";

import { EmptyState } from "@/components/ui/EmptyState";
import { Page } from "@/components/ui/Page";

/** An address that doesn't exist (preview `P.notFound`). */
export function NotFoundState() {
  return (
    <Page>
      <EmptyState
        icon={Search}
        title="This page doesn’t exist"
        description="The link may be old or mistyped."
        actions={
          <Link href="/home" className={buttonVariants({ variant: "primary" })}>
            Go home
          </Link>
        }
      />
    </Page>
  );
}
