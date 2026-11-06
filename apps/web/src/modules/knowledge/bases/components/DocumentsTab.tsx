"use client";

import { Button } from "@heroui/react";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { AlertTriangle, ArrowRight, Clock, FileText, Plug, Upload } from "lucide-react";
import NextLink from "next/link";
import { useMemo, useState } from "react";

import { Callout } from "@/components/ui/Callout";
import { EmptyState } from "@/components/ui/EmptyState";
import { Gate } from "@/components/ui/Gate";
import { NoMatches } from "@/components/ui/NoMatches";
import { Pager, paginate } from "@/components/ui/Pager";
import { SearchInput } from "@/components/ui/SearchInput";
import { SkeletonRows } from "@/components/ui/SkeletonRows";
import { fmtNum } from "@/lib/format";
import { resourceId } from "@/lib/api/client";
import { useWorkspace } from "@/lib/workspace";

import { listAllItems, quote } from "../../api";
import { openContribute } from "../../components/Contribute";
import { ResourceList, ResourceRow } from "../../components/ResourceRow";
import { catalogHref, fold, type Resource } from "../../model";
import { useContributions, useKnowledgeModel } from "../../queries";
import { SortMenu } from "../../library/components/parts";
import { isOwner, isPersonal, type Item } from "../model";

const PER_PAGE = 20;

/** Documents in a base's subtree. Readers get published ones only (server rule); editors see everything. */
export function useBaseDocuments(base: Item) {
  const { id } = useWorkspace();
  const name = base.name ?? "";
  return useQuery({
    queryKey: [id, "items", "baseDocs", resourceId(name)],
    queryFn: () => listAllItems(id, { filter: `itemType = DOCUMENT AND ancestors:${quote(name)}`, orderBy: "updateTime desc" }, 2000),
    enabled: !!name,
  });
}

/** Preview `addBtn(kb)`: Upload (My files) or Contribute to a shared base; nothing when the caller can't. */
export function AddButton({ base, variant = "secondary", label = "Contribute" }: { base: Item; variant?: "primary" | "secondary"; label?: string }) {
  const { can } = useWorkspace();
  if (isPersonal(base)) {
    return (
      <Button variant={variant} onPress={() => openContribute({ mode: "private" })}>
        <Upload className="i" aria-hidden />
        Upload
      </Button>
    );
  }
  if (!can("contributions.create") || base.collection?.acceptsContributions === false || base.access === "LOCKED") return null;
  return (
    <Button variant={variant} onPress={() => openContribute({ collection: base.name })}>
      <Upload className="i" aria-hidden />
      {label}
    </Button>
  );
}

/** Preview `docsEmpty(kb)`. */
function DocsEmpty({ base }: { base: Item }) {
  const { can } = useWorkspace();
  const add = <AddButton base={base} variant="primary" label="Add documents" />;
  if (isPersonal(base)) {
    return <EmptyState icon={Upload} boxed title="No files yet" description="Upload files to ask about them. Only you can see them." actions={add} />;
  }
  const canAdd = can("contributions.create") && base.collection?.acceptsContributions !== false;
  return (
    <EmptyState
      icon={FileText}
      boxed
      title="Nothing published yet"
      description={canAdd ? "Add documents to share them. A reviewer checks them before they’re published here." : "The owners haven’t published anything here yet."}
      actions={
        <>
          {add}
          {can("sources.create") && isOwner(base) ? (
            <Button variant="secondary" onPress={() => window.location.assign(`/sources?connect=1&kb=${resourceId(base.name)}`)}>
              <Plug className="i" aria-hidden />
              Connect source
            </Button>
          ) : null}
        </>
      }
    />
  );
}

/** Resources tab: the reader list for every role (preview `docsTab`); review and the inventory live in Manage → Documents. */
export function DocumentsTab({ base }: { base: Item }) {
  return <ReaderList base={base} />;
}

/** Preview `reviewAlert(kb)`: what's waiting in Manage → Documents, for the base's reviewers (its owners). */
function ReviewAlert({ base, docs }: { base: Item; docs: readonly Resource[] }) {
  const { can } = useWorkspace();
  const router = useRouter();
  const reviewer = !isPersonal(base) && can("contributions.review") && isOwner(base);
  const inReview = useContributions({ filter: `targetCollection = ${quote(base.name ?? "")} AND state = IN_REVIEW` });
  if (!reviewer) return null;
  const n = inReview.data?.length ?? 0;
  const m = docs.filter((r) => r.lifecycle === "failed").length;
  if (!n && !m) return null;
  const kb = resourceId(base.name);
  const to = m ? `/documents?tab=all&kb=${kb}&life=attention` : `/documents?tab=review&kb=${kb}`;
  return (
    <div className="mb-12">
      <Callout
        tone={m ? "warning" : "accent"}
        icon={m ? AlertTriangle : Clock}
        title={[n && `${fmtNum(n)} in review`, m && `${fmtNum(m)} couldn’t be published`].filter(Boolean).join(" · ")}
        actions={
          <Button size="sm" variant="secondary" onPress={() => router.push(to)}>
            Manage in Documents
          </Button>
        }
      />
    </div>
  );
}

/* ═══════════════ Readers: resources ═══════════════ */

const READER_SORTS = { updated: "Recently updated", title: "Title A–Z" } as const;
type ReaderSort = keyof typeof READER_SORTS;

/** What a reader sees in a base: published, usable resources (preview `isReaderVisible`); My files: all of them. */
const readerVisible = (r: Resource) => r.isPersonal || r.readable || r.lifecycle === "stored";

/** A base's documents as resources, and the ones its reader can see (shares `useBaseDocuments`' query). */
export function useReaderResources(base: Item) {
  const docs = useBaseDocuments(base);
  const { toResource } = useKnowledgeModel();
  const resources = useMemo(() => (docs.data ?? []).map((i) => toResource(i)), [docs.data, toResource]);
  const visible = useMemo(() => resources.filter(readerVisible), [resources]);
  return { docs, resources, visible };
}

function ReaderList({ base }: { base: Item }) {
  const { docs, resources, visible: all } = useReaderResources(base);
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<ReaderSort>("updated");
  const [page, setPage] = useState(1);
  const rows = useMemo(() => {
    const words = fold(q.trim()).split(/\s+/).filter(Boolean);
    const hits = all.filter((r) => {
      const text = fold(`${r.title} ${r.summary} ${r.kindMeta.label}`);
      return words.every((w) => text.includes(w));
    });
    return sort === "title" ? [...hits].sort((a, b) => a.title.localeCompare(b.title)) : hits;
  }, [all, q, sort]);
  const personal = isPersonal(base);

  return (
    <Gate query={docs} skeleton={<SkeletonRows rows={8} />}>
      <ReviewAlert base={base} docs={resources} />
      {!all.length ? (
        <DocsEmpty base={base} />
      ) : (
        <>
          <div className="toolbar">
            <SearchInput
              value={q}
              onChange={(v) => {
                setQ(v);
                setPage(1);
              }}
              placeholder={personal ? "Search my files" : "Search this knowledge base"}
              label={personal ? "Search my files" : "Search this knowledge base"}
            />
            {personal ? null : (
              <NextLink className="link-button" href={catalogHref({ filters: { kb: [resourceId(base.name)] } })}>
                Browse with filters
                <ArrowRight className="i i-sm" aria-hidden />
              </NextLink>
            )}
            <div className="toolbar__end">
              <SortMenu
                value={sort}
                options={READER_SORTS}
                onChange={(v) => {
                  setSort(v);
                  setPage(1);
                }}
              />
            </div>
          </div>
          {rows.length ? (
            <>
              <ResourceList>
                {paginate(rows, page, PER_PAGE).map((r) => (
                  <ResourceRow key={r.name} resource={r} q={q} />
                ))}
              </ResourceList>
              <Pager page={page} pageSize={PER_PAGE} total={rows.length} onPageChange={setPage} />
            </>
          ) : (
            <NoMatches what="resources" onClear={() => setQ("")} />
          )}
        </>
      )}
    </Gate>
  );
}
