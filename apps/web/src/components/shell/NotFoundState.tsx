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
        title="Trang này không tồn tại"
        description="Liên kết có thể đã cũ hoặc bị nhập sai."
        actions={
          <Link href="/home" className={buttonVariants({ variant: "primary" })}>
            Về trang chủ
          </Link>
        }
      />
    </Page>
  );
}
