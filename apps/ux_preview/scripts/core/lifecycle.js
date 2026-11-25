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
               the target collection's topics and its suggestion is replaced with what it chose (aiOf).
   Decide      Reviewers (owners of the target collection; workspace admins own all) approve, request changes or decline
               in Knowledge Studio → Documents → Review. Corrections to the classification are recorded and turned into
               topic keywords by workspace admins (Topics → Suggestions).
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
  analyzing: { tone: 'accent', label: 'Analyzing', icon: 'sparkles', live: true, desc: 'Reading the file and suggesting topics, a collection and a summary.' },
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
  processing: { label: 'Processing', tone: 'accent', icon: 'loader', live: true, desc: 'Being read, classified against your topics and indexed.' },
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
/** Topics the pipeline chose (not a person): applied by the assistant, or synced without anyone touching them. */
const topicsByPipeline = d => d.classifiedBy === 'assistant' || (!d.classifiedBy && !d.submission && !!d.source && d.source !== 'upload');
/** Reviewers' corrections to the pipeline's topics: { id, doc, title, from:[ids], to:[ids], by, at, status: open | used |
    dismissed }. They never change the rules by themselves: a workspace admin turns them into keywords or examples. */
function recordCorrection(d, from, to) {
  if (!to.some(id => !from.includes(id))) return null;
  const c = { id: uid('cc'), doc: d.id, title: d.name, from: [...from], to: [...to], by: me().id, at: Date.now(), status: 'open' };
  (D.classCorrections ??= []).unshift(c);
  return c;
}
const openCorrections = () => (D.classCorrections || []).filter(c => c.status === 'open' && c.to.some(id => topicById(id) && !topicById(id).archived));
/** Words that say nothing about a topic on their own (titles are full of them). */
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
/** What the open corrections suggest, per topic reviewers moved documents to. `phrases`: words that two or more of those
    titles share and the topic doesn't know yet (one correction isn't a pattern). `misled`: words in those titles that are
    another topic's keyword — why the pipeline filed them there. [{ topic, corrections, from:[ids], phrases, misled }],
    each phrase { text, n, elsewhere }. */
function correctionSuggestions() {
  const by = new Map();
  openCorrections().forEach(c => c.to.filter(id => !c.from.includes(id) && topicById(id)).forEach(id => (by.get(id) || by.set(id, []).get(id)).push(c)));
  const owner = new Map();
  topicTree().flatMap(dm => dm.children).forEach(t => [...topicKeywords(t), ...topicSynonyms(t)].forEach(k => owner.set(fold(k), t.id)));
  return [...by].map(([id, cs]) => {
    const count = new Map();
    cs.forEach(c => phrasesOf(c.title).forEach(p => count.set(p, (count.get(p) || 0) + 1)));
    const all = [...count].filter(([p]) => owner.get(fold(p)) !== id && fold(p) !== fold(topicById(id).name))
      .map(([text, n]) => ({ text, n, elsewhere: owner.get(fold(text)) || '' }))
      .sort((a, b) => b.n - a.n || b.text.split(' ').length - a.text.split(' ').length || a.text.localeCompare(b.text));
    const from = [...new Set(cs.flatMap(c => c.from.filter(f => !c.to.includes(f))))];
    return { topic: id, corrections: cs, from, phrases: all.filter(p => !p.elsewhere && p.n >= 2).slice(0, 4), misled: all.filter(p => p.elsewhere).slice(0, 3) };
  }).sort((a, b) => b.corrections.length - a.corrections.length);
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
/** A first sync's topics, grouped for people to confirm in bulk (D.classGroups): the open ones in bases the caller edits. */
const openClassGroups = () => (D.classGroups || []).filter(g => g.status === 'open' && g.n > 0 && canEditKb(kbById(g.kb)));
/** Processing runs started from Documents (D.runs with kind 'process', no source): the one in flight, if any. */
const activeProcessRun = () => (D.runs || []).find(r => r.kind === 'process' && r.status === 'running') || null;
/* ── A document's processing steps (an ingestion run task's `phases`, api IngestionTask): the pipeline's phases grouped
   into the five steps people see. Task: { state: queued | running | succeeded | failed | cancelled, phases: [{ phase,
   state, start, end }], error, ocr? }. A step the task went past without entering (no topics to choose among,
   contextual retrieval off) was skipped. ── */
const PROC_STEPS = [
  { id: 'read', label: 'Read the file', phases: ['FETCHING', 'PARSING', 'OCR'], desc: 'Opens the file and splits it into passages', ocrDesc: 'Opens the file, recognizes its text and splits it into passages' },
  { id: 'classify', label: 'Classify', phases: ['CLASSIFYING'], desc: 'Picks its topics among the candidates', skipped: 'Skipped: no topics to choose among' },
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
/** Move counters of a backfill by a delta ({ review: -n, published: n, 'topics.filed': n }); sign -1 undoes it. */
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
/** Proposed-topic heuristics: [pattern, topic name, preferred parent domains by name]. Proposed only when no topic of that name exists. */
const PROPOSAL_RULES = [
  [/open banking|open api|account aggregation/i, 'Open banking', ['Product & Business', 'Engineering & Architecture', 'Product']],
  [/\bai governance|\bllm\b|genai|gen ai|model risk/i, 'AI governance', ['Security & Compliance', 'Data Platform & Analytics']],
  [/intern/i, 'Internships', ['Internal Policies & Guidelines', 'People']],
  [/sustainab|carbon|emission|\besg\b/i, 'Sustainability', []],
  [/hybrid work|return to office/i, 'Hybrid work', ['People', 'Internal Policies & Guidelines']],
];
const PERSONAL_RE = /\bcv\b|résumé|resume|transcript|salary|payslip|passport|national id|\bid card\b|medical|customer export|card numbers?|\bpan\b|cccd/i;
const conf = (seed, lo = 0.62, hi = 0.97) => Math.round((lo + (hashOf(seed) % 1000) / 1000 * (hi - lo)) * 100) / 100;
/** Words shared by several topic names ("engineering", "learning") say little on their own. */
function genericTopicWords() {
  const n = new Map(); topicTree().flatMap(dm => dm.children).forEach(t => new Set(tokens(t.name)).forEach(w => n.set(w, (n.get(w) || 0) + 1)));
  return new Set([...n].filter(([, c]) => c > 1).map(([w]) => w));
}
/** Topics (Knowledge Studio → Topics): on each topic a workspace admin keeps keywords and synonyms (the same signal),
    optional rules on where a document lives or comes from, and example documents. Guidance (t.guidance) is free text the
    assistant reads with the rest; the mock matcher below doesn't use it. */
const topicKeywords = t => (t?.keywords || []).map(k => String(k).trim()).filter(Boolean);
const topicSynonyms = t => (t?.synonyms || []).map(k => String(k).trim()).filter(Boolean);
/** Rules (the contract's TopicRule, exactly one of two kinds): { field: 'collection', value: kb or folder id } = documents
    in that collection's subtree; { field: 'source', value: source id } = documents that live source registered (uploads aren't a source). */
const RULE_FIELDS = { collection: 'Collection', source: 'Source' };
const topicRules = t => (t?.rules || []).filter(r => r && RULE_FIELDS[r.field] && String(r.value ?? '').trim());
/** Example documents that represent a topic (published ones only; the caller's access is checked where they're shown). */
const topicExamples = t => (t?.examples || []).map(docById).filter(d => d && !d.archived && isPublishedStage(d));
const ruleSourceName = v => srcById(v)?.name || v;
const ruleCollectionName = v => kbById(v)?.name || folderById(v)?.name || v;
/** A collection rule holds for a document in that collection or anywhere under it; a source rule for a document that
    source registered (uploads have no source, so no source rule matches them). */
function ruleMatches(r, doc) {
  if (!doc || !r?.value) return false;
  if (r.field === 'source') return !!doc.source && doc.source === r.value && !!srcById(r.value);
  if (r.field !== 'collection') return false;
  if (doc.kb === r.value) return true;
  const f = folderById(r.value);
  return !!f && f.kb === doc.kb && folderSubtree(f.id).includes(doc.folder);
}
/** "documents in “Chargebacks”" — a rule in words (Topics, Review's evidence, the prompt). */
const ruleText = r => (r.field === 'source' ? `documents from “${ruleSourceName(r.value)}”` : `documents in “${ruleCollectionName(r.value)}”`);
/** Title similarity (shared words over all words) — duplicates and topic examples. */
function titleSim(a, b) {
  const x = titleWords(a), y = titleWords(b); if (!x.size || !y.size) return 0;
  const i = [...x].filter(w => y.has(w)).length;
  return i / (x.size + y.size - i);
}
const phrase = s => ' ' + fold(s).replace(/[^a-z0-9]+/g, ' ').trim() + ' ';
/** Topic suggestions. A rule on where the document lives or comes from settles them: when any topic's rule holds, the
    document gets exactly those topics and nothing else is weighed (the model isn't asked). Otherwise, strongest first:
    keywords or synonyms found in the title or note, distinctive words of the topic name, the topics of similar published
    documents, a title close to one of the topic's examples, and what the target collection mostly holds. `doc`
    ({ name, kb, folder, source }) is needed for rules and examples; without it they don't count. `only` (a Set of topic
    ids) limits the candidates — a processing run's chosen topics.
    Returns [{id, score, why:{keywords[], synonyms[], name, similar, example, rule, base}}] (best first, max 3; every rule hit) — `why` is shown to the reviewer. */
function topicMatches(text, kb, similar = [], doc = null, only = null) {
  const words = new Set(tokens(text)), stems = new Set([...words].map(w => w.slice(0, 5))), generic = genericTopicWords(), hay = phrase(text);
  const kbDocs = kb ? docsIn(kb.id) : [];
  const share = id => (kbDocs.length ? kbDocs.filter(x => res(x).topics.includes(id)).length / kbDocs.length : 0);
  const fromSimilar = new Map();
  similar.forEach(s => res(s.doc).topics.forEach(id => { if ((fromSimilar.get(id)?.sim || 0) < s.sim) fromSimilar.set(id, { sim: s.sim, doc: s.doc.id }); }));
  const leaves = topicTree().flatMap(dm => dm.children).filter(t => !only || only.has(t.id));
  const none = { keywords: [], synonyms: [], name: false, similar: '', example: '', base: false };
  const ruled = doc ? leaves.map(t => ({ id: t.id, score: 0, why: { ...none, rule: topicRules(t).find(r => ruleMatches(r, doc)) || null } })).filter(x => x.why.rule) : [];
  if (ruled.length) return ruled;
  const found = k => phrase(k).trim() && hay.includes(phrase(k));
  const scored = leaves.map(t => {
    const tw = tokens(t.name).filter(w => !generic.has(w)), key = tw.length ? tw : tokens(t.name);
    const hit = key.filter(w => words.has(w) || stems.has(w.slice(0, 5))).length / Math.max(1, key.length);
    const kw = topicKeywords(t).filter(found), syn = topicSynonyms(t).filter(found);
    const ex = doc ? topicExamples(t).filter(e => e.id !== doc.id).map(e => ({ id: e.id, sim: titleSim(doc.name || text, e.name) })).sort((a, b) => b.sim - a.sim)[0] : null;
    const exSim = ex && ex.sim >= 0.2 ? ex.sim : 0;
    const sim = fromSimilar.get(t.id), base = !!kb?.topics?.includes(t.id) || share(t.id) >= 0.25;
    const score = Math.min(1.4, (kw.length + syn.length) * 0.8) + (hit >= 0.75 ? hit : 0) + (sim?.sim || 0) * 0.9 + exSim * 0.7 + (kb?.topics?.includes(t.id) ? 0.4 : 0) + share(t.id) * 0.3;
    return { id: t.id, score, why: { keywords: kw.slice(0, 3), synonyms: syn.slice(0, 3), name: hit >= 0.75, similar: sim && sim.sim >= 0.3 ? sim.doc : '', example: exSim ? ex.id : '', rule: null, base } };
  }).filter(x => x.score >= 0.5).sort((a, b) => b.score - a.score).slice(0, 3);
  if (scored.length || !kbDocs.length) return scored;
  // Nothing distinctive: fall back to what the destination base mostly holds, with low confidence.
  const top = leaves.map(t => ({ id: t.id, score: share(t.id) })).sort((a, b) => b.score - a.score)[0];
  return top && top.score >= 0.25 ? [{ id: top.id, score: 0.3, why: { keywords: [], synonyms: [], name: false, similar: '', example: '', rule: null, base: true } }] : [];
}
/** A suggestion's evidence in words, strongest first (Publish's Classification card, the rules' test box). Documents the caller can't see aren't named. */
function topicEvidence(w = {}) {
  const o = w.similar && docById(w.similar), ex = w.example && docById(w.example);
  const q = list => list.map(k => `“${k}”`).join(', ');
  return [
    w.contributor && 'confirmed by the contributor',
    w.rule && `rule: ${ruleText(w.rule)}`,
    // Keywords and synonyms count the same and people edit them as one list, so their evidence reads the same.
    (w.keywords?.length || w.synonyms?.length) && `matched ${q([...(w.keywords || []), ...(w.synonyms || [])].slice(0, 3))}`,
    w.name && 'the title names it',
    ex && canSeeDoc(ex) && `close to the example “${docTitle(ex)}”`,
    o && canSeeDoc(o) && `like “${docTitle(o)}”`,
    w.base && !w.keywords?.length && !w.synonyms?.length && !w.name && !w.rule && 'common in this collection',
  ].filter(Boolean);
}
/** The topics the assistant applies when it classifies (the CLASSIFYING step picks them among the candidates; no
    confidence score, no threshold): every topic whose rule holds (rules settle it, the model isn't asked); otherwise
    matches with real evidence (keywords, synonyms or the topic's own name), at most two. A document it gives no topic
    is published without one and listed in Topics → Suggestions. `ctx` is a processing run's classification context:
    { topics: [ids] (only these are candidates; empty = all), note (read with the title, as the assistant would read
    it with the file) }. `text`: what it reads (the title; a submission's processing reads its note and file too).
    Returns the chosen matches with their evidence (topicMatches). */
function pipelineMatches(d, ctx = null, text = d.name) {
  const only = ctx?.topics?.length ? new Set(ctx.topics) : null;
  const m = topicMatches(ctx?.note ? `${text} ${ctx.note}` : text, kbById(d.kb), similarDocs(d), d, only);
  if (m.some(x => x.why.rule)) return m;
  return m.filter(x => x.why.keywords.length || x.why.synonyms.length || x.why.name).slice(0, 2);
}
const pipelineTopics = (d, ctx = null) => pipelineMatches(d, ctx).map(x => x.id);
/** Classify a document nobody chose topics for (sources' syncs, processing runs). With a context, topics the pipeline
    chose before are chosen again within it; topics a person chose always stay. The context stays on the document
    (`classCtx`), so a later change to the topics re-checks it within the same choices. */
function autoClassify(d, ctx = null) {
  if (ctx && d.topics?.length && topicsByPipeline(d)) d.topics = [];
  if (d.topics?.length) return [];
  if (ctx) d.classCtx = ctx; else delete d.classCtx;
  const ids = pipelineTopics(d, ctx);
  if (ids.length) { d.topics = ids; d.classifiedBy = 'assistant'; }
  return ids;
}
/** Processed, published documents whose topics the pipeline chose or never found: what a change to the topics re-checks
    (a document that isn't processed hasn't been classified yet). */
const reclassifiable = () => curatedDocs().filter(d => stageOf(d) === 'published' && d.status === 'ready' && (topicsByPipeline(d) || !d.topics?.length));
/** The topics changed (`before`: the topics as they were): classify again the published documents whose
    topics the pipeline chose (people's choices stay), and move those whose result the change actually alters. No indexing
    again: topics live in the index's metadata, not in the passages' text. The documents show as Classifying for a moment.
    Returns { checked, changed: [[doc, before, after, classifiedBy]], revert() } and finishes on its own (onDone);
    revert() puts the topics back (before or after it finished). */
function reclassifyPublished(before, onDone) {
  const docs = reclassifiable(), now = D.topics;
  D.topics = before;
  const old = new Map(docs.map(d => [d, pipelineTopics(d, d.classCtx).join()]));
  D.topics = now;
  const changed = [];
  docs.forEach(d => {
    const next = pipelineTopics(d, d.classCtx), was = d.topics ? [...d.topics] : undefined;
    if (next.length && next.join() !== old.get(d) && next.join() !== (was || []).join()) changed.push([d, was, next, d.classifiedBy]);
    d.reclassifying = true;
  });
  let reverted = false;
  setTimeout(() => {
    docs.forEach(x => delete x.reclassifying);
    if (reverted) return;
    changed.forEach(([x, , next]) => { x.topics = next; x.classifiedBy = 'assistant'; });
    onDone?.(); refresh();
  }, 1600);
  const revert = () => {
    reverted = true;
    docs.forEach(x => delete x.reclassifying);
    changed.forEach(([x, was, , by]) => { if (was) x.topics = was; else delete x.topics; if (by) x.classifiedBy = by; else delete x.classifiedBy; });
  };
  return { checked: docs.length, changed, revert };
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
    { status, topics:[{id,conf,why}], proposed:[proposalId], kb:{id,conf,by}, summary, title?, flags:[{type, doc?, sim?, text}], confirmed?, processed? }.
    `title`: the clean name the CLASSIFYING step wrote for a processed new document (d.classTitle), for the reviewer to approve.
    On submit, topics are matched against the workspace's taxonomy from the title and note (topicMatches); `why` says which
    evidence matched. Once a new document's submission is processed, its topics and summary are what the assistant chose
    while processing it (classifiedOnProcessing): `processed` = { at, topics: n chosen for its run, note }. When the
    contributor confirmed the details before submitting (d.submission.confirmed = { topics, summary }), their topics stay
    and carry `why.contributor` (plus the assistant's own evidence where it matched too). */
function aiOf(d) {
  if (d.ai) return d.ai;
  const c = d.submission?.confirmed || null;
  const kb = kbById(d.kb), text = [d.name, d.submission?.note, c?.summary, d.summary].filter(Boolean).join(' ');
  const similar = similarDocs(d);
  const done = isCandidate(d) && ['ready', 'outdated'].includes(d.status) ? classifiedOnProcessing(d) : null;
  const matched = done ? done.matches : topicMatches(text, kb, similar, d).map(x => ({ id: x.id, why: x.why }));
  const confirmed = c ? c.topics.filter(id => topicById(id)).map(id => { const m = matched.find(x => x.id === id); return { id, why: { ...(m?.why || {}), contributor: true } }; }) : [];
  const topics = c ? (done ? [...confirmed, ...matched.filter(x => !c.topics.includes(x.id))] : confirmed) : matched;
  const proposed = [];
  PROPOSAL_RULES.forEach(([re, name, parents]) => {
    if (!re.test(text) || (D.topics || []).some(t => fold(t.name) === fold(name))) return;
    const parent = (D.topics || []).find(t => !t.parent && !t.archived && parents.some(p => fold(p) === fold(t.name)))?.id || null;
    proposed.push(proposeTopic(name, parent, d.id).id);
  });
  const flags = [];
  const sim = similar.filter(x => x.sim >= 0.55);
  if (d.submission?.versionOf) { const o = docById(d.submission.versionOf); if (o) flags.push({ type: 'version', doc: o.id, text: `New version of “${o.name}”` }); }
  else if (sim.length) flags.push({ type: 'duplicate', doc: sim[0].doc.id, sim: sim[0].sim, text: `Looks like “${sim[0].doc.name}” (${Math.round(sim[0].sim * 100)}% similar title)` });
  if (PERSONAL_RE.test(text)) flags.push({ type: 'personal', text: 'May contain personal data. Check before publishing.' });
  if (['png', 'jpg', 'jpeg', 'zip'].includes(d.type)) flags.push({ type: 'format', text: 'This file type can’t be searched; people could only download it.' });
  else if (d.error) flags.push({ type: 'unreadable', text: d.error });
  d.ai = {
    status: 'done', at: Date.now(),
    topics, proposed,
    kb: { id: d.kb, conf: d.submission?.kbBy === 'ai' ? conf(d.id + 'kb', 0.6, 0.85) : 1, by: d.submission?.kbBy || 'contributor' },
    summary: done?.summary || c?.summary || d.summary || `Contributed by ${contributorName(d)}${topics.length ? ` about ${topics.map(t => topicName(t.id).toLowerCase()).join(' and ')}` : ''}.`,
    flags, ...(c ? { confirmed: true } : {}),
    ...(done && d.classTitle && !d.submission?.versionOf ? { title: d.classTitle } : {}),
    ...(done ? { processed: { at: d.processedAt || Date.now(), topics: d.classCtx?.topics?.length || 0, note: !!d.classCtx?.note } } : {}),
  };
  return d.ai;
}
/** What processing a new document's submission chose (the CLASSIFYING step): the target collection's rules settle it,
    else the topics its title, note and text support, at most two (pipelineMatches) — within the run's chosen topics when
    it had some (d.classCtx). The summary is the file's opening paragraph, as the assistant read it, and what it's filed
    under. No confidence: the step picks topics, it doesn't score them. { matches: [{ id, why }], summary }. */
function classifiedOnProcessing(d) {
  const body = X.docText?.(d) || '';
  const matches = pipelineMatches(d, d.classCtx || null, [d.name, d.submission?.note, body].filter(Boolean).join(' ')).map(x => ({ id: x.id, why: x.why }));
  const opening = (X.docModel?.(d)?.chunks || []).find(b => b.kind === 'p' && b.text?.length > 20)?.text || '';
  const about = matches.length ? `About ${matches.map(x => topicName(x.id).toLowerCase()).join(' and ')}.` : '';
  return { matches, summary: [opening.length > 240 ? opening.slice(0, 240).replace(/\s+\S*$/, '') + '…' : opening, about].filter(Boolean).join(' ') };
}
/** Run analysis for every open submission (Topics and the queue read proposals from it). */
const ensureAnalyzed = () => curatedDocs().filter(d => stageOf(d) === 'review').forEach(aiOf);
/** The taxonomy changed: classify every open submission again (their reviewers' unsaved edits reset with it). Returns how many. */
function reclassifyOpen() {
  const open = D.docs.filter(d => !d.archived && stageOf(d) === 'review' && d.ai?.status === 'done');
  open.forEach(d => { delete d.ai; aiOf(d); });
  return open.length;
}
/** Suggest a collection for a file the contributor didn't place: the one whose topics best match its title. */
function suggestKb(name) {
  const cands = contributionTargets(); if (!cands.length) return null;
  const words = new Set(tokens(name));
  const scored = cands.map(k => ({ k, s: [k.name, k.desc, ...(k.topics || []).map(topicName)].join(' ') }))
    .map(({ k, s }) => ({ k, n: tokens(s).filter(w => words.has(w)).length })).sort((a, b) => b.n - a.n);
  return scored[0].k;
}

/* ═══════════════ Proposed topics ═══════════════ */
/** Open proposals live in D.topicProposals: { id, name, parent, docs:[ids], status:'open'|'accepted'|'merged'|'dismissed', at, into? }. */
function proposeTopic(name, parent, docId) {
  D.topicProposals ??= [];
  let p = D.topicProposals.find(x => fold(x.name) === fold(name) && x.status === 'open');
  if (!p) { p = { id: uid('tp'), name, parent, docs: [], status: 'open', at: Date.now() }; D.topicProposals.push(p); }
  if (docId && !p.docs.includes(docId)) p.docs.push(docId);
  return p;
}
const openProposals = () => { ensureAnalyzed(); return (D.topicProposals || []).filter(p => p.status === 'open'); };
const proposalById = id => (D.topicProposals || []).find(p => p.id === id);
/** Admin accepts a proposal: creates the topic (and its domain if new) and tags the documents that triggered it. Returns the topic. */
function acceptProposal(p, { name = p.name, parent = p.parent } = {}) {
  if (!canManageTaxonomy() || p.status !== 'open') return null;
  let par = parent;
  if (!par) { const dm = { id: uid('d'), name }; D.topics.push(dm); par = dm.id; }
  const t = { id: uid('t'), name, parent: par }; D.topics.push(t);
  applyTopicToDocs(p.docs, t.id);
  Object.assign(p, { status: 'accepted', into: t.id, decided: Date.now(), by: me().id });
  lifeAudit('Accepted a proposed topic', name);
  return t;
}
/** Admin folds a proposal into an existing topic. */
function mergeProposal(p, topicId) {
  if (!canManageTaxonomy() || p.status !== 'open') return;
  applyTopicToDocs(p.docs, topicId);
  Object.assign(p, { status: 'merged', into: topicId, decided: Date.now(), by: me().id });
  lifeAudit('Merged a proposed topic', `${p.name} → ${topicName(topicId)}`);
}
function dismissProposal(p) {
  if (!canManageTaxonomy() || p.status !== 'open') return;
  Object.assign(p, { status: 'dismissed', decided: Date.now(), by: me().id });
  (p.docs || []).map(docById).filter(Boolean).forEach(d => { if (d.ai) d.ai.proposed = (d.ai.proposed || []).filter(x => x !== p.id); });
  lifeAudit('Dismissed a proposed topic', p.name);
}
function applyTopicToDocs(ids, topicId) {
  (ids || []).map(docById).filter(Boolean).forEach(d => {
    if (stageOf(d) === 'published') d.topics = [...new Set([...(res(d).topics), topicId])];
    else if (d.ai) { const was = d.ai.topics.find(t => t.id === topicId); d.ai.topics = [...d.ai.topics.filter(t => t.id !== topicId), { id: topicId, accepted: true, why: was?.why }]; d.ai.proposed = []; }
  });
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
    confirmed ({ kind, topics, summary }; aiOf starts from them). opts: { kb?, note?, versionOf? }. Returns the new documents. */
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
/** Reviewer approves with the final classification and publishes. decision: { topics, kb, summary, title?, acceptProposals:[ids],
    asVersionOf, teach }. Approval never processes: a new document was processed before review and stays as it was (its
    index follows it to the collection); a new version is appended Not processed, and waits in Documents → Processing.
    `teach`: record a changed topic as a correction for the topics. `title` renames a new document (its file keeps its name). Returns the published document. */
function approveAndPublish(d, decision = {}) {
  const ai = aiOf(d);
  (decision.acceptProposals || []).map(proposalById).filter(Boolean).forEach(p => { const t = acceptProposal(p); if (t) (decision.topics ??= ai.topics.map(x => x.id)).push(t.id); });
  const meta = {
    topics: [...new Set(decision.topics || ai.topics.map(t => t.id))],
    summary: (decision.summary ?? ai.summary) || undefined,
    classifiedBy: 'person',
  };
  if (decision.teach) recordCorrection(d, ai.topics.map(t => t.id), meta.topics);
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
