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
import { useMessages } from "@/lib/i18n";
import { useWorkspace } from "@/lib/workspace";
import { converse, createConversation } from "@/modules/chat/api";
import type { AnswerSource } from "@/modules/chat/turn";

import { indexStatusOf, type Resource } from "../../model";
import { useDocumentOperations } from "../../operations";
import { useItemPermissions, useKnowledgeModel, useMember, useRecordRecent } from "../../queries";
import { DemoChip } from "../../components/KnowledgeHeader";
import { ResourceMenu, SaveButton, type MenuEntry } from "../../components/ResourceActions";
import { TrustChip, useTrust } from "../../components/TrustChip";
import { explainPassagePrompt, parseOrigin, parseReaderQuery, readerHref, revisionNumber } from "../links";
import { useCanProcess, useConversationCitations, useItemPreview, usePassages, useProcessDocument, useReaderItem, useRevision, useRevisions, useSubmission } from "../queries";
import { AboutPane } from "./AboutPane";
import { AskPane, type AskTurn } from "./AskPane";
import { DocumentSurface, type SurfaceHighlight, type SurfaceMarks } from "./DocumentSurface";
import { Meta, ProcessingNote, RAIL_MIN, Rail, RailSkeleton, ReaderHead, SkeletonPage, Unavailable, Updated, useCollapsingHead, useWidth } from "./ReaderParts";
import { RelatedPane } from "./RelatedPane";
import { SelectionToolbar } from "./SelectionToolbar";
import { SubmissionView } from "./SubmissionView";
import { useOriginCrumbs } from "./useOriginCrumbs";

/**
 * The Reader (`/doc/[id]`, preview `P.docViewer`): content first. The top row carries the trail
 * (back to where it was opened from) and Ask · Save · ⋯; the head below is the document's identity
 * and the find-in-document bar; the page canvas renders the file natively with cited-passage and
 * search highlights; the side panel (Ask · About · Related) opens on demand.
 * Deep links: `?q=&page=&passage=&from=&v=&ask=1` (document_viewer.md).
 */
export function ReaderPage({ itemId }: { itemId: string }) {
  const item = useReaderItem(itemId);
  // Read the current preview alongside the Item, not after it: the surface finds it cached and its viewer chunk loads at once.
  useItemPreview(itemId, undefined);
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
      return e.status === 403 ? <Unavailable locked description="Tài liệu có thể đã bị gỡ hoặc không được chia sẻ với bạn." /> : <Unavailable />;
    }
    return (
      <div className="rdr-msg">
        <ErrorState error={e} title="Không tải được tài liệu này" onRetry={() => void item.refetch()} />
      </div>
    );
  }
  if (!resource || resource.item.itemKind !== "DOCUMENT" || resource.deleted) return <Unavailable />;
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
  const { id: ws } = useWorkspace();
  const ops = useDocumentOperations();
  const perms = useItemPermissions(r.name);
  const canEdit = perms.can("items.update");
  const canProcess = useCanProcess(r.id);
  const process = useProcessDocument();
  const trust = useTrust(r);
  const m = useMessages();
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
  const listed = older ? revisions.data?.find((v) => revisionNumber(v.name) === query.v) : undefined;
  // An older version past the listed page is read on its own.
  const unlisted = useRevision(r.id, older ? query.v : undefined, { enabled: older && !!revisions.data && !listed });
  const olderVersion = listed ?? (older ? unlisted.data : undefined);
  // Ask and Save work on the current version only.
  const askable = readable && !older;

  const passages = usePassages(r.id, passageIds);

  /* ── Highlights: cited passages and `?q=` need a processed document; the file itself never does ── */
  const cited = !!(query.page || conversationFrom || query.q.length >= 40);
  const resolved = useMemo(() => passages.data.filter((p): p is NonNullable<typeof p> => !!p), [passages.data]);
  const highlight = useMemo<SurfaceHighlight | undefined>(() => (readable ? { passages: resolved, q: query.q, cited } : undefined), [readable, resolved, query.q, cited]);
  const [marks, setMarks] = useState<SurfaceMarks>({ total: 0, unresolved: 0, ready: false, searchable: false });
  const unresolved = marks.unresolved + (passages.isPending ? 0 : passages.data.filter((p) => p === null).length);
  const highlighting = readable && marks.ready && (passageIds.length > 0 || (!!query.q && marks.searchable));
  const [hit, setHit] = useState(0);
  const hitKey = `${params.toString()}|${marks.total}`;
  const [lastKey, setLastKey] = useState(hitKey);
  if (lastKey !== hitKey) {
    setLastKey(hitKey);
    setHit(0);
  }
  const focusHit = marks.total ? ((hit % marks.total) + marks.total) % marks.total : -1;

  const scrollRef = useRef<HTMLDivElement>(null);

  /* ── Layout: content first, the side panel opens on demand ── */
  const rootRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLElement>(null);
  const width = useWidth(rootRef);
  const narrow = width > 0 && width < RAIL_MIN;
  const collapsed = useCollapsingHead(scrollRef, headRef, r.id);
  const [open, setOpen] = useState(query.ask && askable);
  const [tab, setTab] = useState<Tab>("ask");
  const activeTab: Tab = !askable && tab === "ask" ? "about" : tab;
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
    r.typeMeta.label,
    owner && <span key="o">{`do ${owner}`}</span>,
    older ? <span key="v">{`Phiên bản ${query.v}${olderVersion ? ` · ${fmtDate(olderVersion.createTime)}` : ""}`}</span> : <Updated key="u" at={r.updated} />,
  ];
  const chips = (
    <>
      {older ? (
        <StatusChip label="Phiên bản cũ" tone="default" icon={History} size="sm" tooltip={`Hiện tại: v${current}, ${fmtDate(r.updated)}`} />
      ) : (
        <TrustChip resource={r} />
      )}
      {status ? <StatusChip kind="doc" value={status} size="sm" /> : null}
      <DemoChip />
    </>
  );
  const pressed = open && activeTab === "ask";
  const panels: MenuEntry[] = [{ id: "about", label: "Về tài liệu này", icon: Info, run: () => openPane("about") }];
  const actions = (
    <>
      {askable ? (
        <Button
          variant="primary"
          className="rdr-ask-btn"
          aria-pressed={pressed}
          aria-label="Hỏi về tài liệu này"
          onPress={() => {
            if (pressed) return setOpen(false);
            openPane("ask");
            focusComposer();
          }}
        >
          <Sparkles className="i" aria-hidden />
          <span>Hỏi</span>
        </Button>
      ) : null}
      {older ? null : <SaveButton resource={r} size="md" label />}
      <ResourceMenu resource={r} size="md" context="reader" extra={panels} />
    </>
  );

  const firstCite = passageIds.length > 0 || cited;
  const hits =
    highlighting ? (
      <div className="rdr-hits" role="status">
        {firstCite ? <Quote className="i i-sm" aria-hidden /> : <Search className="i i-sm" aria-hidden />}
        {/* Whole sentences (preview `hitLabel`), so the localizer can translate them; the query itself is the user's. */}
        <span className="grow truncate">
          {marks.total
            ? firstCite
              ? "Đoạn được trích dẫn"
              : `Kết quả khớp với “${query.q}”`
            : passages.isPending
              ? "Đang tìm đoạn được trích dẫn…"
              : query.q
                ? `Không có kết quả cho “${query.q}”`
                : "Đoạn được trích dẫn không có trong phiên bản này của tài liệu."}
          {marks.total && unresolved > 0 ? (
            <>
              {" · "}
              <span>{`Không còn tìm thấy ${plural(unresolved, "passage")}`}</span>
            </>
          ) : null}
        </span>
        {marks.total > 1 ? <span className="rdr-hits__n num">{`${focusHit + 1} / ${marks.total}`}</span> : null}
        {marks.total > 1 ? (
          <>
            <IconButton icon={ChevronUp} tip="Trước" size="sm" onPress={() => setHit((h) => h - 1)} />
            <IconButton icon={ChevronDown} tip="Tiếp" size="sm" onPress={() => setHit((h) => h + 1)} />
          </>
        ) : null}
        <IconButton icon={X} tip="Xóa đánh dấu" size="sm" onPress={() => setQuery({ q: "", page: "", passage: [] })} />
      </div>
    ) : null;

  /* ── Banners: only when they change what the reader should do ── */
  const outdated = doc?.indexingState === "OUTDATED";
  const canVerify = perms.can("items.verify") && !r.isPersonal;
  const trustBanner =
    trust.state === "review" ? (
      <Callout
        tone="warning"
        title={outdated ? m.state.processing.outdated.label : m.state.verification.review.label}
        description={`${trust.note || m.state.verification.review.desc}${canEdit ? "" : `Hãy xác nhận với ${owner || "chủ sở hữu"} trước khi sử dụng.`}`}
        actions={
          canEdit ? (
            <>
              {canVerify ? (
                <Button size="sm" variant="tertiary" onPress={() => void ops.verify(r)}>
                  <ShieldCheck className="i" aria-hidden />
                  Đánh dấu đã xác minh
                </Button>
              ) : null}
              {outdated && canProcess ? (
                <Button size="sm" variant="secondary" isPending={process.isPending} onPress={() => process.mutate({ item: r.name, title: r.title })}>
                  <RotateCcw className="i" aria-hidden />
                  {r.isPersonal ? "Cập nhật" : "Xử lý bản cập nhật"}
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
      title={`Bạn đang xem phiên bản ${query.v}${olderVersion ? ` từ ${fmtDate(olderVersion.createTime)}` : ""}`}
      description={[olderVersion?.changeSummary, "Hỏi và Lưu áp dụng cho phiên bản hiện tại."].filter(Boolean).join(" · ")}
      actions={
        <Button size="sm" variant="tertiary" onPress={() => setQuery({ v: "" })}>
          Xem bản hiện tại
        </Button>
      }
    />
  ) : null;

  // Where processing stands: a quiet line above the file, which is shown whatever it says.
  const procNote = older || readable ? null : (
    <ProcessingNote
      resource={r}
      error={doc?.indexingError?.message}
      canProcess={canProcess}
      processing={process.isPending}
      onProcess={() => process.mutate({ item: r.name, title: r.title })}
    />
  );

  /* ── Side panel: closed by default; Tabs Ask · About · Related ── */
  const tabs = [...(askable ? [{ id: "ask", label: "Hỏi" }] : []), { id: "about", label: "Giới thiệu" }, { id: "related", label: "Liên quan" }];
  const pane =
    activeTab === "ask" ? (
      <AskPane
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
        <TextField aria-label="Hỏi về tài liệu này" value={draft} onChange={setDraft} className="rdr-composer__field">
          <Input id="rdr-ask-q" placeholder="Hỏi về tài liệu này" autoComplete="off" />
        </TextField>
        <Tip content="Hỏi">
          <Button type="submit" isIconOnly variant="primary" aria-label="Hỏi" isPending={asking} isDisabled={asking || !draft.trim()}>
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
          {verBanner || trustBanner || procNote ? (
            <div className="rdr-banners">
              {verBanner}
              {trustBanner}
              {procNote}
            </div>
          ) : null}
          <DocumentSurface
            key={viewing}
            document={r}
            revision={viewing === current ? undefined : String(viewing)}
            scrollRef={scrollRef}
            highlight={highlight}
            focusHit={focusHit}
            page={query.page}
            onMarks={setMarks}
            onDownload={() => void ops.download(r)}
          />
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
