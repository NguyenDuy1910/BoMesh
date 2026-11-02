"use client";

import {
  BookOpen,
  Building2,
  Clock,
  FileText,
  Layers,
  MessageSquare,
  Moon,
  Plug,
  Plus,
  Search,
  Sparkles,
  Sun,
  Upload,
  User,
  UserPlus,
  type LucideIcon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { PaletteContext, type PaletteControls } from "@/components/shell/usePalette";
import { useCurrentWorkspace } from "@/components/shell/useCurrentWorkspace";
import { Kbd } from "@/components/ui/Kbd";
import { PreviewTag } from "@/components/ui/PreviewTag";
import { isPendingFeatureEnabled } from "@/lib/api/pending";
import {
  canAccessPlatformControl,
  hasPlatformPermission,
  hasSessionPermission,
  type AuthSession,
} from "@/lib/auth/session";
import { cn } from "@/lib/cn";
import { useAccountPreferences } from "@/lib/hooks/useAccountPreferences";
import { useModalLayer } from "@/lib/hooks/useModalLayer";
import { MANAGE_NAV, PLATFORM_NAV, visibleNavItems } from "@/lib/navigation";
import { useConversationList } from "@/modules/chat/hooks/useConversationList";
import { findDocumentsByName, type FoundDocument } from "@/modules/knowledge/document-search";
import { knowledgeApi, type KnowledgeHome } from "@/modules/knowledge/knowledge-api";
import { memberName, workspaceDirectoryApi, type Member } from "@/modules/manage/access/directory";
import { listPlatformUsers, listPlatformWorkspaces, type PlatformUser, type PlatformWorkspace } from "@/modules/platform/api";
import { formatRelative } from "@/lib/format";

const DEBOUNCE_MS = 180;
const RECENT_SEARCHES = 5;

interface PaletteItem {
  id: string;
  label: string;
  icon: LucideIcon;
  meta?: string;
  /** Local data from a not-yet-connected API: marked so it is never mistaken for a record. */
  preview?: boolean;
  /** An app route, or a function for actions that do not navigate. */
  to: string | (() => void);
}

interface PaletteGroup {
  label: string;
  items: PaletteItem[];
}

/** Loads once per open or per query; a refused or failed read is simply no results. */
function useRemote<T>(key: string | null, load: (signal: AbortSignal) => Promise<T>): { data: T | null; loading: boolean } {
  const [state, setState] = useState<{ key: string | null; data: T | null; loading: boolean }>({ key: null, data: null, loading: false });
  const loader = useRef(load);
  loader.current = load;

  useEffect(() => {
    if (key === null) {
      setState({ key: null, data: null, loading: false });
      return;
    }
    const controller = new AbortController();
    setState((current) => ({ key, data: current.key === key ? current.data : null, loading: true }));
    loader.current(controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) setState({ key, data, loading: false });
      })
      .catch(() => {
        if (!controller.signal.aborted) setState({ key, data: null, loading: false });
      });
    return () => controller.abort();
  }, [key]);

  return { data: state.key === key ? state.data : null, loading: state.loading };
}

function useDebounced(value: string, delay: number): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

const recentKey = (session: AuthSession | null) => `bomesh.palette.recent.${session?.user_id ?? "anonymous"}`;

function readRecentSearches(session: AuthSession | null): string[] {
  try {
    const stored: unknown = JSON.parse(window.localStorage.getItem(recentKey(session)) ?? "[]");
    return Array.isArray(stored) ? stored.filter((entry): entry is string => typeof entry === "string").slice(0, RECENT_SEARCHES) : [];
  } catch {
    return [];
  }
}

function rememberSearch(session: AuthSession | null, query: string) {
  const next = [query, ...readRecentSearches(session).filter((entry) => entry.toLowerCase() !== query.toLowerCase())];
  try {
    window.localStorage.setItem(recentKey(session), JSON.stringify(next.slice(0, RECENT_SEARCHES)));
  } catch {
    // Without storage, recent searches are simply not kept.
  }
}

/**
 * Provides `usePalette()` and renders the one command palette. ⌘K / Ctrl+K
 * and `?action=search` are wired by the shell.
 */
export function PaletteProvider({ platform, children }: { platform: boolean; children: React.ReactNode }) {
  const [state, setState] = useState<{ open: boolean; query: string; opened: number }>({ open: false, query: "", opened: 0 });
  const open = useCallback((query = "") => setState((current) => ({ open: true, query, opened: current.opened + 1 })), []);
  const close = useCallback(() => setState((current) => ({ ...current, open: false })), []);
  const controls = useMemo<PaletteControls>(() => ({ open }), [open]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.key.toLowerCase() !== "k") return;
      event.preventDefault();
      setState((current) => (current.open ? { ...current, open: false } : { open: true, query: "", opened: current.opened + 1 }));
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <PaletteContext value={controls}>
      {children}
      {state.open && <CommandPalette initialQuery={state.query} key={state.opened} onClose={close} platform={platform} />}
    </PaletteContext>
  );
}

function CommandPalette({ initialQuery, onClose, platform }: { initialQuery: string; onClose: () => void; platform: boolean }) {
  const router = useRouter();
  const listId = useId();
  const optionId = useId();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const { session } = useCurrentWorkspace();
  const { conversations } = useConversationList();
  const { updatePreferences } = useAccountPreferences();
  const [query, setQuery] = useState(initialQuery);
  // Selection follows the item, not its position, so results arriving late never move it.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [recent, setRecent] = useState<string[]>(() => readRecentSearches(session));
  const [dark] = useState(() => document.documentElement.dataset.theme === "dark");
  const q = useDebounced(query.trim(), DEBOUNCE_MS);
  const typed = query.trim();

  useModalLayer({ open: true, onClose, panelRef, initialFocusRef: inputRef });

  const can = (code: string) => hasSessionPermission(session, code);
  const canPeople = !platform && can("user.manage");

  const home = useRemote<KnowledgeHome>(platform ? null : "home", () => knowledgeApi.home());
  const documents = useRemote<FoundDocument[]>(!platform && q ? `documents:${q}` : null, (signal) => findDocumentsByName(q, signal));
  const people = useRemote<Member[]>(canPeople && q ? `people:${q}` : null, () =>
    workspaceDirectoryApi.members(q).then((page) => page.items));
  const workspaces = useRemote<PlatformWorkspace[]>(
    platform && hasPlatformPermission(session, "platform.tenant.read") ? "workspaces" : null,
    () => listPlatformWorkspaces(),
  );
  const users = useRemote<PlatformUser[]>(
    platform && q && hasPlatformPermission(session, "platform.user.read") ? `users:${q}` : null,
    () => listPlatformUsers({ search: q }),
  );
  const searching = documents.loading || people.loading || users.loading || (typed !== q);

  const groups = useMemo<PaletteGroup[]>(() => {
    const needle = typed.toLowerCase();
    const matches = (...values: (string | null | undefined)[]) =>
      !needle || values.some((value) => value?.toLowerCase().includes(needle));
    const out: PaletteGroup[] = [];
    const add = (label: string, items: PaletteItem[]) => {
      if (items.length) out.push({ label, items });
    };

    if (!typed && recent.length) {
      add("Recent searches", recent.map((entry) => ({ id: `recent:${entry}`, label: entry, icon: Clock, to: () => setQuery(entry) })));
    }

    if (platform) {
      add("Workspaces", (workspaces.data ?? []).filter((row) => matches(row.name, row.code)).slice(0, 6).map((row) => ({
        id: `workspace:${row.id}`,
        label: row.name,
        icon: Building2,
        meta: row.code,
        preview: row.source === "local" || row.changed_locally,
        to: `/platform/workspaces?workspace=${encodeURIComponent(row.id)}`,
      })));
      add("Users", typed ? (users.data ?? []).slice(0, 5).map((row) => ({
        id: `user:${row.id}`,
        label: memberName(row),
        icon: User,
        meta: row.email,
        preview: row.changed_locally,
        to: `/platform/users?user=${encodeURIComponent(row.id)}`,
      })) : []);
      add("Go to", [
        ...visibleNavItems(PLATFORM_NAV, session, isPendingFeatureEnabled).map((item) => ({ id: `page:${item.id}`, label: item.label, icon: item.icon, to: item.href ?? "/platform" })),
        { id: "page:back", label: "Back to workspace", icon: Layers, to: "/chat" },
      ].filter((item) => matches(item.label)));
      return out;
    }

    if (typed) {
      add("Ask the assistant", [{
        id: "ask",
        label: `Ask “${typed}”`,
        icon: Sparkles,
        to: `/chat?q=${encodeURIComponent(typed)}&send=1`,
      }]);
    }
    add("Chats", conversations.filter((chat) => matches(chat.title, chat.preview)).slice(0, typed ? 5 : 3).map((chat) => ({
      id: `chat:${chat.id}`,
      label: chat.title,
      icon: MessageSquare,
      meta: formatRelative(new Date(chat.updated_at).toISOString(), ""),
      to: `/chat/${chat.id}`,
    })));
    const personalId = home.data?.personal_collection_id ?? null;
    add("Knowledge bases", (home.data?.collections ?? [])
      .map((collection) => ({ ...collection, title: collection.id === personalId ? "My files" : collection.title }))
      .filter((collection) => matches(collection.title))
      .slice(0, 4)
      .map((collection) => ({
        id: `kb:${collection.id}`,
        label: collection.title,
        icon: collection.id === personalId ? User : BookOpen,
        meta: `${collection.document_count.toLocaleString()} ${collection.document_count === 1 ? "document" : "documents"}`,
        to: `/knowledge/${collection.id}`,
      })));
    if (typed) {
      const titles = new Map((home.data?.collections ?? []).map((collection) => [collection.id, collection.id === personalId ? "My files" : collection.title]));
      add("Documents", (documents.data ?? []).slice(0, 5).map((document) => ({
        id: `doc:${document.id}`,
        label: document.name,
        icon: FileText,
        meta: (document.collectionId && titles.get(document.collectionId)) || undefined,
        to: `/documents/${document.id}`,
      })));
    }
    if (typed && canPeople) {
      add("People", (people.data ?? []).slice(0, 4).map((member) => ({
        id: `person:${member.id}`,
        label: memberName(member),
        icon: User,
        meta: member.roles.map((role) => role.display_name).join(", ") || member.email,
        to: `/manage/access?tab=members&member=${encodeURIComponent(member.id)}`,
      })));
    }
    const pages: PaletteItem[] = [
      { id: "page:knowledge", label: "Knowledge", icon: BookOpen, to: "/knowledge" },
      { id: "page:chats", label: "All chats", icon: MessageSquare, to: "/chats" },
      ...visibleNavItems(MANAGE_NAV, session, isPendingFeatureEnabled).map((item) => ({ id: `page:${item.id}`, label: item.label, icon: item.icon, to: item.href ?? "/" })),
      ...(canAccessPlatformControl(session) ? [{ id: "page:platform", label: "Platform console", icon: Layers, to: "/platform" }] : []),
    ];
    add("Go to", pages.filter((page) => matches(page.label)).slice(0, typed ? 6 : 4));
    const actions: (PaletteItem | false)[] = [
      { id: "action:new-chat", label: "New chat", icon: Plus, to: "/chat" },
      can("knowledge.read") && { id: "action:upload", label: "Upload files to My files", icon: Upload, to: "/knowledge/personal?action=upload" },
      can("knowledge.manage") && { id: "action:create-kb", label: "Create knowledge base", icon: BookOpen, to: "/knowledge?action=create" },
      can("source.manage") && { id: "action:connect", label: "Connect a source", icon: Plug, to: "/manage/sources?connect=1" },
      can("user.manage") && { id: "action:add-member", label: "Add a member", icon: UserPlus, to: "/manage/access?action=add" },
      {
        id: "action:theme",
        label: dark ? "Switch to light theme" : "Switch to dark theme",
        icon: dark ? Sun : Moon,
        to: () => updatePreferences({ theme: dark ? "light" : "dark" }),
      },
    ];
    add("Actions", actions.filter((action): action is PaletteItem => Boolean(action) && matches((action as PaletteItem).label)));
    return out;
    // `can` reads `session`, which is listed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typed, recent, platform, workspaces.data, users.data, session, conversations, home.data, documents.data, people.data, canPeople, dark, updatePreferences]);

  const flat = useMemo(() => groups.flatMap((group) => group.items), [groups]);
  const found = selectedId ? flat.findIndex((item) => item.id === selectedId) : -1;
  const active = found >= 0 ? found : 0;

  useEffect(() => setSelectedId(null), [typed]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const run = (item: PaletteItem | undefined) => {
    if (!item) return;
    if (typeof item.to === "function") {
      if (item.id.startsWith("recent:")) {
        item.to();
        inputRef.current?.focus();
        return;
      }
      onClose();
      item.to();
      return;
    }
    if (typed) {
      rememberSearch(session, typed);
      setRecent(readRecentSearches(session));
    }
    onClose();
    router.push(item.to);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    const count = flat.length;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (count) setSelectedId(flat[(active + (event.key === "ArrowDown" ? 1 : -1) + count) % count].id);
    } else if (event.key === "Enter") {
      event.preventDefault();
      run(flat[active]);
    }
  };

  let index = -1;
  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex justify-center bg-[var(--scrim)] px-4 pt-[10vh] motion-safe:animate-ui-fade"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        aria-label="Search"
        aria-modal="true"
        className="flex max-h-[70vh] w-[min(640px,100%)] flex-col self-start overflow-hidden rounded-[var(--radius-2xl)] bg-[var(--surface-raised)] shadow-[var(--shadow-modal)] motion-safe:animate-ui-pop"
        ref={panelRef}
        role="dialog"
        tabIndex={-1}
      >
        <div className="flex items-center gap-2.5 border-b border-[var(--border-subtle)] px-4">
          <Search aria-hidden="true" className="size-[18px] shrink-0 text-[var(--text-tertiary)]" />
          <input
            aria-activedescendant={flat.length ? `${optionId}-${active}` : undefined}
            aria-autocomplete="list"
            aria-controls={listId}
            aria-expanded="true"
            aria-label="Search"
            autoComplete="off"
            className="h-[54px] min-w-0 flex-1 bg-transparent text-[length:var(--text-size-section)] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-tertiary)]"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder={platform ? "Search workspaces, users, pages…" : "Search chats, knowledge, documents, people…"}
            ref={inputRef}
            role="combobox"
            spellCheck={false}
            value={query}
          />
          <Kbd>Esc</Kbd>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-1.5" id={listId} ref={listRef} role="listbox" aria-label="Results">
          {groups.map((group) => (
            <div aria-label={group.label} key={group.label} role="group">
              <div aria-hidden="true" className="px-2.5 pb-1 pt-2.5 text-[length:var(--text-size-caption)] font-medium text-[var(--text-tertiary)]">
                {group.label}
              </div>
              {group.items.map((item) => {
                index += 1;
                const position = index;
                const Icon = item.icon;
                return (
                  <div
                    aria-selected={position === active}
                    className={cn(
                      "flex min-h-[42px] w-full cursor-pointer items-center gap-3 rounded-[var(--radius-md)] px-2.5 py-2 text-left text-[var(--text-primary)]",
                      position === active && "bg-[var(--surface-hover)]",
                    )}
                    data-index={position}
                    id={`${optionId}-${position}`}
                    key={item.id}
                    onClick={() => run(item)}
                    onPointerMove={() => {
                      if (position !== active) setSelectedId(item.id);
                    }}
                    role="option"
                  >
                    <Icon aria-hidden="true" className="size-[18px] shrink-0 text-[var(--text-tertiary)]" />
                    <span className="min-w-0 flex-1 truncate">{item.label}</span>
                    {item.preview && <PreviewTag />}
                    {item.meta && (
                      <span className="shrink-0 whitespace-nowrap text-[length:var(--text-size-caption)] text-[var(--text-tertiary)]">{item.meta}</span>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
          {flat.length === 0 && (
            <div className="px-6 py-8 text-center" role="status">
              <p className="font-semibold text-[var(--text-primary)]">{searching ? "Searching…" : "No matches"}</p>
              {!searching && <p className="mt-1 text-[var(--text-secondary)]">Try a different word, or ask the assistant.</p>}
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-4 border-t border-[var(--border-subtle)] px-4 py-2 text-[length:var(--text-size-caption)] text-[var(--text-tertiary)]">
          <span><Kbd>↑</Kbd> <Kbd>↓</Kbd> to move</span>
          <span><Kbd>Enter</Kbd> to open</span>
          <span><Kbd>Esc</Kbd> to close</span>
          <span aria-live="polite" className="ml-auto">{searching && flat.length > 0 ? "Searching…" : ""}</span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
