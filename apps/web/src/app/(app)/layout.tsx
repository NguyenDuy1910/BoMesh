import { Suspense, type ReactNode } from "react";

import { ShellSkeleton, WorkspaceShell } from "@/components/shell/ShellGate";

/* Rendered per request, not prerendered. Next 16.2 (vercel/next.js#92187): on a prerendered page loaded with a query
   (e.g. /people?tab=groups), router.push/replace to the same path with a different query is dropped — no drawer, no
   section switch. Dynamic routes don't hit it; the screens are client-rendered, so nothing is lost. */
export const dynamic = "force-dynamic";

/** Workspace screens: signed in, with an active workspace, inside the app shell. */
export default function WorkspaceLayout({ children }: { children: ReactNode }) {
  return (
    <Suspense fallback={<ShellSkeleton />}>
      <WorkspaceShell>{children}</WorkspaceShell>
    </Suspense>
  );
}
