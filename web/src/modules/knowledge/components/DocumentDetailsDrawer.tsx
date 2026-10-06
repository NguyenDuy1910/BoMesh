"use client";

import { AlertCircle, AlertTriangle, Archive, CheckCircle2, Clock, ExternalLink, Info, Loader2, MoreHorizontal, RotateCw } from "lucide-react";
import Link from "next/link";

import { Button, ButtonLink } from "@/components/ui/Button";
import { Drawer, DrawerSection } from "@/components/ui/Drawer";
import { Menu, MenuItem } from "@/components/ui/Menu";
import { PreviewTag } from "@/components/ui/PreviewTag";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { cn } from "@/lib/cn";
import { FileTypeIcon, fileTypeOf } from "@/modules/knowledge/components/FileTypeIcon";
import type { Collection, ContractDocument } from "@/modules/knowledge/knowledge-api";
import type { AccessSummary } from "@/modules/knowledge/model";
import { formatBytes, formatDateTime } from "@/lib/format";

import { AccessBadge } from "./KnowledgeBaseMark";

function Line({ icon, tone, children }: { icon: React.ReactNode; tone?: "ok" | "warn" | "err" | "info"; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 text-[13.5px] text-[var(--text-primary)]">
      <span
        aria-hidden="true"
        className={cn(
          "mt-0.5 inline-flex shrink-0 [&_svg]:size-4",
          tone === "ok" && "text-[var(--status-success-text)]",
          tone === "warn" && "text-[var(--status-warning-text)]",
          tone === "err" && "text-[var(--status-danger-text)]",
          tone === "info" && "text-[var(--status-info-text)]",
          !tone && "text-[var(--text-tertiary)]",
        )}
      >
        {icon}
      </span>
      <span>{children}</span>
    </div>
  );
}

/** What processing means for this document right now, in one line. */
function ProcessingLine({ document }: { document: ContractDocument }) {
  switch (document.processing.state) {
    case "ready":
      return <Line icon={<CheckCircle2 />} tone="ok">Searchable. The assistant can answer from it.</Line>;
    case "processing":
      return <Line icon={<Loader2 className="motion-safe:animate-spin" />} tone="info">Processing. It’ll be searchable in a few minutes.</Line>;
    case "pending":
      return <Line icon={<Clock />}>Waiting to be processed.</Line>;
    case "outdated":
      return <Line icon={<AlertTriangle />} tone="warn">The way documents are read has changed. Reprocess it to bring it up to date.</Line>;
    case "failed":
      return <Line icon={<AlertCircle />} tone="err">{document.processing.error || "This file couldn’t be read."}</Line>;
    default:
      return <Line icon={<Info />}>This file type can’t be searched. It’s kept here but not used in answers.</Line>;
  }
}

/**
 * Everything about one document that is not its content: where it lives,
 * its size and dates, whether answers can use it, and who can see it.
 * Opening the document itself is a page of its own (`/documents/<id>`).
 */
export function DocumentDetailsDrawer({
  document,
  collection,
  collectionTitle,
  access,
  localAccess,
  movedHere,
  canEdit,
  canRun,
  canShare,
  onClose,
  onReprocess,
  onArchive,
}: {
  document: ContractDocument | null;
  collection: Pick<Collection, "id">;
  collectionTitle: string;
  access: AccessSummary;
  localAccess: boolean;
  movedHere: boolean;
  canEdit: boolean;
  canRun: boolean;
  canShare: boolean;
  onClose: () => void;
  onReprocess: (document: ContractDocument) => void;
  onArchive: (document: ContractDocument) => void;
}) {
  if (!document) return null;
  const type = fileTypeOf(document.content_type, document.name);
  const state = document.processing.state;
  const runnable = canRun && state !== "unsupported" && state !== "processing";
  const facts: [string, React.ReactNode][] = [
    ["Knowledge base", <Link className="text-[var(--text-accent)] hover:underline" href={`/knowledge/${encodeURIComponent(collection.id)}`} key="kb">{collectionTitle}</Link>],
    ["Type", type.label],
    ["Size", formatBytes(document.size_bytes)],
    ...(document.created_at ? [["Added", formatDateTime(document.created_at)] as [string, React.ReactNode]] : []),
    ["Updated", formatDateTime(document.updated_at)],
  ];

  return (
    <Drawer
      footer={(
        <>
          {canEdit && (
            <Menu
              align="start"
              className="mr-auto"
              trigger={(props) => (
                <Button {...props} aria-label="More actions" icon={<MoreHorizontal size={16} />} iconOnly variant="ghost" />
              )}
            >
              <MenuItem danger icon={<Archive />} onSelect={() => onArchive(document)}>Archive</MenuItem>
            </Menu>
          )}
          <ButtonLink href={`/documents/${encodeURIComponent(document.id)}`} icon={<ExternalLink aria-hidden="true" size={16} />}>
            Open document
          </ButtonLink>
          {runnable && state !== "ready" && (
            <Button icon={<RotateCw aria-hidden="true" size={16} />} onClick={() => onReprocess(document)} variant="primary">
              {state === "failed" ? "Retry" : state === "pending" ? "Process now" : "Reprocess"}
            </Button>
          )}
        </>
      )}
      header={(
        <div className="mt-1.5 flex items-center gap-2">
          <StatusBadge kind="doc" value={state} />
          {movedHere && <PreviewTag />}
        </div>
      )}
      icon={<FileTypeIcon kind={type.kind} label={type.label} size="lg" />}
      onClose={onClose}
      open
      title={<span className="break-words">{document.name}</span>}
    >
      <DrawerSection title="Details">
        <dl className="grid grid-cols-[minmax(110px,auto)_1fr] gap-x-4 gap-y-2 text-[13.5px]">
          {facts.map(([label, value]) => (
            <div className="contents" key={label}>
              <dt className="text-[var(--text-tertiary)]">{label}</dt>
              <dd className="min-w-0 break-words text-[var(--text-primary)]">{value}</dd>
            </div>
          ))}
        </dl>
      </DrawerSection>
      <DrawerSection title="Processing">
        <ProcessingLine document={document} />
        {document.processing.run_id && (
          <Link
            className="mt-2 inline-block text-[length:var(--text-size-meta)] text-[var(--text-accent)] hover:underline"
            href={`/manage/sources?run=${encodeURIComponent(document.processing.run_id)}`}
          >
            Open in sync history
          </Link>
        )}
      </DrawerSection>
      <DrawerSection title="Who can see this">
        <div className="grid gap-2">
          <AccessBadge access={access} local={localAccess} sentence />
          {canShare && access.key !== "me" && (
            <Link
              className="text-[length:var(--text-size-meta)] text-[var(--text-accent)] hover:underline"
              href={`/knowledge/${encodeURIComponent(collection.id)}?tab=access`}
              onClick={onClose}
            >
              Manage access
            </Link>
          )}
        </div>
      </DrawerSection>
    </Drawer>
  );
}
