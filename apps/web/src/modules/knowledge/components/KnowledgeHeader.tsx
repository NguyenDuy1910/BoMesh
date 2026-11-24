"use client";

import { Button } from "@heroui/react";
import { Upload } from "lucide-react";
import type { ReactNode } from "react";

import { PageHeader } from "@/components/ui/PageHeader";
import { StatusChip } from "@/components/ui/StatusChip";
import { useMessages } from "@/lib/i18n";
import { librarySections, sectionTitle } from "@/lib/navigation";
import { useWorkspace } from "@/lib/workspace";

import { openContribute } from "./contribute-store";

/** A Knowledge personal section id (Foundation's `librarySections`): saved · files. */
export type LibrarySection = "saved" | "files";

/** The personal sections this member has: My files only with a personal collection. */
export function useLibrarySections() {
  const { member } = useWorkspace();
  return librarySections.filter((s) => s.id !== "files" || !!member.personalCollection);
}

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
        Gửi tài liệu
      </Button>
    );
  }
  if (!member.personalCollection) return null;
  return (
    <Button variant={variant} onPress={() => openContribute({ mode: "private" })}>
      <Upload className="i" aria-hidden />
      Tải lên
    </Button>
  );
}

/** The fictional-data marker for demo workspaces (preview `X.res.demoChip`). */
export function DemoChip() {
  const { workspace } = useWorkspace();
  if (!workspace.demo) return null;
  return <StatusChip label="Dữ liệu mẫu" tone="default" dot={false} size="sm" tooltip="Không gian làm việc này chứa nội dung minh họa hư cấu." />;
}

export interface KnowledgeHeaderProps {
  /** Browse (titled Knowledge) or a personal section (titled by its name). */
  section?: "browse" | LibrarySection;
  /** Top-row actions; defaults to the Contribute button. Pass `null` for none. */
  actions?: ReactNode;
  /** Short dynamic status for the top row. */
  meta?: ReactNode;
}

/**
 * Knowledge top-row header (preview `X.res.hubHeader`): Browse is titled Knowledge, a library
 * section by its name; the Demo data chip marks demo workspaces. No tab bar: the sections are
 * sidebar sub-rows.
 */
export function KnowledgeHeader({ section = "browse", actions, meta }: KnowledgeHeaderProps) {
  const m = useMessages();
  const title = section === "browse" ? m.nav.knowledge : sectionTitle(librarySections, section, m);
  return <PageHeader title={title} chips={<DemoChip />} meta={meta} actions={actions === undefined ? <ContributeButton /> : actions} />;
}
