"use client";

import { Button, Dropdown, Label } from "@heroui/react";
import { ChevronDown, Plus, Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import type { Key } from "react";

import { EmptyState, ItemIcon } from "@/components/ui";
import { useWorkspace } from "@/lib/workspace";

import { newWorkHref, type Workflow, type WorkflowId } from "../kinds";

/** Workflow cards (preview `flowCards`). */
export function FlowCards({ flows, onPick }: { flows: readonly Workflow[]; onPick: (id: WorkflowId) => void }) {
  return (
    <div className="work-flows">
      {flows.map((f) => (
        <button key={f.id} type="button" className="card card--action work-flow" onClick={() => onPick(f.id)}>
          <ItemIcon icon={f.icon} tone="accent" />
          <span className="work-flow__body">
            <span className="work-flow__title">{f.label}</span>
            <span className="work-flow__desc">{f.desc}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

/** First run: what each workflow makes (preview `firstRun`). */
export function FirstRun({ flows }: { flows: readonly Workflow[] }) {
  const router = useRouter();
  const { hasModule } = useWorkspace();
  if (!flows.length) {
    const spaces = hasModule("spaces");
    return (
      <EmptyState
        icon={Sparkles}
        title="Chưa có gì để tạo ở đây"
        description={spaces ? "Công việc bắt đầu từ tài liệu của cộng đồng. Hãy tham gia một khóa học, nhóm hoặc đội để bắt đầu." : "Hãy nhờ quản trị viên bật quy trình cho không gian làm việc này."}
        actions={
          spaces ? (
            <Button variant="primary" onPress={() => router.push("/spaces")}>
              Xem các cộng đồng
            </Button>
          ) : null
        }
        boxed
      />
    );
  }
  return (
    <>
      <div className="work-intro">
        <div className="t-heading">Biến tài liệu thành sản phẩm hoàn chỉnh</div>
        <p className="t-sm muted mt-4">Chọn nội dung bạn cần và tài liệu sử dụng. Mỗi phần đều trích dẫn trang nguồn.</p>
      </div>
      <FlowCards flows={flows} onPick={(workflow) => router.push(newWorkHref({ workflow }))} />
    </>
  );
}

/** New: one workflow is a direct button; several open the "New ▾" workflow menu (preview `newButton`). */
export function NewWorkMenu({ flows, space }: { flows: readonly Workflow[]; space?: string }) {
  const router = useRouter();
  const start = (workflow: WorkflowId) => router.push(newWorkHref({ workflow, space }));
  const only = flows.length === 1 ? flows[0] : null;
  if (only)
    return (
      <Button variant="primary" onPress={() => start(only.id)}>
        <only.icon className="i" aria-hidden />
        {only.label}
      </Button>
    );
  return (
    <Dropdown>
      <Button variant="primary">
        <Plus className="i" aria-hidden />
        Mới
        <ChevronDown className="i" aria-hidden />
      </Button>
      <Dropdown.Popover placement="bottom end">
        <Dropdown.Menu aria-label="Công việc mới" onAction={(key: Key) => start(String(key) as WorkflowId)}>
          {flows.map((f) => (
            <Dropdown.Item key={f.id} id={f.id} textValue={f.label}>
              <f.icon className="i" aria-hidden />
              <Label>{f.label}</Label>
            </Dropdown.Item>
          ))}
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
}
