"use client";

import { Button, Tooltip } from "@heroui/react";
import { Bell, CheckCheck, CheckCircle2, Settings, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from "react";
import { createPortal } from "react-dom";

import { openPreferences } from "@/components/shell/overlays";
import { EmptyState, IconButton, ItemIcon, LinkButton, List, ListItem, SkeletonRows, toast } from "@/components/ui";
import { errorMessage } from "@/lib/api/client";
import { fmtDateTime, rel } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";

import type { Notification } from "../api";
import { needsYou, viewOf, type InboxView, type Subjects } from "../model";
import { useInboxMutations, useNotifications, useNotificationSubjects } from "../queries";
import { closeInbox, toggleInbox, useInboxOpen } from "../store";

/** Below this app width the popover is a bottom sheet (layout.css phone breakpoint). */
const SHEET = 680;
const WIDTH = 400;

/**
 * The top row's Inbox (preview `PO.inbox` on `#topbar-inbox`): a bell with the unread count that opens the
 * notifications in a popover (a bottom sheet on phones), so reading them never leaves the page you're on.
 * Needs you (longest waiting first), then Updates (newest first); Mark all read and Notification settings in its footer.
 */
export function InboxBell() {
  const open = useInboxOpen();
  const query = useNotifications();
  const unread = (query.data ?? []).filter((n) => !n.read).length;
  const bell = useRef<HTMLButtonElement>(null);
  const label = unread ? `Inbox, ${unread} unread` : "Inbox";
  return (
    <>
      <Tooltip>
        <Button
          ref={bell}
          isIconOnly
          size="sm"
          variant="ghost"
          className="button--muted topbar-bell"
          id="topbar-inbox"
          aria-label={label}
          aria-haspopup="dialog"
          aria-expanded={open}
          data-tour="inbox"
          onPress={toggleInbox}
        >
          <Bell className="i" aria-hidden />
          {unread ? (
            <span className="topbar-bell__badge" aria-hidden>
              {unread > 9 ? "9+" : unread}
            </span>
          ) : null}
        </Button>
        <Tooltip.Content>Inbox</Tooltip.Content>
      </Tooltip>
      {open ? <InboxPopover anchor={bell} /> : null}
    </>
  );
}

function InboxPopover({ anchor }: { anchor: RefObject<HTMLButtonElement | null> }) {
  const panel = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ sheet: boolean; style: CSSProperties }>({ sheet: false, style: { visibility: "hidden" } });

  const close = useCallback(
    (refocus: boolean) => {
      closeInbox();
      if (refocus) anchor.current?.focus();
    },
    [anchor],
  );

  // Anchored under the bell, right-aligned to it; a bottom sheet on phones.
  useLayoutEffect(() => {
    const position = () => {
      const width = document.body.clientWidth;
      const r = anchor.current?.getBoundingClientRect();
      if (width < SHEET || !r) return setPlace({ sheet: true, style: {} });
      const w = Math.min(WIDTH, width - 16);
      setPlace({ sheet: false, style: { top: r.bottom + 6, left: Math.max(8, Math.min(r.right - w, width - w - 8)), width: w } });
    };
    position();
    // After the bell's press settles (React Aria keeps focus on a pressed button), so focus lands in the panel.
    const raf = requestAnimationFrame(() => panel.current?.focus({ preventScroll: true }));
    window.addEventListener("resize", position);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", position);
    };
  }, [anchor]);

  // Escape returns to the bell; a click outside closes (the bell itself toggles).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      close(true);
    };
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (panel.current?.contains(t) || anchor.current?.contains(t)) return;
      if ((t as Element).closest?.("[data-toast-region], .toast-region")) return;
      close(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [anchor, close]);

  return createPortal(
    <>
      {place.sheet ? <div className="shell-popover-backdrop" aria-hidden onClick={() => close(true)} /> : null}
      <div
        ref={panel}
        id="popover"
        className={place.sheet ? "shell-popover shell-popover--sheet" : "shell-popover"}
        style={place.style}
        role="dialog"
        aria-label="Inbox"
        tabIndex={-1}
      >
        <InboxPanel sheet={place.sheet} onClose={close} />
      </div>
    </>,
    document.body,
  );
}

/** On phones (`sheet`) the panel drops its × and ends the footer with Done (preview `popoverHtml()` on a phone). */
function InboxPanel({ sheet, onClose }: { sheet: boolean; onClose: (refocus: boolean) => void }) {
  const { can, hasModule, member } = useWorkspace();
  const query = useNotifications();
  const all = query.data ?? [];
  const loaded = useNotificationSubjects(all);
  const admin = can("workspaces.getOverview");
  const subjects: Subjects = { ...loaded, me: member.name ?? "", admin };
  const m = useInboxMutations();
  const unread = all.filter((n) => !n.read).length;

  const rows = all.map((n) => ({ n, view: viewOf(n, subjects) }));
  const needs = rows.filter((r) => needsYou(r.view)).reverse();
  const updates = rows.filter((r) => !needsYou(r.view));

  const markAll = () =>
    m.markAllRead.mutate(undefined, {
      onSuccess: () => toast("Marked all as read"),
      onError: (e) => toast(errorMessage(e), { tone: "danger" }),
    });

  const what = [hasModule("spaces") && "deadlines and announcements", hasModule("requests") && "requests", admin ? "syncs and access requests" : "shared knowledge"].filter(
    (w): w is string => Boolean(w),
  );
  const caughtUp = `Updates about ${what.length > 1 ? `${what.slice(0, -1).join(", ")} and ${what.at(-1)}` : what[0]} show up here.`;
  const list = (items: typeof rows) => (
    <List plain className="inbox-list">
      {items.map(({ n, view }) => (
        <InboxRow key={n.name} notification={n} view={view} onClose={onClose} />
      ))}
    </List>
  );

  return (
    <>
      <div className="popover__header">
        <h2 className="popover__title">Inbox</h2>
        {sheet ? null : <IconButton icon={X} tip="Close" size="sm" onPress={() => onClose(true)} />}
      </div>
      <div className="popover__body">
        <div className="inbox-pop">
          {query.isPending ? (
            <SkeletonRows rows={3} />
          ) : query.isError ? (
            <EmptyState compact tone="danger" title="This didn’t load" description={errorMessage(query.error)} actions={<Button size="sm" onPress={() => void query.refetch()}>Try again</Button>} />
          ) : !all.length ? (
            <EmptyState compact icon={CheckCircle2} tone="success" title="You’re all caught up" description={caughtUp} />
          ) : !needs.length ? (
            list(updates)
          ) : (
            <>
              <section className="inbox-pop__group" aria-label="Needs you">
                <h3 className="inbox-pop__label">Needs you</h3>
                {list(needs)}
              </section>
              {updates.length ? (
                <section className="inbox-pop__group" aria-label="Updates">
                  <h3 className="inbox-pop__label">Updates</h3>
                  {list(updates)}
                </section>
              ) : null}
            </>
          )}
        </div>
      </div>
      <div className="popover__footer">
        <span className="grow">
          <LinkButton
            icon={Settings}
            onPress={() => {
              onClose(false);
              openPreferences("notifications");
            }}
          >
            Notification settings
          </LinkButton>
        </span>
        {unread ? (
          <Button size="sm" variant="ghost" onPress={markAll} isPending={m.markAllRead.isPending}>
            <CheckCheck className="i" aria-hidden />
            Mark all read
          </Button>
        ) : null}
        {sheet ? (
          <Button variant="primary" className="popover__done" onPress={() => onClose(true)}>
            Done
          </Button>
        ) : null}
      </div>
    </>
  );
}

function InboxRow({ notification: n, view, onClose }: { notification: Notification; view: InboxView; onClose: (refocus: boolean) => void }) {
  const router = useRouter();
  const m = useInboxMutations();
  const read = () => {
    if (!n.read) m.markRead.mutate(n);
  };
  const open = (href = view.href) => {
    read();
    if (!href) return;
    onClose(false);
    router.push(href);
  };
  // mutateAsync: the row unmounts once dismissed, which would drop per-call mutate callbacks. Undo restores silently.
  const dismiss = () =>
    m.dismiss.mutateAsync(n).then(
      () => toast("Notification dismissed", { undo: () => void m.restore.mutateAsync(n).catch((e: unknown) => toast(errorMessage(e), { tone: "danger" })) }),
      (e: unknown) => toast(errorMessage(e), { tone: "danger" }),
    );
  const decide = (approve: boolean) => {
    if (view.action.kind !== "decide") return;
    read();
    m.decide.mutate(
      { request: view.action.request, approve },
      {
        onSuccess: () => toast(approve ? "Request approved" : "Request denied", { tone: approve ? "success" : "accent" }),
        onError: (e) => toast(errorMessage(e), { tone: "danger" }),
      },
    );
  };

  const a = view.action;
  const pending = m.decide.isPending;
  // Only in-place decisions get buttons (Approve/Deny, Reconnect), under the text so the title keeps the width.
  const inline =
    a.kind === "decide" ? (
      <span className="inbox-decide">
        <Button size="sm" variant="secondary" onPress={() => decide(true)} isDisabled={pending}>
          Approve
        </Button>
        <Button size="sm" variant="ghost" onPress={() => decide(false)} isDisabled={pending}>
          Deny
        </Button>
      </span>
    ) : a.kind === "reconnect" ? (
      <span className="inbox-decide">
        <Button size="sm" variant="secondary" onPress={() => open(a.href)}>
          Reconnect
        </Button>
      </span>
    ) : null;

  return (
    <ListItem
      className="inbox-item item--lines-2"
      lead={<ItemIcon icon={view.icon} tone={view.tone || undefined} size="sm" />}
      title={n.title ?? ""}
      label={n.title}
      unread={!n.read}
      onPress={() => open()}
      description={
        <>
          {n.body ? (
            <span className="truncate inbox-line" translate="no">
              {n.body}
            </span>
          ) : null}
          <span className="inbox-time" title={fmtDateTime(n.createTime)}>
            {rel(n.createTime)}
          </span>
          {inline}
        </>
      }
      actions={
        <span className="reveal-on-hover">
          <IconButton icon={X} tip="Dismiss" size="sm" onPress={dismiss} />
        </span>
      }
    />
  );
}
