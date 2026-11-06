"use client";

import { Button, Chip, Input } from "@heroui/react";
import { ArrowRight, Layers, Lock, MessageSquare, Search, Sparkles, X } from "lucide-react";
import NextLink from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { PageChrome } from "@/components/shell/page-chrome";
import { EmptyState, ErrorState, IconButton, ItemIcon, List, ListItem, Page, Pager, paginate, Section, SectionTabs, SkeletonRows, UserAvatar } from "@/components/ui";
import { resourceId } from "@/lib/api/client";
import { fmtNum, plural, rel } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";
import { BaseMark } from "@/modules/knowledge/bases/components/BaseMark";
import { HighlightText } from "@/modules/knowledge/components/HighlightText";
import { ResourceList, ResourceRow } from "@/modules/knowledge/components/ResourceRow";
import { useShareLabel } from "@/modules/knowledge/components/AddToCollectionDialog";
import { catalogHref, catalogSearchRequest, fold, parseCatalogQuery, snippetOf, type Resource } from "@/modules/knowledge/model";
import { useKnowledgeBases, useKnowledgeModel, useReadingLists, useSearchItems } from "@/modules/knowledge/queries";

import type { Conversation, Member } from "../api";
import { useMyConversations, usePeople } from "../queries";

const PER_GROUP = 5;
const PER_PAGE = 20;

type GroupId = "docs" | "cols" | "kbs" | "convs" | "people";

interface Group {
  id: GroupId;
  label: string;
  /** Matching rows; `null` while unknown (loading or failed). */
  count: number | null;
  isPending: boolean;
  error: unknown;
  retry: () => unknown;
  render: (page: number, all: boolean) => ReactNode;
}

/** Search (`/search?q=&tab=`, preview `P.search`): one query across documents, collections, bases, conversations and (people managers) people. */
export function SearchPage() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const q = (params.get("q") ?? "").trim();
  const tabParam = params.get("tab") ?? "";
  const [text, setText] = useState(params.get("q") ?? "");
  const [page, setPage] = useState(1);
  const inputRef = useRef<HTMLInputElement>(null);

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
    inputRef.current?.focus();
  };
  const ask = () => q && router.push(`/chat?q=${encodeURIComponent(q)}&send=1`);

  const box = (
    <>
      <h1 className="sr-only">Search</h1>
      <div className="srch-box">
        <Search className="i i-lg" aria-hidden />
        <Input
          ref={inputRef}
          className="input--lg"
          type="search"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Search documents, knowledge and conversations"
          aria-label="Search"
          autoComplete="off"
          autoFocus
          fullWidth
        />
        {text ? (
          <span className="srch-box__clear">
            <IconButton icon={X} tip="Clear search" size="sm" onPress={clear} />
          </span>
        ) : null}
      </div>
    </>
  );

  return (
    <Page narrow>
      <PageChrome crumbs={[{ label: "Search" }]} />
      {box}
      {q ? (
        <>
          <button type="button" className="card card--action srch-ask" onClick={ask}>
            <ItemIcon icon={Sparkles} tone="accent" />
            <span className="grow stack">
              <span className="medium">Ask the assistant</span>
              <span className="t-sm muted truncate" translate="no">
                “{q}”
              </span>
            </span>
            <ArrowRight className="i muted" aria-hidden />
          </button>
          <Results key={q} q={q} tab={tabParam} page={page} setPage={setPage} setTab={(id) => (setPage(1), setQuery({ tab: id === "all" ? "" : id }))} onClear={clear} />
        </>
      ) : (
        <EmptyState icon={Search} title="Search your workspace" description="Find documents by name or content, knowledge bases and past conversations." />
      )}
    </Page>
  );
}

const matches = (q: string, ...texts: (string | undefined)[]) => {
  const fq = fold(q);
  return texts.some((t) => !!t && fold(t).includes(fq));
};

function Results({ q, tab, page, setPage, setTab, onClear }: { q: string; tab: string; page: number; setPage: (n: number) => void; setTab: (id: string) => void; onClear: () => void }) {
  const ws = useWorkspace();
  const model = useKnowledgeModel();
  const canPeople = ws.can("members.create");

  /* ── Documents: the catalog search (same ranking and access as Browse) ── */
  const [docTokens, setDocTokens] = useState<string[]>([""]);
  const docPage = tab === "docs" ? Math.min(page, docTokens.length) : 1;
  const request = useMemo(
    () => catalogSearchRequest(parseCatalogQuery({ q }), ws.id, { topics: model.topics, facets: false, pageSize: PER_PAGE, pageToken: docTokens[docPage - 1] || undefined }),
    [q, ws.id, model.topics, docTokens, docPage],
  );
  const docs = useSearchItems(request);
  const next = docs.data?.nextPageToken;
  useEffect(() => {
    if (next && docTokens.length === docPage) setDocTokens((t) => [...t, next]);
  }, [next, docTokens.length, docPage]);
  const docRows = useMemo(
    () => (docs.data?.results ?? []).filter((r) => r.item).map((r) => ({ resource: model.toResource(r.item!), snippet: snippetOf(r) })),
    [docs.data, model],
  );
  const docTotal = docs.data ? (docs.data.totalSize ?? docRows.length) : null;

  /* ── The rest: filtered locally ── */
  const lists = useReadingLists();
  const bases = useKnowledgeBases({ showLocked: true });
  const convs = useMyConversations();
  const people = usePeople({ enabled: canPeople });
  const shareLabel = useShareLabel();

  const cols = (lists.data ?? []).filter((l) => l.type !== "FEATURED" && matches(q, l.displayName, l.description));
  const kbs = (bases.data ?? []).filter((b) => matches(q, b.displayName, b.collection?.description));
  const conversations = (convs.data ?? []).filter((c) => matches(q, c.displayName));
  const members = (people.members.data ?? []).filter((m) => matches(q, m.displayName, m.email));
  const roleNames = new Map((people.roles.data ?? []).map((r) => [r.name ?? "", r.displayName]));

  const browse = (
    <NextLink className="link-button" href={catalogHref({ q })}>
      {docTotal && docTotal > PER_GROUP ? `See all ${fmtNum(docTotal)} in Browse` : "See all in Browse"}
      <ArrowRight className="i i-sm" aria-hidden />
    </NextLink>
  );

  const groups: Group[] = [
    {
      id: "docs",
      label: "Documents",
      count: docTotal,
      isPending: docs.isPending,
      error: docs.data ? null : docs.error,
      retry: docs.refetch,
      render: (_page, all) => (
        <>
          <ResourceList>
            {(all ? docRows.slice(0, PER_GROUP) : docRows).map(({ resource, snippet }: { resource: Resource; snippet: string | null }) => (
              <ResourceRow key={resource.name} resource={resource} q={q} snippet={snippet} />
            ))}
          </ResourceList>
          {all ? null : (
            <>
              <Pager page={docPage} pageSize={PER_PAGE} total={docs.data?.totalSize} pageCount={docRows.length} hasNext={!!next} onPageChange={setPage} />
              <div className="srch-more">{browse}</div>
            </>
          )}
        </>
      ),
    },
    {
      id: "cols",
      label: "Collections",
      count: lists.data ? cols.length : null,
      isPending: lists.isPending,
      error: lists.data ? null : lists.error,
      retry: lists.refetch,
      render: (p, all) => (
        <List className="srch-list">
          {(all ? cols.slice(0, PER_GROUP) : paginate(cols, p, PER_PAGE)).map((c) => {
            const s = shareLabel(c);
            return (
              <ListItem
                key={c.name}
                lead={<ItemIcon icon={Layers} size="sm" />}
                title={<HighlightText text={c.displayName ?? ""} q={q} />}
                label={c.displayName}
                contentTitle
                description={c.description ? <span translate="no"><HighlightText text={c.description} q={q} /></span> : undefined}
                meta={
                  <>
                    <span className="row gap-4">
                      <s.icon className="i i-xs" aria-hidden />
                      {s.label}
                    </span>{" "}
                    · {plural(c.itemCount ?? 0, "item")}
                  </>
                }
                href={`/knowledge/collections/${resourceId(c.name)}`}
              />
            );
          })}
        </List>
      ),
    },
    {
      id: "kbs",
      label: "Knowledge bases",
      count: bases.data ? kbs.length : null,
      isPending: bases.isPending,
      error: bases.data ? null : bases.error,
      retry: bases.refetch,
      render: (p, all) => (
        <List className="srch-list">
          {(all ? kbs.slice(0, PER_GROUP) : paginate(kbs, p, PER_PAGE)).map((k) => {
            const locked = k.access === "LOCKED";
            return (
              <ListItem
                key={k.name}
                lead={<BaseMark base={k} size={32} />}
                title={<HighlightText text={k.displayName ?? ""} q={q} />}
                label={k.displayName}
                contentTitle
                description={k.collection?.description ? <span translate="no"><HighlightText text={k.collection.description} q={q} /></span> : undefined}
                meta={
                  locked ? (
                    <Chip size="sm">
                      <Lock className="i i-xs" aria-hidden />
                      Locked
                    </Chip>
                  ) : (
                    plural(k.collection?.documentCount ?? 0, "document")
                  )
                }
                href={`/knowledge/${resourceId(k.name)}`}
              />
            );
          })}
        </List>
      ),
    },
    {
      id: "convs",
      label: "Conversations",
      count: convs.data ? conversations.length : null,
      isPending: convs.isPending,
      error: convs.data ? null : convs.error,
      retry: convs.refetch,
      render: (p, all) => (
        <List className="srch-list">
          {(all ? conversations.slice(0, PER_GROUP) : paginate(conversations, p, PER_PAGE)).map((c: Conversation) => (
            <ListItem
              key={c.name}
              lead={<ItemIcon icon={MessageSquare} size="sm" />}
              title={<HighlightText text={c.displayName || "New conversation"} q={q} />}
              label={c.displayName}
              contentTitle
              meta={rel(c.lastMessageTime ?? c.updateTime)}
              href={`/chat/${resourceId(c.name)}`}
            />
          ))}
        </List>
      ),
    },
  ];
  if (canPeople)
    groups.push({
      id: "people",
      label: "People",
      count: people.members.data ? members.length : null,
      isPending: people.members.isPending,
      error: people.members.data ? null : people.members.error,
      retry: people.members.refetch,
      render: (p, all) => (
        <List className="srch-list">
          {(all ? members.slice(0, PER_GROUP) : paginate(members, p, PER_PAGE)).map((m: Member) => (
            <ListItem
              key={m.name}
              lead={<UserAvatar name={m.displayName ?? m.email ?? ""} size="sm" />}
              title={<HighlightText text={m.displayName ?? ""} q={q} />}
              label={m.displayName}
              description={<HighlightText text={m.email ?? ""} q={q} />}
              meta={(m.roles ?? []).map((r) => roleNames.get(r) ?? "").filter(Boolean)[0]}
              href={`/people?tab=members&open=${resourceId(m.name)}`}
            />
          ))}
        </List>
      ),
    });

  const loading = (g: Group) => g.count === null && !g.error;
  if (groups.every(loading)) return <SkeletonRows rows={6} />;

  const total = groups.reduce((n, g) => n + (g.count ?? 0), 0);
  const unsettled = groups.filter((g) => g.error || loading(g));
  if (!total && !unsettled.length) {
    return (
      <EmptyState
        icon={Search}
        title={`No results for “${q}”`}
        description="Try different words, or ask the assistant — it can find answers across everything you can access."
        actions={<Button onPress={onClear}>Clear search</Button>}
        boxed
      />
    );
  }

  const active: "all" | GroupId = groups.some((g) => g.id === tab) ? (tab as GroupId) : "all";
  const tabs = (
    <div className="page-tabs">
      <SectionTabs
        label="Result types"
        active={active}
        onChange={setTab}
        items={[{ id: "all", label: "All", count: total }, ...groups.map((g) => ({ id: g.id, label: g.label, count: g.count }))]}
      />
    </div>
  );
  const errorOf = (g: Group) => <ErrorState error={g.error} onRetry={g.retry} compact />;

  if (active === "all") {
    return (
      <>
        {tabs}
        {groups
          .filter((g) => g.error || g.count || loading(g))
          .map((g) => (
            <Section
              key={g.id}
              title={g.label}
              actions={
                g.error ? null : g.id === "docs" ? (
                  browse
                ) : (g.count ?? 0) > PER_GROUP ? (
                  <button type="button" className="link-button" onClick={() => setTab(g.id)}>
                    See all {fmtNum(g.count ?? 0)}
                  </button>
                ) : null
              }
            >
              {g.error ? errorOf(g) : loading(g) ? <SkeletonRows rows={3} /> : g.render(1, true)}
            </Section>
          ))}
      </>
    );
  }

  const g = groups.find((x) => x.id === active)!;
  return (
    <>
      {tabs}
      {g.error ? (
        errorOf(g)
      ) : loading(g) ? (
        <SkeletonRows rows={6} />
      ) : !g.count ? (
        <EmptyState icon={Search} title={`No ${g.label.toLowerCase()} match`} description="Try another word." boxed compact />
      ) : (
        <>
          {g.render(page, false)}
          {g.id === "docs" ? null : <Pager page={page} pageSize={PER_PAGE} total={g.count} onPageChange={setPage} />}
        </>
      )}
    </>
  );
}
