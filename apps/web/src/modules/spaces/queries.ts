"use client";

import { queryOptions, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import { ApiError, resourceId } from "@/lib/api/client";
import { plural } from "@/lib/format";
import { useTokenPages } from "@/lib/paging";
import { useWorkspace } from "@/lib/workspace";
import { batchGetItems, listRootCollections, type Item } from "@/modules/knowledge/api";

import {
  joinRequestsFilter,
  listAnnouncementPage,
  listMaterialPage,
  listMyJoinRequests,
  listMyRepliesNeeded,
  listRequestPage,
  listRequestTypes,
  listSpaceArtifactPage,
  listSpaceEvents,
  listSpaceMemberPage,
  listSpaces,
  getSpace,
  spaceQueueFilter,
  testSpacePermissions,
  type SpaceEvent,
  type SpacePermission,
} from "./api";
import { LEAD, STAFF, isStaffRole, spaceTypesOf, type Space } from "./types";

/** Query keys; every key starts with the workspace ID and `"spaces"` so `invalidateSpaces` refreshes them all. */
export const spacesKeys = {
  all: (ws: string) => [ws, "spaces"] as const,
  list: (ws: string) => [ws, "spaces", "list"] as const,
  one: (ws: string, id: string) => [ws, "spaces", "one", id] as const,
  permissions: (ws: string, id: string) => [ws, "spaces", "permissions", id] as const,
  members: (ws: string, id: string) => [ws, "spaces", "members", id] as const,
  announcements: (ws: string, id: string) => [ws, "spaces", "announcements", id] as const,
  events: (ws: string, id: string) => [ws, "spaces", "events", id] as const,
  requestTypes: (ws: string, id: string) => [ws, "spaces", "requestTypes", id] as const,
  queue: (ws: string, id: string) => [ws, "spaces", "queue", id] as const,
  joinRequests: (ws: string, id: string) => [ws, "spaces", "joinRequests", id] as const,
  myJoinRequests: (ws: string) => [ws, "spaces", "myJoinRequests"] as const,
  artifacts: (ws: string, id: string) => [ws, "spaces", "artifacts", id] as const,
  upNext: (ws: string, scope: string) => [ws, "spaces", "upNext", scope] as const,
};

export function invalidateSpaces(qc: QueryClient, ws: string) {
  return qc.invalidateQueries({ queryKey: spacesKeys.all(ws) });
}

/** Refresh helper bound to the active workspace. */
export function useInvalidateSpaces() {
  const { id } = useWorkspace();
  const qc = useQueryClient();
  return useCallback(() => invalidateSpaces(qc, id), [qc, id]);
}

/**
 * Every space the caller can see, as ListSpaces returns them: the one request and cache entry
 * behind `useSpaces`, `useMySpaces` and any `fetchQuery` that needs the list.
 */
export function spacesListQuery(ws: string) {
  // Every space change goes through `invalidateSpaces`, so the list stays put meanwhile.
  return queryOptions({ queryKey: spacesKeys.list(ws), queryFn: () => listSpaces(ws), staleTime: 10 * 60_000 });
}

/** Every space the caller can see (their own, open and discoverable ones), live only. */
export function useSpaces() {
  const { id, hasModule } = useWorkspace();
  return useQuery({
    ...spacesListQuery(id),
    select: (spaces: Space[]) => spaces.filter((s) => s.state !== "DELETED"),
    enabled: hasModule("spaces"),
  });
}

/** Spaces the caller belongs to, in the workspace's type order then by name (preview `mySpaces()`). */
export function useMySpaces() {
  const { id, hasModule, settings } = useWorkspace();
  const order = spaceTypesOf(settings).map((t) => t.key);
  const rank = (s: Space) => {
    const i = order.indexOf(s.spaceType ?? "");
    return i < 0 ? order.length : i;
  };
  return useQuery({
    ...spacesListQuery(id),
    select: (spaces: Space[]) =>
      spaces
        .filter((s) => s.state !== "DELETED" && !!s.callerRole)
        .sort((a, b) => rank(a) - rank(b) || (a.displayName ?? "").localeCompare(b.displayName ?? "")),
    enabled: hasModule("spaces"),
  });
}

export function useSpace(spaceId: string) {
  const { id } = useWorkspace();
  return useQuery({
    queryKey: spacesKeys.one(id, spaceId),
    queryFn: () => getSpace(id, spaceId),
    enabled: !!spaceId,
    retry: (n, e) => n < 2 && !(e instanceof ApiError),
  });
}

/** What the caller may do in a space (`:testIamPermissions`). */
export function useSpacePermissions(spaceId: string, enabled = true) {
  const { id } = useWorkspace();
  const q = useQuery({ queryKey: spacesKeys.permissions(id, spaceId), queryFn: () => testSpacePermissions(id, spaceId), enabled: enabled && !!spaceId });
  const granted = q.data;
  const can = useCallback((p: SpacePermission) => !!granted?.includes(p), [granted]);
  return { ...q, can };
}

/** One page of a space's members matching `filter` (`roles:`, `displayName`, `member`), by name. */
export function useSpaceMemberPages(spaceId: string, { filter = "", pageSize, enabled = true }: { filter?: string; pageSize: number; enabled?: boolean }) {
  const { id } = useWorkspace();
  return useTokenPages([...spacesKeys.members(id, spaceId), filter, pageSize], (pageToken) => listSpaceMemberPage(id, spaceId, { filter: filter || undefined, orderBy: "displayName", pageSize, pageToken }), {
    enabled: enabled && !!spaceId,
  });
}

/** How many staff a space's pickers and faces read: its leads and staff, a small team. */
const STAFF_PAGE = 50;

/** The space's leads and staff (one page): who answers its requests. */
export function useSpaceStaff(spaceId: string, enabled = true) {
  return useSpaceMemberPages(spaceId, { filter: `roles:"${LEAD}" OR roles:"${STAFF}"`, pageSize: STAFF_PAGE, enabled });
}

/** One page of a space's announcements, pinned first, then newest. */
export function useAnnouncementPages(spaceId: string, pageSize: number, enabled = true) {
  const { id } = useWorkspace();
  return useTokenPages([...spacesKeys.announcements(id, spaceId), pageSize], (pageToken) => listAnnouncementPage(id, spaceId, pageSize, pageToken), { enabled });
}

export function useRequestTypes(spaceId: string, enabled = true) {
  const { id, hasModule } = useWorkspace();
  return useQuery({
    queryKey: spacesKeys.requestTypes(id, spaceId),
    queryFn: () => listRequestTypes(id, spaceId),
    select: (types) => types.filter((t) => t.state !== "DELETED"),
    enabled: enabled && hasModule("requests"),
  });
}

/** Requests in the space's queue that wait on its staff (open or approved), filed by others: one count. */
export function useSpaceQueueWaiting(spaceId: string, enabled = true) {
  const { id, member, hasModule } = useWorkspace();
  const filter = spaceQueueFilter(id, spaceId, `(state = OPEN OR state = APPROVED) AND requester != "${member.name ?? ""}"`);
  return useQuery({
    queryKey: [...spacesKeys.queue(id, spaceId), "waiting"],
    queryFn: async () => (await listRequestPage(id, { filter, pageSize: 1 })).totalSize ?? 0,
    enabled: enabled && hasModule("requests") && !!member.name,
  });
}

/** One page of open requests to join the space (its staff decide them), oldest first. */
export function useJoinRequestPages(spaceId: string, pageSize: number, enabled = true) {
  const { id } = useWorkspace();
  const filter = joinRequestsFilter(id, spaceId);
  return useTokenPages([...spacesKeys.joinRequests(id, spaceId), pageSize], (pageToken) => listRequestPage(id, { filter, orderBy: "createTime", pageSize, pageToken }), { enabled });
}

/** The caller's open requests to join, by bare space ID (preview `myJoinRequest`). */
export function useMyJoinRequests() {
  const { id, memberId, hasModule } = useWorkspace();
  return useQuery({
    queryKey: spacesKeys.myJoinRequests(id),
    queryFn: async () => new Map((await listMyJoinRequests(id, memberId)).map((r) => [resourceId(r.space), r] as const)),
    enabled: hasModule("spaces"),
  });
}

/** One page of the space's work, most recently updated first. */
export function useSpaceArtifactPages(spaceId: string, pageSize: number, enabled = true) {
  const { id, hasModule } = useWorkspace();
  return useTokenPages([...spacesKeys.artifacts(id, spaceId), pageSize], (pageToken) => listSpaceArtifactPage(id, spaceId, pageSize, pageToken), { enabled: enabled && hasModule("work") });
}

/* ═══════════════ Up next (preview `X.upNext`) ═══════════════ */

export type UpNextKind = "event" | "reply" | "queue";

export interface UpNextItem {
  id: string;
  title: string;
  /** ISO time: event start, reply update or the oldest queued due/created time. */
  at: string;
  kind: UpNextKind;
  /** Bare space ID. */
  space?: string;
  spaceName?: string;
  /** The one action for the row. */
  action?: { label: string; href: string; strong?: boolean };
  /** The event behind a `kind: "event"` item (space staff edit/delete it). */
  event?: SpaceEvent;
}

const DAY = 86_400_000;

/**
 * What's coming up for the caller (preview `X.upNext`): events of their spaces (from two days ago),
 * requests that need their reply and, for space staff, a line per non-empty queue.
 */
export function useUpNext({ space, limit = 6, queue = true }: { space?: string; limit?: number; queue?: boolean } = {}) {
  const { id, memberId, hasModule } = useWorkspace();
  const spaces = useSpaces();
  const scope = space ? resourceId(space) : "";
  const inScope = (spaces.data ?? []).filter((s) => (scope ? resourceId(s.name) === scope : !!s.callerRole));
  const scopeKey = inScope.map((s) => `${resourceId(s.name)}:${s.callerRole ?? ""}`).join(",");
  return useQuery({
    queryKey: [...spacesKeys.upNext(id, scope || "mine"), scopeKey, limit, queue],
    enabled: hasModule("spaces") && spaces.isSuccess,
    queryFn: async (): Promise<UpNextItem[]> => {
      const since = new Date(Date.now() - 2 * DAY).toISOString();
      const out: UpNextItem[] = [];
      await Promise.all(
        inScope.map(async (s) => {
          const sid = resourceId(s.name);
          // Only the soonest `limit` of a space can make the list.
          const events = await listSpaceEvents(id, sid, since, limit).catch(() => []);
          for (const e of events) {
            out.push({
              id: e.name ?? `${sid}-${e.title}`,
              title: e.title,
              at: e.startTime,
              kind: "event",
              space: sid,
              spaceName: s.displayName,
              action: scope ? undefined : { label: "Mở", href: `/space/${sid}` },
              event: e,
            });
          }
          if (queue && hasModule("requests") && isStaffRole(s.callerRole)) {
            // The queue line: how many wait (and how many of them are service requests), and the oldest by due date.
            const [oldest, services] = await Promise.all([
              listRequestPage(id, { filter: spaceQueueFilter(id, sid, "state = OPEN"), orderBy: "dueTime, createTime", pageSize: 1 }),
              listRequestPage(id, { filter: spaceQueueFilter(id, sid, "state = OPEN AND kind = SERVICE"), pageSize: 1 }),
            ]).catch(() => [null, null] as const);
            const first = oldest?.requests?.[0];
            const open = oldest?.totalSize ?? 0;
            if (first && open) {
              out.push({
                id: `queue-${sid}`,
                title: `${plural(open, services?.totalSize ? "request" : "question")} đang chờ`,
                at: first.dueTime ?? first.createTime ?? "",
                kind: "queue",
                space: sid,
                spaceName: s.displayName,
                action: { label: "Hàng đợi duyệt", href: `/space/${sid}?tab=queue` },
              });
            }
          }
        }),
      );
      if (hasModule("requests")) {
        const replies = await listMyRepliesNeeded(id, memberId, limit, scope || undefined).catch(() => []);
        for (const r of replies) {
          const sid = resourceId(r.space);
          out.push({
            id: r.name ?? "",
            title: r.title || r.question || "Yêu cầu",
            at: r.updateTime ?? r.createTime ?? "",
            kind: "reply",
            space: sid || undefined,
            spaceName: (spaces.data ?? []).find((s) => resourceId(s.name) === sid)?.displayName,
            action: { label: "Trả lời", href: `/requests/${resourceId(r.name)}`, strong: true },
          });
        }
      }
      return out
        .sort((a, b) => Number(b.kind === "reply") - Number(a.kind === "reply") || Date.parse(a.at) - Date.parse(b.at))
        .slice(0, limit);
    },
  });
}

/* ═══════════════ Collections a space can link ═══════════════ */

export interface LinkableBase {
  base: Item;
  /** The caller edits it (editor or owner): only those are offered to add to a space's materials. */
  editable: boolean;
  /** The caller can read it (not LOCKED). */
  readable: boolean;
}

/** Shared collections (no personal "My files"), with what the caller may do with them. */
export function useLinkableBases(enabled = true) {
  const { id } = useWorkspace();
  return useQuery({
    queryKey: [id, "spaces", "linkableBases"],
    enabled,
    queryFn: () => listRootCollections(id, { showLocked: true }),
    select: (bases): LinkableBase[] => bases.map((base) => ({ base, readable: base.access !== "LOCKED", editable: base.access === "EDITOR" || base.access === "OWNER" })),
  });
}

/** The collections among a space's materials (`Space.collections`), as items; unreadable ones come back LOCKED or are skipped. */
export function useSpaceBases(space: Space | undefined) {
  const { id } = useWorkspace();
  const names = space?.collections ?? [];
  return useQuery({
    queryKey: [id, "spaces", "bases", resourceId(space?.name), names.join(",")],
    enabled: !!space,
    queryFn: async () => {
      const found = new Map((await batchGetItems(id, names, { showLocked: true })).map((b) => [resourceId(b.name), b]));
      return names.flatMap((n) => found.get(resourceId(n)) ?? []);
    },
  });
}

export interface SpaceMaterial {
  material: string;
  item: Item;
}

/** Whether anything is pinned to the space (one `pageSize=1` read). */
export function useSpaceHasMaterials(spaceId: string, enabled = true) {
  const { id } = useWorkspace();
  return useQuery({ queryKey: [id, "spaces", "materials", spaceId, "any"], queryFn: async () => ((await listMaterialPage(id, spaceId, 1)).materials ?? []).length > 0, enabled });
}

/** Which of `items` (item names, one page) are already linked to the space: one ListMaterials read by item name. */
export function useSpaceLinkedAmong(spaceId: string, items: readonly string[]) {
  const { id } = useWorkspace();
  const names = [...new Set(items.filter(Boolean))].sort();
  return useQuery({
    queryKey: [id, "spaces", "materials", spaceId, "among", names],
    enabled: names.length > 0,
    queryFn: async () => {
      const page = await listMaterialPage(id, spaceId, names.length, { filter: names.map((n) => `item = "${n}"`).join(" OR ") });
      return new Set((page.materials ?? []).map((m) => m.item ?? ""));
    },
  });
}

/** One page of the resources pinned to the space (`…/materials`, `filter` over their title), resolved to items in one batch read; items the caller can't see are omitted. */
export function useSpaceMaterialPages(spaceId: string, pageSize: number, { filter = "", enabled = true }: { filter?: string; enabled?: boolean } = {}) {
  const { id } = useWorkspace();
  const pages = useTokenPages([id, "spaces", "materials", spaceId, filter, pageSize], (pageToken) => listMaterialPage(id, spaceId, pageSize, { filter: filter || undefined, pageToken }), { enabled });
  const materials = pages.data?.materials;
  const items = useQuery({
    queryKey: [id, "spaces", "materials", spaceId, "items", (materials ?? []).map((m) => resourceId(m.item))],
    enabled: !!materials?.length,
    placeholderData: (prev) => prev,
    queryFn: async (): Promise<SpaceMaterial[]> => {
      const found = new Map((await batchGetItems(id, (materials ?? []).map((m) => m.item ?? ""), { view: "FULL" })).map((i) => [resourceId(i.name), i]));
      return (materials ?? []).flatMap((m) => {
        const item = found.get(resourceId(m.item));
        return item && m.name ? [{ material: m.name, item }] : [];
      });
    },
  });
  return { ...pages, rows: materials && !materials.length ? [] : items.data, itemsPending: items.isPending && items.fetchStatus !== "idle" };
}
