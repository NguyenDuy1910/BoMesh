"use client";

import { Button, buttonVariants } from "@heroui/react";
import { ChevronDown, Plus, Sparkles } from "lucide-react";
import NextLink from "next/link";
import { useRouter } from "next/navigation";

import { EmptyState, Gate, List, Pager, SkeletonRows } from "@/components/ui";
import { useWorkspace } from "@/lib/workspace";
import { WorkItemRow, isSpaceStaff, newWorkHref, workflowsFor, type Workflow } from "@/modules/work";

import { useSpaceArtifactPages } from "../queries";
import type { SpaceView } from "./context";
import { Menu } from "./Menu";

const PAGE = 20;

/** Work (preview `workTab`): the same work row as /work, without the space's name. */
export function WorkTab({ view }: { view: SpaceView }) {
  const { settings } = useWorkspace();
  const router = useRouter();
  const works = useSpaceArtifactPages(view.sid, PAGE);
  const wf = workflowsFor(settings, view.space);
  const rows = works.data?.artifacts ?? [];
  const start = (w: Workflow) => newWorkHref({ workflow: w.id, space: view.sid });
  const menu = (flows: readonly Workflow[], label: string, variant: "tertiary" | "ghost") => (
    <Menu label={label} nodes={flows.map((w) => ({ id: w.id, label: w.label, icon: w.icon, run: () => router.push(start(w)) }))}>
      <Button variant={variant}>
        {label === "Mới" ? <Plus aria-hidden /> : null}
        {label}
        <ChevronDown aria-hidden />
      </Button>
    </Menu>
  );

  // The first two workflows as buttons (the first primary unless the header has New), the rest under More.
  const starts = (
    <>
      {wf.slice(0, 2).map((w, i) => (
        <NextLink key={w.id} href={start(w)} className={buttonVariants({ variant: i || view.newInHeader ? "tertiary" : "primary" })}>
          <w.icon aria-hidden />
          {w.label}
        </NextLink>
      ))}
      {wf.length > 2 ? menu(wf.slice(2), "Thêm", "ghost") : null}
    </>
  );
  const empty = (
    <EmptyState
      icon={Sparkles}
      boxed
      title="Chưa có công việc"
      description={
        view.staff
          ? "Những gì bạn tạo từ tài liệu của cộng đồng sẽ xuất hiện ở đây. Bản nháp ở chế độ riêng tư cho đến khi bạn chia sẻ hoặc gửi duyệt."
          : "Nội dung bạn tạo và công việc nhóm chia sẻ sẽ hiển thị tại đây."
      }
      actions={wf.length ? starts : null}
    />
  );

  // Where the header has no New (members, office staff), work starts here (preview `newWork(sp, 'tertiary')`).
  const only = wf.length === 1 ? wf[0] : null;
  const newBtn = only ? (
    <NextLink href={start(only)} className={buttonVariants({ variant: "tertiary" })}>
      <only.icon aria-hidden />
      {only.label}
    </NextLink>
  ) : (
    menu(wf, "Mới", "tertiary")
  );

  return (
    <>
      {!view.newInHeader && wf.length && rows.length ? (
        <div className="toolbar">
          <div className="toolbar__end">{newBtn}</div>
        </div>
      ) : null}
      <Gate query={works} skeleton={<SkeletonRows rows={4} />} isEmpty={!rows.length && works.page === 1} empty={empty}>
        <List className="work-list">
          {rows.map((a) => (
            <WorkItemRow key={a.name} artifact={a} from="space" staffQuiz={isSpaceStaff(view.space)} />
          ))}
        </List>
        {works.page > 1 || works.hasNext ? <Pager page={works.page} pageSize={PAGE} total={works.total} pageCount={rows.length} hasNext={works.hasNext} onPageChange={works.setPage} /> : null}
      </Gate>
    </>
  );
}
