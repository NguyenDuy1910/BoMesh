"use client";

import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import { ApiError, resourceId } from "@/lib/api/client";
import { plural } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";
import { getItem, listMaterials, listRootCollections, type Item } from "@/modules/knowledge/api";

import {
  listAnnouncements,
  listJoinRequests,
  listMyJoinRequests,
  listMyRepliesNeeded,
  listRequestTypes,
  listSpaceArtifacts,
  listSpaceEvents,
  listSpaceMembers,
  listSpaceQueue,
  listSpaces,
  getSpace,
  testSpacePermissions,
  type SpaceEvent,
  type SpacePermission,
} from "./api";
import { isStaffRole, spaceTypesOf, type Space } from "./types";

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

/** Every space the caller can see (their own, open and discoverable ones), live only. */
export function useSpaces() {
  const { id, hasModule } = useWorkspace();
  return useQuery({
    queryKey: spacesKeys.list(id),
    queryFn: () => listSpaces(id),
    select: (spaces: Space[]) => spaces.filter((s) => s.state !== "DELETED"),
    enabled: hasModule("spaces"),
    staleTime: 30_000,
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
    queryKey: spacesKeys.list(id),
    queryFn: () => listSpaces(id),
    select: (spaces: Space[]) =>
      spaces
        .filter((s) => s.state !== "DELETED" && !!s.callerRole)
        .sort((a, b) => rank(a) - rank(b) || (a.displayName ?? "").localeCompare(b.displayName ?? "")),
    enabled: hasModule("spaces"),
    staleTime: 30_000,
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

export function useSpaceMembers(spaceId: string, enabled = true) {
  const { id } = useWorkspace();
  return useQuery({ queryKey: spacesKeys.members(id, spaceId), queryFn: () => listSpaceMembers(id, spaceId), enabled });
}

export function useAnnouncements(spaceId: string, enabled = true) {
  const { id } = useWorkspace();
  return useQuery({ queryKey: spacesKeys.announcements(id, spaceId), queryFn: () => listAnnouncements(id, spaceId), enabled });
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

export function useSpaceQueue(spaceId: string, enabled = true) {
  const { id, hasModule } = useWorkspace();
  return useQuery({ queryKey: spacesKeys.queue(id, spaceId), queryFn: () => listSpaceQueue(id, spaceId), enabled: enabled && hasModule("requests") });
}

export function useJoinRequests(spaceId: string, enabled = true) {
  const { id } = useWorkspace();
  return useQuery({ queryKey: spacesKeys.joinRequests(id, spaceId), queryFn: () => listJoinRequests(id, spaceId), enabled });
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

export function useSpaceArtifacts(spaceId: string, enabled = true) {
  const { id, hasModule } = useWorkspace();
  return useQuery({ queryKey: spacesKeys.artifacts(id, spaceId), queryFn: () => listSpaceArtifacts(id, spaceId), enabled: enabled && hasModule("work") });
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
          const events = await listSpaceEvents(id, sid, since).catch(() => []);
          for (const e of events) {
            out.push({
              id: e.name ?? `${sid}-${e.title}`,
              title: e.title,
              at: e.startTime,
              kind: "event",
              space: sid,
              spaceName: s.displayName,
              action: scope ? undefined : { label: "Open", href: `/space/${sid}` },
              event: e,
            });
          }
          if (queue && hasModule("requests") && isStaffRole(s.callerRole)) {
            const open = (await listSpaceQueue(id, sid).catch(() => [])).filter((r) => r.state === "OPEN");
            if (open.length) {
              const time = (r: (typeof open)[number]) => r.dueTime ?? r.createTime ?? "";
              const oldest = open.reduce((a, b) => (time(a) <= time(b) ? a : b));
              const questions = open.every((r) => r.kind === "QUESTION");
              out.push({
                id: `queue-${sid}`,
                title: `${plural(open.length, questions ? "question" : "request")} waiting`,
                at: time(oldest),
                kind: "queue",
                space: sid,
                spaceName: s.displayName,
                action: { label: "Review queue", href: `/space/${sid}?tab=queue` },
              });
            }
          }
        }),
      );
      if (hasModule("requests")) {
        const replies = await listMyRepliesNeeded(id, memberId).catch(() => []);
        for (const r of replies) {
          const sid = resourceId(r.space);
          if (scope && sid !== scope) continue;
          out.push({
            id: r.name ?? "",
            title: r.title || r.question || "Request",
            at: r.updateTime ?? r.createTime ?? "",
            kind: "reply",
            space: sid || undefined,
            spaceName: (spaces.data ?? []).find((s) => resourceId(s.name) === sid)?.displayName,
            action: { label: "Reply", href: `/requests/${resourceId(r.name)}`, strong: true },
          });
        }
      }
      return out
        .sort((a, b) => Number(b.kind === "reply") - Number(a.kind === "reply") || Date.parse(a.at) - Date.parse(b.at))
        .slice(0, limit);
    },
  });
}

/* ═══════════════ Knowledge bases a space can link ═══════════════ */

export interface LinkableBase {
  base: Item;
  /** The caller may change its `collection.space` (editor or owner). */
  editable: boolean;
  /** The caller can read it (not LOCKED). */
  readable: boolean;
}

/** Shared knowledge bases (no personal "My files"), with what the caller may do with them. */
export function useLinkableBases(enabled = true) {
  const { id } = useWorkspace();
  return useQuery({
    queryKey: [id, "spaces", "linkableBases"],
    enabled,
    queryFn: () => listRootCollections(id, { showLocked: true }),
    select: (bases): LinkableBase[] =>
      bases
        .filter((b) => b.collection?.kind !== "PERSONAL")
        .map((base) => ({ base, readable: base.access !== "LOCKED", editable: base.access === "EDITOR" || base.access === "OWNER" })),
  });
}

/** The knowledge bases linked to a space (`Space.collections`), as items; unreadable ones come back LOCKED or are skipped. */
export function useSpaceBases(space: Space | undefined) {
  const { id } = useWorkspace();
  const names = space?.collections ?? [];
  return useQuery({
    queryKey: [id, "spaces", "bases", resourceId(space?.name), names.join(",")],
    enabled: !!space,
    queryFn: async () => (await Promise.all(names.map((n) => getItem(id, resourceId(n), "BASIC").catch(() => null)))).filter((b): b is Item => !!b),
  });
}

export interface SpaceMaterial {
  material: string;
  item: Item;
}

/** Resources pinned to the space (`…/materials`), resolved to items; items the caller can't see are omitted. */
export function useSpaceMaterials(spaceId: string, enabled = true) {
  const { id } = useWorkspace();
  return useQuery({
    queryKey: [id, "spaces", "materials", spaceId],
    enabled,
    queryFn: async (): Promise<SpaceMaterial[]> => {
      const materials = await listMaterials(id, spaceId);
      const rows = await Promise.all(
        materials.map(async (m) => {
          const item = await getItem(id, resourceId(m.item), "FULL").catch(() => null);
          return item && m.name ? { material: m.name, item } : null;
        }),
      );
      return rows.filter((r): r is SpaceMaterial => !!r);
    },
  });
}
