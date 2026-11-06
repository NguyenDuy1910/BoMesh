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
        title="Nothing to make here yet"
        description={spaces ? "Work starts from a space’s materials. Join a course, group or team to begin." : "Ask an admin to turn on workflows for this workspace."}
        actions={
          spaces ? (
            <Button variant="primary" onPress={() => router.push("/spaces")}>
              Browse spaces
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
        <div className="t-heading">Turn your materials into finished work</div>
        <p className="t-sm muted mt-4">Pick what you need and the documents to use. Every part cites the page it came from.</p>
      </div>
      <FlowCards flows={flows} onPick={(workflow) => router.push(newWorkHref({ workflow }))} />
    </>
  );
}

/** "New ▾" — the workflow menu (preview `MENUS['work-new']`). */
export function NewWorkMenu({ flows, space }: { flows: readonly Workflow[]; space?: string }) {
  const router = useRouter();
  const onAction = (key: Key) => router.push(newWorkHref({ workflow: String(key) as WorkflowId, space }));
  return (
    <Dropdown>
      <Button variant="primary">
        <Plus className="i" aria-hidden />
        New
        <ChevronDown className="i" aria-hidden />
      </Button>
      <Dropdown.Popover placement="bottom end">
        <Dropdown.Menu aria-label="New work" onAction={onAction}>
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
