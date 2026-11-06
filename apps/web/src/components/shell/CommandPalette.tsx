"use client";

import { Autocomplete, Header, Input, Kbd, ListBox, Modal, TextField, type Key } from "@heroui/react";
import { useQuery } from "@tanstack/react-query";
import {
  BookOpen,
  Building,
  Filter,
  Globe,
  List,
  ListPlus,
  MessageSquare,
  MessageSquarePlus,
  Moon,
  Palette,
  Plug,
  Search,
  Sparkles,
  Sun,
  Upload,
  User,
  UserPlus,
  type LucideIcon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { EmptyState } from "@/components/ui/EmptyState";
import { api, call, listAll, resourceId, type Schema } from "@/lib/api/client";
import { plural, rel } from "@/lib/format";
import { tr, useLanguage } from "@/lib/i18n";
import { manageNav, memberNav, MORE_PAGES, PLATFORM_CONSOLE, PLATFORM_NAV, SPACES_NAV, type NavItem, type ShellMode } from "@/lib/navigation";
import { isPlatformOperator, useSession } from "@/lib/session";
import { resolvedMode, setMode } from "@/lib/theme";
import { useOptionalWorkspace, type WorkspaceContextValue } from "@/lib/workspace";
import { roleLabel } from "@/modules/auth/api";
import { openContribute } from "@/modules/knowledge/components/Contribute";
import { openReadingListEditor } from "@/modules/knowledge/components/dialogs";
import { spaceType } from "@/modules/spaces";

import { changeLanguage } from "./LanguagePicker";
import { closeOverlay, openAppearance, useShellOverlays } from "./overlays";

interface PaletteItem {
  id: string;
  label: string;
  icon: LucideIcon;
  meta?: string;
  /** The label is workspace content (titles, names): never translated. */
  content?: boolean;
  run: () => void;
}
interface PaletteGroup {
  group: string;
  items: PaletteItem[];
}

const STALE = 60_000;

/** The query, debounced for server search. */
function useDebounced(value: string, ms: number): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

/** Workspace data the palette searches; loaded while it is open. */
function useWorkspaceSources(ws: WorkspaceContextValue, enabled: boolean, q: string) {
  const path = { workspace: ws.id };
  const conversations = useQuery({
    queryKey: [ws.id, "conversations", "palette"],
    enabled,
    staleTime: STALE,
    queryFn: () => call(api.GET("/api/v1/workspaces/{workspace}/conversations", { params: { path, query: { pageSize: 100, orderBy: "lastMessageTime desc" } } })),
  });
  const collections = useQuery({
    queryKey: [ws.id, "readingLists", "palette"],
    enabled,
    staleTime: STALE,
    queryFn: () => call(api.GET("/api/v1/workspaces/{workspace}/readingLists", { params: { path, query: { pageSize: 200, orderBy: "updateTime desc" } } })),
  });
  const bases = useQuery({
    queryKey: [ws.id, "items", "roots", "palette"],
    enabled,
    staleTime: STALE,
    queryFn: () => call(api.GET("/api/v1/workspaces/{workspace}/items", { params: { path, query: { pageSize: 200, filter: 'parentItem = ""' } } })),
  });
  const spaces = useQuery({
    queryKey: [ws.id, "spaces", "palette"],
    enabled: enabled && ws.hasModule("spaces"),
    staleTime: STALE,
    queryFn: () => call(api.GET("/api/v1/workspaces/{workspace}/spaces", { params: { path, query: { pageSize: 200 } } })),
  });
  const people = useQuery({
    queryKey: [ws.id, "members", "palette"],
    enabled: enabled && Boolean(q) && ws.can("members.create"),
    staleTime: STALE,
    queryFn: () =>
      listAll(
        (pageToken) => call(api.GET("/api/v1/workspaces/{workspace}/members", { params: { path, query: { pageSize: 500, pageToken } } })),
        (page) => page.members,
      ),
  });
  const work = useQuery({
    queryKey: [ws.id, "artifacts", "palette"],
    enabled: enabled && Boolean(q) && ws.hasModule("work"),
    staleTime: STALE,
    queryFn: () => call(api.GET("/api/v1/workspaces/{workspace}/artifacts", { params: { path, query: { pageSize: 200, orderBy: "updateTime desc" } } })),
  });
  const documents = useQuery({
    queryKey: [ws.id, "items:search", "palette", q],
    enabled: enabled && Boolean(q),
    staleTime: STALE,
    queryFn: () => call(api.POST("/api/v1/workspaces/{workspace}/items:search", { params: { path }, body: { query: q, pageSize: 5 } })),
  });
  return {
    conversations: conversations.data?.conversations ?? [],
    collections: collections.data?.readingLists ?? [],
    bases: (bases.data?.items ?? []).filter((i) => i.itemType === "COLLECTION"),
    spaces: spaces.data?.spaces ?? [],
    people: people.data ?? [],
    work: work.data?.artifacts ?? [],
    documents: (documents.data?.results ?? []).map((r) => r.item).filter((i): i is Schema<"Item"> => Boolean(i)),
  };
}

function usePlatformSources(enabled: boolean, q: string) {
  const workspaces = useQuery({
    queryKey: ["platform", "workspaces", "palette"],
    enabled,
    staleTime: STALE,
    queryFn: () => call(api.GET("/api/v1/workspaces", { params: { query: { pageSize: 500 } } })),
  });
  const users = useQuery({
    queryKey: ["platform", "users", "palette"],
    enabled: enabled && Boolean(q),
    staleTime: STALE,
    queryFn: () => call(api.GET("/api/v1/users", { params: { query: { pageSize: 500 } } })),
  });
  return { workspaces: workspaces.data?.workspaces ?? [], users: users.data?.users ?? [] };
}

const toItems = (prefix: string, items: NavItem[], go: (href: string) => void): PaletteItem[] =>
  items.map((n) => ({ id: `${prefix}:${n.id}`, label: n.label, icon: n.icon, run: () => go(n.href) }));

function useWorkspaceGroups(ws: WorkspaceContextValue, q: string, enabled: boolean): PaletteGroup[] {
  const router = useRouter();
  const session = useSession();
  const [language] = useLanguage();
  const debounced = useDebounced(q.trim(), 200);
  const src = useWorkspaceSources(ws, enabled, debounced);
  const query = q.trim();
  const lower = query.toLowerCase();

  return useMemo(() => {
    const m = (s: string | undefined) => !lower || (s ?? "").toLowerCase().includes(lower);
    // Pages and actions also match their interface-language label (preview `m(tr(label))`).
    const mt = (s: string) => m(s) || m(tr(s) ?? "");
    const go = (href: string) => router.push(href);
    const out: PaletteGroup[] = [];
    const add = (group: string, items: PaletteItem[]) => items.length && out.push({ group, items });
    const enc = encodeURIComponent(query);

    if (query) add("Ask", [{ id: "ask", label: `Ask “${query}”`, icon: Sparkles, run: () => go(`/chat?q=${enc}`) }]);
    add(
      "Conversations",
      src.conversations
        .filter((c) => m(c.displayName))
        .slice(0, query ? 5 : 3)
        .map((c) => ({
          id: `conv:${c.name}`,
          label: c.displayName || "New chat",
          icon: MessageSquare,
          meta: c.lastMessageTime ? rel(c.lastMessageTime) : undefined,
          content: Boolean(c.displayName),
          run: () => go(`/chat/${resourceId(c.name)}`),
        })),
    );
    if (query)
      add(
        "Resources",
        src.documents.slice(0, 5).map((d) => ({
          id: `doc:${d.name}`,
          label: d.displayName ?? "",
          icon: BookOpen,
          meta: d.ancestors?.[0]?.displayName,
          content: true,
          run: () => go(`/doc/${resourceId(d.name)}?q=${enc}`),
        })),
      );
    if (query) add("Browse", [{ id: "browse", label: `Browse knowledge for “${query}”`, icon: Filter, run: () => go(`/knowledge?q=${enc}`) }]);
    add(
      "Collections",
      src.collections
        .filter((c) => m(c.displayName))
        .slice(0, query ? 3 : 2)
        .map((c) => ({
          id: `col:${c.name}`,
          label: c.displayName ?? "",
          icon: List,
          meta: plural(c.itemCount ?? 0, "item"),
          content: true,
          run: () => go(`/knowledge/collections/${resourceId(c.name)}`),
        })),
    );
    add(
      "Knowledge bases",
      src.bases
        .filter((k) => m(k.displayName))
        .slice(0, query ? 4 : 2)
        .map((k) => ({
          id: `kb:${k.name}`,
          label: k.displayName ?? "",
          icon: k.collection?.kind === "PERSONAL" ? User : BookOpen,
          meta: plural(k.collection?.documentCount ?? 0, "document"),
          content: k.collection?.kind !== "PERSONAL",
          run: () => go(`/knowledge/${resourceId(k.name)}`),
        })),
    );
    if (query && ws.can("members.create"))
      add(
        "People",
        src.people
          .filter((p) => m(p.displayName) || m(p.email))
          .slice(0, 4)
          .map((p) => ({
            id: `member:${p.name}`,
            label: p.displayName || p.email || "",
            icon: User,
            meta: roleLabel(p.roles),
            content: true,
            run: () => go(`/people?member=${resourceId(p.name)}`),
          })),
      );
    if (ws.hasModule("spaces"))
      add(
        "Spaces",
        src.spaces
          .filter((s) => m(s.displayName))
          .slice(0, query ? 5 : 3)
          .map((s) => {
            const type = spaceType(s.spaceType, ws.settings);
            return {
              id: `space:${s.name}`,
              label: s.displayName,
              icon: type.icon,
              meta: type.label,
              content: true,
              run: () => go(`/space/${resourceId(s.name)}`),
            };
          }),
      );
    if (query && ws.hasModule("work"))
      add(
        "Work",
        src.work
          .filter((w) => m(w.displayName))
          .slice(0, 4)
          .map((w) => ({ id: `work:${w.name}`, label: w.displayName ?? "", icon: Sparkles, content: true, run: () => go(`/work/${resourceId(w.name)}`) })),
      );
    const pages = [
      ...memberNav(ws),
      ...MORE_PAGES,
      ...(ws.hasModule("spaces") ? [SPACES_NAV] : []),
      ...manageNav(ws),
      ...(isPlatformOperator(session) ? [PLATFORM_CONSOLE] : []),
    ];
    add("Go to", toItems("page", pages.filter((p) => mt(p.label)).slice(0, query ? 6 : 4), go));
    const dark = resolvedMode() === "dark";
    const vi = language === "vi";
    const actions: (PaletteItem | false)[] = [
      { id: "new-chat", label: "New chat", icon: MessageSquarePlus, run: () => go("/chat") },
      ws.can("items.create") && { id: "kb-create", label: "Create knowledge base", icon: BookOpen, run: () => go("/knowledge/bases?create=1") },
      { id: "col-new", label: "New collection", icon: ListPlus, run: () => openReadingListEditor() },
      { id: "contribute", label: "Contribute a document", icon: Upload, run: () => openContribute() },
      ws.can("sources.create") && { id: "src-connect", label: "Connect a source", icon: Plug, run: () => go("/sources?connect=1") },
      ws.can("members.create") && { id: "member-add", label: "Add people", icon: UserPlus, run: () => go("/people?add=1") },
      { id: "mode", label: dark ? "Switch to light theme" : "Switch to dark theme", icon: dark ? Sun : Moon, run: () => setMode(dark ? "light" : "dark") },
      { id: "appearance", label: "Change theme and colors", icon: Palette, run: openAppearance },
      { id: "lang", label: vi ? "Switch to English" : "Switch to Vietnamese (Tiếng Việt)", icon: Globe, run: () => changeLanguage(vi ? "en" : "vi") },
    ];
    add("Actions", actions.filter((a): a is PaletteItem => Boolean(a) && mt((a as PaletteItem).label)));
    if (query) add("More", [{ id: "search", label: `See all results for “${query}”`, icon: Search, run: () => go(`/search?q=${enc}`) }]);
    return out;
  }, [lower, query, src, ws, session, router, language]);
}

function usePlatformGroups(q: string, enabled: boolean): PaletteGroup[] {
  const router = useRouter();
  const query = q.trim();
  const src = usePlatformSources(enabled, query);
  return useMemo(() => {
    const lower = query.toLowerCase();
    const m = (s: string | undefined) => !lower || (s ?? "").toLowerCase().includes(lower);
    const go = (href: string) => router.push(href);
    const out: PaletteGroup[] = [];
    const add = (group: string, items: PaletteItem[]) => items.length && out.push({ group, items });
    add(
      "Workspaces",
      src.workspaces
        .filter((w) => m(w.displayName))
        .slice(0, 6)
        .map((w) => ({
          id: `pws:${w.name}`,
          label: w.displayName,
          icon: Building,
          meta: plural(w.memberCount ?? 0, "member"),
          content: true,
          run: () => go(`/p/workspaces?open=${resourceId(w.name)}`),
        })),
    );
    if (query)
      add(
        "Users",
        src.users
          .filter((u) => m(u.displayName) || m(u.email))
          .slice(0, 5)
          .map((u) => ({
            id: `pu:${u.name}`,
            label: u.displayName || u.email,
            icon: User,
            meta: u.email,
            content: true,
            run: () => go(`/p/users?open=${resourceId(u.name)}`),
          })),
      );
    add("Go to", toItems("p", PLATFORM_NAV.filter((n) => m(n.label)), go));
    return out;
  }, [query, src, router]);
}

/** Open state and query of the palette; the query resets to the requested one each time it opens. */
function usePaletteQuery(): { isOpen: boolean; q: string; setQ: (q: string) => void } {
  const overlays = useShellOverlays();
  const isOpen = overlays.open === "palette";
  const [q, setQ] = useState("");
  useEffect(() => {
    if (isOpen) setQ(overlays.query);
  }, [isOpen, overlays.query]);
  return { isOpen, q, setQ };
}

function PaletteDialog({ isOpen, q, setQ, groups, placeholder }: { isOpen: boolean; q: string; setQ: (q: string) => void; groups: PaletteGroup[]; placeholder: string }) {
  const byId = useMemo(() => new Map(groups.flatMap((g) => g.items).map((it) => [it.id, it])), [groups]);
  const run = (key: Key) => {
    const item = byId.get(String(key));
    closeOverlay();
    item?.run();
  };
  return (
    <Modal.Backdrop isOpen={isOpen} onOpenChange={(o) => !o && closeOverlay()}>
      <Modal.Container placement="top" className="palette-container">
        <Modal.Dialog className="palette" aria-label="Search">
          <Autocomplete.Filter inputValue={q} onInputChange={setQ}>
            <TextField aria-label="Search" className="palette__input" autoFocus>
              <Search className="i i-lg" aria-hidden />
              <Input placeholder={placeholder} autoComplete="off" />
              <Kbd>
                <Kbd.Content>Esc</Kbd.Content>
              </Kbd>
            </TextField>
            <ListBox
              aria-label="Results"
              className="palette__list"
              onAction={run}
              renderEmptyState={() => <EmptyState icon={Search} title="No matches" description="Try a different word." compact />}
            >
              {groups.map((g) => (
                <ListBox.Section key={g.group}>
                  <Header className="palette__group">{g.group}</Header>
                  {g.items.map((it) => {
                    const Icon = it.icon;
                    return (
                      <ListBox.Item key={it.id} id={it.id} textValue={it.label} className="palette__item">
                        <Icon className="i" aria-hidden />
                        <span className="grow truncate" translate={it.content ? "no" : undefined}>
                          {it.label}
                        </span>
                        {it.meta && <span className="palette__item-meta truncate">{it.meta}</span>}
                      </ListBox.Item>
                    );
                  })}
                </ListBox.Section>
              ))}
            </ListBox>
          </Autocomplete.Filter>
          <div className="palette__foot">
            <span>
              <Kbd>
                <Kbd.Content>↑</Kbd.Content>
              </Kbd>{" "}
              <Kbd>
                <Kbd.Content>↓</Kbd.Content>
              </Kbd>{" "}
              to move
            </span>
            <span>
              <Kbd>
                <Kbd.Content>↵</Kbd.Content>
              </Kbd>{" "}
              to open
            </span>
          </div>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}

function WorkspacePalette({ ws }: { ws: WorkspaceContextValue }) {
  const { isOpen, q, setQ } = usePaletteQuery();
  const groups = useWorkspaceGroups(ws, q, isOpen);
  return <PaletteDialog isOpen={isOpen} q={q} setQ={setQ} groups={groups} placeholder="Search or ask anything…" />;
}

function PlatformPalette() {
  const { isOpen, q, setQ } = usePaletteQuery();
  const operator = isPlatformOperator(useSession());
  const groups = usePlatformGroups(q, isOpen && operator);
  return <PaletteDialog isOpen={isOpen} q={q} setQ={setQ} groups={groups} placeholder="Search workspaces, users, pages…" />;
}

/** ⌘K: one search for everything the caller may open (preview `paletteResults`). */
export function CommandPalette({ mode }: { mode: Exclude<ShellMode, "auth"> }) {
  const ws = useOptionalWorkspace();
  return mode === "workspace" && ws ? <WorkspacePalette ws={ws} /> : <PlatformPalette />;
}
