/* Home (/home): the Knowledge Atlas — every document the caller can read, drawn
   the way the organisation keeps it, on one pannable, zoomable canvas.
   The tree is the canonical Item hierarchy: workspace › root collection ›
   folders (nested collections) › documents. Each workspace names its levels
   once (mapLevels(): Faculty › Academic department › Program group › Major for
   a university, Area › Section › … for a company); a collection or folder may
   use another label of the same vocabulary (Administrative office, Forms).

   Visual language
   - Node type = icon + label (what it is); territory = accent colour (which
     root collection it belongs to). Each root collection is a territory: a
     faintly tinted band with its own connectors.
   - Documents are lighter than organisational nodes. More than three in one
     place become a cluster card (three shown, +N to see all); search always
     shows every match.
   - Layout: a tidy left-to-right tree (own layout, no graph library — a
     few hundred nodes lay out in a millisecond). A parent sits level with
     its first child, like a sitemap; territories fill lanes under the
     workspace node.
   - Semantic zoom: far (< 55 %) shows structure — icons, short titles and
     counts, documents as slim bars; near (≥ 135 %) adds each document's
     age. Node sizes never change with zoom.
   - Interaction: drag or scroll to pan, ⌘/Ctrl + scroll or pinch to zoom;
     a node selects (path highlighted, the rest dimmed, an inspector opens),
     its handle folds it, a document opens the preview. Folding keeps the
     node under the pointer where it was.
   UI state: ui('home') { q, collapsed, more, docs, all, sel, views{ws: {k, tx, ty}} }; ui('homeBg') for the background dialog.
   Map background: a workspace admin (tenant.manage) sets one image per workspace (ws.mapBg { src, name, w, h, strength,
   by, at }); it sits fixed behind the canvas — it doesn't pan or zoom — under a wash in the page colour, so nodes and
   connectors stay readable. Prefix: home-, atlas-, an-, mapbg-. */
(() => {
  'use strict';

  /** Documents shown in a cluster before "+N more"; fewer than CLUSTER_AT documents are drawn one by one. */
  const CLUSTER_SHOW = 3, CLUSTER_AT = 4;
  /** "New" = changed in this many days. */
  const NEW_DAYS = 14;
  /** Boxes at this depth and deeper start folded (workspace = 0, root collection = 1). */
  const FOLD_DEPTH = 3;
  /** Overview-style titles lead their group; then the most opened (popular) documents. */
  const INTRO = /\b(overview|introduction|getting started|start here|read me|readme)\b|giới thiệu|tổng quan|bắt đầu|hướng dẫn chung/i;
  const HEX = /^#[0-9a-f]{3,8}$/i;
  /** World geometry (px at 100 %). */
  const G = { pad: 40, gapX: 56, gapY: 10, gapYGroup: 18, ws: [208, 64], org: [240, 60], doc: [264, 38], clusterW: 284, row: 30,
    band: { padX: 20, top: 48, bottom: 20, gap: 32 }, lane: { gutter: 38, gap: 40, top: 44 } };
  const ZOOM = { min: 0.2, max: 2, far: 0.55, near: 1.35 };

  const st = () => ui('home', { q: '', collapsed: {}, more: {}, docs: true, all: false, sel: '', views: {} });
  const byName = (a, b) => String(a).localeCompare(String(b), 'vi', { numeric: true, sensitivity: 'base' });
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ═══════════════ The tree (permission-filtered) ═══════════════ */
  const docOrder = (a, b) => (INTRO.test(docTitle(b)) - INTRO.test(docTitle(a))) || (b.views || 0) - (a.views || 0) || byName(docTitle(a), docTitle(b));
  const nodeOrder = (a, b) => (a.order ?? 1e9) - (b.order ?? 1e9) || byName(a.name, b.name);

  /** One readable root collection as a tree: { id, name, level, desc, depth, docs, kids, count, root, kb }. Folders without readable
      documents are dropped; documents in a missing or unreachable folder sit at the root. */
  function branch(kb, pool) {
    const root = { id: kb.id, name: kb.name, level: kb.level, desc: kb.desc, depth: 1, docs: [], kids: [], root: true, kb };
    const nodes = new Map((D.folders || []).filter(f => f.kb === kb.id).map(f => [f.id, { id: f.id, name: f.name, level: f.level, desc: f.desc, order: f.order, parent: f.parent, docs: [], kids: [], kb }]));
    nodes.forEach(n => (nodes.get(n.parent) || (n.parent ? null : root))?.kids.push(n));
    const reach = new Set();
    (function walk(n, depth) { n.depth = depth; n.kids.forEach(k => { if (reach.has(k.id)) return; reach.add(k.id); walk(k, depth + 1); }); })(root, 1);
    pool.forEach(d => (reach.has(d.folder) ? nodes.get(d.folder) : root).docs.push(d));
    (function finish(n) {
      n.kids = n.kids.filter(k => reach.has(k.id));
      n.kids.forEach(finish);
      n.kids = n.kids.filter(k => k.count).sort(nodeOrder);
      n.docs.sort(docOrder);
      n.count = n.docs.length + n.kids.reduce((a, k) => a + k.count, 0);
    })(root);
    return root;
  }
  /** Every collection the caller can see, in the workspace's order: readable ones as branches, locked ones as closed territories. */
  function buildMap() {
    const pool = sharedPool(), byKb = new Map();
    pool.forEach(d => (byKb.get(d.kb) || byKb.set(d.kb, []).get(d.kb)).push(d));
    const roots = D.kbs.filter(k => !k.personal && !k.archived && kbRole(k) !== null);
    const branches = roots.filter(canReadKb).map(kb => branch(kb, byKb.get(kb.id) || [])).filter(b => b.count);
    return { pool, branches, locked: roots.filter(k => !canReadKb(k)) };
  }
  const deepest = n => Math.max(n.depth, ...n.kids.map(deepest));
  const walkAll = (n, fn) => { fn(n); n.kids.forEach(k => walkAll(k, fn)); };

  /* ── Find in the map: every word must start a word of the name. Words typed with Vietnamese marks match those marks exactly
     ("đơn" finds "Đơn xin…" but not "động"); words typed without marks match any ("don" finds both). ── */
  const WORD = /[\p{L}\p{N}]/u;
  const marked = t => /[^\u0000-\u007f]/.test(t);
  const lowerNfc = s => String(s ?? '').normalize('NFC').toLowerCase();
  const queryWords = q => lowerNfc(q).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  /** [start, end) of every word-start occurrence of each query word in text, or null when a word is missing. */
  function wordHits(text, words) {
    const s = String(text ?? '').normalize('NFC'), plain = fold(s), low = lowerNfc(s), out = [];
    for (const w of words) {
      const hay = marked(w) ? low : plain, needle = marked(w) ? w : fold(w);
      let i = 0, found = false;
      while ((i = hay.indexOf(needle, i)) !== -1) { if (i === 0 || !WORD.test(hay[i - 1])) { out.push([i, i + needle.length]); found = true; } i += needle.length; }
      if (!found) return null;
    }
    return out;
  }
  /** The name, escaped, with the matched words marked. */
  function markWords(text, words) {
    const s = String(text ?? '').normalize('NFC'), hits = words.length ? wordHits(s, words) : null;
    if (!hits) return esc(s);
    let out = '', at = 0;
    hits.sort((a, b) => a[0] - b[0]).forEach(([a, b]) => { if (a < at) return; out += esc(s.slice(at, a)) + `<mark class="srch-hl">${esc(s.slice(a, b))}</mark>`; at = b; });
    return out + esc(s.slice(at));
  }
  /** The tree narrowed to a query: a container whose name matches keeps everything under it; otherwise only matching documents
      and the containers that lead to them. */
  function narrow(n, words) {
    if (wordHits(n.name, words)) return n;
    const docs = n.docs.filter(d => wordHits(docTitle(d), words)), kids = n.kids.map(k => narrow(k, words)).filter(Boolean);
    if (!docs.length && !kids.length) return null;
    return { ...n, docs, kids, count: docs.length + kids.reduce((a, k) => a + k.count, 0) };
  }

  /* ═══════════════ Layout: a tidy left-to-right tree ═══════════════ */
  /** A box is folded when the person folded it, else from FOLD_DEPTH down (unless Expand all). Search opens everything. */
  const isFolded = (n, u, searching) => !searching && (u.collapsed[n.id] ?? (!u.all && n.depth >= FOLD_DEPTH));
  const clusterH = rows => 40 + rows * G.row + 34;
  /** The drawable tree under a container: its documents first (one by one, or a cluster), then its folders. */
  function visual(n, u, words, tone) {
    const searching = words.length > 0, open = !isFolded(n, u, searching);
    const v = { id: n.id, kind: n.root ? 'root' : 'org', n, tone, w: G.org[0], h: G.org[1], open, kids: [], hidden: 0 };
    const docs = u.docs || searching ? n.docs : [];
    v.hasKids = docs.length > 0 || n.kids.length > 0;
    if (!open) { v.hidden = (docs.length ? 1 : 0) + n.kids.length; return v; }
    if (docs.length && (searching || docs.length < CLUSTER_AT)) docs.forEach(d => v.kids.push({ id: 'd:' + d.id, kind: 'doc', d, tone, w: G.doc[0], h: G.doc[1], kids: [] }));
    else if (docs.length) {
      const all = !!(u.more[n.id] || u.all), rows = all ? docs.length : CLUSTER_SHOW;
      v.kids.push({ id: 'c:' + n.id, kind: 'cluster', owner: n.id, docs, all, tone, w: G.clusterW, h: clusterH(rows), kids: [] });
    }
    n.kids.forEach(k => v.kids.push(visual(k, u, words, tone)));
    return v;
  }
  const shift = (v, d) => { v.y += d; v.kids.forEach(k => shift(k, d)); };
  /** Places v and its subtree with its top at `top`; returns the subtree's height. A parent sits level with its first child, so
      every branch starts at its top and reads down. */
  function place(v, x, top) {
    v.x = x;
    if (!v.kids.length) { v.y = top; return v.h; }
    const cx = x + v.w + G.gapX;
    let y = top;
    v.kids.forEach((k, i) => { if (i) y += (k.kids.length || v.kids[i - 1].kids.length) ? G.gapYGroup : G.gapY; y += place(k, cx, y); });
    const first = v.kids[0];
    v.y = first.y + first.h / 2 - v.h / 2;
    if (v.y < top) { const d = top - v.y; v.kids.forEach(k => shift(k, d)); v.y = top; return Math.max(y - top + d, v.h); }
    return Math.max(y - top, v.y + v.h - top);
  }
  const bounds = (v, b = { x2: 0, y2: 0 }) => { b.x2 = Math.max(b.x2, v.x + v.w); b.y2 = Math.max(b.y2, v.y + v.h); v.kids.forEach(k => bounds(k, b)); return b; };
  const move = (v, dx, dy) => { v.x += dx; v.y += dy; v.kids.forEach(k => move(k, dx, dy)); };
  /** Lanes: territories fill columns in order (1st, 2nd … then back to the first), as many as make the atlas about as wide as
      the canvas — so a workspace with many collections spreads sideways instead of growing one long column. The count is kept
      per workspace, so opening and folding never moves a territory to another lane. */
  function laneCount(items, aspect, u) {
    const key = [S.ws, aspect >= 1.3 ? 'wide' : aspect >= 0.8 ? 'square' : 'tall', u.q.trim() ? 'q' : ''].join(':');
    u.lanes ??= {};
    if (u.lanes[key] && u.lanes[key] <= items.length) return u.lanes[key];
    let best = 1, score = Infinity;
    for (let n = 1; n <= Math.min(items.length, 6); n++) {
      const lanes = Array.from({ length: n }, (_, l) => items.filter((_, i) => i % n === l));
      const W = lanes.reduce((a, l) => a + Math.max(...l.map(t => t.w)) + G.lane.gutter + G.lane.gap, 0);
      const H = Math.max(...lanes.map(l => l.reduce((a, t) => a + t.h + G.band.gap, 0)));
      const s = Math.abs(Math.log(W / H) - Math.log(aspect));
      if (s < score) { score = s; best = n; }
    }
    return (u.lanes[key] = best);
  }
  /** The whole atlas: the workspace node at the top left; one territory per root collection, in lanes under it. */
  function layout(branches, locked, u, words, aspect) {
    const ws = { id: 'ws', kind: 'ws', w: G.ws[0], h: G.ws[1], x: G.pad, y: G.pad, kids: [] };
    const items = [
      ...branches.map(b => ({ v: visual(b, u, words, b.kb.color), kb: b.kb, locked: false })),
      ...locked.map(kb => ({ v: { id: kb.id, kind: 'locked', kb, tone: '', w: G.org[0], h: G.org[1], kids: [] }, kb, locked: true })),
    ];
    items.forEach(t => {
      const h = place(t.v, G.band.padX, G.band.top), b = bounds(t.v);
      t.w = b.x2 + G.band.padX; t.h = Math.max(h, b.y2 - G.band.top) + G.band.top + G.band.bottom;
    });
    const n = items.length ? laneCount(items, aspect, u) : 1, top = ws.y + ws.h + G.lane.top;
    // Each lane has a spine in its left gutter; the first lane's spine drops straight from the workspace node.
    let x = ws.x + 20 + G.lane.gutter, H = 0;
    for (let l = 0; l < n; l++) {
      const lane = items.filter((_, i) => i % n === l), spine = l ? x - G.lane.gutter / 2 : ws.x + 20;
      let y = top;
      lane.forEach(t => { t.x = x; t.y = y; move(t.v, x, y); t.v.spine = spine; y += t.h + G.band.gap; });
      H = Math.max(H, y - G.band.gap);
      x += Math.max(0, ...lane.map(t => t.w)) + G.lane.gap + G.lane.gutter;
    }
    ws.kids = items.map(t => t.v);
    return { ws, terr: items, W: x - G.lane.gap - G.lane.gutter + G.pad, H: H + G.pad };
  }
  /** A polyline through orthogonal points with rounded corners. */
  function roundPath(pts, r = 10) {
    const p = pts.filter((q, i) => !i || q[0] !== pts[i - 1][0] || q[1] !== pts[i - 1][1])
      .filter((q, i, a) => i === 0 || i === a.length - 1 || !((a[i - 1][0] === q[0] && q[0] === a[i + 1][0]) || (a[i - 1][1] === q[1] && q[1] === a[i + 1][1])));
    let d = `M${p[0][0]} ${p[0][1]}`;
    for (let i = 1; i < p.length; i++) {
      const [x, y] = p[i];
      if (i === p.length - 1) { d += `L${x} ${y}`; break; }
      const [px, py] = p[i - 1], [nx, ny] = p[i + 1];
      const rr = Math.min(r, Math.hypot(x - px, y - py) / 2, Math.hypot(nx - x, ny - y) / 2);
      const ax = x - Math.sign(x - px) * rr, ay = y - Math.sign(y - py) * rr, bx = x + Math.sign(nx - x) * rr, by = y + Math.sign(ny - y) * rr;
      d += `L${ax} ${ay}Q${x} ${y} ${bx} ${by}`;
    }
    return d;
  }
  /** Connector from a parent's right edge to a child's left edge; from the workspace, a bus down each lane's spine. */
  function edgePath(p, c) {
    if (p.kind === 'ws') {
      const x1 = p.x + 20, y1 = p.y + p.h, bus = p.y + p.h + G.lane.top / 2;
      return roundPath([[x1, y1], [x1, bus], [c.spine, bus], [c.spine, c.y + c.h / 2], [c.x, c.y + c.h / 2]]);
    }
    const x1 = p.x + p.w, y1 = p.y + p.h / 2, xm = x1 + G.gapX / 2;
    return roundPath([[x1, y1], [xm, y1], [xm, c.y + c.h / 2], [c.x, c.y + c.h / 2]]);
  }

  /* ═══════════════ Nodes ═══════════════ */
  const toneStyle = tone => (HEX.test(tone || '') ? `--tone:${tone};` : '');
  const box = v => `left:${v.x}px;top:${v.y}px;width:${v.w}px;height:${v.h}px;`;
  /** Marks that help choose a document: verified or due for review, new. */
  function docMarks(d) {
    const t = trustOf(d);
    return [
      t.state === 'verified' && `<span class="an-mark" data-tip="${esc(t.note)}">${ic('shield-check', 'i-xs an-ok')}<span class="sr-only">Verified</span></span>`,
      t.state === 'review' && `<span class="an-mark" data-tip="${esc(t.note)}">${ic('clock', 'i-xs an-due')}<span class="sr-only">Review due</span></span>`,
      NOW - d.updated < NEW_DAYS * DAY && '<span class="an-new">New</span>',
    ].filter(Boolean).join('');
  }
  const docMeta = d => esc(rel(d.updated));
  const docTip = d => (docTitle(d).length > 30 ? ` data-tip="${esc(docTitle(d))}"` : '');
  function docRow(d, words) {
    return `<a class="an-row" href="#/doc/${esc(d.id)}" data-act="doc-preview" data-id="${esc(d.id)}">${fileIcon(d.type, 'sm')}<span class="an-row__title" translate="no"${docTip(d)}>${markWords(docTitle(d), words)}</span>${docMarks(d)}</a>`;
  }
  /** One node, absolutely placed in world coordinates. `cls` carries selection and dimming. */
  function nodeHtml(v, ctx) {
    const { words, u, related } = ctx;
    const cls = (extra = '') => cx('an', extra, related && (related.has(v.id) ? 'is-related' : 'is-dim'), u.sel === v.id && 'is-sel');
    const anc = v.anc ? ` data-anc="${esc(v.anc.join(' '))}"` : '';
    if (v.kind === 'ws') {
      const ws = curWs();
      return `<div class="${cls('an--ws')}" style="${box(v)}" data-id="ws"${anc}>${wsMark(ws, 32)}<span class="an__text"><span class="an__type">Workspace</span><span class="an__title" translate="no">${esc(ws.name)}</span></span></div>`;
    }
    if (v.kind === 'doc') {
      const d = v.d;
      return `<a class="${cls('an--doc')}" style="${box(v)}${toneStyle(v.tone)}" href="#/doc/${esc(d.id)}" data-act="doc-preview" data-id="${esc(d.id)}"${anc}>
        ${fileIcon(d.type, 'sm')}<span class="an__text"><span class="an__title" translate="no"${docTip(d)}>${markWords(docTitle(d), words)}</span><span class="an__meta">${docMeta(d)}</span></span>${docMarks(d)}</a>`;
    }
    if (v.kind === 'cluster') {
      const rows = v.all ? v.docs : v.docs.slice(0, CLUSTER_SHOW), rest = v.docs.length - rows.length;
      return `<div class="${cls('an--cluster')}" style="${box(v)}${toneStyle(v.tone)}" data-id="${esc(v.id)}"${anc}>
        <div class="an-cluster__head">${ic('files', 'i-sm')}<span class="an__title">${esc(plural(v.docs.length, 'document'))}</span></div>
        <div class="an-cluster__rows">${rows.map(d => docRow(d, ctx.words)).join('')}</div>
        <button type="button" class="an-cluster__more" data-act="atlas-more" data-id="${esc(v.owner)}" aria-expanded="${v.all}">${v.all ? 'Show fewer' : `+${rest} more`}</button></div>`;
    }
    if (v.kind === 'locked') {
      const kb = v.kb;
      return `<div class="${cls('an--org an--locked')}" style="${box(v)}" data-id="${esc(v.id)}"${anc}>
        <button type="button" class="an__main" data-act="atlas-select" data-id="${esc(v.id)}" aria-pressed="${u.sel === v.id}">
          <span class="an__icon">${ic('lock')}</span><span class="an__text"><span class="an__type">Restricted</span><span class="an__title" translate="no">${esc(kb.name)}</span></span></button></div>`;
    }
    const n = v.n, label = levelOf(n, n.depth);
    const handle = v.hasKids ? `<button type="button" class="an__handle" data-act="atlas-toggle" data-id="${esc(v.id)}" aria-expanded="${v.open}" aria-label="${esc(`${v.open ? 'Collapse' : 'Expand'} ${n.name}`)}" data-tip="${v.open ? 'Collapse' : 'Expand'}">${v.open ? ic('minus', 'i-xs') : `<span class="num">${v.hidden}</span>`}</button>` : '';
    return `<div class="${cls(cx('an--org', v.kind === 'root' && 'an--root'))}" style="${box(v)}${toneStyle(v.tone)}" data-id="${esc(v.id)}"${anc}>
      <button type="button" class="an__main" id="an-${esc(v.id)}" data-act="atlas-select" data-id="${esc(v.id)}" aria-pressed="${u.sel === v.id}">
        <span class="an__icon">${ic(levelIcon(label, n.depth))}</span>
        <span class="an__text"><span class="an__type">${esc(label)}</span><span class="an__title" translate="no">${markWords(n.name, words)}</span></span>
        <span class="an__count num" data-tip="${esc(plural(n.count, 'document'))}">${fmtNum(n.count)}</span></button>${handle}</div>`;
  }
  /** Width ÷ height of the canvas (before it exists: estimated from the frame), for choosing the number of lanes. */
  function canvasAspect() {
    const r = $('#atlas-vp')?.getBoundingClientRect();
    if (r?.width && r.height) return r.width / r.height;
    const f = $('#frame'), w = f?.clientWidth || innerWidth, h = f?.clientHeight || innerHeight;
    return Math.max(0.5, (w - (w >= 1024 ? 280 : 32)) / Math.max(320, h - 190));
  }
  /** Territory band: tint, the collection's mark and what it holds, and a way into Knowledge. */
  function bandHtml(t, related) {
    const kb = t.kb, dim = related && !related.has(t.v.id);
    return `<section class="${cx('atlas-band', t.locked && 'atlas-band--locked', dim && 'is-dim')}" style="left:${t.x}px;top:${t.y}px;width:${t.w}px;height:${t.h}px;${toneStyle(kb.color)}" aria-label="${esc(kb.name)}">
      <header class="atlas-band__head">${X.kbMark(kb, 20, t.locked)}<span class="atlas-band__name" translate="no">${esc(kb.name)}</span><span class="atlas-band__desc" translate="no">${esc(t.locked ? 'Restricted. Ask its owners for access.' : kb.desc || '')}</span>
      ${t.locked ? '' : `<a class="atlas-band__open" href="#${esc(kbHref(kb))}">Open in Knowledge${ic('arrow-right', 'i-xs')}</a>`}</header></section>`;
  }

  /* ═══════════════ Inspector: the selected node, without leaving the map ═══════════════ */
  function inspector(v, all) {
    if (!v) return '';
    const close = iconBtn('x', 'Close', { size: 'sm', act: 'atlas-deselect' });
    if (v.kind === 'locked') {
      const kb = v.kb, asked = (D.requests || []).some(r => r.kb === kb.id && r.user === me().id && r.status === 'pending');
      return `<aside class="atlas-inspector" aria-label="Details">
        <div class="atlas-inspector__head"><span class="an__icon">${ic('lock')}</span><div class="grow"><div class="an__type">Restricted</div><h2 class="atlas-inspector__title" translate="no">${esc(kb.name)}</h2></div>${close}</div>
        <p class="atlas-inspector__desc">Only its members can see what’s inside. Ask its owners for access.</p>
        <div class="atlas-inspector__actions">${asked ? chip('Access requested', { icon: 'clock', size: 'sm' }) : btn('Request access', { v: 'primary', size: 'sm', act: 'kb-request', data: { kb: kb.id } })}</div></aside>`;
    }
    const n = v.n, label = levelOf(n, n.depth), path = (v.anc || []).filter(id => id !== 'ws').map(id => all.get(id)?.n?.name).filter(Boolean);
    const docs = n.docs.slice(0, 5);
    // One way on: open it in Knowledge. Folding stays on the box's own handle; centring is a quiet icon by Close.
    const focus = iconBtn('target', 'Focus', { size: 'sm', act: 'atlas-focus', data: { id: v.id } });
    return `<aside class="atlas-inspector" style="${toneStyle(v.tone)}" aria-label="Details">
      <div class="atlas-inspector__head"><span class="an__icon">${ic(levelIcon(label, n.depth))}</span><div class="grow"><div class="an__type">${esc(label)}</div><h2 class="atlas-inspector__title" translate="no">${esc(n.name)}</h2></div>${focus}${close}</div>
      ${path.length ? `<p class="atlas-inspector__path" translate="no">${path.map(esc).join(' › ')}</p>` : ''}
      <p class="atlas-inspector__stats num">${esc(plural(n.count, 'document'))}${n.kids.length ? ` · ${esc(plural(n.kids.length, 'folder'))}` : ''}</p>
      ${n.desc ? `<p class="atlas-inspector__desc" translate="no">${esc(n.desc)}</p>` : ''}
      ${docs.length ? `<div class="atlas-inspector__sec"><div class="atlas-inspector__label">${n.docs.length > docs.length ? `Here · ${esc(plural(n.docs.length, 'document'))}` : 'Here'}</div>${docs.map(d => docRow(d, [])).join('')}</div>` : ''}
      <div class="atlas-inspector__actions">
        ${btn('Open in Knowledge', { v: 'secondary', size: 'sm', iconRight: 'arrow-right', href: kbHref(n.kb) })}
        ${canEditKb(n.kb) ? linkBtn('Edit in Studio', { href: kbContentsHref(n.kb, n.root ? '' : n.id), icon: 'pencil', size: 'sm' }) : ''}
      </div></aside>`;
  }

  /* ═══════════════ Canvas chrome ═══════════════ */
  function toolbar(u, total, shown) {
    const q = u.q.trim();
    return `<div class="atlas-toolbar" role="toolbar" aria-label="Map tools">
      ${searchField({ uiKey: 'home', placeholder: 'Find in the map', size: 'sm', cls: 'atlas-toolbar__search', enter: 'atlas-find' })}
      <span class="atlas-toolbar__count num" aria-live="polite">${q ? (shown ? `${plural(shown, 'document')} match` : '') : plural(total, 'document')}</span>
      <span class="atlas-toolbar__sep" aria-hidden="true"></span>
      ${iconBtn('list-tree', u.docs ? 'Hide documents' : 'Show documents', { size: 'sm', act: 'atlas-docs', aria: `aria-pressed="${!u.docs}"` })}
      ${iconBtn('chevrons', 'Expand all', { size: 'sm', act: 'atlas-expand' })}
      ${iconBtn('chevrons-down-up', 'Collapse all', { size: 'sm', act: 'atlas-collapse' })}
      ${btn('Go to', { size: 'sm', v: 'ghost', iconRight: 'chevron-down', menu: 'atlas-goto' })}
    </div>`;
  }
  const zoomBar = k => `<div class="atlas-zoom" role="toolbar" aria-label="Zoom">
    ${iconBtn('minus', 'Zoom out (−)', { size: 'sm', act: 'atlas-zoom', data: { d: '-1' } })}
    <button type="button" class="atlas-zoom__level num" data-act="atlas-zoom" data-d="0" data-tip="Zoom to 100% (0)" id="atlas-zoom-level">${Math.round(k * 100)}%</button>
    ${iconBtn('plus', 'Zoom in (+)', { size: 'sm', act: 'atlas-zoom', data: { d: '1' } })}
    <span class="atlas-toolbar__sep" aria-hidden="true"></span>
    ${iconBtn('maximize', 'Fit to view (1)', { size: 'sm', act: 'atlas-fit' })}
    ${iconBtn('refresh', 'Reset the map', { size: 'sm', act: 'atlas-reset' })}
  </div>`;
  /** The workspace's levels as a path (Faculty › Academic department › … › Document) and what the marks mean. */
  function legend(branches) {
    const depth = Math.max(1, ...branches.map(deepest)), lv = mapLevels(), path = lv.slice(0, Math.min(depth, lv.length));
    const also = new Set();
    branches.forEach(b => walkAll(b, n => { const l = levelOf(n, n.depth); if (!path.includes(l)) also.add(l); }));
    const step = l => `<li class="atlas-level">${ic(levelIcon(l, path.indexOf(l) + 1), 'i-xs')}<span>${esc(l)}</span></li>`;
    return `<div class="atlas-legend">
      <ol class="atlas-levels" aria-label="Levels of this workspace">${path.map(step).join('')}<li class="atlas-level atlas-level--leaf">${ic('file', 'i-xs')}<span>Document</span></li></ol>
      ${also.size ? `<span class="atlas-legend__also">Also: ${[...also].map(esc).join(' · ')}</span>` : ''}
      <span class="atlas-legend__marks"><span>${ic('shield-check', 'i-xs an-ok')}Verified</span><span><span class="an-new">New</span>${esc(`Changed in the last ${NEW_DAYS} days`)}</span></span>
    </div>`;
  }

  /* ═══════════════ States ═══════════════ */
  const loadingBody = () => `<div class="atlas atlas--skel" aria-busy="true" aria-label="Loading"><div class="atlas__viewport">${[0, 1, 2].map(i => `<div class="atlas-skel" style="top:${40 + i * 150}px"><span class="skeleton"></span><span class="skeleton"></span><span class="skeleton"></span></div>`).join('')}</div></div>`;
  const emptyBody = () => emptyState({
    icon: 'book', title: 'Your workspace has no published knowledge yet', boxed: true,
    desc: canContribute() ? 'Contribute documents for review. Once they’re published, the map shows where everything lives.' : 'The map fills in as documents are published.',
    actions: (canContribute() ? X.res.uploadBtn('primary') : '') + btn('Browse knowledge', { href: '/knowledge' }),
  });

  /** Index of the drawn tree: id → visual node (with its ancestors), in drawing order. */
  function indexOf(L) {
    const all = new Map();
    (function walk(v, anc) { v.anc = anc; all.set(v.id, v); v.kids.forEach(k => walk(k, [...anc, v.id])); })(L.ws, []);
    return all;
  }
  /** The selected node's path and everything under it. */
  function relatedTo(v) {
    if (!v) return null;
    const set = new Set([...v.anc, v.id]);
    (function down(x) { x.kids.forEach(k => { set.add(k.id); down(k); }); })(v);
    return set;
  }
  let last = null;   // the last drawn layout, for actions (focus, fit, go to)

  P.home = () => {
    const ws = curWs(), u = st(), state = S.navLoading ? 'loading' : S.pageState;
    const map = state === 'live' ? buildMap() : { pool: [], branches: [], locked: [] };
    const total = map.branches.reduce((a, b) => a + b.count, 0);
    const depth = map.branches.length ? Math.max(...map.branches.map(deepest)) + 1 : 0;
    const fresh = map.pool.filter(d => NOW - d.updated < 30 * DAY).length;
    const meta = total ? `<span>${plural(total, 'document')} you can read</span><span class="res-dot" aria-hidden="true">·</span><span>${plural(map.branches.length + map.locked.length, 'collection')}</span><span class="res-dot" aria-hidden="true">·</span><span>${plural(depth, 'level')}</span>${fresh ? `<span class="res-dot" aria-hidden="true">·</span><span>${fresh} updated in the last 30 days</span>` : ''}` : '';
    const head = pageHeader({
      title: ws.name, lead: wsMark(ws, 40), desc: meta,
      actions: [can('tenant.manage') && iconBtn('image', 'Map background', { act: 'home-bg', size: 'sm' }), can('knowledge.manage') && btn('Edit structure', { href: studioHref('collections'), icon: 'pencil', size: 'sm' })].filter(Boolean).join(''),
    });
    const body = gate({
      loading: loadingBody,
      empty: emptyBody,
      error: () => errorState(),
      ok: () => {
        if (!map.branches.length && !map.locked.length) return emptyBody();
        const words = queryWords(u.q), q = u.q.trim();
        const shown = words.length ? map.branches.map(b => narrow(b, words)).filter(Boolean) : map.branches;
        const matched = shown.reduce((a, b) => a + b.count, 0);
        const L = layout(shown, words.length ? [] : map.locked, u, words, canvasAspect()), all = indexOf(L);
        if (u.sel && !all.has(u.sel)) u.sel = '';
        const sel = u.sel ? all.get(u.sel) : null, related = relatedTo(sel);
        last = { L, all };
        const ctx = { words, u, related };
        // Each connector takes its child's territory colour (the workspace's own connectors included).
        const edges = [...all.values()].filter(v => v.kids.length).flatMap(p => p.kids.map(c => `<path class="${cx('ae', related && (related.has(c.id) && related.has(p.id) ? 'is-related' : 'is-dim'))}" style="${toneStyle(c.tone)}" data-to="${esc(c.id)}" d="${edgePath(p, c)}"/>`)).join('');
        const view = viewOf(u);
        const nothing = q && !shown.length ? `<div class="atlas-nomatch">${emptyState({ icon: 'search', title: `Nothing in the map matches “${q}”`, desc: 'The map searches titles and folder names. Knowledge also searches inside documents.', compact: true, actions: btn('Search in Knowledge', { href: catalogHref({ q }), icon: 'search', size: 'sm' }) })}</div>` : '';
        const bg = ws.mapBg;
        return `<div class="${cx('atlas', related && 'has-sel', zoomClass(view.k), bg && 'has-bg')}" style="--k:${view.k}">
          ${bg ? backdrop(bg, bg.strength) : ''}
          <div class="atlas__viewport" id="atlas-vp" tabindex="0" role="region" aria-label="Knowledge map. Drag to move, ⌘ or Ctrl and scroll to zoom." data-w="${L.W}" data-h="${L.H}" style="${gridStyle(view)}">
            <div class="atlas__world" id="atlas-world" style="width:${L.W}px;height:${L.H}px;transform:${tf(view)}">
              ${L.terr.map(t => bandHtml(t, related)).join('')}
              <svg class="atlas__edges" width="${L.W}" height="${L.H}" aria-hidden="true">${edges}</svg>
              ${[...all.values()].map(v => nodeHtml(v, ctx)).join('')}
            </div>
          </div>
          ${toolbar(u, total, matched)}${zoomBar(view.k)}${legend(map.branches)}${inspector(sel, all)}${nothing}
        </div>`;
      },
    });
    return `<div class="page page--canvas home">${head}${body}</div>`;
  };

  /* ═══════════════ View: pan and zoom (applied straight to the DOM; saved per workspace) ═══════════════ */
  const clampK = k => Math.min(ZOOM.max, Math.max(ZOOM.min, k));
  const zoomClass = k => (k < ZOOM.far ? 'is-far' : k >= ZOOM.near ? 'is-near' : '');
  const tf = v => `translate(${v.tx}px, ${v.ty}px) scale(${v.k})`;
  const gridStyle = v => `background-size:${20 * v.k}px ${20 * v.k}px;background-position:${v.tx}px ${v.ty}px`;
  /** This workspace's view; a first visit starts at 100 % (85 % on phones) at the top left, under the toolbar. */
  function viewOf(u = st()) {
    u.views ??= {};
    return (u.views[S.ws] ??= { k: ($('#frame')?.clientWidth || innerWidth) < 680 ? 0.85 : 1, tx: 0, ty: 40 });
  }
  function applyView(glide = false) {
    const v = viewOf(), world = $('#atlas-world'), vp = $('#atlas-vp'), atlas = vp?.closest('.atlas');
    if (!world) return;
    world.classList.toggle('is-gliding', glide && !reduced());
    world.style.transform = tf(v);
    vp.setAttribute('style', gridStyle(v));
    atlas.style.setProperty('--k', v.k);
    atlas.classList.remove('is-far', 'is-near');
    const z = zoomClass(v.k); if (z) atlas.classList.add(z);
    const lvl = $('#atlas-zoom-level'); if (lvl) lvl.textContent = Math.round(v.k * 100) + '%';
    if (glide) setTimeout(() => world.classList.remove('is-gliding'), 320);
  }
  /** Zoom by `factor` around a point of the viewport (default: its centre). */
  function zoomAt(factor, px, py) {
    const v = viewOf(), vp = $('#atlas-vp'); if (!vp) return;
    const r = vp.getBoundingClientRect();
    px ??= r.width / 2; py ??= r.height / 2;
    const k = clampK(v.k * factor), s = k / v.k;
    v.tx = px - (px - v.tx) * s; v.ty = py - (py - v.ty) * s; v.k = k;
  }
  /** Fit a world rectangle (default: the whole atlas) into the viewport. */
  function fitTo(rect, maxK = 1) {
    const vp = $('#atlas-vp'); if (!vp) return;
    const r = vp.getBoundingClientRect(), v = viewOf(), m = 24;
    rect ??= { x: 0, y: 0, w: +vp.dataset.w, h: +vp.dataset.h };
    v.k = clampK(Math.min((r.width - 2 * m) / rect.w, (r.height - 2 * m) / rect.h, maxK));
    v.tx = m + ((r.width - 2 * m) - rect.w * v.k) / 2 - rect.x * v.k;
    v.ty = m - rect.y * v.k;
  }
  /** Bring a node into view at a readable zoom, centred a little above the middle (its parent stays in sight to the left). */
  function focusNode(id) {
    const vn = last?.all.get(id), vp = $('#atlas-vp'); if (!vn || !vp) return;
    const v = viewOf(), r = vp.getBoundingClientRect();
    v.k = clampK(Math.max(v.k, 0.9));
    v.tx = r.width / 2 - (vn.x + vn.w / 2) * v.k;
    v.ty = r.height * 0.42 - (vn.y + vn.h / 2) * v.k;
    applyView(true);
  }
  /** Re-render keeping `id`'s box where it was on screen (folding never moves what you clicked). */
  function keepInPlace(id, change) {
    const el = $(`.an[data-id="${CSS.escape(id)}"]`), before = el?.getBoundingClientRect();
    change(); refresh();
    const after = $(`.an[data-id="${CSS.escape(id)}"]`)?.getBoundingClientRect();
    if (before && after) { const v = viewOf(); v.tx += before.left - after.left; v.ty += before.top - after.top; applyView(); }
  }

  /* Pointer: drag the background to pan; two fingers pinch to zoom. Wheel: pan; ⌘/Ctrl + wheel (and trackpad pinch) zooms. */
  const pointers = new Map();
  let drag = null;
  document.addEventListener('pointerdown', e => {
    const vp = e.target.closest?.('#atlas-vp');
    if (!vp || e.target.closest('button, a, input, .an--cluster') || e.button > 0) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const v = viewOf();
    drag = { x: e.clientX, y: e.clientY, tx: v.tx, ty: v.ty, k: v.k, dist: 0, moved: false };
    if (pointers.size === 2) { const [a, b] = [...pointers.values()]; drag.dist = Math.hypot(a.x - b.x, a.y - b.y); drag.mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }
    vp.setPointerCapture?.(e.pointerId);
    vp.classList.add('is-grabbing');
  });
  document.addEventListener('pointermove', e => {
    if (!drag || !pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const v = viewOf(), vp = $('#atlas-vp'); if (!vp) return;
    if (pointers.size === 2 && drag.dist) {
      const [a, b] = [...pointers.values()], r = vp.getBoundingClientRect();
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      zoomAt(dist / drag.dist, drag.mid.x - r.left, drag.mid.y - r.top); drag.dist = dist;
    } else {
      v.tx = drag.tx + e.clientX - drag.x; v.ty = drag.ty + e.clientY - drag.y;
      drag.moved ||= Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y) > 3;
    }
    applyView();
  });
  const endDrag = e => {
    pointers.delete(e.pointerId);
    if (pointers.size) return;
    const was = drag; drag = null;
    $('#atlas-vp')?.classList.remove('is-grabbing');
    // A click on the empty canvas (not a drag) clears the selection.
    if (was && !was.moved && st().sel && e.target.closest?.('#atlas-vp') && !e.target.closest('.an')) { st().sel = ''; refresh(); }
  };
  document.addEventListener('pointerup', endDrag);
  document.addEventListener('pointercancel', endDrag);
  document.addEventListener('wheel', e => {
    const vp = e.target.closest?.('#atlas-vp'); if (!vp) return;
    e.preventDefault();
    const v = viewOf();
    if (e.ctrlKey || e.metaKey) { const r = vp.getBoundingClientRect(); zoomAt(Math.exp(-e.deltaY * 0.01), e.clientX - r.left, e.clientY - r.top); }
    else { v.tx -= e.shiftKey ? e.deltaY : e.deltaX; v.ty -= e.shiftKey ? 0 : e.deltaY; }
    applyView();
  }, { passive: false });
  /* Keyboard on the canvas: arrows pan, + / − zoom, 0 = 100 %, 1 = fit, Esc clears the selection. */
  document.addEventListener('keydown', e => {
    const onMap = e.target.closest?.('#atlas-vp'), inAtlas = e.target.closest?.('.atlas');
    if (e.key === 'Escape' && inAtlas && st().sel && !S.modal && !S.menu) { st().sel = ''; refresh(); $('#atlas-vp')?.focus(); return; }
    if (!onMap || e.metaKey || e.ctrlKey || e.altKey) return;
    const v = viewOf(), step = e.shiftKey ? 240 : 80;
    const keys = { ArrowLeft: () => (v.tx += step), ArrowRight: () => (v.tx -= step), ArrowUp: () => (v.ty += step), ArrowDown: () => (v.ty -= step), '+': () => zoomAt(1.2), '=': () => zoomAt(1.2), '-': () => zoomAt(1 / 1.2), '0': () => zoomAt(1 / v.k), '1': () => fitTo() };
    if (!keys[e.key]) return;
    e.preventDefault(); keys[e.key](); applyView(['0', '1'].includes(e.key));
  });
  /* Hovering a node lights its path back to the workspace. */
  document.addEventListener('mouseover', e => {
    const n = e.target.closest?.('.atlas .an'); if (!n || n.contains(e.relatedTarget)) return;
    const ids = [...(n.dataset.anc || '').split(' '), n.classList.contains('an--doc') ? 'd:' + n.dataset.id : n.dataset.id].filter(Boolean);
    $$('.atlas .ae.is-hot').forEach(p => p.classList.remove('is-hot'));
    ids.forEach(id => $(`.atlas .ae[data-to="${CSS.escape(id)}"]`)?.classList.add('is-hot'));
  });
  document.addEventListener('mouseout', e => { if (e.target.closest?.('.atlas .an') && !e.relatedTarget?.closest?.('.atlas .an')) $$('.atlas .ae.is-hot').forEach(p => p.classList.remove('is-hot')); });

  /* ═══════════════ Actions ═══════════════ */
  A['atlas-select'] = el => { const u = st(), id = el.dataset.id; u.sel = u.sel === id ? '' : id; keepInPlace(id, () => {}); $(`.an[data-id="${CSS.escape(id)}"] .an__main`)?.focus(); };
  A['atlas-deselect'] = () => { const id = st().sel; st().sel = ''; refresh(); $(`.an[data-id="${CSS.escape(id)}"] .an__main`)?.focus(); };
  A['atlas-toggle'] = el => {
    const u = st(), id = el.dataset.id, vn = last?.all.get(id); if (!vn) return;
    keepInPlace(id, () => { u.collapsed[id] = !!vn.open; });
    $(`.an[data-id="${CSS.escape(id)}"] .an__handle`)?.focus();
  };
  A['atlas-more'] = el => { const id = el.dataset.id, key = 'c:' + id; keepInPlace(key, () => { st().more[id] = !st().more[id]; }); $(`.an[data-id="${CSS.escape(key)}"] .an-cluster__more`)?.focus(); };
  A['atlas-docs'] = () => { const u = st(); u.docs = !u.docs; refresh(); };
  A['atlas-expand'] = () => { Object.assign(st(), { collapsed: {}, all: true, docs: true }); refresh(); };
  /** Collapse all: every territory shows only its first level, so the whole workspace fits on a screen. */
  A['atlas-collapse'] = () => {
    const u = st(); u.all = false; u.more = {}; u.collapsed = {};
    last?.all.forEach(v => { if (v.kind === 'org') u.collapsed[v.id] = true; });
    refresh(); fitTo(); applyView(true);
  };
  A['atlas-zoom'] = el => { const d = +el.dataset.d; zoomAt(d > 0 ? 1.25 : d < 0 ? 0.8 : 1 / viewOf().k); applyView(true); };
  A['atlas-fit'] = () => { fitTo(); applyView(true); };
  A['atlas-reset'] = () => { const u = st(); Object.assign(u, { collapsed: {}, more: {}, all: false, docs: true, sel: '', q: '', lanes: {} }); delete u.views[S.ws]; refresh(); applyView(true); };
  A['atlas-focus'] = el => focusNode(el.dataset.id);
  /** Enter in Find: bring the first match into view. */
  A['atlas-find'] = () => {
    const hit = [...(last?.all.values() || [])].find(v => v.kind === 'doc' || (v.kind === 'org' && wordHits(v.n.name, queryWords(st().q))));
    if (hit) focusNode(hit.id);
  };
  // Go to clears the selection: a selected box elsewhere would leave the territory you went to dimmed.
  MENUS['atlas-goto'] = () => (last?.L.terr || []).map(t => ({ label: t.kb.name, icon: t.locked ? 'lock' : 'building', run: () => { st().collapsed[t.kb.id] = false; st().sel = ''; refresh(); fitTo({ x: t.x, y: t.y, w: t.w, h: t.h }, 1); applyView(true); } }));

  /* ═══════════════ Map background (workspace admins) ═══════════════ */
  /** Strength 0–100: how much of the image shows through its wash (0 = a faint tint, 100 = clearly visible). */
  const BG_DEFAULT = 25;
  const strengthOf = v => (Number.isFinite(+v) ? Math.min(100, Math.max(0, Math.round(+v))) : BG_DEFAULT);
  const BG_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/svg+xml'], BG_MAX = 10 * 1024 * 1024, BG_W = 1920, BG_SMALL = 1200;
  /** The image under its wash: Home's canvas, the dialog's preview and the Settings thumbnail. --s (0–1) drives the wash, blur
      and saturation in CSS, so a slider can change it without a re-render. */
  const backdrop = (bg, strength = BG_DEFAULT, cls = '') => `<div class="${cx('atlas__backdrop', cls)}" style="background-image:url(&quot;${esc(bg.src)}&quot;);--s:${strengthOf(strength) / 100}" aria-hidden="true"></div>`;
  const bgForm = () => S.ui.homeBg;
  const audit = (action, target) => D.audit.unshift({ id: uid('ev'), at: Date.now(), actor: me().id, action, type: 'Settings', target, outcome: 'success', ip: '10.4.12.30', device: 'Chrome on macOS' });
  /** Opened from Home's header and from Settings → Workspace setup; the draft starts from what's saved. */
  A['home-bg'] = () => {
    if (!can('tenant.manage')) return;
    const bg = curWs().mapBg;
    S.ui.homeBg = { draft: bg ? { ...bg } : null, strength: strengthOf(bg?.strength), err: '', busy: false };
    openModal('home-bg');
  };
  M['home-bg'] = () => {
    const f = bgForm() || {}, ws = curWs(), d = f.draft;
    // The preview draws the workspace and its first collections over the image, so the admin sees what people will read.
    const kbs = D.kbs.filter(k => !k.personal && !k.archived && !k.hidden).slice(0, 3);
    const map = `<div class="mapbg-preview__map" aria-hidden="true"><span class="mapbg-node mapbg-node--ws">${ic('building', 'i-sm')}<span class="truncate" translate="no">${esc(ws.name)}</span></span>${kbs.map(k => `<span class="mapbg-node" style="--tone:${esc(k.color || 'var(--accent)')}"><span class="mapbg-node__dot"></span><span class="truncate" translate="no">${esc(k.name)}</span></span>`).join('')}</div>`;
    const empty = `<div class="mapbg-preview__empty">${ic('image')}<span>${esc('Drop an image here')}</span>${btn('Choose image', { size: 'sm', icon: 'upload', act: 'home-bg-pick' })}</div>`;
    const preview = `<div class="${cx('mapbg-preview', d && 'has-img')}" data-drop="home-bg">${d ? backdrop(d, f.strength) : ''}<div class="mapbg-preview__grid"></div>${d ? map : empty}${f.busy ? `<div class="mapbg-preview__busy">${spinner()}</div>` : ''}</div>`;
    const small = d?.w && d.w < BG_SMALL && !/\.svg$/i.test(d.name || '') ? `<p class="mapbg-warn">${ic('alert', 'i-sm')}<span>${esc(`This image is ${d.w} px wide, so it may look soft on large screens.`)}</span></p>` : '';
    const file = d ? `<div class="mapbg-file">${ic('image', 'i-sm')}<span class="truncate" translate="no">${esc(d.name || 'Background')}</span>${d.w ? `<span class="muted num none">${esc(`${d.w} × ${d.h}`)}</span>` : ''}<span class="grow"></span>${btn('Replace', { v: 'ghost', size: 'sm', icon: 'upload', act: 'home-bg-pick' })}</div>` : '';
    const strength = d ? slider({ id: 'home-bg-strength', value: f.strength, step: 5, input: 'home-bg-strength', label: 'Strength', valueText: `${f.strength}%`, ends: ['Subtle', 'Vivid'] }) : '';
    const err = f.err ? `<div class="field-error" role="alert">${ic('alert-circle')}<span>${esc(f.err)}</span></div>` : '';
    const hint = d ? '' : `<p class="description">${esc('A wide photo or illustration, at least 1600 px wide. JPG, PNG, WebP or SVG, up to 10 MB.')}</p>`;
    return {
      size: 'md', icon: 'image', title: 'Map background',
      desc: esc(`Shown behind the knowledge map on Home for everyone in ${ws.name}. It's softened so the map stays readable.`),
      body: `<div class="mapbg">${preview}${err}${file}${small}${strength}${hint}</div>`,
      footStart: d ? btn('Remove', { v: 'ghost', size: 'sm', icon: 'trash', act: 'home-bg-remove' }) : '',
      foot: btn('Cancel', { v: 'ghost', act: 'close-modal' }) + btn('Save', { v: 'primary', act: 'home-bg-save', disabled: !!f.busy }),
    };
  };
  A['home-bg-pick'] = () => {
    const inp = document.createElement('input'); inp.type = 'file'; inp.accept = BG_TYPES.join(','); inp.hidden = true;
    inp.addEventListener('change', () => { readBg(inp.files?.[0]); inp.remove(); });
    document.body.append(inp); inp.click();
  };
  /** While dragging, the preview follows directly (no re-render, so the slider keeps its grip). */
  A['home-bg-strength'] = el => {
    const f = bgForm(); if (!f) return;
    f.strength = strengthOf(el.value); setSlider(el, `${f.strength}%`);
    $('.mapbg-preview .atlas__backdrop')?.style.setProperty('--s', f.strength / 100);
  };
  A['home-bg-remove'] = () => { const f = bgForm(); if (!f) return; f.draft = null; f.err = ''; refreshLayer(); };
  /** Check the file, then keep a copy small enough to store with the workspace. */
  async function readBg(file) {
    const f = bgForm(); if (!file || !f) return;
    if (!BG_TYPES.includes(file.type)) { f.err = 'Use a JPG, PNG, WebP or SVG image.'; refreshLayer(); return; }
    if (file.size > BG_MAX) { f.err = 'That image is larger than 10 MB. Choose a smaller one.'; refreshLayer(); return; }
    f.err = ''; f.busy = true; refreshLayer();
    try { f.draft = { ...(await toBackground(file)), name: file.name }; } catch (_) { f.err = 'That image couldn’t be read. Try another file.'; }
    f.busy = false; refreshLayer();
  }
  /** Read an image; unless it's SVG, scale it to at most BG_W px wide as a JPEG. */
  function toBackground(file) {
    return new Promise((resolve, reject) => {
      const rd = new FileReader(); rd.onerror = reject;
      rd.onload = () => {
        const img = new Image(); img.onerror = reject;
        img.onload = () => {
          const w = img.naturalWidth || 1600, h = img.naturalHeight || 900;
          if (file.type === 'image/svg+xml') { resolve({ src: rd.result, w, h }); return; }
          const s = Math.min(1, BG_W / w), c = document.createElement('canvas');
          c.width = Math.round(w * s); c.height = Math.round(h * s);
          c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
          resolve({ src: c.toDataURL('image/jpeg', 0.75), w: c.width, h: c.height });
        };
        img.src = rd.result;
      };
      rd.readAsDataURL(file);
    });
  }
  // Dropping an image on the preview picks it.
  const dropZone = e => e.target.closest?.('[data-drop="home-bg"]');
  document.addEventListener('dragover', e => { const z = dropZone(e); if (!z) return; e.preventDefault(); z.classList.add('is-over'); });
  document.addEventListener('dragleave', e => dropZone(e)?.classList.remove('is-over'));
  document.addEventListener('drop', e => { const z = dropZone(e); if (!z) return; e.preventDefault(); z.classList.remove('is-over'); readBg(e.dataTransfer?.files?.[0]); });
  /** Saved on the workspace for everyone, with Undo. */
  A['home-bg-save'] = () => {
    const f = bgForm(), ws = curWs(); if (!f || f.busy || !can('tenant.manage')) return;
    const before = ws.mapBg ? { ...ws.mapBg } : null;
    const next = f.draft ? { src: f.draft.src, name: f.draft.name, w: f.draft.w, h: f.draft.h, strength: f.strength, by: me().id, at: Date.now() } : null;
    closeModal(); S.ui.homeBg = null;
    if ((before?.src || '') === (next?.src || '') && strengthOf(before?.strength) === strengthOf(next?.strength)) return;
    const set = v => { if (v) ws.mapBg = v; else delete ws.mapBg; persist(); refresh(); };
    set(next);
    audit(next ? 'Changed the Home map background' : 'Removed the Home map background', next?.name || before?.name || '');
    toast(next ? (before ? 'Map background updated' : 'Map background added') : 'Map background removed', { action: { label: 'Undo', run: () => set(before) } });
  };
  X.homeBg = { backdrop, strengthOf };
  AFTER.home = () => applyView();
})();
