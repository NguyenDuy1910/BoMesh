"use client";

import { ArrowUpDown, BookOpen, ChevronDown, Lock, Plus, SearchX, Upload } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { Page } from "@/components/shell/Page";
import { Button, ButtonLink } from "@/components/ui/Button";
import { DataTable, type DataTableColumn } from "@/components/ui/DataTable";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { ClearFilters, FilterChip } from "@/components/ui/FilterChip";
import { Menu, MenuLabel, MenuRadioItem } from "@/components/ui/Menu";
import { PageHeader } from "@/components/ui/PageHeader";
import { PreviewTag } from "@/components/ui/PreviewTag";
import { SearchInput } from "@/components/ui/SearchInput";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { SkeletonCards, SkeletonRows } from "@/components/ui/Skeleton";
import { Toolbar } from "@/components/ui/Toolbar";
import { usePendingFeature } from "@/lib/api/pending";
import { hasSessionPermission } from "@/lib/auth/session";
import { cn } from "@/lib/cn";
import { useAuthSession } from "@/lib/hooks/useAuthSession";
import { useRouteState } from "@/lib/hooks/useRouteState";
import { useMyAccessRequests } from "@/modules/knowledge/access-requests";
import { localCollectionGeneralAccess } from "@/modules/knowledge/api";
import {
  ACCESS_FILTERS,
  COLLECTION_SORTS,
  accessSummary,
  matchesSearch,
  sortCollections,
  type AccessSummary,
  type CollectionSort,
} from "@/modules/knowledge/model";
import { useDiscoverableCollections, useKnowledgeHome } from "@/modules/knowledge/queries";
import { formatRelative, pluralize } from "@/lib/format";

import { CreateKnowledgeBaseDialog } from "./CreateKnowledgeBaseDialog";
import { AccessBadge, KnowledgeBaseMark } from "./KnowledgeBaseMark";
import { AccessRequestedMark, RESTRICTED_NAME, RequestAccessDialog } from "./RequestAccessDialog";

export const MY_FILES = "My files";
const MY_FILES_DESCRIPTION = "Only you can see these. Use them in your own chats.";

/** One card or row: a readable knowledge base, or one the caller may only ask to join. */
interface Entry {
  id: string;
  href: string;
  title: string;
  description: string;
  personal: boolean;
  locked: boolean;
  access: AccessSummary;
  /** General access or the entry itself comes from a pending feature kept in this browser. */
  local: boolean;
  documentCount: number;
  updatedAt: string;
}

const VIEW_KEY = "bomesh.knowledge.view";

/**
 * Knowledge: every knowledge base the caller can read, My files first, plus
 * the ones they have met but cannot open (with Request access).
 */
export function KnowledgeList() {
  const router = useRouter();
  const session = useAuthSession();
  const canCreate = hasSessionPermission(session, "knowledge.manage");
  const workspaceName = session?.workspaces.find((workspace) => workspace.id === session.active_workspace_id)?.name ?? "";
  const generalAccessEnabled = usePendingFeature("collection.general_access");
  const discoveryEnabled = usePendingFeature("collection.discovery");
  const home = useKnowledgeHome();
  const discoverable = useDiscoverableCollections(discoveryEnabled);
  const requests = useMyAccessRequests();

  const [search, setSearch] = useState("");
  const [accessFilter, setAccessFilter] = useState("");
  const [sort, setSort] = useState<CollectionSort>("updated");
  const [view, setView] = useState<"grid" | "list">("grid");
  const [asking, setAsking] = useState<{ id: string; title: string | null } | null>(null);
  const [action, setAction] = useRouteState("action");

  useEffect(() => {
    if (globalThis.localStorage?.getItem(VIEW_KEY) === "list") setView("list");
  }, []);
  const changeView = (next: "grid" | "list") => {
    setView(next);
    globalThis.localStorage?.setItem(VIEW_KEY, next);
  };

  const data = home.data;
  const personalId = data?.personal_collection_id ?? null;

  const entries = useMemo<Entry[]>(() => {
    if (!data) return [];
    const general = generalAccessEnabled ? localCollectionGeneralAccess() : {};
    const readable: Entry[] = data.collections.map((collection) => {
      const personal = collection.id === personalId;
      const local = !personal && Boolean(general[collection.id]);
      return {
        id: collection.id,
        href: `/knowledge/${encodeURIComponent(collection.id)}`,
        title: personal ? MY_FILES : collection.title,
        description: personal ? MY_FILES_DESCRIPTION : collection.description?.trim() || "",
        personal,
        locked: false,
        access: accessSummary({ personal, general: local ? "workspace" : "restricted" }, workspaceName),
        local,
        documentCount: collection.document_count,
        updatedAt: collection.updated_at,
      };
    });
    // My files exists for everyone; the server creates it on first use.
    if (!personalId) {
      readable.push({
        id: "personal",
        href: "/knowledge/personal",
        title: MY_FILES,
        description: MY_FILES_DESCRIPTION,
        personal: true,
        locked: false,
        access: accessSummary({ personal: true, general: "restricted" }, workspaceName),
        local: false,
        documentCount: 0,
        updatedAt: "",
      });
    }
    const readableIds = new Set(readable.map((entry) => entry.id));
    const locked: Entry[] = (discoverable.data ?? [])
      .filter((collection) => !readableIds.has(collection.id))
      .map((collection) => ({
        id: collection.id,
        href: `/knowledge/${encodeURIComponent(collection.id)}`,
        title: collection.title ?? RESTRICTED_NAME,
        description: collection.description ?? "",
        personal: false,
        locked: true,
        access: accessSummary({ personal: false, general: collection.general_access }, workspaceName),
        local: true,
        documentCount: 0,
        updatedAt: "",
      }));
    return [...readable, ...locked];
  }, [data, discoverable.data, generalAccessEnabled, personalId, workspaceName]);

  const filtering = Boolean(search.trim() || accessFilter);
  const rows = useMemo(() => {
    const visible = entries.filter((entry) =>
      matchesSearch(search, entry.title, entry.description) && (!accessFilter || entry.access.key === accessFilter));
    const sorted = sortCollections(
      visible.map((entry) => ({ ...entry, document_count: entry.documentCount, updated_at: entry.updatedAt })),
      sort,
      visible.find((entry) => entry.personal)?.id ?? null,
    );
    // Locked knowledge bases follow the ones the caller can open.
    return [...sorted.filter((entry) => !entry.locked), ...sorted.filter((entry) => entry.locked)];
  }, [accessFilter, entries, search, sort]);

  const shared = entries.filter((entry) => !entry.personal);
  const personalEntry = entries.find((entry) => entry.personal);
  const firstRun = Boolean(data) && shared.length === 0 && (personalEntry?.documentCount ?? 0) === 0;
  const createOpen = action === "create" && canCreate;

  const requestCta = (entry: Entry) =>
    requests.data?.get(entry.id)?.status === "pending" ? (
      <AccessRequestedMark />
    ) : (
      <Button
        icon={<Lock aria-hidden="true" size={14} />}
        onClick={() => setAsking({ id: entry.id, title: entry.locked && entry.title !== RESTRICTED_NAME ? entry.title : null })}
        size="sm"
        variant="secondary"
      >
        Request access
      </Button>
    );

  const accessOptions = generalAccessEnabled ? ACCESS_FILTERS : ACCESS_FILTERS.filter((option) => option.value !== "workspace");

  const body = (() => {
    if (home.error && !data) {
      return <ErrorState description={home.error} onAction={home.reload} title="Knowledge didn’t load" />;
    }
    if (!data) return view === "list" ? <SkeletonRows columns={4} label="Loading knowledge" rows={6} /> : <SkeletonCards count={6} label="Loading knowledge" />;
    if (firstRun) {
      return canCreate ? (
        <EmptyState
          action={<Button icon={<Plus aria-hidden="true" size={16} />} onClick={() => setAction("create")} variant="primary">Create knowledge base</Button>}
          boxed
          description="Group documents by team or topic, then add files or connect a source."
          icon={<BookOpen />}
          title="Create your first knowledge base"
        />
      ) : (
        <EmptyState
          action={<ButtonLink href="/knowledge/personal?action=upload" icon={<Upload aria-hidden="true" size={16} />} variant="primary">Upload to My files</ButtonLink>}
          boxed
          description="Upload your own files to ask about them. Only you can see My files."
          icon={<BookOpen />}
          title="No knowledge has been shared with you yet"
        />
      );
    }
    if (!rows.length) {
      return (
        <EmptyState
          action={<Button onClick={() => { setSearch(""); setAccessFilter(""); }} variant="secondary">Clear filters</Button>}
          boxed
          description="Try another word or clear the filters."
          icon={<SearchX />}
          size="md"
          title="No knowledge bases match"
        />
      );
    }
    if (view === "list") {
      return (
        <DataTable
          ariaLabel="Knowledge bases"
          columns={listColumns(requestCta)}
          data={rows}
          onRowClick={(entry) => router.push(entry.href)}
        />
      );
    }
    return (
      <ul className="grid grid-cols-3 gap-3 max-[1180px]:grid-cols-2 max-[640px]:grid-cols-1" aria-label="Knowledge bases">
        {rows.map((entry) => (
          <li key={entry.id}>
            <KnowledgeBaseCard entry={entry} requestCta={requestCta} />
          </li>
        ))}
      </ul>
    );
  })();

  return (
    <Page>
      <PageHeader
        actions={canCreate && !firstRun ? (
          <Button icon={<Plus aria-hidden="true" size={16} />} onClick={() => setAction("create")} variant="primary">
            Create knowledge base
          </Button>
        ) : undefined}
        sub="Everything the assistant can answer from."
        title="Knowledge"
      />
      {!firstRun && (
        <Toolbar
          end={(
            <>
              <Menu
                align="end"
                trigger={(props) => (
                  <Button
                    {...props}
                    aria-label={`Sort: ${COLLECTION_SORTS[sort]}`}
                    icon={<ArrowUpDown aria-hidden="true" size={15} />}
                    iconAfter={<ChevronDown aria-hidden="true" size={14} />}
                    size="sm"
                    variant="ghost"
                  >
                    {COLLECTION_SORTS[sort]}
                  </Button>
                )}
              >
                <MenuLabel>Sort by</MenuLabel>
                {(Object.keys(COLLECTION_SORTS) as CollectionSort[]).map((value) => (
                  <MenuRadioItem checked={sort === value} key={value} onSelect={() => setSort(value)}>
                    {COLLECTION_SORTS[value]}
                  </MenuRadioItem>
                ))}
              </Menu>
              <SegmentedControl
                ariaLabel="Layout"
                onChange={changeView}
                options={[{ value: "grid", label: "Grid" }, { value: "list", label: "List" }]}
                size="sm"
                value={view}
              />
            </>
          )}
          filters={(
            <>
              <FilterChip label="Access" onChange={setAccessFilter} options={accessOptions} value={accessFilter} />
              <ClearFilters active={filtering} onClear={() => { setSearch(""); setAccessFilter(""); }} />
            </>
          )}
          search={<SearchInput ariaLabel="Search knowledge" onChange={setSearch} placeholder="Search knowledge" value={search} />}
        />
      )}
      {body}

      {canCreate && (
        <CreateKnowledgeBaseDialog
          existing={data?.collections ?? []}
          onClose={() => setAction("")}
          open={createOpen}
          workspaceName={workspaceName}
        />
      )}
      {asking && (
        <RequestAccessDialog
          collectionId={asking.id}
          collectionName={asking.title}
          onClose={() => setAsking(null)}
          open
        />
      )}
    </Page>
  );
}

function updatedLine(entry: Entry) {
  if (!entry.updatedAt) return entry.personal ? "No files yet" : "";
  return `${pluralize(entry.documentCount, "document")} · Updated ${formatRelative(entry.updatedAt)}`;
}

function KnowledgeBaseCard({ entry, requestCta }: { entry: Entry; requestCta: (entry: Entry) => React.ReactNode }) {
  return (
    <article
      className={cn(
        "relative flex h-full min-h-[176px] flex-col gap-2.5 rounded-[var(--radius-lg)] border border-[var(--border-subtle)] px-[18px] py-4",
        "transition-[border-color,box-shadow] duration-[var(--duration-fast)]",
        "has-[a:focus-visible]:shadow-[var(--shadow-focus)]",
        entry.locked
          ? "bg-[var(--surface-subtle)]"
          : "bg-[var(--surface-base)] shadow-[var(--shadow-1)] hover:border-[var(--border-default)] hover:shadow-[var(--shadow-2)]",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <KnowledgeBaseMark id={entry.id} locked={entry.locked} personal={entry.personal} title={entry.title} />
        <span className="flex items-center gap-1.5">
          {entry.locked && <PreviewTag />}
          <AccessBadge access={entry.access} local={entry.local && !entry.locked} />
        </span>
      </div>
      <div>
        <h2 className={cn(
          "truncate text-[15px] font-semibold leading-[1.35]",
          entry.locked ? "text-[var(--text-secondary)]" : "text-[var(--text-primary)]",
        )}
        >
          <Link
            aria-label={entry.locked ? `${entry.title}, you don’t have access` : undefined}
            className="focus-visible:outline-none after:absolute after:inset-0 after:rounded-[var(--radius-lg)] after:content-['']"
            href={entry.href}
          >
            {entry.title}
          </Link>
        </h2>
        <p className="mt-0.5 line-clamp-2 min-h-[3em] text-[13.5px] leading-normal text-[var(--text-secondary)]">
          {entry.description || (entry.locked ? "Ask the owners for access to see what it holds." : "No description yet.")}
        </p>
      </div>
      <div className="relative z-[1] mt-auto flex min-h-[22px] items-center justify-between gap-2">
        {entry.locked ? requestCta(entry) : (
          <span className="truncate text-[length:var(--text-size-meta)] text-[var(--text-tertiary)]">{updatedLine(entry)}</span>
        )}
      </div>
    </article>
  );
}

function listColumns(requestCta: (entry: Entry) => React.ReactNode): DataTableColumn<Entry>[] {
  return [
    {
      id: "name",
      header: "Name",
      cell: (entry) => (
        <div className="flex min-w-0 items-center gap-3">
          <KnowledgeBaseMark id={entry.id} locked={entry.locked} personal={entry.personal} size="md" title={entry.title} />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="truncate font-medium text-[var(--text-primary)]">{entry.title}</span>
              {entry.locked && <PreviewTag />}
            </div>
            {entry.description && (
              <div className="truncate text-[length:var(--text-size-meta)] text-[var(--text-tertiary)]">{entry.description}</div>
            )}
          </div>
        </div>
      ),
    },
    { id: "access", header: "Access", cell: (entry) => <AccessBadge access={entry.access} local={entry.local && !entry.locked} /> },
    {
      id: "documents",
      header: "Documents",
      align: "right",
      hideBelow: 900,
      cell: (entry) => (entry.locked ? <span className="text-[var(--text-tertiary)]">—</span> : entry.documentCount.toLocaleString()),
    },
    {
      id: "updated",
      header: "Updated",
      hideBelow: 900,
      cell: (entry) => (
        <span className="whitespace-nowrap text-[var(--text-secondary)]">
          {entry.updatedAt ? formatRelative(entry.updatedAt) : "—"}
        </span>
      ),
    },
    {
      id: "cta",
      header: <span className="sr-only">Actions</span>,
      width: "1%",
      cell: (entry) => (entry.locked ? <div className="flex justify-end">{requestCta(entry)}</div> : null),
    },
  ];
}
