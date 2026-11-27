'use strict';
/* Knowledge catalog — the resource model behind Knowledge (Discover, Browse,
   the personal sections, Reader), Knowledge Studio → Documents and Knowledge health.

   Concepts (one meaning each):
   - Source          where content comes from (a connector source or an upload). Provenance only.
   - Resource        one canonical document (D.docs). Lives in exactly one collection.
   - Collection      the governed home of resources: ownership + access boundary. Never names a space.
   - Space/context   a course, group, office, team or project. A space links documents as its materials
                     (doc.contexts) without copying them.
   - Concept         the workspace taxonomy: concepts in classification schemes (Lĩnh vực, Nghiệp vụ, Loại tài liệu,
                     Đối tượng; one Subject scheme in enterprise workspaces) and authority lists (org units, programs).
   - Type            the document's file class (PDF, Word, Spreadsheet…), derived from its file; never edited.
   - Saved view      a stored Browse query (D.views), kept and managed in Browse's Filters.
   Browse = the organization's knowledge (concepts by scheme, filters). My library = saved + my files
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

/* ═══════════════ Taxonomy: concept schemes (faceted, SKOS) ═══════════════
   item_model.md §4.13. A workspace classifies documents along several schemes (D.schemes), each a poly-hierarchy of
   concepts (D.concepts: a concept may sit under several broader ones). `classification` schemes are targets of
   classification and Browse facets; `authority` schemes (org units, programs) only describe documents (issuer,
   applicability) and members. The working copy (D.concepts) is what people edit and see by name at once; machines
   (classification, query interpretation, facet rollup) read the published version — the preview keeps one copy and
   lists unpublished edits on the scheme (scheme.changes) until Studio › Classification › Publish.
   Shapes (seeded by scripts/data/*):
   scheme   { id (= code: domain | function | document-type | audience | org-unit | program | subject), name, desc,
              purpose: classification | authority, position, minLabels, maxLabels (null = unbounded), hasPrimary,
              maxDepth, assignTop, sections, llm: always | fallback | never, auto, review (thresholds), version,
              versions: [{ v, at, by, note, changes }], changes: [{ kind, concept, text, at, by }] }
   concept  { id, scheme, notation, pref: { vi?, en? }, alt: [[lang, text]], hidden: [[lang, text]], definition, scope,
              examples: [], color (top only), icon, patterns: [] (document type), timeSensitive, state: draft | published |
              deprecated, replacedBy: [], broader: [], related: [], mappings: [[system, code, label, match]], hint }
              `hint` is the mock's stand-in for the server's ambiguity displayName (“Khóa luận tham khảo”).
   group    D.conceptGroups { id, scheme, name, expansion, members: [] } — display/expansion only, never a target.
   rule     D.conceptRules { id, when: { concept | kb | source }, then, effect: implies | prior, weight }
   doc      doc.concepts [{ id, state: accepted | suggested, primary, source: rule | lexical | knn | llm | human, conf,
              quote }], doc.uncertain [scheme ids the classifier left in the pool], doc.issuance { number, issued,
              effective, issuer, supersedes: [doc ids] }, doc.applicability { level: institution | unit | program |
              cohort, units: [], programs: [], cohorts: [] }. */
const SCHEME_ICONS = { domain: 'layers', function: 'briefcase', 'document-type': 'file-text', audience: 'users', 'org-unit': 'building', program: 'graduation', subject: 'layers' };
const schemeById = id => (D.schemes || []).find(s => s.id === id) || null;
const schemeName = id => schemeById(id)?.name || 'Scheme';
const schemeIcon = id => SCHEME_ICONS[id] || 'layers';
const byPosition = (a, b) => (a.position ?? 99) - (b.position ?? 99);
/** Classification schemes (what documents are filed under), in tab order. */
const classSchemes = () => (D.schemes || []).filter(s => s.purpose !== 'authority').sort(byPosition);
/** Authority lists (org units, programs): issuers, applicability and member affiliation — never a classification target. */
const authoritySchemes = () => (D.schemes || []).filter(s => s.purpose === 'authority').sort(byPosition);
/** The lowest-position classification scheme: Home's cards and Browse's pill bar. */
const firstScheme = () => classSchemes()[0] || null;
const _conceptIdx = new WeakMap();
function conceptById(id) {
  const all = D.concepts || [];
  let m = _conceptIdx.get(all);
  if (!m || m.size !== all.length || (id && m.has(id) && m.get(id).id !== id)) { m = new Map(all.map(c => [c.id, c])); _conceptIdx.set(all, m); }
  return (id && m.get(id)) || null;
}
/** A concept's preferred label (Vietnamese first, then English): content, never translated. */
const conceptName = id => { const c = conceptById(id); return c ? c.pref?.vi || c.pref?.en || Object.values(c.pref || {})[0] || c.notation : 'Untitled concept'; };
const conceptState = c => c?.state || 'published';
/** Concepts of a scheme in seed order: drafts and published ones (the working copy); `deprecated` adds the retired ones. */
const conceptsOf = (schemeId, { deprecated = false } = {}) => (D.concepts || []).filter(c => c.scheme === schemeId && (deprecated || conceptState(c) !== 'deprecated'));
/** Narrower concepts of one (its children under this parent; a child with several parents is under each). */
const narrowerOf = id => (D.concepts || []).filter(c => (c.broader || []).includes(id) && conceptState(c) !== 'deprecated');
const topConcepts = schemeId => conceptsOf(schemeId).filter(c => !(c.broader || []).length);
/** Every broader concept, through every parent (the closure). */
function ancestorsOf(id) {
  const out = [], seen = new Set([id]), q = [...(conceptById(id)?.broader || [])];
  while (q.length) { const b = q.shift(); if (seen.has(b)) continue; seen.add(b); out.push(b); q.push(...(conceptById(b)?.broader || [])); }
  return out;
}
/** Every narrower concept, at any depth. */
function descendantsOf(id) {
  const out = [], seen = new Set([id]), q = narrowerOf(id).map(c => c.id);
  while (q.length) { const n = q.shift(); if (seen.has(n)) continue; seen.add(n); out.push(n); q.push(...narrowerOf(n).map(c => c.id)); }
  return out;
}
/** A concept with everything broader: a document filed under it counts under each of them (facets, filters). */
const conceptLineage = id => [id, ...ancestorsOf(id)];
/** The path through each concept's first parent, top first: ["IT", "AI & học máy", "Thị giác máy tính"]. */
function conceptPath(id) {
  const out = [], seen = new Set();
  for (let c = conceptById(id); c && !seen.has(c.id); c = conceptById(c.broader?.[0])) { seen.add(c.id); out.unshift(conceptName(c.id)); }
  return out;
}
const conceptPathText = id => conceptPath(id).join(' › ');
/** The top concept above it through first parents (itself when it is one). */
function conceptTop(id) {
  let c = conceptById(id); const seen = new Set();
  while (c?.broader?.length && !seen.has(c.id)) { seen.add(c.id); c = conceptById(c.broader[0]) || c; if (seen.has(c.id)) break; }
  return c?.id || id;
}
/** Every label of a concept, in every language: [{ kind: pref | alt | hidden, lang, text }]. */
const conceptLabels = c => !c ? [] : [
  ...Object.entries(c.pref || {}).map(([lang, text]) => ({ kind: 'pref', lang, text })),
  ...(c.alt || []).map(([lang, text]) => ({ kind: 'alt', lang, text })),
  ...(c.hidden || []).map(([lang, text]) => ({ kind: 'hidden', lang, text })),
];
/** The label key the backend stores (`normalized`): lower case, collapsed whitespace and punctuation; diacritics kept (khoa ≠ khóa). */
const normLabel = s => String(s ?? '').normalize('NFC').toLowerCase().replace(/[\s\u00a0]+/g, ' ').replace(/^[\s\p{P}]+|[\s\p{P}]+$/gu, '').trim();
/** The icons people give top concepts (concept.icon), in picker order, with what each stands for. The web's
    `CONCEPT_ICONS` (modules/home/domainIcon.ts) has the same names. A new top concept starts with its scheme's icon. */
const CONCEPT_ICONS = [
  ['layers', 'General'], ['book', 'Book'], ['file-text', 'Documents'], ['graduation', 'Learning'], ['lightbulb', 'Ideas'], ['flask', 'Science'],
  ['cpu', 'Technology'], ['code', 'Code'], ['network', 'Network'], ['database', 'Data'], ['shield', 'Security'], ['scale', 'Legal'],
  ['landmark', 'Government'], ['briefcase', 'Business'], ['banknote', 'Money'], ['wallet', 'Payments'], ['chart', 'Analytics'], ['target', 'Goals'],
  ['users', 'Teams'], ['heart', 'Health'], ['leaf', 'Environment'], ['globe', 'Global'], ['building', 'Organization'], ['palette', 'Design'],
  ['megaphone', 'Marketing'], ['calendar', 'Events'], ['settings', 'Operations'], ['compass', 'Strategy'], ['truck', 'Logistics'], ['tag', 'Tag'],
];
/** How a concept is drawn: in its top concept's color, so a branch reads as one family — the stored color, else a stable
    hashed one (categoryColor, core/ui.js); with its own icon, else the nearest broader one's, else a tag (narrower) or its
    scheme's icon (top). */
function conceptLook(id) {
  const c = conceptById(id), top = conceptById(conceptTop(id)), color = top?.color || categoryColor(top?.id || id);
  const inherited = c?.icon || ancestorsOf(id).map(conceptById).find(a => a?.icon)?.icon;
  return { icon: inherited || (c?.broader?.length ? 'tag' : schemeIcon(c?.scheme)), color, style: ` style="--tone:${esc(color)}"` };
}
/** A concept tag: a soft chip in its family's color with its icon. With `href` it is a link (rows); inside a card, plain
    text. `suggested`: the classifier proposed it and nobody confirmed it yet — dashed, marked “Awaiting review”. */
function conceptTag(id, { href = '', suggested = false } = {}) {
  const l = conceptLook(id), name = esc(conceptName(id)), title = esc(conceptPathText(id));
  const inner = `${ic(l.icon)}<span class="concept-tag__label" translate="no">${name}</span>${suggested ? `<span class="concept-tag__state">${esc('Awaiting review')}</span>` : ''}`;
  const cls = cx('concept-tag', suggested && 'concept-tag--suggested');
  return href ? `<a class="${cls}"${l.style} href="#${href}" title="${title}">${inner}</a>` : `<span class="${cls}"${l.style} title="${title}">${inner}</span>`;
}
/** Concepts a document may be filed under in a scheme: published, and not a top concept when the scheme rolls documents
    up instead (assignTop false). */
const assignableConcepts = schemeId => { const s = schemeById(schemeId); return conceptsOf(schemeId).filter(c => conceptState(c) === 'published' && (s?.assignTop !== false || (c.broader || []).length || !narrowerOf(c.id).length)); };
/** Concepts as removable chips beside an “Add…” select (Contribute's Check the details, Edit details, the Process
    dialog). `scheme` limits it to one scheme (else every classification scheme, options prefixed with the scheme).
    Fires A[`${act}-remove`] (data-concept) and A[`${act}-add`] (the select's value: a concept id, or `top:<id>` when
    `broad` offers a whole branch). `data` goes on both. `limit` shows that many chips and a “+N more” toggle
    (A[`${act}-more`]) unless `expanded`; `quiet` uses neutral chips (settings, not the document's own metadata);
    `suggested` (ids) marks chips the classifier proposed. */
function conceptPicker({ id, ids, act, data = {}, label, empty = '', scheme = '', broad = false, limit = 0, expanded = false, quiet = false, suggested = [] }) {
  const shown = limit && !expanded && ids.length > limit + 1 ? ids.slice(0, limit) : ids;
  const chips = shown.map(c => { const l = conceptLook(c), sug = suggested.includes(c); return `<span class="${cx('concept-pick__chip', sug && 'concept-pick__chip--suggested')}"${l.style} title="${esc(conceptPathText(c))}">${ic(l.icon, 'i-xs')}<span class="truncate" translate="no">${esc(conceptName(c))}</span>${sug ? `<span class="concept-pick__state">${esc('Awaiting review')}</span>` : ''}<button type="button" class="concept-pick__x" data-act="${act}-remove" ${dataAttrs({ ...data, concept: c })} aria-label="${esc(`Remove ${conceptName(c)}`)}">${ic('x', 'i-xs')}</button></span>`; }).join('');
  const more = shown.length < ids.length ? `<button type="button" class="concept-pick__more" data-act="${act}-more" ${dataAttrs(data)}>${esc(`+${ids.length - shown.length} more`)}</button>` : '';
  const schemesShown = scheme ? [schemeById(scheme)].filter(Boolean) : classSchemes();
  const opts = [['', scheme ? `Add ${schemeName(scheme)}…` : 'Add a concept…'], ...schemesShown.flatMap(s => {
    const pre = scheme ? '' : `${s.name} · `;
    const tops = broad ? topConcepts(s.id).filter(t => narrowerOf(t.id).length > 1 && !ids.includes(t.id)).map(t => [`top:${t.id}`, `${pre}${conceptName(t.id)} · all`]) : [];
    return [...tops, ...assignableConcepts(s.id).filter(c => !ids.includes(c.id)).map(c => [c.id, pre + conceptPathText(c.id)])];
  })];
  const add = opts.length > 1 ? select({ id, value: '', options: opts, change: `${act}-add`, size: 'sm', cls: 'concept-pick__add', label: scheme ? `Add ${schemeName(scheme)}` : 'Add a concept', attrs: dataAttrs(data) }) : '';
  return `<div class="${cx('concept-pick', quiet && 'concept-pick--quiet')}" role="group" aria-label="${esc(label)}">${chips || (empty ? `<span class="t-sm muted">${esc(empty)}</span>` : '')}${more}${add}</div>`;
}

/* ── A document's assignments (document.concepts; reads omit rejected) ── */
/** [{ id, scheme, state: accepted | suggested, primary, source, conf, quote }], concepts that still exist only. */
const docAssignments = doc => (doc?.concepts || []).filter(a => a.state !== 'rejected' && conceptById(a.id)).map(a => ({ ...a, scheme: conceptById(a.id).scheme, state: a.state || 'accepted' }));
/** The concepts a document is filed under (accepted assignments). */
const resConcepts = doc => (doc?.concepts || []).filter(a => (a.state || 'accepted') === 'accepted' && conceptById(a.id)).map(a => a.id);
/** What the classifier proposed and nobody confirmed yet (Gợi ý › Nhãn chờ duyệt). */
const suggestedConcepts = doc => (doc?.concepts || []).filter(a => a.state === 'suggested' && conceptById(a.id)).map(a => a.id);
/** Assignments per classification scheme, in tab order, every scheme listed even when empty: [{ scheme, items, uncertain }]
    (primary first). */
const assignmentsByScheme = doc => { const all = docAssignments(doc); return classSchemes().map(s => ({ scheme: s, uncertain: (doc?.uncertain || []).includes(s.id), items: all.filter(a => a.scheme === s.id).sort((a, b) => (b.primary ? 1 : 0) - (a.primary ? 1 : 0) || (a.state === 'accepted' ? -1 : 1)) })); };
/** A person sets a document's concepts (ids across schemes): they become accepted human assignments (what they kept of the
    suggestions included), the first of a scheme that has a primary is it; schemes they fill leave the pool. `schemes`
    limits the change to those schemes (default: every classification scheme). */
function setDocConcepts(doc, ids, { schemes = null } = {}) {
  const touched = new Set(schemes || classSchemes().map(s => s.id)), firsts = new Set(), seen = new Set();
  const keep = (doc.concepts || []).filter(a => !touched.has(conceptById(a.id)?.scheme));
  const next = ids.filter(id => conceptById(id) && touched.has(conceptById(id).scheme) && !seen.has(id) && seen.add(id)).map(id => {
    const s = schemeById(conceptById(id).scheme), primary = !!s?.hasPrimary && !firsts.has(s.id);
    firsts.add(s?.id);
    return { id, state: 'accepted', source: 'human', ...(primary ? { primary: true } : {}) };
  });
  doc.concepts = [...keep, ...next];
  if (doc.uncertain) doc.uncertain = doc.uncertain.filter(s => !firsts.has(s));
  return doc.concepts;
}
/** Ids for a scheme: accepted first, suggested after (pickers that show both). */
const schemeConceptIds = (doc, schemeId, { suggested = true } = {}) => docAssignments(doc).filter(a => a.scheme === schemeId && (suggested || a.state === 'accepted')).map(a => a.id);
/** Browse filtered to one concept (its scheme's facet; narrower concepts count). */
const conceptHref = id => catalogHref({ filters: { [conceptById(id)?.scheme || 'domain']: [id] } });

/* ── Thông tin văn bản: document.issuance + document.applicability ── */
const APPLICABILITY = { institution: 'Whole institution', unit: 'Units', program: 'Programs', cohort: 'Cohorts' };
/** The issued-document facts, or null when there are none: { number, issued, effective, issuer, supersedes: [docs], level,
    units: [ids], programs: [ids], cohorts: [] }. */
function issuanceOf(doc) {
  const i = doc?.issuance, a = doc?.applicability;
  if (!i && !a) return null;
  return {
    number: i?.number || '', issued: i?.issued || null, effective: i?.effective || null, issuer: i?.issuer || '',
    supersedes: (i?.supersedes || []).map(docById).filter(Boolean), unresolved: i?.unresolved || [],
    level: a?.level || '', units: a?.units || [], programs: a?.programs || [], cohorts: a?.cohorts || [],
  };
}
/** Who a document applies to, in words: “Whole institution”, “Khoa CNTT, Khoa Cơ khí”, “Công nghệ thông tin · cohort 2022”. */
function applicabilityText(doc) {
  const x = issuanceOf(doc); if (!x || !x.level) return '';
  if (x.level === 'institution') return APPLICABILITY.institution;
  const names = [...x.units, ...x.programs].map(conceptName);
  return [names.join(', '), x.cohorts.length ? `cohort ${x.cohorts.join(', ')}` : ''].filter(Boolean).join(' · ');
}

/* ── Query interpretation (SearchItems.interpretation; conversation_loop.md "Knowledge retrieval") ──
   Longest-match, non-overlapping over the labels of published concepts (classification schemes, plus org units and
   programs); an unaccented query also matches folded labels. A concept in an expansion group stands for every member.
   A label shared across schemes is resolved by the rest of the query: a scheme already named elsewhere picks the other
   one; a domain term without a document type picks the document type; otherwise it is an ambiguity whose options
   become result groups. */
function _labelIndex() {
  const idx = new Map(), add = (key, c) => { if (!key) return; const l = idx.get(key) || idx.set(key, []).get(key); if (!l.includes(c.id)) l.push(c.id); };
  (D.concepts || []).filter(c => conceptState(c) === 'published').forEach(c => conceptLabels(c).forEach(l => { add(normLabel(l.text), c); add('~' + fold(normLabel(l.text)), c); }));
  return idx;
}
function interpretQuery(q) {
  const out = { concepts: [], ambiguities: [], rest: String(q || '').trim() };
  const words = normLabel(q).split(/[^\p{L}\p{N}]+/u).filter(Boolean); if (!words.length) return out;
  const folded = fold(q) === String(q).toLowerCase(), idx = _labelIndex(), hits = [];
  for (let i = 0; i < words.length;) {
    let found = null;
    for (let j = Math.min(words.length, i + 6); j > i && !found; j--) {
      const key = words.slice(i, j).join(' '), ids = idx.get(key) || (folded ? idx.get('~' + fold(key)) : null);
      if (ids?.length) found = { text: key, ids, end: j };
    }
    if (found) { hits.push(found); i = found.end; } else i++;
  }
  const expand = id => { const g = (D.conceptGroups || []).find(x => x.expansion && x.members.includes(id)); return g ? g.members : [id]; };
  const bySchemeOf = ids => { const m = new Map(); ids.forEach(id => { const s = conceptById(id).scheme; (m.get(s) || m.set(s, []).get(s)).push(id); }); return m; };
  const resolved = new Set();
  hits.forEach(h => { const m = bySchemeOf(h.ids); if (m.size === 1) resolved.add([...m.keys()][0]); });
  hits.forEach(h => {
    const m = bySchemeOf(h.ids);
    let pick = m.size === 1 ? [...m.keys()][0] : null;
    if (!pick) { const other = [...m.keys()].filter(s => !resolved.has(s)); if (other.length === 1 && other.length < m.size) pick = other[0]; }
    if (!pick && resolved.has('domain') && !resolved.has('document-type') && m.has('document-type')) pick = 'document-type';
    if (pick) { resolved.add(pick); m.get(pick).flatMap(expand).forEach(id => out.concepts.push({ id, text: h.text })); return; }
    // What a document is comes first: a bare term mostly looks for that kind of document (§8.2 rule 2, §8.7), then by tab order.
    const rank = s => (s === 'document-type' ? -1 : schemeById(s)?.position ?? 99);
    out.ambiguities.push({ text: h.text, options: [...m].sort(([a], [b]) => rank(a) - rank(b)).map(([scheme, ids]) => ({ scheme, concepts: ids.flatMap(expand), label: conceptById(ids[0])?.hint || `${conceptName(ids[0])} · ${schemeName(scheme)}` })) });
  });
  const spans = hits.map(h => h.text);
  out.rest = spans.reduce((s, t) => s.replace(new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), ' '), normLabel(q)).replace(/\s+/g, ' ').trim();
  return out;
}
/** Does a document match a set of concepts the way a facet filter does: AND across schemes, OR within one, narrower
    concepts count. `suggested` includes assignments still awaiting review. */
function matchesConcepts(doc, ids, { suggested = false } = {}) {
  if (!ids?.length) return true;
  const mine = new Set((suggested ? [...resConcepts(doc), ...suggestedConcepts(doc)] : resConcepts(doc)).flatMap(conceptLineage));
  const by = new Map(); ids.forEach(id => { const s = conceptById(id)?.scheme; if (s) (by.get(s) || by.set(s, []).get(s)).push(id); });
  return [...by.values()].every(group => group.some(id => mine.has(id)));
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
/** Everything the catalog knows about a resource. Cheap for one; use docType / resConcepts across thousands. */
function res(doc) {
  const kb = kbById(doc.kb);
  return {
    concepts: resConcepts(doc),
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
/** Knowledge Studio → Classification: a scheme's tab (view = scheme id: its tree and a concept's detail, node = a concept)
    or the suggestions (view = suggestions: what the classifier left for people, proposals and labels learned from edits). */
const taxonomyHref = (view = firstScheme()?.id || 'suggestions', q = {}) => studioHref('taxonomy', { view, ...q });
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
/** Relevance of a resource to tokens; 0 = no match. Most query words (60%) must appear somewhere. Metadata (title, summary, concepts…)
    outweighs body text, and a resource whose metadata covers every word ranks above one that only mentions some in passing. */
function scoreRes(doc, toks) {
  if (!toks.length) return 1;
  const r = res(doc);
  const fields = [
    [doc.name, 4], [r.summary, 3], [r.concepts.map(conceptName).join(' '), 3], [typeMeta(doc).label, 2],
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
/** Browse dimensions. values(doc, r) → keys; label(key) → text. `single` facets hold one value. One facet per
    classification scheme comes first (id = the scheme's id; a document counts under every broader concept). */
const FACETS = [
  { id: 'space', label: 'Space', when: () => hasModule('spaces'), values: (d, r) => r.contexts, name: id => { const s = spaceById(id); return s ? (s.code ? `${s.name} · ${s.code}` : s.name) : 'Space'; } },
  { id: 'type', label: 'Format', values: d => [docType(d)], name: id => (DOC_TYPES[id] || DOC_TYPES.other).label },
  { id: 'owner', label: 'Owner', values: (d, r) => (r.owner ? [r.owner] : ['—']), name: v => (v === '—' ? 'No owner' : v) },
  { id: 'src', label: 'Source', values: (d, r) => [r.source.key], name: id => (id === 'upload' ? 'Uploaded files' : srcById(id)?.name || 'Source') },
  { id: 'kb', label: 'Collection', values: d => [d.kb], name: id => kbById(id)?.name || 'Collection' },
  { id: 'trust', label: 'Trust', values: d => [trustOf(d).state], name: id => TRUST[id]?.label || id },
  { id: 'upd', label: 'Updated', single: true, values: d => UPDATED_WINDOWS.filter(w => Date.now() - d.updated <= w[2] * DAY).map(w => w[0]), name: id => UPDATED_WINDOWS.find(w => w[0] === id)?.[1] || id },
  { id: 'lang', label: 'Language', values: (d, r) => [r.lang], name: id => LANGS[id] || id },
];
/** A classification scheme as a Browse facet. */
const schemeFacet = s => ({ id: s.id, label: s.name, scheme: true, values: (d, r) => { const ids = r.concepts.filter(id => conceptById(id)?.scheme === s.id); return [...new Set(ids.flatMap(conceptLineage))]; }, name: conceptName });
const facetsOn = () => [...classSchemes().map(schemeFacet), ...FACETS.filter(f => !f.when || f.when())];
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
/** '#/knowledge?…' (Browse) for a params patch, e.g. catalogHref({ filters: { domain: ['d-it-ai'] } }). */
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
    const order = f.id === 'upd' ? UPDATED_WINDOWS.map(w => w[0]) : f.scheme ? conceptsOf(f.id).map(c => c.id) : null;
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
const citingConvs = doc => (typeof myConvs === 'function' ? myConvs() : D.convs).filter(c => (c.messages || []).some(m => (m.citations || []).some(x => x.item === doc.id)));
/** Related resources: shared concepts, spaces, base, type and co-citation, readable only. */
function relatedResources(doc, n = 6) {
  const r = res(doc), concepts = new Set(r.concepts), ctx = new Set(r.contexts);
  const co = new Set(citingConvs(doc).flatMap(c => c.messages.flatMap(m => (m.citations || []).map(x => x.item))));
  return catalogPool().filter(d => d.id !== doc.id && isReaderVisible(d)).map(d => {
    const o = res(d);
    const s = o.concepts.filter(t => concepts.has(t)).length * 3 + o.contexts.filter(c => ctx.has(c)).length * 2 + (d.kb === doc.kb ? 1 : 0) + (docType(d) === docType(doc) ? 1 : 0) + (co.has(d.id) ? 2 : 0);
    return { doc: d, score: s };
  }).filter(x => x.score >= 3).sort((a, b) => b.score - a.score || b.doc.updated - a.doc.updated).slice(0, n).map(x => x.doc);
}

/* ═══════════════ Governance signals (Knowledge health) ═══════════════ */
/** Metadata a resource is missing: 'concept' (nothing accepted in the first classification scheme that requires a label,
    or in any scheme that does) | 'owner' | 'summary'. */
function metadataGaps(doc) {
  const kb = kbById(doc.kb), out = [], mine = resConcepts(doc).map(id => conceptById(id).scheme);
  if (!mine.length || classSchemes().some(s => s.minLabels > 0 && !mine.includes(s.id))) out.push('concept');
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
