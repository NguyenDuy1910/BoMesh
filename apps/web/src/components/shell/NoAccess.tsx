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
        title="Bạn không có quyền truy cập trang này"
        description="Hãy hỏi quản trị viên không gian làm việc nếu bạn cần. Mọi thứ bạn có thể dùng đều ở thanh bên."
        actions={
          <>
            <Link href="/home" className={buttonVariants({ variant: "primary" })}>
              Về trang chủ
            </Link>
            <Link href="/knowledge" className={buttonVariants({ variant: "tertiary" })}>
              Tra cứu tài liệu
            </Link>
          </>
        }
      />
    </Page>
  );
}
