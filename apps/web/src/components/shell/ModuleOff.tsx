"use client";

import { buttonVariants } from "@heroui/react";
import { Layers } from "lucide-react";
import Link from "next/link";

import { EmptyState } from "@/components/ui/EmptyState";
import { Page } from "@/components/ui/Page";
import { useWorkspace, type WorkspaceModule } from "@/lib/workspace";

/** Optional workspace modules. Home, Knowledge, Inbox and Conversations are core. */
export const MODULES: Record<WorkspaceModule, { label: string; description: string }> = {
  spaces: { label: "Spaces", description: "Organise people, materials and work by team, project, office or course." },
  work: { label: "Work", description: "AI workflows that produce reviews, drafts, study guides and quizzes." },
  requests: { label: "Requests", description: "People send requests to service teams and offices; staff work a queue." },
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
        title={
          <>
            {m.label} isn’t on in <span translate="no">{workspace.displayName}</span>
          </>
        }
        description={`${m.description}${admin ? " You can turn it on in Settings → Workspace setup." : " Ask a workspace admin if your team needs it."}`}
        actions={
          <>
            {admin && (
              <Link href="/settings?tab=setup" className={buttonVariants({ variant: "primary" })}>
                Open workspace setup
              </Link>
            )}
            <Link href="/home" className={buttonVariants({ variant: "tertiary" })}>
              Go home
            </Link>
          </>
        }
      />
    </Page>
  );
}
