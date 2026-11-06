"use client";

import { Button } from "@heroui/react";
import { Upload } from "lucide-react";
import type { ReactNode } from "react";

import { PageHeader } from "@/components/ui/PageHeader";
import { SectionTabs } from "@/components/ui/SectionTabs";
import { StatusChip } from "@/components/ui/StatusChip";
import { useWorkspace } from "@/lib/workspace";

import { openContribute } from "./Contribute";

const HUB_TABS = [
  { id: "browse", label: "Browse", href: "/knowledge" },
  { id: "library", label: "My library", href: "/knowledge/library" },
  { id: "bases", label: "Knowledge bases", href: "/knowledge/bases" },
] as const;

export type KnowledgeSection = (typeof HUB_TABS)[number]["id"];

/**
 * Knowledge entry point (preview `X.res.uploadBtn`): Contribute (review before publishing) for
 * contributors; otherwise Upload to My files; nothing when neither is possible.
 */
export function ContributeButton({ variant = "secondary" }: { variant?: "primary" | "secondary" | "tertiary" }) {
  const { can, member } = useWorkspace();
  if (can("contributions.create")) {
    return (
      <Button variant={variant} onPress={() => openContribute()}>
        <Upload className="i" aria-hidden />
        Contribute
      </Button>
    );
  }
  if (!member.personalCollection) return null;
  return (
    <Button variant={variant} onPress={() => openContribute({ mode: "private" })}>
      <Upload className="i" aria-hidden />
      Upload
    </Button>
  );
}

export interface KnowledgeHeaderProps {
  /** The active section tab. */
  active: KnowledgeSection;
  /** Page actions; defaults to the Contribute button. Pass `null` for none. */
  actions?: ReactNode;
  description?: ReactNode;
}

/** Knowledge area header (preview `X.res.hubHeader`): title, demo marker, Browse · My library · Knowledge bases. */
export function KnowledgeHeader({ active, actions, description }: KnowledgeHeaderProps) {
  const { workspace } = useWorkspace();
  return (
    <>
      <PageHeader
        title="Knowledge"
        description={description}
        chips={workspace.demo ? <StatusChip label="Demo data" tone="default" dot={false} size="sm" tooltip="This workspace holds fictional demo content." /> : null}
        actions={actions === undefined ? <ContributeButton /> : actions}
      />
      <div className="hub-nav">
        <SectionTabs className="hub-tabs" variant="primary" items={HUB_TABS} active={active} label="Knowledge sections" />
      </div>
    </>
  );
}
