import { Suspense, type ReactNode } from "react";

import { PlatformShell, ShellSkeleton } from "@/components/shell/ShellGate";

/* Per request, not prerendered: see `src/app/(app)/layout.tsx` (vercel/next.js#92187, same-path query navigation). */
export const dynamic = "force-dynamic";

/** Platform console: platform operators and admins only, in the same shell with the platform sidebar. */
export default function PlatformLayout({ children }: { children: ReactNode }) {
  return (
    <Suspense fallback={<ShellSkeleton />}>
      <PlatformShell>{children}</PlatformShell>
    </Suspense>
  );
}
