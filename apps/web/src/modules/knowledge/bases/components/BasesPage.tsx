"use client";

import { Button, Card } from "@heroui/react";
import { BookOpen, Files, Plus, Upload } from "lucide-react";
import NextLink from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState, type KeyboardEvent } from "react";

import { ClearFilters } from "@/components/ui/ClearFilters";
import { EmptyState } from "@/components/ui/EmptyState";
import { FilterButton } from "@/components/ui/FilterButton";
import { Gate } from "@/components/ui/Gate";
import { NoMatches } from "@/components/ui/NoMatches";
import { Page } from "@/components/ui/Page";
import { SearchInput } from "@/components/ui/SearchInput";
import { SkeletonCards } from "@/components/ui/SkeletonCards";
import { PageChrome } from "@/components/shell/page-chrome";
import { resourceId } from "@/lib/api/client";
import { plural } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";

import { openContribute } from "../../components/Contribute";
import { KnowledgeHeader } from "../../components/KnowledgeHeader";
import { updatedLabel } from "../../components/ResourceRow";
import { fold } from "../../model";
import { useKnowledgeBases } from "../../queries";
import { SortMenu } from "../../library/components/parts";
import { generalAccessOf, isLocked, isPersonal, type Item, type Policy } from "../model";
import { useBasePolicies } from "../queries";
import { BaseMark } from "./BaseMark";
import { CreateBaseDialog } from "./CreateBaseDialog";
import { AccessChip, SpaceChip, ownersLabel, useBaseSpace } from "./parts";
import { RequestAccessCta } from "./RequestAccessDialog";

const SORTS = { updated: "Recently updated", name: "Name", docs: "Most documents" } as const;
type SortKey = keyof typeof SORTS;

const ACCESS_FILTER = [
  { value: "workspace", label: "Everyone" },
  { value: "restricted", label: "Restricted" },
  { value: "private", label: "Private" },
];

/** My files' description when the server has none (preview data). */
export const MY_FILES_DESC = "Only you can see these. Use them in your own chats and work.";

/** Bases the caller sees: shared ones (incl. locked) plus only their own My files. */
export function useVisibleBases() {
  const { member } = useWorkspace();
  const bases = useKnowledgeBases({ showLocked: true });
  const data = useMemo(
    () => (bases.data ?? []).filter((b) => b.state !== "DELETED" && (!isPersonal(b) || b.collection?.owner === member.name)),
    [bases.data, member.name],
  );
  return { ...bases, data: bases.data ? data : undefined };
}

function sortBases(rows: Item[], by: SortKey) {
  const cmp: Record<SortKey, (a: Item, b: Item) => number> = {
    updated: (a, b) => (b.updateTime ?? "").localeCompare(a.updateTime ?? ""),
    name: (a, b) => (a.displayName ?? "").localeCompare(b.displayName ?? ""),
    docs: (a, b) => (b.collection?.documentCount ?? 0) - (a.collection?.documentCount ?? 0),
  };
  return [...rows].sort((a, b) => Number(isPersonal(b)) - Number(isPersonal(a)) || cmp[by](a, b));
}

/** `/knowledge/bases` (preview `P.kbList`). */
export function BasesPage() {
  const { can } = useWorkspace();
  const bases = useVisibleBases();
  const policies = useBasePolicies(bases.data ?? []);
  const [q, setQ] = useState("");
  const [access, setAccess] = useState("");
  const [sort, setSort] = useState<SortKey>("updated");
  const canCreate = can("items.create");
  const search = useSearchParams();
  // `?new=1` (Overview) / `?create=1` (command palette) open "Create knowledge base".
  const [creating, setCreating] = useState(() => canCreate && (search.get("new") === "1" || search.get("create") === "1"));

  const rows = useMemo(() => {
    const words = fold(q.trim()).split(/\s+/).filter(Boolean);
    const filtered = (bases.data ?? []).filter((b) => {
      const text = fold(`${b.displayName ?? ""} ${b.collection?.description ?? ""}`);
      if (!words.every((w) => text.includes(w))) return false;
      // Preview `accessKey`: My files counts as private.
      const key = generalAccessOf(b, policies.get(b.name ?? ""));
      return !access || (key === "personal" ? "private" : key) === access;
    });
    return sortBases(filtered, sort);
  }, [bases.data, policies, q, access, sort]);

  const createButton = canCreate ? (
    <Button variant="primary" onPress={() => setCreating(true)}>
      <Plus className="i" aria-hidden />
      Create knowledge base
    </Button>
  ) : null;

  return (
    <Page>
      <PageChrome crumbs={[{ label: "Knowledge", href: "/knowledge" }, { label: "Knowledge bases" }]} />
      <KnowledgeHeader active="bases" actions={createButton} />
      <Gate
        query={bases}
        skeleton={<SkeletonCards cards={6} columns="cols-3" />}
        isEmpty={(data) => !data.length}
        empty={
          canCreate ? (
            <EmptyState
              icon={BookOpen}
              boxed
              title="Create your first knowledge base"
              description="Group documents by team or topic, then add files or connect a source."
              actions={
                <Button variant="primary" onPress={() => setCreating(true)}>
                  <Plus className="i" aria-hidden />
                  Create knowledge base
                </Button>
              }
            />
          ) : (
            <EmptyState
              icon={BookOpen}
              boxed
              title="Nothing has been shared with you yet"
              description="Upload your own files to ask about them. Only you can see My files."
              actions={
                <Button variant="primary" onPress={() => openContribute({ mode: "private" })}>
                  <Upload className="i" aria-hidden />
                  Upload to My files
                </Button>
              }
            />
          )
        }
      >
        <div className="toolbar">
          <SearchInput value={q} onChange={setQ} placeholder="Search knowledge bases" label="Search knowledge bases" />
          <FilterButton label="Access" options={ACCESS_FILTER} value={access} onChange={setAccess} />
          <ClearFilters isActive={!!access} onClear={() => setAccess("")} />
          <div className="toolbar__end">
            <SortMenu value={sort} options={SORTS} onChange={setSort} />
          </div>
        </div>
        {rows.length ? (
          <div className="grid cols-3">
            {rows.map((b) => (
              <BaseCard key={b.name} base={b} policy={policies.get(b.name ?? "")} />
            ))}
          </div>
        ) : (
          <NoMatches
            what="knowledge bases"
            onClear={() => {
              setQ("");
              setAccess("");
            }}
          />
        )}
      </Gate>
      <CreateBaseDialog isOpen={creating} onClose={() => setCreating(false)} />
    </Page>
  );
}

/** Preview `kbCard(kb)`: mark + space/access chips, name, description, documents · updated; locked → owners + Request access. */
function BaseCard({ base, policy }: { base: Item; policy?: Policy }) {
  const router = useRouter();
  const space = useBaseSpace(base);
  const locked = isLocked(base);
  const href = `/knowledge/${resourceId(base.name)}`;
  const desc = base.collection?.description || (isPersonal(base) ? MY_FILES_DESC : "No description");
  const top = (
    <div className="kb-card__top">
      <BaseMark base={base} size={36} />
      <span className="kb-card__chips">
        {space ? <SpaceChip space={space} /> : null}
        <AccessChip access={generalAccessOf(base, policy)} spaceName={space?.displayName} />
      </span>
    </div>
  );
  const text = (
    <div className="stack gap-2">
      <div className="kb-card__name truncate" translate="no">
        {base.displayName}
      </div>
      <div className="kb-card__desc truncate" translate="no">
        {desc}
      </div>
    </div>
  );

  if (locked) {
    const open = () => router.push(href);
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
        e.preventDefault();
        open();
      }
    };
    return (
      <Card className="card--action kb-card" role="link" tabIndex={0} aria-label={`${base.displayName ?? ""}, locked`} onClick={open} onKeyDown={onKeyDown}>
        {top}
        {text}
        <div className="kb-card__foot">
          <span className="truncate">{ownersLabel(base)}</span>
          <span onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
            <RequestAccessCta base={base} />
          </span>
        </div>
      </Card>
    );
  }

  return (
    <Card<"a"> className="card--action kb-card" render={(props) => <NextLink {...props} href={href} />}>
      {top}
      {text}
      <div className="kb-card__foot">
        <span className="row gap-4">
          <Files className="i i-sm" aria-hidden />
          {plural(base.collection?.documentCount ?? 0, "document")}
        </span>
        <span className="truncate">{updatedLabel(base.updateTime)}</span>
      </div>
    </Card>
  );
}
