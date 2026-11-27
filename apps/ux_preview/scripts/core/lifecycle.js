'use strict';
/* Document lifecycle — every document, whatever its origin (a source's sync, an editor's upload, a member's contribution).

   Two independent states, as in the backend (item_model.md: publication and indexing are separate):
   publication  can readers see it? — stage: review → changes ⇄ review → rejected | published ⇄ unpublished
   processing   can search and the assistant use it? — status: pending (not processed) | processing (read → classified →
                indexed, one ingestion run) | ready | failed | outdated | unsupported
   Nothing is processed until someone asks: editors select documents in Knowledge Studio → Documents → Processing and press
   Process; a source's sync processes what it brings in. A submission is processed before it's reviewed, so the reviewer
   decides on the assistant's classification; approving never processes anything.
   A document is searchable only when it is published and processed (isSearchable).
   Contribute  Anyone with knowledge.contribute uploads a file and picks (or lets the assistant suggest) the collection.
               It is a submission (stage 'review'), visible only to its contributor and that base's reviewers.
   Process     Reviewers process a new document's submission (Documents → Processing): the assistant classifies it against
               every classification scheme in one pass and its suggestion is replaced with what it chose (aiOf).
   Decide      Reviewers (owners of the target collection; workspace admins own all) approve, request changes or decline
               in Knowledge Studio → Documents → Review. Corrections to the classification are recorded; repeated words
               become label proposals workspace admins decide (Classification › Suggestions › Learned from edits).
   People see one combined lifecycle label (lifecycleOf); the Studio also shows publication and processing apart. */

/* ═══════════════ Who can do what ═══════════════ */
const canContribute = () => can('knowledge.contribute');
/** Collections a person may submit to: shared bases they can read that accept contributions. */
const contributionTargets = () => visibleKbs().filter(k => !k.personal && canReadKb(k) && k.contribute !== false);
/** Reviewers of a base: its owners (workspace admins own every base). */
const canReviewKb = kb => !!kb && !kb.personal && !kb.archived && kbRole(kb) === 'owner';
const reviewableKbs = () => D.kbs.filter(canReviewKb);
const canReview = () => can('knowledge.manage') && reviewableKbs().length > 0;
const canManageTaxonomy = () => isAdmin();
const stageOf = d => d.stage || 'published';
const isMine = d => d.submission?.by === me().id;
/** May the caller see this document at all? Published: base readers. Otherwise: its contributor and the base's reviewers. */
function canSeeDoc(d) {
  if (!d || d.archived) return false;
  const kb = kbById(d.kb); if (!kb || kb.archived) return false;
  return stageOf(d) === 'published' ? canReadKb(kb) : isMine(d) || canReviewKb(kb);
}

/* ═══════════════ Collection access (one vocabulary everywhere) ═══════════════
   General access and roles use these words in every surface: create dialog, chips, the Access tab,
   filters, Share, Request access and the connect-source wizard. "All members" includes everyone who joins a public workspace. */
const KB_ACCESS = {
  workspace: { label: 'All members', icon: 'building' },
  restricted: { label: 'Restricted', icon: 'users' },
  private: { label: 'Private', icon: 'lock' },
};
/** The long description of a general-access level. */
function kbAccessDesc(key) {
  const ws = curWs()?.name || 'the workspace';
  if (key === 'workspace') return isPublicWs() ? `All members of ${ws} can find it and ask about it, including anyone who joins while it’s public.` : `All members of ${ws} can find it and ask about it.`;
  if (key === 'private') return 'Only its owners.';
  return 'Only the people and groups you add.';
}
/** Filter / Select options: [[key, label]]. */
const KB_ACCESS_OPTIONS = Object.entries(KB_ACCESS).map(([k, a]) => [k, a.label]);
const KB_ROLES = {
  viewer: { label: 'Viewer', icon: 'eye', desc: 'Can search and read its documents.' },
  editor: { label: 'Editor', icon: 'pencil', desc: 'Can also add documents and edit their details.' },
  owner: { label: 'Owner', icon: 'shield', desc: 'Can also review submissions and manage access and settings.' },
};
const KB_ROLE_OPTIONS = Object.entries(KB_ROLES).map(([k, r]) => [k, r.label]);

/* ═══════════════ Lifecycle (one label for people) ═══════════════
   Publication (can readers see it?) and processing (read, classified, indexed: can search and the assistant use it?) are
   independent, as in the backend (`publicationState`, `indexingState`). Nothing is processed until someone asks: uploads,
   submissions and approved new versions wait as Not processed until a reviewer processes them (Documents → Processing); a
   source's sync processes what it brings in. The label below names the one state that matters most for a reviewer. */
const LIFECYCLE = {
  analyzing: { tone: 'accent', label: 'Analyzing', icon: 'sparkles', live: true, desc: 'Reading the file and suggesting concepts, a collection and a summary.' },
  review: { tone: 'accent', label: 'In review', icon: 'clock', desc: 'A reviewer will check it before it’s published.' },
  changes: { tone: 'warning', label: 'Changes requested', icon: 'pencil', desc: 'A reviewer asked for changes before it can be published.' },
  rejected: { tone: 'danger', label: 'Declined', icon: 'x-circle', desc: 'A reviewer declined it. It won’t be published.' },
  queued: { tone: 'default', label: 'Not processed', icon: 'circle-dashed', desc: 'Published, but not processed yet: people can open it from its collection; search and the assistant can’t use it until it’s processed.' },
  publishing: { tone: 'accent', label: 'Processing', icon: 'loader', live: true, desc: 'Being read, classified and indexed. It will be searchable in a few minutes.' },
  published: { tone: 'success', label: 'Published', icon: 'check-circle', quiet: true, desc: 'Searchable and available to the assistant.' },
  update: { tone: 'warning', label: 'Changed at the source', icon: 'refresh', desc: 'The original changed at its source. Answers use the previous version until it’s processed again.' },
  failed: { tone: 'danger', label: 'Processing failed', icon: 'alert-circle', desc: 'It couldn’t be read or indexed. Process it again from Documents → Processing.' },
  versioned: { tone: 'success', label: 'Published as new version', icon: 'check-circle', quiet: true, desc: 'It replaced the earlier version of the document.' },
  stored: { tone: 'default', label: 'Stored, not searchable', icon: 'file', desc: 'This file type can’t be searched. People can still download it.' },
  unpublished: { tone: 'default', label: 'Unpublished', icon: 'eye-off', desc: 'Hidden from readers, search and answers. Editors can publish it.' },
  archived: { tone: 'default', label: 'Archived', icon: 'archive', desc: 'Removed from the library.' },
};
const STATUS_TO_LIFE = { pending: 'queued', processing: 'publishing', ready: 'published', outdated: 'update', failed: 'failed', unsupported: 'stored' };
/** { key, label, tone, icon, desc, live } */
function lifecycleOf(d) {
  let key;
  if (d.archived) key = 'archived';
  else {
    const st = stageOf(d);
    if (st === 'review') key = d.ai?.status === 'analyzing' ? 'analyzing' : 'review';
    else if (st === 'published') key = STATUS_TO_LIFE[d.status] || 'published';
    else key = st;
  }
  return { key, ...LIFECYCLE[key] };
}
/** Lifecycle chip (STATUS.life in ui.js uses the same vocabulary). */
const lifeChip = (d, size) => { const l = lifecycleOf(d); return chip(l.label, { tone: l.tone, variant: l.quiet ? 'tertiary' : 'soft', dot: true, live: !!l.live, size, tip: l.desc }); };

/* ═══════════════ Processing: read → classified → indexed, only when someone asks ═══════════════ */
/** A document's processing state (the backend's indexingState), whatever its publication. A new document's submission has
    one (it's processed before review); a new version's or a declined one doesn't. */
const PROCESSING = {
  pending: { label: 'Not processed', tone: 'default', icon: 'circle-dashed', desc: 'Not read, classified or indexed yet. Search and the assistant can’t use it.' },
  processing: { label: 'Processing', tone: 'accent', icon: 'loader', live: true, desc: 'Being read, classified against your schemes and indexed.' },
  ready: { label: 'Processed', tone: 'success', icon: 'check', desc: 'Read, classified and indexed: search and the assistant can use it once it’s published.' },
  failed: { label: 'Failed', tone: 'danger', icon: 'alert-circle', desc: 'It couldn’t be read or indexed. Process it again from Processing.' },
  outdated: { label: 'Changed at the source', tone: 'warning', icon: 'refresh', desc: 'Changed since it was processed. Answers use the previous version until it’s processed again.' },
  unsupported: { label: 'Not supported', tone: 'default', icon: 'file', desc: 'Images and archives can’t be processed. People can still download them.' },
};
const PROCESSING_ORDER = ['pending', 'processing', 'ready', 'failed', 'outdated', 'unsupported'];
/** An open submission of a new document: its file is processed before a reviewer decides (a new version's is processed
    once it's approved). */
const isCandidate = d => stageOf(d) === 'review' && !d.submission?.versionOf;
function processingOf(d) {
  const st = stageOf(d);
  if (isCandidate(d)) return UNPROCESSABLE.includes(d.type) ? 'unsupported' : PROCESSING[d.status] ? d.status : 'pending';
  if (st === 'review' || st === 'changes' || st === 'rejected' || st === 'versioned') return 'pending';
  return PROCESSING[d.status] ? d.status : 'ready';
}
/** Ready for a reviewer's decision: a new document once processed (or a format that can't be), or a new version. */
const readyToReview = d => stageOf(d) === 'review' && (!isCandidate(d) || ['ready', 'outdated', 'unsupported'].includes(processingOf(d)));
/** Can it be processed (again)? Not while it runs, not an image or archive, not a new version waiting for review. */
const canProcess = d => !!d && !d.archived && (['published', 'unpublished'].includes(stageOf(d)) || isCandidate(d)) && ['pending', 'failed', 'outdated', 'ready'].includes(processingOf(d)) && !UNPROCESSABLE.includes(d.type);
const UNPROCESSABLE = ['png', 'jpg', 'jpeg', 'zip'];
/** Whether people can read it, in words (the publication state, apart from processing). */
const publicationOf = d => ({ review: 'In review', changes: 'Changes requested', rejected: 'Declined', unpublished: 'Unpublished', versioned: 'Published as a new version of the document it updates' }[stageOf(d)] || 'Published');
/** The document a submission was published into as its next version (stage `versioned`), else null. */
const versionTarget = d => (stageOf(d) === 'versioned' ? docById(d.submission?.versionOf) || null : null);
/** In search: published and processed — the only documents search and the assistant use (catalog.js isSearchable only
    says the text is readable). */
const inSearch = d => stageOf(d) === 'published' && d.status === 'ready';

/* ═══════════════ Classification and what reviewers teach it ═══════════════ */
/** Concepts the pipeline chose (not a person): applied by the assistant, or synced without anyone touching them. */
const classifiedByPipeline = d => d.classifiedBy === 'assistant' || (!d.classifiedBy && !d.submission && !!d.source && d.source !== 'upload');
/** Reviewers' corrections to the pipeline's concepts (the human rows that replace a machine's): { id, doc, title,
    from:[ids], to:[ids], by, at } in D.reviewCorrections. They never change the taxonomy by themselves: words that two or
    more corrected titles share become label proposals (D.conceptProposals, kind 'label', origin 'correction') a workspace
    admin decides in Classification › Suggestions › Learned from edits. */
function recordCorrection(d, from, to) {
  if (!to.some(id => !from.includes(id))) return null;
  const c = { id: uid('cc'), doc: d.id, title: d.name, from: [...from], to: [...to], by: me().id, at: Date.now() };
  (D.reviewCorrections ??= []).unshift(c);
  learnLabels();
  return c;
}
/** Words that say nothing about a concept on their own (titles are full of them). */
const PHRASE_STOP = new Set(['the', 'and', 'for', 'with', 'from', 'about', 'into', 'guide', 'policy', 'procedure', 'template', 'notes', 'report', 'update', 'draft', 'final', 'sop', 'quy trình', 'hướng dẫn', 'biểu mẫu', 'giao dịch', 'tài liệu']);
/** Candidate keywords in a title, in its own spelling, lower-case: two-word phrases, plus single words in an English title
    (a Vietnamese syllable alone means little) and acronyms in any title (NAPAS). A pair never borrows a word from a
    stop phrase ("giao dịch", "hướng dẫn"): "soát giao" means nothing. */
function phrasesOf(title) {
  const raw = String(bareName(title)).normalize('NFC'), vi = /[^\u0000-\u007f]/.test(raw.replace(/[—–’“”]/g, ''));
  const orig = raw.match(/[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*/gu) || [];
  const words = orig.map(w => w.toLowerCase()).filter(w => !/^(v?\d+|\d{4})$/.test(w));
  const used = new Set(words.flatMap((w, i) => (PHRASE_STOP.has(`${w} ${words[i + 1]}`) ? [i, i + 1] : [])));
  const ok = (w, i) => w.length >= 3 && !PHRASE_STOP.has(w) && !used.has(i);
  const pairs = words.slice(1).map((w, i) => [i, words[i], w]).filter(([i, a, b]) => ok(a, i) && ok(b, i + 1)).map(([, a, b]) => `${a} ${b}`);
  const singles = vi ? orig.filter(w => /^[A-Z]{3,}$/.test(w)).map(w => w.toLowerCase()) : words.filter((w, i) => w.length >= 4 && ok(w, i));
  return [...new Set([...pairs, ...singles])];
}
/** Turn repeated corrections into label proposals: per concept reviewers moved documents to, a phrase two or more of those
    titles share that no concept of its scheme has as a label yet. Existing open proposals gain the new documents. */
function learnLabels() {
  const by = new Map();
  (D.reviewCorrections || []).forEach(c => c.to.filter(id => !c.from.includes(id) && conceptById(id)).forEach(id => (by.get(id) || by.set(id, []).get(id)).push(c)));
  by.forEach((cs, id) => {
    const scheme = conceptById(id).scheme, known = new Set(conceptsOf(scheme).flatMap(conceptLabels).map(l => normLabel(l.text)));
    const count = new Map();
    cs.forEach(c => phrasesOf(c.title).forEach(p => (count.get(p) || count.set(p, []).get(p)).push(c.doc)));
    [...count].filter(([p, docs]) => docs.length >= 2 && !known.has(normLabel(p))).forEach(([p, docs]) => {
      // One proposal per label and concept, ever: a rejected one isn't proposed again.
      const seen = (D.conceptProposals ||= []).find(x => x.kind === 'label' && x.target === id && normLabel(x.name) === normLabel(p));
      if (seen) { if (seen.state === 'open') seen.docs = [...new Set([...(seen.docs || []), ...docs])]; return; }
      D.conceptProposals.push({ id: uid('cp'), scheme, kind: 'label', name: p, target: id, labelKind: 'alt', origin: 'correction', state: 'open', docs: [...new Set(docs)], at: Date.now() });
    });
  });
}

/* ═══════════════ Queries ═══════════════ */
/** Everything a reviewer curates: documents in bases they own (any stage) — outside folders with their own access that leave
    them out — not archived unless asked. */
const curatedDocs = ({ archived = false } = {}) => D.docs.filter(d => (archived || !d.archived) && canReviewKb(kbById(d.kb)) && canReadFolder(docFolder(d)));
/** Submissions ready for a decision (readyToReview), oldest first. */
const reviewQueue = () => curatedDocs().filter(readyToReview).sort((a, b) => (a.submission?.at || a.updated) - (b.submission?.at || b.updated));
/** Processing states Documents → Processing lists: what isn't processed yet. */
const TO_PROCESS = ['pending', 'processing', 'failed', 'outdated'];
/** What waits to be processed, for Documents → Processing: new documents' submissions (processed before review) and
    documents nobody processed, that failed or that changed at their source. Not listed: formats that can't be processed,
    new versions waiting for review (processed once approved), what's processed already. */
const processingQueue = () => curatedDocs().filter(d => (isCandidate(d) || ['published', 'unpublished'].includes(stageOf(d))) && TO_PROCESS.includes(processingOf(d)));
/** First syncs at scale hold risky files back in batches, one per reason (D.reviewBatches): the open ones in bases the caller reviews. */
const openBatches = () => (D.reviewBatches || []).filter(b => b.status === 'open' && canReviewKb(kbById(b.kb)));
/** Suggested assignments a first sync left at scale, kept as counts (D.assignmentBatches: { id, run, kb, scheme, concept
    (null = the scheme's pool), n, sample: [titles], state: open | done }) — the open ones in bases the caller edits. */
const openAssignmentBatches = (scheme = '') => (D.assignmentBatches || []).filter(g => g.state === 'open' && g.n > 0 && (!scheme || g.scheme === scheme) && canEditKb(kbById(g.kb)));
/** Processing runs started from Documents (D.runs with kind 'process', no source): the one in flight, if any. */
const activeProcessRun = () => (D.runs || []).find(r => r.kind === 'process' && r.status === 'running') || null;
/* ── A document's processing steps (an ingestion run task's `phases`, api IngestionTask): the pipeline's phases grouped
   into the five steps people see. Task: { state: queued | running | succeeded | failed | cancelled, phases: [{ phase,
   state, start, end }], error, ocr? }. A step the task went past without entering (no published concepts to choose among,
   contextual retrieval off) was skipped. ── */
const PROC_STEPS = [
  { id: 'read', label: 'Read the file', phases: ['FETCHING', 'PARSING', 'OCR'], desc: 'Opens the file and splits it into passages', ocrDesc: 'Opens the file, recognizes its text and splits it into passages' },
  { id: 'classify', label: 'Classify', phases: ['CLASSIFYING'], desc: 'Files it under each scheme’s concepts and reads its issuing details', skipped: 'Skipped: no published concepts to choose among' },
  { id: 'context', label: 'Add context', phases: ['CHUNKING'], desc: 'Situates each passage in the document', skipped: 'Skipped: contextual retrieval is off' },
  { id: 'embed', label: 'Embed', phases: ['EMBEDDING'], desc: 'Turns passages into vectors for search' },
  { id: 'index', label: 'Index', phases: ['INDEXING'], desc: 'Stores them so search and the assistant find them' },
];
/** The task's steps: { ...step, state: todo | running | done | failed | skipped, ms } — ms: time spent so far (running) or
    in total. */
function procSteps(task, now = Date.now()) {
  const ph = task?.phases || [], ended = ['succeeded', 'failed', 'cancelled'].includes(task?.state);
  const lastSeen = Math.max(-1, ...ph.map(p => PROC_STEPS.findIndex(s => s.phases.includes(p.phase))));
  return PROC_STEPS.map((s, i) => {
    const mine = ph.filter(p => s.phases.includes(p.phase));
    const ms = mine.reduce((a, p) => a + Math.max(0, (p.end || now) - (p.start || now)), 0);
    const state = mine.some(p => p.state === 'FAILED') ? 'failed' : mine.some(p => p.state === 'RUNNING') ? 'running'
      : mine.length ? 'done' : i < lastSeen || (task?.state === 'succeeded') ? 'skipped' : 'todo';
    return { ...s, state: ended && state === 'running' ? 'todo' : state, ms: mine.length ? ms : 0, ocr: s.id === 'read' && ph.some(p => p.phase === 'OCR') };
  });
}
/** The step it's at (running or failed), with its 1-based position. */
const procStepAt = steps => { const i = steps.findIndex(s => s.state === 'running' || s.state === 'failed'); return i < 0 ? null : { ...steps[i], n: i + 1 }; };
/** A run's at-scale counters (run.backfill), the one source of truth every surface reads. */
const backfillOf = runId => (D.runs || []).find(r => r.id === runId)?.backfill || null;
/** Move counters of a backfill by a delta ({ review: -n, published: n, 'concepts.filed': n }); sign -1 undoes it. */
function shiftBackfill(runId, delta, sign = 1) {
  const bf = backfillOf(runId); if (!bf) return;
  Object.entries(delta).forEach(([path, n]) => {
    const [a, b] = path.split('.'), o = b ? (bf[a] ??= {}) : bf, k = b || a;
    o[k] = (o[k] || 0) + sign * n;
  });
}
/** The caller's contributions, newest activity first (withdrawn ones are archived and hidden). */
const myContributions = () => D.docs.filter(d => !d.archived && isMine(d) && !kbById(d.kb)?.personal).sort((a, b) => lastEvent(b).at - lastEvent(a).at);
const lastEvent = d => (d.submission?.events || []).at(-1) || { at: d.submission?.at || d.updated };
const contributorName = d => (d.submission?.by ? actorName(d.submission.by) : d.submission?.via === 'sync' ? (srcById(d.source)?.name || 'Source sync') : d.addedBy || '—');

/* ═══════════════ Assistant suggestions (mock, deterministic) ═══════════════ */
const PERSONAL_RE = /\bcv\b|résumé|resume|transcript|salary|payslip|passport|national id|\bid card\b|medical|customer export|card numbers?|\bpan\b|cccd/i;
const conf = (seed, lo = 0.62, hi = 0.97) => Math.round((lo + (hashOf(seed) % 1000) / 1000 * (hi - lo)) * 100) / 100;
/** Rules (D.conceptRules, the contract's ConceptRule): { id, when: { concept } | { kb } (a collection or folder) |
    { source }, then, effect: implies | prior, weight }. `implies` settles `then`'s scheme without asking the model
    (Loại tài liệu “Quyết định” → …); `prior` adds a weighted candidate (an issuing unit's usual function). */
const RULE_FIELDS = { concept: 'Concept', kb: 'Collection', source: 'Source' };
const ruleField = r => Object.keys(RULE_FIELDS).find(k => r?.when?.[k]) || '';
const ruleSourceName = v => srcById(v)?.name || v;
const ruleCollectionName = v => kbById(v)?.name || folderById(v)?.name || v;
/** Rules whose outcome is this concept. */
const rulesFor = conceptId => (D.conceptRules || []).filter(r => r.then === conceptId);
/** A collection rule holds for a document in that collection or anywhere under it; a source rule for a document that
    source registered (uploads have no source); a concept rule once the document is filed under that concept
    (`assigned`: what this pass decided so far). */
function ruleHolds(r, doc, assigned = []) {
  const w = r?.when || {};
  if (!doc) return false;
  if (w.source) return !!doc.source && doc.source === w.source && !!srcById(w.source);
  if (w.kb) { if (doc.kb === w.kb) return true; const f = folderById(w.kb); return !!f && f.kb === doc.kb && folderSubtree(f.id).includes(doc.folder); }
  if (w.concept) return assigned.includes(w.concept) || resConcepts(doc).includes(w.concept);
  return false;
}
/** "documents in “Chargebacks”" — a rule's condition in words (a concept's detail, Review's evidence, the prompt). */
const ruleText = r => { const w = r?.when || {}; return w.source ? `documents from “${ruleSourceName(w.source)}”` : w.kb ? `documents in “${ruleCollectionName(w.kb)}”` : `documents filed under “${conceptName(w.concept)}”`; };
/** Title similarity (shared words over all words) — duplicates. */
function titleSim(a, b) {
  const x = titleWords(a), y = titleWords(b); if (!x.size || !y.size) return 0;
  const i = [...x].filter(w => y.has(w)).length;
  return i / (x.size + y.size - i);
}
/** Text as a padded run of normalized words, so labels match whole words with their diacritics (khoa ≠ khóa). */
const phrase = s => ' ' + normLabel(s).replace(/[^\p{L}\p{N}]+/gu, ' ').trim() + ' ';
/** Candidates in one scheme, strongest first. An `implies` rule that holds settles the scheme (nothing else is weighed);
    otherwise: a recognition pattern on the title (document types: “/QĐ-”, “^QUY CHẾ”), labels (pref, alt, hidden) found in
    the text, the concepts of similar published documents, and `prior` rules. A concept loses to a narrower one that
    matched as well. `only` (Set) limits the candidates — a processing run's chosen concepts. `doc` ({ name, kb, folder,
    source }) is needed for rules and patterns.
    Returns [{ id, conf, source: rule | lexical | knn | llm, why: { labels[], pattern, rule, similar, prior } }]. */
function conceptMatches(text, schemeId, { doc = null, similar = [], only = null, assigned = [] } = {}) {
  const targets = assignableConcepts(schemeId).filter(c => !only || only.has(c.id));
  const none = { labels: [], pattern: '', rule: null, similar: '', prior: false };
  const implied = targets.map(c => ({ c, r: rulesFor(c.id).find(r => r.effect === 'implies' && ruleHolds(r, doc, assigned)) })).filter(x => x.r);
  if (implied.length) return implied.map(({ c, r }) => ({ id: c.id, conf: 0.98, source: 'rule', why: { ...none, rule: r } }));
  const hay = phrase(text), title = doc?.name || text, found = k => phrase(k).trim() && hay.includes(phrase(k));
  const fromSimilar = new Map();
  similar.forEach(x => resConcepts(x.doc).forEach(id => { if ((fromSimilar.get(id)?.sim || 0) < x.sim) fromSimilar.set(id, { sim: x.sim, doc: x.doc.id }); }));
  const out = targets.map(c => {
    const pattern = (c.patterns || []).find(p => { try { return new RegExp(p, 'iu').test(bareName(title)); } catch { return false; } }) || '';
    const labels = [...new Set(conceptLabels(c).filter(l => found(l.text)).map(l => l.text))];
    const prior = rulesFor(c.id).filter(r => r.effect === 'prior' && ruleHolds(r, doc, assigned)).reduce((a, r) => a + (r.weight ?? 0.2), 0);
    const sim = fromSimilar.get(c.id);
    let score = 0, source = 'llm';
    if (pattern) { score = 0.96; source = 'rule'; } else {
      if (labels.length) { score = Math.min(0.9, 0.62 + 0.14 * labels.length); source = 'lexical'; }
      const knn = sim && sim.sim >= 0.3 ? 0.4 + sim.sim * 0.45 : 0;
      if (knn > score) { score = knn; source = 'knn'; } else if (knn) score = Math.min(0.95, score + 0.05);
      if (prior) score = score ? Math.min(0.95, score + prior * 0.3) : Math.min(0.55, prior);
    }
    return { id: c.id, conf: Math.round(score * 100) / 100, source, why: { labels: labels.slice(0, 3), pattern, rule: null, similar: sim && sim.sim >= 0.3 ? sim.doc : '', prior: !!prior } };
  }).filter(x => x.conf >= 0.3);
  return out.filter(x => !out.some(y => y !== x && y.conf >= x.conf - 0.1 && ancestorsOf(y.id).includes(x.id))).sort((a, b) => b.conf - a.conf);
}
/** A suggestion's evidence in words, strongest first (Review's Classification card, the test box). Documents the caller
    can't see aren't named. */
function conceptEvidence(w = {}) {
  const o = w.similar && docById(w.similar), q = list => list.map(k => `“${k}”`).join(', ');
  return [
    w.contributor && 'confirmed by the contributor',
    w.rule && `rule: ${ruleText(w.rule)}`,
    w.pattern && `the title matches “${w.pattern}”`,
    w.labels?.length && `matched ${q(w.labels)}`,
    o && canSeeDoc(o) && `like “${docTitle(o)}”`,
    w.prior && !w.labels?.length && !w.rule && !w.pattern && 'usual for where it comes from',
  ].filter(Boolean);
}
/** Classify a document against every classification scheme in one pass (the CLASSIFYING step: one model call reads
    every published scheme). Document type goes first — its patterns and rules settle it, and a type implies function
    and audience concepts through rules. Per scheme, candidates at or above the scheme's review threshold, at most
    maxLabels: confidence ≥ auto → accepted, else suggested (Classification › Suggestions); nothing above review →
    the scheme's pool (`uncertain`) when it needs a label. `ctx`: a processing run's { concepts: [ids] (a scheme with
    chosen concepts only weighs those and what's under them; others weigh everything), note }. `text`: what it reads.
    Returns { assignments: [{ id, state, primary?, source, conf, quote, why }], uncertain: [scheme ids] }. */
function classifyDoc(d, ctx = null, text = d.name) {
  const chosen = new Set((ctx?.concepts || []).flatMap(id => [id, ...descendantsOf(id)]));
  const similar = similarDocs(d), body = ctx?.note ? `${text} ${ctx.note}` : text;
  const order = [...classSchemes()].sort((a, b) => (b.id === 'document-type') - (a.id === 'document-type'));
  const assignments = [], uncertain = [], assigned = [];
  order.forEach(s => {
    const only = chosen.size && assignableConcepts(s.id).some(c => chosen.has(c.id)) ? chosen : null;
    const picked = conceptMatches(body, s.id, { doc: d, similar, only, assigned }).filter(x => x.conf >= (s.review ?? 0.5)).slice(0, s.maxLabels ?? 99);
    picked.forEach((x, i) => {
      assignments.push({ id: x.id, state: x.conf >= (s.auto ?? 0.85) ? 'accepted' : 'suggested', ...(s.hasPrimary && i === 0 ? { primary: true } : {}), source: x.source, conf: x.conf, quote: x.why.labels[0] || x.why.pattern || '', why: x.why });
      assigned.push(x.id);
    });
    if (!picked.length && (s.minLabels || 0) > 0) uncertain.push(s.id);
  });
  return { assignments, uncertain };
}
/** Stored form of classifier output (document.concepts rows; `why` stays with the suggestion only). */
const storedAssignment = ({ why, ...a }) => a;
/** Classify a document (sources' syncs, processing runs). Without a context, one that already has concepts is left alone;
    with one, what the pipeline chose before is chosen again within it. A person's assignments always stay, and the
    schemes they filled aren't weighed. The context stays on the document (`classCtx`), so a published change to a
    scheme re-checks it within the same choices. Returns the concept ids it applied. */
function autoClassify(d, ctx = null) {
  if (!ctx && (d.concepts || []).length) return [];
  const human = (d.concepts || []).filter(a => a.source === 'human' && a.state !== 'rejected'), mine = new Set(human.map(a => conceptById(a.id)?.scheme));
  if (ctx) d.classCtx = ctx; else delete d.classCtx;
  const r = classifyDoc(d, ctx), machine = r.assignments.filter(a => !mine.has(conceptById(a.id).scheme)).map(storedAssignment);
  d.concepts = [...human, ...machine];
  d.uncertain = r.uncertain.filter(s => !mine.has(s));
  if (machine.length && !human.length) d.classifiedBy = 'assistant';
  return machine.map(a => a.id);
}
/** Processed, published documents whose concepts in a scheme the pipeline chose or never found: what a published change
    to that scheme re-checks (a document that isn't processed hasn't been classified yet; people's choices stay). */
const reclassifiable = schemeId => curatedDocs().filter(d => stageOf(d) === 'published' && d.status === 'ready' && !docAssignments(d).some(a => a.scheme === schemeId && a.source === 'human'));
/** A published scheme version changed what classification can choose: classify `docs` again in that scheme only (other
    schemes and people's choices stay). `rerank` ([{ concept, among: [ids] }], the version's reclassification.rerank)
    scopes it: a document filed under `concept` is weighed only among `among` (a split's targets, the children a parent
    gained) and keeps `concept` when none of them fits; documents no rerank entry covers (a retired concept, new
    thresholds) are classified again in the whole scheme. No indexing again: concepts live beside the index, not in
    passages. The documents show as Classifying for a moment. Returns { checked, changed: [doc], revert() } and finishes
    on its own (onDone). */
function reclassifyScheme(schemeId, docs = reclassifiable(schemeId), onDone = null, { rerank = [] } = {}) {
  const changed = [], key = list => (list || []).map(a => `${a.id}:${a.state || 'accepted'}`).sort().join(), s = schemeById(schemeId);
  docs.forEach(d => {
    const own = (d.concepts || []).filter(a => a.state !== 'rejected'), scoped = rerank.filter(x => own.some(a => a.id === x.concept));
    let next, unc = d.uncertain;
    if (scoped.length) {
      next = [...(d.concepts || [])];
      scoped.forEach(x => {
        // `required` (a split): the retired concept can't stay, so the best target wins even when unsure (as a suggestion).
        const found = conceptMatches([d.name, d.summary].filter(Boolean).join(' '), schemeId, { doc: d, similar: similarDocs(d), only: new Set(x.among) })[0];
        const best = found || (x.required && x.among[0] ? { id: x.among[0], conf: 0, source: 'llm', why: { labels: [], pattern: '' } } : null);
        const i = next.findIndex(a => a.id === x.concept);
        if (i < 0 || !best || (!x.required && best.conf < (s?.review ?? 0.5))) return;
        const was = next[i];
        next = next.filter((a, j) => j !== i && a.id !== best.id);
        next.splice(Math.min(i, next.length), 0, { ...storedAssignment({ id: best.id, state: best.conf >= (s?.auto ?? 0.85) ? 'accepted' : 'suggested', source: best.source, conf: best.conf || undefined, quote: best.why.labels[0] || best.why.pattern || '' }), ...(was.primary ? { primary: true } : {}), evidence: { replacedFrom: x.concept } });
      });
    } else {
      const r = classifyDoc(d, d.classCtx || null);
      next = [...(d.concepts || []).filter(a => conceptById(a.id)?.scheme !== schemeId), ...r.assignments.filter(a => conceptById(a.id).scheme === schemeId).map(storedAssignment)];
      unc = [...(d.uncertain || []).filter(x => x !== schemeId), ...r.uncertain.filter(x => x === schemeId)];
    }
    if (key(next) !== key(d.concepts)) changed.push({ d, before: d.concepts, beforeU: d.uncertain, next, unc });
    d.reclassifying = true;
  });
  let reverted = false;
  setTimeout(() => {
    docs.forEach(x => delete x.reclassifying);
    if (reverted) return;
    changed.forEach(x => { x.d.concepts = x.next; x.d.uncertain = x.unc; if (!x.d.classifiedBy) x.d.classifiedBy = 'assistant'; });
    onDone?.(); refresh();
  }, 1600);
  const revert = () => { reverted = true; docs.forEach(x => delete x.reclassifying); changed.forEach(x => { x.d.concepts = x.before; x.d.uncertain = x.beforeU; }); };
  return { checked: docs.length, changed: changed.map(x => x.d), revert };
}
/** Merge remap (publishing a deprecation with one replacement): every assignment of `from` moves to `to` without asking the
    model; a document that has both keeps one. Returns how many documents moved. */
function remapConcept(from, to) {
  let n = 0;
  D.docs.forEach(d => {
    if (!(d.concepts || []).some(a => a.id === from)) return;
    n++; const has = d.concepts.some(a => a.id === to);
    d.concepts = d.concepts.flatMap(a => (a.id !== from ? [a] : has ? [] : [{ ...a, id: to, evidence: { replacedFrom: from } }]));
  });
  return n;
}
const titleWords = name => new Set(tokens(String(name).replace(/\.[a-z0-9]+$/i, '')).filter(w => !/^(v\d+|draft|update|updated|copy|final|new|\d{4})$/.test(w)));
/** Similar published documents by title words (possible duplicate or earlier version). */
function similarDocs(d, min = 0.3) {
  const mine = titleWords(d.name); if (!mine.size) return [];
  return D.docs.filter(o => o.id !== d.id && !o.archived && isPublishedStage(o) && !kbById(o.kb)?.personal).map(o => {
    const t = titleWords(o.name), inter = [...mine].filter(w => t.has(w)).length;
    return { doc: o, sim: inter / (mine.size + t.size - inter) };
  }).filter(x => x.sim >= min).sort((a, b) => b.sim - a.sim).slice(0, 3);
}
/** Compute (once) and return the assistant's suggestion for a document:
    { status, concepts: [{ id, state, primary?, source, conf, why }], uncertain: [scheme ids], kb: { id, conf, by }, summary,
    title?, flags: [{ type, doc?, sim?, text }], confirmed?, processed? }.
    `title`: the clean name the CLASSIFYING step wrote for a processed new document (d.classTitle), for the reviewer to
    approve. On submit, concepts are matched from the title and note (classifyDoc); `why` says which evidence matched.
    Once a new document's submission is processed, its concepts and summary are what the assistant chose while processing
    it (classifiedOnProcessing): `processed` = { at, concepts: n chosen for its run, note }. When the contributor confirmed
    the details before submitting (d.submission.confirmed = { concepts, summary }), their concepts stay (accepted, why.contributor)
    and the schemes they filled aren't weighed. */
function aiOf(d) {
  if (d.ai) return d.ai;
  const c = d.submission?.confirmed || null;
  const text = [d.name, d.submission?.note, c?.summary, d.summary].filter(Boolean).join(' ');
  const similar = similarDocs(d);
  const done = isCandidate(d) && ['ready', 'outdated'].includes(d.status) ? classifiedOnProcessing(d) : null;
  const matched = done ? done.result : classifyDoc(d, null, text);
  const mine = (c?.concepts || []).filter(conceptById), mineSchemes = new Set(mine.map(id => conceptById(id).scheme));
  const fromContributor = mine.map((id, i) => { const m = matched.assignments.find(x => x.id === id); return { id, state: 'accepted', source: 'human', conf: 1, ...(i === 0 || !mine.slice(0, i).some(o => conceptById(o).scheme === conceptById(id).scheme) ? { primary: true } : {}), why: { ...(m?.why || {}), contributor: true } }; });
  const concepts = c ? [...fromContributor, ...(done ? matched.assignments.filter(x => !mineSchemes.has(conceptById(x.id).scheme)) : [])] : matched.assignments;
  const flags = [];
  const sim = similar.filter(x => x.sim >= 0.55);
  if (d.submission?.versionOf) { const o = docById(d.submission.versionOf); if (o) flags.push({ type: 'version', doc: o.id, text: `New version of “${o.name}”` }); }
  else if (sim.length) flags.push({ type: 'duplicate', doc: sim[0].doc.id, sim: sim[0].sim, text: `Looks like “${sim[0].doc.name}” (${Math.round(sim[0].sim * 100)}% similar title)` });
  if (PERSONAL_RE.test(text)) flags.push({ type: 'personal', text: 'May contain personal data. Check before publishing.' });
  if (['png', 'jpg', 'jpeg', 'zip'].includes(d.type)) flags.push({ type: 'format', text: 'This file type can’t be searched; people could only download it.' });
  else if (d.error) flags.push({ type: 'unreadable', text: d.error });
  const about = concepts.filter(x => x.primary).map(x => conceptName(x.id).toLowerCase());
  d.ai = {
    status: 'done', at: Date.now(),
    concepts, uncertain: matched.uncertain.filter(s => !mineSchemes.has(s)),
    kb: { id: d.kb, conf: d.submission?.kbBy === 'ai' ? conf(d.id + 'kb', 0.6, 0.85) : 1, by: d.submission?.kbBy || 'contributor' },
    summary: done?.summary || c?.summary || d.summary || `Contributed by ${contributorName(d)}${about.length ? ` about ${about.join(' and ')}` : ''}.`,
    flags, ...(c ? { confirmed: true } : {}),
    ...(done && d.classTitle && !d.submission?.versionOf ? { title: d.classTitle } : {}),
    ...(done ? { processed: { at: d.processedAt || Date.now(), concepts: d.classCtx?.concepts?.length || 0, note: !!d.classCtx?.note } } : {}),
  };
  return d.ai;
}
/** What processing a new document's submission chose (the CLASSIFYING step): classifyDoc over its title, note and text,
    within the run's chosen concepts when it had some (d.classCtx). The summary is the file's opening paragraph, as the
    assistant read it, and what it's filed under. { result: classifyDoc(…), summary }. */
function classifiedOnProcessing(d) {
  const body = X.docText?.(d) || '';
  const result = classifyDoc(d, d.classCtx || null, [d.name, d.submission?.note, body].filter(Boolean).join(' '));
  const opening = (X.docModel?.(d)?.chunks || []).find(b => b.kind === 'p' && b.text?.length > 20)?.text || '';
  const prim = result.assignments.filter(x => x.primary).map(x => conceptName(x.id).toLowerCase());
  const about = prim.length ? `About ${prim.join(' and ')}.` : '';
  return { result, summary: [opening.length > 240 ? opening.slice(0, 240).replace(/\s+\S*$/, '') + '…' : opening, about].filter(Boolean).join(' ') };
}
/** Run analysis for every open submission (the review queue reads it). */
const ensureAnalyzed = () => curatedDocs().filter(d => stageOf(d) === 'review').forEach(aiOf);
/** The taxonomy changed: classify every open submission again (their reviewers' unsaved edits reset with it). Returns how many. */
function reclassifyOpen() {
  const open = D.docs.filter(d => !d.archived && stageOf(d) === 'review' && d.ai?.status === 'done');
  open.forEach(d => { delete d.ai; aiOf(d); });
  return open.length;
}
/** Suggest a collection for a file the contributor didn't place: the one whose name, description and usual concepts
    (its prior rules) best match its title. */
function suggestKb(name) {
  const cands = contributionTargets(); if (!cands.length) return null;
  const words = new Set(tokens(name));
  const scored = cands.map(k => ({ k, s: [k.name, k.desc, ...(D.conceptRules || []).filter(r => r.when?.kb === k.id).map(r => conceptName(r.then))].join(' ') }))
    .map(({ k, s }) => ({ k, n: tokens(s).filter(w => words.has(w)).length })).sort((a, b) => b.n - a.n);
  return scored[0].k;
}

/* ═══════════════ Suggestions: assignments awaiting review, the pool, proposals ═══════════════ */
/** Classification › Suggestions › Awaiting review: published documents' suggested assignments grouped by concept, in
    collections the caller edits: [{ concept, scheme, docs }] (most first). `scheme` limits it. */
function pendingByConcept(scheme = '') {
  const m = new Map();
  curatedDocs().filter(d => stageOf(d) === 'published' && canEditKb(kbById(d.kb))).forEach(d => docAssignments(d).filter(a => a.state === 'suggested' && (!scheme || a.scheme === scheme)).forEach(a => (m.get(a.id) || m.set(a.id, []).get(a.id)).push(d)));
  return [...m].map(([concept, docs]) => ({ concept, scheme: conceptById(concept).scheme, docs })).sort((a, b) => b.docs.length - a.docs.length);
}
/** The pool: published documents a scheme couldn't file with confidence (outcome uncertain), per scheme or all. */
const unclassifiedPool = (scheme = '') => curatedDocs().filter(d => stageOf(d) === 'published' && canEditKb(kbById(d.kb)) && (d.uncertain || []).some(s => !scheme || s === scheme));
/** Accept every suggested assignment of a concept (`docs`: limit to these; confirmAssignments). Returns how many. */
function confirmAssignments(conceptId, docs = null) {
  let n = 0;
  (docs || pendingByConcept().find(g => g.concept === conceptId)?.docs || []).forEach(d => (d.concepts || []).forEach(a => {
    if (a.id !== conceptId || a.state !== 'suggested') return;
    const s = schemeById(conceptById(a.id).scheme);
    a.state = 'accepted'; a.reviewedBy = me().id; a.reviewedAt = Date.now(); n++;
    if (s?.hasPrimary && !d.concepts.some(o => o !== a && o.primary && o.state === 'accepted' && conceptById(o.id)?.scheme === s.id)) a.primary = true;
  }));
  if (n) lifeAudit('Confirmed suggested concepts', `${conceptName(conceptId)} · ${n}`);
  return n;
}
/** Reject every suggested assignment of a concept (rejectAssignments): the rows stay as rejected, so the classifier
    doesn't propose them again; a scheme left without a label goes back to the pool. Returns how many. */
function rejectAssignments(conceptId, docs = null) {
  let n = 0;
  (docs || pendingByConcept().find(g => g.concept === conceptId)?.docs || []).forEach(d => {
    (d.concepts || []).forEach(a => { if (a.id === conceptId && a.state === 'suggested') { a.state = 'rejected'; a.reviewedBy = me().id; a.reviewedAt = Date.now(); n++; } });
    const s = schemeById(conceptById(conceptId)?.scheme);
    if (s && (s.minLabels || 0) > 0 && !docAssignments(d).some(a => a.scheme === s.id)) d.uncertain = [...new Set([...(d.uncertain || []), s.id])];
  });
  if (n) lifeAudit('Rejected suggested concepts', `${conceptName(conceptId)} · ${n}`);
  return n;
}
/** D.conceptProposals: { id, scheme, kind: concept | label, name, definition?, broader? (concept), target?, labelKind?
    (label: alt | hidden), origin: cluster | correction | member, state: open | accepted | rejected, docs: [ids], n?
    (documents when a cluster is larger than its sample), at, concept? (the concept accepting created or changed) }.
    The classifier never creates them: the weekly clustering of the pool and repeated corrections do (learnLabels runs
    before they're listed, so seeded corrections show up too). */
const openProposals = ({ scheme = '', kind = '' } = {}) => { learnLabels(); return (D.conceptProposals || []).filter(p => p.state === 'open' && (!scheme || p.scheme === scheme) && (!kind || p.kind === kind)); };
const proposalById = id => (D.conceptProposals || []).find(p => p.id === id) || null;
/** How many decisions wait in Classification › Suggestions (its tab count; shown nowhere else). */
const suggestionCount = () => pendingByConcept().length + openAssignmentBatches().length + new Set(unclassifiedPool().flatMap(d => d.uncertain)).size + openProposals().length;
/** The content language of a scheme's labels: Vietnamese when its concepts are named in Vietnamese. */
const schemeLang = schemeId => (conceptsOf(schemeId).some(c => c.pref?.vi) ? 'vi' : 'en');
/** A notation (the concept's API ID) from a name, unique in its scheme over every concept it ever had. */
function newNotation(schemeId, name) {
  const base = (fold(name).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'concept').replace(/^[^a-z]+/, 'c-').slice(0, 56);
  const taken = new Set((D.concepts || []).filter(c => c.scheme === schemeId).map(c => c.notation));
  let n = base, i = 2; while (taken.has(n)) n = `${base}-${i++}`;
  return n;
}
/** An unpublished edit of a scheme's working copy (scheme.changes: { kind: added | relabeled | redefined | moved |
    deprecated | merged | split | thresholds, concept, text, at, by }): Publish lists and publishes them. */
function noteChange(schemeId, kind, concept, text = '') {
  const s = schemeById(schemeId); if (!s) return;
  (s.changes ??= []).push({ kind, concept, text, at: Date.now(), by: me().id });
}
const pendingChanges = schemeId => schemeById(schemeId)?.changes || [];
/** Accept a proposal: a new concept becomes a draft in the tree (classified once the scheme is published); a label is
    added to its concept as an alternative (or hidden) label. Returns the concept. */
function acceptProposal(p, { name = p.name, broader = p.broader, definition = p.definition } = {}) {
  if (!canManageTaxonomy() || p.state !== 'open') return null;
  const lang = schemeLang(p.scheme);
  let c;
  if (p.kind === 'label') {
    c = conceptById(p.target); if (!c) return null;
    (c[p.labelKind === 'hidden' ? 'hidden' : 'alt'] ??= []).push([lang, name]);
    noteChange(c.scheme, 'relabeled', c.id, name);
  } else {
    c = { id: uid('c'), scheme: p.scheme, notation: newNotation(p.scheme, name), pref: { [lang]: name }, alt: [], hidden: [], definition: definition || '', scope: '', examples: [], broader: broader ? [broader] : [], related: [], mappings: [], patterns: [], state: 'draft' };
    D.concepts.push(c);
    noteChange(p.scheme, 'added', c.id, name);
  }
  Object.assign(p, { state: 'accepted', concept: c.id, decided: Date.now(), by: me().id });
  lifeAudit(p.kind === 'label' ? 'Added a suggested label' : 'Accepted a proposed concept', name);
  return c;
}
function rejectProposal(p) {
  if (!canManageTaxonomy() || p.state !== 'open') return;
  Object.assign(p, { state: 'rejected', decided: Date.now(), by: me().id });
  lifeAudit(p.kind === 'label' ? 'Rejected a suggested label' : 'Rejected a proposed concept', p.name);
}

/* ═══════════════ Mutations (data + audit; callers refresh and toast) ═══════════════ */
function lifeAudit(action, target) { D.audit.unshift({ id: uid('ev'), at: Date.now(), actor: me().id, action, type: 'Knowledge', target, outcome: 'success', ip: '10.4.12.30', device: 'Chrome on macOS' }); }
const event = (d, kind, text = '') => { (d.submission ??= { by: null, at: d.updated, events: [] }).events ??= []; d.submission.events.push({ at: Date.now(), by: me().id, kind, text }); };
/** Analysis runs in the background after submit (~2 s). */
function analyzeSoon(d, ms = 1800) {
  d.ai = { status: 'analyzing' };
  setTimeout(() => { if (!D.docs.includes(d) || d.ai?.status !== 'analyzing') return; d.ai = null; aiOf(d); refresh(); }, ms);
}
/** Submit files for review. files: [{name, size, type, kb?, confirmed?}] — per file, the collection and the details the contributor
    confirmed ({ kind, concepts, summary }; aiOf starts from them). opts: { kb?, note?, versionOf? }. Returns the new documents. */
function submitFiles(files, { kb, note = '', versionOf } = {}) {
  const base = versionOf ? docById(versionOf) : null;
  return files.map(f => {
    const target = kbById(base?.kb || f.kb || kb) || suggestKb(f.name);
    const d = {
      id: uid('d'), kb: target?.id, ...(f.folder && target?.id === f.kb ? { folder: f.folder } : {}), name: f.name, type: (f.type || f.name.split('.').pop() || 'file').toLowerCase(), size: Math.round(f.size || 120e3),
      status: 'pending', stage: 'review', source: 'upload', updated: Date.now(), addedBy: me().name, pages: Math.max(1, Math.round((f.size || 120e3) / 9e4) % 60 || 3), passages: 0, error: f.error || '',
      submission: { by: me().id, at: Date.now(), note: note.trim(), kbBy: base || f.kb || kb || f.confirmed ? 'contributor' : 'ai', ...(versionOf ? { versionOf } : {}), ...(f.confirmed ? { confirmed: f.confirmed } : {}), events: [{ at: Date.now(), by: me().id, kind: 'submitted', text: note.trim() }] },
    };
    // The contributor already watched the analysis and confirmed it: the suggestion is ready at once. Otherwise it runs in the background.
    D.docs.push(d); if (f.confirmed) aiOf(d); else analyzeSoon(d);
    lifeAudit(versionOf ? 'Submitted a new version' : 'Submitted a document for review', d.name);
    return d;
  });
}
/** Move a private file (My files) into review for a collection — same document, no copy. */
function submitPrivate(d, kbId, note = '') {
  d.kb = kbId; d.stage = 'review'; d.status = 'pending';
  d.submission = { by: me().id, at: Date.now(), note, kbBy: 'contributor', events: [{ at: Date.now(), by: me().id, kind: 'submitted', text: note }] };
  analyzeSoon(d); lifeAudit('Submitted a document for review', d.name);
}
/** Contributor resubmits after changes (optionally with a new file, which isn't processed yet). */
function resubmit(d, { note = '', file } = {}) {
  if (file) { Object.assign(d, { name: file.name, size: Math.round(file.size || d.size), type: (file.name.split('.').pop() || d.type).toLowerCase(), error: '', status: 'pending' }); delete d.processedAt; delete d.classCtx; }
  d.stage = 'review'; event(d, 'resubmitted', note); analyzeSoon(d, 1200);
  lifeAudit('Resubmitted a document', d.name);
}
/** Contributor withdraws a submission (tombstone). */
function withdraw(d) { d.archived = true; event(d, 'withdrawn'); lifeAudit('Withdrew a submission', d.name); }
/** Reviewer approves with the final classification and publishes. decision: { concepts (ids across schemes; omitted = the
    assistant's assignments as they are, suggested ones still awaiting review), kb, summary, title?, asVersionOf }.
    Approval never processes: a new document was processed before review and stays as it was (its index follows it to the
    collection); a new version is appended Not processed, and waits in Documents → Processing. A reviewer's change to the
    concepts is always recorded as a correction (label learning). `title` renames a new document (its file keeps its name).
    Returns the published document. */
function approveAndPublish(d, decision = {}) {
  const ai = aiOf(d), aiIds = ai.concepts.map(x => x.id);
  const holder = { concepts: decision.concepts ? [] : ai.concepts.map(storedAssignment), uncertain: decision.concepts ? [] : [...(ai.uncertain || [])] };
  if (decision.concepts) { holder.uncertain = [...(ai.uncertain || [])]; setDocConcepts(holder, decision.concepts); }
  const meta = {
    concepts: holder.concepts, uncertain: holder.uncertain,
    summary: (decision.summary ?? ai.summary) || undefined,
    classifiedBy: decision.concepts ? 'person' : 'assistant',
  };
  if (decision.concepts) recordCorrection(d, aiIds, decision.concepts);
  const unsupported = UNPROCESSABLE.includes(d.type);
  const versionOf = decision.asVersionOf || d.submission?.versionOf;
  const orig = versionOf && docById(versionOf);
  event(d, 'approved', decision.note || '');
  if (orig) {
    const r = res(orig);
    orig.versions = [{ v: r.version + 1, at: Date.now(), by: contributorName(d), note: decision.note || d.submission?.note || 'New version' }, ...r.versions];
    Object.assign(orig, { version: r.version + 1, size: d.size, type: d.type, status: unsupported ? 'unsupported' : 'pending', error: d.error || '', updated: Date.now(), ...meta });
    // The submission stays as the record of who contributed which version; the published document is its versionOf.
    Object.assign(d, { stage: 'versioned', submission: { ...d.submission, versionOf: orig.id } });
    lifeAudit('Published a new version', orig.name);
    return orig;
  }
  if (decision.kb && decision.kb !== d.kb) d.kb = decision.kb;
  if (decision.title) d.name = decision.title;
  Object.assign(d, { stage: 'published', status: unsupported ? 'unsupported' : processingOf(d), ...meta });
  lifeAudit('Approved and published a document', d.name);
  return d;
}
function requestChanges(d, text) { d.stage = 'changes'; event(d, 'changes', text); lifeAudit('Requested changes', d.name); }
function rejectSubmission(d, text) { d.stage = 'rejected'; event(d, 'rejected', text); lifeAudit('Declined a submission', d.name); }
function unpublish(d, text = '') { d.stage = 'unpublished'; event(d, 'unpublished', text); lifeAudit('Unpublished a document', d.name); }
/** Publishing again keeps how far it was processed (unpublishing never removes the index). */
function republish(d) { d.stage = 'published'; event(d, 'published'); lifeAudit('Published a document again', d.name); }
/** Restore a snapshot taken with snapDoc (Undo for any lifecycle change). */
const snapDoc = d => JSON.parse(JSON.stringify(d));
function restoreDoc(d, snap) { Object.keys(d).forEach(k => delete d[k]); Object.assign(d, snap); }
