"use client";

import { Button, buttonVariants } from "@heroui/react";
import clsx from "clsx";
import { ArrowRight, Check, Eye, Layers, MessageSquare, Tag, X, type LucideIcon } from "lucide-react";
import NextLink from "next/link";
import type { CSSProperties } from "react";

import { startTour } from "@/components/shell/overlays";
import { IconButton, LinkButton, ProgressBar, toast } from "@/components/ui";
import { resourceId } from "@/lib/api/client";
import { plural, rel } from "@/lib/format";
import { DocThumb, ResourceCard } from "@/modules/knowledge/components/ResourceCard";
import { ResDot } from "@/modules/knowledge/components/ResourceRow";
import { catalogHref, type Resource } from "@/modules/knowledge/model";
import { openDocumentPreview } from "@/modules/knowledge/preview/store";
import { readerHref } from "@/modules/knowledge/reader/links";
import { conversationTitle, type Conversation } from "@/modules/projects";

import type { MemberHomeDomain, MemberHomeRecommended, StarterPrompt } from "../api";
import { topicIcon } from "../domainIcon";

const DOMAINS = 6;

/** Focuses Home's composer (Getting started › Ask). */
function focusAsk() {
  const input = document.querySelector<HTMLTextAreaElement>("#chat-input");
  if (!input) return;
  input.scrollIntoView({ block: "center", behavior: "smooth" });
  input.focus({ preventScroll: true });
}

/* ═══════════════ Getting started ═══════════════ */

export interface StartSteps {
  asked: boolean;
  opened: boolean;
  saved: boolean;
}

/**
 * New members (preview `gettingStarted`): three steps, each done by doing it for real (a question asked, a document opened,
 * one saved), each with one button while it's open: Ask focuses the box, Open opens the first pick (Browse opens Knowledge
 * when there are no picks), Find one opens it too and says where Save is. Once all three are done it says so, until the
 * member hides it; then Jump back in takes its place. "Take the tour" restarts the product tour.
 */
export function GettingStarted({ steps, first, onHide }: { steps: StartSteps; first?: Resource; onHide: () => void }) {
  const action = buttonVariants({ size: "sm", variant: "tertiary" });
  const open = first ? readerHref({ item: first.name, from: "home" }) : catalogHref();
  const list = [
    {
      done: steps.asked,
      title: "Ask your first question",
      desc: "Every answer shows the documents it comes from.",
      own: false,
      action: (
        <Button size="sm" variant="tertiary" onPress={focusAsk}>
          Ask
        </Button>
      ),
    },
    {
      done: steps.opened,
      title: "Open a document",
      desc: first ? first.title : "Find one in Knowledge.",
      own: !!first,
      action: (
        <NextLink href={open} className={action}>
          {first ? "Open" : "Browse"}
        </NextLink>
      ),
    },
    {
      done: steps.saved,
      title: "Save one you’ll need again",
      desc: "Select the bookmark on a document. Saved ones stay in Knowledge › Saved.",
      own: false,
      action: (
        <NextLink
          href={open}
          className={action}
          onClick={() => toast(first ? "Select Save to keep it in Knowledge › Saved." : "Select the bookmark on a document to save it.")}
        >
          Find one
        </NextLink>
      ),
    },
  ];
  const done = list.filter((s) => s.done).length;
  if (done === list.length) {
    return (
      <section className="home-start home-start--done" aria-labelledby="home-start-title">
        <div className="home-start__head">
          <span className="home-start__ok" aria-hidden>
            <Check className="i i-sm" />
          </span>
          <div className="grow">
            <h2 className="home-start__title" id="home-start-title">
              You’re all set
            </h2>
            <p className="home-start__desc">You’ve asked, read and saved. Hide this to see where you left off.</p>
          </div>
          <Button size="sm" variant="tertiary" onPress={onHide}>
            Hide
          </Button>
        </div>
      </section>
    );
  }
  return (
    <section className="home-start" aria-labelledby="home-start-title">
      <div className="home-start__head">
        <div className="grow">
          <h2 className="home-start__title" id="home-start-title">
            Getting started
          </h2>
          <p className="home-start__desc">
            <span>{`${done} of ${list.length} done`}</span>
            <ResDot />
            <LinkButton onPress={startTour}>Take the tour</LinkButton>
          </p>
        </div>
        <div className="home-start__bar">
          <ProgressBar value={(done / list.length) * 100} label="Getting started" />
        </div>
        <IconButton icon={X} tip="Hide getting started" size="sm" onPress={onHide} />
      </div>
      <ol className="home-start__steps">
        {list.map((s, i) => (
          <li key={s.title} className={clsx("home-step", s.done && "is-done")}>
            <span className="home-step__mark" aria-hidden>
              {s.done ? <Check className="i i-sm" /> : i + 1}
            </span>
            <div className="home-step__body">
              <h3 className="home-step__title">
                {s.title}
                {s.done ? <span className="sr-only"> (done)</span> : null}
              </h3>
              <p className="home-step__desc" translate={s.own ? "no" : undefined}>
                {s.desc}
              </p>
            </div>
            {s.done ? null : s.action}
          </li>
        ))}
      </ol>
    </section>
  );
}

/* ═══════════════ Jump back in ═══════════════ */

export interface RecentDoc {
  resource: Resource;
  /** Last opened (RFC 3339), when known. */
  at?: string;
}

/** Everyone else (preview `jumpBack`): the latest conversation and the last documents opened, as small covered tiles. */
export function JumpBackIn({ conversation, docs }: { conversation?: Conversation; docs: readonly RecentDoc[] }) {
  if (!conversation && !docs.length) return null;
  return (
    <section className="home-section" aria-labelledby="home-recent-title">
      <div className="home-section__head">
        <h2 className="home-section__title" id="home-recent-title">
          Jump back in
        </h2>
      </div>
      <div className="home-recent__grid">
        {conversation ? (
          <NextLink className="home-recent" href={`/chat/${resourceId(conversation.name)}`}>
            <span className="home-recent__thumb">
              <span className="home-recent__chat">
                <MessageSquare className="i" aria-hidden />
              </span>
            </span>
            <span className="home-recent__text">
              <span className="home-recent__title" translate="no">
                {conversationTitle(conversation)}
              </span>
              {conversation.lastMessageTime ? <span className="home-recent__when">{rel(conversation.lastMessageTime)}</span> : null}
            </span>
          </NextLink>
        ) : null}
        {docs.map(({ resource: r, at }) => (
          <NextLink key={r.id} className="home-recent" href={readerHref({ item: r.name, from: "home" })}>
            <span className="home-recent__thumb">
              <DocThumb resource={r} />
            </span>
            <span className="home-recent__text">
              <span className="home-recent__title" translate="no">
                {r.title}
              </span>
              {at ? <span className="home-recent__when">{rel(at)}</span> : null}
            </span>
          </NextLink>
        ))}
      </div>
    </section>
  );
}

/* ═══════════════ Picked for you ═══════════════ */

type ReasonKind = NonNullable<NonNullable<MemberHomeRecommended["reason"]>["kind"]>;

const REASON_ICON: Readonly<Record<ReasonKind, LucideIcon>> = {
  STARTER_PROMPT: MessageSquare,
  FROM_YOUR_SPACE: Layers,
  BECAUSE_YOU_READ: Tag,
  SAVED_TOPIC: Tag,
  POPULAR: Eye,
};

/** The chip's words for a reason; `label` is its subject (a starter's title, a space or topic name). */
function reasonText(kind: ReasonKind, label: string): string {
  switch (kind) {
    case "STARTER_PROMPT":
      return label;
    case "FROM_YOUR_SPACE":
      return `In ${label}`;
    case "BECAUSE_YOU_READ":
    case "SAVED_TOPIC":
      return `More on ${label}`;
    case "POPULAR":
      return "Most read";
  }
}

export interface Pick {
  resource: Resource;
  reason: MemberHomeRecommended["reason"];
}

/** Picked for you (preview `pickCard`): Browse's document card with the reason it was picked over its cover. */
export function PickedForYou({ picks, starters }: { picks: readonly Pick[]; starters: readonly StarterPrompt[] }) {
  if (!picks.length) return null;
  return (
    <section className="home-section home-picks" aria-labelledby="home-picks-title">
      <div className="home-section__head">
        <div className="grow">
          <h2 className="home-section__title" id="home-picks-title">
            Picked for you
          </h2>
          <p className="home-section__desc">From your role’s questions, your spaces and what you read.</p>
        </div>
      </div>
      <div className="home-picks__grid">
        {picks.map(({ resource: r, reason }) => {
          const kind = reason?.kind ?? "POPULAR";
          const label = reason?.label ?? "";
          const Icon = REASON_ICON[kind];
          const starter = kind === "STARTER_PROMPT" ? starters.find((s) => s.title === label)?.prompt : undefined;
          return (
            <ResourceCard
              key={r.id}
              resource={r}
              className="home-pick"
              from="home"
              onOpen={() => openDocumentPreview({ item: r.name, listed: r.item, from: "home" })}
              badge={
                <span className="home-pick__why" title={starter}>
                  <Icon className="i i-sm" aria-hidden />
                  <span className="truncate" translate={kind === "STARTER_PROMPT" ? "no" : undefined}>
                    {reasonText(kind, label)}
                  </span>
                </span>
              }
            />
          );
        })}
      </div>
    </section>
  );
}

/* ═══════════════ Explore by domain ═══════════════ */

/** Explore by domain (preview `domainCard`): each domain in its colour with what it holds, opening Knowledge filtered. */
export function ExploreByDomain({ domains }: { domains: readonly MemberHomeDomain[] }) {
  if (!domains.length) return null;
  return (
    <section className="home-section home-domains" aria-labelledby="home-domains-title">
      <div className="home-section__head">
        <div className="grow">
          <h2 className="home-section__title" id="home-domains-title">
            Explore by domain
          </h2>
        </div>
        <LinkButton href="/knowledge" icon={ArrowRight} size="sm">
          {domains.length > DOMAINS ? `All ${domains.length} domains` : "Browse knowledge"}
        </LinkButton>
      </div>
      <div className="home-domains__grid">
        {domains.slice(0, DOMAINS).map((d) => (
          <DomainCard key={d.topic} domain={d} />
        ))}
      </div>
    </section>
  );
}

const topicHref = (topic: string | undefined) => catalogHref({ filters: { topic: [resourceId(topic)] } });

function DomainCard({ domain: d }: { domain: MemberHomeDomain }) {
  const Icon = topicIcon(d.icon);
  const fresh = d.newDocumentCount ?? 0;
  const top = (d.topTopics ?? []).filter((t) => (t.documentCount ?? 0) > 0).slice(0, 3);
  return (
    <article className="home-domain" style={{ "--tone": d.color || "var(--accent)" } as CSSProperties}>
      <div className="home-domain__head">
        <span className="home-domain__icon" aria-hidden>
          <Icon className="i" />
        </span>
        <div className="home-domain__titles">
          <h3 className="home-domain__name">
            <NextLink className="home-domain__link" href={topicHref(d.topic)} title={d.displayName} translate="no">
              {d.displayName}
            </NextLink>
          </h3>
          <p className="home-domain__meta">
            <span>{plural(d.documentCount ?? 0, "document")}</span>
            {fresh ? (
              <>
                <ResDot />
                <span className="home-domain__new">{`${fresh} new`}</span>
              </>
            ) : null}
          </p>
        </div>
      </div>
      {d.description ? (
        <p className="home-domain__desc" title={d.description} translate="no">
          {d.description}
        </p>
      ) : null}
      {top.length ? (
        <div className="home-domain__topics">
          {top.map((t) => (
            <NextLink key={t.topic} className="home-topic" href={topicHref(t.topic)} title={t.displayName} translate="no">
              {t.displayName}
            </NextLink>
          ))}
        </div>
      ) : null}
    </article>
  );
}
