"use client";

import { Button, buttonVariants } from "@heroui/react";
import { ChevronDown, Plus, Sparkles } from "lucide-react";
import NextLink from "next/link";
import { useRouter } from "next/navigation";

import { EmptyState, Gate, List, SkeletonRows } from "@/components/ui";
import { useWorkspace } from "@/lib/workspace";
import { WorkItemRow, isSpaceStaff, newWorkHref, workflowsFor, type Workflow } from "@/modules/work";

import { useSpaceArtifacts } from "../queries";
import type { SpaceView } from "./context";
import { Menu } from "./Menu";

/** Work (preview `workTab`): the same work row as /work, without the space's name. */
export function WorkTab({ view }: { view: SpaceView }) {
  const { settings } = useWorkspace();
  const router = useRouter();
  const works = useSpaceArtifacts(view.sid);
  const wf = workflowsFor(settings, view.space);
  const rows = (works.data ?? []).filter((a) => a.kind !== "FILE" && a.state !== "DELETED");
  const start = (w: Workflow) => newWorkHref({ workflow: w.id, space: view.sid });
  const menu = (flows: readonly Workflow[], label: string, variant: "tertiary" | "ghost") => (
    <Menu label={label} nodes={flows.map((w) => ({ id: w.id, label: w.label, icon: w.icon, run: () => router.push(start(w)) }))}>
      <Button variant={variant}>
        {label === "New" ? <Plus aria-hidden /> : null}
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
      {wf.length > 2 ? menu(wf.slice(2), "More", "ghost") : null}
    </>
  );
  const empty = (
    <EmptyState
      icon={Sparkles}
      boxed
      title="No work here yet"
      description={
        view.staff
          ? "What you make from this space’s materials shows up here. Drafts stay private until you share or send them for review."
          : "Things you make here, and work the team shares, show up here."
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
    menu(wf, "New", "tertiary")
  );

  return (
    <>
      {!view.newInHeader && wf.length && rows.length ? (
        <div className="toolbar">
          <div className="toolbar__end">{newBtn}</div>
        </div>
      ) : null}
      <Gate query={works} skeleton={<SkeletonRows rows={4} />} isEmpty={!rows.length} empty={empty}>
        <List className="work-list">
          {rows.map((a) => (
            <WorkItemRow key={a.name} artifact={a} from="space" staffQuiz={isSpaceStaff(view.space)} />
          ))}
        </List>
      </Gate>
    </>
  );
}
