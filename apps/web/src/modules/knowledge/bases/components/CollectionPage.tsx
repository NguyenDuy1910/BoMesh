"use client";

import { Button, buttonVariants, Dropdown, Label } from "@heroui/react";
import { AlertTriangle, BookOpen, Building2, Clock, Ellipsis, Files, Link, Plug, Upload } from "lucide-react";
import NextLink from "next/link";
import { useRouter, useSearchParams } from "next/navigation";

import { PageChrome, type Crumb } from "@/components/shell/page-chrome";
import { Callout } from "@/components/ui/Callout";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { Page } from "@/components/ui/Page";
import { ContextBar } from "@/components/ui/ContextBar";
import { PageHeader } from "@/components/ui/PageHeader";
import { SectionTabs, type SectionTab } from "@/components/ui/SectionTabs";
import { SkeletonRows } from "@/components/ui/SkeletonRows";
import { ApiError, resourceId } from "@/lib/api/client";
import { fmtNum, plural } from "@/lib/format";
import { useMessages } from "@/lib/i18n";
import { useWorkspace } from "@/lib/workspace";
import { CollectionSources } from "@/modules/ingestion";
import { useSources } from "@/modules/ingestion/queries";
import { useCopyShareLink } from "@/modules/shares/queries";

import { openContribute } from "../../components/contribute-store";
import { catalogHref } from "../../model";
import { useContributionTargets, useItem } from "../../queries";
import { collectionHref, COLLECTIONS_HREF, generalAccessOf, isEditor, isLocked, isOwner, isPersonal, type Item } from "../model";
import { useBasePolicy, useCollectionReviewCounts, usePendingRequestsFor } from "../queries";
import { AccessTab } from "./AccessTab";
import { ContentsTab } from "./ContentsTab";
import { BaseMark } from "./BaseMark";
import { AccessChip, ownersLabel } from "./parts";
import { SettingsTab } from "./SettingsTab";

type TabId = "contents" | "access" | "sources" | "settings";

/** Knowledge Studio › Collections, the trail above every collection page. */
function useStudioCrumbs(): [studio: Crumb, collections: Crumb] {
  const m = useMessages();
  return [
    { label: m.nav.studio, href: "/studio" },
    { label: m.nav.collections, href: COLLECTIONS_HREF },
  ];
}

/**
 * `/studio/collections/[id]` (preview `P.kbDetail`): one collection its owners and editors look after.
 * Everyone who edits it sees Contents (its folders and documents) and Sources; owners also Access and
 * Settings. One primary: Add documents, into the folder on screen.
 */
export function CollectionPage({ id }: { id: string }) {
  const item = useItem(id);
  const [studio, collections] = useStudioCrumbs();
  const m = useMessages();
  const denied = item.error instanceof ApiError && (item.error.status === 403 || item.error.status === 404);
  const c = item.data;
  if (c && c.state !== "DELETED" && c.itemKind === "COLLECTION" && !isPersonal(c) && !isLocked(c) && isEditor(c)) return <CollectionDetail collection={c} />;
  if (item.isPending) {
    return (
      <Page>
        <PageChrome crumbs={[studio, collections, { label: "…" }]} />
        <SkeletonRows rows={6} />
      </Page>
    );
  }
  if (item.isError && !denied) {
    return (
      <Page>
        <PageChrome crumbs={[studio, collections, { label: m.nav.collection }]} />
        <ErrorState error={item.error} onRetry={() => void item.refetch()} />
      </Page>
    );
  }
  return <Unavailable />;
}

/** Preview `unavailable()`. */
function Unavailable() {
  const [studio] = useStudioCrumbs();
  return (
    <Page>
      <PageChrome crumbs={[studio, { label: "Không khả dụng" }]} />
      <EmptyState
        icon={BookOpen}
        boxed
        title="Kho tài liệu này không khả dụng"
        description="Kho này có thể đã được lưu trữ, hoặc bạn không quản lý nó."
        actions={
          <NextLink href={COLLECTIONS_HREF} className={buttonVariants({ variant: "primary" })}>
            Đến Kho tài liệu
          </NextLink>
        }
      />
    </Page>
  );
}

function CollectionDetail({ collection }: { collection: Item }) {
  const router = useRouter();
  const [studio, collections] = useStudioCrumbs();
  const search = useSearchParams();
  const { can } = useWorkspace();
  const msg = useMessages();
  const owner = isOwner(collection);
  const policy = useBasePolicy(owner ? collection : null);
  const requests = usePendingRequestsFor(owner ? collection : null);
  const sources = useSources();
  const cId = resourceId(collection.name);
  const name = collection.displayName ?? "";
  const reviewer = owner && can("contributions.review");
  const review = useCollectionReviewCounts(collection, reviewer);
  const targets = useContributionTargets();
  const sourceCount = (sources.data ?? []).filter((s) => s.targetCollection === collection.name).length;
  const copyShareLink = useCopyShareLink();

  const tabs: SectionTab[] = [{ id: "contents", label: "Nội dung" }];
  if (owner) tabs.push({ id: "access", label: "Quyền truy cập", count: requests.total || null, alert: true });
  tabs.push({ id: "sources", label: msg.nav.sources, count: can("sources.list") ? sourceCount : null });
  if (owner) tabs.push({ id: "settings", label: "Cài đặt" });
  const asked = search.get("tab") ?? "";
  const tab = (tabs.some((t) => t.id === asked) ? asked : tabs[0]!.id) as TabId;
  const folder = tab === "contents" ? search.get("folder") : null;

  // Every document with its processing and publication, for its reviewers; what readers see for everyone.
  const docsHref = `/studio?tab=documents&view=all&kb=${cId}`;
  const browseHref = catalogHref({ filters: { kb: [cId] } });

  /** For the collection's reviewers: what's waiting in Documents → Review and Processing, with the task as the action. */
  const n = reviewer ? review.submissions : 0;
  const m = reviewer ? review.problems : 0;
  const alert =
    n || m ? (
      <div className="mb-12">
        <Callout
          tone={m ? "warning" : "accent"}
          icon={m ? AlertTriangle : Clock}
          title={[n && `${plural(n, "submission")} đang chờ duyệt`, m && `${plural(m, "document")} không xử lý được`].filter(Boolean).join(" · ")}
          actions={
            <>
              {m ? (
                <NextLink href={`/studio?tab=documents&view=processing&state=failed&kb=${cId}`} className={buttonVariants({ variant: n ? "ghost" : "secondary", size: "sm" })}>
                  Hiển thị
                </NextLink>
              ) : null}
              {n ? (
                <NextLink href={`/studio?tab=documents&view=review&kb=${cId}`} className={buttonVariants({ variant: "secondary", size: "sm" })}>
                  {`Duyệt ${fmtNum(n)}`}
                </NextLink>
              ) : null}
            </>
          }
        />
      </div>
    ) : null;

  // Rare actions only: contents, access and archiving live in their own tabs, so they aren't repeated here.
  const menu = [
    ...(reviewer ? [{ id: "docs", label: "Mở trong Tài liệu", icon: Files, run: () => router.push(docsHref) }] : []),
    { id: "browse", label: "Mở trong mục Tài liệu", icon: BookOpen, run: () => router.push(browseHref) },
    ...(can("sources.create") && tab !== "sources" ? [{ id: "source", label: "Thêm nguồn dữ liệu", icon: Plug, run: () => router.push(collectionHref(collection.name, "sources")) }] : []),
    { id: "link", label: "Sao chép liên kết", icon: Link, run: () => void copyShareLink(collection.name ?? "") },
  ];

  const actions = (
    <>
      {targets.data.some((t) => t.name === collection.name) ? (
        <Button variant="primary" onPress={() => openContribute({ collection: collection.name, folder: folder ? folder : undefined })}>
          <Upload className="i" aria-hidden />
          Thêm tài liệu
        </Button>
      ) : null}
      <Dropdown>
        <Button isIconOnly variant="ghost" aria-label="Thêm" className="button--muted">
          <Ellipsis aria-hidden />
        </Button>
        <Dropdown.Popover placement="bottom end">
          <Dropdown.Menu aria-label={`Thao tác cho ${name}`} onAction={(key) => menu.find((x) => x.id === key)?.run()}>
            {menu.map((x) => (
              <Dropdown.Item key={x.id} id={x.id} textValue={x.label}>
                <x.icon className="i" aria-hidden />
                <Label>{x.label}</Label>
              </Dropdown.Item>
            ))}
          </Dropdown.Menu>
        </Dropdown.Popover>
      </Dropdown>
    </>
  );

  // The owning unit only adds information when it isn't the collection's own name.
  const ownerUnit = ownersLabel(collection);
  const desc = collection.collection?.description ?? "";
  const meta =
    desc || ownerUnit ? (
      <>
        {desc ? <span translate="no">{desc}</span> : null}
        {ownerUnit && ownerUnit !== name ? (
          <span className="kb-head__meta">
            <span className="row gap-4 t-sm muted">
              <Building2 className="i i-sm" aria-hidden />
              {ownerUnit}
            </span>
          </span>
        ) : null}
      </>
    ) : undefined;

  return (
    <Page>
      <PageHeader
        title={name}
        heading={<span translate="no">{name}</span>}
        lead={<BaseMark base={collection} size={40} />}
        chips={<AccessChip access={generalAccessOf(collection, policy.data)} />}
        meta={meta}
        actions={actions}
        crumbs={[studio, collections, { label: name }]}
      />
      {alert}
      {tabs.length > 1 ? (
        <ContextBar>
          <SectionTabs items={tabs} active={tab} base={collectionHref(collection.name)} label="Các phần của kho tài liệu" />
        </ContextBar>
      ) : null}
      {tab === "sources" ? (
        <CollectionSources collection={collection.name ?? ""} />
      ) : tab === "settings" ? (
        <SettingsTab key={collection.etag} base={collection} />
      ) : tab === "access" ? (
        <AccessTab base={collection} />
      ) : (
        <ContentsTab collection={collection} folder={folder} />
      )}
    </Page>
  );
}
