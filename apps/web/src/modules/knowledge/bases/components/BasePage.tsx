"use client";

import { Button, Dropdown, Label, Separator } from "@heroui/react";
import { Archive, BookOpen, Building2, Clock, Ellipsis, Link, Lock, Plug, Sparkles, Users } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import type { ReactNode } from "react";

import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { Page } from "@/components/ui/Page";
import { PageHeader } from "@/components/ui/PageHeader";
import { SectionTabs, type SectionTab } from "@/components/ui/SectionTabs";
import { SkeletonRows } from "@/components/ui/SkeletonRows";
import { StatusChip } from "@/components/ui/StatusChip";
import { toast } from "@/components/ui/Toast";
import { PageChrome, type Crumb } from "@/components/shell/page-chrome";
import { ApiError, resourceId } from "@/lib/api/client";
import { rel } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";
import { useSources } from "@/modules/ingestion/queries";

import { useItem, useKnowledgeBases } from "../../queries";
import { generalAccessOf, isEditor, isLocked, isOwner, isPersonal, type Item } from "../model";
import { useBaseOperations } from "../operations";
import { useBasePolicy, useMyAccessRequest, usePendingRequestsFor } from "../queries";
import { AccessTab } from "./AccessTab";
import { MY_FILES_DESC } from "./BasesPage";
import { BaseMark } from "./BaseMark";
import { AddButton, DocumentsTab, useReaderResources } from "./DocumentsTab";
import { AccessChip, SpaceChip, ownersLabel, useBaseSpace } from "./parts";
import { RequestAccessCta } from "./RequestAccessDialog";
import { SettingsTab } from "./SettingsTab";
import { connectHref, SourcesTab } from "./SourcesTab";

type TabId = "documents" | "sources" | "access" | "settings";

const crumbsFor = (label: string): Crumb[] => [{ label: "Knowledge", href: "/knowledge" }, { label: "Knowledge bases", href: "/knowledge/bases" }, { label }];

/** `/knowledge/[id]` (preview `P.kbDetail`). */
export function BasePage({ id }: { id: string }) {
  const item = useItem(id);
  // A base the caller can't read comes back only as a LOCKED projection in the list.
  const bases = useKnowledgeBases({ showLocked: true });
  const lockedProjection = (bases.data ?? []).find((b) => resourceId(b.name) === id && isLocked(b));
  const denied = item.error instanceof ApiError && (item.error.status === 403 || item.error.status === 404);

  if (item.data && item.data.state !== "DELETED" && item.data.itemType === "COLLECTION") {
    return isLocked(item.data) ? <LockedBase base={item.data} /> : <BaseDetail base={item.data} />;
  }
  if (lockedProjection) return <LockedBase base={lockedProjection} />;
  if (item.isPending || (denied && bases.isPending)) {
    return (
      <Page>
        <PageChrome crumbs={crumbsFor("…")} />
        <SkeletonRows rows={6} />
      </Page>
    );
  }
  if (item.isError && !denied) {
    return (
      <Page>
        <PageChrome crumbs={crumbsFor("Knowledge base")} />
        <ErrorState error={item.error} onRetry={() => void item.refetch()} />
      </Page>
    );
  }
  return <Unavailable />;
}

/** Preview `unavailable()`. */
function Unavailable() {
  const router = useRouter();
  return (
    <Page>
      <PageChrome crumbs={crumbsFor("Not available")} />
      <EmptyState
        icon={BookOpen}
        boxed
        title="This knowledge base isn’t available"
        description="It may have been archived, or it isn’t shared with you."
        actions={
          <Button variant="primary" onPress={() => router.push("/knowledge/bases")}>
            Go to Knowledge bases
          </Button>
        }
      />
    </Page>
  );
}

/** Locked base: header + Request access (or the pending state). */
function LockedBase({ base }: { base: Item }) {
  const mine = useMyAccessRequest(base.name);
  const owners = ownersLabel(base);
  return (
    <Page>
      <PageChrome crumbs={crumbsFor(base.displayName ?? "")} />
      <PageHeader
        title={<span translate="no">{base.displayName}</span>}
        description={base.collection?.description ? <span translate="no">{base.collection.description}</span> : undefined}
        lead={<BaseMark base={base} size={40} locked />}
        chips={<AccessChip access="restricted" />}
      />
      <EmptyState
        icon={Lock}
        boxed
        title={mine.data ? "Your request is with the owners" : "You don’t have access yet"}
        description={
          mine.data
            ? `You asked ${rel(mine.data.createTime).toLowerCase()}. You can open it as soon as it’s approved.`
            : `${owners ? `${owners}. ` : ""}Ask for access to search and read its documents.`
        }
        actions={mine.data ? <StatusChip label="Pending" tone="warning" icon={Clock} /> : <RequestAccessCta base={base} variant="primary" size="md" />}
      />
    </Page>
  );
}

function BaseDetail({ base }: { base: Item }) {
  const router = useRouter();
  const search = useSearchParams();
  const { can } = useWorkspace();
  const personal = isPersonal(base);
  const owner = isOwner(base) && !personal;
  const editor = isEditor(base) && !personal;
  const policy = useBasePolicy(owner ? base : null);
  const requests = usePendingRequestsFor(owner ? base : null);
  const sources = useSources();
  const space = useBaseSpace(base);
  const ops = useBaseOperations();
  const baseId = resourceId(base.name);
  const href = `/knowledge/${baseId}`;
  const title = personal ? "My files" : (base.displayName ?? "");
  const docCount = base.collection?.documentCount ?? 0;
  // Preview `hasDocs`: published resources the caller can see (same query as the Resources list).
  const hasDocs = useReaderResources(base).visible.length > 0;
  const sourceCount = (sources.data ?? []).filter((s) => s.targetCollection === base.name).length;

  const tabs: SectionTab[] = [{ id: "documents", label: "Resources", count: docCount }];
  if (editor) tabs.push({ id: "sources", label: "Sources", count: can("sources.list") ? sourceCount : null });
  if (owner) tabs.push({ id: "access", label: "Access", count: requests.data.length || null, alert: true }, { id: "settings", label: "Settings" });
  const asked = search.get("tab") ?? "";
  const tab = (tabs.some((t) => t.id === asked) ? asked : "documents") as TabId;

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}${href}`);
      toast("Link copied");
    } catch {
      toast("Couldn’t copy the link", { tone: "danger" });
    }
  };
  const menu: { id: string; label: string; icon: typeof Link; danger?: boolean; run: () => void; sepBefore?: boolean }[] = [
    ...(can("sources.create") && !personal && editor ? [{ id: "connect", label: "Connect source", icon: Plug, run: () => router.push(connectHref(base)) }] : []),
    { id: "link", label: "Copy link", icon: Link, run: () => void copyLink() },
    ...(owner
      ? [
          { id: "access", label: "Manage access", icon: Users, run: () => router.push(`${href}?tab=access`) },
          { id: "archive", label: "Archive", icon: Archive, danger: true, sepBefore: true, run: () => void ops.archive(base) },
        ]
      : []),
  ];

  const actions = (
    <>
      {hasDocs ? (
        <Button variant="primary" onPress={() => router.push(`/chat?scope=${baseId}`)}>
          <Sparkles className="i" aria-hidden />
          Ask
        </Button>
      ) : null}
      {hasDocs || tab !== "documents" ? <AddButton base={base} /> : null}
      <Dropdown>
        <Button isIconOnly variant="ghost" aria-label="More" className="button--muted">
          <Ellipsis aria-hidden />
        </Button>
        <Dropdown.Popover placement="bottom end">
          <Dropdown.Menu aria-label={`Actions for ${title}`} onAction={(key) => menu.find((m) => m.id === key)?.run()}>
            {menu.flatMap((m): ReactNode[] => [
              ...(m.sepBefore ? [<Separator key={`sep-${m.id}`} />] : []),
              <Dropdown.Item key={m.id} id={m.id} textValue={m.label} variant={m.danger ? "danger" : undefined}>
                <m.icon className="i" aria-hidden />
                <Label>{m.label}</Label>
              </Dropdown.Item>,
            ])}
          </Dropdown.Menu>
        </Dropdown.Popover>
      </Dropdown>
    </>
  );

  const ownerUnit = ownersLabel(base);
  const desc = base.collection?.description || (personal ? MY_FILES_DESC : "");
  const description =
    desc || ownerUnit ? (
      <>
        {desc ? <span translate="no">{desc}</span> : null}
        {desc && ownerUnit ? <br /> : null}
        {ownerUnit ? (
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
      <PageChrome crumbs={crumbsFor(title)} />
      <PageHeader
        title={<span translate="no">{title}</span>}
        description={description}
        lead={<BaseMark base={base} size={40} />}
        chips={
          <>
            <AccessChip access={generalAccessOf(base, policy.data) ?? (personal ? "personal" : null)} spaceName={space?.displayName} />
            {space ? <SpaceChip space={space} link /> : null}
          </>
        }
        actions={actions}
      >
        {tabs.length > 1 ? <SectionTabs items={tabs} active={tab} base={href} label="Knowledge base sections" /> : null}
      </PageHeader>
      {tab === "sources" ? (
        <SourcesTab base={base} />
      ) : tab === "access" ? (
        <AccessTab base={base} />
      ) : tab === "settings" ? (
        <SettingsTab key={base.etag} base={base} />
      ) : (
        <DocumentsTab base={base} />
      )}
    </Page>
  );
}
