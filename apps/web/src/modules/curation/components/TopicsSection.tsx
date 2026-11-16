"use client";

import { Button, Description, FieldError, Input, Label, TextArea, TextField } from "@heroui/react";
import { Archive, ArrowLeft, ChevronDown, ChevronRight, Clock, Code, Database, Download, FolderPlus, Lock, Pencil, Plus, Table, Tag, Undo2, Upload } from "lucide-react";
import NextLink from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import { EmptyState, ErrorState, PageHeader, SaveBar, SearchInput, SectionTabs, SkeletonRows, StatusChip, toast } from "@/components/ui";
import { errorMessage, resourceId } from "@/lib/api/client";
import { fmtNum, plural } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";
import { catalogHref, fold, type Resource } from "@/modules/knowledge/model";

import { createTopic, deleteTopic, undeleteTopic, updateTopic, type Topic, type TopicPatch } from "../api";
import { activeDomains, cleanName, distribution, nameTaken, topicCounts, topicsOf, type TopicCounts } from "../governance";
import { docsHref, topicsHref } from "../model";
import { useHeldDecisions } from "../decisions";
import { useAllTopics, useCurationPool, useInvalidateCuration, useRememberTopic, useReviewQueue } from "../queries";
import { exportRows, TEMPLATE_ROWS } from "../topicSheet";
import { DemoChip, PlainSelect } from "./parts";
import { ActionsMenu, saveCsv } from "./shared";
import { ImportDialog } from "./topics/ImportDialog";
import { PromptDrawer } from "./topics/PromptDrawer";
import { TestClassification } from "./topics/TestClassification";
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

const NEW = "__new";
const ARCHIVED = "__archived";

/** Topics' views (`?view=`): the tree and what the assistant and reviewers suggest. */
const VIEWS = [
  ["topics", "Topics"],
  ["suggestions", "Suggestions"],
] as const;

/** A node's working copy (one per node, one save bar): its fields, its signals and what's typed in the chip inputs. */
interface Draft extends TermsDraft {
  name: string;
  parent: string;
  desc: string;
  guidance: string;
  rules: RuleDraft[];
  /** Example document item names. */
  examples: string[];
  /** New nodes: the code to create it with (its topic ID); empty = one is made. */
  code: string;
  /** New nodes: a domain rather than a topic. */
  domain?: boolean;
  /** Name (and domain) fields open. */
  ident: boolean;
  tried: boolean;
}

const valuesOf = (t: Topic): Draft => ({
  name: t.displayName ?? "",
  parent: t.parentTopic ?? "",
  desc: t.description ?? "",
  guidance: t.guidance ?? "",
  keywords: [...(t.keywords ?? [])],
  synonyms: [...(t.synonyms ?? [])],
  rules: rulesOf(t),
  examples: [...(t.examples ?? [])],
  keywordsIn: "",
  synonymsIn: "",
  code: "",
  ident: false,
  tried: false,
});
/** Same entries in the same order. */
const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
/** `b` is a saved node's values; anything typed in a chip input counts as a change (saving adds it). */
const sameValues = (a: Draft, b: Draft) =>
  cleanName(a.name) === cleanName(b.name) &&
  a.parent === b.parent &&
  a.desc.trim() === b.desc.trim() &&
  cleanBlock(a.guidance) === cleanBlock(b.guidance) &&
  sameList(a.keywords, b.keywords) &&
  sameList(a.synonyms, b.synonyms) &&
  sameList(a.examples, b.examples) &&
  JSON.stringify(a.rules) === JSON.stringify(b.rules) &&
  !a.keywordsIn.trim() &&
  !a.synonymsIn.trim();

/** A topic the assistant can only match by name: no keywords and no synonyms. Filling these in is the main upkeep. */
const isBare = (t: Topic) => t.kind === "TOPIC" && !t.keywords?.length && !t.synonyms?.length;

/** Topic ID pattern (openapi `TopicId`): the code a new topic may be created with. */
const CODE_RE = /^[a-z][a-z0-9-]{0,62}$/;

/**
 * Knowledge Studio → Topics (preview `X.md.tab`, workspace admins): what documents are about, in two views as page
 * tabs (`?view=`). Topics: a summary line (counts; topics without keywords narrow the tree, `?show=bare`; ⋯ shows the
 * classification prompt, exports) and the tree (search over names, codes and keywords, domains with their topics and
 * counts, archived last; keyboard navigable) beside the selected node's detail (`?node=`); its one action is Import
 * (`?import=1` opens it). Suggestions: topics the assistant proposes, keywords from reviewers' corrections, topics to
 * confirm and documents without a topic; its tab counts the proposals (the sidebar badge's number).
 */
export function TopicsSection() {
  const { can, workspace } = useWorkspace();
  const admin = can("topics.update");
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const topics = useAllTopics({ enabled: admin });
  const queue = useReviewQueue({ enabled: admin });
  const pool = useCurationPool({ enabled: admin });
  const held = useHeldDecisions();
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [importing, setImporting] = useState(false);
  const [promptOpen, setPromptOpen] = useState(false);
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
  const published = useMemo(() => pool.data?.pool ?? [], [pool.data]);
  const counts = useMemo(
    () =>
      topicCounts(
        all,
        published.map((r) => r.item),
        (queue.data ?? []).map((s) => [...(s.contribution.suggestions?.topics ?? []), ...(s.contribution.suggestions?.proposedTopics ?? [])]),
      ),
    [all, published, queue.data],
  );
  // A decision in its Undo window has left the list already.
  const proposals = all.filter((t) => t.state === "PROPOSED" && !held.has(t.name ?? ""));

  const header = (
    <PageHeader
      title="Topics"
      chips={<DemoChip />}
      actions={
        admin && view === "topics" ? (
          <Button variant="primary" onPress={() => setImporting(true)}>
            <Upload className="i" aria-hidden />
            Import
          </Button>
        ) : null
      }
    >
      {admin ? (
        <SectionTabs
          items={VIEWS.map(([id, label]) => ({ id, label, href: topicsHref(id), count: id === "suggestions" ? proposals.length || null : null }))}
          active={view}
          label="Topics views"
        />
      ) : null}
    </PageHeader>
  );

  if (!admin) {
    return (
      <>
        {header}
        <EmptyState icon={Lock} title="Only workspace admins change the topics" boxed />
      </>
    );
  }
  if (!topics.data) {
    return (
      <>
        {header}
        {topics.isError ? <ErrorState title="The topics didn’t load" error={topics.error} onRetry={() => void topics.refetch()} /> : <SkeletonRows rows={6} />}
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

  const domains = activeDomains(all);
  const liveTopics = all.filter((t) => t.kind === "TOPIC" && t.state === "ACTIVE" && domains.some((d) => d.name === t.parentTopic));
  const bareCount = liveTopics.filter(isBare).length;
  const bare = params.get("show") === "bare";
  const picked = params.get("node") ?? "";
  const byId = (id: string) => all.find((t) => resourceId(t.name) === id);
  const resolve = (): string => {
    if (picked === NEW) return drafts[NEW] ? NEW : resourceId(domains[0]?.name);
    if (picked && byId(picked) && byId(picked)?.state !== "PROPOSED" && byId(picked)?.state !== "REJECTED") return picked;
    // Narrowed to topics without keywords: the first of them, ready to fill in.
    return resourceId(((bare && liveTopics.find(isBare)) || domains[0])?.name);
  };
  const node = resolve();
  const exportName = `${fold(workspace.displayName ?? "workspace").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}-topics.csv`;

  const startNew = (kind: "domain" | "topic", parent = "") => {
    setDrafts((d) => ({
      ...d,
      [NEW]: {
        name: "",
        parent: kind === "domain" ? "" : parent || domains[0]?.name || "",
        desc: "",
        guidance: "",
        keywords: [],
        synonyms: [],
        rules: [],
        examples: [],
        keywordsIn: "",
        synonymsIn: "",
        code: "",
        domain: kind === "domain",
        ident: true,
        tried: false,
      },
    }));
    setQuery({ node: NEW });
  };

  const keywordCount = liveTopics.reduce((a, t) => a + (t.keywords?.length ?? 0), 0);
  const summary = (
    <div className="tx-sum">
      <p className="tx-sum__text">
        <span className="medium">{`${plural(domains.length, "domain")} · ${plural(liveTopics.length, "topic")} · ${plural(keywordCount, "keyword")}`}</span>
        {bareCount || bare ? (
          <>
            <span className="muted" aria-hidden="true">
              {" · "}
            </span>
            <button
              type="button"
              className="tx-sum__warn"
              aria-pressed={bare}
              title={bare ? "Show every topic" : "The assistant matches them by name only. Show just these."}
              onClick={() => setQuery({ show: bare ? "" : "bare" })}
            >
              {`${plural(bareCount, "topic")} without keywords`}
            </button>
          </>
        ) : null}
      </p>
      <ActionsMenu
        label="More topics actions"
        actions={[
          { id: "prompt", label: "Show the classification prompt", icon: Code, onAction: () => setPromptOpen(true) },
          { id: "export", label: "Export topics", icon: Download, separated: true, onAction: () => saveCsv(exportName, exportRows(all)) },
          { id: "template", label: "Download template", icon: Table, onAction: () => saveCsv("topics-template.csv", TEMPLATE_ROWS) },
        ]}
      />
    </div>
  );
  const prompt = <PromptDrawer isOpen={promptOpen} onClose={() => setPromptOpen(false)} topics={all} />;

  if (!domains.length && !drafts[NEW]) {
    return (
      <>
        {header}
        <div className="tx">
          {summary}
          <EmptyState
            icon={Database}
            title="No topics yet"
            description="Import your topics from a spreadsheet (Import, above), or add the first domain here."
            boxed
            actions={
              <Button variant="secondary" onPress={() => startNew("domain")}>
                <Plus className="i" aria-hidden />
                Add domain
              </Button>
            }
          />
        </div>
        <ImportDialog isOpen={importOpen} onClose={closeImport} topics={all} />
        {prompt}
      </>
    );
  }

  const draftOf = (key: string): Draft | null => {
    if (key === NEW) return drafts[NEW] ?? null;
    const t = byId(key);
    if (!t) return null;
    return drafts[key] ?? valuesOf(t);
  };
  const isDirty = (key: string) => {
    if (key === NEW) return !!drafts[NEW];
    const t = byId(key);
    return !!t && !!drafts[key] && !sameValues(drafts[key], valuesOf(t));
  };
  // Merges onto the latest draft, so several patches in one event all land.
  const setDraft = (key: string, patch: Partial<Draft>) => {
    const t = key === NEW ? null : byId(key);
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
            newDraft={drafts[NEW] ?? null}
            bare={bare}
            onSelect={(id) => setQuery({ node: id })}
            onAdd={startNew}
          />
          <div className="tx-main">
            <NodeDetail
              key={node}
              nodeKey={node}
              topic={node === NEW ? null : (byId(node) ?? null)}
              topics={all}
              counts={counts}
              published={published}
              draft={draftOf(node)}
              dirty={isDirty(node)}
              setDraft={(patch) => setDraft(node, patch)}
              dropDraft={() => dropDraft(node)}
              onSelect={(id) => setQuery({ node: id })}
              onAdd={startNew}
            />
          </div>
        </div>
      </div>
      <ImportDialog isOpen={importOpen} onClose={closeImport} topics={all} />
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

function TopicTree({
  topics,
  counts,
  selected,
  dirty,
  newDraft,
  bare,
  onSelect,
  onAdd,
}: {
  topics: readonly Topic[];
  counts: TopicCounts;
  selected: string;
  dirty: (key: string) => boolean;
  newDraft: Draft | null;
  /** Only topics without keywords (`?show=bare`). */
  bare: boolean;
  onSelect: (id: string) => void;
  onAdd: (kind: "domain" | "topic", parent?: string) => void;
}) {
  const [q, setQ] = useState("");
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  const [archivedOpen, setArchivedOpen] = useState(false);
  const ref = useRef<HTMLUListElement>(null);
  const needle = fold(q).trim();
  // Search matches names, codes, keywords and synonyms.
  const hit = (t: Topic) => (!needle || [t.displayName ?? "", resourceId(t.name), ...(t.keywords ?? []), ...(t.synonyms ?? [])].some((s) => fold(s).includes(needle))) && (!bare || isBare(t));
  const domains = activeDomains(topics);
  const id = (t: Topic) => resourceId(t.name);
  const dot = (key: string) => (dirty(key) ? <span className="tx-row__dot" role="img" aria-label="Unsaved changes" title="Unsaved changes" /> : null);
  // A topic with no words to recognise it by: a hollow ring (its fix: add keywords in its detail).
  const warn = (t: Topic) => (isBare(t) ? <span className="tx-row__warn" role="img" aria-label="No keywords" title="No keywords" /> : null);
  const code = (t: Topic) => (
    <span className="tx-row__code" translate="no" title={id(t)}>
      {id(t)}
    </span>
  );
  const count = (n: number) => <span className="tx-row__count">{n ? fmtNum(n) : ""}</span>;
  const chev = (key: string, open: boolean, toggle: () => void) => (
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
  const newItem = (level: 1 | 2): TreeItem => ({
    id: NEW,
    level,
    cls: "is-new",
    inner: (
      <>
        <span className="tx-row__code" translate="no">
          {newDraft?.code.trim().toLowerCase() || "—"}
        </span>
        <span className="tx-row__name">{cleanName(newDraft?.name ?? "") || (newDraft?.domain ? "New domain" : "New topic")}</span>
        {dot(NEW)}
      </>
    ),
  });

  const items: TreeItem[] = [];
  for (const dm of domains) {
    const all = topicsOf(topics, dm.name ?? "");
    const domHit = !bare && hit(dm);
    const kids = domHit ? all : all.filter(hit);
    const draftHere = !!newDraft && !newDraft.domain && newDraft.parent === dm.name;
    if ((needle || bare) && !domHit && !kids.length) continue;
    const open = needle || bare ? true : !closed[dm.name ?? ""];
    items.push({
      id: id(dm),
      level: 1,
      expanded: open,
      inner: (
        <>
          {chev(dm.name ?? "", open, () => setClosed((c) => ({ ...c, [dm.name ?? ""]: !c[dm.name ?? ""] })))}
          <span className="md-code md-code--domain" translate="no">
            {id(dm)}
          </span>
          <span className="tx-row__name tx-row__name--domain" translate="no">
            {dm.displayName}
          </span>
          {dot(id(dm))}
          {count(counts.domain(dm.name ?? ""))}
        </>
      ),
      children: open
        ? [
            ...kids.map<TreeItem>((t) => ({
              id: id(t),
              level: 2,
              inner: (
                <>
                  {code(t)}
                  <span className="tx-row__name" translate="no">
                    {t.displayName}
                  </span>
                  {warn(t)}
                  {dot(id(t))}
                  {count(counts.topic(t.name ?? ""))}
                </>
              ),
            })),
            ...(draftHere ? [newItem(2)] : []),
          ]
        : [],
    });
  }
  if (newDraft?.domain) items.push(newItem(1));
  const archived = topics.filter((t) => t.state === "DELETED" && (t.kind === "DOMAIN" || topics.some((d) => d.name === t.parentTopic)));
  if (archived.length && !needle && !bare) {
    items.push({
      id: ARCHIVED,
      level: 1,
      expanded: archivedOpen,
      cls: "tx-item--archived",
      inner: (
        <>
          {chev(ARCHIVED, archivedOpen, () => setArchivedOpen((o) => !o))}
          <Archive className="i i-sm tx-row__icon" aria-hidden />
          <span className="tx-row__name muted">{`Archived (${archived.length})`}</span>
        </>
      ),
      children: archivedOpen
        ? archived.map<TreeItem>((t) => ({
            id: id(t),
            level: 2,
            inner: (
              <>
                {code(t)}
                <span className="tx-row__name" translate="no">
                  {t.displayName}
                </span>
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
      if (dm) setClosed((c) => ({ ...c, [dm.name ?? ""]: close == null ? !c[dm.name ?? ""] : close }));
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

  const current = topics.find((t) => resourceId(t.name) === selected && t.state === "ACTIVE");
  const dm = current ? (current.kind === "TOPIC" ? topics.find((d) => d.name === current.parentTopic) : current) : domains[0];

  return (
    <div className="tx-side" id="tx-side">
      <div className="tx-side__tools">
        <SearchInput value={q} onChange={setQ} placeholder="Search topics and keywords" fullWidth />
        <ActionsMenu
          label="Add domain or topic"
          actions={[
            ...(dm ? [{ id: "topic", label: `Add topic to ${dm.displayName}`, icon: Tag, onAction: () => onAdd("topic", dm.name) }] : []),
            { id: "domain", label: "Add domain", icon: FolderPlus, onAction: () => onAdd("domain") },
          ]}
          icon={Plus}
        />
      </div>
      {items.length ? (
        <ul role="tree" className="tx-tree" aria-label="Domains and topics" ref={ref} onKeyDown={onKeyDown}>
          {items.map(row)}
        </ul>
      ) : (
        <p className="tx-side__empty">{needle ? `No topics match “${q}”.` : "Every topic has keywords."}</p>
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
        All topics
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
          {`${fmtNum(pub)} published`}
        </NextLink>
      ) : (
        <span>Not used yet</span>
      )}
      {rv ? (
        <>
          <span className="muted" aria-hidden="true">
            {" "}
            ·{" "}
          </span>
          <NextLink className="link tx-review" href={docsHref("review")}>
            {`${fmtNum(rv)} in review`}
          </NextLink>
        </>
      ) : null}
    </>
  );
}

interface NodeDetailProps {
  nodeKey: string;
  topic: Topic | null;
  topics: readonly Topic[];
  counts: TopicCounts;
  published: readonly Resource[];
  draft: Draft | null;
  dirty: boolean;
  setDraft: (patch: Partial<Draft>) => void;
  dropDraft: () => void;
  onSelect: (id: string) => void;
  onAdd: (kind: "domain" | "topic", parent?: string) => void;
}

function NodeDetail(p: NodeDetailProps) {
  const { id: ws } = useWorkspace();
  const invalidate = useInvalidateCuration();
  const remember = useRememberTopic();
  const ruleOptions = useRuleOptions();
  const [saving, setSaving] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  const { topic: t, draft: f, topics, counts } = p;
  const back = <Back onBack={() => p.onSelect("")} />;
  const fail = (error: unknown) => {
    invalidate();
    toast(errorMessage(error), { tone: "danger" });
  };

  if (!f || (!t && p.nodeKey !== NEW)) {
    return (
      <div className="tx-detail">
        {back}
        <EmptyState icon={Tag} title="Pick a topic" description="Choose a domain or topic in the list to see and edit it." compact />
      </div>
    );
  }

  if (t?.state === "DELETED") {
    const parent = topics.find((d) => d.name === t.parentTopic);
    const restore = async () => {
      if (parent?.state === "DELETED") {
        toast(`Restore ${parent.displayName} first: its domain is archived.`, { tone: "accent" });
        return;
      }
      try {
        await undeleteTopic(ws, t.name ?? "");
        invalidate();
        toast(`Restored “${t.displayName}”`, { undo: () => void deleteTopic(ws, t.name ?? "").then(invalidate, fail) });
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
              <span className="md-code md-code--domain" translate="no">
                {resourceId(t.name)}
              </span>
              <h2 className="tx-head__title" translate="no">
                {t.displayName}
              </h2>
              <StatusChip label="Archived" size="sm" dot={false} />
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
              <span>Hidden from Browse and from classification. Documents keep it until they’re retagged.</span>
            </p>
          </div>
          <div className="tx-head__acts">
            <Button variant="secondary" size="sm" onPress={() => void restore()}>
              <Undo2 className="i" aria-hidden />
              Restore
            </Button>
          </div>
        </header>
        {t.description ? (
          <Sec title="Description">
            <p className="tx-text">{t.description}</p>
          </Sec>
        ) : null}
      </div>
    );
  }

  const isNew = !t;
  const isDomain = t ? t.kind === "DOMAIN" : !!f.domain;
  const domains = activeDomains(topics);
  const parentName = (name: string) => topics.find((d) => d.name === name)?.displayName ?? "";
  const kids = t && isDomain ? topicsOf(topics, t.name ?? "") : [];

  // Validation (shown once Save was tried). A new node's code is optional: empty → the server makes one.
  const name = cleanName(f.name);
  const code = f.code.trim().toLowerCase();
  const err: { name?: string; code?: string; parent?: string } = {};
  if (!name) err.name = "Enter a name.";
  else if (nameTaken(topics, name, isDomain ? null : f.parent, t?.name)) err.name = isDomain ? `A domain called “${name}” already exists.` : `${parentName(f.parent)} already has “${name}”.`;
  if (isNew && code) {
    const taken = topics.find((x) => resourceId(x.name) === code);
    if (!CODE_RE.test(code)) err.code = "Use lowercase letters, numbers and dashes, starting with a letter.";
    else if (taken) err.code = `${code} is already used by “${taken.displayName}”.`;
  }
  if (!isDomain && !domains.some((d) => d.name === f.parent)) err.parent = "Choose a domain.";
  const shownErr = f.tried ? err : {};

  // The signals as they'd be saved: words still typed in the chip inputs count.
  const terms = withTyped(f, f);
  const guidance = cleanBlock(f.guidance);
  const rules = rulesToApi(f.rules);
  /** The topic as edited, for the test box (unsaved changes only). */
  const edited: Topic | null =
    t && !isDomain && p.dirty ? { name: t.name, displayName: name || t.displayName, keywords: terms.keywords, synonyms: terms.synonyms, guidance, examples: f.examples, rules } : null;

  const save = async () => {
    const typed = isDomain ? {} : { keywords: terms.keywords, synonyms: terms.synonyms, keywordsIn: "", synonymsIn: "" };
    if (Object.keys(err).length) {
      p.setDraft({ ...typed, tried: true, ident: true });
      // Validate on submit: the first invalid field takes focus (a renamed field mounts focused).
      if (err.name) requestAnimationFrame(() => nameRef.current?.focus());
      else if (err.code) requestAnimationFrame(() => codeRef.current?.focus());
      return;
    }
    p.setDraft({ ...typed, tried: true });
    setSaving(true);
    try {
      if (!t) {
        // Empty signals are left out.
        const signals = isDomain
          ? {}
          : {
              parentTopic: f.parent,
              keywords: terms.keywords.length ? terms.keywords : undefined,
              synonyms: terms.synonyms.length ? terms.synonyms : undefined,
              guidance: guidance || undefined,
              examples: f.examples.length ? f.examples : undefined,
              rules: rules.length ? rules : undefined,
            };
        const created = await createTopic(ws, { displayName: name, kind: isDomain ? "DOMAIN" : "TOPIC", description: f.desc.trim() || undefined, ...signals }, code || undefined);
        remember(created);
        p.dropDraft();
        invalidate();
        p.onSelect(resourceId(created.name));
        toast(isDomain ? `Added the domain “${name}”` : `Added “${name}” to ${parentName(f.parent)}`, { undo: () => void deleteTopic(ws, created.name ?? "").then(invalidate, fail) });
      } else {
        const before: Required<TopicPatch> = {
          displayName: t.displayName ?? "",
          description: t.description ?? "",
          parentTopic: t.parentTopic ?? "",
          keywords: t.keywords ?? [],
          synonyms: t.synonyms ?? [],
          guidance: t.guidance ?? "",
          examples: t.examples ?? [],
          rules: t.rules ?? [],
        };
        const after: TopicPatch = isDomain
          ? { displayName: name, description: f.desc.trim() }
          : { displayName: name, description: f.desc.trim(), parentTopic: f.parent, keywords: terms.keywords, synonyms: terms.synonyms, guidance, examples: f.examples, rules };
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
        toast(`Saved “${name}”`, { undo: () => void updateTopic(ws, saved, revert).then(invalidate, fail) });
      }
    } catch (error) {
      toast(errorMessage(error), { tone: "danger" });
    } finally {
      setSaving(false);
    }
  };

  /** Archive acts at once with Undo; while documents or topics still use it, it says what to do first instead. */
  const archive = async () => {
    if (!t) return;
    const used = isDomain ? counts.domain(t.name ?? "") + counts.reviewDomain(t.name ?? "") + kids.length : counts.topic(t.name ?? "") + counts.review(t.name ?? "");
    if (used) {
      toast(isDomain ? `“${t.displayName}” still has topics or documents. Move or archive them first.` : `Documents use “${t.displayName}”. Retag them first, then archive it.`, { tone: "accent" });
      return;
    }
    try {
      await deleteTopic(ws, t.name ?? "");
      p.dropDraft();
      invalidate();
      p.onSelect(isDomain ? "" : resourceId(t.parentTopic));
      toast(`Archived “${t.displayName}”`, {
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

  const head = t ? (
    <header className="tx-head">
      <div className="tx-head__main">
        <div className="tx-head__title-row">
          <span className="md-code md-code--domain" translate="no">
            {resourceId(t.name)}
          </span>
          <h2 className="tx-head__title" translate="no">
            {t.displayName}
          </h2>
        </div>
        <p className="tx-head__meta">
          {isDomain ? (
            <span>{plural(kids.length, "topic")}</span>
          ) : (
            <button type="button" className="tx-head__domain link" translate="no" onClick={() => p.onSelect(resourceId(t.parentTopic))}>
              {parentName(t.parentTopic ?? "")}
            </button>
          )}
          <span className="muted" aria-hidden="true">
            {" "}
            ·{" "}
          </span>
          {isDomain ? <CountLinks topic={t.name ?? ""} pub={counts.domain(t.name ?? "")} rv={counts.reviewDomain(t.name ?? "")} /> : <CountLinks topic={t.name ?? ""} pub={counts.topic(t.name ?? "")} rv={counts.review(t.name ?? "")} />}
        </p>
      </div>
      <div className="tx-head__acts">
        <ActionsMenu
          label={`More actions for ${t.displayName}`}
          actions={[
            { id: "ident", label: isDomain ? "Edit name…" : "Edit name and domain…", icon: Pencil, onAction: () => p.setDraft({ ident: true }) },
            { id: "archive", label: "Archive", icon: Archive, danger: true, separated: true, onAction: () => void archive() },
          ]}
        />
      </div>
    </header>
  ) : (
    <header className="tx-head">
      <div className="tx-head__main">
        <h2 className="tx-head__title">{isDomain ? "New domain" : "New topic"}</h2>
        <p className="tx-head__meta">
          <span>{isDomain ? "Domains group topics on Home and in Browse." : "A topic people browse by and the assistant classifies with."}</span>
        </p>
      </div>
    </header>
  );

  const ident =
    isNew || f.ident ? (
      <div className={`tx-ident${isNew && !isDomain ? " tx-ident--3" : ""}`}>
        <TextField value={f.name} onChange={(v) => p.setDraft({ name: v })} isRequired isInvalid={!!shownErr.name} maxLength={60} autoFocus>
          <Label>Name</Label>
          <Input ref={nameRef} translate="no" />
          <FieldError>{shownErr.name}</FieldError>
        </TextField>
        {isNew ? (
          <TextField value={f.code} onChange={(v) => p.setDraft({ code: v })} isInvalid={!!shownErr.code} maxLength={63}>
            <Label>
              Code <span className="label__opt">(optional)</span>
            </Label>
            <Input ref={codeRef} translate="no" spellCheck={false} autoCapitalize="none" autoComplete="off" placeholder={isDomain ? "e.g. ops" : "e.g. ops-cards"} />
            {shownErr.code ? <FieldError>{shownErr.code}</FieldError> : <Description>The key in your spreadsheet. Stays the same when you rename.</Description>}
          </TextField>
        ) : null}
        {isDomain ? null : (
          <div className="field">
            <span className="label">Domain</span>
            <PlainSelect label="Domain" value={f.parent} options={domains.map((d) => [d.name ?? "", d.displayName ?? ""] as const)} onChange={(v) => p.setDraft({ parent: v })} />
            {shownErr.parent ? <div className="field-error">{shownErr.parent}</div> : null}
          </div>
        )}
      </div>
    ) : null;

  const desc = (
    <Sec title="Description" desc={isDomain ? "Shown on Home’s topic cards." : "For people choosing a topic."}>
      <TextField value={f.desc} onChange={(v) => p.setDraft({ desc: v })} maxLength={300} aria-label="Description">
        <TextArea rows={2} placeholder={isDomain ? "What this domain groups, in a sentence" : "What this topic covers, in your business’s words"} />
      </TextField>
    </Sec>
  );

  // A topic's job is to recognise documents, so its words lead; the description (for people) and guidance follow.
  const signals = isDomain ? null : (
    <>
      <TermsEditor value={f} onChange={p.setDraft} />
      {desc}
      <Sec title="Guidance for the assistant" desc="When to use it, and what belongs elsewhere.">
        <TextField value={f.guidance} onChange={(v) => p.setDraft({ guidance: v })} maxLength={GUIDANCE_MAX} aria-label="Guidance for the assistant">
          <TextArea rows={3} placeholder={"Use for…\nNot for…"} />
        </TextField>
      </Sec>
      <RulesEditor rules={f.rules} options={ruleOptions} onChange={(next) => p.setDraft({ rules: next })} />
      <ExamplesEditor topic={t?.name ?? null} examples={f.examples} onChange={(next) => p.setDraft({ examples: next })} />
    </>
  );

  const topicsSec =
    t && isDomain ? (
      <Sec
        title="Topics"
        aside={
          <Button variant="ghost" size="sm" onPress={() => p.onAdd("topic", t.name)}>
            <Plus className="i" aria-hidden />
            Add topic
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
                    <span className="tx-row__code" translate="no">
                      {resourceId(k.name)}
                    </span>
                    <span className="tx-trow__name truncate" translate="no">
                      {k.displayName}
                    </span>
                    <span className={`tx-trow__kw${kw ? "" : " is-warn"}`}>{kw ? plural(kw, "keyword") : "No keywords"}</span>
                    <span className="tx-trow__n">{`${fmtNum(counts.topic(k.name ?? ""))} published`}</span>
                    <ChevronRight className="i i-sm muted" aria-hidden />
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="tx-sec__empty">No topics yet.</p>
        )}
      </Sec>
    ) : null;

  const dist = t ? <Distribution topic={t} kids={kids} published={p.published} counts={counts} /> : null;
  const test = t && !isDomain ? <TestClassification topic={t} draft={edited} topics={topics} options={ruleOptions} /> : null;
  const nErr = f.tried ? Object.keys(err).length : 0;

  return (
    <div className="tx-detail">
      {back}
      {head}
      {ident}
      {isDomain ? desc : signals}
      {topicsSec}
      {dist}
      {test}
      <SaveBar
        isDirty={p.dirty}
        isSaving={saving}
        onSave={() => void save()}
        onDiscard={() => {
          p.dropDraft();
          if (isNew) p.onSelect(resourceId(f.parent));
        }}
        message={`${isNew ? (isDomain ? "New domain" : "New topic") : "Unsaved changes"}${nErr ? ` · ${plural(nErr, "field")} to fix` : ""}`}
        saveLabel={isNew ? (isDomain ? "Add domain" : "Add topic") : "Save"}
      />
    </div>
  );
}

/** How a topic's (or a domain's) published documents spread over the collections, and what's still in review. */
function Distribution({ topic: t, kids, published, counts }: { topic: Topic; kids: readonly Topic[]; published: readonly Resource[]; counts: TopicCounts }) {
  const isDomain = t.kind === "DOMAIN";
  const ids = isDomain ? [t.name ?? "", ...kids.map((k) => k.name ?? "")] : [t.name ?? ""];
  const rows = distribution(published, ids);
  const max = rows[0]?.n || 1;
  const total = rows.reduce((a, r) => a + r.n, 0);
  const rv = isDomain ? counts.reviewDomain(t.name ?? "") : counts.review(t.name ?? "");
  return (
    <Sec title="Distribution" aside={<span className="tx-sec__meta">{`${plural(total, "published document")} · ${plural(rows.length, "collection")}`}</span>}>
      {rows.length ? (
        <ul className="tx-dist">
          {rows.map(({ base, n }) => (
            <li key={base.name} className="tx-dist__row">
              <NextLink className="tx-dist__name link truncate" href={catalogHref({ filters: { topic: [resourceId(t.name)], kb: [base.id] } })} translate="no">
                {base.displayName}
              </NextLink>
              <span className="tx-dist__bar" aria-hidden="true">
                <span style={{ width: `${Math.max(3, Math.round((n / max) * 100))}%` }} />
              </span>
              <span className="tx-dist__n">{fmtNum(n)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="tx-sec__empty">No published documents yet.</p>
      )}
      {rv ? (
        <p className="tx-dist__pending">
          <Clock className="i i-sm" aria-hidden />
          <NextLink className="link" href={docsHref("review")}>{`${fmtNum(rv)} in review`}</NextLink>
        </p>
      ) : null}
    </Sec>
  );
}

