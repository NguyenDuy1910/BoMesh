"use client";

import { Button } from "@heroui/react";
import { ArrowLeft, ArrowRight, Lock, MessageSquare, Search, Sparkles } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { EmptyState, ErrorState, ItemIcon, LinkButton, List, ListItem, Page, PageHeader, Pager, SearchInput, Section, SkeletonRows, StatusChip, UserAvatar } from "@/components/ui";
import { resourceId } from "@/lib/api/client";
import { fmtNum, plural, rel } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";
import { BaseMark } from "@/modules/knowledge/bases/components/BaseMark";
import { HighlightText } from "@/modules/knowledge/components/HighlightText";
import { ResourceList, ResourceRow } from "@/modules/knowledge/components/ResourceRow";
import { catalogHref, catalogSearchRequest, fold, parseCatalogQuery, snippetOf, tokens } from "@/modules/knowledge/model";
import { openDocumentPreview } from "@/modules/knowledge/preview/store";
import { useKnowledgeBases, useKnowledgeModel, useSearchItems } from "@/modules/knowledge/queries";
import { originParam } from "@/modules/knowledge/reader/links";

import type { Conversation, Member } from "../api";
import { useMyConversations, usePeople } from "../queries";

const PER_GROUP = 5;
const PER_PAGE = 20;

type GroupId = "docs" | "kbs" | "convs" | "people";

interface Group {
  id: GroupId;
  label: string;
  /** Matching rows; `null` while unknown (loading or failed). */
  count: number | null;
  error: unknown;
  retry: () => unknown;
  /** Rows `start`–`end` of the group. */
  render: (start: number, end: number) => ReactNode;
}

/** A group of matched rows rendered as a `.srch-list` list. */
function listGroup<T>({ rows, item, ...g }: Omit<Group, "render"> & { rows: readonly T[]; item: (row: T) => ReactNode }): Group {
  return { ...g, render: (start, end) => <List className="srch-list">{rows.slice(start, end).map(item)}</List> };
}

/** Every query word (folded) starts a word somewhere in the texts (preview search.js `matches`). */
function matches(toks: readonly string[], ...texts: (string | undefined)[]) {
  if (!toks.length) return false;
  const words = " " + texts.map((t) => fold(t ?? "").replace(/[^\p{L}\p{N}]+/gu, " ")).join(" ");
  return toks.every((t) => words.includes(" " + t));
}

/**
 * Search (`/search?q=&tab=`, preview `P.search`): a grouped overview of one query — documents (the top five; the
 * full set with filters is Browse), collections, conversations and, for people managers, people.
 * Other groups open their full list here (`?tab=`).
 */
export function SearchPage() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const q = (params.get("q") ?? "").trim();
  const tab = params.get("tab") ?? "";
  const [text, setText] = useState(params.get("q") ?? "");
  const [page, setPage] = useState(1);

  const setQuery = (patch: Record<string, string>) => {
    const next = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(patch)) (v ? next.set(k, v) : next.delete(k));
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };

  // The box writes the URL (debounced); the URL is the result set.
  useEffect(() => {
    if (text.trim() === q) return;
    const t = window.setTimeout(() => {
      setPage(1);
      setQuery({ q: text.trim() });
    }, 250);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  const clear = () => {
    setText("");
    setPage(1);
    setQuery({ q: "", tab: "" });
  };
  const ask = () => q && router.push(`/chat?q=${encodeURIComponent(q)}&send=1`);

  return (
    <Page width="narrow">
      <PageHeader title="Search" />
      <div className="srch-top">
        <SearchInput value={text} onChange={setText} label="Search" placeholder="Search documents, collections and conversations" size="md" fullWidth autoFocus />
      </div>
      {q ? (
        <>
          {/* Same wording as Home and ⌘K: "Ask AI", answered with sources. */}
          <button type="button" className="card card--action srch-ask" onClick={ask}>
            <ItemIcon icon={Sparkles} tone="accent" />
            <span className="grow stack">
              <span className="medium">Ask AI</span>
              <span className="t-sm muted truncate">
                <span translate="no">“{q}”</span>
                {" · "}
                {"Answer with sources"}
              </span>
            </span>
            <ArrowRight className="i muted" aria-hidden />
          </button>
          <Results
            key={q}
            q={q}
            tab={tab}
            page={page}
            setPage={setPage}
            setTab={(id) => {
              setPage(1);
              setQuery({ tab: id === "all" ? "" : id });
              window.scrollTo({ top: 0 });
            }}
            onClear={clear}
          />
        </>
      ) : (
        <EmptyState icon={Search} title="Search your workspace" description="Find documents by name or content, collections and past conversations." />
      )}
    </Page>
  );
}

function Results({ q, tab, page, setPage, setTab, onClear }: { q: string; tab: string; page: number; setPage: (n: number) => void; setTab: (id: string) => void; onClear: () => void }) {
  const ws = useWorkspace();
  const model = useKnowledgeModel();
  const canPeople = ws.can("members.create");
  const toks = useMemo(() => tokens(q), [q]);

  /* Documents: the catalog search (same ranking and access as Browse); the full set is Browse. */
  const request = useMemo(() => catalogSearchRequest(parseCatalogQuery({ q }), ws.id, { facets: false, pageSize: PER_GROUP }), [q, ws.id]);
  const docs = useSearchItems(request);
  const docRows = useMemo(() => (docs.data?.results ?? []).filter((r) => r.item).map((r) => ({ resource: model.toResource(r.item!), snippet: snippetOf(r) })), [docs.data, model]);
  const docTotal = docs.data ? (docs.data.totalSize ?? docRows.length) : null;

  /* The rest: matched locally. */
  const bases = useKnowledgeBases({ showLocked: true });
  const convs = useMyConversations();
  const people = usePeople({ enabled: canPeople });
  const roleNames = new Map((people.roles.data ?? []).map((r) => [r.name ?? "", r.displayName]));

  const kbRows = (bases.data ?? []).filter((b) => matches(toks, b.displayName, b.collection?.description));
  const convRows = (convs.data ?? []).filter((c) => matches(toks, c.displayName));
  const memberRows = (people.members.data ?? []).filter((m) => matches(toks, m.displayName, m.email));

  const groups: Group[] = [
    {
      id: "docs",
      label: "Documents",
      count: docTotal,
      error: docs.data ? null : docs.error,
      retry: docs.refetch,
      render: () => (
        <ResourceList>
          {docRows.map(({ resource, snippet }) => (
            <ResourceRow
              key={resource.name}
              resource={resource}
              q={q}
              snippet={snippet}
              onOpen={() => openDocumentPreview({ item: resource.name, listed: resource.item, q, from: originParam({ kind: "search" }) })}
            />
          ))}
        </ResourceList>
      ),
    },
    listGroup({
      id: "kbs",
      label: "Collections",
      count: bases.data ? kbRows.length : null,
      error: bases.data ? null : bases.error,
      retry: bases.refetch,
      rows: kbRows,
      // A collection's documents are a Browse filter; a locked one there offers Request access.
      item: (k) => {
        const locked = k.access === "LOCKED";
        return (
          <ListItem
            key={k.name}
            lead={<BaseMark base={k} size={32} />}
            title={<HighlightText text={k.displayName ?? ""} q={q} />}
            label={k.displayName}
            contentTitle
            description={k.collection?.description ? <span translate="no"><HighlightText text={k.collection.description} q={q} /></span> : undefined}
            meta={locked ? <StatusChip label="Locked" icon={Lock} size="sm" /> : plural(k.collection?.documentCount ?? 0, "document")}
            href={k.itemType === "PERSONAL" ? "/knowledge/library?tab=files" : catalogHref({ filters: { kb: [resourceId(k.name)] } })}
          />
        );
      },
    }),
    listGroup({
      id: "convs",
      label: "Conversations",
      count: convs.data ? convRows.length : null,
      error: convs.data ? null : convs.error,
      retry: convs.refetch,
      rows: convRows,
      item: (c: Conversation) => (
        <ListItem
          key={c.name}
          lead={<ItemIcon icon={MessageSquare} size="sm" />}
          title={<HighlightText text={c.displayName || "New conversation"} q={q} />}
          label={c.displayName}
          contentTitle
          meta={rel(c.lastMessageTime ?? c.updateTime)}
          href={`/chat/${resourceId(c.name)}`}
        />
      ),
    }),
    ...(canPeople
      ? [
          listGroup({
            id: "people",
            label: "People",
            count: people.members.data ? memberRows.length : null,
            error: people.members.data ? null : people.members.error,
            retry: people.members.refetch,
            rows: memberRows,
            item: (m: Member) => (
              <ListItem
                key={m.name}
                lead={<UserAvatar name={m.displayName ?? m.email ?? ""} size="sm" />}
                title={<HighlightText text={m.displayName ?? ""} q={q} />}
                label={m.displayName}
                description={<HighlightText text={m.email ?? ""} q={q} />}
                meta={(m.roles ?? []).map((r) => roleNames.get(r) ?? "").filter(Boolean)[0]}
                href={`/people?tab=members&open=${resourceId(m.name)}`}
              />
            ),
          }),
        ]
      : []),
  ];

  const loading = (g: Group) => g.count === null && !g.error;
  if (groups.every(loading)) return <SkeletonRows rows={6} />;

  const total = groups.reduce((n, g) => n + (g.count ?? 0), 0);
  if (!total && !groups.some((g) => g.error || loading(g))) {
    return (
      <EmptyState
        icon={Search}
        title={`No results for “${q}”`}
        description="Try different words, or ask AI above — it answers from everything you can access."
        actions={
          <Button variant="tertiary" onPress={onClear}>
            Clear search
          </Button>
        }
        boxed
      />
    );
  }

  // Documents never paginate here: their full set (with filters and sort) is Browse.
  const open = groups.find((g) => g.id === tab && g.id !== "docs");
  if (open) {
    return (
      <>
        <div className="srch-back">
          <Button variant="ghost" size="sm" onPress={() => setTab("all")}>
            <ArrowLeft aria-hidden />
            All results
          </Button>
        </div>
        <Section title={`${open.label} · ${fmtNum(open.count ?? 0)}`}>
          {open.error ? (
            <ErrorState error={open.error} onRetry={open.retry} compact />
          ) : loading(open) ? (
            <SkeletonRows rows={6} />
          ) : (
            <>
              {open.render((page - 1) * PER_PAGE, page * PER_PAGE)}
              <Pager page={page} pageSize={PER_PAGE} total={open.count ?? 0} onPageChange={setPage} />
            </>
          )}
        </Section>
      </>
    );
  }

  const more = (g: Group) =>
    g.id === "docs" ? (
      <LinkButton href={catalogHref({ q })} icon={ArrowRight}>
        {(g.count ?? 0) > PER_GROUP ? `See all ${fmtNum(g.count ?? 0)} in Knowledge` : "Open in Knowledge"}
      </LinkButton>
    ) : (g.count ?? 0) > PER_GROUP ? (
      <LinkButton onPress={() => setTab(g.id)} icon={ArrowRight}>
        {`See all ${fmtNum(g.count ?? 0)}`}
      </LinkButton>
    ) : null;

  return (
    <>
      {groups
        .filter((g) => g.error || g.count || loading(g))
        .map((g) => (
          <Section key={g.id} title={g.label} actions={g.error ? null : more(g)}>
            {g.error ? <ErrorState error={g.error} onRetry={g.retry} compact /> : loading(g) ? <SkeletonRows rows={3} /> : g.render(0, PER_GROUP)}
          </Section>
        ))}
    </>
  );
}
