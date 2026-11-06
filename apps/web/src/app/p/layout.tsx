import { Suspense, type ReactNode } from "react";

import { PlatformShell, ShellSkeleton } from "@/components/shell/ShellGate";

/** Platform console: platform operators and admins only, in the same shell with the platform sidebar. */
export default function PlatformLayout({ children }: { children: ReactNode }) {
  return (
    <Suspense fallback={<ShellSkeleton />}>
      <PlatformShell>{children}</PlatformShell>
    </Suspense>
  );
}
