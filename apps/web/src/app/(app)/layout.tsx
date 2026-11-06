import { Suspense, type ReactNode } from "react";

import { ShellSkeleton, WorkspaceShell } from "@/components/shell/ShellGate";

/** Workspace screens: signed in, with an active workspace, inside the app shell. */
export default function WorkspaceLayout({ children }: { children: ReactNode }) {
  return (
    <Suspense fallback={<ShellSkeleton />}>
      <WorkspaceShell>{children}</WorkspaceShell>
    </Suspense>
  );
}
