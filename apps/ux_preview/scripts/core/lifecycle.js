'use strict';
/* Document lifecycle — contribution, curation and publication are separate steps.

   Contribute  Anyone with knowledge.contribute uploads a file and picks (or lets the assistant
               suggest) the collection. Nothing is published: the document is a submission
               (stage 'review') visible only to its contributor and that base's reviewers.
   Curate      Reviewers (owners of the target collection; workspace admins own all) work in Knowledge Studio.
               The assistant classifies every incoming document against the workspace's taxonomy (topics with
               their keywords, synonyms, rules and examples) and suggests type, topics (existing or proposed),
               collection, summary and flags; reviewers approve, request changes or decline. Only workspace
               admins change the taxonomy (import it, edit topics, accept or dismiss proposed topics).
   Publish     Approval publishes: the document joins its collection and is processed
               (status pending → processing → ready). Only published + ready content reaches
               Browse, search, the reader and the assistant (core/catalog.js pools).

   stage:  review → changes ⇄ review → rejected | published → unpublished → published
   status: index/processing state of a published document (pending | processing | ready | failed | outdated | unsupported)
   Users see one combined lifecycle label (lifecycleOf); no one sees "index" or "embedding". */

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
   filters, Share, Request access and the connect-source wizard. */
const KB_ACCESS = {
  workspace: { label: 'Everyone', icon: 'globe' },
  restricted: { label: 'Restricted', icon: 'users' },
  private: { label: 'Private', icon: 'lock' },
};
/** The long description of a general-access level. space = the owning space's name, when there is one. */
function kbAccessDesc(key, space = '') {
  if (key === 'workspace') return `Anyone in ${curWs()?.name || 'the workspace'} can find it and ask about it.`;
  if (key === 'private') return 'Only its owners.';
  return space ? `Only the people and groups you add, plus members of ${space}.` : 'Only the people and groups you add.';
}
/** Filter / Select options: [[key, label]]. */
const KB_ACCESS_OPTIONS = Object.entries(KB_ACCESS).map(([k, a]) => [k, a.label]);
const KB_ROLES = {
  viewer: { label: 'Viewer', icon: 'eye', desc: 'Can search and read its documents.' },
  editor: { label: 'Editor', icon: 'pencil', desc: 'Can also add documents and edit their details.' },
  owner: { label: 'Owner', icon: 'shield', desc: 'Can also review submissions and manage access and settings.' },
};
const KB_ROLE_OPTIONS = Object.entries(KB_ROLES).map(([k, r]) => [k, r.label]);

/* ═══════════════ Lifecycle (one label for people) ═══════════════ */
const LIFECYCLE = {
  analyzing: { tone: 'accent', label: 'Analyzing', icon: 'sparkles', live: true, desc: 'Reading the file and suggesting a type, topics and a collection.' },
  review: { tone: 'accent', label: 'In review', icon: 'clock', desc: 'A reviewer will check it before it’s published.' },
  changes: { tone: 'warning', label: 'Changes requested', icon: 'pencil', desc: 'A reviewer asked for changes before it can be published.' },
  rejected: { tone: 'danger', label: 'Declined', icon: 'x-circle', desc: 'A reviewer declined it. It won’t be published.' },
  queued: { tone: 'default', label: 'Waiting to publish', icon: 'clock', desc: 'Approved. It becomes searchable once it’s published.' },
  publishing: { tone: 'accent', label: 'Publishing', icon: 'loader', live: true, desc: 'It will be searchable in a few minutes.' },
  published: { tone: 'success', label: 'Published', icon: 'check-circle', quiet: true, desc: 'Searchable and available to the assistant.' },
  update: { tone: 'warning', label: 'Update available', icon: 'refresh', desc: 'The original changed at its source. Answers use the previous version until you publish the update.' },
  failed: { tone: 'danger', label: 'Couldn’t publish', icon: 'alert-circle', desc: 'It was approved but couldn’t be made searchable.' },
  merged: { tone: 'success', label: 'Published as new version', icon: 'check-circle', quiet: true, desc: 'It replaced the earlier version of the document.' },
  stored: { tone: 'default', label: 'Stored, not searchable', icon: 'file', desc: 'This file type can’t be searched. People can still download it.' },
  unpublished: { tone: 'default', label: 'Unpublished', icon: 'eye-off', desc: 'Removed from search and answers. Reviewers can publish it again.' },
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
/** The Knowledge Studio flow, in order, then the two off-ramps: [key, label, lifecycle keys].
    Every incoming document — contributed, synced or uploaded — moves In review → Publishing → Published;
    Needs attention holds what stopped (and its fix), Not published what a reviewer turned away or took down. */
const LIFE_GROUPS = [
  ['review', 'In review', ['analyzing', 'review', 'changes']], ['publishing', 'Publishing', ['publishing']], ['published', 'Published', ['published', 'stored']],
  ['attention', 'Needs attention', ['failed', 'queued', 'update']], ['closed', 'Not published', ['rejected', 'unpublished']],
];
/** Older addresses (?life=changes…) land on the group that now holds them. */
const LIFE_GROUP_ALIAS = { changes: 'review', rejected: 'closed', unpublished: 'closed' };

/* ═══════════════ Queries ═══════════════ */
/** Everything a reviewer curates: documents in bases they own (any stage), not archived unless asked. */
const curatedDocs = ({ archived = false } = {}) => D.docs.filter(d => (archived || !d.archived) && canReviewKb(kbById(d.kb)));
/** Submissions waiting for a decision, oldest first. */
const reviewQueue = () => curatedDocs().filter(d => stageOf(d) === 'review').sort((a, b) => (a.submission?.at || a.updated) - (b.submission?.at || b.updated));
/** First syncs at scale hold risky files back in batches, one per reason (D.reviewBatches): the open ones in bases the caller reviews. */
const openBatches = () => (D.reviewBatches || []).filter(b => b.status === 'open' && canReviewKb(kbById(b.kb)));
/** Decisions waiting in Review: submissions plus open batches (what the Review tab and the Studio badge count). */
const reviewDecisionCount = () => reviewQueue().length + openBatches().length;
/** Published from a first sync but filed with low confidence or without a topic (D.classGroups): the open ones in bases the caller edits. */
const openClassGroups = () => (D.classGroups || []).filter(g => g.status === 'open' && g.n > 0 && canEditKb(kbById(g.kb)));
/** A run's at-scale counters (run.backfill), the one source of truth every surface reads. */
const backfillOf = runId => (D.runs || []).find(r => r.id === runId)?.backfill || null;
/** Move counters of a backfill by a delta ({ review: -n, published: n, 'topics.confident': n }); sign -1 undoes it. */
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
/** Taxonomy (Knowledge Studio → Taxonomy): on each topic a workspace admin keeps keywords and synonyms (the same signal),
    optional rules on where a file comes from, and example documents. Guidance (t.guidance) is free text the assistant reads
    with the rest; the mock matcher below doesn't use it. */
const topicKeywords = t => (t?.keywords || []).map(k => String(k).trim()).filter(Boolean);
const topicSynonyms = t => (t?.synonyms || []).map(k => String(k).trim()).filter(Boolean);
/** Rule fields and operators: { field: 'source'|'path'|'type', op: 'is'|'contains', value }. A source value is a source id ('upload' = uploads). */
const RULE_FIELDS = { source: 'Source', path: 'Folder path', type: 'File type' };
const RULE_OPS = { is: 'is', contains: 'contains' };
const topicRules = t => (t?.rules || []).filter(r => r && RULE_FIELDS[r.field] && RULE_OPS[r.op] && String(r.value ?? '').trim());
/** Example documents that represent a topic (published ones only; the caller's access is checked where they're shown). */
const topicExamples = t => (t?.examples || []).map(docById).filter(d => d && !d.archived && isPublishedStage(d));
const ruleSourceName = v => (v === 'upload' ? 'Uploaded files' : srcById(v)?.name || v);
/** What a rule tests on a document: its source (id and name), its path (own path, else the source's folders) or its file type. */
function ruleValues(field, doc) {
  const src = doc?.source && srcById(doc.source);
  if (field === 'source') return [doc?.source, src?.name, doc?.source === 'upload' ? 'Uploaded files' : ''];
  if (field === 'path') return [doc?.path, ...(src?.scope || [])];
  return [doc?.type || String(doc?.name || '').split('.').slice(1).pop()];
}
function ruleMatches(r, doc) {
  if (!doc) return false;
  const norm = x => { const s = fold(x).trim(); return r.field === 'type' ? s.replace(/^\./, '') : s; };
  const v = norm(r.value), vals = ruleValues(r.field, doc).filter(Boolean).map(norm);
  return !!v && (r.op === 'is' ? vals.some(x => x === v) : vals.some(x => x.includes(v)));
}
/** "folder path contains “Chargebacks”" — a rule in words (Taxonomy, Review's evidence). */
const ruleText = r => `${RULE_FIELDS[r.field].toLowerCase()} ${RULE_OPS[r.op]} “${r.field === 'source' ? ruleSourceName(r.value) : r.value}”`;
/** Title similarity (shared words over all words) — duplicates and topic examples. */
function titleSim(a, b) {
  const x = titleWords(a), y = titleWords(b); if (!x.size || !y.size) return 0;
  const i = [...x].filter(w => y.has(w)).length;
  return i / (x.size + y.size - i);
}
const phrase = s => ' ' + fold(s).replace(/[^a-z0-9]+/g, ' ').trim() + ' ';
/** Topic suggestions from these signals, strongest first: a rule on where the file comes from, keywords or synonyms found
    in the title or note, distinctive words of the topic name, the topics of similar published documents, a title close to
    one of the topic's examples, and what the target collection mostly holds. `doc` ({ name, path, type, source }) is
    needed for rules and examples; without it they don't count.
    Returns [{id, score, why:{keywords[], synonyms[], name, similar, example, rule, base}}] (best first, max 3) — `why` is shown to the reviewer. */
function topicMatches(text, kb, similar = [], doc = null) {
  const words = new Set(tokens(text)), stems = new Set([...words].map(w => w.slice(0, 5))), generic = genericTopicWords(), hay = phrase(text);
  const kbDocs = kb ? docsIn(kb.id) : [];
  const share = id => (kbDocs.length ? kbDocs.filter(x => res(x).topics.includes(id)).length / kbDocs.length : 0);
  const fromSimilar = new Map();
  similar.forEach(s => res(s.doc).topics.forEach(id => { if ((fromSimilar.get(id)?.sim || 0) < s.sim) fromSimilar.set(id, { sim: s.sim, doc: s.doc.id }); }));
  const leaves = topicTree().flatMap(dm => dm.children);
  const found = k => phrase(k).trim() && hay.includes(phrase(k));
  const scored = leaves.map(t => {
    const tw = tokens(t.name).filter(w => !generic.has(w)), key = tw.length ? tw : tokens(t.name);
    const hit = key.filter(w => words.has(w) || stems.has(w.slice(0, 5))).length / Math.max(1, key.length);
    const kw = topicKeywords(t).filter(found), syn = topicSynonyms(t).filter(found);
    const rule = topicRules(t).find(r => ruleMatches(r, doc)) || null;
    const ex = doc ? topicExamples(t).filter(e => e.id !== doc.id).map(e => ({ id: e.id, sim: titleSim(doc.name || text, e.name) })).sort((a, b) => b.sim - a.sim)[0] : null;
    const exSim = ex && ex.sim >= 0.2 ? ex.sim : 0;
    const sim = fromSimilar.get(t.id), base = !!kb?.topics?.includes(t.id) || share(t.id) >= 0.25;
    const score = (rule ? 1.2 : 0) + Math.min(1.4, (kw.length + syn.length) * 0.8) + (hit >= 0.75 ? hit : 0) + (sim?.sim || 0) * 0.9 + exSim * 0.7 + (kb?.topics?.includes(t.id) ? 0.4 : 0) + share(t.id) * 0.3;
    return { id: t.id, score, why: { keywords: kw.slice(0, 3), synonyms: syn.slice(0, 3), name: hit >= 0.75, similar: sim && sim.sim >= 0.3 ? sim.doc : '', example: exSim ? ex.id : '', rule, base } };
  }).filter(x => x.score >= 0.5).sort((a, b) => b.score - a.score).slice(0, 3);
  if (scored.length || !kbDocs.length) return scored;
  // Nothing distinctive: fall back to what the destination base mostly holds, with low confidence.
  const top = leaves.map(t => ({ id: t.id, score: share(t.id) })).sort((a, b) => b.score - a.score)[0];
  return top && top.score >= 0.25 ? [{ id: top.id, score: 0.3, why: { keywords: [], synonyms: [], name: false, similar: '', example: '', rule: null, base: true } }] : [];
}
/** A suggestion's evidence in words, strongest first (Review's Classification card, Taxonomy's test box). Documents the caller can't see aren't named. */
function topicEvidence(w = {}) {
  const o = w.similar && docById(w.similar), ex = w.example && docById(w.example);
  const q = list => list.map(k => `“${k}”`).join(', ');
  return [
    w.contributor && 'confirmed by the contributor',
    w.rule && `rule: ${ruleText(w.rule)}`,
    w.keywords?.length && `matched ${q(w.keywords)}`,
    w.synonyms?.length && `synonym ${q(w.synonyms)}`,
    w.name && 'the title names it',
    ex && canSeeDoc(ex) && `close to the example “${docTitle(ex)}”`,
    o && canSeeDoc(o) && `like “${docTitle(o)}”`,
    w.base && !w.keywords?.length && !w.synonyms?.length && !w.name && !w.rule && 'common in this collection',
  ].filter(Boolean);
}
/** Documents from sources that publish automatically skip review, so the assistant applies its confident taxonomy
    matches itself (a rule, keywords, synonyms or the topic's own name; at most two). The rest stay untagged and show in Review → Missing details. */
function autoClassify(d) {
  if (d.topics?.length) return [];
  const ids = topicMatches(d.name, kbById(d.kb), similarDocs(d), d).filter(x => x.why.rule || x.why.keywords.length || x.why.synonyms.length || x.why.name).slice(0, 2).map(x => x.id);
  if (ids.length) { d.topics = ids; d.classifiedBy = 'assistant'; }
  return ids;
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
    { status, kind:{value,conf,by?}, topics:[{id,conf,why}], proposed:[proposalId], kb:{id,conf,by}, summary, flags:[{type, doc?, sim?, text}], confirmed? }.
    Topics are matched against the workspace's taxonomy (topicMatches); `why` says which evidence matched. When the contributor
    confirmed the details before submitting (d.submission.confirmed = { kind, topics, summary }), the suggestion starts from what
    they confirmed: their topics carry `why.contributor` (plus the assistant's own evidence where it matched too). */
function aiOf(d) {
  if (d.ai && d.ai.status !== 'analyzing') return d.ai;
  if (d.ai?.status === 'analyzing') return d.ai;
  const c = d.submission?.confirmed || null;
  const kb = kbById(d.kb), text = [d.name, d.submission?.note, c?.summary, d.summary].filter(Boolean).join(' ');
  const kind = c?.kind || d.kind || inferKind(d);
  const similar = similarDocs(d);
  const matched = topicMatches(text, kb, similar, d).map(x => ({ id: x.id, why: x.why, conf: x.score < 0.5 ? conf(d.id + x.id, 0.48, 0.6) : Math.round(Math.min(0.97, conf(d.id + x.id, 0.66, 0.88) + (x.score > 1.2 ? 0.07 : 0)) * 100) / 100 }));
  const topics = c ? c.topics.filter(id => topicById(id)).map(id => { const m = matched.find(x => x.id === id); return { id, why: { ...(m?.why || {}), contributor: true }, conf: m?.conf ?? 1 }; }) : matched;
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
  const k = kindMeta(kind).label;
  d.ai = {
    status: 'done', at: Date.now(),
    kind: { value: kind, conf: c ? 1 : conf(d.id + kind), ...(c ? { by: 'contributor' } : {}) },
    topics, proposed,
    kb: { id: d.kb, conf: d.submission?.kbBy === 'ai' ? conf(d.id + 'kb', 0.6, 0.85) : 1, by: d.submission?.kbBy || 'contributor' },
    summary: c?.summary || d.summary || `${k} contributed by ${contributorName(d)}${topics.length ? ` about ${topics.map(t => topicName(t.id).toLowerCase()).join(' and ')}` : ''}.`,
    flags, ...(c ? { confirmed: true } : {}),
  };
  return d.ai;
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
    else if (d.ai) { const was = d.ai.topics.find(t => t.id === topicId); d.ai.topics = [...d.ai.topics.filter(t => t.id !== topicId), { id: topicId, conf: 1, accepted: true, why: was?.why }]; d.ai.proposed = []; }
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
      id: uid('d'), kb: target?.id, name: f.name, type: (f.type || f.name.split('.').pop() || 'file').toLowerCase(), size: Math.round(f.size || 120e3),
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
/** Contributor resubmits after changes (optionally with a new file). */
function resubmit(d, { note = '', file } = {}) {
  if (file) Object.assign(d, { name: file.name, size: Math.round(file.size || d.size), type: (file.name.split('.').pop() || d.type).toLowerCase(), error: '' });
  d.stage = 'review'; event(d, 'resubmitted', note); analyzeSoon(d, 1200);
  lifeAudit('Resubmitted a document', d.name);
}
/** Contributor withdraws a submission (tombstone). */
function withdraw(d) { d.archived = true; event(d, 'withdrawn'); lifeAudit('Withdrew a submission', d.name); }
/** Reviewer approves with the final classification and publishes. decision: { kind, topics, kb, summary, acceptProposals:[ids], asVersionOf }. Returns the published document. */
function approveAndPublish(d, decision = {}) {
  const ai = aiOf(d);
  (decision.acceptProposals || []).map(proposalById).filter(Boolean).forEach(p => { const t = acceptProposal(p); if (t) (decision.topics ??= ai.topics.map(x => x.id)).push(t.id); });
  const meta = {
    kind: decision.kind || ai.kind.value,
    topics: [...new Set(decision.topics || ai.topics.map(t => t.id))],
    summary: (decision.summary ?? ai.summary) || undefined,
  };
  const versionOf = decision.asVersionOf || d.submission?.versionOf;
  const orig = versionOf && docById(versionOf);
  event(d, 'approved', decision.note || '');
  if (orig) {
    const r = res(orig);
    orig.versions = [{ v: r.version + 1, at: Date.now(), by: contributorName(d), note: decision.note || d.submission?.note || 'New version' }, ...r.versions];
    Object.assign(orig, { version: r.version + 1, size: d.size, type: d.type, status: 'pending', error: d.error || '', updated: Date.now(), ...meta });
    Object.assign(d, { stage: 'merged', mergedInto: orig.id });
    lifeAudit('Published a new version', orig.name);
    X.processDocs?.([orig], { quiet: true });
    return orig;
  }
  if (decision.kb && decision.kb !== d.kb) d.kb = decision.kb;
  Object.assign(d, { stage: 'published', status: 'pending', ...meta });
  lifeAudit('Approved and published a document', d.name);
  X.processDocs?.([d], { quiet: true });
  return d;
}
function requestChanges(d, text) { d.stage = 'changes'; event(d, 'changes', text); lifeAudit('Requested changes', d.name); }
function rejectSubmission(d, text) { d.stage = 'rejected'; event(d, 'rejected', text); lifeAudit('Declined a submission', d.name); }
function unpublish(d, text = '') { d.stage = 'unpublished'; event(d, 'unpublished', text); lifeAudit('Unpublished a document', d.name); }
function republish(d) { d.stage = 'published'; event(d, 'published'); lifeAudit('Published a document again', d.name); X.processDocs?.([d], { quiet: true }); }
/** Restore a snapshot taken with snapDoc (Undo for any lifecycle change). */
const snapDoc = d => JSON.parse(JSON.stringify(d));
function restoreDoc(d, snap) { Object.keys(d).forEach(k => delete d[k]); Object.assign(d, snap); }
