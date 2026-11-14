"use client";

import { Button, Input, Label, TextArea, TextField, FieldError } from "@heroui/react";
import { Archive, ArrowLeft, ChevronDown, ChevronRight, Clock, Database, Download, FolderPlus, Lock, Pencil, Plus, Sparkles, Table, Tag, Undo2, Upload } from "lucide-react";
import NextLink from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import { EmptyState, ErrorState, PageHeader, SaveBar, SearchInput, SkeletonRows, StatusChip, toast } from "@/components/ui";
import { errorMessage, resourceId } from "@/lib/api/client";
import { fmtNum, plural } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";
import { catalogHref, fold, type Resource } from "@/modules/knowledge/model";

import { createTopic, deleteTopic, undeleteTopic, updateTopic, type Topic } from "../api";
import { activeDomains, cleanName, distribution, nameTaken, topicCounts, topicsOf, type TopicCounts } from "../governance";
import { reviewQueueHref } from "../model";
import { useHeldDecisions } from "../decisions";
import { useAllTopics, useCurationPool, useInvalidateCuration, useRememberTopic, useReviewQueue } from "../queries";
import { exportRows, TEMPLATE_ROWS } from "../taxonomy";
import { DemoChip, PlainSelect } from "./parts";
import { ActionsMenu, saveCsv } from "./shared";
import { ImportDialog } from "./taxonomy/ImportDialog";
import { ProposedDetail } from "./taxonomy/Proposed";

const PROPOSED = "__proposed";
const NEW = "__new";
const ARCHIVED = "__archived";

/** A node's working copy (one per node, one save bar). */
interface Draft {
  name: string;
  parent: string;
  desc: string;
  /** New nodes: a domain rather than a topic. */
  domain?: boolean;
  /** Name (and domain) fields open. */
  ident: boolean;
  tried: boolean;
}

const valuesOf = (t: Topic): Draft => ({ name: t.displayName ?? "", parent: t.parentTopic ?? "", desc: t.description ?? "", ident: false, tried: false });
const sameValues = (a: Draft, b: Draft) => cleanName(a.name) === cleanName(b.name) && a.parent === b.parent && a.desc.trim() === b.desc.trim();

/**
 * Knowledge Studio → Taxonomy (preview `X.md.tab`, workspace admins): the topic tree documents are filed under —
 * a summary line, the tree (search, Proposed by the assistant, domains with their topics and counts, archived last;
 * keyboard navigable) beside the selected node's detail (`?node=`). One action: Import (`?import=1` opens it).
 */
export function TaxonomySection() {
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

  const setQuery = (patch: Record<string, string>) => {
    const next = new URLSearchParams(params.toString());
    next.set("tab", "taxonomy");
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

  const header = (
    <PageHeader
      title="Taxonomy"
      chips={<DemoChip />}
      actions={
        admin ? (
          <Button variant="primary" onPress={() => setImporting(true)}>
            <Upload className="i" aria-hidden />
            Import
          </Button>
        ) : null
      }
    />
  );

  if (!admin) {
    return (
      <>
        {header}
        <EmptyState icon={Lock} title="Only workspace admins change the taxonomy" boxed />
      </>
    );
  }
  if (!topics.data) {
    return (
      <>
        {header}
        {topics.isError ? <ErrorState title="The taxonomy didn’t load" error={topics.error} onRetry={() => void topics.refetch()} /> : <SkeletonRows rows={6} />}
      </>
    );
  }

  const domains = activeDomains(all);
  // A decision in its Undo window has left the list already.
  const proposals = all.filter((t) => t.state === "PROPOSED" && !held.has(t.name ?? ""));
  const picked = params.get("node") ?? "";
  const byId = (id: string) => all.find((t) => resourceId(t.name) === id);
  const resolve = (): string => {
    if (picked === NEW) return drafts[NEW] ? NEW : resourceId(domains[0]?.name);
    if (picked === PROPOSED) return PROPOSED;
    if (picked && byId(picked) && byId(picked)?.state !== "PROPOSED" && byId(picked)?.state !== "REJECTED") return picked;
    return proposals.length ? PROPOSED : resourceId(domains[0]?.name);
  };
  const node = resolve();
  const exportName = `${fold(workspace.displayName ?? "workspace").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}-taxonomy.csv`;

  const startNew = (kind: "domain" | "topic", parent = "") => {
    setDrafts((d) => ({ ...d, [NEW]: { name: "", parent: kind === "domain" ? "" : parent || domains[0]?.name || "", desc: "", domain: kind === "domain", ident: true, tried: false } }));
    setQuery({ node: NEW });
  };

  const summary = (
    <div className="tx-sum">
      <p className="tx-sum__text">
        <span className="medium">{`${plural(domains.length, "domain")} · ${plural(all.filter((t) => t.kind === "TOPIC" && t.state === "ACTIVE").length, "topic")}`}</span>
      </p>
      <ActionsMenu
        label="More taxonomy actions"
        actions={[
          { id: "export", label: "Export taxonomy", icon: Download, onAction: () => saveCsv(exportName, exportRows(all)) },
          { id: "template", label: "Download template", icon: Table, onAction: () => saveCsv("taxonomy-template.csv", TEMPLATE_ROWS) },
        ]}
      />
    </div>
  );

  if (!domains.length && !proposals.length && !drafts[NEW]) {
    return (
      <>
        {header}
        <div className="tx">
          {summary}
          <EmptyState
            icon={Database}
            title="No taxonomy yet"
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
  const setDraft = (key: string, patch: Partial<Draft>) => {
    const base = draftOf(key);
    if (base) setDrafts((d) => ({ ...d, [key]: { ...base, ...patch } }));
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
          <TaxonomyTree
            topics={all}
            counts={counts}
            selected={node}
            proposals={proposals.length}
            dirty={(key) => isDirty(key)}
            newDraft={drafts[NEW] ?? null}
            onSelect={(id) => setQuery({ node: id })}
            onAdd={startNew}
          />
          <div className="tx-main">
            {node === PROPOSED ? (
              <ProposedDetail proposals={proposals} topics={all} onBack={() => setQuery({ node: "" })} />
            ) : (
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
            )}
          </div>
        </div>
      </div>
      <ImportDialog isOpen={importOpen} onClose={closeImport} topics={all} />
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

function TaxonomyTree({
  topics,
  counts,
  selected,
  proposals,
  dirty,
  newDraft,
  onSelect,
  onAdd,
}: {
  topics: readonly Topic[];
  counts: TopicCounts;
  selected: string;
  proposals: number;
  dirty: (key: string) => boolean;
  newDraft: Draft | null;
  onSelect: (id: string) => void;
  onAdd: (kind: "domain" | "topic", parent?: string) => void;
}) {
  const [q, setQ] = useState("");
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  const [archivedOpen, setArchivedOpen] = useState(false);
  const ref = useRef<HTMLUListElement>(null);
  const needle = fold(q).trim();
  const hit = (t: Topic) => !needle || fold(t.displayName ?? "").includes(needle);
  const domains = activeDomains(topics);
  const id = (t: Topic) => resourceId(t.name);
  const dot = (key: string) => (dirty(key) ? <span className="tx-row__dot" role="img" aria-label="Unsaved changes" title="Unsaved changes" /> : null);
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
        <span className="tx-row__name">{cleanName(newDraft?.name ?? "") || (newDraft?.domain ? "New domain" : "New topic")}</span>
        {dot(NEW)}
      </>
    ),
  });

  const items: TreeItem[] = [];
  if (proposals && !needle) {
    items.push({
      id: PROPOSED,
      level: 1,
      cls: "tx-item--prop",
      inner: (
        <>
          <Sparkles className="i i-sm tx-row__icon" aria-hidden />
          <span className="tx-row__name">{`Proposed by the assistant (${proposals})`}</span>
        </>
      ),
    });
  }
  for (const dm of domains) {
    const all = topicsOf(topics, dm.name ?? "");
    const domHit = hit(dm);
    const kids = domHit ? all : all.filter(hit);
    const draftHere = !!newDraft && !newDraft.domain && newDraft.parent === dm.name;
    if (needle && !domHit && !kids.length) continue;
    const open = needle ? true : !closed[dm.name ?? ""];
    items.push({
      id: id(dm),
      level: 1,
      expanded: open,
      inner: (
        <>
          {chev(dm.name ?? "", open, () => setClosed((c) => ({ ...c, [dm.name ?? ""]: !c[dm.name ?? ""] })))}
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
                  <span className="tx-row__name" translate="no">
                    {t.displayName}
                  </span>
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
  if (archived.length && !needle) {
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
              <span className="tx-row__name" translate="no">
                {t.displayName}
              </span>
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
        <SearchInput value={q} onChange={setQ} placeholder="Search topics" fullWidth />
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
        <p className="tx-side__empty">{`No topics match “${q}”.`}</p>
      )}
    </div>
  );
}

/* ═══════════════ Detail ═══════════════ */

function Sec({ title, desc, aside, optional, children }: { title: string; desc?: string; aside?: ReactNode; optional?: boolean; children: ReactNode }) {
  return (
    <section className="tx-sec">
      <div className="tx-sec__head">
        <h3 className="tx-sec__title">
          {title}
          {optional ? <span className="label__opt">(optional)</span> : null}
        </h3>
        {aside}
      </div>
      {desc ? <p className="tx-sec__desc">{desc}</p> : null}
      {children}
    </section>
  );
}

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

/** "12 published · 2 in review": published links to Browse, in review to the Review queue. */
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
          <NextLink className="link tx-review" href={reviewQueueHref("submissions")}>
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
  const [saving, setSaving] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
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

  // Validation (shown once Save was tried).
  const name = cleanName(f.name);
  const err: { name?: string; parent?: string } = {};
  if (!name) err.name = "Enter a name.";
  else if (nameTaken(topics, name, isDomain ? null : f.parent, t?.name)) err.name = isDomain ? `A domain called “${name}” already exists.` : `${parentName(f.parent)} already has “${name}”.`;
  if (!isDomain && !domains.some((d) => d.name === f.parent)) err.parent = "Choose a domain.";
  const shownErr = f.tried ? err : {};

  const save = async () => {
    p.setDraft({ tried: true });
    if (Object.keys(err).length) {
      p.setDraft({ tried: true, ident: true });
      // Validate on submit: the first invalid field takes focus (a renamed field mounts focused).
      if (err.name) requestAnimationFrame(() => nameRef.current?.focus());
      return;
    }
    setSaving(true);
    try {
      if (!t) {
        const created = await createTopic(ws, { displayName: name, kind: isDomain ? "DOMAIN" : "TOPIC", parentTopic: isDomain ? undefined : f.parent, description: f.desc.trim() || undefined });
        remember(created);
        p.dropDraft();
        invalidate();
        p.onSelect(resourceId(created.name));
        toast(isDomain ? `Added the domain “${name}”` : `Added “${name}” to ${parentName(f.parent)}`, { undo: () => void deleteTopic(ws, created.name ?? "").then(invalidate, fail) });
      } else {
        const before = { displayName: t.displayName ?? "", description: t.description ?? "", parentTopic: t.parentTopic ?? "" };
        const patch: { displayName?: string; description?: string; parentTopic?: string } = {};
        if (name !== before.displayName) patch.displayName = name;
        if (f.desc.trim() !== before.description) patch.description = f.desc.trim();
        if (!isDomain && f.parent !== before.parentTopic) patch.parentTopic = f.parent;
        const saved = await updateTopic(ws, t, patch);
        remember(saved);
        p.dropDraft();
        invalidate();
        const revert = Object.fromEntries(Object.keys(patch).map((k) => [k, before[k as keyof typeof before]]));
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
            { id: "archive", label: "Archive", icon: Archive, danger: true, onAction: () => void archive() },
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
      <div className="tx-ident">
        <TextField value={f.name} onChange={(v) => p.setDraft({ name: v })} isRequired isInvalid={!!shownErr.name} maxLength={60} autoFocus>
          <Label>Name</Label>
          <Input ref={nameRef} translate="no" />
          <FieldError>{shownErr.name}</FieldError>
        </TextField>
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
            {kids.map((k) => (
              <li key={k.name}>
                <button type="button" className="tx-trow" onClick={() => p.onSelect(resourceId(k.name))}>
                  <span className="tx-trow__name truncate" translate="no">
                    {k.displayName}
                  </span>
                  <span className="tx-trow__n">{`${fmtNum(counts.topic(k.name ?? ""))} published`}</span>
                  <ChevronRight className="i i-sm muted" aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="tx-sec__empty">No topics yet.</p>
        )}
      </Sec>
    ) : null;

  const dist = t ? <Distribution topic={t} kids={kids} published={p.published} counts={counts} /> : null;
  const nErr = f.tried ? Object.keys(err).length : 0;

  return (
    <div className="tx-detail">
      {back}
      {head}
      {ident}
      {desc}
      {topicsSec}
      {dist}
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
          <NextLink className="link" href={reviewQueueHref("submissions")}>{`${fmtNum(rv)} in review`}</NextLink>
        </p>
      ) : null}
    </Sec>
  );
}

