"use client";

import { Button, Dropdown, Header, Label, Separator } from "@heroui/react";
import { useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { ArrowRight, BookOpen, Calendar, History, Inbox, Megaphone, MessageSquare, Search, ShieldCheck, SlidersHorizontal, Sparkles, Tag, Upload, X, type LucideIcon } from "lucide-react";
import type { IconName } from "lucide-react/dynamic";
import dynamic from "next/dynamic";
import NextLink from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";

import { PageChrome } from "@/components/shell/page-chrome";
import { EmptyState, ErrorState, FileIcon, ItemIcon, List, ListItem, Tip, toast } from "@/components/ui";
import { errorMessage, resourceId } from "@/lib/api/client";
import { plural, rel } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";
import { openContribute } from "@/modules/knowledge/components/contribute-store";
import { openDocumentPreview } from "@/modules/knowledge/preview/store";
import { ContributeButton } from "@/modules/knowledge/components/KnowledgeHeader";
import { deleteReadingListEntry, featureItem, FEATURED_LIST } from "@/modules/knowledge/api";
import { catalogHref, kindMeta, typeLabelFor } from "@/modules/knowledge/model";
import { knowledgeKeys, useKnowledgeModel, useTopics } from "@/modules/knowledge/queries";
import { ResDot } from "@/modules/knowledge/components/ResourceRow";
import { useMyConversations } from "@/modules/search/queries";
import { upNextWhen, useUpNext } from "@/modules/spaces";

import type { MemberHome, MemberHomeItem } from "../api";
import { callName, greeting } from "../intent";
import { homeKeys, useCardDetails, useFreshCount, useInsights, useLastViews, useMemberHome, type Insight } from "../queries";

/** Topic icons are any Lucide name an admin picked: the name → icon loader table loads after first paint. */
const DynamicIcon = dynamic(() => import("lucide-react/dynamic").then((m) => m.DynamicIcon), { ssr: false, loading: () => <Tag className="i i-sm" /> });

const DAY = 86_400_000;
const bare = (n?: string) => String(n ?? "").replace(/\.[a-z0-9]{1,5}$/i, "");
const relLow = (t?: string) => rel(t).replace(/^(Just now|Yesterday)$/, (m) => m.toLowerCase());

/** Tells `HomeBody` whether a section rendered anything, so it can fall back once every section is empty. */
function useReportVisible(onVisible: ((visible: boolean) => void) | undefined, visible: boolean) {
  useEffect(() => onVisible?.(visible), [onVisible, visible]);
}

/** Home (`/home`, preview `P.home`): Discover & start — a greeting, three intent cards, then only what has value now. */
export function HomePage() {
  const ws = useWorkspace();
  const home = useMemberHome();
  const convs = useMyConversations();
  const firstVisit = !!home.data && !convs.isPending && !(home.data.continue?.recentItems?.length ?? 0) && !(convs.data?.length ?? 0);
  const pool = home.data?.counts?.documentCount ?? 0;
  const empty = home.isSuccess && !pool;

  return (
    <div className="page home">
      <PageChrome crumbs={[{ label: "Home" }]} />
      <header className="home-head">
        <h1 className="home-title">
          {greeting()}, <span translate="no">{callName(ws.member.displayName)}</span>
        </h1>
        <Lede home={home.data} loading={home.isPending} />
      </header>
      {empty ? null : <IntentCards pool={pool} />}
      {home.isPending ? (
        <LoadingBody />
      ) : home.isError ? (
        <section className="home-sec">
          <ErrorState error={home.error} onRetry={home.refetch} />
        </section>
      ) : empty ? (
        <EmptyBody />
      ) : (
        <HomeBody home={home.data} firstVisit={firstVisit} />
      )}
    </div>
  );
}

/** One line of scale, computed from what the caller can read (preview `lede()`). */
function Lede({ home, loading }: { home: MemberHome | undefined; loading: boolean }) {
  const n = home?.counts?.documentCount ?? 0;
  // Only worth a request once something is readable; hooks still run on every render.
  const fresh = useFreshCount({ enabled: !loading && n > 0 });
  if (loading) return <p className="home-lede">&nbsp;</p>;
  if (!n) return <p className="home-lede">Find documents, ask questions answered from them and share what you know.</p>;
  const topics = home?.counts?.topicCount ?? 0;
  return (
    <p className="home-lede">
      <span>{topics ? `${plural(n, "document")} you can read, across ${plural(topics, "topic")}` : `${plural(n, "document")} you can read`}</span>
      {fresh ? <span className="home-lede__fresh">{`${fresh} updated in the last 30 days`}</span> : null}
    </p>
  );
}

/* ═══════════════ Intent cards: find · ask · contribute ═══════════════ */

interface IntentCard {
  icon: LucideIcon;
  tone?: "accent";
  title: string;
  desc: string;
  href?: string;
  onPress?: () => void;
}

/** The three things people come here to do (preview `starts()`). Entry points, not a composer: nothing is typed on Home. */
function IntentCards({ pool }: { pool: number }) {
  const ws = useWorkspace();
  const router = useRouter();
  const canContribute = ws.can("contributions.create");
  const cards: IntentCard[] = [
    {
      icon: Search,
      title: "Find a document",
      desc: pool ? `Search ${plural(pool, "document")} by title, topic or content` : "Search by title, topic or content",
      onPress: () => router.push(catalogHref({}) + "?focus=1"),
    },
    { icon: Sparkles, tone: "accent", title: "Ask a question", desc: `Answers from ${ws.workspace.displayName} documents, with citations`, href: "/chat" },
    canContribute
      ? { icon: Upload, title: "Contribute knowledge", desc: "Share a document; a reviewer publishes it", onPress: () => openContribute() }
      : { icon: BookOpen, title: "Your library", desc: "Saved documents, recent reads and collections", href: "/knowledge/library" },
  ];
  return (
    <nav className="home-starts" aria-label="Get started">
      {cards.map((c) => {
        const inner = (
          <>
            <ItemIcon icon={c.icon} tone={c.tone} />
            <span className="home-start__body">
              <span className="home-start__title">{c.title}</span>
              <span className="home-start__desc">{c.desc}</span>
            </span>
            <ArrowRight className="i i-sm home-start__go" aria-hidden />
          </>
        );
        return c.href ? (
          <NextLink key={c.title} className="home-start" href={c.href}>
            {inner}
          </NextLink>
        ) : (
          <button key={c.title} type="button" className="home-start" onClick={c.onPress}>
            {inner}
          </button>
        );
      })}
    </nav>
  );
}

/* ═══════════════ Body: main (carry on, discover) · aside (timely) ═══════════════ */

function HomeBody({ home, firstVisit }: { home: MemberHome; firstVisit: boolean }) {
  const last = useLastViews();
  const readCollections = useMemo(() => new Set((home.continue?.recentItems ?? []).map((i) => i.collection ?? "").filter(Boolean)), [home.continue?.recentItems]);
  const insights = useInsights({ readCollections });
  const know = insights.data ?? [];
  const shown = new Set(know.map((x) => x.resource.id));
  // Every section below shows only what it has; once all have reported in and none did, the body
  // would otherwise render empty with no next step, so a light fallback takes its place.
  const [visible, setVisible] = useState<Partial<Record<"attention" | "continue" | "reading" | "explore" | "news", boolean>>>({});
  const report = useCallback(
    (id: "attention" | "continue" | "reading" | "explore" | "news") => (v: boolean) =>
      setVisible((prev: Partial<Record<"attention" | "continue" | "reading" | "explore" | "news", boolean>>) => (prev[id] === v ? prev : { ...prev, [id]: v })),
    [],
  );
  const onAttention = useMemo(() => report("attention"), [report]);
  const onContinue = useMemo(() => report("continue"), [report]);
  const onReading = useMemo(() => report("reading"), [report]);
  const onExplore = useMemo(() => report("explore"), [report]);
  const onNews = useMemo(() => report("news"), [report]);
  const keys = ["attention", "continue", "reading", "explore", "news"] as const;
  const settled = keys.every((k) => k in visible) && !insights.isPending;
  const nothingToShow = settled && !Object.values(visible).some(Boolean);
  const hasAside = visible.attention || visible.news;

  const reading = <ReadingSection home={home} firstVisit={firstVisit} exclude={shown} views={last.views} onVisible={onReading} />;
  return (
    <div className={clsx("home-body", !hasAside && "home-body--single")}>
      <div className="home-main">
        <ContinueSection home={home} views={last.views} onVisible={onContinue} />
        {firstVisit ? reading : null}
        <ExploreSection home={home} onVisible={onExplore} />
        {firstVisit ? null : reading}
      </div>
      <aside className="home-aside" aria-label="For you now">
        <AttentionSection onVisible={onAttention} />
        {insights.isPending ? null : <InsightsSection list={know} onVisible={onNews} />}
      </aside>
      {nothingToShow ? <CaughtUpBody /> : null}
    </div>
  );
}

/** Preview `homeCaughtUp()`: every section had nothing of its own to show, but the workspace isn't empty. */
function CaughtUpBody() {
  return (
    <section className="home-sec home-sec--caught-up">
      <EmptyState
        icon={BookOpen}
        title="You’re caught up"
        description="Nothing needs you and nothing new changed. Explore what's published or start a conversation to search it."
        actions={
          <>
            <NextLinkButton href="/knowledge">Knowledge</NextLinkButton>
            <NextLinkButton href="/chat">Ask a question</NextLinkButton>
          </>
        }
        boxed
      />
    </section>
  );
}

/* ═══════════════ Needs your attention (aside) ═══════════════ */

interface AttentionItem {
  href: string;
  lead: ReactNode;
  title: string;
  sub: string;
}

/** What is waiting on you: changes requested, your review queue, a reply or something due soon (three at most). */
function AttentionSection({ onVisible }: { onVisible?: (visible: boolean) => void }) {
  const ws = useWorkspace();
  const home = useMemberHome();
  const withUpNext = ws.hasModule("spaces") || ws.hasModule("requests");
  const upNext = useUpNext({ limit: 4 });
  const items: AttentionItem[] = [];
  for (const c of (home.data?.continue?.contributions ?? []).filter((c) => c.state === "CHANGES_REQUESTED").slice(0, 1))
    items.push({
      href: `/knowledge/library?tab=contributions&open=${resourceId(c.contribution)}`,
      lead: <FileIcon name={c.displayName} size="sm" />,
      title: bare(c.displayName),
      sub: "Changes requested",
    });
  const queue = ws.can("contributions.review") ? (home.data?.continue?.reviewQueueCount ?? 0) : 0;
  if (queue) items.push({ href: "/documents?tab=review", lead: <ItemIcon icon={Inbox} tone="accent" size="sm" />, title: `${plural(queue, "document")} to review`, sub: "Waiting for your decision" });
  if (withUpNext) {
    const now = Date.now();
    const due = (upNext.data ?? []).find((it) => it.kind === "reply" || (Date.parse(it.at) - now < 2 * DAY && Date.parse(it.at) > now - DAY));
    if (due) {
      const icon = due.kind === "reply" ? MessageSquare : due.kind === "queue" ? Inbox : Calendar;
      items.push({ href: due.action?.href ?? "/inbox", lead: <ItemIcon icon={icon} tone="warning" size="sm" />, title: due.title, sub: upNextWhen(due).text });
    }
  }
  const cards = items.slice(0, 3);
  useReportVisible(onVisible, cards.length > 0);
  if (!cards.length) return null;
  return (
    <section className="home-sec home-sec--attention" aria-labelledby="home-attention-h">
      <div className="home-sec__head">
        <h2 className="home-sec__title" id="home-attention-h">
          Needs your attention
        </h2>
      </div>
      <List className="home-list">
        {cards.map((it) => (
          <ListItem key={it.href} lead={it.lead} title={it.title} contentTitle description={it.sub} href={it.href} />
        ))}
      </List>
    </section>
  );
}

/* ═══════════════ Continue reading (main) ═══════════════ */

/** The last documents you opened → the Reader where you left off; Ask continues from the document. */
function ContinueSection({ home, views, onVisible }: { home: MemberHome; views: ReadonlyMap<string, string>; onVisible?: (visible: boolean) => void }) {
  const recent = (home.continue?.recentItems ?? []).slice(0, 4);
  const details = useCardDetails(home);
  const { ctx } = useKnowledgeModel();
  useReportVisible(onVisible, recent.length > 0);
  if (!recent.length) return null;
  return (
    <section className="home-sec home-sec--continue" aria-labelledby="home-cont-h">
      <div className="home-sec__head">
        <h2 className="home-sec__title" id="home-cont-h">
          Continue reading
        </h2>
      </div>
      <List className="home-list">
        {recent.map((doc) => {
          const id = resourceId(doc.item);
          const d = details.get(id);
          return (
            <ListItem
              key={id}
              lead={<FileIcon name={d?.fileName || doc.displayName} mime={d?.mime} size="sm" />}
              title={bare(doc.displayName)}
              contentTitle
              description={
                <>
                  {`Opened ${relLow(views.get(id) || doc.publishTime)}`}
                  <ResDot />
                  {typeLabelFor(doc.documentType, d?.fileName || doc.displayName || "", d?.mime, ctx.documentTypes)}
                </>
              }
              href={`/doc/${id}`}
              actions={
                <span className="reveal-on-hover">
                  <Tip content="Ask about this document">
                    <NextLink className="button button--ghost button--muted button--icon-only button--sm" href={`/doc/${id}?ask=1`} aria-label="Ask about this document">
                      <Sparkles className="i" aria-hidden />
                    </NextLink>
                  </Tip>
                </span>
              }
            />
          );
        })}
      </List>
    </section>
  );
}

/* ═══════════════ What's new (aside) ═══════════════ */

function OkMark({ verified }: { verified: boolean }) {
  if (!verified) return null;
  return (
    <Tip content="Verified">
      <span className="home-ok">
        <ShieldCheck className="i i-xs" aria-hidden />
        <span className="sr-only">Verified</span>
      </span>
    </Tip>
  );
}

function InsightsSection({ list, onVisible }: { list: Insight[]; onVisible?: (visible: boolean) => void }) {
  useReportVisible(onVisible, list.length > 0);
  if (!list.length) return null;
  return (
    <section className="home-sec home-sec--news" aria-labelledby="home-news-h">
      <div className="home-sec__head">
        <h2 className="home-sec__title" id="home-news-h">
          What’s new
        </h2>
      </div>
      <div className="home-feed">
        {list.map((it) => {
          const r = it.resource;
          const Icon = it.kind === "version" ? History : Megaphone;
          return (
            <button key={r.id} type="button" className="home-news" onClick={() => openDocumentPreview({ item: r.item.name ?? r.id })}>
              <span className="home-news__meta">
                <Icon className="i i-xs" aria-hidden />
                <span>{it.label}</span>
                <span className="res-dot" aria-hidden>
                  ·
                </span>
                <span>{relLow(it.at)}</span>
              </span>
              <span className="home-news__text" translate="no">
                {it.text}
              </span>
              <span className="home-news__src">
                <FileIcon type={r.ext} mime={r.mime} size="sm" />
                <span className="truncate">
                  <span translate="no">{r.title}</span>
                  {it.source ? ` · ${it.source}` : ""}
                </span>
                <OkMark verified={r.trust.state === "verified"} />
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

/* ═══════════════ Start here · Recommended for you (main) ═══════════════ */

interface ReadCard {
  item: MemberHomeItem;
  reason: string;
}

function ReadingSection({ home, firstVisit, exclude, views, onVisible }: { home: MemberHome; firstVisit: boolean; exclude: ReadonlySet<string>; views: ReadonlyMap<string, string>; onVisible?: (visible: boolean) => void }) {
  const ws = useWorkspace();
  const wsName = ws.workspace.displayName;
  const featuredReason = (source?: string) => (source === "POPULAR" ? "Often opened" : `Recommended by ${wsName}`);
  const ok = (i?: MemberHomeItem): i is MemberHomeItem => !!i?.item && !exclude.has(resourceId(i.item));

  const list: ReadCard[] = [];
  if (firstVisit) {
    for (const f of home.featured ?? []) if (ok(f.item)) list.push({ item: f.item, reason: featuredReason(f.source) });
  } else {
    const ranked: ReadCard[] = [];
    for (const r of home.recommended ?? []) if (ok(r.item) && !views.has(resourceId(r.item.item))) ranked.push({ item: r.item, reason: r.reason?.label ?? featuredReason(r.reason?.kind) });
    for (const f of home.featured ?? []) if (ok(f.item) && !views.has(resourceId(f.item.item))) ranked.push({ item: f.item, reason: featuredReason(f.source) });
    const seen = new Set<string>();
    const unique = ranked.filter((x) => !seen.has(x.item.item!) && seen.add(x.item.item!));
    // One per reason first, so one recent read doesn't fill the row.
    const per = new Map<string, number>();
    const first = unique.filter((x) => {
      const n = (per.get(x.reason) ?? 0) + 1;
      per.set(x.reason, n);
      return n <= 1;
    });
    list.push(...first.slice(0, 3), ...unique.filter((x) => !first.slice(0, 3).includes(x)));
  }
  const cards = list.slice(0, 3);
  const details = useCardDetails(home);
  useReportVisible(onVisible, cards.length > 0);
  if (!cards.length) return null;

  const curated = (home.featured ?? []).filter((f) => f.source === "CURATED" && f.item?.item);
  return (
    <section className="home-sec home-sec--reading" aria-labelledby="home-read-h">
      <div className="home-sec__head">
        <h2 className="home-sec__title" id="home-read-h">
          {firstVisit ? "Start here" : "Recommended for you"}
        </h2>
        <span className="grow" />
        {ws.can("readingLists.publish") ? <ManageFeatured items={curated.map((f) => f.item!)} /> : null}
      </div>
      <List className="home-list">
        {cards.map(({ item, reason }) => {
          const id = resourceId(item.item);
          const d = details.get(id);
          const about = d?.summary;
          return (
            <ListItem
              key={id}
              lead={<FileIcon name={d?.fileName || item.displayName} mime={d?.mime} size="sm" />}
              title={
                <>
                  {bare(item.displayName)}
                  <OkMark verified={item.verificationState === "VERIFIED"} />
                </>
              }
              contentTitle
              description={about || reason}
              meta={about ? reason : undefined}
              onPress={() => openDocumentPreview({ item: item.item ?? id })}
            />
          );
        })}
      </List>
    </section>
  );
}

/** Admins: what's featured on Home, with a quick way to take a document off (Undo). Adding happens from a document's ⋯ menu. */
function ManageFeatured({ items }: { items: MemberHomeItem[] }) {
  const ws = useWorkspace();
  const qc = useQueryClient();
  const router = useRouter();
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: homeKeys.home(ws.id) });
    void qc.invalidateQueries({ queryKey: knowledgeKeys.featured(ws.id) });
  };
  const remove = async (item: MemberHomeItem) => {
    try {
      await deleteReadingListEntry(ws.id, FEATURED_LIST, item.item ?? "");
      refresh();
      toast(`Removed “${bare(item.displayName)}” from Home`, {
        undo: () =>
          void featureItem(ws.id, item.item ?? "")
            .then(refresh)
            .catch((e: unknown) => toast(errorMessage(e), { tone: "danger" })),
      });
    } catch (e) {
      toast(errorMessage(e), { tone: "danger" });
    }
  };
  return (
    <Tip content="Documents featured on Home">
      <Dropdown>
        <Button isIconOnly size="sm" variant="ghost" aria-label="Manage featured documents" className="button--muted">
          <SlidersHorizontal aria-hidden />
        </Button>
        <Dropdown.Popover placement="bottom end">
          <Dropdown.Menu
            aria-label="Featured on Home"
            onAction={(key) => {
              const k = String(key);
              if (k === "browse") return router.push(catalogHref({}));
              const item = items.find((i) => i.item === k);
              if (item) void remove(item);
            }}
          >
            <Dropdown.Section>
              <Header>{items.length ? "Featured on Home · remove" : "Nothing featured yet"}</Header>
              {items.map((i) => (
                <Dropdown.Item key={i.item} id={i.item ?? ""} textValue={bare(i.displayName)}>
                  <X className="i" aria-hidden />
                  <Label translate="no">{bare(i.displayName)}</Label>
                </Dropdown.Item>
              ))}
            </Dropdown.Section>
            <Separator />
            <Dropdown.Item id="browse" textValue="Feature from Knowledge (⋯ menu)">
              <Search className="i" aria-hidden />
              <Label>Feature from Knowledge (⋯ menu)</Label>
            </Dropdown.Item>
          </Dropdown.Menu>
        </Dropdown.Popover>
      </Dropdown>
    </Tip>
  );
}

/* ═══════════════ Explore knowledge ═══════════════ */

const HEX = /^#[0-9a-f]{3,8}$/i;

/** One card per domain: what it covers, how much there is, and its largest topics (preview `exploreSection()`). */
function ExploreSection({ home, onVisible }: { home: MemberHome; onVisible?: (visible: boolean) => void }) {
  const topics = useTopics();
  const meta = new Map((topics.data ?? []).map((t) => [t.name ?? "", t]));
  const domains = (home.topicDomains ?? []).filter((d) => (d.documentCount ?? 0) > 0);
  useReportVisible(onVisible, domains.length > 0);
  if (!domains.length) return null;
  return (
    <section className="home-sec home-sec--explore" aria-labelledby="home-explore-h">
      <div className="home-sec__head">
        <h2 className="home-sec__title" id="home-explore-h">
          Explore knowledge
        </h2>
        <span className="grow" />
        <NextLink className="link-button" href="/knowledge">
          All knowledge
          <ArrowRight className="i i-sm" aria-hidden />
        </NextLink>
      </div>
      <div className="home-topics">
        {domains.map((d) => {
          const t = meta.get(d.topic ?? "");
          const color = t?.color && HEX.test(t.color) ? t.color : undefined;
          const subs = (d.topTopics ?? []).slice(0, 3);
          return (
            <article key={d.topic} className="home-topic" style={color ? ({ "--tone": color } as CSSProperties) : undefined}>
              <span className="home-topic__icon" aria-hidden>
                {t?.icon ? <DynamicIcon name={t.icon as IconName} className="i i-sm" fallback={() => <Tag className="i i-sm" />} /> : <Tag className="i i-sm" />}
              </span>
              <div className="home-topic__body">
                <h3 className="home-topic__head">
                  <NextLink className="home-topic__link" href={catalogHref({ filters: { topic: [resourceId(d.topic)] } })} translate="no">
                    {d.displayName}
                  </NextLink>
                  <span className="home-topic__count num">{plural(d.documentCount ?? 0, "document")}</span>
                </h3>
                {t?.description ? (
                  <p className="home-topic__desc" translate="no">
                    {t.description}
                  </p>
                ) : null}
                {subs.length ? (
                  <p className="home-topic__subs">
                    {subs.map((s) => (
                      <NextLink key={s.topic} className="home-topic__sub" href={catalogHref({ filters: { topic: [resourceId(s.topic)] } })} translate="no">
                        {s.displayName}
                      </NextLink>
                    ))}
                  </p>
                ) : null}
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

/* ═══════════════ States ═══════════════ */

function LoadingBody() {
  const head = (w: number) => (
    <div className="home-sec__head">
      <span className="skeleton skeleton--title" style={{ width: w }} />
    </div>
  );
  return (
    <div className="home-body" aria-busy="true" aria-label="Loading">
      <div className="home-main">
        <section className="home-sec">
          {head(160)}
          <List className="home-list home-skel" aria-hidden>
            {[0, 1, 2].map((i) => (
              <ListItem key={i} lead={<span className="skeleton home-skel__icon" />} title={<span className="skeleton skeleton--line" style={{ width: "62%" }} />} description={<span className="skeleton skeleton--line" style={{ width: "34%", height: 10 }} />} />
            ))}
          </List>
        </section>
        <section className="home-sec">
          {head(180)}
          <div className="home-topics">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="home-topic home-skel" aria-hidden>
                <span className="skeleton home-skel__icon" />
                <div className="home-topic__body">
                  <span className="skeleton skeleton--line" style={{ width: "45%" }} />
                  <span className="skeleton skeleton--line" style={{ width: "90%", height: 10 }} />
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>
      <aside className="home-aside">
        <section className="home-sec">
          {head(140)}
          <List className="home-list home-skel" aria-hidden>
            {[0, 1].map((i) => (
              <ListItem key={i} lead={<span className="skeleton home-skel__icon" />} title={<span className="skeleton skeleton--line" style={{ width: "70%" }} />} description={<span className="skeleton skeleton--line" style={{ width: "40%", height: 10 }} />} />
            ))}
          </List>
        </section>
      </aside>
    </div>
  );
}

function EmptyBody() {
  const ws = useWorkspace();
  return (
    <section className="home-sec">
      <EmptyState
        icon={BookOpen}
        title="Your workspace has no published knowledge yet"
        description={ws.can("contributions.create") ? "Contribute documents for review. Published documents show up here and can be asked about." : "Documents show up here once they’re published."}
        actions={
          <>
            <ContributeButton variant="primary" />
            <NextLinkButton href="/knowledge">Knowledge</NextLinkButton>
          </>
        }
        boxed
      />
    </section>
  );
}

function NextLinkButton({ href, children }: { href: string; children: ReactNode }) {
  const router = useRouter();
  return (
    <Button variant="secondary" onPress={() => router.push(href)}>
      {children}
    </Button>
  );
}
