"use client";

import { PageHeader } from "@/components/ui/PageHeader";
import { findRoute } from "@/modules/workspace-control/navigation";

/**
 * The top of every workspace-control and platform-control page.
 *
 * Title and purpose come from the section registry that also builds the rail,
 * so a page can never be named differently from the item that opened it. The
 * page supplies only what the registry cannot know: its primary action, and —
 * where live state says more than the static purpose line (Knowledge's
 * document and source counts) — a replacement description.
 */
export function SectionHeader({
  section,
  description,
  actions,
  className,
}: {
  /** Section id from the registry, e.g. "access" or "platform-users". */
  section: string;
  description?: React.ReactNode;
  /** At most one primary action; secondary actions belong in a menu. */
  actions?: React.ReactNode;
  className?: string;
}) {
  const route = findRoute(section);
  if (!route) throw new Error(`Unknown control-plane section "${section}".`);
  return (
    <PageHeader
      actions={actions}
      className={className}
      description={description ?? route.description}
      title={route.label}
    />
  );
}
