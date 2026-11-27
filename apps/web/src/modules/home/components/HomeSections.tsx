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
import { categoryColor } from "@/lib/tones";
import { DocThumb, ResourceCard } from "@/modules/knowledge/components/ResourceCard";
import { ResDot } from "@/modules/knowledge/components/ResourceRow";
import { catalogHref, conceptHref, type Resource } from "@/modules/knowledge/model";
import { openDocumentPreview } from "@/modules/knowledge/preview/store";
import { readerHref } from "@/modules/knowledge/reader/links";
import { resourceKey, schemeIconName, schemeOfConcept } from "@/modules/knowledge/taxonomy";
import { conversationTitle, type Conversation } from "@/modules/projects";

import type { MemberHomeDomain, MemberHomeRecommended, StarterPrompt } from "../api";
import { conceptIcon } from "../domainIcon";

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
      title: "Đặt câu hỏi đầu tiên",
      desc: "Mỗi câu trả lời đều ghi rõ lấy từ tài liệu nào.",
      own: false,
      action: (
        <Button size="sm" variant="tertiary" onPress={focusAsk}>
          Hỏi
        </Button>
      ),
    },
    {
      done: steps.opened,
      title: "Mở một tài liệu",
      desc: first ? first.title : "Tìm một tài liệu trong mục Tài liệu.",
      own: !!first,
      action: (
        <NextLink href={open} className={action}>
          {first ? "Mở" : "Tra cứu"}
        </NextLink>
      ),
    },
    {
      done: steps.saved,
      title: "Lưu tài liệu bạn sẽ cần dùng lại",
      desc: "Chọn biểu tượng dấu trang trên tài liệu. Tài liệu đã lưu nằm trong mục Tài liệu › Đã lưu.",
      own: false,
      action: (
        <NextLink
          href={open}
          className={action}
          onClick={() => toast(first ? "Chọn Lưu để giữ tài liệu trong mục Tài liệu › Đã lưu." : "Chọn biểu tượng dấu trang trên một tài liệu để lưu tài liệu đó.")}
        >
          Tìm tài liệu
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
              Bạn đã sẵn sàng
            </h2>
            <p className="home-start__desc">Bạn đã hỏi, đọc và lưu tài liệu. Ẩn phần này để xem tiếp những gì bạn đang làm dở.</p>
          </div>
          <Button size="sm" variant="tertiary" onPress={onHide}>
            Ẩn
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
            Bắt đầu
          </h2>
          <p className="home-start__desc">
            <span>{`Đã xong ${done}/${list.length}`}</span>
            <ResDot />
            <LinkButton onPress={startTour}>Xem hướng dẫn</LinkButton>
          </p>
        </div>
        <div className="home-start__bar">
          <ProgressBar value={(done / list.length) * 100} label="Bắt đầu" />
        </div>
        <IconButton icon={X} tip="Ẩn phần Bắt đầu" size="sm" onPress={onHide} />
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
                {s.done ? <span className="sr-only"> (đã xong)</span> : null}
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
          Xem tiếp
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
  SAVED_CONCEPT: Tag,
  POPULAR: Eye,
};

/** The chip's words for a reason; `label` is its subject (a starter's title, a space or concept name). */
function reasonText(kind: ReasonKind, label: string): string {
  switch (kind) {
    case "STARTER_PROMPT":
      return label;
    case "FROM_YOUR_SPACE":
      return `Trong ${label}`;
    case "BECAUSE_YOU_READ":
    case "SAVED_CONCEPT":
      return `Thêm về ${label}`;
    case "POPULAR":
      return "Đọc nhiều nhất";
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
            Dành cho bạn
          </h2>
          <p className="home-section__desc">Gợi ý theo câu hỏi thường gặp của vai trò bạn, cộng đồng bạn tham gia và những gì bạn đã đọc.</p>
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

/** Explore by domain (preview `domainCard`): the first classification scheme's top concepts (`featuredConcepts`), each in
 *  its colour with what it holds, opening Knowledge filtered to it. */
export function ExploreByDomain({ domains }: { domains: readonly MemberHomeDomain[] }) {
  if (!domains.length) return null;
  return (
    <section className="home-section home-domains" aria-labelledby="home-domains-title">
      <div className="home-section__head">
        <div className="grow">
          <h2 className="home-section__title" id="home-domains-title">
            Khám phá theo lĩnh vực
          </h2>
        </div>
        <LinkButton href="/knowledge" icon={ArrowRight} size="sm">
          {domains.length > DOMAINS ? `Tất cả ${domains.length} lĩnh vực` : "Tra cứu tài liệu"}
        </LinkButton>
      </div>
      <div className="home-domains__grid">
        {domains.slice(0, DOMAINS).map((d) => (
          <DomainCard key={d.concept} domain={d} />
        ))}
      </div>
    </section>
  );
}

/** A top concept: its icon in its colour (preview `conceptLook`), name, count, what's new, definition and its biggest
 *  narrower concepts — each opening Browse filtered to it (`conceptHref`). */
function DomainCard({ domain: d }: { domain: MemberHomeDomain }) {
  const concept = d.concept ?? "";
  const Icon = conceptIcon(d.icon || schemeIconName(schemeOfConcept(concept)));
  const fresh = d.newDocumentCount ?? 0;
  const top = (d.topConcepts ?? []).filter((t) => (t.documentCount ?? 0) > 0).slice(0, 3);
  return (
    <article className="home-domain" style={{ "--tone": d.color || categoryColor(resourceKey(concept)) } as CSSProperties}>
      <div className="home-domain__head">
        <span className="home-domain__icon" aria-hidden>
          <Icon className="i" />
        </span>
        <div className="home-domain__titles">
          <h3 className="home-domain__name">
            <NextLink className="home-domain__link" href={conceptHref(concept)} title={d.displayName} translate="no">
              {d.displayName}
            </NextLink>
          </h3>
          <p className="home-domain__meta">
            <span>{plural(d.documentCount ?? 0, "document")}</span>
            {fresh ? (
              <>
                <ResDot />
                <span className="home-domain__new">{`${fresh} mới`}</span>
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
        <div className="home-domain__concepts">
          {top.map((t) => (
            <NextLink key={t.concept} className="home-concept" href={conceptHref(t.concept ?? "")} title={t.displayName} translate="no">
              {t.displayName}
            </NextLink>
          ))}
        </div>
      ) : null}
    </article>
  );
}
