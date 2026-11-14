"use client";

import { Button, Card } from "@heroui/react";
import { BookOpen, Files, Plus, UserPlus } from "lucide-react";
import NextLink from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { ClearFilters } from "@/components/ui/ClearFilters";
import { EmptyState } from "@/components/ui/EmptyState";
import { FilterButton } from "@/components/ui/FilterButton";
import { Gate } from "@/components/ui/Gate";
import { NoMatches } from "@/components/ui/NoMatches";
import { PageHeader } from "@/components/ui/PageHeader";
import { PreviewChip } from "@/components/ui/PreviewChip";
import { SearchInput } from "@/components/ui/SearchInput";
import { SkeletonCards } from "@/components/ui/SkeletonCards";
import { StatusChip } from "@/components/ui/StatusChip";
import { Tip } from "@/components/ui/Tip";
import { fmtNum, plural } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";

import { updatedLabel } from "../../components/ResourceRow";
import { SortMenu } from "../../library/components/parts";
import { fold } from "../../model";
import { useKnowledgeBases } from "../../queries";
import { accessInfo, collectionHref, generalAccessOf, isEditor, isLocked, isPendingRequest, isPersonal, type AccessKey, type Item, type Policy } from "../model";
import { useAccessRequests, useBasePolicies } from "../queries";
import { BaseMark } from "./BaseMark";
import { CreateCollectionDialog } from "./CreateCollectionDialog";
import { AccessChip, SpaceChip, useBaseSpace } from "./parts";

const SORTS = { updated: "Recently updated", name: "Name", docs: "Most documents" } as const;
type SortKey = keyof typeof SORTS;

/** Collections the caller looks after: shared roots they own or edit (never My files or locked ones). */
function useManagedCollections() {
  const collections = useKnowledgeBases();
  const data = useMemo(() => (collections.data ?? []).filter((b) => b.state !== "DELETED" && !isPersonal(b) && !isLocked(b) && isEditor(b)), [collections.data]);
  return { ...collections, data: collections.data ? data : undefined };
}

function sortCollections(rows: Item[], by: SortKey) {
  const cmp: Record<SortKey, (a: Item, b: Item) => number> = {
    updated: (a, b) => (b.updateTime ?? "").localeCompare(a.updateTime ?? ""),
    name: (a, b) => (a.displayName ?? "").localeCompare(b.displayName ?? ""),
    docs: (a, b) => (b.collection?.documentCount ?? 0) - (a.collection?.documentCount ?? 0),
  };
  return [...rows].sort(cmp[by]);
}

/**
 * Knowledge Studio → Collections (preview `X.kb.tab`): the governed homes the caller owns or edits. No intro
 * paragraph; search, access filter and sort only once there are enough collections to need them.
 * `?new=1` / `?create=1` opens New collection.
 */
export function CollectionsSection() {
  const { can, member, workspace } = useWorkspace();
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const collections = useManagedCollections();
  const policies = useBasePolicies(collections.data ?? []);
  const requests = useAccessRequests();
  const [q, setQ] = useState("");
  const [access, setAccess] = useState("");
  const [sort, setSort] = useState<SortKey>("updated");
  const [creating, setCreating] = useState(false);
  const canCreate = can("items.create");
  // Owners decide their collections' requests here unless they manage People (then they decide them there).
  const decidesHere = !can("members.create");

  const asked = search.get("new") === "1" || search.get("create") === "1";
  useEffect(() => {
    if (!asked) return;
    if (canCreate) setCreating(true);
    const next = new URLSearchParams(search.toString());
    next.delete("new");
    next.delete("create");
    router.replace(`${pathname}?${next.toString()}`, { scroll: false });
  }, [asked, canCreate, search, pathname, router]);

  const pending = useMemo(() => {
    const out = new Map<string, number>();
    for (const r of requests.data ?? []) {
      if (!isPendingRequest(r) || r.requester === member.name || !r.collection) continue;
      out.set(r.collection, (out.get(r.collection) ?? 0) + 1);
    }
    return out;
  }, [requests.data, member.name]);

  const all = collections.data ?? [];
  const rows = useMemo(() => {
    const words = fold(q.trim()).split(/\s+/).filter(Boolean);
    const filtered = all.filter((b) => {
      const text = fold(`${b.displayName ?? ""} ${b.collection?.description ?? ""}`);
      if (!words.every((w) => text.includes(w))) return false;
      return !access || generalAccessOf(b, policies.get(b.name ?? "")) === access;
    });
    return sortCollections(filtered, sort);
  }, [all, policies, q, access, sort]);

  const create = canCreate ? (
    <Button variant="primary" onPress={() => setCreating(true)}>
      <Plus className="i" aria-hidden />
      New collection
    </Button>
  ) : null;

  const empty = (
    <EmptyState
      icon={BookOpen}
      boxed
      title="Create your first collection"
      description="A collection decides who can read a team’s or a function’s documents. Sources and uploads land in one."
      actions={
        canCreate ? (
          <Button variant="primary" onPress={() => setCreating(true)}>
            <Plus className="i" aria-hidden />
            Create collection
          </Button>
        ) : null
      }
    />
  );

  const tools = all.length >= 7 || !!(q || access);
  const accessOptions = (["workspace", "restricted", "private"] as const).map((value) => ({ value, label: accessInfo(value, workspace.displayName ?? "").label }));

  return (
    <>
      <PageHeader title="Collections" chips={workspace.demo ? <PreviewChip label="Demo data" tooltip="This workspace holds fictional demo content." /> : null} actions={create} />
      <Gate query={collections} skeleton={<SkeletonCards cards={6} columns="cols-3" />} isEmpty={(data) => !data.length} empty={empty}>
        {tools ? (
          <div className="toolbar">
            <SearchInput value={q} onChange={setQ} placeholder="Search collections" label="Search collections" />
            <FilterButton label="Access" options={accessOptions} value={access} onChange={setAccess} />
            <ClearFilters isActive={!!access} onClear={() => setAccess("")} />
            <div className="toolbar__end">
              <SortMenu value={sort} options={SORTS} onChange={setSort} />
            </div>
          </div>
        ) : null}
        {rows.length ? (
          <div className="grid cols-3">
            {rows.map((b) => (
              <CollectionCard key={b.name} collection={b} policy={policies.get(b.name ?? "")} requests={decidesHere ? (pending.get(b.name ?? "") ?? 0) : 0} />
            ))}
          </div>
        ) : (
          <NoMatches
            what="collections"
            onClear={() => {
              setQ("");
              setAccess("");
            }}
          />
        )}
      </Gate>
      <CreateCollectionDialog isOpen={creating} onClose={() => setCreating(false)} />
    </>
  );
}

/** Preview `kbCard(kb)`: what a collection holds and, for owners who decide there, the access requests waiting on them. */
function CollectionCard({ collection, policy, requests }: { collection: Item; policy?: Policy; requests: number }) {
  const space = useBaseSpace(collection);
  const access: AccessKey | null = generalAccessOf(collection, policy);
  const linked = collection.collection?.linkCount ?? 0;
  return (
    <Card<"a"> className="card--action kb-card" render={(props) => <NextLink {...props} href={collectionHref(collection.name)} />}>
      <div className="kb-card__top">
        <BaseMark base={collection} size={36} />
        <span className="kb-card__chips">
          {space ? <SpaceChip space={space} /> : null}
          <AccessChip access={access} spaceName={space?.displayName} />
        </span>
      </div>
      <div className="stack gap-2">
        <div className="kb-card__name truncate" translate="no">
          {collection.displayName}
        </div>
        <div className="kb-card__desc truncate" translate="no">
          {collection.collection?.description || "No description"}
        </div>
      </div>
      <div className="kb-card__foot">
        <span className="row gap-4">
          <Files className="i i-sm" aria-hidden />
          {plural(collection.collection?.documentCount ?? 0, "document")}
          {linked ? (
            <Tip content="Documents from other collections shown here without a copy">
              <span className="muted">{` · ${fmtNum(linked)} linked`}</span>
            </Tip>
          ) : null}
        </span>
        {requests ? (
          <StatusChip label={plural(requests, "access request")} tone="warning" icon={UserPlus} size="sm" />
        ) : (
          <span className="truncate">{updatedLabel(collection.updateTime)}</span>
        )}
      </div>
    </Card>
  );
}
