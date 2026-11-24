"use client";

import { Button, Dropdown, Header, Label, TextArea, TextField } from "@heroui/react";
import { Archive, ArrowLeft, ChevronDown, ChevronRight, Clock, Code, Database, Download, Folder, FolderPlus, Lock, Plus, Table, Tag, Undo2, Upload } from "lucide-react";
import NextLink from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import { EditableTitle, EmptyState, ErrorState, IconButton, PageHeader, SaveBar, SearchInput, SectionTabs, SkeletonRows, StatusChip, toast } from "@/components/ui";
import { errorMessage, resourceId } from "@/lib/api/client";
import { fmtNum, plural, relInline } from "@/lib/format";
import { useMessages } from "@/lib/i18n";
import { useWorkspace } from "@/lib/workspace";
import { DOMAIN_ICON } from "@/modules/home/domainIcon";
import { topicToneProps } from "@/modules/knowledge/components/TopicTag";
import { catalogHref, fold, topicLooks } from "@/modules/knowledge/model";
import { useMemberNames } from "@/modules/knowledge/queries";

import { deleteTopic, undeleteTopic, updateTopic, type Topic, type TopicPatch } from "../api";
import { publishedWithTopic } from "../docFilter";
import { activeDomains, nameTaken, topicCounts, topicsOf, type TopicCounts } from "../governance";
import { docsHref, topicsHref } from "../model";
import { useHeldDecisions } from "../decisions";
import { useAllTopics, useAssistantTaggedCounts, useCounts, useDocScope, useInvalidateCuration, useLastTopicImport, useRememberTopic } from "../queries";
import { exportRows, TEMPLATE_ROWS } from "../topicSheet";
import { DemoChip } from "./parts";
import { ActionsMenu, saveCsv } from "./shared";
import { ImportDialog } from "./topics/ImportDialog";
import { NewNodeDialog, type NewNodeRequest } from "./topics/NewTopicDialog";
import { PromptDrawer } from "./topics/PromptDrawer";
import { TestClassification } from "./topics/TestClassification";
import { DomainColorPicker, IconPicker } from "./topics/TopicLookPicker";
import {
  cleanBlock,
  ExamplesEditor,
  GUIDANCE_MAX,
  RulesEditor,
  rulesOf,
  rulesToApi,
  Sec,
  TermsEditor,
  useRuleOptions,
  withTyped,
  type RuleDraft,
  type TermsDraft,
} from "./topics/TopicSignals";
import { TopicSuggestions } from "./topics/Suggestions";

const ARCHIVED = "__archived";

/** Topics' views (`?view=`): every topic, and what the assistant and reviewers suggest. Named by `m.studio.topicViews[view]`. */
const VIEWS = ["topics", "suggestions"] as const;

/** A node's working copy (one per node, one save bar): its description and signals, and what's typed in the keyword
 *  input. The name and the domain change in the header at once (with Undo), never through the draft. */
interface Draft extends TermsDraft {
  desc: string;
  guidance: string;
  rules: RuleDraft[];
  /** Example document item names. */
  examples: string[];
}

const valuesOf = (t: Topic): Draft => ({
  desc: t.description ?? "",
  guidance: t.guidance ?? "",
  keywords: [...(t.keywords ?? [])],
  synonyms: [...(t.synonyms ?? [])],
  rules: rulesOf(t),
  examples: [...(t.examples ?? [])],
  keywordsIn: "",
});
/** Same entries in the same order. */
const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
/** `b` is a saved node's values; anything typed in the keyword input counts as a change (saving adds it). */
const sameValues = (a: Draft, b: Draft) =>
  a.desc.trim() === b.desc.trim() &&
  cleanBlock(a.guidance) === cleanBlock(b.guidance) &&
  sameList(a.keywords, b.keywords) &&
  sameList(a.synonyms, b.synonyms) &&
  sameList(a.examples, b.examples) &&
  JSON.stringify(a.rules) === JSON.stringify(b.rules) &&
  !a.keywordsIn.trim();
/** A topic the assistant can only match by name: no keywords and no synonyms. Filling these in is the main upkeep. */
const isBare = (t: Topic) => t.kind === "TOPIC" && !t.keywords?.length && !t.synonyms?.length;

/**
 * Knowledge Studio → Topics (preview `X.md.tab`, workspace admins): what documents are about, in two views as page
 * tabs (`?view=`). All: the header's ⋯ (classification prompt, export, template) and Import; a summary line (counts,
 * the last import; topics without keywords narrow the tree, `?show=bare`) and the tree (search over names and keywords,
 * one New menu, domains with their topics and counts, archived last; keyboard navigable) beside the selected node's
 * detail (`?node=`). New domains and topics are made in small dialogs, then edited in the detail. `?import=1` opens
 * Import. Suggestions: topics the assistant proposes, keywords from reviewers' corrections, topics to confirm and
 * documents without a topic; its tab counts the proposals (the sidebar badge's number).
 */
export function TopicsSection() {
  const { can, workspace } = useWorkspace();
  const m = useMessages();
  const admin = can("topics.update");
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const topics = useAllTopics({ enabled: admin });
  const held = useHeldDecisions();
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [importing, setImporting] = useState(false);
  const [promptOpen, setPromptOpen] = useState(false);
  const [adding, setAdding] = useState<NewNodeRequest | null>(null);
  /** "Fine-tune classification" stays as the admin left it while they move between topics. */
  const [advOpen, setAdvOpen] = useState(false);
  const lastImport = useLastTopicImport({ enabled: admin && can("auditEvents.list") });
  const importerName = lastImport.data ? `${workspace.name}/members/${resourceId(lastImport.data.actor)}` : null;
  const importerNames = useMemberNames([importerName]);
  const view = params.get("view") === "suggestions" ? "suggestions" : "topics";

  const setQuery = (patch: Record<string, string>) => {
    const next = new URLSearchParams(params.toString());
    next.set("tab", "topics");
    next.set("view", view);
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    router.replace(`${pathname}?${next.toString()}`, { scroll: false });
  };
  const importOpen = importing || params.get("import") === "1";
  const closeImport = () => {
    setImporting(false);
    if (params.get("import")) setQuery({ import: "" });
  };

  const all = useMemo(() => topics.data ?? [], [topics.data]);
  const counts = useMemo(() => topicCounts(all), [all]);
  // A decision in its Undo window has left the list already.
  const proposals = all.filter((t) => t.state === "PROPOSED" && !held.has(t.name ?? ""));
  const domains = activeDomains(all);
  const exportName = `${fold(workspace.displayName ?? "workspace").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}-topics.csv`;

  const header = (
    <PageHeader
      title={m.nav.topics}
      chips={<DemoChip />}
      actions={
        // With no topics yet the empty state carries Import, so the header stays empty.
        admin && view === "topics" && domains.length ? (
          <>
            <ActionsMenu
              label="Thao tác khác cho chủ đề"
              actions={[
                { id: "prompt", label: "Xem cách trợ lý phân loại", icon: Code, onAction: () => setPromptOpen(true) },
                { id: "export", label: "Xuất danh sách chủ đề", icon: Download, separated: true, onAction: () => saveCsv(exportName, exportRows(all)) },
                { id: "template", label: "Tải mẫu", icon: Table, onAction: () => saveCsv("topics-template.csv", TEMPLATE_ROWS) },
              ]}
            />
            <Button variant="secondary" onPress={() => setImporting(true)}>
              <Upload className="i" aria-hidden />
              Nhập
            </Button>
          </>
        ) : null
      }
    >
      {admin ? (
        <SectionTabs
          items={VIEWS.map((id) => ({ id, label: m.studio.topicViews[id], href: topicsHref(id), count: id === "suggestions" ? proposals.length || null : null }))}
          active={view}
          label={m.studio.topicViews.label}
        />
      ) : null}
    </PageHeader>
  );

  if (!admin) {
    return (
      <>
        {header}
        <EmptyState icon={Lock} title="Chỉ quản trị viên không gian làm việc mới thay đổi được chủ đề" boxed />
      </>
    );
  }
  if (!topics.data) {
    return (
      <>
        {header}
        {topics.isError ? <ErrorState title="Không tải được chủ đề" error={topics.error} onRetry={() => void topics.refetch()} /> : <SkeletonRows rows={6} />}
      </>
    );
  }
  if (view === "suggestions") {
    return (
      <>
        {header}
        <TopicSuggestions proposals={proposals} topics={all} />
      </>
    );
  }

  const liveTopics = all.filter((t) => t.kind === "TOPIC" && t.state === "ACTIVE" && domains.some((d) => d.name === t.parentTopic));
  const bareCount = liveTopics.filter(isBare).length;
  const bare = params.get("show") === "bare";
  const picked = params.get("node") ?? "";
  const byId = (id: string) => all.find((t) => resourceId(t.name) === id);
  const resolve = (): string => {
    if (picked && byId(picked) && byId(picked)?.state !== "PROPOSED" && byId(picked)?.state !== "REJECTED") return picked;
    // Narrowed to topics without keywords: the first of them, ready to fill in.
    return resourceId(((bare && liveTopics.find(isBare)) || domains[0])?.name);
  };
  const node = resolve();

  /** Opens New domain / New topic. A new topic goes into `parent`, else the selected node's domain, else the first; with no domain yet, a domain comes first. */
  const openNew = (kind: "domain" | "topic", parent = "") => {
    if (kind === "domain" || !domains.length) {
      setAdding({ kind: "domain", parent: "" });
      return;
    }
    const cur = byId(node);
    const context = cur?.state === "ACTIVE" ? (cur.kind === "TOPIC" ? cur.parentTopic : cur.name) : "";
    setAdding({ kind: "topic", parent: parent || context || domains[0]?.name || "" });
  };
  const newDialog = <NewNodeDialog request={adding} topics={all} onClose={() => setAdding(null)} onSelect={(id) => setQuery({ node: id })} />;

  const keywordCount = liveTopics.reduce((a, t) => a + (t.keywords?.length ?? 0) + (t.synonyms?.length ?? 0), 0);
  const last = lastImport.data;
  const importer = last ? importerNames.get(importerName ?? "") || "Thành viên cũ" : "";
  const dot = (
    <span className="muted" aria-hidden="true">
      {" · "}
    </span>
  );
  const summary = (
    <div className="tx-sum">
      <p className="tx-sum__text">
        <span className="medium">{`${plural(domains.length, "domain")} · ${plural(liveTopics.length, "topic")} · ${plural(keywordCount, "keyword")}`}</span>
        {last ? (
          <>
            {dot}
            <span>{`Do ${importer} nhập lần cuối ${relInline(last.createTime)}`}</span>
          </>
        ) : null}
        {bareCount || bare ? (
          <>
            {dot}
            <button
              type="button"
              className="tx-sum__warn"
              aria-pressed={bare}
              title={bare ? "Hiện mọi chủ đề" : "Quy trình xử lý chỉ khớp theo tên. Chỉ hiện các chủ đề này."}
              onClick={() => setQuery({ show: bare ? "" : "bare" })}
            >
              {`${plural(bareCount, "topic")} chưa có từ khóa`}
            </button>
          </>
        ) : null}
      </p>
    </div>
  );
  const prompt = <PromptDrawer isOpen={promptOpen} onClose={() => setPromptOpen(false)} topics={all} />;

  if (!domains.length) {
    return (
      <>
        {header}
        <div className="tx">
          <EmptyState
            icon={Database}
            title="Chưa có chủ đề"
            description="Nhập chủ đề từ bảng tính, hoặc bắt đầu với một lĩnh vực."
            boxed
            actions={
              <>
                <Button variant="primary" onPress={() => setImporting(true)}>
                  <Upload className="i" aria-hidden />
                  Nhập
                </Button>
                <Button variant="secondary" onPress={() => openNew("domain")}>
                  <FolderPlus className="i" aria-hidden />
                  Lĩnh vực mới
                </Button>
              </>
            }
          />
        </div>
        <ImportDialog isOpen={importOpen} onClose={closeImport} />
        {newDialog}
      </>
    );
  }

  const draftOf = (key: string): Draft | null => {
    const t = byId(key);
    if (!t) return null;
    return drafts[key] ?? valuesOf(t);
  };
  const isDirty = (key: string) => {
    const t = byId(key);
    return !!t && !!drafts[key] && !sameValues(drafts[key], valuesOf(t));
  };
  // Merges onto the latest draft, so several patches in one event all land.
  const setDraft = (key: string, patch: Partial<Draft>) => {
    const t = byId(key);
    setDrafts((d) => {
      const base = d[key] ?? (t ? valuesOf(t) : null);
      return base ? { ...d, [key]: { ...base, ...patch } } : d;
    });
  };
  const dropDraft = (key: string) =>
    setDrafts((d) => {
      const next = { ...d };
      delete next[key];
      return next;
    });

  return (
    <>
      {header}
      <div className={`tx${picked ? " tx--picked" : ""}`}>
        {summary}
        <div className="tx-panes">
          <TopicTree
            topics={all}
            counts={counts}
            selected={node}
            dirty={(key) => isDirty(key)}
            bare={bare}
            onSelect={(id) => setQuery({ node: id })}
            onNew={openNew}
          />
          <div className="tx-main">
            <NodeDetail
              key={node}
              topic={byId(node) ?? null}
              topics={all}
              counts={counts}
              draft={draftOf(node)}
              dirty={isDirty(node)}
              setDraft={(patch) => setDraft(node, patch)}
              dropDraft={() => dropDraft(node)}
              onSelect={(id) => setQuery({ node: id })}
              onNew={openNew}
              advOpen={advOpen}
              onAdvOpen={setAdvOpen}
            />
          </div>
        </div>
      </div>
      <ImportDialog isOpen={importOpen} onClose={closeImport} />
      {newDialog}
      {prompt}
    </>
  );
}

/* ═══════════════ Tree ═══════════════ */

interface TreeItem {
  id: string;
  level: 1 | 2;
  expanded?: boolean;
  inner: ReactNode;
  cls?: string;
  children?: TreeItem[];
}

const NO_KEYWORDS = "Chưa có từ khóa — hãy thêm để tài liệu được khớp";

/**
 * Domains → topics on one row grid: [chevron 16] [icon 20] [name] [trailing]. Topic rows keep an empty chevron slot and
 * indent by chevron + gap, so a topic's icon sits under its domain's name. A domain's icon sits on a tile in its color;
 * a topic's (its own, else its domain's) is drawn in that color; archived ones stay muted.
 */
function TopicTree({
  topics,
  counts,
  selected,
  dirty,
  bare,
  onSelect,
  onNew,
}: {
  topics: readonly Topic[];
  counts: TopicCounts;
  selected: string;
  dirty: (key: string) => boolean;
  /** Only topics without keywords (`?show=bare`). */
  bare: boolean;
  onSelect: (id: string) => void;
  onNew: (kind: "domain" | "topic", parent?: string) => void;
}) {
  const [q, setQ] = useState("");
  /** Domains the person opened or closed; the rest start closed, except the selection's domain (27 domains of 200
   *  topics scan better as a list of domains, and the tree stays a few hundred elements instead of thousands). */
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [shown, setShown] = useState(selected);
  const ref = useRef<HTMLUListElement>(null);
  // A topic selected from elsewhere (just created, picked in its domain's list) opens its domain.
  if (shown !== selected) {
    setShown(selected);
    const pick = topics.find((t) => resourceId(t.name) === selected);
    const dom = pick?.kind === "TOPIC" ? (pick.parentTopic ?? "") : "";
    if (dom && closed[dom] !== false) setClosed((c) => ({ ...c, [dom]: false }));
  }
  const needle = fold(q).trim();
  // Search matches names, keywords and synonyms (IDs are internal).
  const hit = (t: Topic) => (!needle || [t.displayName ?? "", ...(t.keywords ?? []), ...(t.synonyms ?? [])].some((s) => fold(s).includes(needle))) && (!bare || isBare(t));
  const domains = activeDomains(topics);
  const looks = useMemo(() => topicLooks(topics), [topics]);
  const lookOf = (t: Topic) => topicToneProps(looks.get(t.name ?? ""));
  const tile = (t: Topic) => {
    const { style, Icon } = lookOf(t);
    return (
      <span className="tx-row__tile" style={style} aria-hidden="true">
        <Icon className="i" />
      </span>
    );
  };
  const glyph = (t: Topic) => {
    const { style, Icon } = lookOf(t);
    return (
      <span className="tx-row__glyph" style={style} aria-hidden="true">
        <Icon className="i" />
      </span>
    );
  };
  const muted = (t: Topic) => {
    const { Icon } = lookOf(t);
    return <Icon className="i tx-row__icon tx-row__icon--topic" aria-hidden />;
  };
  const id = (t: Topic) => resourceId(t.name);
  const picked = topics.find((t) => resourceId(t.name) === selected);
  const pickedDomain = picked?.kind === "TOPIC" ? (picked.parentTopic ?? "") : (picked?.name ?? "");
  const isClosed = (domain: string) => closed[domain] ?? domain !== pickedDomain;
  const dot = (key: string) => (dirty(key) ? <span className="tx-row__dot" role="img" aria-label="Thay đổi chưa lưu" title="Thay đổi chưa lưu" /> : null);
  // A topic with no words to recognise it by: a hollow ring (its fix: add keywords in its detail).
  const warn = (t: Topic) => (isBare(t) ? <span className="tx-row__warn" role="img" aria-label={NO_KEYWORDS} title={NO_KEYWORDS} /> : null);
  const count = (n: number) => <span className="tx-row__count">{n ? fmtNum(n) : ""}</span>;
  const name = (s: string, domain = false) => (
    <span className={`tx-row__name${domain ? " tx-row__name--domain" : ""}`} translate="no" title={s}>
      {s}
    </span>
  );
  const chev = (open: boolean, toggle: () => void) => (
    <span
      className="tx-row__chev"
      aria-hidden="true"
      onClick={(e) => {
        e.stopPropagation();
        toggle();
      }}
    >
      {open ? <ChevronDown className="i i-sm" /> : <ChevronRight className="i i-sm" />}
    </span>
  );
  const noChev = <span className="tx-row__chev tx-row__chev--none" aria-hidden="true" />;

  const items: TreeItem[] = [];
  for (const dm of domains) {
    const all = topicsOf(topics, dm.name ?? "");
    const domHit = !bare && hit(dm);
    const kids = domHit ? all : all.filter(hit);
    if ((needle || bare) && !domHit && !kids.length) continue;
    const open = needle || bare ? true : !isClosed(dm.name ?? "");
    const addLabel = `Thêm chủ đề vào ${dm.displayName}`;
    items.push({
      id: id(dm),
      level: 1,
      expanded: open,
      inner: (
        <>
          {chev(open, () => setClosed((c) => ({ ...c, [dm.name ?? ""]: !isClosed(dm.name ?? "") })))}
          {tile(dm)}
          {name(dm.displayName ?? "", true)}
          <span className="tx-row__trail">
            {dot(id(dm))}
            {count(counts.published(dm.name ?? ""))}
            <button
              type="button"
              className="tx-row__add"
              tabIndex={-1}
              aria-label={addLabel}
              title={addLabel}
              onClick={(e) => {
                e.stopPropagation();
                onNew("topic", dm.name);
              }}
            >
              <Plus className="i i-sm" aria-hidden />
            </button>
          </span>
        </>
      ),
      children: open
        ? kids.map<TreeItem>((t) => ({
            id: id(t),
            level: 2,
            inner: (
              <>
                {noChev}
                {glyph(t)}
                {name(t.displayName ?? "")}
                <span className="tx-row__trail">
                  {warn(t)}
                  {dot(id(t))}
                  {count(counts.published(t.name ?? ""))}
                </span>
              </>
            ),
          }))
        : [],
    });
  }
  const archived = topics.filter((t) => t.state === "DELETED" && (t.kind === "DOMAIN" || topics.some((d) => d.name === t.parentTopic)));
  if (archived.length && !needle && !bare) {
    items.push({
      id: ARCHIVED,
      level: 1,
      expanded: archivedOpen,
      cls: "tx-item--archived",
      inner: (
        <>
          {chev(archivedOpen, () => setArchivedOpen((o) => !o))}
          <Archive className="i tx-row__icon" aria-hidden />
          <span className="tx-row__name muted">{`Đã lưu trữ (${archived.length})`}</span>
        </>
      ),
      children: archivedOpen
        ? archived.map<TreeItem>((t) => ({
            id: id(t),
            level: 2,
            inner: (
              <>
                {noChev}
                {muted(t)}
                {name(t.displayName ?? "")}
              </>
            ),
          }))
        : [],
    });
  }

  const flat = items.flatMap((x) => [x.id, ...(x.children ?? []).map((c) => c.id)]);
  const focusId = flat.includes(selected) ? selected : flat[0];
  const select = (key: string) => (key === ARCHIVED ? setArchivedOpen((o) => !o) : onSelect(key));
  const toggle = (key: string, close?: boolean) => {
    if (key === ARCHIVED) setArchivedOpen((o) => (close == null ? !o : !close));
    else {
      const dm = domains.find((d) => id(d) === key);
      if (dm) setClosed((c) => ({ ...c, [dm.name ?? ""]: close == null ? !isClosed(dm.name ?? "") : close }));
    }
  };

  /** Tree keyboard: ↑↓ Home End move, → opens or enters a domain, ← closes it or goes to the parent, Enter/Space selects. */
  const onKeyDown = (e: KeyboardEvent<HTMLUListElement>) => {
    const it = (e.target as HTMLElement).closest<HTMLElement>('[role="treeitem"]');
    if (!it || e.target !== it || e.metaKey || e.ctrlKey || e.altKey) return;
    const all = Array.from(ref.current?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? []);
    const i = all.indexOf(it);
    const key = it.dataset.id ?? "";
    const exp = it.getAttribute("aria-expanded");
    const focus = (el: HTMLElement | null | undefined) => {
      if (!el) return;
      all.forEach((x) => (x.tabIndex = -1));
      el.tabIndex = 0;
      el.focus();
    };
    switch (e.key) {
      case "ArrowDown":
        focus(all[i + 1]);
        break;
      case "ArrowUp":
        focus(all[i - 1]);
        break;
      case "Home":
        focus(all[0]);
        break;
      case "End":
        focus(all.at(-1));
        break;
      case "ArrowRight":
        if (exp === "false") toggle(key, false);
        else if (exp === "true") focus(all[i + 1]);
        break;
      case "ArrowLeft":
        if (exp === "true") toggle(key, true);
        else focus(it.parentElement?.closest<HTMLElement>('[role="treeitem"]'));
        break;
      case "Enter":
      case " ":
        select(key);
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  const row = (x: TreeItem): ReactNode => (
    <li
      key={x.id}
      role="treeitem"
      id={`tx-n-${x.id}`}
      className={`tx-item${x.cls ? ` ${x.cls}` : ""}`}
      aria-level={x.level}
      aria-selected={x.id === selected}
      aria-expanded={x.expanded}
      tabIndex={x.id === focusId ? 0 : -1}
      data-id={x.id}
    >
      <div className={`tx-row${x.id === selected ? " is-selected" : ""}`} onClick={() => select(x.id)}>
        {x.inner}
      </div>
      {x.children?.length ? (
        <ul role="group" className="tx-group">
          {x.children.map(row)}
        </ul>
      ) : null}
    </li>
  );

  return (
    <div className="tx-side" id="tx-side">
      <div className="tx-side__tools">
        <SearchInput value={q} onChange={setQ} placeholder="Tìm chủ đề" label="Tìm chủ đề và từ khóa" fullWidth />
        <ActionsMenu
          label="Mới"
          icon={Plus}
          actions={[
            ...(domains.length ? [{ id: "topic", label: "Chủ đề mới", icon: Tag, onAction: () => onNew("topic") }] : []),
            { id: "domain", label: "Lĩnh vực mới", icon: FolderPlus, onAction: () => onNew("domain") },
          ]}
        />
      </div>
      {items.length ? (
        <ul role="tree" className="tx-tree" aria-label="Lĩnh vực và chủ đề" ref={ref} onKeyDown={onKeyDown}>
          {items.map(row)}
        </ul>
      ) : (
        <p className="tx-side__empty">{needle ? `Không có chủ đề nào khớp với “${q}”.` : "Mọi chủ đề đều đã có từ khóa."}</p>
      )}
    </div>
  );
}

/* ═══════════════ Detail ═══════════════ */

function Back({ onBack }: { onBack: () => void }) {
  return (
    <div className="tx-back">
      <Button variant="ghost" size="sm" onPress={onBack}>
        <ArrowLeft className="i" aria-hidden />
        Tất cả chủ đề
      </Button>
    </div>
  );
}

/** "12 published · 2 in review": published links to Browse, in review to Documents → Review. */
function CountLinks({ topic, pub, rv }: { topic: string; pub: number; rv: number }) {
  return (
    <>
      {pub ? (
        <NextLink className="link" href={catalogHref({ filters: { topic: [resourceId(topic)] } })}>
          {`${fmtNum(pub)} đã công bố`}
        </NextLink>
      ) : (
        <span>Chưa được dùng</span>
      )}
      {rv ? (
        <>
          <span className="muted" aria-hidden="true">
            {" "}
            ·{" "}
          </span>
          <NextLink className="link tx-review" href={docsHref("review")}>
            {`${fmtNum(rv)} đang chờ duyệt`}
          </NextLink>
        </>
      ) : null}
    </>
  );
}

interface NodeDetailProps {
  topic: Topic | null;
  topics: readonly Topic[];
  counts: TopicCounts;
  draft: Draft | null;
  dirty: boolean;
  setDraft: (patch: Partial<Draft>) => void;
  dropDraft: () => void;
  onSelect: (id: string) => void;
  onNew: (kind: "domain" | "topic", parent?: string) => void;
  /** "Fine-tune classification" expanded. */
  advOpen: boolean;
  onAdvOpen: (open: boolean) => void;
}

function NodeDetail(p: NodeDetailProps) {
  const { id: ws } = useWorkspace();
  const invalidate = useInvalidateCuration();
  const remember = useRememberTopic();
  const ruleOptions = useRuleOptions();
  const [saving, setSaving] = useState(false);
  const advId = useId();
  const { topic: t, draft: f, topics, counts } = p;
  const back = <Back onBack={() => p.onSelect("")} />;
  const fail = (error: unknown) => {
    invalidate();
    toast(errorMessage(error), { tone: "danger" });
  };

  if (!f || !t) {
    return (
      <div className="tx-detail">
        {back}
        <EmptyState icon={Tag} title="Chọn một chủ đề" description="Chọn một lĩnh vực hoặc chủ đề trong danh sách để xem và chỉnh sửa." compact />
      </div>
    );
  }

  if (t.state === "DELETED") {
    const parent = topics.find((d) => d.name === t.parentTopic);
    const restore = async () => {
      if (parent?.state === "DELETED") {
        toast(`Hãy khôi phục ${parent.displayName} trước: lĩnh vực của chủ đề này đã được lưu trữ.`, { tone: "accent" });
        return;
      }
      try {
        await undeleteTopic(ws, t.name ?? "");
        invalidate();
        toast(`Đã khôi phục “${t.displayName}”`, { undo: () => void deleteTopic(ws, t.name ?? "").then(invalidate, fail) });
      } catch (error) {
        fail(error);
      }
    };
    return (
      <div className="tx-detail">
        {back}
        <header className="tx-head">
          <div className="tx-head__main">
            <div className="tx-head__title-row">
              <h2 className="tx-head__title" translate="no">
                {t.displayName}
              </h2>
              <StatusChip label="Đã lưu trữ" size="sm" dot={false} />
            </div>
            <p className="tx-head__meta">
              {parent ? (
                <>
                  <span translate="no">{parent.displayName}</span>
                  <span className="muted" aria-hidden="true">
                    {" "}
                    ·{" "}
                  </span>
                </>
              ) : null}
              <span>Ẩn khỏi Tra cứu và khỏi việc phân loại. Tài liệu vẫn giữ chủ đề này cho đến khi được gắn chủ đề khác.</span>
            </p>
          </div>
          <div className="tx-head__acts">
            <Button variant="secondary" size="sm" onPress={() => void restore()}>
              <Undo2 className="i" aria-hidden />
              Khôi phục
            </Button>
          </div>
        </header>
        {t.description ? (
          <Sec title="Mô tả">
            <p className="tx-text">{t.description}</p>
          </Sec>
        ) : null}
      </div>
    );
  }

  const isDomain = t.kind === "DOMAIN";
  const domains = activeDomains(topics);
  const parentName = (name: string) => topics.find((d) => d.name === name)?.displayName ?? "";
  const kids = isDomain ? topicsOf(topics, t.name ?? "") : [];

  // The signals as they'd be saved: words still typed in the keyword input count.
  const terms = withTyped(f, f.keywordsIn);
  const guidance = cleanBlock(f.guidance);
  const rules = rulesToApi(f.rules);
  /** The topic as edited, for the test box (unsaved changes only). */
  const edited: Topic | null = !isDomain && p.dirty ? { name: t.name, displayName: t.displayName, keywords: terms.keywords, synonyms: terms.synonyms, guidance, examples: f.examples, rules } : null;

  /** Applies a name, domain, icon or color change at once, with Undo. The draft (description, signals) is left as it is. */
  const applyNow = async (patch: Pick<TopicPatch, "displayName" | "parentTopic" | "icon" | "color">, message: string) => {
    const before = Object.fromEntries((Object.keys(patch) as (keyof typeof patch)[]).map((k) => [k, t[k] ?? ""])) as TopicPatch;
    try {
      const saved = await updateTopic(ws, t, patch);
      remember(saved);
      invalidate();
      toast(message, { undo: () => void updateTopic(ws, saved, before).then(invalidate, fail) });
    } catch (error) {
      fail(error);
    }
  };
  /** Click-to-edit title: a name the domain (or the workspace, for a domain) already has keeps the field open. */
  const rename = async (name: string) => {
    if (nameTaken(topics, name, isDomain ? null : (t.parentTopic ?? ""), t.name)) return isDomain ? `Lĩnh vực “${name}” đã tồn tại.` : `${parentName(t.parentTopic ?? "")} đã có “${name}”.`;
    await applyNow({ displayName: name }, `Đã đổi tên thành “${name}”`);
  };
  const move = (domain: string) => {
    if (domain === t.parentTopic) return;
    const name = t.displayName ?? "";
    if (nameTaken(topics, name, domain, t.name)) {
      toast(`${parentName(domain)} đã có “${name}”.`, { tone: "accent" });
      return;
    }
    void applyNow({ parentTopic: domain }, `Đã di chuyển “${name}” đến ${parentName(domain)}`);
  };

  const save = async () => {
    if (!isDomain) p.setDraft({ keywords: terms.keywords, keywordsIn: "" });
    setSaving(true);
    try {
      const before: TopicPatch = {
        description: t.description ?? "",
        keywords: t.keywords ?? [],
        synonyms: t.synonyms ?? [],
        guidance: t.guidance ?? "",
        examples: t.examples ?? [],
        rules: t.rules ?? [],
      };
      const after: TopicPatch = isDomain
        ? { description: f.desc.trim() }
        : { description: f.desc.trim(), keywords: terms.keywords, synonyms: terms.synonyms, guidance, examples: f.examples, rules };
      // Only what changed goes (`updateMask`); lists compare in order, and emptied ones are sent to clear them.
      const changed = (Object.keys(after) as (keyof TopicPatch)[]).filter((k) => JSON.stringify(after[k]) !== JSON.stringify(before[k]));
      if (!changed.length) {
        p.dropDraft();
        return;
      }
      const patch = Object.fromEntries(changed.map((k) => [k, after[k]])) as TopicPatch;
      const saved = await updateTopic(ws, t, patch);
      remember(saved);
      p.dropDraft();
      invalidate();
      const revert = Object.fromEntries(changed.map((k) => [k, before[k]])) as TopicPatch;
      toast(`Đã lưu “${t.displayName}”`, { undo: () => void updateTopic(ws, saved, revert).then(invalidate, fail) });
    } catch (error) {
      toast(errorMessage(error), { tone: "danger" });
    } finally {
      setSaving(false);
    }
  };

  /** Archive acts at once with Undo; while documents or topics still use it, it says what to do first instead. */
  const archive = async () => {
    const used = counts.published(t.name ?? "") + counts.review(t.name ?? "") + (isDomain ? kids.length : 0);
    if (used) {
      toast(isDomain ? `“${t.displayName}” vẫn còn chủ đề hoặc tài liệu. Hãy chuyển hoặc lưu trữ chúng trước.` : `Tài liệu đang dùng “${t.displayName}”. Hãy gắn lại chủ đề cho chúng trước, rồi lưu trữ.`, { tone: "accent" });
      return;
    }
    try {
      await deleteTopic(ws, t.name ?? "");
      p.dropDraft();
      invalidate();
      p.onSelect(isDomain ? "" : resourceId(t.parentTopic));
      toast(`Đã lưu trữ “${t.displayName}”`, {
        undo: () =>
          void undeleteTopic(ws, t.name ?? "").then(() => {
            invalidate();
            p.onSelect(resourceId(t.name));
          }, fail),
      });
    } catch (error) {
      fail(error);
    }
  };

  // The header changes the node's identity in place: its icon tile opens the icon grid, the name is click-to-edit, a
  // topic's domain is a menu that moves it, Archive is one icon. Each applies at once with Undo: no form, no save bar.
  const look = topicLooks(topics).get(t.name ?? "");
  const where = isDomain ? (
    <span>{plural(kids.length, "topic")}</span>
  ) : (
    <Dropdown>
      <Button variant="ghost" size="sm" className="tx-head__domain">
        <span translate="no">{parentName(t.parentTopic ?? "")}</span>
        <ChevronDown className="i i-xs" aria-hidden />
      </Button>
      <Dropdown.Popover placement="bottom start">
        <Dropdown.Menu aria-label="Chuyển đến lĩnh vực" selectionMode="single" selectedKeys={[t.parentTopic ?? ""]} onAction={(key) => move(String(key))}>
          <Dropdown.Section>
            <Header>Chuyển đến lĩnh vực</Header>
            {domains.map((d) => (
              <Dropdown.Item key={d.name} id={d.name ?? ""} textValue={d.displayName}>
                <Folder className="i" aria-hidden />
                <Label translate="no">{d.displayName}</Label>
                <Dropdown.ItemIndicator />
              </Dropdown.Item>
            ))}
          </Dropdown.Section>
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
  const head = (
    <header className="tx-head">
      <IconPicker
        shown={look?.icon}
        color={look?.color ?? ""}
        value={t.icon || (isDomain ? DOMAIN_ICON : "")}
        onPick={(icon) => {
          if (icon !== (t.icon ?? "")) void applyNow({ icon }, "Đã đổi biểu tượng");
        }}
        onReset={!isDomain && t.icon ? () => void applyNow({ icon: "" }, "Đã chuyển về biểu tượng của lĩnh vực") : undefined}
      />
      <div className="tx-head__main">
        <EditableTitle value={t.displayName ?? ""} onCommit={rename} label={isDomain ? "Đổi tên lĩnh vực" : "Đổi tên chủ đề"} className="tx-head__title" maxLength={60} />
        <p className="tx-head__meta">
          {where}
          <span className="muted" aria-hidden="true">
            {" "}
            ·{" "}
          </span>
          <CountLinks topic={t.name ?? ""} pub={counts.published(t.name ?? "")} rv={counts.review(t.name ?? "")} />
        </p>
      </div>
      <div className="tx-head__acts">
        <IconButton icon={Archive} tip={isDomain ? "Lưu trữ lĩnh vực" : "Lưu trữ chủ đề"} onPress={() => void archive()} />
      </div>
    </header>
  );

  const desc = (
    <Sec title="Mô tả" desc={isDomain ? "Hiển thị trên thẻ chủ đề ở Trang chủ." : "Mọi người thấy khi chọn chủ đề; trợ lý đọc khi phân loại."}>
      <TextField value={f.desc} onChange={(v) => p.setDraft({ desc: v })} maxLength={300} aria-label="Mô tả">
        <TextArea rows={2} placeholder={isDomain ? "Lĩnh vực này nhóm những gì, trong một câu" : "Chủ đề này bao gồm những gì, theo cách nói của doanh nghiệp bạn"} />
      </TextField>
    </Sec>
  );
  // A domain's color: its topics, their tags and Browse's pills use it too.
  const colorSec = (
    <Sec title="Màu" desc="Các chủ đề của lĩnh vực cũng dùng màu này: trong danh sách này, trên thẻ tài liệu và trong Tra cứu.">
      <DomainColorPicker
        value={t.color ?? ""}
        onChange={(color) => {
          if (color !== (t.color ?? "").toLowerCase()) void applyNow({ color }, "Đã đổi màu");
        }}
      />
    </Sec>
  );

  // "Fine-tune classification (optional)": what the assistant reads (guidance, examples) and rules that skip it, behind
  // one disclosure; closed, it says what's set.
  const advSet = [guidance ? "Hướng dẫn" : "", f.examples.length ? plural(f.examples.length, "example") : "", rules.length ? plural(rules.length, "rule") : ""].filter(Boolean);
  const adv = (
    <section className={`tx-adv${p.advOpen ? " is-open" : ""}`}>
      <h3 className="tx-adv__h">
        <button type="button" className="tx-adv__toggle" aria-expanded={p.advOpen} aria-controls={advId} onClick={() => p.onAdvOpen(!p.advOpen)}>
          {p.advOpen ? <ChevronDown className="i i-sm tx-adv__chev" aria-hidden /> : <ChevronRight className="i i-sm tx-adv__chev" aria-hidden />}
          <span className="tx-adv__title">
            Tinh chỉnh phân loại<span className="label__opt">(không bắt buộc)</span>
          </span>
          {p.advOpen ? null : <span className="tx-adv__sum">{(advSet.length ? advSet : ["Chưa thiết lập"]).join(" · ")}</span>}
        </button>
      </h3>
      {p.advOpen ? (
        <div className="tx-adv__body" id={advId}>
          <Sec title="Hướng dẫn" desc="Khi nào Trợ lý nên dùng chủ đề này, và nội dung nào thuộc chỗ khác.">
            <TextField value={f.guidance} onChange={(v) => p.setDraft({ guidance: v })} maxLength={GUIDANCE_MAX} aria-label="Hướng dẫn">
              <TextArea rows={3} placeholder={"Dùng cho…\nKhông dùng cho…"} />
            </TextField>
          </Sec>
          <ExamplesEditor topic={t.name ?? null} examples={f.examples} onChange={(next) => p.setDraft({ examples: next })} />
          <RulesEditor rules={f.rules} options={ruleOptions} onChange={(next) => p.setDraft({ rules: next })} />
        </div>
      ) : null}
    </section>
  );

  const topicsSec = (
    <Sec
      title="Chủ đề"
      aside={
        <Button variant="ghost" size="sm" onPress={() => p.onNew("topic", t.name)}>
          <Plus className="i" aria-hidden />
          Thêm chủ đề
        </Button>
      }
    >
      {kids.length ? (
        <ul className="tx-trows">
          {kids.map((k) => {
            const kw = (k.keywords?.length ?? 0) + (k.synonyms?.length ?? 0);
            return (
              <li key={k.name}>
                <button type="button" className="tx-trow" onClick={() => p.onSelect(resourceId(k.name))}>
                  <span className="tx-trow__name truncate" translate="no">
                    {k.displayName}
                  </span>
                  <span className={`tx-trow__kw${kw ? "" : " is-warn"}`}>{kw ? plural(kw, "keyword") : "Chưa có từ khóa"}</span>
                  <span className="tx-trow__n">{`${fmtNum(counts.published(k.name ?? ""))} đã công bố`}</span>
                  <ChevronRight className="i i-sm muted" aria-hidden />
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="tx-sec__empty">Chưa có chủ đề.</p>
      )}
    </Sec>
  );

  return (
    <div className="tx-detail">
      {back}
      {head}
      {/* A topic's job is to recognise documents, so its words lead; what fine-tunes classification waits behind one disclosure. */}
      {isDomain ? (
        <>
          {desc}
          {colorSec}
          {topicsSec}
        </>
      ) : (
        <>
          <TermsEditor value={f} onChange={p.setDraft} />
          {desc}
          {adv}
          <Distribution topic={t} counts={counts} />
          <TestClassification topic={t} draft={edited} topics={topics} options={ruleOptions} />
        </>
      )}
      <SaveBar isDirty={p.dirty} isSaving={saving} onSave={() => void save()} onDiscard={p.dropDraft} message="Thay đổi chưa lưu" saveLabel="Lưu" />
    </div>
  );
}

/** How a topic's published documents spread over the collections the caller looks after (one count per collection,
 *  read for the open topic only), and what's still waiting: documents a first sync tagged with it that nobody
 *  confirmed yet (Topics → Suggestions) and submissions in review. */
function Distribution({ topic: t, counts }: { topic: Topic; counts: TopicCounts }) {
  const name = t.name ?? "";
  const docScope = useDocScope();
  const perBase = useCounts(docScope.bases.map((b) => ({ of: "items", filter: publishedWithTopic(b.name ?? "", name) })));
  const rows = docScope.bases
    .map((base, i) => ({ base, n: perBase.data[i] ?? 0 }))
    .filter((r) => r.n > 0)
    .sort((a, b) => b.n - a.n);
  const max = rows[0]?.n || 1;
  const total = rows.reduce((a, r) => a + r.n, 0);
  const rv = counts.review(name);
  const confirm = useAssistantTaggedCounts(docScope.scope).data?.get(name) ?? 0;
  return (
    <Sec title="Phân bổ" aside={rows.length ? <span className="tx-sec__meta">{`${plural(total, "tài liệu đã công bố")} · ${plural(rows.length, "collection")}`}</span> : undefined}>
      {rows.length ? (
        <ul className="tx-dist">
          {rows.map(({ base, n }) => (
            <li key={base.name} className="tx-dist__row">
              <NextLink className="tx-dist__name link truncate" href={catalogHref({ filters: { topic: [resourceId(name)], kb: [resourceId(base.name)] } })} translate="no">
                {base.displayName}
              </NextLink>
              <span className="tx-dist__bar" aria-hidden="true">
                <span style={{ width: `${Math.max(3, Math.round((n / max) * 100))}%` }} />
              </span>
              <span className="tx-dist__n">{fmtNum(n)}</span>
            </li>
          ))}
        </ul>
      ) : docScope.isPending || perBase.isPending ? null : (
        <p className="tx-sec__empty">Chưa có tài liệu đã công bố.</p>
      )}
      {confirm || rv ? (
        <p className="tx-dist__pending">
          <Clock className="i i-sm" aria-hidden />
          <span>
            {confirm ? <NextLink className="link" href={topicsHref("suggestions")}>{`${fmtNum(confirm)} cần xác nhận từ lần đồng bộ đầu tiên`}</NextLink> : null}
            {confirm && rv ? (
              <span className="muted" aria-hidden="true">
                {" · "}
              </span>
            ) : null}
            {rv ? <NextLink className="link" href={docsHref("review")}>{`${fmtNum(rv)} đang chờ duyệt`}</NextLink> : null}
          </span>
        </p>
      ) : null}
    </Sec>
  );
}
