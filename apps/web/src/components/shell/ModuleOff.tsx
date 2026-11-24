"use client";

import { buttonVariants } from "@heroui/react";
import { Layers, Sparkles } from "lucide-react";
import Link from "next/link";

import { EmptyState } from "@/components/ui/EmptyState";
import { Page } from "@/components/ui/Page";
import { useWorkspace, type WorkspaceModule } from "@/lib/workspace";

/** Optional workspace modules. Home, Knowledge, Inbox and Conversations are core. */
export const MODULES: Record<WorkspaceModule, { label: string; description: string }> = {
  spaces: { label: "Cộng đồng", description: "Tổ chức mọi người, tài liệu và công việc theo nhóm, dự án, văn phòng hoặc khóa học." },
  work: { label: "Công việc", description: "Quy trình AI tạo bản tổng hợp, bản nháp, tài liệu ôn tập và bài kiểm tra." },
  requests: { label: "Yêu cầu", description: "Mọi người gửi yêu cầu đến nhóm dịch vụ và văn phòng; nhân viên xử lý theo hàng đợi." },
};

/** A route whose module this workspace hasn't turned on (preview `moduleOffPage`). */
export function ModuleOff({ module }: { module: WorkspaceModule }) {
  const { workspace, can } = useWorkspace();
  const admin = can("workspaces.updateSettings");
  const m = MODULES[module];
  return (
    <Page>
      <EmptyState
        icon={Layers}
        title={`${m.label} chưa được bật trong ${workspace.displayName}`}
        description={`${m.description}${admin ? "Bạn có thể bật trong Cài đặt → Thiết lập không gian làm việc." : "Hãy hỏi quản trị viên không gian làm việc nếu nhóm bạn cần."}`}
        actions={
          <>
            {admin && (
              <Link href="/settings?tab=setup" className={buttonVariants({ variant: "primary" })}>
                Mở thiết lập không gian làm việc
              </Link>
            )}
            <Link href="/home" className={buttonVariants({ variant: "tertiary" })}>
              Về trang chủ
            </Link>
          </>
        }
      />
    </Page>
  );
}

/** A module held back for a later phase (`lib/modules` LATER_PHASE_MODULES; preview `comingSoonPage`): what it will do. */
export function ComingSoon({ module }: { module: WorkspaceModule }) {
  const m = MODULES[module];
  return (
    <Page>
      <EmptyState
        icon={Sparkles}
        title={`${m.label} sắp ra mắt`}
        description={`${m.description} Tính năng này sẽ có trong bản cập nhật tới.`}
        actions={
          <Link href="/home" className={buttonVariants({ variant: "primary" })}>
            Về trang chủ
          </Link>
        }
      />
    </Page>
  );
}
