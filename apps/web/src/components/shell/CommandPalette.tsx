"use client";

import { Autocomplete, Button, Header, Input, Kbd, ListBox, Modal, TextField, type Key } from "@heroui/react";
import { useQuery } from "@tanstack/react-query";
import {
  BookOpen,
  Building,
  Inbox,
  List,
  Lock,
  MessageSquare,
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
import type { Messages } from "@/i18n/messages";
import { api, call, resourceId, type Schema } from "@/lib/api/client";
import { useDebounced } from "@/lib/debounce";
import { plural, rel } from "@/lib/format";
import { useMessages } from "@/lib/i18n";
import {
  activitySections,
  isComingSoon,
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
import { useUnreadNotificationCount } from "@/modules/inbox/queries";
import { spaceType } from "@/modules/spaces";
import { spacesListQuery } from "@/modules/spaces/queries";

import { useNavBadges, useStudioSections } from "./badges";
import { startNewChat } from "./newChat";
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

/** AIP-160 case-insensitive substring match. */
const contains = (field: string, q: string) => `${field} = ${JSON.stringify(`*${q}*`)}`;

/** Workspace data the palette searches; loaded while it is open. Each group reads one small page. */
function useWorkspaceSources(ws: WorkspaceContextValue, enabled: boolean, q: string) {
  const path = { workspace: ws.id };
  const conversations = useQuery({
    queryKey: [ws.id, "conversations", "palette", q],
    enabled,
    staleTime: STALE,
    queryFn: () =>
      call(
        api.GET("/api/v1/workspaces/{workspace}/conversations", {
          params: { path, query: q ? { pageSize: 4, orderBy: "lastMessageTime desc", filter: contains("displayName", q) } : { pageSize: 3, orderBy: "lastMessageTime desc" } },
        }),
      ),
  });
  const bases = useQuery({
    queryKey: [ws.id, "items", "roots", "palette", q],
    enabled: enabled && Boolean(q),
    staleTime: STALE,
    queryFn: () =>
      call(
        api.GET("/api/v1/workspaces/{workspace}/items", {
          params: { path, query: { pageSize: 4, filter: `parentItem = "" AND itemKind = COLLECTION AND ${contains("displayName", q)}`, orderBy: "displayName", showLocked: true } },
        }),
      ),
  });
  const spaces = useQuery({
    ...spacesListQuery(ws.id),
    select: (list) => list.filter((s) => s.state !== "DELETED"),
    enabled: enabled && ws.hasModule("spaces"),
  });
  const people = useQuery({
    queryKey: [ws.id, "members", "palette", q],
    enabled: enabled && Boolean(q) && ws.can("members.create"),
    staleTime: STALE,
    queryFn: () =>
      call(
        api.GET("/api/v1/workspaces/{workspace}/members", {
          params: { path, query: { pageSize: 4, filter: `${contains("displayName", q)} OR ${contains("email", q)}`, orderBy: "displayName" } },
        }),
      ),
  });
  const work = useQuery({
    queryKey: [ws.id, "artifacts", "palette", q],
    enabled: enabled && Boolean(q) && ws.hasModule("work"),
    staleTime: STALE,
    queryFn: () =>
      call(api.GET("/api/v1/workspaces/{workspace}/artifacts", { params: { path, query: { pageSize: 4, filter: contains("displayName", q), orderBy: "updateTime desc" } } })),
  });
  const documents = useQuery({
    queryKey: [ws.id, "items:search", "palette", q],
    enabled: enabled && Boolean(q),
    staleTime: STALE,
    queryFn: () => call(api.POST("/api/v1/workspaces/{workspace}/items:search", { params: { path }, body: { query: q, pageSize: 5 } })),
  });
  return {
    conversations: conversations.data?.conversations ?? [],
    bases: q ? (bases.data?.items ?? []) : [],
    spaces: spaces.data ?? [],
    people: people.data?.members ?? [],
    work: work.data?.artifacts ?? [],
    documents: (documents.data?.results ?? []).map((r) => r.item).filter((i): i is Schema<"Item"> => Boolean(i)),
  };
}

function usePlatformSources(enabled: boolean, q: string) {
  const workspaces = useQuery({
    queryKey: ["platform", "workspaces", "palette", q],
    enabled,
    staleTime: STALE,
    queryFn: () => call(api.GET("/api/v1/workspaces", { params: { query: { pageSize: 6, orderBy: "displayName", filter: q ? contains("displayName", q) : undefined } } })),
  });
  const users = useQuery({
    queryKey: ["platform", "users", "palette", q],
    enabled: enabled && Boolean(q),
    staleTime: STALE,
    queryFn: () => call(api.GET("/api/v1/users", { params: { query: { pageSize: 5, filter: `${contains("displayName", q)} OR ${contains("email", q)}`, orderBy: "displayName" } } })),
  });
  return { workspaces: workspaces.data?.workspaces ?? [], users: users.data?.users ?? [] };
}

const toItems = (prefix: string, items: NavItem[], go: (href: string) => void, msg: Messages): PaletteItem[] =>
  items.map((n) => ({ id: `${prefix}:${n.id}`, label: n.label(msg), icon: n.icon, run: () => go(n.href) }));

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
  const msg = useMessages();
  const debounced = useDebounced(q.trim(), 200);
  const src = useWorkspaceSources(ws, enabled, debounced);
  const badges = useNavBadges();
  const studio = useStudioSections();
  const unread = useUnreadNotificationCount().data ?? 0;
  const query = q.trim();

  return useMemo(() => {
    const fq = fold(query);
    const m = (s: string | undefined) => !query || fold(s ?? "").includes(fq);
    const mt = (x: PaletteItem) => m(x.label);
    /** Word-start match on the label ("thô" → Thông báo, "tối" → Chuyển sang chế độ tối). */
    const strong = (x: PaletteItem) => Boolean(query) && ` ${fold(x.label)}`.includes(` ${fq}`);
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
    // New chat is its page row (with the shortcut, starting a fresh chat), not a second action row.
    const withKids = (n: NavItem): PageRow[] => [
      n.id === "chat"
        ? { id: `page:${n.id}`, label: n.label(msg), icon: n.icon, meta: "⌘⇧O", run: () => startNewChat(go) }
        : { id: `page:${n.id}`, label: n.label(msg), icon: n.icon, meta: isComingSoon(n) ? "Sắp ra mắt" : undefined, run: () => go(n.href) },
      ...(query
        ? sectionsOf(n).map((k) => ({ id: `page:${n.id}:${k.id}`, label: k.label(msg), icon: n.icon, meta: n.label(msg), run: () => go(k.href) }))
        : []),
    ];
    const pages: PageRow[] = [
      { id: "page:inbox", label: msg.nav.inbox, icon: Inbox, meta: unread ? msg.nav.unread({ count: unread }) : undefined, run: openInbox },
      ...[...memberNav(ws), ...yourWorkNav(ws, badges.hasContributions, projectsAvailable), ...manageNav(ws, studio.length > 0)].flatMap(withKids),
      ...(isPlatformOperator(session)
        ? [{ id: "page:platform", label: PLATFORM_CONSOLE.label(msg), icon: PLATFORM_CONSOLE.icon, run: () => go(PLATFORM_CONSOLE.href) }]
        : []),
    ];
    const goTo = pages
      .filter(mt)
      .sort((x, y) => Number(strong(y)) - Number(strong(x)))
      .slice(0, query ? 6 : 4);

    const dark = resolvedMode() === "dark";
    const actions = (
      [
        ws.can("contributions.create") && { id: "contribute", label: "Gửi tài liệu", icon: Upload, run: () => openContribute() },
        ws.can("items.create") && { id: "kb-create", label: "Tạo kho tài liệu", icon: BookOpen, run: () => go("/studio?tab=collections&new=1") },
        ws.can("sources.create") && { id: "src-add", label: "Thêm nguồn dữ liệu", icon: Plug, run: () => go("/studio?tab=sources&connect=1") },
        ws.can("members.create") && { id: "member-add", label: "Thêm người", icon: UserPlus, run: () => go("/people?tab=members&add=1") },
        { id: "mode", label: dark ? "Chuyển sang chế độ sáng" : "Chuyển sang chế độ tối", icon: dark ? Sun : Moon, run: () => setMode(dark ? "light" : "dark") },
        { id: "appearance", label: "Giao diện", icon: Palette, meta: themeLabel(getAppearance().look), run: openAppearance },
      ] as (PaletteItem | false)[]
    ).filter((a): a is PaletteItem => Boolean(a) && mt(a as PaletteItem));

    const conversations = src.conversations.map((c) => ({
      id: `conv:${c.name}`,
      label: c.displayName || "Trò chuyện mới",
      icon: MessageSquare,
      meta: c.lastMessageTime ? rel(c.lastMessageTime) : undefined,
      content: Boolean(c.displayName),
      run: () => go(`/chat/${resourceId(c.name)}`),
    }));

    if (!query) {
      add("Đi đến", goTo);
      add("Cuộc trò chuyện gần đây", conversations.slice(0, 3));
      add("Thao tác", actions.slice(0, 4));
      return out;
    }

    const question = isQuestion(query);
    const hits = question ? [] : [...goTo, ...actions].filter(strong).slice(0, 3);
    add("Phù hợp nhất", hits);
    const search: PaletteItem = { id: "search-docs", label: `Tìm tài liệu cho “${query}”`, icon: Search, meta: "Tài liệu", run: () => go(catalogHref({ q: query })) };
    const ask: PaletteItem = { id: "ask", label: `Hỏi AI “${query}”`, icon: Sparkles, meta: "Trả lời kèm nguồn", run: () => go(`/chat?q=${enc}`) };
    add("Tìm kiếm hoặc hỏi", question ? [ask, search] : [search, ask]);
    add(
      "Tài liệu",
      src.documents.slice(0, 5).map((d) => ({
        id: `doc:${d.name}`,
        label: d.displayName ?? "",
        icon: BookOpen,
        meta: d.ancestors?.[0]?.displayName,
        content: true,
        run: () => go(`/doc/${resourceId(d.name)}?q=${enc}`),
      })),
    );
    add("Cuộc trò chuyện", conversations.filter((c) => c.content && m(c.label)).slice(0, 4));
    // A collection opens its documents in Knowledge (your own: My files); a locked one asks for access there.
    add(
      "Kho tài liệu",
      src.bases
        .filter((k) => m(k.displayName))
        .slice(0, 4)
        .map((k) => {
          const personal = k.itemType === "PERSONAL";
          const locked = k.access === "LOCKED";
          return {
            id: `kb:${k.name}`,
            label: personal ? msg.nav.myFiles : (k.displayName ?? ""),
            icon: personal ? User : locked ? Lock : BookOpen,
            meta: locked ? "Yêu cầu quyền truy cập" : plural(k.collection?.documentCount ?? 0, "document"),
            content: !personal,
            run: () => go(personal ? "/knowledge/library?tab=files" : catalogHref({ filters: { kb: [resourceId(k.name)] } })),
          };
        }),
    );
    if (ws.hasModule("spaces"))
      add(
        "Cộng đồng",
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
        "Công việc",
        src.work
          .filter((w) => m(w.displayName))
          .slice(0, 4)
          .map((w) => ({ id: `work:${w.name}`, label: w.displayName ?? "", icon: Sparkles, content: true, run: () => go(`/work/${resourceId(w.name)}`) })),
      );
    if (ws.can("members.create"))
      add(
        "Thành viên",
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
    add("Đi đến", goTo.filter((x) => !hits.includes(x)));
    add("Thao tác", actions.filter((x) => !hits.includes(x)));
    add("Thêm", [{ id: "search", label: `Xem tất cả kết quả cho “${query}”`, icon: List, run: () => go(`/search?q=${enc}`) }]);
    return out;
  }, [query, src, ws, session, router, msg, badges.hasContributions, studio, unread]);
}

function usePlatformGroups(q: string, enabled: boolean): PaletteGroup[] {
  const router = useRouter();
  const msg = useMessages();
  const query = q.trim();
  const src = usePlatformSources(enabled, useDebounced(query, 200));
  return useMemo(() => {
    const lower = query.toLowerCase();
    const m = (s: string | undefined) => !lower || (s ?? "").toLowerCase().includes(lower);
    const go = (href: string) => router.push(href);
    const out: PaletteGroup[] = [];
    const add = (group: string, items: PaletteItem[]) => items.length && out.push({ group, items });
    add(
      "Không gian làm việc",
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
        "Người dùng",
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
    add("Đi đến", toItems("p", [...PLATFORM_NAV], go, msg).filter((x) => m(x.label)));
    return out;
  }, [query, src, router, msg]);
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
        <Modal.Dialog className={touch ? "palette palette--touch" : "palette"} aria-label="Tìm kiếm">
          <Autocomplete.Filter inputValue={q} onInputChange={setQ}>
            <TextField aria-label="Tìm kiếm" className="palette__input" autoFocus>
              <Search className="i i-lg" aria-hidden />
              <Input ref={input} placeholder={placeholder} autoComplete="off" />
              {touch ? (
                <Button size="sm" variant="ghost" onPress={closeOverlay}>
                  Hủy
                </Button>
              ) : (
                <Kbd>
                  <Kbd.Content>Esc</Kbd.Content>
                </Kbd>
              )}
            </TextField>
            <ListBox
              aria-label="Kết quả"
              className="palette__list"
              onAction={run}
              renderEmptyState={() => <EmptyState icon={Search} title="Không có kết quả" description="Hãy thử từ khác." compact />}
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
              để chuyển
            </span>
            <span>
              <Kbd>
                <Kbd.Content>↵</Kbd.Content>
              </Kbd>{" "}
              để mở
            </span>
            <span>
              <Kbd>
                <Kbd.Content>Esc</Kbd.Content>
              </Kbd>{" "}
              để đóng
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
  return <PaletteDialog isOpen={isOpen} q={q} setQ={setQ} groups={groups} placeholder="Tìm, hỏi hoặc đi đến…" />;
}

function PlatformPalette() {
  const { isOpen, q, setQ } = usePaletteQuery();
  const operator = isPlatformOperator(useSession());
  const groups = usePlatformGroups(q, isOpen && operator);
  return <PaletteDialog isOpen={isOpen} q={q} setQ={setQ} groups={groups} placeholder="Tìm không gian làm việc, người dùng, trang…" />;
}

/** ⌘K: one search for everything the caller may open (preview `paletteResults`). */
export function CommandPalette({ mode }: { mode: Exclude<ShellMode, "auth"> }) {
  const ws = useOptionalWorkspace();
  return mode === "workspace" && ws ? <WorkspacePalette ws={ws} /> : <PlatformPalette />;
}
