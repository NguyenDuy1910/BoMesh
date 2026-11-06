"use client";

import { Button, Dropdown, Header, Label, Separator } from "@heroui/react";
import { useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { ArrowRight, BookOpen, Calendar, History, Inbox, Megaphone, MessageSquare, Search, ShieldCheck, SlidersHorizontal, Tag, X, type LucideIcon } from "lucide-react";
import { DynamicIcon, type IconName } from "lucide-react/dynamic";
import NextLink from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, type CSSProperties, type ReactNode } from "react";

import { PageChrome } from "@/components/shell/page-chrome";
import { EmptyState, ErrorState, FileIcon, Tip, toast } from "@/components/ui";
import { errorMessage, resourceId } from "@/lib/api/client";
import { plural, rel } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";
import { deleteReadingListEntry, featureItem, FEATURED_LIST } from "@/modules/knowledge/api";
import { ContributeButton } from "@/modules/knowledge/components/KnowledgeHeader";
import { catalogHref } from "@/modules/knowledge/model";
import { knowledgeKeys, useTopics } from "@/modules/knowledge/queries";
import { useMyConversations } from "@/modules/search/queries";
import { upNextWhen, useUpNext } from "@/modules/spaces";

import type { MemberHome, MemberHomeItem } from "../api";
import { callName, greeting } from "../intent";
import { homeKeys, useCardDetails, useInsights, useLastViews, useMemberHome, type Insight } from "../queries";
import { HomeBox } from "./HomeBox";

const DAY = 86_400_000;
const bare = (n?: string) => String(n ?? "").replace(/\.[a-z0-9]{1,5}$/i, "");
const relLow = (t?: string) => rel(t).replace(/^(Just now|Yesterday)$/, (m) => m.toLowerCase());

/** Home (`/home`, preview `P.home`): one box to ask or find, then only what has value now. */
export function HomePage() {
  const ws = useWorkspace();
  const home = useMemberHome();
  const convs = useMyConversations();
  const last = useLastViews();
  const firstVisit = !!home.data && !convs.isPending && !(home.data.continue?.recentItems?.length ?? 0) && !(convs.data?.length ?? 0);
  const starters = home.data?.suggestedQuestions ?? [];
  const tries = firstVisit ? starters.slice(0, 3) : [];
  const router = useRouter();

  return (
    <div className="page home">
      <PageChrome crumbs={[{ label: "Home" }]} />
      <section className="home-hero" aria-labelledby="home-title">
        <h1 className="home-title" id="home-title">
          {greeting()}, <span translate="no">{callName(ws.member.displayName)}</span>
        </h1>
        <HomeBox starters={starters} />
        {tries.length ? (
          <div className="home-suggest" role="group" aria-label="Suggested questions">
            <span className="home-suggest__label">Try asking</span>
            {tries.map((s) => (
              <button key={s} type="button" className="home-suggest__chip" title={s} onClick={() => router.push(`/chat?q=${encodeURIComponent(s)}&send=1`)}>
                <span className="truncate">{s}</span>
              </button>
            ))}
          </div>
        ) : null}
      </section>
      {home.isPending ? (
        <LoadingBody />
      ) : home.isError ? (
        <section className="home-sec">
          <ErrorState error={home.error} onRetry={home.refetch} />
        </section>
      ) : !home.data.counts?.documentCount ? (
        <EmptyBody />
      ) : (
        <HomeBody home={home.data} firstVisit={firstVisit} views={last.views} />
      )}
    </div>
  );
}

function HomeBody({ home, firstVisit, views }: { home: MemberHome; firstVisit: boolean; views: ReadonlyMap<string, string> }) {
  const readCollections = useMemo(() => new Set((home.continue?.recentItems ?? []).map((i) => i.collection ?? "").filter(Boolean)), [home.continue?.recentItems]);
  const insights = useInsights({ readCollections });
  const know = insights.data ?? [];
  const shown = new Set(know.map((x) => x.resource.id));
  return (
    <div className="home-body">
      <ContinueSection home={home} views={views} />
      {insights.isPending ? null : <InsightsSection list={know} />}
      <ReadingSection home={home} firstVisit={firstVisit} exclude={shown} views={views} />
      <TopicsSection home={home} />
    </div>
  );
}

/* ═══════════════ Pick up where you left off ═══════════════ */

interface ContinueCard {
  href: string;
  lead: ReactNode;
  title: string;
  sub: string;
  tone?: "warning" | "accent";
  recent?: boolean;
  contentTitle?: boolean;
}

const contIcon = (Icon: LucideIcon) => (
  <span className="home-cont__icon" aria-hidden>
    <Icon className="i i-sm" />
  </span>
);

function ContinueSection({ home, views }: { home: MemberHome; views: ReadonlyMap<string, string> }) {
  const ws = useWorkspace();
  const withUpNext = ws.hasModule("spaces") || ws.hasModule("requests");
  const upNext = useUpNext({ limit: 4 });
  const items: ContinueCard[] = [];
  for (const c of (home.continue?.contributions ?? []).filter((c) => c.state === "CHANGES_REQUESTED").slice(0, 1))
    items.push({
      href: `/knowledge/library?tab=contributions&open=${resourceId(c.contribution)}`,
      lead: <FileIcon name={c.displayName} size="sm" />,
      title: bare(c.displayName),
      sub: "Changes requested",
      tone: "warning",
      contentTitle: true,
    });
  const queue = ws.can("contributions.review") ? (home.continue?.reviewQueueCount ?? 0) : 0;
  if (queue) items.push({ href: "/documents?tab=review", lead: contIcon(Inbox), title: `${plural(queue, "document")} to review`, sub: "Waiting for your decision", tone: "accent" });
  if (withUpNext) {
    const now = Date.now();
    const due = (upNext.data ?? []).find((it) => it.kind === "reply" || (Date.parse(it.at) - now < 2 * DAY && Date.parse(it.at) > now - DAY));
    if (due) {
      const icon = due.kind === "reply" ? MessageSquare : due.kind === "queue" ? Inbox : Calendar;
      items.push({ href: due.action?.href ?? "/inbox", lead: contIcon(icon), title: due.title, sub: upNextWhen(due).text, tone: "warning", contentTitle: true });
    }
  }
  const recent = (home.continue?.recentItems ?? []).slice(0, Math.max(0, 4 - items.length));
  const details = useCardDetails(recent.map((doc) => resourceId(doc.item)));
  for (const doc of recent) {
    const id = resourceId(doc.item);
    const d = details.get(id);
    items.push({
      href: `/doc/${id}`,
      lead: <FileIcon name={d?.fileName || doc.displayName} mime={d?.mime} size="sm" />,
      title: bare(doc.displayName),
      sub: `Opened ${relLow(views.get(id) || doc.publishTime)}`,
      recent: true,
      contentTitle: true,
    });
  }
  const cards = items.slice(0, 4);
  if (!cards.length) return null;
  return (
    <section className="home-sec" aria-labelledby="home-cont-h">
      <div className="home-sec__head">
        <h2 className="home-sec__title" id="home-cont-h">
          {cards.some((c) => c.recent) ? "Pick up where you left off" : "Waiting for you"}
        </h2>
      </div>
      <div className="home-conts">
        {cards.map((c) => (
          <NextLink key={c.href} className={clsx("home-cont", c.tone && `home-cont--${c.tone}`)} href={c.href}>
            {c.lead}
            <span className="home-cont__body">
              <span className="home-cont__title" translate={c.contentTitle ? "no" : undefined}>
                {c.title}
              </span>
              <span className="home-cont__sub">{c.sub}</span>
            </span>
            <ArrowRight className="i i-sm home-cont__go" aria-hidden />
          </NextLink>
        ))}
      </div>
    </section>
  );
}

/* ═══════════════ Worth knowing ═══════════════ */

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

function InsightsSection({ list }: { list: Insight[] }) {
  if (!list.length) return null;
  return (
    <section className="home-sec" aria-labelledby="home-know-h">
      <div className="home-sec__head">
        <h2 className="home-sec__title" id="home-know-h">
          Worth knowing
        </h2>
        <span className="home-sec__note">What changed in documents you can read</span>
      </div>
      <div className="home-grid3">
        {list.map((it) => {
          const r = it.resource;
          const Icon = it.kind === "version" ? History : Megaphone;
          return (
            <NextLink key={r.id} className="home-insight" href={`/doc/${r.id}`}>
              <span className="home-insight__label">
                <Icon className="i i-xs" aria-hidden />
                {it.label}
                <span className="res-dot" aria-hidden>
                  ·
                </span>
                {relLow(it.at)}
              </span>
              <span className="home-insight__text" translate="no">
                {it.text}
              </span>
              <span className="home-insight__src">
                <FileIcon type={r.ext} mime={r.mime} size="sm" />
                <span className="truncate">
                  <span translate="no">{r.title}</span>
                  {it.source ? ` · ${it.source}` : ""}
                </span>
                <OkMark verified={r.trust.state === "verified"} />
              </span>
            </NextLink>
          );
        })}
      </div>
    </section>
  );
}

/* ═══════════════ Start here · Recommended for you ═══════════════ */

interface ReadCard {
  item: MemberHomeItem;
  reason: string;
}

function ReadingSection({ home, firstVisit, exclude, views }: { home: MemberHome; firstVisit: boolean; exclude: ReadonlySet<string>; views: ReadonlyMap<string, string> }) {
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
  const details = useCardDetails(cards.map((c) => resourceId(c.item.item)));
  if (!cards.length) return null;

  const curated = (home.featured ?? []).filter((f) => f.source === "CURATED" && f.item?.item);
  return (
    <section className="home-sec" aria-labelledby="home-read-h">
      <div className="home-sec__head">
        <h2 className="home-sec__title" id="home-read-h">
          {firstVisit ? "Start here" : "Recommended for you"}
        </h2>
        <span className="grow" />
        {ws.can("readingLists.publish") ? <ManageFeatured items={curated.map((f) => f.item!)} /> : null}
      </div>
      <div className="home-grid3">
        {cards.map(({ item, reason }) => {
          const id = resourceId(item.item);
          const d = details.get(id);
          const about = d?.summary;
          return (
            <NextLink key={id} className="home-read" href={`/doc/${id}`}>
              <span className="home-read__head">
                <FileIcon name={d?.fileName || item.displayName} mime={d?.mime} size="sm" />
                <span className="home-read__title" translate="no">
                  {bare(item.displayName)}
                </span>
                <OkMark verified={item.verificationState === "VERIFIED"} />
              </span>
              {about ? (
                <span className="home-read__about" translate="no">
                  {about}
                </span>
              ) : null}
              <span className="home-read__why">{reason}</span>
            </NextLink>
          );
        })}
      </div>
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

/* ═══════════════ Explore by topic ═══════════════ */

const HEX = /^#[0-9a-f]{3,8}$/i;

function TopicsSection({ home }: { home: MemberHome }) {
  const topics = useTopics();
  const meta = new Map((topics.data ?? []).map((t) => [t.name ?? "", t]));
  const domains = (home.topicDomains ?? []).filter((d) => (d.documentCount ?? 0) > 0);
  if (!domains.length) return null;
  return (
    <section className="home-sec" aria-labelledby="home-topics-h">
      <div className="home-sec__head">
        <h2 className="home-sec__title" id="home-topics-h">
          Explore by topic
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
          return (
            <NextLink
              key={d.topic}
              className="home-topic"
              href={catalogHref({ filters: { topic: [resourceId(d.topic)] } })}
              style={color ? ({ "--tone": color } as CSSProperties) : undefined}
            >
              <span className="home-topic__icon" aria-hidden>
                {t?.icon ? <DynamicIcon name={t.icon as IconName} className="i i-sm" fallback={() => <Tag className="i i-sm" />} /> : <Tag className="i i-sm" />}
              </span>
              <span translate="no">{d.displayName}</span>
            </NextLink>
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
      <section className="home-sec">
        {head(200)}
        <div className="home-conts">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="home-cont home-skel" aria-hidden>
              <span className="skeleton home-skel__icon" />
              <span className="home-cont__body">
                <span className="skeleton skeleton--line" style={{ width: "70%" }} />
                <span className="skeleton skeleton--line" style={{ width: "40%", height: 10 }} />
              </span>
            </div>
          ))}
        </div>
      </section>
      <section className="home-sec">
        {head(150)}
        <div className="home-grid3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="home-insight home-skel" aria-hidden>
              <span className="skeleton skeleton--line" style={{ width: "45%", height: 10 }} />
              <span className="skeleton skeleton--line" style={{ width: "95%" }} />
              <span className="skeleton skeleton--line" style={{ width: "70%" }} />
              <span className="skeleton skeleton--line" style={{ width: "55%", height: 10 }} />
            </div>
          ))}
        </div>
      </section>
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
