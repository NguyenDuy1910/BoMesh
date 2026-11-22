"use client";

import { useQuery } from "@tanstack/react-query";
import { Globe, Lock, User, type LucideIcon } from "lucide-react";
import NextLink from "next/link";

import { KeyValue } from "@/components/ui/KeyValue";
import { api, call, resourceId } from "@/lib/api/client";
import { fmtDate } from "@/lib/format";
import { useMessages } from "@/lib/i18n";
import { useWorkspace } from "@/lib/workspace";

import { accessFolder, type FolderIndex, type Item } from "../bases/model";
import { catalogHref, languageName, type Resource } from "../model";
import { useItem, useItemSpaces, useKnowledgeModel, useMember } from "../queries";
import { useSourceApp, SourceIcon } from "./SourceIcon";
import { TrustChip, useTrust } from "./TrustChip";

/**
 * Who can read the documents of a collection (preview `X.whoCanSee`): from its IAM policy when the caller
 * may read it (owners), else a plain "People with access to …". `personal` = the caller's My files.
 */
export function useWhoCanSeeCollection(collection: { id: string; displayName?: string; personal?: boolean } | null | undefined): { icon: LucideIcon; label: string } {
  const { id, workspace } = useWorkspace();
  const baseId = collection && !collection.personal ? collection.id : "";
  const base = useItem(baseId || null);
  const canRead = base.data?.access === "OWNER";
  const policy = useQuery({
    queryKey: [id, "items", "policy", baseId],
    queryFn: () => call(api.POST("/api/v1/workspaces/{workspace}/items/{item}:getIamPolicy", { params: { path: { workspace: id, item: baseId } }, body: {} })),
    enabled: canRead && !!baseId,
    retry: false,
    staleTime: 60_000,
  });
  if (collection?.personal) return { icon: User, label: "Only you" };
  if (policy.data?.bindings?.some((b) => b.members.includes("workspaceMembers"))) return { icon: Globe, label: `Everyone in ${workspace.displayName}` };
  if (policy.data) return { icon: Lock, label: "Only people with access" };
  const name = collection?.displayName || base.data?.displayName;
  return { icon: Lock, label: name ? `People with access to ${name}` : "People with access" };
}

/** Who reads what's in a collection or one of its folders (preview `whoCanSee(kb, folder)`): the nearest folder with its own access decides, else the collection. */
export function useWhoCanSeeAt(collection: Item | undefined, index: FolderIndex | undefined, folder: string | null | undefined): { icon: LucideIcon; label: string } {
  const base = useWhoCanSeeCollection(collection ? { id: resourceId(collection.name), displayName: collection.displayName } : null);
  const own = index && folder ? accessFolder(index, folder) : null;
  return own ? { icon: Lock, label: `Only people added to ${own.displayName}` } : base;
}

/** Who can read a document: the audience of its collection. */
export function useWhoCanSee(resource: Resource): { icon: LucideIcon; label: string } {
  return useWhoCanSeeCollection(resource.base ? { id: resource.base.id, displayName: resource.base.displayName, personal: resource.isPersonal } : null);
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
  const verification = useMessages().state.verification;
  const who = useWhoCanSee(r);
  const source = useSourceApp(r.source.isUpload ? undefined : r.source.key);
  const creator = useMember(r.source.isUpload ? r.item.creator : null);
  const base = useItem(r.isPersonal ? null : r.base?.id);
  // Managers go to the collection's page in Knowledge Studio; readers browse what it holds.
  const manages = base.data?.access === "OWNER" || base.data?.access === "EDITOR";
  const collectionHref = r.isPersonal ? "/knowledge/library?tab=files" : manages ? `/studio/collections/${r.base?.id}` : catalogHref({ filters: { kb: [r.base?.id ?? ""] } });
  const spaces = useItemSpaces(r.name, { enabled: hasModule("spaces") });
  const linked = (spaces.data ?? []).filter((s) => s.material);
  const TypeIcon = r.typeMeta.icon;
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
            <TypeIcon className="i i-sm muted" aria-hidden />
            {r.typeMeta.label}
          </span>,
        ],
        [
          "Topics",
          r.topics.length ? (
            <span className="res-topics">
              {r.topics.map((t) => {
                const label = ctx.topicNames?.get(t) ?? "Untitled topic";
                return (
                  <NextLink key={t} className="res-topic" title={label} href={catalogHref({ filters: { topic: [resourceId(t)] } })}>
                    {label}
                  </NextLink>
                );
              })}
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
          "Collection",
          r.base ? (
            <NextLink className="link" href={collectionHref} translate={r.base.personal ? undefined : "no"}>
              {r.isPersonal ? "My files" : r.base.displayName || "Collection"}
            </NextLink>
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
            {trust.state === "personal" ? verification.personal.label : <TrustChip resource={r} />}
            <span className="t-xs muted">{trust.note || verification[trust.state].desc}</span>
          </span>,
        ],
        ["Version", `v${version} · ${fmtDate(r.updated)}`],
        ["Language", languageName(r.language)],
        [
          "Who can see it",
          <span key="w" className="row-start gap-6">
            <WhoIcon className="i i-sm muted mt-4" aria-hidden />
            {who.label}
          </span>,
        ],
      ]}
    />
  );
}
