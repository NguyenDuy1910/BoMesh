/**
 * Permanent redirects from addresses that predate the one-shell navigation.
 * Read by `next.config.ts` `redirects()`; kept dependency-free so the config
 * and the navigation tests load the same table.
 *
 * Next passes the original query string through and lets a destination's own
 * query win, so `/app?action=search` lands on `/chat?action=search` and
 * `/workspace-control/access?tab=roles` on `/manage/access?tab=roles`. Rules
 * are tried in order: query-specific ones come before their plain fallback.
 */
export interface LegacyRedirect {
  source: string;
  destination: string;
  permanent: true;
  has?: { type: "query"; key: string; value?: string }[];
}

const to = (source: string, destination: string, has?: LegacyRedirect["has"]): LegacyRedirect =>
  has ? { source, destination, permanent: true, has } : { source, destination, permanent: true };

const CONTROL = "/workspace-control";

export const LEGACY_REDIRECTS: readonly LegacyRedirect[] = [
  to("/app", "/chat"),
  to("/library", "/knowledge/personal"),

  // Workspace control → Manage, Knowledge
  to(CONTROL, "/manage/overview"),
  to(`${CONTROL}/dashboard`, "/manage/overview"),
  to(`${CONTROL}/:section(knowledge|knowledge-governance|collections|knowledge-bases|documents|all-items|items|apps|apps-permissions)/:rest*`, "/knowledge"),
  to(`${CONTROL}/:section(ingestion|connectors|sources)`, "/manage/sources?tab=history", [{ type: "query", key: "tab", value: "runs" }]),
  to(`${CONTROL}/:section(ingestion|connectors|sources)`, "/manage/sources?tab=sources"),
  to(`${CONTROL}/:section(agent|agents-policies|experience)`, "/manage/assistant"),
  to(`${CONTROL}/:section(members|people)`, "/manage/access?tab=members"),
  to(`${CONTROL}/roles`, "/manage/access?tab=roles"),
  to(`${CONTROL}/groups`, "/manage/access?tab=groups"),
  to(`${CONTROL}/access`, "/manage/access"),
  to(`${CONTROL}/:section(activity|audit|audit-logs)`, "/manage/activity"),
  to(`${CONTROL}/:section(settings|workspace-settings)`, "/manage/settings"),

  // Platform control → the platform console
  to(`${CONTROL}/platform`, "/platform/workspaces"),
  to(`${CONTROL}/platform/:section(overview|workspaces|tenants)`, "/platform/workspaces"),
  to(`${CONTROL}/platform/users`, "/platform/users"),
  to(`${CONTROL}/platform/integrations`, "/platform/connectors"),
  to(`${CONTROL}/platform/:section(models|policies)`, "/platform/capabilities"),
  to(`${CONTROL}/platform/usage`, "/platform/usage"),
  to(`${CONTROL}/platform/audit`, "/platform/audit"),
  to(`${CONTROL}/platform/:section(system|health)`, "/platform/health"),

  // Anything else the old console addressed
  to(`${CONTROL}/platform/:rest*`, "/platform/workspaces"),
  to(`${CONTROL}/:rest*`, "/manage/overview"),
];
