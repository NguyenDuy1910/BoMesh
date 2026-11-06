"use client";

import type { ReactNode } from "react";

import { useWorkspace, type WorkspaceModule } from "@/lib/workspace";

import { ModuleOff } from "./ModuleOff";

/** Renders children only when the workspace has the module on; otherwise the module-off state. */
export function RequireModule({ module, children }: { module: WorkspaceModule; children: ReactNode }) {
  const { hasModule } = useWorkspace();
  return hasModule(module) ? <>{children}</> : <ModuleOff module={module} />;
}
