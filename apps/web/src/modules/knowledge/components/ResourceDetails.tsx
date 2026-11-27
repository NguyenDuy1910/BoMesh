"use client";

import { useQuery } from "@tanstack/react-query";
import { Building2, Lock, User, type LucideIcon } from "lucide-react";
import NextLink from "next/link";

import { KeyValue } from "@/components/ui/KeyValue";
import { api, call, resourceId } from "@/lib/api/client";
import { fmtDate } from "@/lib/format";
import { useMessages } from "@/lib/i18n";
import { useWorkspace } from "@/lib/workspace";

import { accessFolder, type FolderIndex, type Item } from "../bases/model";
import { catalogHref, languageName, type Resource } from "../model";
import { useItem, useItemSpaces, useKnowledgeModel, useMember } from "../queries";
import { DocumentFacts, schemeRows } from "./ConceptsByScheme";
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
  if (collection?.personal) return { icon: User, label: "Chỉ bạn" };
  if (policy.data?.bindings?.some((b) => b.members.includes("workspaceMembers"))) return { icon: Building2, label: `Mọi thành viên của ${workspace.displayName}` };
  if (policy.data) return { icon: Lock, label: "Chỉ người có quyền truy cập" };
  const name = collection?.displayName || base.data?.displayName;
  return { icon: Lock, label: name ? `Những người có quyền truy cập ${name}` : "Những người có quyền truy cập" };
}

/** Who reads what's in a collection or one of its folders (preview `whoCanSee(kb, folder)`): the nearest folder with its own access decides, else the collection. */
export function useWhoCanSeeAt(collection: Item | undefined, index: FolderIndex | undefined, folder: string | null | undefined): { icon: LucideIcon; label: string } {
  const base = useWhoCanSeeCollection(collection ? { id: resourceId(collection.name), displayName: collection.displayName } : null);
  const own = index && folder ? accessFolder(index, folder) : null;
  return own ? { icon: Lock, label: `Chỉ người được thêm vào ${own.displayName}` } : base;
}

/** Who can read a document: the audience of its collection. */
export function useWhoCanSee(resource: Resource): { icon: LucideIcon; label: string } {
  return useWhoCanSeeCollection(resource.base ? { id: resource.base.id, displayName: resource.base.displayName, personal: resource.isPersonal } : null);
}

export interface ResourceDetailsProps {
  resource: Resource;
}

/** Metadata list (preview `X.res.details`): what it is and what it's filed under (one row per classification scheme), where it
 *  lives and came from, who owns it, who can see it; then its “Thông tin văn bản” when it is an issued document. */
export function ResourceDetails({ resource: r }: ResourceDetailsProps) {
  const { hasModule } = useWorkspace();
  const { taxonomy } = useKnowledgeModel();
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
    ? `Do ${creator.data?.displayName ?? "một thành viên"} tải lên`
    : r.source.path || source.name;

  return (
    <>
      <KeyValue
        pairs={[
        [
          "Loại",
          <span key="t" className="row gap-6">
            <TypeIcon className="i i-sm muted" aria-hidden />
            {r.typeMeta.label}
          </span>,
        ],
        ...schemeRows(taxonomy, r.assignments),
        hasModule("spaces") && [
          "Cộng đồng",
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
            <span className="muted">Chưa liên kết</span>
          ),
        ],
        ["Chủ sở hữu", owner.data?.displayName ?? (r.owner ? "—" : "Chưa có chủ sở hữu")],
        [
          "Kho tài liệu",
          r.base ? (
            <NextLink className="link" href={collectionHref} translate={r.base.personal ? undefined : "no"}>
              {r.isPersonal ? "Tệp của tôi" : r.base.displayName || "Kho tài liệu"}
            </NextLink>
          ) : (
            "—"
          ),
        ],
        [
          "Nguồn dữ liệu",
          <span key="s" className="stack gap-2">
            <span className="row gap-6">
              <SourceIcon source={r.source.isUpload ? undefined : r.source.key} />
              {source.name}
            </span>
            <span className="t-xs muted res-path">{sourcePath}</span>
          </span>,
        ],
        [
          "Xác minh",
          <span key="tr" className="stack gap-2">
            {trust.state === "personal" ? verification.personal.label : <TrustChip resource={r} />}
            <span className="t-xs muted">{trust.note || verification[trust.state].desc}</span>
          </span>,
        ],
        ["Phiên bản", `v${version} · ${fmtDate(r.updated)}`],
        ["Ngôn ngữ", languageName(r.language)],
        [
          "Ai có thể xem",
          <span key="w" className="row-start gap-6">
            <WhoIcon className="i i-sm muted mt-4" aria-hidden />
            {who.label}
          </span>,
        ],
        ]}
      />
      <DocumentFacts item={r.item} />
    </>
  );
}
