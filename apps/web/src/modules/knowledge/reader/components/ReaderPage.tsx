"use client";

import { Button, Input, TextField } from "@heroui/react";
import clsx from "clsx";
import { ChevronDown, ChevronUp, History, Info, Quote, RotateCcw, Search, Send, ShieldCheck, Sparkles, X } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { PageChrome } from "@/components/shell/page-chrome";
import { Callout } from "@/components/ui/Callout";
import { ErrorState } from "@/components/ui/ErrorState";
import { IconButton } from "@/components/ui/IconButton";
import { StatusChip } from "@/components/ui/StatusChip";
import { Tip } from "@/components/ui/Tip";
import { ApiError, errorMessage, resourceId } from "@/lib/api/client";
import { fmtDate, plural } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";
import { converse, createConversation } from "@/modules/chat/api";
import type { AnswerSource } from "@/modules/chat/turn";

import { indexStatusOf, type Resource } from "../../model";
import { useDocumentOperations } from "../../operations";
import { useItemPermissions, useKnowledgeModel, useMember, useRecordRecent } from "../../queries";
import { DemoChip } from "../../components/KnowledgeHeader";
import { ResourceMenu, SaveButton, type MenuEntry } from "../../components/ResourceActions";
import { TrustChip, useTrust } from "../../components/TrustChip";
import { docFormat, PAGED_FORMATS } from "../format";
import { documentMarks, renditionText, searchNeedles, NO_MARKS } from "../marks";
import { explainPassagePrompt, parseOrigin, parseReaderQuery, readerHref, revisionNumber } from "../links";
import { RenditionLoadError } from "../rendition";
import { useCanProcess, useConversationCitations, usePassages, useProcessDocument, useReaderContent, useReaderItem, useRevisions, useSubmission } from "../queries";
import { AboutPane } from "./AboutPane";
import { AskPane, type AskTurn } from "./AskPane";
import { DocumentViewer } from "./DocumentViewer";
import { Meta, NotReady, NothingToShow, RAIL_MIN, Rail, RailSkeleton, ReaderHead, SkeletonPage, Unavailable, Updated, useCollapsingHead, useWidth } from "./ReaderParts";
import { RelatedPane } from "./RelatedPane";
import { renditionPageCount, RenditionView } from "./RenditionView";
import { PageImageView } from "./PageImageView";
import { SelectionToolbar } from "./SelectionToolbar";
import { SubmissionView } from "./SubmissionView";
import { useOriginCrumbs } from "./useOriginCrumbs";
import { useRendition } from "./useRendition";

/**
 * The Reader (`/doc/[id]`, preview `P.docViewer`): content first. The top row carries the trail
 * (back to where it was opened from) and Ask · Save · ⋯; the head below is the document's identity
 * and the find-in-document bar; the page canvas renders the file natively with cited-passage and
 * search highlights; the side panel (Ask · About · Related) opens on demand.
 * Deep links: `?q=&page=&passage=&from=&v=&ask=1` (document_viewer.md).
 */
export function ReaderPage({ itemId }: { itemId: string }) {
  const item = useReaderItem(itemId);
  const { toResource } = useKnowledgeModel();
  const resource = useMemo(() => (item.data ? toResource(item.data) : null), [item.data, toResource]);
  const published = item.data?.document?.publicationState !== "UNPUBLISHED";
  // A member's candidate document lives in their "My files": show it as a submission while a contribution is open.
  const submission = useSubmission(itemId, { enabled: !!resource && (!published || !resource.isPersonal) });

  if (item.isPending) return <ReaderSkeleton />;
  if (item.isError) {
    const e = item.error;
    if (e instanceof ApiError && (e.status === 403 || e.status === 404)) {
      // The API answers 403 alike whether or not the document exists, and names no collection to ask.
      return e.status === 403 ? <Unavailable locked description="It may have been removed, or it isn’t shared with you." /> : <Unavailable />;
    }
    return (
      <div className="rdr-msg">
        <ErrorState error={e} title="This document didn’t load" onRetry={() => void item.refetch()} />
      </div>
    );
  }
  if (!resource || resource.item.itemType !== "DOCUMENT" || resource.deleted) return <Unavailable />;
  if (submission.data || !published) {
    if (submission.isPending && published) return <ReaderSkeleton />;
    return <SubmissionView key={resource.id} resource={resource} contribution={submission.data ?? null} />;
  }
  return <Reader key={resource.id} resource={resource} />;
}

function ReaderSkeleton() {
  return (
    <div className="rdr">
      <header className="rdr-head">
        <div className="rdr-head__row">
          <span className="skeleton" style={{ width: 40, height: 40, borderRadius: 10 }} />
          <div className="rdr-head__main stack gap-6">
            <span className="skeleton skeleton--title" style={{ width: "40%" }} />
            <span className="skeleton skeleton--line" style={{ width: "30%" }} />
          </div>
        </div>
      </header>
      <div className="rdr-body">
        <div className="rdr-canvas">
          <SkeletonPage />
        </div>
      </div>
    </div>
  );
}

type Tab = "ask" | "about" | "related";

function Reader({ resource: r }: { resource: Resource }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const query = useMemo(() => parseReaderQuery(params), [params]);
  const { id: ws, workspace } = useWorkspace();
  const ops = useDocumentOperations();
  const perms = useItemPermissions(r.name);
  const canEdit = perms.can("items.update");
  const canProcess = useCanProcess(r.id);
  const process = useProcessDocument();
  const trust = useTrust(r);
  const record = useRecordRecent();
  const doc = r.item.document;
  const readable = r.readable;
  const owner = useMember(r.owner).data?.displayName;
  const crumbs = useOriginCrumbs(query.from, r);
  const origin = parseOrigin(query.from);
  const conversationFrom = origin?.kind === "conversation" ? origin.id : "";

  // Record the view once per document (UpdateRecentItem with allowMissing).
  const recorded = useRef("");
  useEffect(() => {
    if (recorded.current === r.id) return;
    recorded.current = r.id;
    record.mutate(r.id);
  }, [r.id, record]);

  /* ── URL state ── */
  const setQuery = useCallback(
    (patch: Partial<Record<"q" | "page" | "from" | "v" | "ask", string>> & { passage?: string[] }) => {
      const next = new URLSearchParams(params);
      for (const [k, v] of Object.entries(patch)) {
        if (k === "passage") continue;
        if (v) next.set(k, v as string);
        else next.delete(k);
      }
      if (patch.passage) {
        next.delete("passage");
        patch.passage.forEach((p) => next.append("passage", resourceId(p)));
      }
      const s = next.toString();
      router.replace(`${pathname}${s ? `?${s}` : ""}`, { scroll: false });
    },
    [params, pathname, router],
  );

  /* ── Which revision to read ── */
  const current = revisionNumber(doc?.revision) ?? 1;
  const indexed = revisionNumber(doc?.indexedRevision);
  const fromCitations = useConversationCitations(conversationFrom, r.id);
  const passageIds = useMemo(
    () => [...new Set([...query.passages, ...(query.passages.length ? [] : (fromCitations.data ?? []).map((c) => resourceId(c.passage)))])],
    [query.passages, fromCitations.data],
  );
  const older = !!query.v && query.v !== current;
  const viewing = older ? query.v! : passageIds.length && indexed && indexed !== current ? indexed : current;
  const revisions = useRevisions(r.id);
  const olderVersion = older ? revisions.data?.find((v) => revisionNumber(v.name) === query.v) : undefined;
  // Ask and Save work on the current version only.
  const askable = readable && !older;

  const content = useReaderContent(r.id, viewing === current ? undefined : String(viewing), { enabled: readable });
  const passages = usePassages(r.id, passageIds);

  // Page images of the viewed revision, in page order: the document's own pages.
  const pageImages = useMemo(
    () => [...(content.data?.pageAssets ?? [])].filter((p) => p.imageUri).sort((a, b) => (a.pageNumber ?? 0) - (b.pageNumber ?? 0)),
    [content.data],
  );

  /* ── Rendition: only downloaded when it is what the canvas shows (no page images) ── */
  const rendition = useRendition(r.id, content.data, { enabled: !pageImages.length });
  const rd = rendition.doc;

  /* ── Highlights ── */
  const cited = !!(query.page || conversationFrom || query.q.length >= 40);
  const text = useMemo(() => (rd ? renditionText(rd) : ""), [rd]);
  const needles = useMemo(() => (rd ? searchNeedles(query.q, text, cited) : []), [rd, query.q, text, cited]);
  const resolved = useMemo(() => passages.data.filter((p): p is NonNullable<typeof p> => !!p), [passages.data]);
  const marks = useMemo(
    () => (rd && (resolved.length || needles.length || passageIds.length) ? documentMarks(rd, { passages: resolved, needles }) : NO_MARKS),
    [rd, resolved, needles, passageIds.length],
  );
  const unresolved = marks.unresolved + (passages.isPending ? 0 : passages.data.filter((p) => p === null).length);
  const highlighting = readable && (passageIds.length > 0 || needles.length > 0 || !!query.q);
  const [hit, setHit] = useState(0);
  const hitKey = `${params.toString()}|${marks.total}`;
  const [lastKey, setLastKey] = useState(hitKey);
  if (lastKey !== hitKey) {
    setLastKey(hitKey);
    setHit(0);
  }
  const focusHit = marks.total ? ((hit % marks.total) + marks.total) % marks.total : -1;

  const scrollRef = useRef<HTMLDivElement>(null);
  const firstScroll = useRef(true);
  useEffect(() => {
    const sc = scrollRef.current;
    if (!sc || (!rd && !pageImages.length)) return;
    const mark = focusHit >= 0 ? sc.querySelector<HTMLElement>(`mark.evidence[data-hit="${focusHit}"]`) : null;
    const target = mark ?? (query.page ? sc.querySelector<HTMLElement>(`.doc-page[data-page="${query.page}"]`) : null);
    if (!target) return;
    const top = sc.scrollTop + target.getBoundingClientRect().top - sc.getBoundingClientRect().top - (mark ? sc.clientHeight / 3 : 24);
    sc.scrollTo({ top, behavior: firstScroll.current ? "auto" : "smooth" });
    firstScroll.current = false;
  }, [focusHit, rd, pageImages.length, query.page, marks]);

  /* ── Layout: content first, the side panel opens on demand ── */
  const rootRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLElement>(null);
  const width = useWidth(rootRef);
  const narrow = width > 0 && width < RAIL_MIN;
  const collapsed = useCollapsingHead(scrollRef, headRef, r.id);
  const [open, setOpen] = useState(query.ask && askable);
  const [tab, setTab] = useState<Tab>("ask");
  const activeTab: Tab = !askable && tab === "ask" ? "about" : tab;
  const format = docFormat({ ext: r.ext, mime: r.mime });
  const assetPages = content.data?.pageAssets?.length ?? 0;
  // Which page to open on: `?page=`, else the first cited passage's page.
  const citedPage = Number(query.page) || resolved.find((p) => p.boundingBoxes?.[0]?.pageNumber)?.boundingBoxes?.[0]?.pageNumber || 0;
  const focusComposer = () => requestAnimationFrame(() => document.getElementById("rdr-ask-q")?.focus());

  // ?ask=1 ("Ask about this document" from anywhere): opens the Ask panel once, then leaves the address.
  useEffect(() => {
    if (!query.ask) return;
    if (askable) {
      setOpen(true);
      setTab("ask");
      focusComposer();
    }
    setQuery({ ask: "" });
  }, [query.ask, askable, setQuery]);

  /* ── Ask (in place, through the conversation API) ── */
  const [thread, setThread] = useState<AskTurn[]>([]);
  const [draft, setDraft] = useState("");
  const conversation = useRef<string | null>(null);
  const seq = useRef(0);
  const railBody = useRef<HTMLDivElement>(null);
  const asking = thread.some((t) => !t.error && (!t.turn || t.turn.status === "streaming"));
  const stick = () => requestAnimationFrame(() => railBody.current && (railBody.current.scrollTop = railBody.current.scrollHeight));
  const update = (id: number, patch: Partial<AskTurn>) => setThread((list) => list.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  const ask = async (q: string) => {
    const question = q.trim();
    if (!question || asking || !askable) return;
    const id = ++seq.current;
    setThread((list) => [...list, { id, q: question }]);
    setDraft("");
    setOpen(true);
    setTab("ask");
    stick();
    try {
      const first = !conversation.current;
      if (!conversation.current) {
        const scope = r.base && !r.isPersonal ? { collections: [r.base.name] } : undefined;
        const conv = await createConversation(ws, { displayName: question.slice(0, 80), scope });
        conversation.current = resourceId(conv.name);
      }
      await converse(ws, conversation.current, { message: question, attachments: first ? [r.name] : undefined }, {
        onTurn: (turn) => {
          update(id, { turn });
          stick();
        },
      });
    } catch (error) {
      update(id, { error: errorMessage(error) });
    }
    stick();
  };
  const continueInChat = () => {
    const last = thread.at(-1);
    if (conversation.current) router.push(`/chat/${conversation.current}`);
    else router.push(`/chat?${new URLSearchParams({ q: last?.q ?? "", doc: r.id, ...(r.base && !r.isPersonal ? { scope: r.base.id } : {}) })}`);
  };
  // A citation in the panel: highlight that passage in the page (closes the overlay panel on narrow screens).
  const showPassages = (ids: string[]) => {
    if (narrow) setOpen(false);
    setQuery({ q: "", page: "", passage: ids });
  };
  const openSource = (s: AnswerSource) => router.push(readerHref({ item: s.item, passages: s.passages.map((p) => p.passage), from: conversation.current ?? undefined }));
  const openPane = (t: Tab) => {
    setOpen(true);
    setTab(t);
    requestAnimationFrame(() => railBody.current && (railBody.current.scrollTop = t === "ask" ? railBody.current.scrollHeight : 0));
  };

  // Escape closes the overlay panel on narrow screens (the selection toolbar handles its own).
  useEffect(() => {
    if (!narrow || !open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !document.querySelector(".doc-sel")) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [narrow, open]);

  /* ── Header: type · by owner · updated; trust; Ask · Save · ⋯ ── */
  const status = indexStatusOf(r);
  const meta = [
    r.typeLabel,
    owner && <span key="o">{`by ${owner}`}</span>,
    older ? <span key="v">{`Version ${query.v}${olderVersion ? ` · ${fmtDate(olderVersion.createTime)}` : ""}`}</span> : <Updated key="u" at={r.updated} />,
  ];
  const chips = (
    <>
      {older ? (
        <StatusChip label="Older version" tone="default" icon={History} size="sm" tooltip={`Current: v${current}, ${fmtDate(r.updated)}`} />
      ) : (
        <TrustChip resource={r} />
      )}
      {status ? <StatusChip kind="doc" value={status} size="sm" /> : null}
      <DemoChip />
    </>
  );
  const pressed = open && activeTab === "ask";
  const panels: MenuEntry[] = [{ id: "about", label: "About this document", icon: Info, run: () => openPane("about") }];
  const actions = (
    <>
      {askable ? (
        <Button
          variant="primary"
          className="rdr-ask-btn"
          aria-pressed={pressed}
          aria-label="Ask about this document"
          onPress={() => {
            if (pressed) return setOpen(false);
            openPane("ask");
            focusComposer();
          }}
        >
          <Sparkles className="i" aria-hidden />
          <span>Ask</span>
        </Button>
      ) : null}
      {older ? null : <SaveButton resource={r} size="md" label />}
      <ResourceMenu resource={r} size="md" context="reader" extra={panels} />
    </>
  );

  const firstCite = passageIds.length > 0 || cited;
  const hits =
    highlighting && rd ? (
      <div className="rdr-hits" role="status">
        {firstCite ? <Quote className="i i-sm" aria-hidden /> : <Search className="i i-sm" aria-hidden />}
        <span className="grow truncate">
          {marks.total ? (
            firstCite ? (
              <>
                Cited passage
                {marks.total > 1 ? (
                  <>
                    {" "}
                    <span className="num">{focusHit + 1}</span> of <span className="num">{marks.total}</span>
                  </>
                ) : null}
              </>
            ) : (
              <>
                <span className="num">{focusHit + 1}</span> of <span className="num">{marks.total}</span> for “<span translate="no">{query.q}</span>”
              </>
            )
          ) : passages.isPending ? (
            "Finding the cited passage…"
          ) : query.q ? (
            <>
              No matches for “<span translate="no">{query.q}</span>”
            </>
          ) : (
            "The cited passage isn’t in this version of the document."
          )}
          {marks.total && unresolved > 0 ? ` · ${plural(unresolved, "passage")} no longer found` : ""}
        </span>
        {marks.total > 1 ? (
          <>
            <IconButton icon={ChevronUp} tip="Previous" size="sm" onPress={() => setHit((h) => h - 1)} />
            <IconButton icon={ChevronDown} tip="Next" size="sm" onPress={() => setHit((h) => h + 1)} />
          </>
        ) : null}
        <IconButton icon={X} tip="Clear highlights" size="sm" onPress={() => setQuery({ q: "", page: "", passage: [] })} />
      </div>
    ) : null;

  /* ── Banners: only when they change what the reader should do ── */
  const outdated = doc?.indexingState === "OUTDATED";
  const canVerify = perms.can("items.verify") && !r.isPersonal;
  const trustBanner =
    trust.state === "review" ? (
      <Callout
        tone="warning"
        title={outdated ? "Changed at the source" : "Review due"}
        description={`${trust.note}${canEdit ? "" : ` Check with ${owner || "the owner"} before relying on it.`}`}
        actions={
          canEdit ? (
            <>
              {canVerify ? (
                <Button size="sm" variant="tertiary" onPress={() => void ops.verify(r)}>
                  <ShieldCheck className="i" aria-hidden />
                  Mark as verified
                </Button>
              ) : null}
              {outdated && canProcess ? (
                <Button size="sm" variant="secondary" isPending={process.isPending} onPress={() => process.mutate({ item: r.name, title: r.title })}>
                  <RotateCcw className="i" aria-hidden />
                  {r.isPersonal ? "Update" : "Publish update"}
                </Button>
              ) : null}
            </>
          ) : null
        }
      />
    ) : null;
  const verBanner = older ? (
    <Callout
      tone="accent"
      icon={History}
      title={`You’re viewing version ${query.v}${olderVersion ? ` from ${fmtDate(olderVersion.createTime)}` : ""}`}
      description={[olderVersion?.changeSummary, "Ask and Save work on the current version."].filter(Boolean).join(" · ")}
      actions={
        <Button size="sm" variant="tertiary" onPress={() => setQuery({ v: "" })}>
          View current
        </Button>
      }
    />
  ) : null;

  /* ── Canvas: the document in its native format ── */
  const notRendered = content.error instanceof ApiError && content.error.code === "FAILED_PRECONDITION";
  let canvas: React.ReactNode;
  if (!readable) {
    canvas = (
      <NotReady
        resource={r}
        error={doc?.indexingError?.message}
        canFix={canProcess}
        fixing={process.isPending}
        onFix={() => process.mutate({ item: r.name, title: r.title })}
        onDownload={() => void ops.download(r)}
      />
    );
  } else if (content.isPending || rendition.loading) {
    canvas = <SkeletonPage />;
  } else if (notRendered) {
    canvas = (
      <NothingToShow
        title={viewing === current ? "Nothing to show" : "This version can’t be previewed"}
        description={viewing === current ? "This document has no readable content yet." : "Download it to view."}
      />
    );
  } else if (content.isError || rendition.failed) {
    canvas = (
      <ErrorState
        title="This document didn’t load"
        error={content.error ?? undefined}
        description={!content.isError && rendition.error instanceof RenditionLoadError ? rendition.error.message : undefined}
        onRetry={() => {
          rendition.reset();
          void content.refetch();
        }}
      />
    );
  } else if (pageImages.length) {
    // The document as it is (document_viewer.md: PDFs keep page images); the rendition isn't downloaded.
    canvas = (
      <DocumentViewer key={viewing} format={PAGED_FORMATS[format] ? format : "pdf"} count={Math.max(assetPages, pageImages.at(-1)?.pageNumber ?? 0)} scrollRef={scrollRef}>
        <PageImageView pages={pageImages} focusPage={citedPage} />
      </DocumentViewer>
    );
  } else if (!rd?.blocks.length) {
    canvas = <NothingToShow />;
  } else {
    canvas = (
      <DocumentViewer key={viewing} format={format} count={renditionPageCount(rd, format, assetPages)} scrollRef={scrollRef}>
        <RenditionView rendition={rd} marks={marks} focusHit={focusHit} format={format} pageCount={assetPages} runningHead={[r.title, workspace.displayName ?? ""]} />
      </DocumentViewer>
    );
  }

  /* ── Side panel: closed by default; Tabs Ask · About · Related ── */
  const tabs = [...(askable ? [{ id: "ask", label: "Ask" }] : []), { id: "about", label: "About" }, { id: "related", label: "Related" }];
  const pane =
    activeTab === "ask" ? (
      <AskPane
        kind={r.kind}
        itemName={r.name}
        thread={thread}
        onAsk={(q) => void ask(q)}
        onRetry={(t) => {
          setThread((list) => list.filter((x) => x.id !== t.id));
          void Promise.resolve().then(() => ask(t.q));
        }}
        onShowPassages={showPassages}
        onOpenSource={openSource}
        onContinue={continueInChat}
        onClear={() => {
          setThread([]);
          conversation.current = null;
        }}
      />
    ) : activeTab === "related" ? (
      <RelatedPane resource={r} />
    ) : perms.isPending ? (
      <RailSkeleton />
    ) : (
      <AboutPane resource={r} canEdit={canEdit} revisions={revisions.data} viewing={viewing} current={current} onView={(v) => setQuery({ v: v ? String(v) : "" })} />
    );
  const composer =
    activeTab === "ask" && askable ? (
      <form
        className="rdr-composer"
        onSubmit={(e) => {
          e.preventDefault();
          void ask(draft);
          focusComposer();
        }}
      >
        <TextField aria-label="Ask about this document" value={draft} onChange={setDraft} className="rdr-composer__field">
          <Input id="rdr-ask-q" placeholder="Ask about this document" autoComplete="off" />
        </TextField>
        <Tip content="Ask">
          <Button type="submit" isIconOnly variant="primary" aria-label="Ask" isPending={asking} isDisabled={asking || !draft.trim()}>
            <Send aria-hidden />
          </Button>
        </Tip>
      </form>
    ) : null;

  return (
    <div className={clsx("rdr", collapsed && "is-collapsed")} ref={rootRef}>
      <PageChrome hero title={r.title} extra={chips} meta={<Meta parts={meta} className="row gap-6" />} actions={actions} crumbs={crumbs} />
      <ReaderHead resource={r} chips={chips} meta={meta} headRef={headRef}>
        {hits}
      </ReaderHead>
      <div className={clsx("rdr-body", open && "has-rail")}>
        <div className="rdr-canvas" id="rdr-scroll" ref={scrollRef}>
          {verBanner || trustBanner ? (
            <div className="rdr-banners">
              {verBanner}
              {trustBanner}
            </div>
          ) : null}
          {canvas}
        </div>
        {open ? (
          <Rail tabs={tabs} tab={activeTab} onTab={(t) => openPane(t as Tab)} onClose={() => setOpen(false)} bodyRef={railBody} composer={composer}>
            {pane}
          </Rail>
        ) : null}
      </div>
      {readable ? <SelectionToolbar root={rootRef} onAsk={askable ? (t) => void ask(explainPassagePrompt(t)) : undefined} /> : null}
    </div>
  );
}
