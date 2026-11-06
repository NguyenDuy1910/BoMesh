"use client";

import { Button } from "@heroui/react";
import { CheckCheck, CheckCircle2, Settings, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { PageChrome } from "@/components/shell/page-chrome";
import { openPreferences } from "@/components/shell/overlays";
import { EmptyState, Gate, IconButton, ItemIcon, List, ListItem, Page, PageHeader, SectionTabs, SkeletonRows, toast } from "@/components/ui";
import { errorMessage } from "@/lib/api/client";
import { rel, fmtDateTime } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";

import type { Notification } from "../api";
import { viewOf, type InboxView, type Subjects } from "../model";
import { useInboxMutations, useNotifications, useNotificationSubjects } from "../queries";

type Tab = "all" | "unread";

/** Inbox (`/inbox`, preview `P.inbox`): notifications for the caller, each with one inline action. */
export function InboxPage() {
  const { can, hasModule, member } = useWorkspace();
  const query = useNotifications();
  const [tab, setTab] = useState<Tab>("all");
  const all = query.data ?? [];
  const unread = all.filter((n) => !n.read).length;
  const loaded = useNotificationSubjects(all);
  const admin = can("workspaces.getOverview");
  const subjects: Subjects = { ...loaded, me: member.name ?? "", admin };
  const m = useInboxMutations();

  const markAll = () =>
    m.markAllRead.mutate(undefined, {
      onSuccess: () => toast("Marked all as read"),
      onError: (e) => toast(errorMessage(e), { tone: "danger" }),
    });

  const what = [hasModule("spaces") && "deadlines and announcements", hasModule("requests") && "request updates", admin ? "syncs and access requests" : "shared knowledge"].filter(Boolean).join(", ");
  const caughtUp = (
    <EmptyState icon={CheckCircle2} tone="success" title="You’re all caught up" description={`${what.charAt(0).toUpperCase()}${what.slice(1)} show up here.`} boxed />
  );
  const shown = tab === "unread" ? all.filter((n) => !n.read) : all;

  return (
    <Page narrow>
      <PageChrome crumbs={[{ label: "Inbox" }]} />
      <PageHeader
        title="Inbox"
        actions={
          unread ? (
            <Button variant="ghost" onPress={markAll} isPending={m.markAllRead.isPending}>
              <CheckCheck className="i" aria-hidden />
              Mark all read
            </Button>
          ) : null
        }
      >
        <SectionTabs
          variant="primary"
          label="Inbox filter"
          active={tab}
          onChange={(id) => setTab(id as Tab)}
          items={[
            { id: "all", label: "All" },
            { id: "unread", label: "Unread", count: unread || null },
          ]}
        />
      </PageHeader>
      <Gate query={query} skeleton={<SkeletonRows rows={5} />} isEmpty={(rows) => !rows.length} empty={caughtUp}>
        {() =>
          shown.length ? (
            <List className="inbox-list">
              {shown.map((n) => (
                <InboxRow key={n.name} notification={n} view={viewOf(n, subjects)} />
              ))}
            </List>
          ) : tab === "unread" && all.length ? (
            <EmptyState
              icon={CheckCircle2}
              tone="success"
              title="Nothing unread"
              description="You’ve seen everything."
              actions={<Button onPress={() => setTab("all")}>Show all</Button>}
              boxed
            />
          ) : (
            caughtUp
          )
        }
      </Gate>
      <div className="inbox-foot">
        <button type="button" className="link-button" onClick={openPreferences}>
          Notification settings
          <Settings className="i i-sm" aria-hidden />
        </button>
      </div>
    </Page>
  );
}

function InboxRow({ notification: n, view }: { notification: Notification; view: InboxView }) {
  const router = useRouter();
  const m = useInboxMutations();
  const read = () => {
    if (!n.read) m.markRead.mutate(n);
  };
  const open = (href = view.href) => {
    read();
    router.push(href);
  };
  // mutateAsync: the row unmounts once dismissed, which would drop per-call mutate callbacks.
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
  const inline =
    a.kind === "decide" ? (
      <>
        <Button size="sm" variant="ghost" onPress={() => decide(false)} isDisabled={pending}>
          Deny
        </Button>
        <Button size="sm" variant="secondary" onPress={() => decide(true)} isDisabled={pending}>
          Approve
        </Button>
      </>
    ) : a.kind === "reconnect" ? (
      <Button size="sm" variant="secondary" onPress={() => open(a.href)}>
        Reconnect
      </Button>
    ) : a.kind === "cta" ? (
      <Button size="sm" variant="secondary" onPress={() => open(a.href)}>
        {a.label}
      </Button>
    ) : (
      <Button size="sm" variant="tertiary" className="hide-sm" onPress={() => open(a.href)}>
        Open
      </Button>
    );

  return (
    <ListItem
      className="inbox-item"
      lead={<ItemIcon icon={view.icon} tone={view.tone || undefined} />}
      title={n.title ?? ""}
      label={n.title}
      unread={!n.read}
      onPress={() => open()}
      description={
        <>
          <span className="truncate inbox-line">{n.body}</span>
          <span className="inbox-time" title={fmtDateTime(n.createTime)}>
            {rel(n.createTime)}
          </span>
        </>
      }
      actions={
        <>
          {inline}
          <IconButton icon={X} tip="Dismiss" size="sm" onPress={dismiss} />
        </>
      }
    />
  );
}
