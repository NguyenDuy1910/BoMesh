'use strict';
/* Knowledge catalog — the resource model behind Knowledge (Discover, Browse,
   Library, Reader) and Knowledge health.

   Concepts (one meaning each):
   - Source          where content comes from (a connector source or an upload). Provenance only.
   - Resource        one canonical document (D.docs). Lives in exactly one knowledge base.
   - Knowledge base  the governed home of resources: ownership + access boundary (backend Collection).
   - Space/context   a course, group, office, team or project. Resources link to many spaces
                     (doc.contexts, plus the knowledge base's own space) without being copied.
   - Topic           the workspace taxonomy (domain → topic), D.topics.
   - Collection      a curated, ordered list of references (D.collections). Never grants access.
   - Saved view      a stored Browse query (D.views), kept and managed in Browse's Filters.
   Browse = the organization's knowledge (topics, collections shared with you, filters).
   My library = saved + recent + my files + my collections + contributions. Managing
   knowledge bases (access, sources, settings) is Manage → Knowledge bases.

   Feature code reads metadata through res(doc), so derived defaults apply everywhere and
   resources without hand-written metadata (uploads, synced files) still work. Workspace-
   neutral: nothing here knows about UTE or Northwind. */

/* ═══════════════ Resource types (platform registry) ═══════════════ */
const RESOURCE_KINDS = {
  policy: { label: 'Policy', plural: 'Policies', icon: 'shield', group: 'Policies & procedures' },
  procedure: { label: 'Procedure', plural: 'Procedures', icon: 'route', group: 'Policies & procedures' },
  form: { label: 'Form or checklist', plural: 'Forms & checklists', icon: 'clipboard', group: 'Policies & procedures' },
  guide: { label: 'Guide', plural: 'Guides', icon: 'book', group: 'Policies & procedures' },
  calendar: { label: 'Calendar', plural: 'Calendars', icon: 'calendar', group: 'Policies & procedures' },
  faq: { label: 'FAQ', plural: 'FAQs', icon: 'help', group: 'Policies & procedures' },
  handbook: { label: 'Handbook', plural: 'Handbooks', icon: 'book', group: 'Policies & procedures' },
  announcement: { label: 'Announcement', plural: 'Announcements', icon: 'megaphone', group: 'Policies & procedures' },
  syllabus: { label: 'Syllabus', plural: 'Syllabi', icon: 'list', group: 'Teaching & learning' },
  lecture: { label: 'Lecture slides', plural: 'Lecture slides', icon: 'monitor', group: 'Teaching & learning' },
  lab: { label: 'Lab or exercise', plural: 'Labs & exercises', icon: 'terminal', group: 'Teaching & learning' },
  assignment: { label: 'Assignment', plural: 'Assignments', icon: 'pencil', group: 'Teaching & learning' },
  exam: { label: 'Past exam', plural: 'Past exams', icon: 'check-circle', group: 'Teaching & learning' },
  paper: { label: 'Paper', plural: 'Papers', icon: 'file-text', group: 'Research' },
  thesis: { label: 'Thesis', plural: 'Theses', icon: 'graduation', group: 'Research' },
  dataset: { label: 'Dataset', plural: 'Datasets', icon: 'database', group: 'Research' },
  protocol: { label: 'Protocol', plural: 'Protocols', icon: 'flask', group: 'Research' },
  report: { label: 'Report', plural: 'Reports', icon: 'chart', group: 'Research' },
  contract: { label: 'Contract', plural: 'Contracts', icon: 'key', group: 'Business' },
  spec: { label: 'Technical reference', plural: 'Technical references', icon: 'cpu', group: 'Business' },
  playbook: { label: 'Playbook', plural: 'Playbooks', icon: 'target', group: 'Business' },
  template: { label: 'Template', plural: 'Templates', icon: 'copy', group: 'Business' },
  sheet: { label: 'Spreadsheet', plural: 'Spreadsheets', icon: 'table', group: 'Business' },
  notes: { label: 'Notes', plural: 'Notes', icon: 'note', group: 'Reference' },
  reference: { label: 'Reference', plural: 'References', icon: 'file', group: 'Reference' },
};
/** Ordered [pattern, kind]; first match wins. Used only when a resource has no kind yet (new uploads, synced files). */
const KIND_RULES = [
  [/\bfaq\b/i, 'faq'], [/syllabus/i, 'syllabus'], [/calendar/i, 'calendar'], [/^notice|announcement|results? (are|for)|opens? /i, 'announcement'],
  [/thesis/i, 'thesis'], [/dataset/i, 'dataset'], [/protocol/i, 'protocol'], [/ et al\.| & [A-Z][a-z]+ (19|20)\d\d|survey/i, 'paper'],
  [/^w\d\d\b|lecture|slides/i, 'lecture'], [/^lab\b|\blab \d/i, 'lab'], [/assignment|project brief/i, 'assignment'], [/midterm|final exam|past exam|exam \d{4}/i, 'exam'],
  [/template/i, 'template'], [/agreement|\bnda\b|addendum|\bsow\b|order form|terms of service|\bdpa\b|\bmsa\b/i, 'contract'],
  [/api reference|release notes|changelog|architecture|spec\b|error codes|rate limits|glossary/i, 'spec'],
  [/playbook|battlecard|pitch|\bscript|case study|brief|objection|selling|sequences|kit\b|qbr deck/i, 'playbook'],
  [/form\b|checklist|application\b/i, 'form'], [/procedure|process|how to/i, 'procedure'], [/policy|regulation|code of conduct|requirement|\brules\b|guidelines/i, 'policy'],
  [/guide|handbook|overview|explained/i, 'guide'], [/notes|minutes|interview/i, 'notes'], [/report|analysis|review\b/i, 'report'],
];
const kindMeta = id => RESOURCE_KINDS[id] || RESOURCE_KINDS.reference;
function inferKind(doc) {
  const n = String(doc.name || '');
  for (const [re, k] of KIND_RULES) if (re.test(n)) return k;
  return ['xlsx', 'xls', 'csv'].includes(doc.type) ? 'sheet' : 'reference';
}

/** File format groups (what the file is, not what it's for). */
const FORMATS = { pdf: ['pdf', 'PDF'], doc: ['word', 'Word'], docx: ['word', 'Word'], xls: ['sheet', 'Spreadsheet'], xlsx: ['sheet', 'Spreadsheet'], csv: ['sheet', 'Spreadsheet'], ppt: ['slides', 'Slides'], pptx: ['slides', 'Slides'], md: ['text', 'Text'], txt: ['text', 'Text'], html: ['text', 'Text'], json: ['text', 'Text'], png: ['image', 'Image'], jpg: ['image', 'Image'], zip: ['archive', 'Archive'] };
const formatOf = doc => FORMATS[doc.type] || ['other', 'Other'];
const LANGS = { en: 'English', vi: 'Vietnamese' };

/* ═══════════════ Topics (workspace taxonomy) ═══════════════ */
const topicById = id => (D.topics || []).find(t => t.id === id);
const topicName = id => topicById(id)?.name || 'Untitled topic';
/** Domains with their topics, in seed order. Archived topics stay resolvable by id but aren't offered. */
const topicTree = () => (D.topics || []).filter(t => !t.parent && !t.archived).map(d => ({ ...d, children: D.topics.filter(t => t.parent === d.id && !t.archived) }));
/** A topic and its domain (selecting a domain matches everything under it). */
const topicLineage = id => { const t = topicById(id); return t ? (t.parent ? [t.parent, t.id] : [t.id]) : []; };

/* ═══════════════ Resource metadata ═══════════════ */
const READABLE_STATUS = ['ready', 'outdated'];
/** Library records that are reader-facing: index status is an editor concern. */
const isReaderVisible = doc => [...READABLE_STATUS, 'unsupported'].includes(doc.status);
const isSearchable = doc => READABLE_STATUS.includes(doc.status);
function ownerOfKb(kb) {
  if (!kb) return '';
  if (kb.unit) return kb.unit;
  const o = (kb.shares || []).find(s => s.role === 'owner');
  return o ? (o.kind === 'group' ? groupById(o.id)?.name : memberById(o.id)?.name) || '' : '';
}
/** Spaces a resource belongs to: its own links plus its knowledge base's space. Spaces module only. */
function resContexts(doc) {
  if (!hasModule('spaces')) return [];
  const kb = kbById(doc.kb);
  return [...new Set([...(doc.contexts || []), kb?.space].filter(Boolean))].filter(id => { const sp = spaceById(id); return sp && !sp.archived; });
}
/** Where the resource came from: { key, app, name, path, url }. key = source id or 'upload'. */
function provenance(doc) {
  const src = doc.source && doc.source !== 'upload' ? srcById(doc.source) : null;
  if (!src) return { key: 'upload', app: 'upload', name: 'Uploaded file', path: doc.path || `Uploaded by ${doc.addedBy === 'You' ? 'you' : doc.addedBy}`, url: '' };
  const path = doc.path || [...(src.scope?.[0] ? [src.scope[0]] : []), doc.name].join(' / ');
  return { key: src.id, app: src.app, name: src.name, path, url: doc.url || `${APPS[src.app]?.url || 'https://source.example'}/${encodeURIComponent(doc.id)}` };
}
function defaultSummary(doc) {
  const k = kindMeta(doc.kind || inferKind(doc)).label.toLowerCase(), kb = kbById(doc.kb);
  return `${k[0].toUpperCase() + k.slice(1)} in ${kb?.name || 'this knowledge base'}.`;
}
/** Everything the catalog knows about a resource. Cheap; call freely. */
function res(doc) {
  const kb = kbById(doc.kb);
  return {
    kind: doc.kind || inferKind(doc),
    topics: doc.topics || kb?.topics || [],
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

/* ═══════════════ Access-aware pools ═══════════════ */
/** Published = past review (the lifecycle lives in core/lifecycle.js). Submissions, rejected and unpublished documents never reach readers, search or the assistant. */
const isPublishedStage = d => !d.stage || d.stage === 'published';
/** Published resources the caller may read (any publishing status). Authorization happens here, before any listing, search or AI use. */
const readableResources = () => D.docs.filter(d => { const kb = kbById(d.kb); return !d.archived && isPublishedStage(d) && kb && !kb.archived && canReadKb(kb); });
/** Every published resource the caller can use, My files included (search, ⌘K, the assistant). */
const catalogPool = () => readableResources().filter(isReaderVisible);
/** What Browse lists: the organization's knowledge. Personal files live in My library. */
const sharedPool = () => catalogPool().filter(d => !kbById(d.kb)?.personal);
const canOpenRes = doc => !!doc && !doc.archived && isPublishedStage(doc) && canReadKb(kbById(doc.kb)) && !kbById(doc.kb)?.archived;
/** Where a knowledge base opens for reading: its documents in Browse (a locked base offers Request access there); My files in My library. */
const kbHref = kb => (!kb ? '/knowledge' : kb.personal ? '/knowledge/library?tab=files' : catalogHref({ filters: { kb: [kb.id] } }));
/** Bases the caller manages (owner or editor) — Manage → Knowledge bases. */
const managedKbs = () => visibleKbs().filter(k => !k.personal && canEditKb(k));
const canManageKbs = () => can('knowledge.manage') || managedKbs().length > 0;
/** A managed base's page (access, sources, settings). */
const kbManageHref = (kb, tab = '') => '/bases/' + kb.id + (tab ? '?tab=' + tab : '');

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
    [doc.name, 4], [r.summary, 3], [r.topics.map(topicName).join(' '), 3], [kindMeta(r.kind).label, 2],
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
  { id: 'kind', label: 'Type', values: (d, r) => [r.kind], name: id => kindMeta(id).label },
  { id: 'owner', label: 'Owner', values: (d, r) => (r.owner ? [r.owner] : ['—']), name: v => (v === '—' ? 'No owner' : v) },
  { id: 'src', label: 'Source', values: (d, r) => [r.source.key], name: id => (id === 'upload' ? 'Uploaded files' : srcById(id)?.name || 'Source') },
  { id: 'kb', label: 'Knowledge base', values: d => [d.kb], name: id => kbById(id)?.name || 'Knowledge base' },
  { id: 'trust', label: 'Trust', values: d => [trustOf(d).state], name: id => TRUST[id]?.label || id },
  { id: 'upd', label: 'Updated', single: true, values: d => UPDATED_WINDOWS.filter(w => Date.now() - d.updated <= w[2] * DAY).map(w => w[0]), name: id => UPDATED_WINDOWS.find(w => w[0] === id)?.[1] || id },
  { id: 'fmt', label: 'Format', values: d => [formatOf(d)[0]], name: id => Object.values(FORMATS).find(f => f[0] === id)?.[1] || 'Other' },
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

/* ═══════════════ Home curation: featured and recently published ═══════════════ */
/** Workspace admins pick the documents featured on Home (D.featured = doc ids, in order). Only resources the caller can open are returned. */
const featuredIds = () => (D.featured ??= []);
const isFeatured = id => featuredIds().includes(id);
function toggleFeatured(id) { const l = featuredIds(), i = l.indexOf(id); if (i >= 0) l.splice(i, 1); else l.unshift(id); persist(); return i < 0; }
const featuredResources = (n = 8) => featuredIds().map(docById).filter(d => canOpenRes(d) && isReaderVisible(d)).slice(0, n);
/** When a document became available to readers: its approval/publication event, else its last update. */
const publishedAt = d => { const e = (d.submission?.events || []).filter(x => x.kind === 'approved' || x.kind === 'published').at(-1); return e ? e.at : d.updated; };
/** Trusted, readable, ready documents, newest first (Home "Recently published"). */
const recentlyPublished = (n = 6) => catalogPool().filter(d => d.status === 'ready' && !kbById(d.kb)?.personal).sort((a, b) => publishedAt(b) - publishedAt(a)).slice(0, n);

/* ═══════════════ Collections ═══════════════ */
const collectionById = id => (D.collections || []).find(c => c.id === id && !c.archived);
/** Share scopes: 'private' | 'workspace' | 'space:<id>'. */
const collectionSpace = c => (c.share?.startsWith('space:') ? spaceById(c.share.slice(6)) : null);
function canSeeCollection(c) {
  if (!c || c.archived) return false;
  if (c.owner === me().id || c.share === 'workspace') return true;
  const sp = collectionSpace(c);
  return !!sp && hasModule('spaces') && (!!spaceRole(sp) || isAdmin());
}
const canEditCollection = c => !!c && (c.owner === me().id || (c.share === 'workspace' && isAdmin()) || (!!collectionSpace(c) && canManageSpace(collectionSpace(c))));
const visibleCollections = () => (D.collections || []).filter(canSeeCollection).sort((a, b) => b.updated - a.updated);
const myCollections = () => visibleCollections().filter(c => c.owner === me().id);
/** Items split by access: readable ones and a count of references the caller can't open (titles stay hidden). */
function collectionItems(c) {
  const ok = [], locked = [];
  (c.items || []).forEach(it => { const d = docById(it.doc); if (canOpenRes(d)) ok.push({ ...it, d }); else if (d && !d.archived) locked.push(it); });
  return { ok, locked: locked.length };
}
function shareLabel(c) {
  if (c.share === 'workspace') return { icon: 'globe', label: `Everyone in ${curWs().name}` };
  const sp = collectionSpace(c); if (sp) return { icon: spaceType(sp.type).icon, label: sp.code ? `${sp.name} · ${sp.code}` : sp.name };
  return { icon: 'lock', label: 'Only you' };
}

/* ═══════════════ Relationships ═══════════════ */
/** Conversations of the caller that cite a resource. */
const citingConvs = doc => (typeof myConvs === 'function' ? myConvs() : D.convs).filter(c => (c.messages || []).some(m => (m.citations || []).some(x => x.doc === doc.id)));
/** Related resources: shared topics, spaces, base, type and co-citation, readable only. */
function relatedResources(doc, n = 6) {
  const r = res(doc), topics = new Set(r.topics), ctx = new Set(r.contexts);
  const co = new Set(citingConvs(doc).flatMap(c => c.messages.flatMap(m => (m.citations || []).map(x => x.doc))));
  return catalogPool().filter(d => d.id !== doc.id && isReaderVisible(d)).map(d => {
    const o = res(d);
    const s = o.topics.filter(t => topics.has(t)).length * 3 + o.contexts.filter(c => ctx.has(c)).length * 2 + (d.kb === doc.kb ? 1 : 0) + (o.kind === r.kind ? 1 : 0) + (co.has(d.id) ? 2 : 0);
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
