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
import { toast } from "@/components/ui/Toast";
import { ApiError, resourceId } from "@/lib/api/client";
import { fmtNum, plural } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";
import { CollectionSources } from "@/modules/ingestion";
import { useSources } from "@/modules/ingestion/queries";

import { openContribute } from "../../components/contribute-store";
import { catalogHref } from "../../model";
import { useContributionTargets, useItem } from "../../queries";
import { collectionHref, COLLECTIONS_HREF, generalAccessOf, isEditor, isLocked, isOwner, isPersonal, type Item } from "../model";
import { useBasePolicy, useCollectionReviewCounts, usePendingRequestsFor } from "../queries";
import { AccessTab } from "./AccessTab";
import { ContentsTab } from "./ContentsTab";
import { BaseMark } from "./BaseMark";
import { AccessChip, ownersLabel, SpaceChip, useBaseSpace } from "./parts";
import { SettingsTab } from "./SettingsTab";

type TabId = "contents" | "access" | "sources" | "settings";

const STUDIO: Crumb = { label: "Knowledge Studio", href: "/studio" };
const COLLECTIONS: Crumb = { label: "Collections", href: COLLECTIONS_HREF };

/**
 * `/studio/collections/[id]` (preview `P.kbDetail`): one collection its owners and editors look after.
 * Everyone who edits it sees Contents (its folders and documents) and Sources; owners also Access and
 * Settings. One primary: Add documents, into the folder on screen.
 */
export function CollectionPage({ id }: { id: string }) {
  const item = useItem(id);
  const denied = item.error instanceof ApiError && (item.error.status === 403 || item.error.status === 404);
  const c = item.data;
  if (c && c.state !== "DELETED" && c.itemType === "COLLECTION" && !isPersonal(c) && !isLocked(c) && isEditor(c)) return <CollectionDetail collection={c} />;
  if (item.isPending) {
    return (
      <Page>
        <PageChrome crumbs={[STUDIO, COLLECTIONS, { label: "…" }]} />
        <SkeletonRows rows={6} />
      </Page>
    );
  }
  if (item.isError && !denied) {
    return (
      <Page>
        <PageChrome crumbs={[STUDIO, COLLECTIONS, { label: "Collection" }]} />
        <ErrorState error={item.error} onRetry={() => void item.refetch()} />
      </Page>
    );
  }
  return <Unavailable />;
}

/** Preview `unavailable()`. */
function Unavailable() {
  return (
    <Page>
      <PageChrome crumbs={[STUDIO, { label: "Not available" }]} />
      <EmptyState
        icon={BookOpen}
        boxed
        title="This collection isn’t available"
        description="It may have been archived, or you don’t manage it."
        actions={
          <NextLink href={COLLECTIONS_HREF} className={buttonVariants({ variant: "primary" })}>
            Go to Collections
          </NextLink>
        }
      />
    </Page>
  );
}

function CollectionDetail({ collection }: { collection: Item }) {
  const router = useRouter();
  const search = useSearchParams();
  const { can } = useWorkspace();
  const owner = isOwner(collection);
  const policy = useBasePolicy(owner ? collection : null);
  const requests = usePendingRequestsFor(owner ? collection : null);
  const sources = useSources();
  const space = useBaseSpace(collection);
  const cId = resourceId(collection.name);
  const name = collection.displayName ?? "";
  const reviewer = owner && can("contributions.review");
  const review = useCollectionReviewCounts(collection, reviewer);
  const targets = useContributionTargets();
  const sourceCount = (sources.data ?? []).filter((s) => s.targetCollection === collection.name).length;

  const tabs: SectionTab[] = [{ id: "contents", label: "Contents" }];
  if (owner) tabs.push({ id: "access", label: "Access", count: requests.data.length || null, alert: true });
  tabs.push({ id: "sources", label: "Sources", count: can("sources.list") ? sourceCount : null });
  if (owner) tabs.push({ id: "settings", label: "Settings" });
  const asked = search.get("tab") ?? "";
  const tab = (tabs.some((t) => t.id === asked) ? asked : tabs[0]!.id) as TabId;
  const folder = tab === "contents" ? search.get("folder") : null;

  // Every document with its processing and publication, for its reviewers; what readers see for everyone.
  const docsHref = `/studio?tab=documents&view=all&kb=${cId}`;
  const browseHref = catalogHref({ filters: { kb: [cId] } });
  // The link people can open: its documents in Browse.
  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}${browseHref}`);
      toast("Link copied");
    } catch {
      toast("Couldn’t copy the link", { tone: "danger" });
    }
  };

  /** For the collection's reviewers: what's waiting in Documents → Review and Issues, with the task as the action. */
  const n = reviewer ? review.submissions : 0;
  const m = reviewer ? review.problems : 0;
  const alert =
    n || m ? (
      <div className="mb-12">
        <Callout
          tone={m ? "warning" : "accent"}
          icon={m ? AlertTriangle : Clock}
          title={[n && `${plural(n, "submission")} waiting for review`, m && `${plural(m, "document")} couldn’t be processed`].filter(Boolean).join(" · ")}
          actions={
            <>
              {m ? (
                <NextLink href={`/studio?tab=documents&view=issues&kb=${cId}`} className={buttonVariants({ variant: n ? "ghost" : "secondary", size: "sm" })}>
                  See issues
                </NextLink>
              ) : null}
              {n ? (
                <NextLink href={`/studio?tab=documents&view=review&kb=${cId}`} className={buttonVariants({ variant: "secondary", size: "sm" })}>
                  {`Review ${fmtNum(n)}`}
                </NextLink>
              ) : null}
            </>
          }
        />
      </div>
    ) : null;

  // Rare actions only: contents, access and archiving live in their own tabs, so they aren't repeated here.
  const menu = [
    ...(reviewer ? [{ id: "docs", label: "Open in Documents", icon: Files, run: () => router.push(docsHref) }] : []),
    { id: "browse", label: "Open in Knowledge", icon: BookOpen, run: () => router.push(browseHref) },
    ...(can("sources.create") && tab !== "sources" ? [{ id: "source", label: "Add source", icon: Plug, run: () => router.push(collectionHref(collection.name, "sources")) }] : []),
    { id: "link", label: "Copy link", icon: Link, run: () => void copyLink() },
  ];

  const actions = (
    <>
      {targets.data.some((t) => t.name === collection.name) ? (
        <Button variant="primary" onPress={() => openContribute({ collection: collection.name, folder: folder ? folder : undefined })}>
          <Upload className="i" aria-hidden />
          Add documents
        </Button>
      ) : null}
      <Dropdown>
        <Button isIconOnly variant="ghost" aria-label="More" className="button--muted">
          <Ellipsis aria-hidden />
        </Button>
        <Dropdown.Popover placement="bottom end">
          <Dropdown.Menu aria-label={`Actions for ${name}`} onAction={(key) => menu.find((x) => x.id === key)?.run()}>
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
        chips={
          <>
            <AccessChip access={generalAccessOf(collection, policy.data)} spaceName={space?.displayName} />
            {space ? <SpaceChip space={space} link /> : null}
          </>
        }
        meta={meta}
        actions={actions}
        crumbs={[STUDIO, COLLECTIONS, { label: name }]}
      />
      {alert}
      {tabs.length > 1 ? (
        <ContextBar>
          <SectionTabs items={tabs} active={tab} base={collectionHref(collection.name)} label="Collection sections" />
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
