"use client";

import { Autocomplete, Button, Header, Input, Kbd, ListBox, Modal, TextField, type Key } from "@heroui/react";
import { useQuery } from "@tanstack/react-query";
import {
  BookOpen,
  Building,
  Globe,
  Inbox,
  List,
  Lock,
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
import { useEffect, useMemo, useRef, useState } from "react";

import { EmptyState } from "@/components/ui/EmptyState";
import { api, call, listAll, resourceId, type Schema } from "@/lib/api/client";
import { plural, rel } from "@/lib/format";
import { tr, useLanguage } from "@/lib/i18n";
import {
  activitySections,
  librarySections,
  manageNav,
  memberNav,
  peopleSections,
  PLATFORM_CONSOLE,
  PLATFORM_NAV,
  settingsSections,
  yourWorkNav,
  type NavItem,
  type Section,
  type ShellMode,
} from "@/lib/navigation";
import { isPlatformOperator, useSession } from "@/lib/session";
import { getAppearance, resolvedMode, setMode, themeLabel } from "@/lib/theme";
import { useOptionalWorkspace, type WorkspaceContextValue } from "@/lib/workspace";
import { roleLabel } from "@/modules/auth/api";
import { openContribute } from "@/modules/knowledge/components/contribute-store";
import { catalogHref } from "@/modules/knowledge/model";
import { openInbox } from "@/modules/inbox";
import { projectsAvailable } from "@/modules/projects/adapter";
import { useNotifications } from "@/modules/inbox/queries";
import { spaceType } from "@/modules/spaces";
import { spacesListQuery } from "@/modules/spaces/queries";

import { useNavBadges, useStudioSections } from "./badges";
import { changeLanguage } from "./language";
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
  const bases = useQuery({
    queryKey: [ws.id, "items", "roots", "palette"],
    enabled,
    staleTime: STALE,
    queryFn: () => call(api.GET("/api/v1/workspaces/{workspace}/items", { params: { path, query: { pageSize: 200, filter: 'parentItem = ""', showLocked: true } } })),
  });
  const spaces = useQuery({
    ...spacesListQuery(ws.id),
    select: (list) => list.filter((s) => s.state !== "DELETED"),
    enabled: enabled && ws.hasModule("spaces"),
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
    bases: (bases.data?.items ?? []).filter((i) => i.itemKind === "COLLECTION"),
    spaces: spaces.data ?? [],
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

/** Does typed text read like a question? Then Ask AI ranks first; otherwise Search documents does (preview `isQuestion`). */
const QUESTION_RE =
  /^(how|what|when|where|why|who|whom|whose|which|can|could|would|do|does|did|is|are|was|were|should|tell me|explain|summari[sz]e|compare|show me|help me|làm sao|làm thế nào|tại sao|vì sao|khi nào|bao giờ|ở đâu|ai|cái gì|thế nào|như thế nào|có nên|giải thích|tóm tắt|so sánh)(\s|$)/i;
function isQuestion(q: string): boolean {
  const s = q.trim();
  return Boolean(s) && (/[?？]$/.test(s) || QUESTION_RE.test(s) || /\s(không|chưa|gì|nào|sao)$/i.test(s));
}

/** Case- and accent-insensitive text for matching (preview `fold`). */
const fold = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase();

interface PageRow {
  id: string;
  label: string;
  icon: LucideIcon;
  meta?: string;
  run: () => void;
}

/**
 * The workspace palette (preview `paletteResults`). Empty: Go to (Inbox first, then the sidebar's pages in its order),
 * recent conversations and the first actions. Typing: a best match (an exact page or action), then Search documents and
 * Ask AI (Ask first when the text reads like a question), the matching documents, conversations,
 * collections, spaces, work and people, the remaining pages (an area's sections too, named with their parent) and actions.
 */
function useWorkspaceGroups(ws: WorkspaceContextValue, q: string, enabled: boolean): PaletteGroup[] {
  const router = useRouter();
  const session = useSession();
  const [language] = useLanguage();
  const debounced = useDebounced(q.trim(), 200);
  const src = useWorkspaceSources(ws, enabled, debounced);
  const badges = useNavBadges();
  const studio = useStudioSections();
  const unread = (useNotifications().data ?? []).filter((n) => !n.read).length;
  const query = q.trim();

  return useMemo(() => {
    const fq = fold(query);
    const m = (s: string | undefined) => !query || fold(s ?? "").includes(fq);
    // Pages and actions also match their interface-language label (preview `m(tr(label))`).
    const mt = (s: string) => m(s) || m(tr(s) ?? "");
    /** Word-start match on the label or its translation ("inb" → Inbox, "dark" → Switch to dark mode). */
    const strong = (s: string) => Boolean(query) && [s, tr(s) ?? ""].some((x) => ` ${fold(x)}`.includes(` ${fq}`));
    const go = (href: string) => router.push(href);
    const out: PaletteGroup[] = [];
    const add = (group: string, items: PaletteItem[]) => items.length && out.push({ group, items });
    const enc = encodeURIComponent(query);

    const library = librarySections.filter((x) => x.id !== "files" || Boolean(ws.member.personalCollection));
    const sectionsOf = (n: NavItem): Section[] =>
      n.sections === "library"
        ? library
        : n.sections === "studio"
          ? studio
          : n.sections === "people"
            ? [...peopleSections]
            : n.sections === "activity"
              ? [...activitySections]
              : n.sections === "settings"
                ? [...settingsSections]
                : [];
    const withKids = (n: NavItem): PageRow[] => [
      { id: `page:${n.id}`, label: n.label, icon: n.icon, run: () => go(n.href) },
      ...(query ? sectionsOf(n).map((k) => ({ id: `page:${n.id}:${k.id}`, label: k.label, icon: n.icon, meta: n.label, run: () => go(k.href) })) : []),
    ];
    const pages: PageRow[] = [
      { id: "page:inbox", label: "Inbox", icon: Inbox, meta: unread ? `${unread} unread` : undefined, run: openInbox },
      ...[...memberNav(ws), ...yourWorkNav(ws, badges.hasContributions, projectsAvailable), ...manageNav(ws, studio.length > 0)].flatMap(withKids),
      ...(isPlatformOperator(session) ? [{ id: "page:platform", label: PLATFORM_CONSOLE.label, icon: PLATFORM_CONSOLE.icon, run: () => go(PLATFORM_CONSOLE.href) }] : []),
    ];
    const goTo = pages
      .filter((p) => mt(p.label))
      .sort((x, y) => Number(strong(y.label)) - Number(strong(x.label)))
      .slice(0, query ? 6 : 4);

    const dark = resolvedMode() === "dark";
    const vi = language === "vi";
    const actions = (
      [
        { id: "new-chat", label: "New chat", icon: MessageSquarePlus, run: () => go("/chat") },
        ws.can("contributions.create") && { id: "contribute", label: "Contribute a document", icon: Upload, run: () => openContribute() },
        ws.can("items.create") && { id: "kb-create", label: "New collection", icon: BookOpen, run: () => go("/studio?tab=collections&new=1") },
        ws.can("sources.create") && { id: "src-add", label: "Add source", icon: Plug, run: () => go("/studio?tab=sources&connect=1") },
        ws.can("members.create") && { id: "member-add", label: "Add people", icon: UserPlus, run: () => go("/people?tab=members&add=1") },
        { id: "mode", label: dark ? "Switch to light mode" : "Switch to dark mode", icon: dark ? Sun : Moon, run: () => setMode(dark ? "light" : "dark") },
        { id: "appearance", label: "Appearance", icon: Palette, meta: themeLabel(getAppearance().look), run: openAppearance },
        { id: "lang", label: vi ? "Switch to English" : "Switch to Vietnamese (Tiếng Việt)", icon: Globe, run: () => changeLanguage(vi ? "en" : "vi") },
      ] as (PaletteItem | false)[]
    ).filter((a): a is PaletteItem => Boolean(a) && mt((a as PaletteItem).label));

    const conversations = src.conversations.map((c) => ({
      id: `conv:${c.name}`,
      label: c.displayName || "New chat",
      icon: MessageSquare,
      meta: c.lastMessageTime ? rel(c.lastMessageTime) : undefined,
      content: Boolean(c.displayName),
      run: () => go(`/chat/${resourceId(c.name)}`),
    }));

    if (!query) {
      add("Go to", goTo);
      add("Recent conversations", conversations.slice(0, 3));
      add("Actions", actions.slice(0, 4));
      return out;
    }

    const question = isQuestion(query);
    const hits = question ? [] : [...goTo, ...actions].filter((x) => strong(x.label)).slice(0, 3);
    add("Best match", hits);
    const search: PaletteItem = { id: "search-docs", label: `Search documents for “${query}”`, icon: Search, meta: "Knowledge", run: () => go(catalogHref({ q: query })) };
    const ask: PaletteItem = { id: "ask", label: `Ask AI “${query}”`, icon: Sparkles, meta: "Answer with sources", run: () => go(`/chat?q=${enc}`) };
    add("Search or ask", question ? [ask, search] : [search, ask]);
    add(
      "Documents",
      src.documents.slice(0, 5).map((d) => ({
        id: `doc:${d.name}`,
        label: d.displayName ?? "",
        icon: BookOpen,
        meta: d.ancestors?.[0]?.displayName,
        content: true,
        run: () => go(`/doc/${resourceId(d.name)}?q=${enc}`),
      })),
    );
    add("Conversations", conversations.filter((c) => c.content && m(c.label)).slice(0, 4));
    // A collection opens its documents in Knowledge (your own: My files); a locked one asks for access there.
    add(
      "Collections",
      src.bases
        .filter((k) => m(k.displayName))
        .slice(0, 4)
        .map((k) => {
          const personal = k.itemType === "PERSONAL";
          const locked = k.access === "LOCKED";
          return {
            id: `kb:${k.name}`,
            label: personal ? "My files" : (k.displayName ?? ""),
            icon: personal ? User : locked ? Lock : BookOpen,
            meta: locked ? "Request access" : plural(k.collection?.documentCount ?? 0, "document"),
            content: !personal,
            run: () => go(personal ? "/knowledge/library?tab=files" : catalogHref({ filters: { kb: [resourceId(k.name)] } })),
          };
        }),
    );
    if (ws.hasModule("spaces"))
      add(
        "Spaces",
        src.spaces
          .filter((x) => m(x.displayName))
          .slice(0, 5)
          .map((x) => {
            const type = spaceType(x.spaceType, ws.settings);
            return { id: `space:${x.name}`, label: x.displayName, icon: type.icon, meta: type.label, content: true, run: () => go(`/space/${resourceId(x.name)}`) };
          }),
      );
    if (ws.hasModule("work"))
      add(
        "Work",
        src.work
          .filter((w) => m(w.displayName))
          .slice(0, 4)
          .map((w) => ({ id: `work:${w.name}`, label: w.displayName ?? "", icon: Sparkles, content: true, run: () => go(`/work/${resourceId(w.name)}`) })),
      );
    if (ws.can("members.create"))
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
            run: () => go(`/people?tab=members&member=${resourceId(p.name)}`),
          })),
      );
    add("Go to", goTo.filter((x) => !hits.includes(x)));
    add("Actions", actions.filter((x) => !hits.includes(x)));
    add("More", [{ id: "search", label: `See all results for “${query}”`, icon: List, run: () => go(`/search?q=${enc}`) }]);
    return out;
  }, [query, src, ws, session, router, language, badges.hasContributions, studio, unread]);
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
  const input = useRef<HTMLInputElement>(null);
  // Touch devices and phones get a full-screen palette with a Cancel button and no keyboard hints.
  const touch = typeof window !== "undefined" && (window.matchMedia("(hover: none), (pointer: coarse)").matches || document.body.clientWidth < 680);
  const run = (key: Key) => {
    const item = byId.get(String(key));
    closeOverlay();
    item?.run();
  };
  // A result is always highlighted (the one ↵ opens), as in the preview: the filter highlights the first match while typing;
  // with no query, move the virtual focus onto the first row the way ↓ would.
  const empty = !q;
  useEffect(() => {
    if (!isOpen || !empty) return;
    const t = window.setTimeout(() => input.current?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })), 30);
    return () => window.clearTimeout(t);
  }, [isOpen, empty]);
  return (
    <Modal.Backdrop isOpen={isOpen} onOpenChange={(o) => !o && closeOverlay()}>
      <Modal.Container placement="top" className="palette-container">
        <Modal.Dialog className={touch ? "palette palette--touch" : "palette"} aria-label="Search">
          <Autocomplete.Filter inputValue={q} onInputChange={setQ}>
            <TextField aria-label="Search" className="palette__input" autoFocus>
              <Search className="i i-lg" aria-hidden />
              <Input ref={input} placeholder={placeholder} autoComplete="off" />
              {touch ? (
                <Button size="sm" variant="ghost" onPress={closeOverlay}>
                  Cancel
                </Button>
              ) : (
                <Kbd>
                  <Kbd.Content>Esc</Kbd.Content>
                </Kbd>
              )}
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
                        <Kbd className="palette__enter" aria-hidden>
                          <Kbd.Content>↵</Kbd.Content>
                        </Kbd>
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
            <span>
              <Kbd>
                <Kbd.Content>Esc</Kbd.Content>
              </Kbd>{" "}
              to close
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
  return <PaletteDialog isOpen={isOpen} q={q} setQ={setQ} groups={groups} placeholder="Search, ask or go to…" />;
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
