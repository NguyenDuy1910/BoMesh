"use client";

import {
  CircleAlert,
  CircleCheck,
  CircleX,
  Clock,
  Plug,
  Settings,
  Sparkles,
  UserPlus,
  type LucideIcon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

import { Button } from "@/components/ui/Button";
import { Drawer } from "@/components/ui/Drawer";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { PreviewTag } from "@/components/ui/PreviewTag";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { SkeletonRows } from "@/components/ui/Skeleton";
import { useToast } from "@/components/ui/Toast";
import { usePendingFeature } from "@/lib/api/pending";
import { apiRevision, subscribeApiData } from "@/lib/api/revision";
import { cn } from "@/lib/cn";
import {
  listNotifications,
  markAllNotificationsRead,
  markNotification,
  type NotificationKind,
  type NotificationList,
} from "@/modules/notifications/api";
import { formatRelative } from "@/lib/format";

type Tone = "err" | "warn" | "ok" | "info" | "neutral";

const KIND: Record<NotificationKind, { icon: LucideIcon; tone: Tone }> = {
  product_notice: { icon: Sparkles, tone: "info" },
  source_failed: { icon: CircleAlert, tone: "err" },
  connection_reconnect: { icon: Plug, tone: "err" },
  access_request: { icon: UserPlus, tone: "warn" },
  access_request_pending: { icon: Clock, tone: "neutral" },
  access_request_approved: { icon: CircleCheck, tone: "ok" },
  access_request_denied: { icon: CircleX, tone: "neutral" },
};

const TONE_CLASS: Record<Tone, string> = {
  err: "bg-[var(--status-danger-bg)] text-[var(--status-danger-text)]",
  warn: "bg-[var(--status-warning-bg)] text-[var(--status-warning-text)]",
  ok: "bg-[var(--status-success-bg)] text-[var(--status-success-text)]",
  info: "bg-[var(--status-info-bg)] text-[var(--status-info-text)]",
  neutral: "bg-[var(--surface-inset)] text-[var(--text-secondary)]",
};

export interface InboxState {
  enabled: boolean;
  list: NotificationList | null;
  loading: boolean;
  error: boolean;
  reload: () => void;
}

/**
 * The inbox (pending API `notifications.inbox`), read once for the sidebar
 * count and the drawer. Re-reads when any screen changes data.
 */
export function useInbox(): InboxState {
  const enabled = usePendingFeature("notifications.inbox");
  const revision = useSyncExternalStore(subscribeApiData, apiRevision, () => 0);
  const [reloads, setReloads] = useState(0);
  const [state, setState] = useState<{ list: NotificationList | null; loading: boolean; error: boolean }>({
    list: null,
    loading: enabled,
    error: false,
  });
  const reload = useCallback(() => setReloads((value) => value + 1), []);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setState((current) => ({ ...current, loading: true, error: false }));
    listNotifications()
      .then((list) => {
        if (!cancelled) setState({ list, loading: false, error: false });
      })
      .catch(() => {
        if (!cancelled) setState((current) => ({ list: current.list, loading: false, error: true }));
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, revision, reloads]);

  return { enabled, ...state, reload };
}

/** Prototype `DR['pol-inbox']`: sync failures, requests and notices, each linked to where it is resolved. */
export function InboxDrawer({
  inbox,
  open,
  onClose,
  onOpenSettings,
}: {
  inbox: InboxState;
  open: boolean;
  onClose: () => void;
  onOpenSettings: () => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const [tab, setTab] = useState<"all" | "unread">("all");
  const [marking, setMarking] = useState(false);
  // Opening lands on the newest notification, not on the header's controls.
  const firstItemRef = useRef<HTMLButtonElement | null>(null);
  if (!inbox.enabled) return null;

  const unread = inbox.list?.unread_count ?? 0;
  const items = (inbox.list?.items ?? []).filter((item) => tab === "all" || !item.read);

  const markAll = async () => {
    setMarking(true);
    try {
      await markAllNotificationsRead();
      toast.show({ message: "Marked all as read" });
    } catch {
      toast.show({ tone: "err", message: "Couldn’t mark them as read. Try again." });
    } finally {
      setMarking(false);
    }
  };

  let body: React.ReactNode;
  if (!inbox.list && inbox.loading) {
    body = <SkeletonRows columns={1} label="Loading notifications" rows={4} />;
  } else if (!inbox.list && inbox.error) {
    body = <ErrorState onAction={inbox.reload} title="Notifications didn’t load" />;
  } else if (items.length === 0) {
    body = (
      <EmptyState
        description="New syncs, requests and shared knowledge appear here."
        icon={<CircleCheck />}
        size="md"
        title={tab === "unread" ? "You’re all caught up" : "No notifications"}
        tone="ok"
      />
    );
  } else {
    body = (
      <ul className="-mx-2 flex flex-col">
        {items.map((item, index) => {
          const { icon: Icon, tone } = KIND[item.kind] ?? KIND.product_notice;
          return (
            <li key={item.id}>
              <button
                ref={index === 0 ? firstItemRef : undefined}
                className="relative flex w-full items-start gap-3 rounded-[var(--radius-lg)] p-3 text-left hover:bg-[var(--surface-hover)] focus-visible:shadow-[var(--shadow-focus)] focus-visible:outline-none"
                onClick={() => {
                  if (!item.read) void markNotification(item.id, { read: true }).catch(() => undefined);
                  onClose();
                  router.push(item.href);
                }}
                type="button"
              >
                <span aria-hidden="true" className={cn("grid size-8 shrink-0 place-items-center rounded-[9px] [&_svg]:size-4", TONE_CLASS[tone])}>
                  <Icon />
                </span>
                <span className="min-w-0 flex-1 pr-4">
                  <span className={cn("block leading-snug text-[var(--text-primary)]", item.read ? "font-medium" : "font-semibold")}>
                    {item.title}
                  </span>
                  <span className="mt-0.5 block truncate text-[length:var(--text-size-meta)] text-[var(--text-secondary)]">{item.body}</span>
                  <span className="mt-1 block text-[length:var(--text-size-caption)] text-[var(--text-tertiary)]">
                    {formatRelative(item.created_at)}
                  </span>
                </span>
                {!item.read && (
                  <span className="absolute right-3 top-4 size-2 rounded-full bg-[var(--accent-primary)]">
                    <span className="sr-only">Unread</span>
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <Drawer
      description={unread ? `${unread} unread ${unread === 1 ? "notification" : "notifications"}` : "Nothing unread"}
      footer={(
        <Button className="mr-auto" icon={<Settings aria-hidden="true" />} onClick={onOpenSettings} size="sm" variant="ghost">
          Notification settings
        </Button>
      )}
      header={(
        <div className="mt-3">
          <SegmentedControl
            ariaLabel="Show"
            onChange={setTab}
            options={[{ value: "all", label: "All" }, { value: "unread", label: "Unread" }]}
            size="sm"
            value={tab}
          />
        </div>
      )}
      headerActions={unread > 0 ? (
        <Button loading={marking} onClick={() => void markAll()} size="sm" variant="ghost">Mark all read</Button>
      ) : undefined}
      initialFocusRef={firstItemRef}
      onClose={onClose}
      open={open}
      title={<span className="flex items-center gap-2">Inbox <PreviewTag /></span>}
    >
      {body}
    </Drawer>
  );
}
