"use client";

import { ArrowRight } from "lucide-react";

import { ButtonLink } from "@/components/ui/Button";
import { Drawer, DrawerSection } from "@/components/ui/Drawer";
import { ui } from "@/components/ui/design-system";
import { EmptyState } from "@/components/ui/EmptyState";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { outcomeStatusKey } from "@/lib/status";
import { cn } from "@/lib/cn";
import type { AuditEvent } from "@/modules/manage/access/directory";
import { ActorAvatar } from "@/modules/manage/activity/Actor";
import {
  AUDIT_AREAS,
  auditActionArea,
  auditActorName,
  describeAuditAction,
  describeAuditTarget,
} from "@/modules/manage/activity/audit-actions";
import { formatDateTime, formatRelative } from "@/lib/format";

/** Where the thing an event changed can be opened now, when it still exists. */
function relatedLink(event: AuditEvent): { label: string; href: string } | null {
  const action = event.action.toLowerCase();
  const id = event.resource_id ? encodeURIComponent(event.resource_id) : null;
  if (action === "tenant.updated") return { label: "Open workspace settings", href: "/manage/settings" };
  if (!id || action.endsWith(".deleted")) return null;
  if (action.startsWith("collection.")) return { label: "Open knowledge base", href: `/knowledge/${id}` };
  if (action.startsWith("document.")) return { label: "Open document", href: `/documents/${id}` };
  if (action.startsWith("ingestion.source.")) return { label: "Open source", href: `/manage/sources?source=${id}` };
  if (action.startsWith("integration.connection.")) return { label: "Open account", href: `/manage/sources?tab=accounts&connection=${id}` };
  if (action === "member.added" || action === "user.updated") return { label: "View member", href: `/manage/access?tab=members&member=${id}` };
  if (action.startsWith("group.")) return { label: "Open group", href: `/manage/access?tab=groups&group=${id}` };
  if (action.startsWith("role.")) return { label: "Open role", href: `/manage/access?tab=roles&role=${id}` };
  if (action.startsWith("approval_request.")) return { label: "Open request", href: `/manage/access?tab=requests&request=${id}` };
  return null;
}

function whereFrom(details: Record<string, unknown>): string | null {
  const parts = ["ip_address", "ip", "user_agent", "device"]
    .map((key) => details[key])
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  return parts.length ? parts.join(" · ") : null;
}

/** One audit event in full: who, what, when, where, and what it touched. */
export function EventDrawer({
  event,
  missing,
  onClose,
}: {
  event: AuditEvent | null;
  /** The link named an event that is not in the loaded window. */
  missing: boolean;
  onClose: () => void;
}) {
  if (!event) {
    return (
      <Drawer onClose={onClose} open={missing} title="Event not found">
        <EmptyState
          description="It may be older than 30 days. Export the activity to see everything the workspace kept."
          size="sm"
          title="This event isn’t in the last 30 days"
        />
      </Drawer>
    );
  }
  const sentence = describeAuditAction(event.action, event.details);
  const area = AUDIT_AREAS.find((item) => item.value === auditActionArea(event.action))?.label ?? "Other";
  const where = whereFrom(event.details ?? {});
  const related = relatedLink(event);
  const rows: [string, React.ReactNode][] = [
    ["When", formatDateTime(event.created_at)],
    [
      "Person",
      <span className="flex items-center gap-2" key="person">
        <ActorAvatar actor={event.actor} size="xs" />
        <span>
          {auditActorName(event.actor)}
          {event.actor.email && event.actor.display_name && (
            <span className="text-text-tertiary"> · {event.actor.email}</span>
          )}
        </span>
      </span>,
    ],
    ["Action", sentence],
    ["Area", area],
    ["Target", describeAuditTarget(event)],
    [
      "Result",
      event.outcome === "success" ? "Succeeded" : <StatusBadge key="result" kind="outcome" value={outcomeStatusKey(event.outcome)} />,
    ],
    ["Where", where ?? <span className="text-text-tertiary" key="where">Not recorded</span>],
  ];

  return (
    <Drawer
      description={`${auditActorName(event.actor)} · ${formatRelative(event.created_at)}`}
      footer={related && (
        <ButtonLink href={related.href} iconAfter={<ArrowRight aria-hidden="true" />} variant="secondary">
          {related.label}
        </ButtonLink>
      )}
      icon={<ActorAvatar actor={event.actor} size="lg" />}
      onClose={onClose}
      open
      title={sentence}
    >
      <DrawerSection title="Details">
        <dl className="grid grid-cols-[120px_minmax(0,1fr)] gap-x-4 gap-y-2.5 text-body">
          {rows.map(([label, value]) => (
            <div className="contents" key={label}>
              <dt className="text-text-tertiary">{label}</dt>
              <dd className="m-0 min-w-0 break-words text-text-primary">{value}</dd>
            </div>
          ))}
        </dl>
      </DrawerSection>
      <details className="group rounded-md border border-border-subtle">
        <summary className={cn("cursor-pointer list-none rounded-md px-3 py-2 text-meta font-medium text-text-secondary hover:bg-surface-hover", ui.focus)}>
          Technical details
        </summary>
        <dl className="grid grid-cols-[120px_minmax(0,1fr)] gap-x-4 gap-y-1.5 border-t border-border-subtle px-3 py-2.5 font-mono text-caption">
          <dt className="text-text-tertiary">Event</dt><dd className="m-0 break-all">{event.id}</dd>
          <dt className="text-text-tertiary">Action code</dt><dd className="m-0 break-all">{event.action}</dd>
          <dt className="text-text-tertiary">Resource</dt>
          <dd className="m-0 break-all">{event.resource_type}{event.resource_id ? ` ${event.resource_id}` : ""}</dd>
          <dt className="text-text-tertiary">Recorded</dt>
          <dd className="m-0 overflow-x-auto"><pre className="m-0 whitespace-pre-wrap break-all">{JSON.stringify(event.details ?? {}, null, 2)}</pre></dd>
        </dl>
      </details>
    </Drawer>
  );
}
