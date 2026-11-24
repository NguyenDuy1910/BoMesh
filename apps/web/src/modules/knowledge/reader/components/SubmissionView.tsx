"use client";

import { Button, buttonVariants, Dropdown, Label } from "@heroui/react";
import clsx from "clsx";
import { CheckCheck, Download, Ellipsis, EyeOff, History, Info, Pencil } from "lucide-react";
import NextLink from "next/link";
import { useRef, useState } from "react";

import { PageChrome } from "@/components/shell/page-chrome";
import { Callout } from "@/components/ui/Callout";
import { FileIcon } from "@/components/ui/FileIcon";
import { KeyValue } from "@/components/ui/KeyValue";
import { resourceId } from "@/lib/api/client";
import { fmtDateTime, fmtSize } from "@/lib/format";
import { useMessages } from "@/lib/i18n";
import { useWorkspace } from "@/lib/workspace";

import type { Contribution } from "../../api";
import { DemoChip } from "../../components/KnowledgeHeader";
import { LifecycleChip } from "../../components/LifecycleChip";
import { ContributionTimeline } from "../../library/components/ContributionTimeline";
import { contributionHref, lastEvent, type ContributionEventView } from "../../library/contributions";
import { lifecycleKey, type Resource } from "../../model";
import { useDocumentOperations } from "../../operations";
import { useItem, useMemberNames } from "../../queries";
import { RailSection } from "./AboutPane";
import { DocumentSurface } from "./DocumentSurface";
import { Meta, Rail, Updated } from "./ReaderParts";

/**
 * A document that isn't knowledge yet (preview `submissionView`): in review, changes requested,
 * not approved or unpublished. Seen only by its contributor and the collection's reviewers: a
 * preview with its lifecycle and who can see it — no Ask, no saving.
 */
export function SubmissionView({ resource: r, contribution: c }: { resource: Resource; contribution: Contribution | null }) {
  const { member, can } = useWorkspace();
  const m = useMessages();
  const ops = useDocumentOperations();
  const me = member.name ?? "";
  const contributor = c?.contributor || r.owner || "";
  const mine = !!contributor && contributor === me;
  const reviewer = can("contributions.review") && !r.isPersonal;
  const names = useMemberNames([contributor, c?.decision?.reviewer, ...(c?.events ?? []).map((e) => e.actor)]);
  const target = useItem(c?.targetCollection || c?.suggestions?.collection || null);
  const original = useItem(c?.replacesItem || null);
  const base = target.data?.displayName || (r.isPersonal ? "" : r.base?.displayName) || "";
  const life = lifecycleKey({ item: r.item, contribution: c });
  const stage = life === "analyzing" || life === "review" ? "review" : life;
  const track = contributionHref(c ? resourceId(c.name) : null);
  const contributorName = mine ? "bạn" : names.get(contributor) || "người gửi";

  /* The file as submitted: viewable whether or not it has been processed. */
  const scrollRef = useRef<HTMLDivElement>(null);
  const canvas = <DocumentSurface document={r} scrollRef={scrollRef} onDownload={() => void ops.download(r)} />;

  /* Side panel: closed by default */
  const [open, setOpen] = useState(false);

  /* Header: the decision and Track sit in the top row with the trail; the head is the document's identity */
  const meta = [
    r.typeMeta.label,
    base && <span translate="no">{base}</span>,
    mine ? "Do bạn gửi" : <span>Người gửi {names.get(contributor) || "ai đó"}</span>,
    c?.createTime && <Updated key="s" at={c.createTime} prefix="Đã gửi" />,
  ];
  // One primary: Review (reviewers) or Revise (the contributor, when changes were asked for — it opens the same place as Track).
  const main =
    reviewer && stage === "review" && c ? (
      <NextLink href={`/studio?tab=documents&view=review&sel=${resourceId(c.name)}`} className={buttonVariants({ variant: "primary" })}>
        <CheckCheck className="i" aria-hidden />
        Duyệt
      </NextLink>
    ) : mine && stage === "changes" ? (
      <NextLink href={track} className={buttonVariants({ variant: "primary" })}>
        <Pencil className="i" aria-hidden />
        Sửa đổi
      </NextLink>
    ) : null;
  const trackBtn =
    mine && stage !== "changes" ? (
      <NextLink href={track} className={buttonVariants({ variant: main ? "secondary" : "primary" })}>
        <History className="i" aria-hidden />
        Theo dõi
      </NextLink>
    ) : null;
  const more = (
    <Dropdown>
      <Button isIconOnly size="md" variant="ghost" aria-label="Thao tác khác" className="button--muted">
        <Ellipsis aria-hidden />
      </Button>
      <Dropdown.Popover placement="bottom end">
        <Dropdown.Menu aria-label="Thao tác khác" onAction={(key) => (key === "details" ? setOpen(!open) : void ops.download(r))}>
          <Dropdown.Item id="details" textValue={open ? "Ẩn chi tiết và lịch sử" : "Chi tiết và lịch sử"}>
            <Info className="i" aria-hidden />
            <Label>{open ? "Ẩn chi tiết và lịch sử" : "Chi tiết và lịch sử"}</Label>
          </Dropdown.Item>
          <Dropdown.Item id="download" textValue="Tải xuống">
            <Download className="i" aria-hidden />
            <Label>Tải xuống</Label>
          </Dropdown.Item>
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );

  /* Banner: why only some people can see it, and what happens next */
  const byName = (e?: ContributionEventView) => (e?.by === me && me ? "Bạn" : (e?.by && names.get(e.by)) || "Một người duyệt");
  const quote = (e?: ContributionEventView) =>
    e?.text ? (
      <blockquote className="rdr-sub-quote" translate="no">
        {e.text}
      </blockquote>
    ) : null;
  const audience = (
    <>
      Chỉ {mine ? "bạn" : <span translate="no">{contributorName}</span>} và người duyệt của <span translate="no">{base || "kho tài liệu chứa tài liệu"}</span> xem được tệp này.
    </>
  );
  let banner: React.ReactNode;
  if (stage === "review") {
    banner = <Callout tone="accent" icon={EyeOff} title={life === "analyzing" ? "Chờ duyệt · trợ lý đang đọc" : "Chờ duyệt"} description={<>{audience} Tệp chưa tra cứu được.</>} />;
  } else if (stage === "changes") {
    const e = c ? lastEvent(c, "changes") : undefined;
    banner = (
      <Callout
        tone="warning"
        title={`${byName(e)} đã yêu cầu chỉnh sửa`}
        description={
          <>
            {quote(e)}
            {audience} Tệp chưa tra cứu được.
          </>
        }
      />
    );
  } else if (stage === "rejected") {
    const e = c ? lastEvent(c, "rejected") : undefined;
    banner = (
      <Callout
        tone="danger"
        title={m.state.lifecycle.rejected.label}
        description={
          <>
            {quote(e)}
            Tệp sẽ không được công bố. {audience}
          </>
        }
      />
    );
  } else if (stage === "unpublished") {
    banner = <Callout tone="default" icon={EyeOff} title={m.state.lifecycle.unpublished.label} description={<>Một người duyệt đã gỡ tệp khỏi tìm kiếm và câu trả lời. {audience}</>} />;
  } else {
    banner = <Callout tone="default" title={<LifecycleChip lifecycle={life} noTip />} description={audience} />;
  }

  const crumbs =
    mine || !reviewer
      ? [{ label: m.nav.knowledge, href: "/knowledge" }, { label: m.nav.myContributions, href: "/contributions" }, { label: r.title }]
      : [{ label: m.nav.documents, href: "/studio?tab=documents&view=review" }, { label: r.title }];

  return (
    <div className="rdr rdr--sub">
      <PageChrome
        hero
        title={r.title}
        extra={<LifecycleChip lifecycle={life} />}
        meta={<Meta parts={meta} className="row gap-6" />}
        actions={
          <>
            {main}
            {trackBtn}
            {more}
          </>
        }
        crumbs={crumbs}
      />
      <header className="rdr-head">
        <div className="rdr-head__row">
          <FileIcon type={r.ext} mime={r.mime} name={r.fileName} size="lg" />
          <div className="rdr-head__main">
            <div className="rdr-head__title-row">
              <h1 className="rdr-head__title" title={r.title} translate="no">
                {r.title}
              </h1>
              <LifecycleChip lifecycle={life} />
              <DemoChip />
            </div>
            <Meta parts={meta} />
          </div>
        </div>
      </header>
      <div className={clsx("rdr-body", open && "has-rail")}>
        <div className="rdr-canvas" id="rdr-scroll" ref={scrollRef}>
          <div className="rdr-banners">{banner}</div>
          {canvas}
        </div>
        {open ? (
          <Rail title="Về tài liệu đã gửi" onClose={() => setOpen(false)}>
            <section className="rdr-sec">
              <KeyValue
                pairs={[
                  ["Trạng thái", <LifecycleChip key="s" lifecycle={life} size="sm" />],
                  ["Kho tài liệu", <span translate="no">{base || "—"}</span>],
                  ["Người gửi", mine ? "Bạn" : names.get(contributor) ? <span translate="no">{names.get(contributor)}</span> : "Ai đó"],
                  c?.createTime ? ["Đã gửi", fmtDateTime(c.createTime)] : null,
                  c?.replacesItem
                    ? [
                        "Phiên bản mới của",
                        original.data ? (
                          <NextLink className="link" href={`/doc/${resourceId(original.data.name)}`} translate="no">
                            {original.data.displayName}
                          </NextLink>
                        ) : (
                          "Một tài liệu trước đó"
                        ),
                      ]
                    : null,
                  ["Tệp", `${(r.ext || "tệp").toUpperCase()} · ${fmtSize(r.sizeBytes)}`],
                ]}
              />
            </section>
            {c ? (
              <RailSection title="Lịch sử">
                <ContributionTimeline contribution={c} compact />
              </RailSection>
            ) : null}
          </Rail>
        ) : null}
      </div>
    </div>
  );
}
