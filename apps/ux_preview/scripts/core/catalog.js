'use strict';
/* Knowledge catalog — the resource model behind Knowledge (Discover, Browse,
   the personal sections, Reader), Knowledge Studio → Documents and Knowledge health.

   Concepts (one meaning each):
   - Source          where content comes from (a connector source or an upload). Provenance only.
   - Resource        one canonical document (D.docs). Lives in exactly one collection.
   - Collection      the governed home of resources: ownership + access boundary. Never names a space.
   - Space/context   a course, group, office, team or project. A space links documents as its materials
                     (doc.contexts) without copying them.
   - Topic           the workspace taxonomy (domain → topic), D.topics.
   - Type            the document's file class (PDF, Word, Spreadsheet…), derived from its file; never edited.
   - Saved view      a stored Browse query (D.views), kept and managed in Browse's Filters.
   Browse = the organization's knowledge (topics, filters). My library = saved + my files
   + contributions. Managing collections (access, sources, settings) is Manage → Collections.

   Feature code reads metadata through res(doc), so derived defaults apply everywhere and
   resources without hand-written metadata (uploads, synced files) still work. Workspace-
   neutral: nothing here knows about UTE or Northwind. */

/* ═══════════════ Document type: the file class ═══════════════
   What the file is, derived from its format (the backend's items.item_type for documents). Not a business category:
   nobody picks or edits it, and every version of a document keeps the same class. */
const DOC_TYPES = {
  pdf: { label: 'PDF', icon: 'file-text' },
  word: { label: 'Word', icon: 'file-text' },
  presentation: { label: 'Presentation', icon: 'monitor' },
  spreadsheet: { label: 'Spreadsheet', icon: 'table' },
  markdown: { label: 'Markdown', icon: 'file-text' },
  html: { label: 'HTML', icon: 'globe' },
  plain_text: { label: 'Plain text', icon: 'file' },
  data: { label: 'Data', icon: 'database' },
  image: { label: 'Image', icon: 'image' },
  audio: { label: 'Audio', icon: 'music' },
  video: { label: 'Video', icon: 'video' },
  archive: { label: 'Compressed file', icon: 'archive' },
  other: { label: 'Other', icon: 'file' },
};
/** File extension → file class. Anything unlisted is Other. */
const EXT_TYPES = {
  pdf: 'pdf', doc: 'word', docx: 'word', ppt: 'presentation', pptx: 'presentation',
  xls: 'spreadsheet', xlsx: 'spreadsheet', csv: 'spreadsheet', tsv: 'spreadsheet',
  md: 'markdown', markdown: 'markdown', rst: 'markdown', html: 'html', htm: 'html',
  txt: 'plain_text', log: 'plain_text', sql: 'plain_text', json: 'data', jsonl: 'data', xml: 'data', yaml: 'data', yml: 'data',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', svg: 'image',
  mp3: 'audio', wav: 'audio', m4a: 'audio', mp4: 'video', mov: 'video', webm: 'video', zip: 'archive',
};
/** A document's file class id (doc.type is its file extension). */
const docType = doc => EXT_TYPES[String(doc?.type || '').toLowerCase()] || 'other';
const typeMeta = doc => DOC_TYPES[docType(doc)];
const LANGS = { en: 'English', vi: 'Vietnamese' };

/* ═══════════════ Topics (workspace taxonomy) ═══════════════ */
const topicById = id => (D.topics || []).find(t => t.id === id);
const topicName = id => topicById(id)?.name || 'Untitled topic';
/** Domains with their topics, in seed order. Archived topics stay resolvable by id but aren't offered. */
const topicTree = () => (D.topics || []).filter(t => !t.parent && !t.archived).map(d => ({ ...d, children: D.topics.filter(t => t.parent === d.id && !t.archived) }));
/** A topic and its domain (selecting a domain matches everything under it). */
const topicLineage = id => { const t = topicById(id); return t ? (t.parent ? [t.parent, t.id] : [t.id]) : []; };
/** Topics as removable chips beside an "Add topic…" select (Contribute's Check the details, the Process dialog).
    Fires A[`${act}-remove`] (data-topic) and A[`${act}-add`] (the select's value: a topic id, or `domain:<id>` when
    `domains` offers whole domains). `data` goes on both. `limit` shows that many chips and a "+N more" toggle
    (A[`${act}-more`]) unless `expanded`; `quiet` uses neutral chips (settings, not the document's own metadata). */
function topicPicker({ id, ids, act, data = {}, label, empty = '', domains = false, limit = 0, expanded = false, quiet = false }) {
  const shown = limit && !expanded && ids.length > limit + 1 ? ids.slice(0, limit) : ids;
  const chips = shown.map(t => `<span class="topic-pick__chip"><span class="truncate" translate="no">${esc(topicName(t))}</span><button type="button" class="topic-pick__x" data-act="${act}-remove" ${dataAttrs({ ...data, topic: t })} aria-label="${esc(`Remove ${topicName(t)}`)}">${ic('x', 'i-xs')}</button></span>`).join('');
  const more = shown.length < ids.length ? `<button type="button" class="topic-pick__more" data-act="${act}-more" ${dataAttrs(data)}>${esc(`+${ids.length - shown.length} more`)}</button>` : '';
  const opts = [['', 'Add topic…'], ...topicTree().flatMap(dm => {
    const left = dm.children.filter(t => !ids.includes(t.id));
    return [...(domains && left.length > 1 ? [[`domain:${dm.id}`, `${dm.name} · all topics`]] : []), ...left.map(t => [t.id, `${dm.name} · ${t.name}`])];
  })];
  const add = opts.length > 1 ? select({ id, value: '', options: opts, change: `${act}-add`, size: 'sm', cls: 'topic-pick__add', label: 'Add topic', attrs: dataAttrs(data) }) : '';
  return `<div class="${cx('topic-pick', quiet && 'topic-pick--quiet')}" role="group" aria-label="${esc(label)}">${chips || (empty ? `<span class="t-sm muted">${esc(empty)}</span>` : '')}${more}${add}</div>`;
}

/* ═══════════════ Resource metadata ═══════════════ */
const READABLE_STATUS = ['ready', 'outdated'];
/** Catalog records that are reader-facing: index status is an editor concern. */
const isReaderVisible = doc => [...READABLE_STATUS, 'unsupported'].includes(doc.status);
const isSearchable = doc => READABLE_STATUS.includes(doc.status);
function ownerOfKb(kb) {
  if (!kb) return '';
  if (kb.unit) return kb.unit;
  const o = (kb.shares || []).find(s => s.role === 'owner');
  return o ? (o.kind === 'group' ? groupById(o.id)?.name : memberById(o.id)?.name) || '' : '';
}
/** Spaces a resource belongs to: the spaces that link it as a material. Spaces module only. */
function resContexts(doc) {
  if (!hasModule('spaces')) return [];
  return [...new Set(doc.contexts || [])].filter(id => { const sp = spaceById(id); return sp && !sp.archived; });
}
/** Where the resource came from: { key, app, name, path, url }. key = source id or 'upload'. */
function provenance(doc) {
  const src = doc.source && doc.source !== 'upload' ? srcById(doc.source) : null;
  if (!src) return { key: 'upload', app: 'upload', name: 'Uploaded file', path: doc.path || `Uploaded by ${doc.addedBy === 'You' ? 'you' : doc.addedBy}`, url: '' };
  const path = doc.path || [...(src.scope?.[0] ? [src.scope[0]] : []), doc.name].join(' / ');
  return { key: src.id, app: src.app, name: src.name, path, url: doc.url || `${APPS[src.app]?.url || 'https://source.example'}/${encodeURIComponent(doc.id)}` };
}
function defaultSummary(doc) {
  return `${typeMeta(doc).label} in ${kbById(doc.kb)?.name || 'this collection'}.`;
}
/** A resource's topics without building the whole record (lists that facet or filter thousands of documents). */
const resTopics = doc => doc.topics || kbById(doc.kb)?.topics || [];
/** Everything the catalog knows about a resource. Cheap for one; use docType / resTopics across thousands. */
function res(doc) {
  const kb = kbById(doc.kb);
  return {
    topics: resTopics(doc),
    contexts: resContexts(doc),
    owner: doc.owner || ownerOfKb(kb) || '',
    lang: doc.lang || 'en',
    version: doc.version || 1,
    versions: doc.versions || [{ v: doc.version || 1, at: doc.updated, by: doc.addedBy, note: 'Current version' }],
    summary: doc.summary || defaultSummary(doc),
    source: provenance(doc),
    kb,
  };
}
/** The one display title of a document (Foundation's bareName: its name without the file extension — the format badge says PDF/MD).
    Rows, cards, the Reader, previews, crumbs and Edit details all use it. */
const docTitle = doc => bareName(doc?.name);

/* ═══════════════ Trust (verification + freshness) ═══════════════ */
const TRUST = {
  verified: { tone: 'success', label: 'Verified', icon: 'shield-check', desc: 'An owner confirmed it is accurate and current.' },
  review: { tone: 'warning', label: 'Review due', icon: 'clock', desc: 'It may be out of date. Check with the owner before relying on it.' },
  unverified: { tone: 'default', label: 'Not verified', icon: 'circle-dashed', desc: 'No owner has confirmed it yet.' },
  personal: { tone: 'default', label: 'Your file', icon: 'user', desc: 'Only you can see it.' },
};
/** { state, label, tone, icon, desc, by, at, due, note }. Outdated at the source or past the review date → review. */
function trustOf(doc) {
  const kb = kbById(doc.kb), v = doc.verify;
  if (kb?.personal) return { state: 'personal', ...TRUST.personal };
  if (doc.status === 'outdated') return { state: 'review', ...TRUST.review, by: v?.by, at: v?.at, due: v?.due, note: 'The original changed at the source. Answers use the previous version until it’s reprocessed.' };
  if (v?.state === 'verified') {
    if (v.due && v.due < Date.now()) return { state: 'review', ...TRUST.review, by: v.by, at: v.at, due: v.due, note: `Verification expired ${fmtDate(v.due)}.` };
    return { state: 'verified', ...TRUST.verified, by: v.by, at: v.at, due: v.due, note: `Verified by ${v.by} on ${fmtDate(v.at)}${v.due ? ` · next review ${fmtDate(v.due)}` : ''}.` };
  }
  return { state: 'unverified', ...TRUST.unverified, note: 'No owner has confirmed this resource yet.' };
}
/** Fictional-data marker for demo workspaces (curWs().demo holds the explanation). */
const isDemoWs = () => !!curWs()?.demo;

/* ═══════════════ Structure: folders (nested collections) ═══════════════
   A collection holds folders (D.folders: { id, kb, parent, name, order, desc?, level?, own? }) and documents (doc.folder;
   none = its top level). A folder uses its collection's access unless it has its own (`own: { shares }`, the backend's
   inheritAccess = false): then only the people and groups it names read it and everything under it — workspace admins
   always. The collection's own people don't reach inside: a collection grant never overrides a folder's own access. */
const folderById = id => (id && (D.folders || []).find(f => f.id === id)) || null;
/** A collection's folders directly under `parent` (null = its top level), in their sibling order. */
const foldersIn = (kbId, parent = null) => (D.folders || []).filter(f => f.kb === kbId && (f.parent || null) === parent)
  .sort((a, b) => (a.order ?? 1e9) - (b.order ?? 1e9) || a.name.localeCompare(b.name));
/** The folders from the collection's top level down to this one ([] for the top level). */
function folderPath(id) {
  const out = [], seen = new Set();
  for (let f = folderById(id); f && !seen.has(f.id); f = folderById(f.parent)) { seen.add(f.id); out.unshift(f); }
  return out;
}
/** This folder and every folder under it. */
const folderSubtree = id => [id, ...(D.folders || []).filter(f => f.parent === id).flatMap(f => folderSubtree(f.id))];
/** The folder a document sits in, if it belongs to the document's own collection (a reviewer can file a submission
    elsewhere, leaving a stale folder behind); null = the collection's top level. */
const docFolder = d => (folderById(d?.folder)?.kb === d?.kb ? d.folder : null);
/** Where access is decided for what's in this folder: the nearest folder with its own access, else null (the collection). */
const accessFolder = id => [...folderPath(id)].reverse().find(f => f.own) || null;
const coversMe = s => (s.kind === 'user' ? s.id === me().id : !!memberById(me().id)?.groups.includes(s.id));
/** May the caller read inside this folder? (Its collection's access is checked separately.) */
const canReadFolder = id => { const b = accessFolder(id); return !b || isAdmin() || b.own.shares.some(coversMe); };
/** What each level is: one icon per kind (identity), wherever it sits — the knowledge map and the Studio's Contents share it. */
const LEVEL_ICON = {
  Faculty: 'building', 'Academic department': 'network', 'Program group': 'layers', Major: 'graduation', 'Administrative office': 'briefcase', Forms: 'clipboard',
  Area: 'library', Section: 'layers', Subsection: 'network', Folder: 'folder',
};
const DEPTH_ICON = ['landmark', 'building', 'network', 'layers', 'folder'];
/** The label of a container at a depth (root collection = 1): its own level when it names one of the workspace's levels, else its depth's. */
function levelOf(node, depth) {
  const lv = mapLevels();
  if (node?.level && lv.includes(node.level)) return node.level;
  return lv[Math.min(depth, lv.length) - 1] || 'Folder';
}
const levelIcon = (label, depth) => LEVEL_ICON[label] || DEPTH_ICON[Math.min(depth, DEPTH_ICON.length - 1)];

/* ═══════════════ Access-aware pools ═══════════════ */
/** Published = past review (the lifecycle lives in core/lifecycle.js). Submissions, rejected and unpublished documents never reach readers, search or the assistant. */
const isPublishedStage = d => !d.stage || d.stage === 'published';
/** Published resources the caller may read (any publishing status). Authorization happens here, before any listing, search or AI use. */
const readableResources = () => D.docs.filter(d => { const kb = kbById(d.kb); return !d.archived && isPublishedStage(d) && kb && !kb.archived && canReadKb(kb) && canReadFolder(docFolder(d)); });
/** Every published resource the caller can use, My files included (search, ⌘K, the assistant). */
const catalogPool = () => readableResources().filter(isReaderVisible);
/** What Browse lists: the organization's public knowledge — published (past review), processed (ready or outdated), in a
    shared collection. Uploads stay in My files; a contribution appears once it is approved and processed. */
const sharedPool = () => catalogPool().filter(d => isSearchable(d) && !kbById(d.kb)?.personal);
const canOpenRes = doc => !!doc && !doc.archived && isPublishedStage(doc) && canReadKb(kbById(doc.kb)) && !kbById(doc.kb)?.archived && canReadFolder(docFolder(doc));
/** Where a collection opens for reading: its documents in Browse (a locked base offers Request access there); My files in My library. */
const kbHref = kb => (!kb ? '/knowledge' : kb.personal ? '/knowledge/library?tab=files' : catalogHref({ filters: { kb: [kb.id] } }));
/** Bases the caller manages (owner or editor) — Manage → Collections. */
const managedKbs = () => visibleKbs().filter(k => !k.personal && canEditKb(k));
const canManageKbs = () => can('knowledge.manage') || managedKbs().length > 0;
/** A managed base's page (contents, access, sources, settings), under Knowledge Studio → Collections. */
const kbManageHref = (kb, tab = '') => '/studio/collections/' + kb.id + (tab ? '?tab=' + tab : '');
/** A collection's Contents, opened on one of its folders (none = its top level). */
const kbContentsHref = (kb, folder = '') => '/studio/collections/' + kb.id + '?' + new URLSearchParams({ tab: 'contents', ...(folder ? { folder } : {}) });
/** Knowledge Studio addresses: a tab, optionally with a view (Sources: sources | history | accounts) and more query. */
const studioHref = (tab, q = {}) => '/studio?' + new URLSearchParams({ tab, ...q });
/** Knowledge Studio → Documents: view all (the registry; processing = a processing state, quality = reverify | details |
    duplicates), processing (what isn't processed yet; state = pending | processing | failed | outdated) or review
    (processed submissions, new versions and what a sync held back). */
const docsHref = (view = 'all', q = {}) => studioHref('documents', { view, ...q });
/** Knowledge Studio → Topics: view topics (the tree and a topic's detail; node = a topic) or suggestions (what the
    assistant left for people and what reviewers' corrections suggest). */
const topicsHref = (view = 'topics', q = {}) => studioHref('topics', { view, ...q });
const onStudioTab = (tab, view) => S.cur?.r.page === 'studio' && S.cur.query.tab === tab && (!view || (S.cur.query.view || '') === view);

/* ═══════════════ Search ═══════════════ */
const _textCache = new Map();
/** Full text of a searchable resource (cached per version). */
function resText(doc) {
  if (!isSearchable(doc) || !X.docText) return '';
  const key = doc.id + '|' + doc.updated + '|' + doc.status;
  if (!_textCache.has(key)) _textCache.set(key, X.docText(doc));
  return _textCache.get(key);
}
/** Lowercase and strip diacritics one character at a time, so indexes in the folded text match the original ("Lịch" → "lich"). */
const fold = s => String(s ?? '').toLowerCase().replace(/[^\u0000-\u007f]/g, c => (c === 'đ' ? 'd' : c.normalize('NFD').replace(/[\u0300-\u036f]/g, '').charAt(0) || c));
const STOPWORDS = new Set('a an and are as at be by can do does for from how i if in is it me my of on or our the their to was we what when where which who why will with you your about this that these those there any all after before'.split(' '));
/** Query words worth matching (folded, no stopwords). */
const tokens = q => fold(q).replace(/[“”"]/g, ' ').split(/[^\p{L}\p{N}]+/u).filter(w => w.length > 1 && !STOPWORDS.has(w));
/** Relevance of a resource to tokens; 0 = no match. Most query words (60%) must appear somewhere. Metadata (title, summary, topics…)
    outweighs body text, and a resource whose metadata covers every word ranks above one that only mentions some in passing. */
function scoreRes(doc, toks) {
  if (!toks.length) return 1;
  const r = res(doc);
  const fields = [
    [doc.name, 4], [r.summary, 3], [r.topics.map(topicName).join(' '), 3], [typeMeta(doc).label, 2],
    [r.owner, 1.5], [r.kb?.name, 1.5], [r.contexts.map(id => { const s = spaceById(id); return s ? s.name + ' ' + (s.code || '') : ''; }).join(' '), 2],
  ].map(([t, w]) => [fold(t), w]);
  let score = 0, hits = 0, inMeta = 0, text = null;
  for (const t of toks) {
    let s = 0;
    fields.forEach(([f, w]) => { if (f.includes(t)) s += w; });
    if (s) inMeta++;
    else { text ??= fold(resText(doc)); if (text.includes(t)) s = 1; }
    if (s) { hits++; score += s; }
  }
  if (hits < Math.max(1, Math.ceil(toks.length * 0.6))) return 0;
  return score * (hits / toks.length) + (inMeta === toks.length ? 3 : 0) + (trustOf(doc).state === 'verified' ? 0.5 : 0);
}
/** A short excerpt around the first query word found in the text, HTML-escaped with <mark>s. */
function resSnippet(doc, q) {
  const toks = tokens(q); if (!toks.length) return '';
  const text = resText(doc); const low = fold(text);
  const i = toks.map(t => low.indexOf(t)).filter(x => x >= 0).sort((a, b) => a - b)[0];
  if (i == null) return '';
  const start = Math.max(0, text.lastIndexOf(' ', Math.max(0, i - 70)) + 1), end = Math.min(text.length, i + 150);
  return (start > 0 ? '…' : '') + markTokens(text.slice(start, end).trim(), toks) + (end < text.length ? '…' : '');
}
/** Escape text and wrap query words (accent-insensitive) in <mark class="srch-hl">. Matches start at a word start only, so "cut"
    marks "cut-off" but never the middle of "Executive". */
const WORD_CHAR = /[\p{L}\p{N}]/u;
function markTokens(text, toks) {
  const s = String(text ?? ''); if (!toks?.length) return esc(s);
  const low = fold(s), ranges = [];
  toks.forEach(t => { let i = 0; while ((i = low.indexOf(t, i)) !== -1) { if (i === 0 || !WORD_CHAR.test(low[i - 1])) ranges.push([i, i + t.length]); i += t.length; } });
  if (!ranges.length) return esc(s);
  ranges.sort((a, b) => a[0] - b[0]);
  let out = '', at = 0;
  ranges.forEach(([a, b]) => { if (a < at) return; out += esc(s.slice(at, a)) + `<mark class="srch-hl">${esc(s.slice(a, b))}</mark>`; at = b; });
  return out + esc(s.slice(at));
}

/* ═══════════════ Facets & queries ═══════════════ */
const UPDATED_WINDOWS = [['7d', 'Past week', 7], ['30d', 'Past month', 30], ['365d', 'Past year', 365]];
/** Browse dimensions. values(doc, r) → keys; label(key) → text. `single` facets hold one value. */
const FACETS = [
  { id: 'topic', label: 'Topic', values: (d, r) => [...new Set(r.topics.flatMap(topicLineage))], name: topicName },
  { id: 'space', label: 'Space', when: () => hasModule('spaces'), values: (d, r) => r.contexts, name: id => { const s = spaceById(id); return s ? (s.code ? `${s.name} · ${s.code}` : s.name) : 'Space'; } },
  { id: 'type', label: 'Type', values: d => [docType(d)], name: id => (DOC_TYPES[id] || DOC_TYPES.other).label },
  { id: 'owner', label: 'Owner', values: (d, r) => (r.owner ? [r.owner] : ['—']), name: v => (v === '—' ? 'No owner' : v) },
  { id: 'src', label: 'Source', values: (d, r) => [r.source.key], name: id => (id === 'upload' ? 'Uploaded files' : srcById(id)?.name || 'Source') },
  { id: 'kb', label: 'Collection', values: d => [d.kb], name: id => kbById(id)?.name || 'Collection' },
  { id: 'trust', label: 'Trust', values: d => [trustOf(d).state], name: id => TRUST[id]?.label || id },
  { id: 'upd', label: 'Updated', single: true, values: d => UPDATED_WINDOWS.filter(w => Date.now() - d.updated <= w[2] * DAY).map(w => w[0]), name: id => UPDATED_WINDOWS.find(w => w[0] === id)?.[1] || id },
  { id: 'lang', label: 'Language', values: (d, r) => [r.lang], name: id => LANGS[id] || id },
];
const facetsOn = () => FACETS.filter(f => !f.when || f.when());
const SORTS_CATALOG = { relevance: 'Best match', updated: 'Recently updated', title: 'Title A–Z', popular: 'Most opened' };
/** URL query → catalog params. Multi-value facets are comma lists. */
function parseCatalogQuery(query = {}) {
  const p = { q: (query.q || '').trim(), sort: SORTS_CATALOG[query.sort] ? query.sort : '', view: query.view === 'list' ? 'list' : 'grid', filters: {} };
  facetsOn().forEach(f => { const v = (query[f.id] || '').split(',').filter(Boolean); if (v.length) p.filters[f.id] = f.single ? [v[0]] : v; });
  return p;
}
/** Catalog params → query object for setQuery()/hrefs. */
function catalogQueryOf(p) {
  const q = { q: p.q || '', sort: p.sort || '', view: p.view === 'list' ? 'list' : '' };
  facetsOn().forEach(f => { q[f.id] = (p.filters?.[f.id] || []).join(','); });
  return q;
}
/** '#/knowledge?…' (Browse) for a params patch, e.g. catalogHref({ filters: { topic: ['t-ml'] } }). */
function catalogHref(p = {}) {
  const qs = new URLSearchParams(Object.entries(catalogQueryOf({ view: 'grid', ...p })).filter(([, v]) => v)).toString();
  return '/knowledge' + (qs ? '?' + qs : '');
}
const activeFilterCount = p => Object.values(p.filters || {}).reduce((a, v) => a + v.length, 0);
/** Run a catalog query: { rows:[{doc, score}], facets:{ id: [{value,label,count,on}] }, total, pool }.
    Facet counts are disjunctive (each facet ignores its own selection), so people can widen as well as narrow. */
function catalogSearch(p, pool = catalogPool()) {
  const toks = tokens(p.q), fs = facetsOn();
  const metas = new Map(pool.map(d => [d.id, res(d)]));
  const keys = new Map(pool.map(d => [d.id, Object.fromEntries(fs.map(f => [f.id, f.values(d, metas.get(d.id))]))]));
  const scored = pool.map(d => ({ doc: d, score: scoreRes(d, toks) })).filter(x => x.score > 0);
  const passes = (x, skip) => fs.every(f => f.id === skip || !p.filters[f.id]?.length || p.filters[f.id].some(v => keys.get(x.doc.id)[f.id].includes(v)));
  const rows = scored.filter(x => passes(x, null));
  const facets = {};
  fs.forEach(f => {
    const counts = new Map();
    scored.filter(x => passes(x, f.id)).forEach(x => keys.get(x.doc.id)[f.id].forEach(v => counts.set(v, (counts.get(v) || 0) + 1)));
    (p.filters[f.id] || []).forEach(v => counts.has(v) || counts.set(v, 0));
    const order = f.id === 'upd' ? UPDATED_WINDOWS.map(w => w[0]) : f.id === 'topic' ? (D.topics || []).map(t => t.id) : null;
    facets[f.id] = [...counts].map(([value, count]) => ({ value, label: f.name(value), count, on: !!p.filters[f.id]?.includes(value) }))
      .sort((a, b) => (order ? order.indexOf(a.value) - order.indexOf(b.value) : (b.count - a.count) || a.label.localeCompare(b.label)));
  });
  const sort = p.sort || (toks.length ? 'relevance' : 'updated');
  const cmp = {
    relevance: (a, b) => b.score - a.score || b.doc.updated - a.doc.updated,
    updated: (a, b) => b.doc.updated - a.doc.updated,
    title: (a, b) => a.doc.name.localeCompare(b.doc.name),
    popular: (a, b) => (b.doc.views || 0) - (a.doc.views || 0) || b.doc.updated - a.doc.updated,
  }[sort];
  rows.sort(cmp);
  return { rows, facets, total: rows.length, pool, sort };
}

/* ═══════════════ Personal state: saved, recent, views ═══════════════ */
const userList = key => { const m = (D[key] ??= {}); return (m[me().id] ??= []); };
const isSaved = id => userList('saved').includes(id);
/** Toggle a saved resource; returns the new state. */
function toggleSaved(id) { const l = userList('saved'), i = l.indexOf(id); if (i >= 0) l.splice(i, 1); else l.unshift(id); persist(); return i < 0; }
const savedResources = () => userList('saved').map(docById).filter(canOpenRes);
/** Record that the caller opened a resource (reader). */
function trackRecent(id) {
  const l = userList('recent'), i = l.findIndex(x => x.doc === id);
  if (i >= 0) l.splice(i, 1);
  l.unshift({ doc: id, at: Date.now() }); l.length = Math.min(l.length, 40);
  const d = docById(id); if (d) d.views = (d.views || 0) + 1;
  persist();
}
const recentResources = (n = 40) => userList('recent').map(x => ({ doc: docById(x.doc), at: x.at })).filter(x => canOpenRes(x.doc)).slice(0, n);
const myViews = () => userList('views');

/* ═══════════════ Relationships ═══════════════ */
/** Conversations of the caller that cite a resource. */
const citingConvs = doc => (typeof myConvs === 'function' ? myConvs() : D.convs).filter(c => (c.messages || []).some(m => (m.citations || []).some(x => x.doc === doc.id)));
/** Related resources: shared topics, spaces, base, type and co-citation, readable only. */
function relatedResources(doc, n = 6) {
  const r = res(doc), topics = new Set(r.topics), ctx = new Set(r.contexts);
  const co = new Set(citingConvs(doc).flatMap(c => c.messages.flatMap(m => (m.citations || []).map(x => x.doc))));
  return catalogPool().filter(d => d.id !== doc.id && isReaderVisible(d)).map(d => {
    const o = res(d);
    const s = o.topics.filter(t => topics.has(t)).length * 3 + o.contexts.filter(c => ctx.has(c)).length * 2 + (d.kb === doc.kb ? 1 : 0) + (docType(d) === docType(doc) ? 1 : 0) + (co.has(d.id) ? 2 : 0);
    return { doc: d, score: s };
  }).filter(x => x.score >= 3).sort((a, b) => b.score - a.score || b.doc.updated - a.doc.updated).slice(0, n).map(x => x.doc);
}

/* ═══════════════ Governance signals (Knowledge health) ═══════════════ */
/** Metadata a resource is missing: 'topic' | 'owner' | 'summary'. */
function metadataGaps(doc) {
  const kb = kbById(doc.kb), out = [];
  if (!(doc.topics || kb?.topics)?.length) out.push('topic');
  if (!doc.owner && !ownerOfKb(kb)) out.push('owner');
  if (!doc.summary) out.push('summary');
  return out;
}
const normTitle = n => String(n).toLowerCase().replace(/\.[a-z0-9]+$/, '').replace(/\((website|copy|old|final)[^)]*\)/g, '').replace(/[–—-]/g, ' ').replace(/[^\p{L}\p{N} ]/gu, ' ').replace(/\b(copy|website|final|v\d+)\b/g, '').replace(/\s+/g, ' ').trim();
/** Likely duplicates among resources the caller can edit: same normalized title, or flagged by processing (doc.dupOf). */
function duplicateCandidates() {
  const pool = readableResources().filter(d => !kbById(d.kb)?.personal), dismissed = new Set(D.dupDismissed || []);
  const byTitle = new Map(), pairs = [];
  const add = (a, b, reason) => {
    const key = [a.id, b.id].sort().join('|');
    if (dismissed.has(key) || pairs.some(p => p.key === key)) return;
    if (!canEditKb(kbById(a.kb)) && !canEditKb(kbById(b.kb))) return;
    const [keep, dup] = a.updated >= b.updated ? [a, b] : [b, a];
    pairs.push({ key, keep, dup, reason });
  };
  pool.forEach(d => {
    if (d.dupOf) { const o = docById(d.dupOf); if (o && !o.archived) add(o, d, d.dupReason || 'Processing found nearly identical text'); }
    const k = normTitle(d.name); if (k.length < 8) return;
    if (byTitle.has(k)) add(byTitle.get(k), d, 'Same title'); else byTitle.set(k, d);
  });
  return pairs;
}
