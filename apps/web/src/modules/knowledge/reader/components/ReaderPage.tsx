"use client";

import { Button, Dropdown, Header, Input, Label, TextField } from "@heroui/react";
import clsx from "clsx";
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, History, List as ListIcon, ListPlus, Quote, Search, Send, ShieldCheck, Sparkles, X, Zap, RotateCcw } from "lucide-react";
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
import { openAddToCollection } from "../../components/dialogs";
import { ResourceMenu, SaveButton, useUseInEntries } from "../../components/ResourceActions";
import { TrustChip, useTrust } from "../../components/TrustChip";
import { documentMarks, renditionText, searchNeedles, NO_MARKS } from "../marks";
import { explainPassagePrompt, parseReaderQuery, readerHref, revisionNumber } from "../links";
import { isSpreadsheetType, RenditionLoadError, renditionOutline } from "../rendition";
import { useCanProcess, useConversationCitations, usePassages, useProcessDocument, useReaderContent, useReaderItem, useRevisions, useSubmission } from "../queries";
import { AboutPane } from "./AboutPane";
import { AskPane, type AskTurn } from "./AskPane";
import { NotReady, NothingToShow, PanelToggle, RAIL_MIN, Rail, RailSkeleton, ReaderHead, SkeletonPage, Unavailable, Updated, useWidth, DownloadButton } from "./ReaderParts";
import { RelatedPane } from "./RelatedPane";
import { RenditionView } from "./RenditionView";
import { SelectionToolbar } from "./SelectionToolbar";
import { SubmissionView } from "./SubmissionView";
import { useRendition } from "./useRendition";

/**
 * The Reader (`/doc/[id]`, preview `P.docViewer`): header with trust and actions, outline,
 * the page canvas with cited-passage and search highlights, and a rail (Ask · About · Related).
 * Deep links: `?q=&page=&passage=&from=&v=` (document_viewer.md).
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
    return <SubmissionView resource={resource} contribution={submission.data ?? null} />;
  }
  return <Reader resource={resource} />;
}

function ReaderSkeleton() {
  return (
    <div className="rdr">
      <header className="rdr-head">
        <span className="skeleton skeleton--line" style={{ width: 60 }} />
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
  const useIn = useUseInEntries(r);
  const doc = r.item.document;
  const readable = r.readable;
  const owner = useMember(r.owner).data?.displayName;

  // Record the view once per document (UpdateRecentItem with allowMissing).
  const recorded = useRef("");
  useEffect(() => {
    if (recorded.current === r.id) return;
    recorded.current = r.id;
    record.mutate(r.id);
  }, [r.id, record]);

  /* ── URL state ── */
  const setQuery = useCallback(
    (patch: Partial<Record<"q" | "page" | "from" | "v", string>> & { passage?: string[] }) => {
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
  const fromCitations = useConversationCitations(query.from, r.id);
  const passageIds = useMemo(
    () => [...new Set([...query.passages, ...(query.passages.length ? [] : (fromCitations.data ?? []).map((c) => resourceId(c.passage)))])],
    [query.passages, fromCitations.data],
  );
  const viewing = query.v && query.v !== current ? query.v : passageIds.length && indexed && indexed !== current ? indexed : current;
  const revisions = useRevisions(r.id);
  const olderVersion = query.v && query.v !== current ? revisions.data?.find((v) => revisionNumber(v.name) === query.v) : undefined;

  const content = useReaderContent(r.id, viewing === current ? undefined : String(viewing), { enabled: readable });
  const passages = usePassages(r.id, passageIds);

  /* ── Rendition ── */
  const rendition = useRendition(r.id, content.data);
  const rd = rendition.doc;

  /* ── Highlights ── */
  const cited = !!(query.page || query.from || query.q.length >= 40);
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
    if (!sc || !rd) return;
    const mark = focusHit >= 0 ? sc.querySelector<HTMLElement>(`mark.evidence[data-hit="${focusHit}"]`) : null;
    const target = mark ?? (query.page ? sc.querySelector<HTMLElement>(`.doc-page[data-page="${query.page}"]`) : null);
    if (!target) return;
    const top = sc.scrollTop + target.getBoundingClientRect().top - sc.getBoundingClientRect().top - (mark ? sc.clientHeight / 3 : 24);
    sc.scrollTo({ top, behavior: firstScroll.current ? "auto" : "smooth" });
    firstScroll.current = false;
  }, [focusHit, rd, query.page, marks]);

  /* ── Layout ── */
  const rootRef = useRef<HTMLDivElement>(null);
  const width = useWidth(rootRef);
  const [railPref, setRailPref] = useState<boolean | null>(null);
  const narrow = width > 0 && width < RAIL_MIN;
  const open = railPref ?? (width === 0 || width >= RAIL_MIN);
  const [tab, setTab] = useState<Tab>("ask");
  const activeTab: Tab = !readable && tab === "ask" ? "about" : tab;
  const [outlineOpen, setOutlineOpen] = useState(true);
  const sheet = isSpreadsheetType(r.mime);
  const outline = useMemo(() => (rd ? renditionOutline(rd).filter((o) => o.id !== (rd.blocks[0]?.kind === "heading" ? rd.blocks[0].id : "")) : []), [rd]);
  const hasOutline = readable && !sheet && outline.length > 1;
  const pageCount = Math.max(content.data?.pageAssets?.length ?? 0, ...(rd?.blocks.map((b) => b.page ?? 0) ?? [0]));
  const [activeHeading, setActiveHeading] = useState("");

  const jump = (id: string) => {
    const sc = scrollRef.current;
    const h = sc?.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(id)}"]`);
    if (!sc || !h) return;
    sc.scrollTo({ top: sc.scrollTop + h.getBoundingClientRect().top - sc.getBoundingClientRect().top - 24, behavior: "smooth" });
  };
  useEffect(() => {
    const sc = scrollRef.current;
    if (!sc || !hasOutline) return;
    const track = () => {
      const top = sc.getBoundingClientRect().top + sc.clientHeight / 3;
      let on = outline[0]?.id ?? "";
      for (const o of outline) {
        const h = sc.querySelector(`[data-block-id="${CSS.escape(o.id)}"]`);
        if (h && h.getBoundingClientRect().top <= top) on = o.id;
      }
      setActiveHeading(on);
    };
    track();
    sc.addEventListener("scroll", track, { passive: true });
    return () => sc.removeEventListener("scroll", track);
  }, [hasOutline, outline, rd]);

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
    if (!question || asking || !readable) return;
    const id = ++seq.current;
    setThread((list) => [...list, { id, q: question }]);
    setDraft("");
    setRailPref(true);
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
  const showPassages = (ids: string[]) => {
    if (narrow) setRailPref(false);
    setQuery({ q: "", page: "", passage: ids });
  };
  const openSource = (s: AnswerSource) => router.push(readerHref({ item: s.item, passages: s.passages.map((p) => p.passage), from: conversation.current ?? undefined }));

  // Escape closes the overlay rail on narrow screens (the selection toolbar handles its own).
  useEffect(() => {
    if (!narrow || !open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !document.querySelector(".doc-sel")) setRailPref(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [narrow, open]);

  /* ── Header ── */
  const status = indexStatusOf(r);
  const meta = [
    r.kindMeta.label,
    r.base?.displayName && <span translate="no">{r.base.displayName}</span>,
    owner && <span translate="no">{owner}</span>,
    <Updated key="u" at={r.updated} />,
    `v${current}`,
    readable && !sheet && pageCount > 0 && plural(pageCount, "page"),
  ];
  const actions = (
    <>
      {readable ? (
        <Button
          variant="primary"
          className="rdr-ask-btn"
          onPress={() => {
            setRailPref(true);
            setTab("ask");
            requestAnimationFrame(() => document.getElementById("rdr-ask-q")?.focus());
          }}
        >
          <Sparkles className="i" aria-hidden />
          Ask
        </Button>
      ) : null}
      <span className="rdr-wrap rdr-wide">
        <SaveButton resource={r} size="md" label />
      </span>
      <Tip content="Add to collection">
        <Button variant="secondary" className="rdr-wide rdr-squeeze" onPress={() => openAddToCollection(r.name)}>
          <ListPlus className="i" aria-hidden />
          <span>Add to collection</span>
        </Button>
      </Tip>
      {readable && useIn.length ? (
        <Dropdown>
          <Button variant="secondary" className="rdr-wide rdr-squeeze" aria-label="Use in a workflow">
            <Zap className="i" aria-hidden />
            <span>Use in…</span>
            <ChevronDown className="i" aria-hidden />
          </Button>
          <Dropdown.Popover placement="bottom end">
            <Dropdown.Menu aria-label="Use in" onAction={(key) => useIn.find((e) => e.id === key)?.run()}>
              <Dropdown.Section>
                <Header>Use in</Header>
                {useIn.map((e) => (
                  <Dropdown.Item key={e.id} id={e.id} textValue={e.label}>
                    <e.icon className="i" aria-hidden />
                    <Label>{e.label}</Label>
                  </Dropdown.Item>
                ))}
              </Dropdown.Section>
            </Dropdown.Menu>
          </Dropdown.Popover>
        </Dropdown>
      ) : null}
      <DownloadButton onPress={() => void ops.download(r)} />
      {hasOutline ? (
        <Dropdown>
          <Button isIconOnly variant="ghost" className="button--muted rdr-outline-btn" aria-label="Outline">
            <ListIcon aria-hidden />
          </Button>
          <Dropdown.Popover placement="bottom end">
            <Dropdown.Menu aria-label="On this page" onAction={(key) => jump(String(key))}>
              <Dropdown.Section>
                <Header>On this page</Header>
                {outline.map((o) => (
                  <Dropdown.Item key={o.id} id={o.id} textValue={o.title}>
                    <ChevronRight className="i" aria-hidden />
                    <Label translate="no">{o.title}</Label>
                  </Dropdown.Item>
                ))}
              </Dropdown.Section>
            </Dropdown.Menu>
          </Dropdown.Popover>
        </Dropdown>
      ) : null}
      <PanelToggle open={open} onToggle={() => setRailPref(!open)} />
      <ResourceMenu resource={r} size="md" hideOpen q={query.q} />
    </>
  );

  const firstCite = passageIds.length > 0 || cited;
  const hits = highlighting && rd ? (
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
      <IconButton icon={X} tip="Clear highlights" size="sm" onPress={() => setQuery({ q: "", page: "", from: "", passage: [] })} />
    </div>
  ) : null;

  /* ── Banners ── */
  const outdated = doc?.indexingState === "OUTDATED";
  const canVerify = perms.can("items.verify") && !r.isPersonal;
  const trustBanner =
    trust.state === "review" ? (
      <Callout
        tone="warning"
        title={outdated ? "Changed at the source" : "Review due"}
        description={`${trust.note}${canEdit ? "" : " Check with the owner before relying on it."}`}
        actions={
          canEdit ? (
            <>
              {canVerify ? (
                <Button size="sm" variant="secondary" onPress={() => void ops.verify(r)}>
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
  const verBanner =
    query.v && query.v !== current ? (
      <Callout
        tone="accent"
        icon={History}
        title={`You’re viewing version ${query.v}${olderVersion ? ` from ${fmtDate(olderVersion.createTime)}` : ""}`}
        description={olderVersion?.changeSummary ? <span translate="no">{olderVersion.changeSummary}</span> : undefined}
        actions={
          <Button size="sm" variant="secondary" onPress={() => setQuery({ v: "" })}>
            View current
          </Button>
        }
      />
    ) : null;

  /* ── Canvas ── */
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
  } else if (!rd?.blocks.length) {
    canvas = <NothingToShow />;
  } else {
    canvas = <RenditionView rendition={rd} marks={marks} focusHit={focusHit} sheet={sheet} pageCount={pageCount} />;
  }

  /* ── Rail ── */
  const tabs = [...(readable ? [{ id: "ask", label: "Ask" }] : []), { id: "about", label: "About" }, { id: "related", label: "Related" }];
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
    activeTab === "ask" && readable ? (
      <form
        className="rdr-composer"
        onSubmit={(e) => {
          e.preventDefault();
          void ask(draft);
        }}
      >
        <TextField aria-label="Ask about this document" value={draft} onChange={setDraft} className="rdr-composer__field">
          <Input id="rdr-ask-q" placeholder="Ask about this document" autoComplete="off" />
        </TextField>
        <Tip content="Ask">
          <Button type="submit" isIconOnly variant="primary" aria-label="Ask" isDisabled={asking || !draft.trim()}>
            <Send aria-hidden />
          </Button>
        </Tip>
      </form>
    ) : null;

  const crumbs = [
    { label: "Knowledge", href: "/knowledge" },
    ...(r.base ? [{ label: r.base.displayName || "Knowledge base", href: r.isPersonal ? "/knowledge/library?tab=files" : `/knowledge/${r.base.id}` }] : []),
    { label: r.title },
  ];

  return (
    <div className="rdr" ref={rootRef}>
      <PageChrome crumbs={crumbs} />
      <ReaderHead
        resource={r}
        conversation={query.from || undefined}
        chips={
          <>
            <TrustChip resource={r} />
            {status ? <StatusChip kind="doc" value={status} size="sm" /> : null}
            {workspace.demo ? <StatusChip label="Demo data" tone="default" dot={false} size="sm" tooltip="This workspace holds fictional demo content." /> : null}
          </>
        }
        meta={meta}
        actions={actions}
      >
        {hits}
      </ReaderHead>
      <div className={clsx("rdr-body", open && "has-rail")}>
        {hasOutline ? (
          outlineOpen ? (
            <nav className="rdr-outline" aria-label="Outline">
              <div className="rdr-outline__head">
                <span className="t-label">On this page</span>
                <IconButton icon={ChevronLeft} tip="Hide outline" size="sm" onPress={() => setOutlineOpen(false)} />
              </div>
              {outline.map((o, i) => (
                <button
                  key={o.id}
                  type="button"
                  className={clsx("rdr-outline__link", (activeHeading ? activeHeading === o.id : !i) && "is-on")}
                  onClick={() => jump(o.id)}
                  translate="no"
                >
                  {o.title}
                </button>
              ))}
            </nav>
          ) : (
            <nav className="rdr-outline rdr-outline--closed" aria-label="Outline">
              <IconButton icon={ListIcon} tip="Show outline" size="sm" onPress={() => setOutlineOpen(true)} />
            </nav>
          )
        ) : null}
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
          <Rail tabs={tabs} tab={activeTab} onTab={(t) => setTab(t as Tab)} onClose={() => setRailPref(false)} bodyRef={railBody} composer={composer}>
            {pane}
          </Rail>
        ) : null}
      </div>
      {readable ? <SelectionToolbar root={rootRef} onAsk={(t) => void ask(explainPassagePrompt(t))} /> : null}
    </div>
  );
}
