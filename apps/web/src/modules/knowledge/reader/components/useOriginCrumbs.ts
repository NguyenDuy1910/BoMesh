"use client";

import type { Crumb } from "@/components/shell/page-chrome";
import { resourceId } from "@/lib/api/client";
import { librarySections, sectionTitle } from "@/lib/navigation";
import { useConversation } from "@/modules/chat/queries";
import { useSpace } from "@/modules/spaces/queries";

import { catalogHref, type Resource } from "../../model";
import { parseOrigin } from "../links";

/**
 * The Reader's trail (preview `crumbs` + `backBtn`): back to where it was opened from when `from=`
 * names it — a conversation, Home, search, Recent, My contributions, a library section or a space —
 * else Knowledge › the document's collection (a Browse filter; My files for
 * personal files). The trail leads to the origin, so the Reader needs no separate Back button.
 */
export function useOriginCrumbs(from: string, r: Resource): Crumb[] {
  const origin = parseOrigin(from);
  const conversation = useConversation(origin?.kind === "conversation" ? origin.id : undefined);
  const space = useSpace(origin?.kind === "space" ? origin.id : "");
  const current = { label: r.title };

  switch (origin?.kind) {
    case "conversation":
      return [{ label: conversation.data?.displayName || "Conversation", href: `/chat/${origin.id}` }, current];
    case "home":
      return [{ label: "Home", href: "/home" }, current];
    case "search":
      return [{ label: "Search", href: "/search" }, current];
    case "recent":
      return [{ label: "Recent", href: "/recent" }, current];
    case "contributions":
      return [{ label: "My contributions", href: "/contributions" }, current];
    case "library": {
      const label = sectionTitle(librarySections, origin.tab);
      if (label) return [{ label: "Knowledge", href: "/knowledge" }, { label, href: `/knowledge/library?tab=${origin.tab}` }, current];
      break;
    }
    case "space":
      return [{ label: "Spaces", href: "/spaces" }, { label: space.data?.displayName || "Space", href: `/space/${origin.id}` }, current];
  }
  const base = r.base
    ? [{ label: r.isPersonal ? "My files" : r.base.displayName || "Collection", href: r.isPersonal ? "/knowledge/library?tab=files" : catalogHref({ filters: { kb: [resourceId(r.base.id)] } }) }]
    : [];
  return [{ label: "Knowledge", href: "/knowledge" }, ...base, current];
}
