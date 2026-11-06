"use client";

import { Button, buttonVariants } from "@heroui/react";
import { ChevronDown, Plus, Sparkles } from "lucide-react";
import NextLink from "next/link";
import { useRouter } from "next/navigation";

import { EmptyState, Gate, List, SkeletonRows } from "@/components/ui";
import { plural } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";
import { WorkItemRow } from "@/modules/work";
import { newWorkHref, workflowsFor } from "@/modules/work/kinds";

import { useSpaceArtifacts } from "../queries";
import type { SpaceView } from "./context";
import { Menu } from "./Menu";

/** Work (preview `workTab`): reviews, drafts, guides and quizzes made in this space. */
export function WorkTab({ view }: { view: SpaceView }) {
  const { settings } = useWorkspace();
  const router = useRouter();
  const works = useSpaceArtifacts(view.sid);
  const wf = workflowsFor(settings, view.space);
  const FirstIcon = wf[0]?.icon;
  const rows = (works.data ?? []).filter((a) => a.kind !== "FILE" && a.state !== "DELETED");

  const empty = (
    <EmptyState
      icon={Sparkles}
      boxed
      title="No work here yet"
      description={
        view.staff
          ? "Quizzes, guides, reviews and drafts made in this space show up here. Drafts stay private until you publish them."
          : "Things you make here, and work the team shares, show up here."
      }
      actions={
        wf[0] ? (
          <NextLink href={newWorkHref({ workflow: wf[0].id, space: view.sid })} className={buttonVariants({ variant: "primary" })}>
            {FirstIcon ? <FirstIcon aria-hidden /> : null}
            {wf[0].label}
          </NextLink>
        ) : null
      }
    />
  );

  return (
    <>
      {rows.length ? (
        <div className="toolbar">
          <span className="t-sm muted">{plural(rows.length, "item")}</span>
          <div className="toolbar__end">
            {wf.length ? (
              <Menu label="New work" nodes={wf.map((w) => ({ id: w.id, label: w.label, icon: w.icon, run: () => router.push(newWorkHref({ workflow: w.id, space: view.sid })) }))}>
                <Button variant="tertiary">
                  <Plus aria-hidden />
                  New
                  <ChevronDown aria-hidden />
                </Button>
              </Menu>
            ) : null}
          </div>
        </div>
      ) : null}
      <Gate query={works} skeleton={<SkeletonRows rows={4} />} isEmpty={!rows.length} empty={empty}>
        <List>
          {rows.map((a) => (
            <WorkItemRow key={a.name} artifact={a} from="space" />
          ))}
        </List>
      </Gate>
    </>
  );
}
