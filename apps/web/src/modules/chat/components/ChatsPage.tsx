"use client";

import { BookOpen, MessageSquare, MoreHorizontal, Pencil, Plus, Search, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import { Page } from "@/components/shell/Page";
import { ButtonLink, Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { ICON_MENU_TRIGGER } from "./icon-menu-trigger";
import { Menu, MenuItem, MenuSeparator } from "@/components/ui/Menu";
import { PageHeader } from "@/components/ui/PageHeader";
import { SearchInput } from "@/components/ui/SearchInput";
import { SkeletonRows } from "@/components/ui/Skeleton";
import { Tag } from "@/components/ui/Tag";
import { Toolbar } from "@/components/ui/Toolbar";
import { chatTimeLabel, groupChatsByDate, matchesChatQuery } from "../chat-list";
import { useConversationList, type ConversationListItem } from "../hooks/useConversationList";
import { plural } from "../work";
import { DeleteChatDialog, RenameChatDialog } from "./ChatDialogs";

/** `/chats` — every chat kept in this browser, searchable, grouped by day. */
export function ChatsPage() {
  const router = useRouter();
  const { conversations, loading, error, reload } = useConversationList();
  const [query, setQuery] = useState("");
  const [action, setAction] = useState<{ kind: "rename" | "delete"; chat: ConversationListItem } | null>(null);
  const now = Date.now();
  const matches = useMemo(() => conversations.filter((chat) => matchesChatQuery(chat, query)), [conversations, query]);
  const groups = useMemo(() => groupChatsByDate(matches, now), [matches, now]);

  let body: React.ReactNode;
  if (loading) {
    body = <SkeletonRows columns={3} label="Loading chats" rows={6} />;
  } else if (error) {
    body = <ErrorState description={error} onAction={() => void reload()} />;
  } else if (!conversations.length) {
    body = (
      <EmptyState
        action={<ButtonLink href="/chat" icon={<Plus aria-hidden="true" />} variant="secondary">New chat</ButtonLink>}
        boxed
        description="Ask a question and your chats will appear here. Chats are kept in this browser."
        icon={<MessageSquare aria-hidden="true" />}
        title="No chats yet"
      />
    );
  } else if (!matches.length) {
    body = (
      <EmptyState
        action={<Button onClick={() => setQuery("")} variant="secondary">Clear search</Button>}
        boxed
        description="Try a different word."
        icon={<Search aria-hidden="true" />}
        title={`No chats match “${query.trim()}”`}
      />
    );
  } else {
    body = groups.map((group) => (
      <section aria-labelledby={`chats-${group.group}`} className="mb-[22px] last:mb-0" key={group.group}>
        <h2 className="mb-2 text-caption font-medium text-text-tertiary" id={`chats-${group.group}`}>{group.group}</h2>
        <ul className="overflow-hidden rounded-lg border border-border-subtle bg-surface-base">
          {group.items.map((chat) => (
            <li
              className="relative flex items-center gap-3 border-b border-border-subtle px-4 py-3 last:border-b-0 hover:bg-surface-subtle has-[a:focus-visible]:bg-surface-subtle has-[a:focus-visible]:shadow-[inset_0_0_0_2px_var(--focus-ring)]"
              key={chat.id}
            >
              <span aria-hidden="true" className="grid size-8 shrink-0 place-items-center rounded-md bg-surface-inset text-text-secondary">
                <MessageSquare size={16} />
              </span>
              <div className="min-w-0 flex-1">
                <a
                  className="block truncate font-medium text-text-primary after:absolute after:inset-0 after:content-[''] focus-visible:outline-none"
                  href={`/chat/${encodeURIComponent(chat.id)}`}
                  onClick={(event) => {
                    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
                    event.preventDefault();
                    router.push(`/chat/${encodeURIComponent(chat.id)}`);
                  }}
                >
                  {chat.title}
                </a>
                {chat.preview && <p className="truncate text-meta text-text-secondary">{chat.preview}</p>}
              </div>
              {chat.scope[0] && (
                <Tag className="relative max-[900px]:hidden" icon={<BookOpen aria-hidden="true" size={12} />}>
                  {chat.scope.length > 1 ? `${chat.scope[0].title} +${chat.scope.length - 1}` : chat.scope[0].title}
                </Tag>
              )}
              <span className="relative shrink-0 whitespace-nowrap text-meta text-text-tertiary" title={new Date(chat.updated_at).toLocaleString()}>
                {chatTimeLabel(chat.updated_at, now)}
              </span>
              <div className="relative">
                <Menu align="end" ariaLabel={`More actions for ${chat.title}`} label={<MoreHorizontal aria-hidden="true" />} showChevron={false} tooltip="More" triggerClassName={ICON_MENU_TRIGGER}>
                  <MenuItem icon={<Pencil />} onSelect={() => setAction({ kind: "rename", chat })}>Rename</MenuItem>
                  <MenuSeparator />
                  <MenuItem danger icon={<Trash2 />} onSelect={() => setAction({ kind: "delete", chat })}>Delete chat</MenuItem>
                </Menu>
              </div>
            </li>
          ))}
        </ul>
      </section>
    ));
  }

  return (
    <Page width="narrow">
      <PageHeader
        actions={<ButtonLink href="/chat" icon={<Plus aria-hidden="true" />} variant="primary">New chat</ButtonLink>}
        sub="Chats are kept in this browser."
        title="Chats"
      />
      <Toolbar
        end={!loading && !error && conversations.length > 0 ? (
          <span className="text-meta text-text-tertiary">
            {query.trim() ? plural(matches.length, "result") : plural(conversations.length, "chat")}
          </span>
        ) : undefined}
        search={<SearchInput ariaLabel="Search chats" onChange={setQuery} placeholder="Search chats" size="sm" value={query} />}
      />
      <div className="mt-5">{body}</div>
      {action && (
        <>
          <RenameChatDialog
            conversationId={action.chat.id}
            onClose={() => setAction(null)}
            open={action.kind === "rename"}
            title={action.chat.title}
          />
          <DeleteChatDialog
            conversationId={action.chat.id}
            onClose={() => setAction(null)}
            open={action.kind === "delete"}
            title={action.chat.title}
          />
        </>
      )}
    </Page>
  );
}
