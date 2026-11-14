"use client";

import { Button, Dropdown, Label } from "@heroui/react";
import clsx from "clsx";
import {
  ArrowRight,
  Building2,
  ChevronDown,
  ChevronsDownUp,
  ChevronsUpDown,
  File,
  ListTree,
  Lock,
  Maximize,
  Minus,
  Plus,
  RotateCcw,
  Search,
  Star,
  ShieldCheck,
  Target,
  X,
} from "lucide-react";
import NextLink from "next/link";
import { useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";

import { EmptyState, ErrorState, IconButton, LinkButton, SearchInput } from "@/components/ui";
import { resourceId } from "@/lib/api/client";
import { plural } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";
import type { Item } from "@/modules/knowledge/api";
import { BaseMark } from "@/modules/knowledge/bases/components/BaseMark";
import { RequestAccessCta } from "@/modules/knowledge/bases/components/RequestAccessDialog";
import { catalogHref } from "@/modules/knowledge/model";

import { DocGroup, DocRow, levelIcon, NearViewContext, OrgNode, SearchDoc, WorkspaceNode } from "./AtlasNodes";
import { edgePath, LEVELS, layoutAtlas, levelOf, relatedTo, type AtlasCollection, type AtlasLayout, type AtlasNode } from "./layout";
import { narrowTree, queryWords, wordHits } from "./match";
import { AtlasDocsContext, useAtlasDocsModel, useAtlasSearch, useAtlasTree, useContainerDocs } from "./queries";
import { useAtlasView } from "./useAtlasView";

const NEW_DAYS = 14;

/** Rounded to one decimal so a resize only re-lays out when the canvas actually changes shape. */
const aspectOf = (el: HTMLElement | null) => {
  const r = el?.getBoundingClientRect();
  if (r?.width && r.height) return Math.round((r.width / r.height) * 10) / 10;
  if (typeof window === "undefined") return 1.6;
  return Math.round(((window.innerWidth - (window.innerWidth >= 1024 ? 280 : 32)) / Math.max(320, window.innerHeight - 190)) * 10) / 10;
};

/** What the Home header says about the atlas: documents the caller can read, collections, levels. */
export interface AtlasStats {
  documents: number;
  collections: number;
  levels: number;
}

/**
 * Home's Knowledge Atlas (preview `features/home.js`): the workspace's collections, folders and documents on one canvas.
 * One request draws the structure; documents load per container when their boxes come near the view. Pan and zoom never
 * re-render (useAtlasView); folding re-lays out in a few milliseconds and keeps the folded box where it was on screen.
 */
export function KnowledgeAtlas({ onStats }: { onStats?: (s: AtlasStats) => void }) {
  const ws = useWorkspace();
  const tree = useAtlasTree();
  const docsModel = useAtlasDocsModel();
  const viewport = useRef<HTMLDivElement | null>(null);
  /** The canvas element as state: lazy loading observes against it, and pan/zoom listeners attach once it exists. */
  const [canvas, setCanvas] = useState<HTMLDivElement | null>(null);
  const viewportRef = useCallback((el: HTMLDivElement | null) => {
    viewport.current = el;
    setCanvas(el);
  }, []);
  const world = useRef<HTMLDivElement>(null);
  const zoomLabel = useRef<HTMLButtonElement>(null);
  const view = useAtlasView(ws.id, viewport, world, zoomLabel, !!canvas);

  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [clustersOpen, setClustersOpen] = useState<Record<string, boolean>>({});
  const [expandAll, setExpandAll] = useState(false);
  const [showDocs, setShowDocs] = useState(true);
  const [sel, setSel] = useState("");
  const [q, setQ] = useState("");
  const term = useDeferredValue(q.trim());
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(term), 250);
    return () => window.clearTimeout(t);
  }, [term]);
  const search = useAtlasSearch(debounced, docsModel.toResource);
  const words = useMemo(() => (debounced ? queryWords(debounced) : []), [debounced]);

  const [aspect, setAspect] = useState(() => aspectOf(null));
  useEffect(() => {
    if (!canvas) return;
    const ro = new ResizeObserver(() => setAspect(aspectOf(canvas)));
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [canvas]);
  /** Lanes are kept per canvas shape and search state, so folding never moves a territory to another lane. */
  const lanes = useRef(new Map<string, number>());

  const levels = LEVELS[ws.workspace.template === "CAMPUS" ? "CAMPUS" : "ENTERPRISE"];
  const searching = words.length > 0;
  const matches = searching ? search.byContainer : null;
  const shown = useMemo(() => {
    if (!matches) return { roots: tree.roots, locked: tree.locked };
    const roots = tree.roots.map((r) => narrowTree(r, words, matches)).filter((r): r is AtlasCollection => !!r);
    return { roots, locked: [] };
  }, [tree.roots, tree.locked, words, matches]);

  const layout = useMemo(() => {
    const shape = aspect >= 1.3 ? "wide" : aspect >= 0.8 ? "square" : "tall";
    const key = `${shape}:${matches ? `q${shown.roots.length}` : ""}`;
    const L = layoutAtlas(shown.roots, shown.locked, {
      collapsed,
      clustersOpen,
      expandAll,
      showDocs,
      aspect,
      matches,
      lanes: lanes.current.get(key),
    });
    // The layout also runs while the tree loads (no territories): pinning its single lane would stack the whole map.
    if (L.territories.length) lanes.current.set(key, L.lanes);
    return L;
  }, [shown, collapsed, clustersOpen, expandAll, showDocs, aspect, matches]);

  const stats = useMemo(() => {
    const deepest = (c: AtlasCollection): number => Math.max(c.depth, ...c.kids.map(deepest));
    return {
      documents: tree.roots.reduce((a, r) => a + r.count, 0),
      collections: tree.roots.length + tree.locked.length,
      levels: tree.roots.length ? Math.max(...tree.roots.map(deepest)) + 1 : 0,
    };
  }, [tree.roots, tree.locked]);
  useEffect(() => onStats?.(stats), [stats, onStats]);

  const selected = sel ? layout.byId.get(sel) : undefined;
  const related = useMemo(() => relatedTo(selected), [selected]);

  /* Folding keeps the folded box where it was on screen: measure before, nudge the view after the new layout commits. */
  const keep = useRef<{ id: string; left: number; top: number } | null>(null);
  const remember = (id: string) => {
    const r = world.current?.querySelector(`[data-node="${CSS.escape(id)}"]`)?.getBoundingClientRect();
    keep.current = r ? { id, left: r.left, top: r.top } : null;
  };
  useLayoutEffect(() => {
    const k = keep.current;
    if (!k) return;
    keep.current = null;
    const r = world.current?.querySelector(`[data-node="${CSS.escape(k.id)}"]`)?.getBoundingClientRect();
    if (r) view.nudge(k.left - r.left, k.top - r.top);
  }, [layout, view]);

  /** Latest layout for the stable callbacks below (boxes are memoized; a new callback per layout would re-render them all). */
  const current = useRef(layout);
  useLayoutEffect(() => {
    current.current = layout;
  }, [layout]);
  const onToggle = useCallback((id: string) => {
    const n = current.current.byId.get(id);
    if (!n) return;
    remember(id);
    setCollapsed((c) => ({ ...c, [id]: !!n.open }));
  }, []);
  const onSelect = useCallback((id: string) => setSel((s) => (s === id ? "" : id)), []);
  const onMore = useCallback((container: string) => {
    remember(`c:${container}`);
    setClustersOpen((c) => ({ ...c, [container]: !c[container] }));
  }, []);

  /* Hovering a box lights its path back to the workspace (straight on the SVG: no re-render). */
  const onHover = useCallback((e: React.MouseEvent) => {
    const el = (e.target as Element).closest<HTMLElement>("[data-node]");
    const svg = world.current?.querySelector("svg");
    if (!svg) return;
    svg.querySelectorAll(".ae.is-hot").forEach((p) => p.classList.remove("is-hot"));
    if (!el) return;
    for (const id of [...(el.dataset.anc ?? "").split(" "), el.dataset.node ?? ""])
      if (id) svg.querySelector(`[data-to="${CSS.escape(id)}"]`)?.classList.add("is-hot");
  }, []);
  const down = useRef<{ x: number; y: number } | null>(null);

  const fitAll = () => view.fit({ x: 0, y: 0, w: layout.W, h: layout.H });
  const territoryOf = (n: AtlasNode | undefined) => (n ? layout.byId.get(n.anc[1] ?? n.id) : undefined);

  // Rebuilt only with the layout or the selection, so other renders (zoom band, lazy loads) keep every box memoized.
  const edges = useMemo(
    () =>
      layout.nodes.flatMap((p) =>
        p.kids.map((c) => (
          <path
            key={c.id}
            className={clsx("ae", related && (related.has(c.id) && related.has(p.id) ? "is-related" : "is-dim"))}
            style={c.tone ? ({ "--tone": c.tone } as CSSProperties) : undefined}
            data-to={c.id}
            d={edgePath(p, c)}
          />
        )),
      ),
    [layout, related],
  );
  const containers = useMemo(() => {
    const m = new Map<string, AtlasNode[]>();
    for (const n of layout.nodes)
      if ((n.kind === "doc" || n.kind === "cluster") && n.coll && !n.docName) m.set(n.coll.name, [...(m.get(n.coll.name) ?? []), n]);
    return [...m];
  }, [layout]);

  if (tree.isPending)
    return (
      <div className="atlas atlas--skel" aria-busy="true" aria-label="Loading">
        <div className="atlas__viewport">
          {[0, 1, 2].map((i) => (
            <div key={i} className="atlas-skel" style={{ top: 40 + i * 150 }}>
              <span className="skeleton" />
              <span className="skeleton" />
              <span className="skeleton" />
            </div>
          ))}
        </div>
      </div>
    );
  if (tree.isError) return <ErrorState error={tree.error} onRetry={() => void tree.refetch()} />;
  if (!tree.roots.length && !tree.locked.length) return <EmptyAtlas />;

  const dimOf = (id: string) => !!related && !related.has(id);

  return (
    <AtlasDocsContext.Provider value={docsModel}>
      <div
        className={clsx("atlas", `is-${view.band}`, related && "has-sel")}
        onKeyDown={(e) => e.key === "Escape" && sel && (setSel(""), viewport.current?.focus())}
      >
        <div
          ref={viewportRef}
          className="atlas__viewport"
          tabIndex={0}
          role="region"
          aria-label="Knowledge map. Drag to move, ⌘ or Ctrl and scroll to zoom."
          onPointerDown={(e) => (down.current = { x: e.clientX, y: e.clientY })}
          onClick={(e) => {
            const d = down.current;
            if (!sel || (e.target as Element).closest(".an") || (d && Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) > 4)) return;
            setSel("");
          }}
        >
          <NearViewContext.Provider value={canvas}>
            <div ref={world} className="atlas__world" style={{ width: layout.W, height: layout.H }} onMouseOver={onHover}>
              {layout.territories.map((t) => (
                <section
                  key={t.id}
                  className={clsx("atlas-band", t.locked && "atlas-band--locked", dimOf(t.id) && "is-dim")}
                  style={{
                    left: t.x,
                    top: t.y,
                    width: t.w,
                    height: t.h,
                    ...(t.locked ? {} : ({ "--tone": t.coll.tone } as CSSProperties)),
                  }}
                  aria-label={t.coll.displayName}
                >
                  <header className="atlas-band__head">
                    {tree.items.get(t.id) ? <BaseMark base={tree.items.get(t.id)!} size={20} locked={t.locked} /> : null}
                    <span className="atlas-band__name" translate="no">
                      {t.coll.displayName}
                    </span>
                    <span className="atlas-band__desc" translate="no">
                      {t.locked ? "Restricted. Ask its owners for access." : t.coll.description}
                    </span>
                    {t.locked ? null : (
                      <NextLink
                        className="atlas-band__open"
                        href={catalogHref({
                          filters: { kb: [resourceId(t.id)] },
                        })}
                      >
                        Open in Knowledge
                        <ArrowRight className="i i-xs" aria-hidden />
                      </NextLink>
                    )}
                  </header>
                </section>
              ))}
              <svg className="atlas__edges" width={layout.W} height={layout.H} aria-hidden>
                {edges}
              </svg>
              <WorkspaceNode node={layout.ws} dim={dimOf("ws")} name={ws.workspace.displayName ?? ""} />
              {layout.nodes.map((n) =>
                n.kind === "root" || n.kind === "org" || n.kind === "locked" ? (
                  <OrgNode
                    key={n.id}
                    node={n}
                    dim={dimOf(n.id)}
                    label={levelOf(levels, n.coll!.depth)}
                    selected={sel === n.id}
                    words={words}
                    onSelect={onSelect}
                    onToggle={onToggle}
                  />
                ) : n.kind === "doc" && n.docName && search.docs.get(n.docName) ? (
                  <SearchDoc
                    key={n.id}
                    node={n}
                    r={search.docs.get(n.docName)!}
                    words={words}
                    featured={false}
                    root={n.anc[1] ?? ""}
                    dim={dimOf(n.id)}
                  />
                ) : null,
              )}
              {containers.map(([container, nodes]) => (
                <DocGroup
                  key={container}
                  nodes={nodes}
                  container={container}
                  root={nodes[0].anc[1] ?? container}
                  tone={nodes[0].tone}
                  dim={dimOf(nodes[0].id)}
                  onMore={onMore}
                />
              ))}
            </div>
          </NearViewContext.Provider>
        </div>

        <div className="atlas-toolbar" role="toolbar" aria-label="Map tools">
          <SearchInput
            value={q}
            onChange={setQ}
            placeholder="Find in the map"
            className="atlas-toolbar__search"
            onSubmit={() => {
              const hit = layout.nodes.find(
                (n) => n.kind === "doc" || ((n.kind === "org" || n.kind === "root") && wordHits(n.coll!.displayName, words)),
              );
              if (hit) view.focus(hit);
            }}
          />
          <span className="atlas-toolbar__count num" aria-live="polite">
            {searching
              ? search.settled
                ? shown.roots.length
                  ? `${plural(
                      shown.roots.reduce((a, r) => a + r.count, 0),
                      "document",
                    )} match`
                  : ""
                : "Searching…"
              : plural(stats.documents, "document")}
          </span>
          <span className="atlas-toolbar__sep" aria-hidden />
          <IconButton
            icon={ListTree}
            tip={showDocs ? "Hide documents" : "Show documents"}
            size="sm"
            onPress={() => setShowDocs((s) => !s)}
            className={clsx(!showDocs && "is-pressed")}
          />
          <IconButton
            icon={ChevronsUpDown}
            tip="Expand all"
            size="sm"
            onPress={() => {
              setCollapsed({});
              setExpandAll(true);
              setShowDocs(true);
            }}
          />
          <IconButton
            icon={ChevronsDownUp}
            tip="Collapse all"
            size="sm"
            onPress={() => {
              setExpandAll(false);
              setClustersOpen({});
              setCollapsed(Object.fromEntries(layout.nodes.filter((n) => n.kind === "org").map((n) => [n.id, true])));
              window.requestAnimationFrame(() => window.requestAnimationFrame(fitAll));
            }}
          />
          <Dropdown>
            <Button size="sm" variant="ghost" className="atlas-goto">
              Go to
              <ChevronDown className="i i-sm" aria-hidden />
            </Button>
            <Dropdown.Popover placement="bottom start">
              <Dropdown.Menu aria-label="Go to a collection">
                {layout.territories.map((t) => (
                  <Dropdown.Item
                    key={t.id}
                    id={t.id}
                    textValue={t.coll.displayName}
                    onAction={() => {
                      setCollapsed((c) => ({ ...c, [t.id]: false }));
                      // A selected box elsewhere would leave the territory you went to dimmed.
                      setSel("");
                      view.fit({ x: t.x, y: t.y, w: t.w, h: t.h });
                    }}
                  >
                    {t.locked ? <Lock className="i" aria-hidden /> : <Building2 className="i" aria-hidden />}
                    <Label className="truncate" translate="no">
                      {t.coll.displayName}
                    </Label>
                  </Dropdown.Item>
                ))}
              </Dropdown.Menu>
            </Dropdown.Popover>
          </Dropdown>
        </div>

        <div className="atlas-zoom" role="toolbar" aria-label="Zoom">
          <IconButton icon={Minus} tip="Zoom out (−)" size="sm" onPress={() => view.zoomBy(0.8)} />
          <button ref={zoomLabel} type="button" className="atlas-zoom__level num" title="Zoom to 100% (0)" onClick={view.zoomTo100}>
            100%
          </button>
          <IconButton icon={Plus} tip="Zoom in (+)" size="sm" onPress={() => view.zoomBy(1.25)} />
          <span className="atlas-toolbar__sep" aria-hidden />
          <IconButton icon={Maximize} tip="Fit to view" size="sm" onPress={fitAll} />
          <IconButton
            icon={RotateCcw}
            tip="Reset the map"
            size="sm"
            onPress={() => {
              setCollapsed({});
              setClustersOpen({});
              setExpandAll(false);
              setShowDocs(true);
              setSel("");
              setQ("");
              lanes.current.clear();
              view.reset();
            }}
          />
        </div>

        <Legend levels={levels} depth={stats.levels - 1} />
        {selected ? (
          <Inspector
            node={selected}
            levels={levels}
            layout={layout}
            items={tree.items}
            onClose={() => setSel("")}
            onToggle={onToggle}
            onFocus={() => view.focus(selected)}
            territory={territoryOf(selected)}
          />
        ) : null}
        {searching && search.settled && !shown.roots.length ? (
          <div className="atlas-nomatch">
            <EmptyState
              icon={Search}
              title={`Nothing in the map matches “${debounced}”`}
              description="The map finds collection names and documents you can read."
              compact
              actions={
                <LinkButton href={catalogHref({ q: debounced })} size="sm">
                  Search in Knowledge
                </LinkButton>
              }
            />
          </div>
        ) : null}
      </div>
    </AtlasDocsContext.Provider>
  );
}

/** The workspace's levels as a path and what the marks mean. */
function Legend({ levels, depth }: { levels: readonly string[]; depth: number }) {
  const path = levels.slice(0, Math.max(1, Math.min(depth, levels.length)));
  return (
    <div className="atlas-legend">
      <ol className="atlas-levels" aria-label="Levels of this workspace">
        {path.map((l, i) => {
          const Icon = levelIcon(l, i + 1);
          return (
            <li key={l} className="atlas-level">
              <Icon className="i i-xs" aria-hidden />
              <span>{l}</span>
            </li>
          );
        })}
        <li className="atlas-level atlas-level--leaf">
          <File className="i i-xs" aria-hidden />
          <span>Document</span>
        </li>
      </ol>
      <span className="atlas-legend__marks">
        <span>
          <Star className="i i-xs an-star" aria-hidden />
          Read first
        </span>
        <span>
          <ShieldCheck className="i i-xs an-ok" aria-hidden />
          Verified
        </span>
        <span>
          <span className="an-new">New</span>
          {`Changed in the last ${NEW_DAYS} days`}
        </span>
      </span>
    </div>
  );
}

/** The selected box: its level, path, counts and description, the first documents in it, and what to do next. */
function Inspector({
  node,
  levels,
  layout,
  items,
  onClose,
  onToggle,
  onFocus,
  territory,
}: {
  node: AtlasNode;
  levels: readonly string[];
  layout: AtlasLayout;
  items: ReadonlyMap<string, Item>;
  onClose: () => void;
  onToggle: (id: string) => void;
  onFocus: () => void;
  territory: AtlasNode | undefined;
}) {
  const c = node.coll;
  const docs = useContainerDocs(c?.name, !!c && node.kind !== "locked" && c.direct > 0);
  if (!c) return null;
  const close = <IconButton icon={X} tip="Close" size="sm" onPress={onClose} />;
  if (node.kind === "locked") {
    const item = items.get(node.id);
    return (
      <aside className="atlas-inspector" aria-label="Details">
        <div className="atlas-inspector__head">
          <span className="an__icon">
            <Lock className="i" aria-hidden />
          </span>
          <div className="grow">
            <div className="an__type">Restricted</div>
            <h2 className="atlas-inspector__title" translate="no">
              {c.displayName}
            </h2>
          </div>
          {close}
        </div>
        <p className="atlas-inspector__desc">Only its members can see what’s inside. Ask its owners for access.</p>
        {item ? (
          <div className="atlas-inspector__actions">
            <RequestAccessCta base={item} variant="primary" />
          </div>
        ) : null}
      </aside>
    );
  }
  const label = levelOf(levels, c.depth);
  const Icon = levelIcon(label, c.depth);
  const path = node.anc
    .filter((id) => id !== "ws")
    .map((id) => layout.byId.get(id)?.coll?.displayName)
    .filter(Boolean);
  const first = docs.docs.slice(0, 5);
  return (
    <aside className="atlas-inspector" style={{ "--tone": c.tone } as CSSProperties} aria-label="Details">
      <div className="atlas-inspector__head">
        <span className="an__icon">
          <Icon className="i" aria-hidden />
        </span>
        <div className="grow">
          <div className="an__type">{label}</div>
          <h2 className="atlas-inspector__title" translate="no">
            {c.displayName}
          </h2>
        </div>
        {close}
      </div>
      {path.length ? (
        <p className="atlas-inspector__path" translate="no">
          {path.join(" › ")}
        </p>
      ) : null}
      <p className="atlas-inspector__stats num">
        {plural(c.count, "document")}
        {c.kids.length ? ` · ${plural(c.kids.length, "folder")}` : ""}
      </p>
      {c.description ? (
        <p className="atlas-inspector__desc" translate="no">
          {c.description}
        </p>
      ) : null}
      {c.direct > 0 ? (
        <div className="atlas-inspector__sec">
          <div className="atlas-inspector__label">{c.direct > first.length ? `Here · ${plural(c.direct, "document")}` : "Here"}</div>
          {first.length
            ? first.map((r) => <DocRow key={r.id} r={r} featured={docs.featured.has(r.id)} root={territory?.id} />)
            : Array.from({ length: Math.min(c.direct, 5) }, (_, i) => (
                <span key={i} className="an-row an-row--skel" aria-hidden>
                  <span className="skeleton" />
                </span>
              ))}
        </div>
      ) : null}
      <div className="atlas-inspector__actions">
        {node.hasKids ? (
          <Button size="sm" variant="tertiary" onPress={() => onToggle(node.id)}>
            {node.open ? <ChevronsDownUp className="i" aria-hidden /> : <ChevronsUpDown className="i" aria-hidden />}
            {node.open ? "Collapse" : "Expand"}
          </Button>
        ) : null}
        <Button size="sm" variant="tertiary" onPress={onFocus}>
          <Target className="i" aria-hidden />
          Focus
        </Button>
        <LinkButton
          href={catalogHref({
            filters: { kb: [resourceId(territory?.id ?? c.name)] },
          })}
          size="sm"
          icon={ArrowRight}
        >
          Open in Knowledge
        </LinkButton>
      </div>
    </aside>
  );
}

function EmptyAtlas() {
  return (
    <EmptyState
      icon={Search}
      title="Your workspace has no published knowledge yet"
      description="The map fills in as documents are published."
      boxed
    />
  );
}
