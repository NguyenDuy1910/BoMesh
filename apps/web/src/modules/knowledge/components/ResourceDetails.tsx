"use client";

import { useQuery } from "@tanstack/react-query";
import { Globe, Lock, User, type LucideIcon } from "lucide-react";
import NextLink from "next/link";

import { KeyValue } from "@/components/ui/KeyValue";
import { api, call, resourceId } from "@/lib/api/client";
import { fmtDate } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";

import { catalogHref, languageName, TRUST, type Resource } from "../model";
import { useItem, useItemSpaces, useKnowledgeModel, useMember } from "../queries";
import { useSourceApp, SourceIcon } from "./SourceIcon";
import { TrustChip, useTrust } from "./TrustChip";

/** Who can read documents in a knowledge base (preview `X.whoCanSee`): from its IAM policy when the caller may read it. */
export function useWhoCanSee(resource: Resource): { icon: LucideIcon; label: string } {
  const { id, workspace } = useWorkspace();
  const baseId = resource.base?.id ?? "";
  const base = useItem(resource.isPersonal ? null : baseId);
  const canRead = base.data?.access === "OWNER";
  const policy = useQuery({
    queryKey: [id, "items", "policy", baseId],
    queryFn: () => call(api.POST("/api/v1/workspaces/{workspace}/items/{item}:getIamPolicy", { params: { path: { workspace: id, item: baseId } }, body: {} })),
    enabled: canRead && !!baseId,
    retry: false,
    staleTime: 60_000,
  });
  if (resource.isPersonal) return { icon: User, label: "Only you" };
  const everyone = policy.data?.bindings?.some((b) => b.members.includes("workspaceMembers"));
  if (everyone) return { icon: Globe, label: `Everyone in ${workspace.displayName}` };
  if (policy.data) return { icon: Lock, label: "Only people with access" };
  return { icon: Lock, label: resource.base?.displayName ? `People with access to ${resource.base.displayName}` : "People with access" };
}

export interface ResourceDetailsProps {
  resource: Resource;
}

/** Metadata list (preview `X.res.details`): what it is, where it lives and came from, who owns it, who can see it. */
export function ResourceDetails({ resource: r }: ResourceDetailsProps) {
  const { hasModule } = useWorkspace();
  const { ctx } = useKnowledgeModel();
  const owner = useMember(r.owner);
  const trust = useTrust(r);
  const who = useWhoCanSee(r);
  const source = useSourceApp(r.source.isUpload ? undefined : r.source.key);
  const creator = useMember(r.source.isUpload ? r.item.creator : null);
  const base = useItem(hasModule("spaces") && !r.isPersonal ? r.base?.id : null);
  const spaces = useItemSpaces(r.name, { baseSpace: base.data?.collection?.space, enabled: hasModule("spaces") });
  const linked = (spaces.data ?? []).filter((s) => s.material || s.viaBase);
  const KindIcon = r.kindMeta.icon;
  const WhoIcon = who.icon;
  const version = /\/revisions\/(\d+)$/.exec(r.item.document?.revision ?? "")?.[1] ?? "1";
  const sourcePath = r.source.isUpload
    ? `Uploaded by ${creator.data?.displayName ?? "a member"}`
    : r.source.path || source.name;

  return (
    <KeyValue
      pairs={[
        [
          "Type",
          <span key="t" className="row gap-6">
            <KindIcon className="i i-sm muted" aria-hidden />
            {r.kindMeta.label}
          </span>,
        ],
        [
          "Topics",
          r.topics.length ? (
            <span className="res-topics">
              {r.topics.map((t) => (
                <NextLink key={t} className="res-topic" href={catalogHref({ filters: { topic: [resourceId(t)] } })}>
                  {ctx.topicNames?.get(t) ?? "Untitled topic"}
                </NextLink>
              ))}
            </span>
          ) : (
            <span className="muted">None yet</span>
          ),
        ],
        hasModule("spaces") && [
          "Spaces",
          linked.length ? (
            <span>
              {linked.map((s, i) => (
                <span key={s.space.name}>
                  {i ? ", " : null}
                  <NextLink className="link" href={`/space/${resourceId(s.space.name)}`}>
                    {s.space.displayName}
                  </NextLink>
                </span>
              ))}
            </span>
          ) : (
            <span className="muted">Not linked</span>
          ),
        ],
        ["Owner", owner.data?.displayName ?? (r.owner ? "—" : "No owner")],
        [
          "Knowledge base",
          r.base ? (
            r.isPersonal ? (
              "My files"
            ) : (
              <NextLink className="link" href={`/knowledge/${r.base.id}`} translate="no">
                {r.base.displayName || "Knowledge base"}
              </NextLink>
            )
          ) : (
            "—"
          ),
        ],
        [
          "Source",
          <span key="s" className="stack gap-2">
            <span className="row gap-6">
              <SourceIcon source={r.source.isUpload ? undefined : r.source.key} />
              {source.name}
            </span>
            <span className="t-xs muted res-path">{sourcePath}</span>
          </span>,
        ],
        [
          "Trust",
          <span key="tr" className="stack gap-2">
            {trust.state === "personal" ? TRUST.personal.label : <TrustChip resource={r} />}
            <span className="t-xs muted">{trust.note || TRUST[trust.state].desc}</span>
          </span>,
        ],
        ["Version", `v${version} · ${fmtDate(r.updated)}`],
        ["Language", languageName(r.language)],
        [
          "Who can see it",
          <span key="w" className="row gap-6">
            <WhoIcon className="i i-sm muted" aria-hidden />
            {who.label}
          </span>,
        ],
      ]}
    />
  );
}
