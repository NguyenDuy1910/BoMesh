/* Contribute — the contributor side of the document lifecycle: share a file for
   review (or keep it private in My files), submit a new version, follow what
   happens to it and act on reviewer feedback.
   A['contribute']({dataset:{kb?, versionOf?, private?}}) opens the dialog (M['contribute']).
   DR['ctb'] is one contribution: state, history, what the assistant suggested, revise.
   M['ctb-share'] moves a private file into review. Inbox: X.contribNotices().
   Shared with library.js and reader.js: X.ctb = { eventLine, timeline, href }.
   Lifecycle model and mutations: core/lifecycle.js. Prefix: ctb-. */
(() => {
  'use strict';

  const MB = 1048576;
  const OK_TYPES = ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'csv', 'ppt', 'pptx', 'txt', 'md', 'html', 'htm', 'zip'];
  const MAX_BYTES = 100 * MB;
  /** Sample files per workspace template (one unsupported file shows the per-file error). */
  const SAMPLES = {
    campus: [{ name: 'Thesis writing guide — FIT.pdf', size: 2.6 * MB }, { name: 'Internship placement list 2026.xlsx', size: 184e3 }, { name: 'Lab safety induction.pptx', size: 6.8 * MB }, { name: 'Lecture recording — Week 4.mp4', size: 412 * MB }],
    enterprise: [{ name: 'Q4 Sales Kickoff.pptx', size: 8.4 * MB }, { name: 'Pricing FAQ.docx', size: 214e3 }, { name: 'Customer onboarding checklist.md', size: 9e3 }, { name: 'Product demo.mov', size: 182 * MB }],
  };
  const samples = () => SAMPLES[curWs().template] || SAMPLES.enterprise;

  function audit(action, target) {
    D.audit.unshift({ id: uid('ev'), at: Date.now(), actor: me().id, action, type: 'Knowledge', target, outcome: 'success', ip: '10.4.12.30', device: 'Chrome on macOS' });
  }
  const personalKb = () => visibleKbs().find(k => k.personal);
  const canShare = () => canContribute() && contributionTargets().length > 0;
  const href = id => '/contributions' + (id ? '?open=' + id : '');
  const relLow = ts => rel(ts).replace(/^(Just now|Yesterday)$/, m => m.toLowerCase());
  const extOf = name => (name.includes('.') ? name.split('.').pop() : '').toLowerCase();
  const stemOf = name => name.replace(/\.[^.]+$/, '');
  function fileEntry(name, size) {
    const ext = extOf(name);
    const err = !OK_TYPES.includes(ext) ? 'This file type isn’t supported' : size > MAX_BYTES ? 'Larger than 100 MB' : !size ? 'This file is empty' : '';
    return { id: uid('f'), name, size, type: ext || 'file', err, pct: 0 };
  }

  /* ═══════════════ Contribute dialog ═══════════════
     Contribute to a collection: pick files → Analyzing (the assistant reads them against the workspace's taxonomy) →
     Check the details (title, topics with their evidence, collection and who will see it, summary, flags) →
     Submit for review; what the contributor confirmed travels with the submission (submission.confirmed, read by aiOf).
     Upload to My files and Submit a new version stay one step. */
  /** A['contribute']({dataset:{kb?, folder?, versionOf?, private?}}). kb preselects a base (a personal base means My files);
      folder (a collection's Contents) is where its files land when they stay in that collection. */
  A['contribute'] = el => {
    const ds = el?.dataset || {}, kb = kbById(ds.kb), base = ds.versionOf ? docById(ds.versionOf) : null;
    if (base && (!canShare() || !canSeeDoc(base))) { toast('You can’t submit a new version of this document', { tone: 'danger' }); return; }
    const share = !!base || (canShare() && ds.private !== '1' && !kb?.personal);
    if (!share && !personalKb()) { toast('You can’t add files to any collection', { tone: 'danger' }); return; }
    S.ui.ctb = { mode: share ? 'share' : 'private', step: 'pick', meta: {}, kb: kb && contributionTargets().includes(kb) ? kb.id : '', folder: kb && folderById(ds.folder)?.kb === kb.id ? ds.folder : '', note: '', files: [], busy: false, versionOf: base?.id || '', touched: false, showNote: false };
    openModal('contribute', {});
  };
  M['contribute'] = () => {
    const f = ui('ctb');
    if (f.step === 'analyzing') return analyzingDialog(f);
    if (f.step === 'details') return detailsDialog(f);
    const base = f.versionOf ? docById(f.versionOf) : null, priv = f.mode === 'private', twoStep = !base && !priv;
    const valid = f.files.filter(x => !x.err), skipped = f.files.length - valid.length;
    const full = !!base && valid.length > 0;
    const have = new Set(f.files.map(x => x.name));
    const current = base ? `<div class="ctb-current">${fileIcon(base.type)}<div class="grow"><div class="medium truncate">${esc(docTitle(base))}</div><div class="t-xs muted">Current version v${res(base).version} · ${esc(kbById(base.kb)?.name || '')}</div></div></div>` : '';
    const drop = f.busy || full ? '' : `<button type="button" class="ctb-drop" id="ctb-drop" data-act="ctb-browse" aria-describedby="ctb-drop-hint"><span class="ctb-drop__icon">${ic('upload', 'i-lg')}</span><span class="medium">${base ? 'Drop the new file here or' : 'Drop files here or'} <span class="text-accent">browse</span></span><span class="description" id="ctb-drop-hint">PDF, Word, Excel, PowerPoint, text, Markdown, HTML or ZIP · up to 100 MB${base ? '' : ' each'}</span></button>`;
    const row = x => item({
      lead: fileIcon(x.type), title: esc(x.name),
      desc: x.err ? `<span class="field-error">${ic('alert-circle')}<span>${esc(x.err)}</span></span>` : f.busy ? `<span class="row gap-8"><span class="grow">${progress(x.pct, x.pct >= 100 ? 'success' : '', 'Upload progress')}</span><span class="num t-xs muted ctb-pct">${Math.round(x.pct)}%</span></span>` : fmtSize(x.size),
      trail: f.busy ? (x.err ? '<span class="t-xs muted">Skipped</span>' : x.pct >= 100 ? ic('check-circle', 'text-success') : '') : iconBtn('x', 'Remove ' + x.name, { size: 'sm', act: 'ctb-remove', data: { id: x.id } }),
    });
    const files = f.files.length ? `<div class="${f.busy && !base ? '' : 'mt-12'}">${list(f.files.map(row))}</div>` : '';
    const fileErr = f.touched && !f.busy && !valid.length ? `<div class="field-error mt-8" role="alert">${ic('alert-circle')}<span>${f.files.length ? 'None of these files can be added. Add a supported file.' : 'Add at least one file.'}</span></div>` : '';
    const pool = base ? [{ name: `${stemOf(base.name)} (v${res(base).version + 1}).${base.type}`, size: Math.max(base.size || 0, 180e3) }] : samples();
    const sampleList = pool.filter(s => !have.has(s.name));
    const sampleHtml = f.busy || full || !sampleList.length ? '' : `<div class="ctb-samples"><span class="t-xs muted">Or try a sample:</span>${sampleList.map(s => btn(s.name, { v: 'outline', size: 'sm', icon: 'plus', act: 'ctb-sample', data: { name: s.name, size: Math.round(s.size) } })).join('')}</div>`;
    // Destination first, as a choice the rest of the dialog follows (title, description, fields, button).
    const choose = !base && !f.busy && canShare() && personalKb() ? `<div class="field ctb-dest"><span class="label">Where should it go?</span>${choiceGroup({ name: 'ctb-dest', value: f.mode, act: 'ctb-dest', cols: 2, options: [['share', 'Contribute to a collection', 'Your team can find it once a reviewer publishes it.', 'share'], ['private', 'Upload to My files', 'Only you can see it. Ask about it in chat.', 'lock']] })}</div>` : '';
    const note = f.note.trim();
    const noteErr = base && f.touched && !note ? 'Say what changed.' : '';
    const versionFields = base && !f.busy ? `<div class="ctb-fields">${field({ id: 'ctb-note', label: 'What changed?', required: true, error: noteErr, desc: 'Reviewers see this next to the current version.', control: textarea({ id: 'ctb-note', bind: 'ctb.note', value: f.note, rows: 3, placeholder: 'e.g. Corrected section 2 and updated the dates', invalid: !!noteErr, attrs: 'maxlength="400" data-input="kn-revalidate" data-form="ctb"' }) })}</div>` : '';
    const busyNote = f.busy ? `<p class="t-sm muted mb-12">${priv ? 'Adding to My files…' : `Uploading the new version of ${esc(docTitle(base))}…`}</p>` : '';
    const n = valid.length;
    // Contributing takes two steps: Continue reads the files, then the contributor checks what the assistant suggests.
    const label = base ? 'Submit new version' : priv ? (n > 1 ? `Add ${n} files` : 'Add to My files') : 'Continue';
    const hint = skipped ? `${plural(skipped, 'file')} will be skipped` : priv ? 'Only you can see them.' : twoStep ? 'You check the details before anything is sent.' : 'You can withdraw it while it’s in review.';
    return {
      size: 'lg', guard: f.busy, icon: priv ? 'lock' : 'upload',
      title: base ? 'Submit a new version' : priv ? 'Upload to My files' : 'Contribute documents',
      desc: base ? 'A reviewer checks it before it replaces the current version.' : priv ? 'Only you can see these files. Ask about them in chat.' : 'Share what your team should know. A reviewer checks it before it’s published.',
      body: current + choose + busyNote + drop + fileErr + files + sampleHtml + versionFields,
      footStart: f.busy ? '' : hint,
      foot: btn('Cancel', { v: 'ghost', act: 'close-modal', disabled: f.busy }) + btn(label, twoStep ? { v: 'primary', iconRight: 'arrow-right', act: 'ctb-go' } : { v: 'primary', icon: priv ? 'upload' : 'send', act: 'ctb-go', loading: f.busy }),
    };
  };
  const addFiles = list => {
    const f = ui('ctb');
    list.forEach(x => f.files.push(fileEntry(x.name, x.size)));
    if (f.files.some(x => !x.err)) f.touched = false;
    // A new version takes one file: keep the latest valid one.
    if (f.versionOf) { const ok = f.files.filter(x => !x.err); if (ok.length > 1) f.files = f.files.filter(x => x.err || x === ok.at(-1)); }
    refreshLayer();
  };
  A['ctb-dest'] = el => { ui('ctb').mode = el.dataset.value; refreshLayer(); };
  A['ctb-browse'] = () => {
    const inp = document.createElement('input'); inp.type = 'file'; inp.hidden = true; inp.multiple = !ui('ctb').versionOf;
    inp.accept = OK_TYPES.map(x => '.' + x).join(',');
    inp.addEventListener('change', () => { addFiles([...(inp.files || [])]); inp.remove(); });
    document.body.appendChild(inp); inp.click();
  };
  A['ctb-sample'] = el => addFiles([{ name: el.dataset.name, size: +el.dataset.size }]);
  A['ctb-remove'] = el => { const f = ui('ctb'); f.files = f.files.filter(x => x.id !== el.dataset.id); refreshLayer(); $('#ctb-drop')?.focus(); };
  document.addEventListener('dragover', e => { const z = e.target.closest?.('#ctb-drop'); if (!z) return; e.preventDefault(); z.classList.add('is-drag'); });
  document.addEventListener('dragleave', e => { const z = e.target.closest?.('#ctb-drop'); if (z && !z.contains(e.relatedTarget)) z.classList.remove('is-drag'); });
  document.addEventListener('drop', e => {
    const z = e.target.closest?.('#ctb-drop'); if (!z) return; e.preventDefault();
    const files = [...(e.dataTransfer?.files || [])]; if (files.length) addFiles(files);
  });
  A['ctb-go'] = () => {
    const f = ui('ctb'); if (f.busy) return;
    const valid = f.files.filter(x => !x.err);
    if (!valid.length) { f.touched = true; refreshLayer(); $('#ctb-drop')?.focus(); return; }
    if (f.versionOf && !f.note.trim()) { f.touched = true; refreshLayer(); $('#ctb-note')?.focus(); return; }
    if (f.mode === 'share' && !f.versionOf) return analyzeAll(f, valid);
    f.busy = true; refreshLayer();
    const timer = setInterval(() => {
      if (S.modal?.name !== 'contribute') { clearInterval(timer); return; }
      valid.forEach(x => { x.pct = Math.min(100, x.pct + 8 + Math.random() * (x.size > 2e7 ? 8 : 26)); });
      refreshLayer();
      if (valid.every(x => x.pct >= 100)) { clearInterval(timer); setTimeout(() => uploaded(f, valid), 300); }
    }, 140);
  };
  /** Private uploads and new versions: one step, straight from the file list. */
  function uploaded(f, valid) {
    closeModal();
    if (f.mode === 'private') return addPrivate(valid);
    const docs = submitFiles(valid.map(x => ({ name: x.name, size: x.size, type: x.type })), { note: f.note, versionOf: f.versionOf || undefined });
    refresh();
    submittedToast(docs, 'Submitted the new version for review');
  }
  /** Open opens the contribution in My contributions; reviewers who can decide it themselves go on to it: Process (a new
      document is processed before it's reviewed), or Review now (a new version). */
  function submittedToast(docs, msg) {
    const review = can('knowledge.manage') && docs.every(d => canReviewKb(kbById(d.kb)));
    const next = docs.every(readyToReview) ? { label: 'Review now', run: () => go(docsHref('review', { sel: docs[0].id })) } : { label: 'Process', run: () => go(docsHref('processing')) };
    toast(msg || (docs.length === 1 ? 'Submitted for review' : `Submitted ${plural(docs.length, 'document')} for review`), {
      action: review ? next : { label: 'Open', run: () => go(href(docs.length === 1 ? docs[0].id : '')) },
    });
  }

  /* ── Analyzing → Check the details (Contribute to a collection) ── */
  const ANALYZE_MS = 1200;
  const andList = xs => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);
  /** What the assistant reads from one file before the contributor confirms it: title, topics matched against the workspace's
      taxonomy (with their evidence), the best-fitting collection (unless one was chosen), a summary and flags. The type is the
      file's own class: nobody picks it. */
  function suggest(x, preset) {
    const probe = { id: x.id, name: x.name, type: x.type, source: 'upload' };
    const title = stemOf(x.name).replace(/_+/g, ' ').replace(/\s+/g, ' ').trim();
    const hint = suggestKb(x.name);
    const kb = (preset && contributionTargets().some(k => k.id === preset) ? preset : hint?.id) || contributionTargets()[0]?.id || '';
    const similar = similarDocs(probe);
    const matches = topicMatches(x.name, kbById(kb), similar, probe);
    const topics = matches.map(m => m.id);
    const dup = similar.find(s => s.sim >= 0.55 && canSeeDoc(s.doc));
    return {
      title, topics, why: Object.fromEntries(matches.map(m => [m.id, m.why])), kb, kbHint: preset ? '' : hint?.id || '',
      summary: `${title}.${topics.length ? ` Covers ${andList(topics.map(topicName))}.` : ''}`,
      personal: PERSONAL_RE.test(x.name), dup: dup ? { id: dup.doc.id, sim: dup.sim } : null,
    };
  }
  /** Continue: a visible Analyzing step, then Check the details. Edits survive Back; only new files are read. */
  async function analyzeAll(f, valid) {
    f.step = 'analyzing'; f.touched = false; refreshLayer();
    await sleep(ANALYZE_MS);
    if (S.modal?.name !== 'contribute' || ui('ctb') !== f || f.step !== 'analyzing') return;
    const keep = new Set(valid.map(x => x.id));
    Object.keys(f.meta).forEach(id => { if (!keep.has(id)) delete f.meta[id]; });
    valid.forEach(x => { f.meta[x.id] ??= suggest(x, f.kb); });
    f.step = 'details'; refreshLayer();
  }
  /** One progress indicator (the status line); the files it's reading are listed plainly, and the next step waits, disabled. */
  function analyzingDialog(f) {
    const valid = f.files.filter(x => !x.err), ws = curWs().name;
    const rows = valid.map(x => item({ lead: fileIcon(x.type), title: esc(x.name), desc: fmtSize(x.size) }));
    return {
      size: 'lg', icon: 'sparkles', title: 'Analyzing',
      desc: 'The assistant suggests a title, topics and a collection. You check them next.',
      body: `<div class="ctb-analyzing" role="status" aria-live="polite">${spinner()}<span>${valid.length > 1 ? `Reading the files and matching them against ${esc(ws)}’s topics…` : `Reading the file and matching it against ${esc(ws)}’s topics…`}</span></div>${list(rows)}`,
      foot: btn('Cancel', { v: 'ghost', act: 'close-modal' }) + btn('Check the details', { v: 'primary', iconRight: 'arrow-right', disabled: true }),
    };
  }
  /** One file's suggestions as an editable form. */
  function checkFile(f, x, many) {
    const m = f.meta[x.id], key = `ctb.meta.${x.id}`, kb = kbById(m.kb), who = kb ? X.whoCanSee(kb) : null;
    const titleErr = f.touched && !m.title.trim() ? 'Give it a title.' : '';
    const flags = [
      m.personal && alertBox('warning', 'May contain personal data', 'Remove personal details before you submit, or say in the note why they’re needed.'),
      m.dup && docById(m.dup.id) && alertBox('default', 'Possible duplicate', `Looks like “${esc(docTitle(docById(m.dup.id)))}” (${Math.round(m.dup.sim * 100)}% similar title). If it replaces that document, submit a new version of it instead.`, btn('Preview', { act: 'doc-preview', data: { id: m.dup.id } })),
    ].filter(Boolean).join('');
    const picker = topicPicker({ id: 'ctb-add-' + x.id, ids: m.topics, act: 'ctb-topic', data: { file: x.id }, label: 'Topics', empty: 'No clear topic. Add one if you know it.' });
    const why = m.topics.map(id => { const ev = m.why[id] ? topicEvidence(m.why[id]).join(' · ') : 'added by you'; return ev ? `<li><span class="medium" translate="no">${esc(topicName(id))}</span><span class="muted" aria-hidden="true"> — </span><span class="muted">${esc(ev)}</span></li>` : ''; }).join('');
    const topics = `<div class="field"><span class="label">Topics</span>${picker}${why ? `<ul class="cur-why" aria-label="Why these topics">${why}</ul>` : ''}</div>`;
    const kbDesc = who ? `<span class="row gap-4">${ic(who.icon, 'i-xs')}<span>${esc(`${who.label} will see it once published.`)}${m.kb === m.kbHint ? ' Suggested by the assistant.' : ''}</span></span>` : '';
    return `<section class="ctb-check" aria-label="${esc(`Details for ${x.name}`)}">
      ${many ? `<div class="ctb-check__file">${fileIcon(x.type, 'sm')}<span class="medium truncate">${esc(x.name)}</span><span class="t-xs muted none">${fmtSize(x.size)}</span></div>` : ''}
      ${flags ? `<div class="stack gap-8">${flags}</div>` : ''}
      ${field({ id: 'ctb-title-' + x.id, label: 'Title', required: true, error: titleErr, control: input({ id: 'ctb-title-' + x.id, bind: key + '.title', value: m.title, invalid: !!titleErr, attrs: `maxlength="120"${titleErr ? ' data-live' : ''}` }) })}
      ${topics}
      ${field({ id: 'ctb-kb-' + x.id, label: 'Collection', desc: kbDesc, control: select({ id: 'ctb-kb-' + x.id, bind: key + '.kb', value: m.kb, options: contributionTargets().map(k => [k.id, k.name]), change: 'ctb-meta-kb' }) })}
      ${field({ id: 'ctb-sum-' + x.id, label: 'Summary', desc: 'Shown in search results and to reviewers.', control: textarea({ id: 'ctb-sum-' + x.id, bind: key + '.summary', value: m.summary, rows: 2, attrs: 'maxlength="280"' }) })}
    </section>`;
  }
  function detailsDialog(f) {
    const valid = f.files.filter(x => !x.err && f.meta[x.id]), n = valid.length, note = f.note.trim();
    const lone = n === 1 ? valid[0] : null;
    const head = lone ? `<div class="ctb-current">${fileIcon(lone.type)}<div class="grow"><div class="medium truncate">${esc(lone.name)}</div><div class="t-xs muted">${fmtSize(lone.size)}</div></div></div>` : '';
    const noteHtml = disclosure({ path: 'ctb.showNote', icon: 'note', title: 'Note for reviewers', summary: note ? esc(note.length > 40 ? note.slice(0, 40) + '…' : note) : 'Optional', body: textarea({ id: 'ctb-note', bind: 'ctb.note', value: f.note, rows: 2, placeholder: 'What it covers and who it helps', attrs: 'maxlength="400" aria-label="Note for reviewers"' }) });
    return {
      size: 'lg', guard: f.busy, icon: 'check-check', title: 'Check the details',
      desc: 'The assistant suggested these from your file. Change anything that’s off — reviewers see what you confirmed.',
      body: `${head}<div class="ctb-checks">${valid.map(x => checkFile(f, x, n > 1)).join('')}</div><div class="ctb-fields">${noteHtml}</div>`,
      footStart: f.busy ? '' : btn('Back', { v: 'ghost', icon: 'arrow-left', act: 'ctb-back' }),
      foot: btn('Cancel', { v: 'ghost', act: 'close-modal', disabled: f.busy }) + btn(n > 1 ? `Submit ${n} for review` : 'Submit for review', { v: 'primary', icon: 'send', act: 'ctb-submit', loading: f.busy }),
    };
  }
  A['ctb-back'] = () => { const f = ui('ctb'); f.step = 'pick'; f.touched = false; refreshLayer(); };
  A['ctb-meta-kb'] = () => refreshLayer();
  A['ctb-topic-remove'] = el => {
    const m = ui('ctb').meta[el.dataset.file]; if (!m) return;
    m.topics = m.topics.filter(id => id !== el.dataset.topic); refreshLayer();
    requestAnimationFrame(() => $('#ctb-add-' + el.dataset.file)?.focus());
  };
  A['ctb-topic-add'] = el => {
    const m = ui('ctb').meta[el.dataset.file], id = el.value; if (!m || !id || m.topics.includes(id)) return;
    m.topics.push(id); refreshLayer();
    requestAnimationFrame(() => $('#ctb-add-' + el.dataset.file)?.focus());
  };
  /** Submit for review with what the contributor confirmed; the title becomes the document's name (its extension kept). */
  A['ctb-submit'] = async () => {
    const f = ui('ctb'); if (f.busy) return;
    const valid = f.files.filter(x => !x.err && f.meta[x.id]);
    const missing = valid.find(x => !f.meta[x.id].title.trim());
    if (missing) { f.touched = true; refreshLayer(); $('#ctb-title-' + missing.id)?.focus(); return; }
    f.busy = true; refreshLayer(); await sleep(500);
    if (S.modal?.name !== 'contribute' || ui('ctb') !== f) return;
    const files = valid.map(x => {
      const m = f.meta[x.id], ext = extOf(x.name);
      return { name: m.title.trim() + (ext ? '.' + ext : ''), size: x.size, type: x.type, kb: m.kb || undefined, folder: f.folder && m.kb === f.kb ? f.folder : undefined, confirmed: { topics: [...m.topics], summary: m.summary.trim() } };
    });
    closeModal();
    const docs = submitFiles(files, { note: f.note });
    refresh();
    submittedToast(docs);
  };
  /** My files never need review: add to the personal base and make them usable right away. */
  function addPrivate(valid) {
    const kb = personalKb(); if (!kb) return;
    const docs = valid.map(x => ({
      id: uid('d'), kb: kb.id, name: x.name, type: x.type, size: Math.round(x.size), status: 'pending', source: 'upload', updated: Date.now(),
      addedBy: me().name, pages: Math.max(1, Math.round(x.size / 9e4) % 60 || 4), passages: Math.round(18 + (x.size % 240)), error: '',
    }));
    D.docs.push(...docs); kb.updated = Date.now();
    audit(docs.length === 1 ? 'Uploaded a document' : `Uploaded ${plural(docs.length, 'document')}`, kb.name);
    X.processDocs?.(docs, { quiet: true });
    refresh();
    toast('Added to My files', { action: { label: 'Open', run: () => go('/knowledge/library?tab=files') } });
  }

  /* ═══════════════ How a contribution reads ═══════════════ */
  const who = (by, d) => (by === me().id ? 'You' : by ? actorName(by) : contributorName(d));
  const VERB = { submitted: 'submitted it', resubmitted: 'resubmitted it', changes: 'asked for changes', rejected: 'declined it', approved: 'approved it', published: 'published it again', unpublished: 'unpublished it', withdrawn: 'withdrew it' };
  const STEP = { submitted: ['upload', ''], resubmitted: ['refresh', ''], changes: ['pencil', 'warning'], rejected: ['x-circle', 'danger'], approved: ['check', 'success'], published: ['check-circle', 'success'], unpublished: ['eye-off', ''], withdrawn: ['undo', ''] };
  const lastBy = (d, kind) => [...(d.submission?.events || [])].reverse().find(e => e.kind === kind);
  /** One line for lists: the latest thing that happened, in plain language. */
  function eventLine(d) {
    const l = lifecycleOf(d), e = lastEvent(d), ok = lastBy(d, 'approved');
    const by = ok && ok.by !== me().id ? ` by ${actorName(ok.by)}` : '';
    switch (l.key) {
      case 'published': case 'update': case 'stored': return `Published · ${fmtDate(Math.max(d.updated || 0, e.at || 0))}`;
      case 'versioned': return `Published as a new version · ${fmtDate(versionTarget(d)?.updated || e.at)}`;
      case 'publishing': return `Approved${by} · being processed`;
      case 'queued': return `Approved${by} · not processed yet`;
      case 'failed': return `Approved${by} · processing failed`;
      case 'analyzing': return `${e.kind === 'resubmitted' ? 'Resubmitted' : 'Submitted'} · ${relLow(e.at)} · the assistant is reading it`;
    }
    if (!e.kind || e.kind === 'submitted' && e.by === me().id) return `Submitted · ${relLow(e.at)}`;
    if (e.by === me().id) return `${VERB[e.kind].replace(/ it$/, '').replace(/^./, c => c.toUpperCase())} · ${relLow(e.at)}`;
    return `${who(e.by, d)} ${VERB[e.kind] || 'updated it'} · ${relLow(e.at)}`;
  }
  /** What happens next (or what happened last) beyond the stored events. */
  function tail(d) {
    const l = lifecycleOf(d), kb = kbById(d.kb)?.name || 'the collection', e = lastEvent(d);
    switch (l.key) {
      case 'analyzing': return { icon: 'sparkles', tone: 'accent', title: 'The assistant is reading it', desc: 'It suggests topics and a collection for the reviewer.', live: true };
      case 'review': return { icon: 'clock', title: 'Waiting for a reviewer', desc: `The reviewers of ${kb} check it before it’s published.`, next: true };
      case 'changes': return { icon: 'pencil', title: isMine(d) ? 'Waiting for your revision' : 'Waiting for a revision', next: true };
      case 'queued': return { icon: 'clock', title: 'Waiting to be processed', desc: 'A reviewer chooses when it’s processed. Until then search and the assistant can’t use it.', next: true };
      case 'publishing': return { icon: 'loader', tone: 'accent', title: 'Processing', desc: 'It will be searchable in a few minutes.', live: true };
      case 'published': case 'update': return e.kind === 'published' ? null : { icon: 'check-circle', tone: 'success', title: 'Published', desc: `Searchable in ${kb}.`, at: d.updated };
      case 'stored': return { icon: 'check-circle', tone: 'success', title: 'Published', desc: 'People can download it. This file type can’t be searched.', at: d.updated };
      case 'versioned': { const o = versionTarget(d); return { icon: 'check-circle', tone: 'success', title: 'Published as a new version', desc: o ? `It replaced the earlier version of “${o.name}”.` : '', at: o?.updated }; }
      case 'failed': return { icon: 'alert-circle', tone: 'danger', title: 'Processing failed', desc: 'The reviewers have been told.' };
      default: return null;
    }
  }
  /** Vertical history: who did what, when, and what reviewers wrote. quoted: the event whose message is already shown above (its alert). */
  function timeline(d, { compact = false, quoted = null } = {}) {
    const steps = (d.submission?.events || []).map(e => {
      const [icon, tone] = STEP[e.kind] || ['circle-dashed', ''];
      return { icon, tone, title: `${who(e.by, d)} ${VERB[e.kind] || 'updated it'}`, at: e.at, quote: e === quoted ? '' : e.text };
    });
    const t = tail(d); if (t) steps.push(t);
    if (!steps.length) return '<p class="t-sm muted">No history yet.</p>';
    return `<ol class="${cx('ctb-tl', compact && 'ctb-tl--compact')}">${steps.map(s => `<li class="${cx('ctb-tl__step', s.tone && 'ctb-tl__step--' + s.tone, s.next && 'is-next')}">
      <span class="ctb-tl__dot" aria-hidden="true">${s.live ? spinner('sm') : ic(s.icon)}</span>
      <div class="ctb-tl__body"><div class="ctb-tl__title">${esc(s.title)}</div>${s.desc ? `<div class="ctb-tl__desc">${esc(s.desc)}</div>` : ''}${s.at ? `<div class="ctb-tl__meta" data-tip="${esc(fmtDateTime(s.at))}">${esc(rel(s.at))}</div>` : ''}${s.quote ? `<blockquote class="ctb-quote">${esc(s.quote)}</blockquote>` : ''}</div></li>`).join('')}</ol>`;
  }
  X.ctb = { eventLine, timeline, href };

  /* ── Progress: Submitted → Analyzed → In review → Approved → Published — the Studio's document stepper (.flow-steps), told from
     the contributor's side. Each step: { label, state: done | current | issue | skipped | todo, busy?, text, at? }. ── */
  const PROG_ICON = { done: ['check', 'success'], current: ['clock', 'accent'], issue: ['alert', 'warning'], skipped: ['minus', ''], todo: ['circle-dashed', ''] };
  const PROG_SR = { done: 'Done', current: 'In progress', issue: 'Needs attention', skipped: 'Skipped', todo: 'Not yet' };
  function progressSteps(d) {
    const k = lifecycleOf(d).key, sub = d.submission || {}, kb = kbById(d.kb), base = kb?.name || 'the collection', mine = isMine(d);
    const by = e => (e?.by && e.by !== me().id ? ` by ${actorName(e.by)}` : '');
    const sent = [...(sub.events || [])].reverse().find(e => e.kind === 'submitted' || e.kind === 'resubmitted');
    const ok = lastBy(d, 'approved'), who = kb ? X.whoCanSee(kb).label : '';
    const open = ['analyzing', 'review', 'changes'].includes(k);
    const confirmed = !!sub.confirmed;
    const submitted = { state: 'done', at: sent?.at || sub.at, text: `${sent?.kind === 'resubmitted' ? 'Resubmitted' : 'Sent'} to ${base}` };
    const analyzed = k === 'analyzing' ? { state: 'current', busy: true, text: 'Reading the file and matching it against the topics…' }
      : { state: 'done', text: confirmed ? `Topics and collection confirmed by ${mine ? 'you' : contributorName(d)}` : 'Topics and collection suggested' };
    const review = k === 'analyzing' ? { state: 'todo', text: `The reviewers of ${base} check it` }
      : k === 'review' ? { state: 'current', text: `Waiting for a reviewer of ${base}` }
        : k === 'changes' ? { state: 'issue', text: `Changes requested${by(lastBy(d, 'changes'))}`, at: lastBy(d, 'changes')?.at }
          : k === 'rejected' ? { state: 'issue', text: `Declined${by(lastBy(d, 'rejected'))}`, at: lastBy(d, 'rejected')?.at }
            : { state: 'done', text: `Checked by the reviewers of ${base}` };
    const approved = open ? { state: 'todo', text: 'A reviewer approves it, or asks for changes' }
      : k === 'rejected' ? { state: 'skipped', text: 'Won’t be published' }
        : { state: 'done', text: `Approved${by(ok)}`, at: ok?.at };
    const PUB = {
      queued: { state: 'current', text: 'Published · waiting to be processed' }, publishing: { state: 'current', busy: true, text: 'Processing, so search can find it…' },
      published: { state: 'done', text: `Searchable · ${who}`, at: d.updated }, update: { state: 'done', text: `Searchable · ${who}`, at: d.updated },
      stored: { state: 'done', text: 'Stored · people can download it; this file type can’t be searched' },
      versioned: { state: 'done', text: 'Published as a new version', at: versionTarget(d)?.updated },
      failed: { state: 'issue', text: 'Processing failed · the reviewers have been told' },
      unpublished: { state: 'issue', text: `Unpublished${by(lastBy(d, 'unpublished'))}`, at: lastBy(d, 'unpublished')?.at },
      rejected: { state: 'skipped', text: 'Won’t be published' },
    };
    const published = PUB[k] || { state: 'todo', text: who ? `${who} will see it once it’s published` : 'Searchable once it’s published' };
    return [['Submitted', submitted], ['Analyzed', analyzed], ['In review', review], ['Approved', approved], ['Published', published]].map(([label, s]) => ({ label, ...s }));
  }
  function stepper(d) {
    return `<ol class="flow-steps" aria-label="Progress">${progressSteps(d).map(s => {
      const [icon, tone] = s.busy ? ['loader', 'accent'] : PROG_ICON[s.state];
      return `<li class="${cx('flow-steps__item', 'is-' + s.state, s.busy && 'is-busy')}"><span class="${cx('flow-steps__dot', tone && 'flow-steps__dot--' + tone)}" aria-hidden="true">${ic(icon, 'i-xs')}</span>
        <div class="grow"><div class="t-sm"><span class="medium">${esc(s.label)}</span><span class="sr-only">${esc(PROG_SR[s.state])}</span></div><div class="flow-steps__text">${esc(s.text)}${s.at ? `<span class="muted" data-tip="${esc(fmtDateTime(s.at))}"> · ${esc(rel(s.at))}</span>` : ''}</div></div></li>`;
    }).join('')}</ol>`;
  }

  /* ═══════════════ Contribution panel ═══════════════ */
  /** Read-only and transparent: what the assistant suggested (or, once published, how it's classified). */
  function suggestion(d) {
    const st = stageOf(d), kb = kbById(d.kb);
    if (st === 'published' || st === 'versioned') {
      const x = versionTarget(d) || d, r = res(x);
      return `<section><h3 class="ctb-sec__title">How it’s classified</h3>${kv([
        ['Type', esc(typeMeta(x).label)],
        ['Topics', r.topics.length ? `<span class="ctb-topics">${r.topics.map(id => chip(topicName(id), { size: 'sm' })).join('')}</span>` : '<span class="muted">None</span>'],
        ['Collection', esc(r.kb?.name || '—')],
      ])}</section>`;
    }
    if (!['review', 'changes'].includes(st) && !d.ai) return '';
    const ai = aiOf(d);
    // Confirmed before submitting: the contributor's own choices, not the assistant's guesses.
    const head = `<h3 class="ctb-sec__title">${ai.confirmed ? (isMine(d) ? 'What you confirmed' : 'Confirmed by the contributor') : 'What the assistant suggested'}</h3>`;
    if (ai.status === 'analyzing') return `<section>${head}<div class="ctb-reading">${spinner('sm')}<span>Reading the file…</span></div></section>`;
    const topics = [...ai.topics.map(t => chip(topicName(t.id), { size: 'sm' })), ...(ai.proposed || []).map(proposalById).filter(Boolean).map(p => chip(p.name, { size: 'sm', tone: 'accent', icon: 'plus', tip: 'Proposed new topic. A workspace admin decides whether to add it.' }))];
    const kbBy = ai.kb.by === 'ai' ? 'Suggested by the assistant' : `Chosen by ${isMine(d) ? 'you' : contributorName(d)}`;
    const flags = (ai.flags || []).length ? `<ul class="ctb-flags">${ai.flags.map(f => `<li>${ic(f.type === 'personal' ? 'shield' : f.type === 'format' ? 'file' : 'git-compare', 'i-sm')}<span>${esc(f.text)}</span></li>`).join('')}</ul>` : '';
    return `<section>${head}${kv([
      ['Topics', topics.length ? `<span class="ctb-topics">${topics.join('')}</span>` : '<span class="muted">No clear topic</span>'],
      ['Collection', `<span class="stack gap-2"><span>${esc(kb?.name || '—')}</span><span class="t-xs muted">${esc(kbBy)}</span></span>`],
    ])}${flags}<p class="t-xs muted mt-8">Reviewers can change these before publishing.</p></section>`;
  }
  const revKey = id => 'ctbRev-' + id;
  function reviseForm(d) {
    const r = ui(revKey(d.id), { note: '', file: null, touched: false });
    const err = r.touched && !r.note.trim() ? 'Say what you changed.' : '';
    const file = r.file
      ? `<div class="ctb-revfile">${fileIcon(r.file.type)}<span class="grow stack gap-2"><span class="medium truncate">${esc(r.file.name)}</span>${r.file.err ? `<span class="field-error">${ic('alert-circle')}<span>${esc(r.file.err)}</span></span>` : `<span class="t-xs muted">${fmtSize(r.file.size)}</span>`}</span>${iconBtn('x', 'Remove file', { size: 'sm', act: 'ctb-rev-clear', data: { id: d.id } })}</div>`
      : `<div class="row wrap gap-8">${btn('Choose a file', { size: 'sm', icon: 'upload', act: 'ctb-rev-browse', data: { id: d.id } })}${btn('Use a sample revision', { v: 'ghost', size: 'sm', icon: 'plus', act: 'ctb-rev-sample', data: { id: d.id } })}</div>`;
    return `<section class="ctb-revise" aria-label="Revise and resubmit"><h3 class="ctb-sec__title">Revise and resubmit</h3>
      <div class="field"><span class="label">Replacement file<span class="label__opt">(optional)</span></span>${file}${r.file ? '' : '<div class="description">Keep the current file if you only need to explain something.</div>'}</div>
      ${field({ id: 'ctb-rev-note', label: 'What did you change?', required: true, error: err, control: textarea({ id: 'ctb-rev-note', bind: revKey(d.id) + '.note', value: r.note, rows: 3, placeholder: 'e.g. Removed the full answers and kept my approach', invalid: !!err, attrs: 'maxlength="400"' }) })}</section>`;
  }
  /** Where it stands when someone decided something: an alert with their message (the history doesn't repeat it). Every other state
      is the progress stepper's current step. Returns the event the alert quotes. */
  function stateBlock(d) {
    const l = lifecycleOf(d), st = stageOf(d);
    const quote = e => (e?.text ? `<blockquote class="ctb-quote">${esc(e.text)}</blockquote>` : '');
    if (st === 'changes') { const e = lastBy(d, 'changes'); return { html: alertBox('warning', `${who(e?.by, d)} asked for changes`, quote(e)), quoted: e }; }
    if (st === 'rejected') { const e = lastBy(d, 'rejected'); return { html: alertBox('danger', `${who(e?.by, d)} declined it`, quote(e) || 'It won’t be published.'), quoted: e }; }
    if (st === 'unpublished') { const e = lastBy(d, 'unpublished'); return { html: alertBox('default', `${who(e?.by, d)} unpublished it`, quote(e)), quoted: e }; }
    if (l.key === 'failed') return { html: alertBox('danger', 'Processing failed — the reviewers have been told', 'It was approved, but the file couldn’t be processed for search. You don’t need to do anything.') };
    return { html: '' };
  }
  /** One contribution. Each fact appears once: the file and (when no section names it) the collection in the subtitle, where it
      stands in Progress (plus an alert with the reviewer's message), the details in their section, every event in History (collapsed). */
  DR['ctb'] = ({ id }) => {
    const d = docById(id);
    if (!d || !canSeeDoc(d)) return { title: 'Contribution not available', body: emptyState({ icon: 'file', title: 'This contribution isn’t available', desc: 'It may have been withdrawn.', compact: true }) };
    const l = lifecycleOf(d), kb = kbById(d.kb), sub = d.submission || {}, mine = isMine(d);
    const orig = sub.versionOf ? docById(sub.versionOf) : null;
    const state = stateBlock(d), sugg = suggestion(d);
    const desc = [
      !sugg && kb && esc(kb.name),
      `${esc((d.type || 'file').toUpperCase())} · ${fmtSize(d.size || 0)}`,
      !mine && `Contributed by ${esc(contributorName(d))}`,
      orig && `New version of <a class="link" href="#/doc/${orig.id}">${esc(docTitle(orig))}</a>`,
    ].filter(Boolean).join(' · ');
    ui('ctbHist', { open: false });
    const body = `<div class="ctb-panel">${state.html}${l.key === 'changes' && mine ? reviseForm(d) : ''}
      <section><h3 class="ctb-sec__title">Progress</h3>${stepper(d)}</section>${sugg}
      ${disclosure({ path: 'ctbHist.open', icon: 'history', title: 'History', summary: esc(`Last update ${relLow(lastEvent(d).at)}`), body: timeline(d, { quoted: state.quoted }) })}</div>`;
    const did = { id: d.id }, openId = versionTarget(d)?.id || d.id;
    const withdrawBtn = btn('Withdraw', { v: 'ghost', icon: 'undo', act: 'ctb-withdraw', data: did });
    let foot = '', footStart = '';
    if (mine) switch (l.key) {
      case 'analyzing': case 'review': footStart = withdrawBtn; foot = btn('Open preview', { v: 'secondary', icon: 'eye', act: 'ctb-doc', data: did }); break;
      case 'changes': footStart = withdrawBtn; foot = btn('Resubmit', { v: 'primary', icon: 'send', act: 'ctb-resubmit', data: did }); break;
      case 'published': case 'publishing': case 'queued': case 'update': case 'stored': case 'versioned':
        foot = (canShare() ? btn('Submit a new version', { icon: 'upload', act: 'ctb-new-version', data: { id: openId } }) : '') + btn('Open', { v: 'primary', icon: 'file-text', act: 'ctb-doc', data: { id: openId } }); break;
      case 'rejected': foot = btn('Withdraw', { v: 'danger-soft', icon: 'trash', act: 'ctb-withdraw', data: did }); break;
    }
    return { size: 'lg', title: docTitle(d), lead: fileIcon(d.type), desc, body, foot, footStart };
  };

  /* ═══════════════ Actions ═══════════════ */
  A['ctb-open'] = el => openDrawer('ctb', { id: el.dataset.id });
  A['ctb-revise'] = el => { openDrawer('ctb', { id: el.dataset.id }); requestAnimationFrame(() => $('#ctb-rev-note')?.focus()); };
  A['ctb-doc'] = el => go('/doc/' + el.dataset.id);
  A['ctb-new-version'] = el => { if (S.drawer) closeDrawer(); A['contribute']({ dataset: { versionOf: el.dataset.id } }); };
  /** Withdraw (in review / changes requested) or remove (not approved). Cheap to reverse: a tombstone with Undo, no confirmation. */
  A['ctb-withdraw'] = el => {
    const d = docById(el.dataset.id); if (!d || !isMine(d) || d.archived) return;
    const removing = stageOf(d) === 'rejected', snap = snapDoc(d);
    withdraw(d);
    if (S.drawer?.name === 'ctb' && S.drawer.props?.id === d.id) S.drawer = null;
    refresh();
    toast(removing ? `Removed “${docTitle(d)}”` : `Withdrew “${docTitle(d)}”`, { action: { label: 'Undo', run: () => { restoreDoc(d, snap); refresh(); } } });
  };
  const revDoc = el => { const d = docById(el.dataset.id); return d && isMine(d) && stageOf(d) === 'changes' ? d : null; };
  A['ctb-rev-browse'] = el => {
    const d = revDoc(el); if (!d) return;
    const inp = document.createElement('input'); inp.type = 'file'; inp.hidden = true; inp.accept = OK_TYPES.map(x => '.' + x).join(',');
    inp.addEventListener('change', () => { const f = inp.files?.[0]; inp.remove(); if (!f) return; ui(revKey(d.id)).file = fileEntry(f.name, f.size); refreshLayer(); });
    document.body.appendChild(inp); inp.click();
  };
  A['ctb-rev-sample'] = el => {
    const d = revDoc(el); if (!d) return;
    const name = /\(revised\)/.test(d.name) ? d.name.replace(/\(revised\)/, '(revised 2)') : `${stemOf(d.name)} (revised).${d.type}`;
    ui(revKey(d.id)).file = fileEntry(name, Math.max(40e3, Math.round((d.size || 120e3) * 0.9))); refreshLayer();
  };
  A['ctb-rev-clear'] = el => { const d = revDoc(el); if (d) { ui(revKey(d.id)).file = null; refreshLayer(); } };
  A['ctb-resubmit'] = el => {
    const d = revDoc(el); if (!d) return;
    const r = ui(revKey(d.id), { note: '', file: null, touched: false }); r.touched = true;
    if (!r.note.trim() || r.file?.err) { refreshLayer(); requestAnimationFrame(() => $('#ctb-rev-note')?.focus()); return; }
    const snap = snapDoc(d);
    resubmit(d, { note: r.note.trim(), file: r.file ? { name: r.file.name, size: r.file.size } : undefined });
    delete S.ui[revKey(d.id)];
    refresh();
    toast('Resubmitted for review', { action: { label: 'Undo', run: () => { restoreDoc(d, snap); refresh(); } } });
  };

  /* ── Share a private file as knowledge (My files → review) ── */
  A['ctb-share'] = el => {
    const d = docById(el.dataset.id); if (!d || !kbById(d.kb)?.personal || !canShare()) return;
    const hint = suggestKb(d.name);
    S.ui.ctbShare = { id: d.id, kb: (hint || contributionTargets()[0]).id, suggested: hint?.id || '', note: '', busy: false };
    openModal('ctb-share', {});
  };
  M['ctb-share'] = () => {
    const f = ui('ctbShare'), d = docById(f.id), dis = f.busy ? 'disabled' : '';
    if (!d) return { title: 'Share as knowledge', body: '', foot: btn('Close', { act: 'close-modal' }) };
    return {
      size: 'md', title: 'Share as knowledge', icon: 'share',
      desc: `Send “${esc(docTitle(d))}” for review. It leaves My files; once published, your team can find it.`,
      body: `<div class="kn-form">${field({ id: 'ctbs-kb', label: 'Collection', desc: f.suggested && f.kb === f.suggested ? 'Suggested by the assistant. A reviewer confirms it.' : `Reviewed by the owners of ${esc(kbById(f.kb)?.name || '')}.`, control: select({ id: 'ctbs-kb', bind: 'ctbShare.kb', value: f.kb, change: 'ctb-share-kb', options: contributionTargets().map(k => [k.id, k.name]), attrs: dis }) })}
        ${field({ id: 'ctbs-note', label: 'Note for reviewers', optional: true, control: textarea({ id: 'ctbs-note', bind: 'ctbShare.note', value: f.note, rows: 2, placeholder: 'What it covers and who it helps', attrs: `maxlength="400" ${dis}` }) })}</div>`,
      footStart: 'Until it’s published, only you and the reviewers can see it.',
      foot: btn('Cancel', { v: 'ghost', act: 'close-modal', disabled: f.busy }) + btn('Send for review', { v: 'primary', icon: 'send', act: 'ctb-share-go', loading: f.busy }),
    };
  };
  A['ctb-share-kb'] = () => refreshLayer();
  A['ctb-share-go'] = async () => {
    const f = ui('ctbShare'), d = docById(f.id), kb = kbById(f.kb);
    if (f.busy || !d || !kb || !contributionTargets().includes(kb)) return;
    f.busy = true; S.modal.props.guard = true; refreshLayer(); await sleep(500);
    submitPrivate(d, kb.id, (f.note || '').trim());
    closeModal(); refresh();
    toast(`Sent “${docTitle(d)}” for review`, { action: { label: 'Open', run: () => go(href(d.id)) } });
  };

  /* ═══════════════ Inbox ═══════════════ */
  const NOTICE = { changes: ['pencil', 'warn'], rejected: ['x-circle', 'neu'], approved: ['check-circle', 'ok'] };
  /** Decisions on the caller's contributions; stable ids per event so read/dismissed state sticks. */
  X.contribNotices = () => myContributions().flatMap(d => {
    const evs = d.submission?.events || [], to = href(d.id), out = [];
    let i = evs.length - 1; while (i >= 0 && !(evs[i].by !== me().id && NOTICE[evs[i].kind])) i--;
    const e = evs[i], name = docTitle(d);
    const live = stageOf(d) === 'versioned' ? versionTarget(d) : d;
    const ready = e?.kind === 'approved' && live && isPublishedStage(live) && live.status === 'ready';
    if (ready) {
      out.push({ id: `ctb-${d.id}-pub`, icon: 'check-circle', tone: 'ok', title: `${name} is published`, body: e.text ? `${actorName(e.by)}: “${e.text}”` : `Searchable in ${kbById(live.kb)?.name || 'its collection'}.`, at: Math.max(e.at, live.updated || 0), to });
    } else if (e) {
      const [icon, tone] = NOTICE[e.kind], by = actorName(e.by);
      const title = e.kind === 'changes' ? `${by} asked for changes to ${name}` : e.kind === 'rejected' ? `${name} was declined` : `${by} approved ${name}`;
      const body = e.text ? `“${e.text}”` : e.kind === 'approved' ? (live?.status === 'failed' ? 'It couldn’t be published. The reviewers have been told.' : 'It’s being published now.') : '';
      out.push({ id: `ctb-${d.id}-${i}`, icon, tone, title, body, at: e.at, to, ...(e.kind === 'changes' && stageOf(d) === 'changes' ? { cta: 'Revise' } : {}) });
    }
    return out;
  });
})();
