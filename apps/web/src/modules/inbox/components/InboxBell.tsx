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
import { useInboxMutations, useNotificationList, useNotificationSubjects, useUnreadNotificationCount } from "../queries";
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
  const unread = useUnreadNotificationCount().data ?? 0;
  const bell = useRef<HTMLButtonElement>(null);
  const label = unread ? `Thông báo, ${unread} chưa đọc` : "Thông báo";
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
        <Tooltip.Content>Thông báo</Tooltip.Content>
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
        aria-label="Thông báo"
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
  const query = useNotificationList();
  const all = query.notifications ?? [];
  const loaded = useNotificationSubjects(all);
  const admin = can("workspaces.getOverview");
  const subjects: Subjects = { ...loaded, me: member.name ?? "", admin };
  const m = useInboxMutations();
  const unread = useUnreadNotificationCount().data ?? 0;

  const rows = all.map((n) => ({ n, view: viewOf(n, subjects) }));
  const needs = rows.filter((r) => needsYou(r.view)).reverse();
  const updates = rows.filter((r) => !needsYou(r.view));

  const markAll = () =>
    m.markAllRead.mutate(undefined, {
      onSuccess: () => toast("Đã đánh dấu tất cả là đã đọc"),
      onError: (e) => toast(errorMessage(e), { tone: "danger" }),
    });

  const what = [hasModule("spaces") && "hạn chót và thông báo", hasModule("requests") && "requests", admin ? "đồng bộ và yêu cầu quyền truy cập" : "tài liệu được chia sẻ"].filter(
    (w): w is string => Boolean(w),
  );
  const caughtUp = `Cập nhật về ${what.length > 1 ? `${what.slice(0, -1).join(", ")} và ${what.at(-1)}` : what[0]} sẽ hiện ở đây.`;
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
        <h2 className="popover__title">Thông báo</h2>
        {sheet ? null : <IconButton icon={X} tip="Đóng" size="sm" onPress={() => onClose(true)} />}
      </div>
      <div className="popover__body">
        <div className="inbox-pop">
          {query.isPending ? (
            <SkeletonRows rows={3} />
          ) : query.isError ? (
            <EmptyState compact tone="danger" title="Không tải được nội dung này" description={errorMessage(query.error)} actions={<Button size="sm" onPress={() => void query.refetch()}>Thử lại</Button>} />
          ) : !all.length ? (
            <EmptyState compact icon={CheckCircle2} tone="success" title="Bạn đã xử lý hết" description={caughtUp} />
          ) : !needs.length ? (
            list(updates)
          ) : (
            <>
              <section className="inbox-pop__group" aria-label="Cần bạn">
                <h3 className="inbox-pop__label">Cần bạn</h3>
                {list(needs)}
              </section>
              {updates.length ? (
                <section className="inbox-pop__group" aria-label="Cập nhật">
                  <h3 className="inbox-pop__label">Cập nhật</h3>
                  {list(updates)}
                </section>
              ) : null}
            </>
          )}
          {query.hasNextPage ? <MoreRows onMore={query.fetchNextPage} loading={query.isFetchingNextPage} /> : null}
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
            Cài đặt thông báo
          </LinkButton>
        </span>
        {unread ? (
          <Button size="sm" variant="ghost" onPress={markAll} isPending={m.markAllRead.isPending}>
            <CheckCheck className="i" aria-hidden />
            Đánh dấu tất cả đã đọc
          </Button>
        ) : null}
        {sheet ? (
          <Button variant="primary" className="popover__done" onPress={() => onClose(true)}>
            Xong
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
      () => toast("Đã bỏ qua thông báo", { undo: () => void m.restore.mutateAsync(n).catch((e: unknown) => toast(errorMessage(e), { tone: "danger" })) }),
      (e: unknown) => toast(errorMessage(e), { tone: "danger" }),
    );
  const decide = (approve: boolean) => {
    if (view.action.kind !== "decide") return;
    read();
    m.decide.mutate(
      { request: view.action.request, approve },
      {
        onSuccess: () => toast(approve ? "Đã phê duyệt yêu cầu" : "Đã từ chối yêu cầu", { tone: approve ? "success" : "accent" }),
        onError: (e) => toast(errorMessage(e), { tone: "danger" }),
      },
    );
  };

  const a = view.action;
  const pending = m.decide.isPending;
  // Only in-place decisions get buttons (Approve/Decline, Reconnect), under the text so the title keeps the width.
  const inline =
    a.kind === "decide" ? (
      <span className="inbox-decide">
        <Button size="sm" variant="secondary" onPress={() => decide(true)} isDisabled={pending}>
          Phê duyệt
        </Button>
        <Button size="sm" variant="ghost" onPress={() => decide(false)} isDisabled={pending}>
          Từ chối
        </Button>
      </span>
    ) : a.kind === "reconnect" ? (
      <span className="inbox-decide">
        <Button size="sm" variant="secondary" onPress={() => open(a.href)}>
          Kết nối lại
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
          <IconButton icon={X} tip="Bỏ qua" size="sm" onPress={dismiss} />
        </span>
      }
    />
  );
}

/** Older notifications load when the end of the list scrolls into view (a page at a time). */
function MoreRows({ onMore, loading }: { onMore: () => unknown; loading: boolean }) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = end.current;
    if (!el || loading) return;
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && onMore(), { rootMargin: "120px" });
    io.observe(el);
    return () => io.disconnect();
  }, [onMore, loading]);
  return <div ref={end}>{loading ? <SkeletonRows rows={2} /> : null}</div>;
}
