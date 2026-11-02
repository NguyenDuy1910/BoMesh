/* Learning work kinds: quizzes (staff quizzes published to a course, and
   private practice quizzes with instant feedback) and study guides.
   Content is generated from the chosen documents (names, topics and pages),
   every item cited. Engine + shell: features/work.js. */
(() => {
  'use strict';

  const C = (doc, page, quote) => ({ doc, page, quote });
  const KEYS = 'ABCD';
  const DIFF = { easy: ['Easy', 'success'], medium: ['Medium', 'default'], hard: ['Hard', 'warning'] };

  /* ═══════════════ Document helpers ═══════════════ */
  const stripExt = n => String(n || '').replace(/\.[a-z0-9]+$/i, '');
  function docTopic(d) {
    const base = stripExt(d?.name);
    const m = base.match(/^(.{1,16}?)\s+—\s+(.+)$/);
    return m ? m[2] : base;
  }
  const shortTopic = d => docTopic(d).split(' & ')[0].replace(/\s*\(.*?\)\s*/g, ' ').trim();
  const weekOf = d => +(String(d?.name || '').match(/^W0?(\d+)\b/)?.[1] || 0);
  function topicsLine(docs) {
    if (docs.length === 1) return docTopic(docs[0]);
    return docs.slice(0, 2).map(shortTopic).join(' & ') + (docs.length > 2 ? ` +${docs.length - 2}` : '');
  }
  function weeksLabel(docs) {
    const w = docs.map(weekOf);
    if (!w.length || w.some(x => !x)) return '';
    const s = [...new Set(w)].sort((a, b) => a - b);
    if (s.length === 1) return `Week ${s[0]}`;
    return s[s.length - 1] - s[0] === s.length - 1 ? `Weeks ${s[0]}–${s[s.length - 1]}` : `Weeks ${s.join(', ')}`;
  }
  const ctxDocs = ctx => (ctx.sources || []).map(docById).filter(Boolean);
  const isPractice = w => w.workflow === 'practice-quiz';
  const audit = (a, t) => X.work.audit(a, t);

  /** Questions for a document without a bank, built from its name and its neighbours. */
  function fallbackQuestions(d) {
    const topic = docTopic(d), pos = hashOf(d.id) % 4;
    const siblings = docsIn(d.kb).filter(x => x.id !== d.id);
    const other = [...siblings.map(docTopic), 'Course logistics and grading', 'Exam regulations', 'Academic integrity'].filter((t, i, a) => t !== topic && a.indexOf(t) === i).slice(0, 3);
    const place = (right, wrong) => { const o = [...wrong]; o.splice(pos, 0, right); return o.slice(0, 4); };
    const names = [...siblings.map(x => stripExt(x.name)), 'Syllabus', 'Academic calendar', 'Lab handbook'].filter((n, i, a) => a.indexOf(n) === i && n !== stripExt(d.name)).slice(0, 3);
    return [
      { q: `Which topic does “${stripExt(d.name)}” cover?`, options: place(topic, other), answer: pos, difficulty: 'easy', topic: topic.toLowerCase(), explain: `This document is the material on ${topic.toLowerCase()}.`, cite: C(d.id, 1, `${stripExt(d.name)} — an introduction to ${topic.toLowerCase()} and its key terms.`) },
      { q: `You need to revise ${topic.toLowerCase()}. Which document should you start with?`, options: place(stripExt(d.name), names), answer: pos, difficulty: 'medium', topic: `where ${topic.toLowerCase()} is covered`, explain: `“${stripExt(d.name)}” is where ${topic.toLowerCase()} is introduced.`, cite: C(d.id, 2, `This document introduces ${topic.toLowerCase()} and the terms used in the rest of the course.`) },
    ];
  }
  /** Interleave per-document banks so a quiz covers every chosen document. */
  function pool(sources) {
    const banks = sources.map(docById).filter(Boolean).map(fallbackQuestions);
    const out = [];
    for (let i = 0; banks.some(b => i < b.length); i++) banks.forEach(b => b[i] && out.push(b[i]));
    return out;
  }

  /* ═══════════════ Quiz kind ═══════════════ */
  const qb = w => ui('quiz:' + w.id, {});
  const take = w => ui(`quizTake:${w.id}:${me().id}`, { mode: null, i: 0, answers: [] });
  const curWork = () => X.work.byId(S.cur?.params?.id);
  const scrollTop = () => $('#work-scroll')?.scrollTo({ top: 0 });
  const topicOf = q => q.topic || '';
  const citeRef = q => q.cite?.doc ? `<span class="quiz-src">${X.work.cite(q.cite, 1)}<span class="truncate">${esc(stripExt(docById(q.cite.doc)?.name || ''))} · p. ${q.cite.page}</span></span>` : '';
  const classSize = (sp, s) => Math.max(s.attempts || 0, (sp?.memberCount || 0) - (sp?.members || []).filter(m => spaceType(sp.type).staff.includes(m.role)).length);
  /** The caller's answer to question q in an attempt (attempts remember question ids, so edits don't shift answers). */
  const answerOf = (a, q, i) => (a.qids ? (a.qids.indexOf(q.id) >= 0 ? a.answers[a.qids.indexOf(q.id)] : undefined) : a.answers[i]);

  function quizOptions(f, ctx) {
    const staff = WORKFLOWS[ctx.workflow]?.audience === 'staff';
    f.opts.count ??= staff ? 8 : 5; f.opts.mix ??= 'balanced';
    return `<div class="field"><span class="label" id="qo-count">Number of questions</span>${seg({ value: f.opts.count, options: [[5, '5'], [8, '8'], [10, '10']], act: 'quiz-opt', data: { k: 'count' }, label: 'Number of questions' })}</div>
      <div class="field"><span class="label">Difficulty</span>${seg({ value: f.opts.mix, options: [['easy', 'Mostly easy'], ['balanced', 'Balanced'], ['hard', 'Challenging']], act: 'quiz-opt', data: { k: 'mix' }, label: 'Difficulty' })}</div>
      <div class="field"><span class="label">Question type</span><div class="t-sm">Multiple choice · 4 answers · one correct</div></div>
      <div class="field">${staff ? alertBox('accent', 'For students — publish when ready', 'You review and edit every question first. Students see nothing until you publish.') : alertBox('default', 'Private practice', 'Only you see it. Each answer is checked right away, with its source.')}</div>`;
  }
  A['quiz-opt'] = el => { const f = ui('workNew'); f.opts[el.dataset.k] = el.dataset.k === 'count' ? +el.dataset.value : el.dataset.value; refresh(); };
  function quizTitle(ctx) {
    const docs = ctxDocs(ctx); if (!docs.length) return 'Quiz';
    if (ctx.workflow === 'practice-quiz') return `Practice — ${topicsLine(docs)}`;
    const wk = weeksLabel(docs);
    return `${wk ? wk + ' quiz' : 'Quiz'} — ${topicsLine(docs)}`;
  }
  function generateQuiz(ctx) {
    const n = ctx.options?.count || 8, mix = ctx.options?.mix || 'balanced';
    let p = pool(ctx.sources || []);
    if (mix !== 'balanced') { const order = mix === 'easy' ? ['easy', 'medium', 'hard'] : ['hard', 'medium', 'easy']; p = p.map((q, i) => [q, i]).sort((a, b) => order.indexOf(a[0].difficulty) - order.indexOf(b[0].difficulty) || a[1] - b[1]).map(x => x[0]); }
    const picks = p.slice(0, n);
    const practice = ctx.workflow === 'practice-quiz';
    return {
      timeLimit: practice ? null : picks.length <= 5 ? 10 : picks.length <= 8 ? 15 : 20, attemptsAllowed: practice ? 0 : 1,
      questions: picks.map((q, i) => ({ id: 'q' + (i + 1), ...clone(q) })),
      stats: { attempts: 0, avg: 0, byQuestion: [] }, attempts: [],
    };
  }
  function quizSummary(w) {
    const n = w.data?.questions?.length || 0, base = plural(n, 'question');
    if (isPractice(w)) { const best = Math.max(-1, ...(w.data?.attempts || []).map(a => a.score)); return best >= 0 ? `${base} · best ${best}/${n}` : `${base} · practice`; }
    if (w.status === 'published' && w.due) return `${base} · ${w.due < Date.now() ? 'closed' : 'due'} ${fmtDate(w.due)}`;
    return base;
  }

  function renderQuiz(w, ctx) {
    if (isPractice(w) && ctx.isOwner) return takeFlow(w, ctx, true);
    if (ctx.canEdit) return staffView(w, ctx);
    return takeFlow(w, ctx, false);
  }

  /* ── Staff: questions + results ── */
  function staffView(w, ctx) {
    const d = w.data || {}, qs = d.questions || [], s = d.stats || {}, published = w.status === 'published';
    const hasResults = published || (s.attempts || 0) > 0;
    const u = qb(w);
    const tab = hasResults ? (u.tab || ctx.query?.tab || (published && s.attempts ? 'results' : 'questions')) : 'questions';
    const sp = ctx.sp;
    const line = published
      ? `<div class="quiz-status">${ic('calendar', 'i-sm')}<span>${w.due ? `${w.due < Date.now() ? 'Closed' : 'Due'} ${esc(fmtDateTime(w.due))}` : 'Published'}</span><span aria-hidden="true">·</span><span>${d.attemptsAllowed === 1 ? 'One attempt' : 'Unlimited attempts'}</span><span aria-hidden="true">·</span><span>${fmtNum(s.attempts || 0)} of ${fmtNum(classSize(sp, s))} submitted</span></div>`
      : `<div class="quiz-status">${ic('eye-off', 'i-sm')}<span>Draft — only the teaching team can see it. Check the questions, then publish.</span></div>`;
    const tabsHtml = hasResults ? `<div class="quiz-tabs">${tabs([{ id: 'questions', label: 'Questions', count: qs.length }, { id: 'results', label: 'Results' }], tab, '', { variant: 'primary', act: 'quiz-tab' })}</div>` : '';
    return `${line}${tabsHtml}${tab === 'results' ? resultsView(w, ctx) : questionsView(w, ctx)}`;
  }
  A['quiz-tab'] = el => { const w = curWork(); if (!w) return; qb(w).tab = el.dataset.value; refresh(); };
  function questionsView(w, ctx) {
    const qs = w.data?.questions || [], u = qb(w), s = w.data?.stats || {};
    const cards = qs.map((q, i) => (u.edit === q.id ? editCard(w, q, i) : u.busy === q.id ? `<div class="card quiz-q" aria-busy="true"><span class="skeleton skeleton--line" style="width:70%"></span><span class="skeleton skeleton--line" style="width:45%"></span><span class="skeleton skeleton--line" style="width:55%"></span></div>` : qCard(w, q, i, ctx, s.byQuestion?.[i])));
    if (!qs.length) return emptyState({ icon: 'list', title: 'No questions yet', desc: 'Add one by hand.', actions: ctx.canEdit ? btn('Add question', { v: 'primary', icon: 'plus', act: 'quiz-add', data: { id: w.id } }) : '', boxed: true });
    return `<div class="quiz-list">${cards.join('')}</div>${ctx.canEdit && !u.edit ? `<div class="quiz-add">${btn('Add question', { icon: 'plus', act: 'quiz-add', data: { id: w.id } })}</div>` : ''}`;
  }
  function qCard(w, q, i, ctx, rate) {
    const [dl, dt] = DIFF[q.difficulty] || DIFF.medium;
    const acts = ctx.canEdit ? `<div class="quiz-q__acts">${iconBtn('pencil', 'Edit', { size: 'sm', act: 'quiz-edit', data: { id: w.id, q: q.id } })}${iconBtn('refresh', 'Regenerate', { size: 'sm', act: 'quiz-regen', data: { id: w.id, q: q.id } })}${iconBtn('trash', 'Remove', { size: 'sm', act: 'quiz-remove', data: { id: w.id, q: q.id } })}</div>` : '';
    return `<div class="card quiz-q" id="quiz-q-${q.id}">
      <div class="quiz-q__head"><span class="quiz-q__n">${i + 1}</span><div class="quiz-q__text">${esc(q.q)}</div>${acts}</div>
      <ol class="quiz-key">${q.options.map((o, j) => `<li class="quiz-key__opt ${j === q.answer ? 'is-correct' : ''}"><span class="quiz-opt__key">${KEYS[j]}</span><span class="grow">${esc(o)}</span>${j === q.answer ? `<span class="quiz-key__tag">${ic('check', 'i-sm')}Correct</span>` : ''}</li>`).join('')}</ol>
      <div class="quiz-q__explain">${esc(q.explain || '')}</div>
      <div class="quiz-q__foot">${chip(dl, { tone: dt, size: 'sm' })}${rate != null && w.status === 'published' ? chip(`${Math.round(rate * 100)}% correct`, { size: 'sm', variant: 'outline' }) : ''}<span class="grow"></span>${citeRef(q)}</div>
    </div>`;
  }
  function editCard(w, q, i) {
    const e = S.ui.quizEdit || {};
    const missing = e.err ? e.options.map(o => !o.trim()) : [];
    return `<div class="card quiz-q quiz-q--edit" id="quiz-q-${q.id}">
      <div class="t-subheading">${e.isNew ? 'New question' : `Edit question ${i + 1}`}</div>
      ${field({ id: 'qe-q', label: 'Question', required: true, control: textarea({ id: 'qe-q', bind: 'quizEdit.q', value: e.q, rows: 2, invalid: e.err && !e.q.trim() }) })}
      <div class="field"><span class="label">Answers<span class="label__req" aria-hidden="true">*</span></span><div class="quiz-edit__opts">${e.options.map((o, j) => `<div class="quiz-edit__opt"><button type="button" class="quiz-edit__key ${e.answer === j ? 'is-on' : ''}" data-act="quiz-edit-answer" data-value="${j}" aria-pressed="${e.answer === j}" aria-label="Mark answer ${KEYS[j]} as correct" data-tip="Mark as correct">${e.answer === j ? ic('check', 'i-sm') : KEYS[j]}</button>${input({ id: 'qe-o' + j, bind: 'quizEdit.options.' + j, value: o, placeholder: `Answer ${KEYS[j]}`, attrs: `aria-label="Answer ${KEYS[j]}"`, invalid: missing[j] })}</div>`).join('')}</div><div class="description">Select a letter to mark the correct answer.</div></div>
      <div class="field"><span class="label">Difficulty</span>${seg({ value: e.difficulty, options: [['easy', 'Easy'], ['medium', 'Medium'], ['hard', 'Hard']], act: 'quiz-edit-diff', label: 'Difficulty' })}</div>
      ${field({ id: 'qe-x', label: 'Explanation', optional: true, desc: 'Students see it after they answer.', control: textarea({ id: 'qe-x', bind: 'quizEdit.explain', value: e.explain, rows: 2 }) })}
      ${e.err ? `<div class="field-error" role="alert">${ic('alert-circle')}<span>${esc(e.err)}</span></div>` : ''}
      <div class="quiz-edit__foot">${q.cite?.doc ? citeRef(q) : ''}<span class="grow"></span>${btn('Cancel', { v: 'ghost', act: 'quiz-edit-cancel' })}${btn('Save', { v: 'primary', act: 'quiz-edit-save' })}</div>
    </div>`;
  }
  function openEdit(w, q, isNew) {
    S.ui.quizEdit = { wid: w.id, qid: q.id, q: q.q, options: [...q.options], answer: q.answer, difficulty: q.difficulty || 'medium', explain: q.explain || '', isNew, err: '' };
    qb(w).edit = q.id; refresh();
    requestAnimationFrame(() => { $('#quiz-q-' + q.id)?.scrollIntoView({ block: 'nearest' }); $('#qe-q')?.focus(); });
  }
  A['quiz-edit'] = el => { const w = X.work.byId(el.dataset.id), q = w?.data.questions.find(x => x.id === el.dataset.q); if (q && X.work.canEdit(w)) openEdit(w, q, false); };
  A['quiz-edit-answer'] = el => { S.ui.quizEdit.answer = +el.dataset.value; refresh(); };
  A['quiz-edit-diff'] = el => { S.ui.quizEdit.difficulty = el.dataset.value; refresh(); };
  A['quiz-edit-cancel'] = () => {
    const e = S.ui.quizEdit, w = X.work.byId(e?.wid); if (!w) return;
    if (e.isNew) { const i = w.data.questions.findIndex(q => q.id === e.qid); if (i >= 0) w.data.questions.splice(i, 1); }
    qb(w).edit = null; S.ui.quizEdit = null; refresh();
  };
  A['quiz-edit-save'] = () => {
    const e = S.ui.quizEdit, w = X.work.byId(e?.wid); if (!w) return;
    if (!e.q.trim() || e.options.some(o => !o.trim())) { e.err = 'Write the question and all four answers.'; refresh(); return; }
    const q = w.data.questions.find(x => x.id === e.qid); if (!q) return;
    Object.assign(q, { q: e.q.trim(), options: e.options.map(o => o.trim()), answer: e.answer, difficulty: e.difficulty, explain: e.explain.trim() });
    delete q.topic;
    qb(w).edit = null; S.ui.quizEdit = null; X.work.save(w); refresh();
    toast(e.isNew ? 'Question added' : 'Question saved');
  };
  A['quiz-add'] = el => {
    const w = X.work.byId(el.dataset.id); if (!w || !X.work.canEdit(w)) return;
    const q = { id: uid('q'), q: '', options: ['', '', '', ''], answer: 0, difficulty: 'medium', explain: '', cite: null };
    w.data.questions ??= []; w.data.questions.push(q); openEdit(w, q, true);
  };
  A['quiz-regen'] = async el => {
    const w = X.work.byId(el.dataset.id); if (!w) return;
    const qs = w.data.questions, i = qs.findIndex(x => x.id === el.dataset.q); if (i < 0) return;
    const used = new Set(qs.map(q => q.q));
    const next = pool(w.sources).find(q => !used.has(q.q));
    if (!next) { toast('No other questions in these materials. Edit this one instead.', { tone: 'accent' }); return; }
    qb(w).busy = qs[i].id; refresh();
    await sleep(700);
    const prev = qs[i], s = w.data.stats || {}, prevRate = s.byQuestion?.[i];
    qs[i] = { id: prev.id, ...clone(next) };
    if (s.byQuestion && i < s.byQuestion.length) s.byQuestion[i] = null;
    qb(w).busy = null; X.work.save(w); refresh();
    toast('Question replaced', { action: { label: 'Undo', run: () => { const j = qs.findIndex(x => x.id === prev.id); if (j >= 0) { qs[j] = prev; if (s.byQuestion && j < s.byQuestion.length) s.byQuestion[j] = prevRate; } X.work.save(w); refresh(); } } });
  };
  A['quiz-remove'] = el => {
    const w = X.work.byId(el.dataset.id); if (!w) return;
    const qs = w.data.questions, i = qs.findIndex(x => x.id === el.dataset.q); if (i < 0) return;
    if (qs.length === 1) { toast('A quiz needs at least one question.', { tone: 'danger' }); return; }
    const [q] = qs.splice(i, 1), s = w.data.stats || {}, rate = s.byQuestion?.splice(i, 1);
    X.work.save(w); refresh();
    toast(`Removed question ${i + 1}`, { action: { label: 'Undo', run: () => { qs.splice(i, 0, q); if (rate?.length) s.byQuestion.splice(i, 0, rate[0]); X.work.save(w); refresh(); } } });
  };

  function resultsView(w, ctx) {
    const d = w.data, qs = d.questions || [], s = d.stats || { attempts: 0 };
    if (!s.attempts) return emptyState({ icon: 'chart', title: 'No answers yet', desc: w.due ? `Results show up here as students submit. The quiz closes ${esc(fmtDateTime(w.due))}.` : 'Results show up here as students submit.', boxed: true });
    const size = classSize(ctx.sp, s);
    const stats = `<div class="grid cols-2 quiz-stats">${statCard({ icon: 'users', label: 'Submitted', value: `${fmtNum(s.attempts)}<span class="quiz-stat__of"> of ${fmtNum(size)}</span>`, meta: `${pct(s.attempts, size)}% of the class` })}${statCard({ icon: 'target', label: 'Average score', value: `${(s.avg || 0).toFixed(1)}<span class="quiz-stat__of"> / ${qs.length}</span>`, meta: `${pct(s.avg || 0, qs.length)}%` })}</div>`;
    const rated = qs.map((q, i) => ({ q, i, r: s.byQuestion?.[i] })).filter(x => x.r != null).sort((a, b) => a.r - b.r);
    const hard = rated[0];
    const insight = hard && hard.r < 0.6 ? `<div class="mt-16">${alertBox('warning', `Q${hard.i + 1} — ${topicOf(hard.q) || `“${hard.q.q}”`} — only ${Math.round(hard.r * 100)}% correct`, `Correct answer: ${esc(hard.q.options[hard.q.answer])}. ${esc(hard.q.explain || '')}`, btn('Explain in class', { size: 'sm', v: 'secondary', icon: 'sparkles', act: 'quiz-explain', data: { id: w.id, q: hard.q.id } }), { icon: 'lightbulb' })}</div>` : '';
    const tone = r => (r < 0.5 ? 'danger' : r < 0.7 ? 'warning' : 'success');
    const barsHtml = rated.length ? `<div class="card quiz-bars">${rated.map(x => `<div class="quiz-bar"><span class="quiz-bar__n num">Q${x.i + 1}</span><span class="quiz-bar__q truncate" title="${esc(x.q.q)}">${esc(x.q.q)}</span><span class="quiz-bar__track">${progress(x.r * 100, tone(x.r), `Q${x.i + 1} correct rate`)}</span><span class="quiz-bar__pct num">${Math.round(x.r * 100)}%</span></div>`).join('')}</div>` : emptyState({ icon: 'chart', title: 'No answers for these questions yet', compact: true, boxed: true });
    return `${stats}${insight}${section('By question', barsHtml, { desc: 'Share of students who answered correctly, hardest first.' })}`;
  }
  A['quiz-explain'] = el => {
    const w = X.work.byId(el.dataset.id), q = w?.data.questions.find(x => x.id === el.dataset.q); if (!q) return;
    const i = w.data.questions.indexOf(q), r = w.data.stats?.byQuestion?.[i];
    const prompt = `Help me explain this in class: “${q.q}” Only ${Math.round((r || 0) * 100)}% of students answered correctly (the answer is “${q.options[q.answer]}”). Give a short explanation, a worked example and the most likely misconception, from the course materials.`;
    if (A['chat-ask']) A['chat-ask']({ dataset: { q: prompt, space: w.space, doc: q.cite?.doc } });
    else toast('The assistant isn’t available right now.', { tone: 'danger' });
  };

  /* ── Publish ── */
  const dueAt = days => { const d = new Date(Date.now() + days * DAY); d.setHours(23, 59, 0, 0); return d.getTime(); };
  A['quiz-publish'] = el => {
    const w = X.work.byId(el.dataset.id); if (!w) return;
    S.ui.quizPub = { days: '5', attempts: '1', notify: true, limit: String(w.data.timeLimit || 15) };
    openModal('quiz-publish', { id: w.id });
  };
  M['quiz-publish'] = p => {
    const w = X.work.byId(p.id), sp = spaceById(w?.space), f = S.ui.quizPub || {};
    if (!w || !sp) return { title: 'Publish quiz', body: '' };
    const n = w.data.questions.length;
    return {
      title: `Publish to ${sp.code || sp.name}`, desc: `${plural(n, 'question')} · students in ${esc(sp.name)} see it on Home and in the course.`,
      body: `<div class="quiz-pub">${field({ id: 'qp-due', label: 'Due', control: select({ id: 'qp-due', bind: 'quizPub.days', value: f.days, options: [3, 5, 7].map(dd => [String(dd), `In ${dd} days — ${new Date(dueAt(dd)).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`]) }) })}
        ${field({ id: 'qp-limit', label: 'Time limit', control: select({ id: 'qp-limit', bind: 'quizPub.limit', value: f.limit, options: [['10', '10 minutes'], ['15', '15 minutes'], ['20', '20 minutes'], ['30', '30 minutes']] }) })}
        <div class="field"><span class="label">Attempts</span>${seg({ value: f.attempts, options: [['1', 'One attempt'], ['0', 'Unlimited']], act: 'quiz-pub-attempts', label: 'Attempts' })}</div>
        <div class="mt-8">${switchRow({ title: 'Notify students', desc: 'Posts an announcement in the course.', on: f.notify, act: 'quiz-pub-notify' })}</div></div>`,
      foot: btn('Cancel', { act: 'close-modal' }) + btn('Publish', { v: 'primary', icon: 'send', act: 'quiz-pub-ok', data: { id: w.id } }),
    };
  };
  A['quiz-pub-attempts'] = el => { S.ui.quizPub.attempts = el.dataset.value; refreshLayer(); };
  A['quiz-pub-notify'] = () => { S.ui.quizPub.notify = !S.ui.quizPub.notify; refreshLayer(); };
  A['quiz-pub-ok'] = el => {
    const w = X.work.byId(el.dataset.id), sp = spaceById(w?.space), f = S.ui.quizPub; if (!w || !sp) return;
    const prev = { status: w.status, visibility: w.visibility, published: w.published, due: w.due, attemptsAllowed: w.data.attemptsAllowed, timeLimit: w.data.timeLimit };
    const due = dueAt(+f.days);
    Object.assign(w, { status: 'published', visibility: 'space', published: Date.now(), due });
    w.data.attemptsAllowed = +f.attempts; w.data.timeLimit = +f.limit;
    const evt = { id: uid('evt'), space: sp.id, kind: 'quiz', title: `${w.title.split(' — ')[0]} closes`, at: due, audience: 'members', work: w.id };
    (D.events ??= []).push(evt);
    let ann = null;
    if (f.notify) { ann = { id: uid('an'), by: me().id, at: Date.now(), title: `${w.title.split(' — ')[0]} is open`, text: `${plural(w.data.questions.length, 'question')}, ${f.limit} minutes. It closes ${new Date(due).toLocaleString('en-US', { weekday: 'long', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}${+f.attempts === 1 ? '; you can take it once' : ''}.` }; (sp.announcements ??= []).unshift(ann); }
    audit('Published quiz', `${w.title} → ${sp.name}`);
    X.work.save(w); closeModal(); qb(w).tab = null; refresh();
    toast(`Published to ${sp.code || sp.name}${f.notify ? ' · students notified' : ''}`, { action: { label: 'Undo', run: () => {
      Object.assign(w, { status: prev.status, visibility: prev.visibility, published: prev.published, due: prev.due }); w.data.attemptsAllowed = prev.attemptsAllowed; w.data.timeLimit = prev.timeLimit;
      D.events = (D.events || []).filter(e => e !== evt); if (ann) sp.announcements = sp.announcements.filter(a => a !== ann);
      X.work.save(w); refresh(); toast('Back to draft');
    } } });
  };

  /* ── Students & practice: take the quiz ── */
  function takeFlow(w, ctx, practice) {
    const t = take(w), a = X.work.myAttempt(w), qs = w.data?.questions || [];
    if (!qs.length) return emptyState({ icon: 'list', title: 'This quiz has no questions', boxed: true });
    if (t.mode === 'taking') return takeView(w, t, practice);
    if (a && t.mode !== 'start') return resultView(w, a, ctx, practice);
    if (!practice && w.due && w.due < Date.now() && !a) return emptyState({ icon: 'clock', title: 'This quiz is closed', desc: `It closed ${esc(fmtDateTime(w.due))}. Ask the teaching team if you missed it for a good reason.`, actions: A['rq-ask-staff'] ? btn('Ask the teaching team', { act: 'quiz-ask', data: { id: w.id } }) : '', boxed: true });
    return startCard(w, a, practice);
  }
  function startCard(w, a, practice) {
    const d = w.data, n = d.questions.length;
    const facts = [plural(n, 'question'), d.timeLimit ? `${d.timeLimit} min` : 'No time limit', practice ? 'Instant feedback' : d.attemptsAllowed === 1 ? 'One attempt' : 'Unlimited attempts', !practice && w.due ? `Due ${fmtDateTime(w.due)}` : ''].filter(Boolean);
    const tries = (d.attempts || []).filter(x => x.user === me().id);
    const best = tries.length ? Math.max(...tries.map(x => x.score)) : null;
    return `<div class="card card--lg quiz-start">
      ${itemIcon(practice ? 'target' : 'check-circle', 'accent')}
      <div><h2 class="t-heading">${practice ? 'Practice quiz' : 'Ready when you are'}</h2><p class="t-sm muted mt-4">${practice ? 'Each answer is checked right away and explained with its source.' : 'Answer every question, then submit. You’ll see your score and why each answer is right.'}</p></div>
      <div class="quiz-facts">${facts.map(f => `<span class="quiz-fact">${esc(f)}</span>`).join('')}</div>
      ${best != null ? `<div class="t-sm muted">Best so far ${best}/${n} · ${plural(tries.length, 'try', 'tries')}</div>` : ''}
      <div class="row gap-8 wrap">${btn(a ? 'Try again' : 'Start quiz', { v: 'primary', icon: 'play', act: 'quiz-start', data: { id: w.id } })}${a ? btn('See last result', { act: 'quiz-last', data: { id: w.id } }) : ''}</div>
    </div>`;
  }
  function takeView(w, t, practice) {
    const qs = w.data.questions, n = qs.length, i = Math.min(t.i, n - 1), q = qs[i], ans = t.answers[i];
    const locked = practice && ans != null;
    const answered = qs.filter((_, j) => t.answers[j] != null).length;
    const left = !practice && w.data.timeLimit ? Math.max(0, Math.ceil((t.started + w.data.timeLimit * MIN - Date.now()) / MIN)) : null;
    const opts = q.options.map((o, j) => {
      const st = locked ? (j === q.answer ? 'is-correct' : j === ans ? 'is-wrong' : '') : '';
      return `<label class="quiz-opt ${ans === j ? 'is-picked' : ''} ${st}"><input type="radio" id="qt-${q.id}-${j}" name="qt-${q.id}" value="${j}" ${ans === j ? 'checked' : ''} ${locked ? 'disabled' : ''} data-change="quiz-pick" data-id="${w.id}" data-i="${i}" data-value="${j}"><span class="quiz-opt__key">${KEYS[j]}</span><span class="quiz-opt__text">${esc(o)}</span>${locked && j === q.answer ? ic('check-circle', 'quiz-opt__icon') : locked && j === ans ? ic('x-circle', 'quiz-opt__icon') : ''}</label>`;
    }).join('');
    const right = ans === q.answer;
    const feedback = locked ? `<div class="quiz-feedback ${right ? 'is-right' : 'is-wrong'}" role="status"><div class="quiz-feedback__title">${ic(right ? 'check-circle' : 'x-circle', 'i-sm')}${right ? 'Correct' : `Not quite — the answer is ${KEYS[q.answer]}`}</div><p>${esc(q.explain || '')}</p>${citeRef(q)}</div>` : '';
    const last = i === n - 1;
    return `<div class="card card--lg quiz-take">
      <div class="quiz-take__top"><span class="t-sm medium">Question ${i + 1} of ${n}</span><span class="t-sm muted num">${left != null ? `${left} min left` : `${answered} answered`}</span></div>
      ${progress(((i + 1) / n) * 100, '', `Question ${i + 1} of ${n}`)}
      <h2 class="quiz-take__q" id="qt-label">${esc(q.q)}</h2>
      <div class="quiz-opts" role="radiogroup" aria-labelledby="qt-label">${opts}</div>
      ${feedback}
      <div class="quiz-take__nav">${btn('Back', { icon: 'arrow-left', act: 'quiz-nav', data: { id: w.id, d: -1 }, disabled: i === 0 })}${btn('Exit', { v: 'ghost', act: 'quiz-exit', data: { id: w.id } })}<span class="grow"></span>${last ? btn(practice ? 'See results' : 'Submit', { v: 'primary', icon: 'check', act: 'quiz-submit', data: { id: w.id } }) : btn('Next', { v: ans != null ? 'primary' : 'tertiary', iconRight: 'arrow-right', act: 'quiz-nav', data: { id: w.id, d: 1 } })}</div>
    </div>`;
  }
  A['quiz-start'] = el => {
    const w = X.work.byId(el.dataset.id); if (!w) return;
    if (!isPractice(w) && w.data.attemptsAllowed === 1 && X.work.myAttempt(w)) return;
    Object.assign(take(w), { mode: 'taking', i: 0, answers: [], started: Date.now() }); refresh(); scrollTop();
  };
  A['quiz-last'] = el => { const w = X.work.byId(el.dataset.id); if (!w) return; take(w).mode = 'result'; refresh(); scrollTop(); };
  A['quiz-exit'] = el => { const w = X.work.byId(el.dataset.id); if (!w) return; take(w).mode = X.work.myAttempt(w) ? 'result' : 'start'; refresh(); scrollTop(); };
  A['quiz-pick'] = el => { const w = X.work.byId(el.dataset.id); if (!w) return; take(w).answers[+el.dataset.i] = +el.dataset.value; refresh(); };
  A['quiz-nav'] = el => { const w = X.work.byId(el.dataset.id); if (!w) return; const t = take(w); t.i = Math.max(0, Math.min(w.data.questions.length - 1, t.i + +el.dataset.d)); refresh(); scrollTop(); };
  A['quiz-submit'] = el => {
    const w = X.work.byId(el.dataset.id); if (!w) return;
    const t = take(w), qs = w.data.questions, open = qs.filter((_, i) => t.answers[i] == null).length;
    const practice = isPractice(w);
    if (practice && !open) return submit(w);
    confirmAction({
      title: open ? `Submit with ${plural(open, 'unanswered question')}?` : 'Submit your answers?',
      body: open ? 'Unanswered questions count as wrong.' : w.data.attemptsAllowed === 1 ? 'You can take this quiz once, so you can’t change answers after this.' : 'You can try again afterwards.',
      confirm: 'Submit', delay: 300, onConfirm: () => submit(w),
    });
  };
  function submit(w) {
    const t = take(w), qs = w.data.questions, d = w.data;
    const answers = qs.map((_, i) => t.answers[i] ?? null);
    const score = qs.filter((q, i) => answers[i] === q.answer).length;
    const att = { id: uid('at'), user: me().id, at: Date.now(), answers, qids: qs.map(q => q.id), score, total: qs.length };
    (d.attempts ??= []).push(att);
    if (!isPractice(w)) {
      const s = d.stats ??= { attempts: 0, avg: 0, byQuestion: [] }, n = s.attempts || 0;
      s.byQuestion = qs.map((q, i) => (((s.byQuestion?.[i] ?? 0) * n) + (answers[i] === q.answer ? 1 : 0)) / (n + 1));
      s.avg = ((s.avg || 0) * n + score) / (n + 1); s.attempts = n + 1;
      audit('Submitted quiz', w.title);
    }
    Object.assign(t, { mode: 'result', i: 0, answers: [] });
    persist(); refresh(); scrollTop();
    toast(`Submitted · ${score} of ${qs.length} correct`);
  }
  const missedOf = (w, a) => (w.data.questions || []).filter((q, i) => answerOf(a, q, i) !== q.answer);
  function resultView(w, a, ctx, practice) {
    const qs = w.data.questions, p = pct(a.score, a.total), missed = missedOf(w, a), sp = ctx.sp;
    const msg = p >= 80 ? 'Strong result.' : p >= 50 ? 'A good base — a few things to review.' : 'Worth another look at the materials.';
    const canGuide = workflowsFor(sp).some(f => f.id === 'study-guide');
    const canAsk = !!A['rq-ask-staff'] && !!sp && !isSpaceStaff(sp);
    const retake = practice || w.data.attemptsAllowed !== 1;
    const next = [
      canGuide && btn(missed.length ? 'Make a study guide on what I missed' : 'Make a study guide', { v: 'primary', icon: 'book', act: 'quiz-guide', data: { id: w.id } }),
      canAsk && btn('Ask the teaching team', { icon: 'message', act: 'quiz-ask', data: { id: w.id } }),
      retake && btn('Try again', { icon: 'retry', act: 'quiz-start', data: { id: w.id } }),
    ].filter(Boolean).join('');
    const review = qs.map((q, i) => {
      const ans = answerOf(a, q, i), ok = ans === q.answer;
      return `<div class="card quiz-q quiz-q--review">
        <div class="quiz-q__head"><span class="quiz-q__n ${ok ? 'is-right' : 'is-wrong'}" aria-label="${ok ? 'Correct' : 'Incorrect'}">${ic(ok ? 'check' : 'x', 'i-sm')}</span><div class="quiz-q__text">${i + 1}. ${esc(q.q)}</div></div>
        <ol class="quiz-key">${q.options.map((o, j) => `<li class="quiz-key__opt ${j === q.answer ? 'is-correct' : j === ans ? 'is-wrong' : ''}"><span class="quiz-opt__key">${KEYS[j]}</span><span class="grow">${esc(o)}</span>${j === q.answer ? `<span class="quiz-key__tag">${ic('check', 'i-sm')}${j === ans ? 'Your answer' : 'Correct answer'}</span>` : j === ans ? `<span class="quiz-key__tag">${ic('x', 'i-sm')}Your answer</span>` : ''}</li>`).join('')}</ol>
        ${ans == null ? '<div class="t-xs muted">Not answered</div>' : ''}
        <div class="quiz-q__explain">${esc(q.explain || '')}</div>
        <div class="quiz-q__foot"><span class="grow"></span>${citeRef(q)}</div>
      </div>`;
    }).join('');
    return `<div class="card card--lg quiz-score">
        <div class="quiz-score__row"><div><div class="t-label">Your score</div><div class="quiz-score__num num">${a.score}<span>/${a.total}</span></div></div><div class="grow"><div class="t-subheading">${msg}</div><div class="t-sm muted">${p}% · submitted ${esc(rel(a.at))}${missed.length ? ` · ${plural(missed.length, 'question')} to review` : ''}</div></div></div>
        ${progress(p, p >= 80 ? 'success' : p >= 50 ? 'warning' : 'danger', 'Score')}
        ${next ? `<div class="quiz-next"><div class="t-label">Next step</div><div class="row gap-8 wrap">${next}</div></div>` : ''}
      </div>
      ${section('Your answers', `<div class="quiz-list">${review}</div>`)}`;
  }
  A['quiz-guide'] = el => {
    const w = X.work.byId(el.dataset.id), a = w && X.work.myAttempt(w); if (!w) return;
    const missed = a ? missedOf(w, a) : [];
    const docs = [...new Set(missed.map(q => q.cite?.doc).filter(Boolean))];
    const short = w.title.split(' — ')[0];
    A['work-start']({ dataset: { workflow: 'study-guide', space: w.space, docs: (docs.length ? docs : w.sources).join(','), title: missed.length ? `${short} — what I missed` : `${short} — study guide`, from: missed.length ? w.id : '' } });
  };
  A['quiz-ask'] = el => {
    const w = X.work.byId(el.dataset.id), a = w && X.work.myAttempt(w); if (!w) return;
    const m = a ? missedOf(w, a)[0] : null, i = m ? w.data.questions.indexOf(m) : -1;
    const mine = m ? m.options[answerOf(a, m, i)] : null;
    const q = m ? `About ${w.title}, question ${i + 1}: “${m.q}” ${mine ? `I chose “${mine}”` : 'I left it blank'}, but the answer is “${m.options[m.answer]}”. Could you explain why?` : `Question about ${w.title}: `;
    if (A['rq-ask-staff']) A['rq-ask-staff']({ dataset: { space: w.space, q } });
    else toast('Requests aren’t available right now.', { tone: 'danger' });
  };
  function quizActions(w, ctx) {
    if (isPractice(w) || !ctx.canEdit || w.status === 'published' || !ctx.sp) return '';
    return btn(`Publish to ${ctx.sp.code || ctx.sp.name}`, { v: 'primary', icon: 'send', act: 'quiz-publish', data: { id: w.id }, disabled: !w.data?.questions?.length || !!qb(w).edit });
  }
  const quizHtml = w => `<ol>${(w.data.questions || []).map(q => `<li><p>${esc(q.q)}</p><ol type="A">${q.options.map((o, j) => `<li>${esc(o)}${j === q.answer ? ' <b>(correct)</b>' : ''}</li>`).join('')}</ol>${q.explain ? `<p><i>${esc(q.explain)}</i></p>` : ''}${q.cite?.doc ? `<p><small>Source: ${esc(docById(q.cite.doc)?.name || '')}, page ${q.cite.page}</small></p>` : ''}</li>`).join('')}</ol>`;
  const quizLines = w => (w.data.questions || []).flatMap((q, i) => [`${i + 1}. ${q.q}`, ...q.options.map((o, j) => `   ${KEYS[j]}. ${o}${j === q.answer ? '  (correct)' : ''}`), q.explain ? `   ${q.explain}` : '', '']);

  WORK_KINDS.quiz = {
    label: 'Quiz', icon: 'check-circle', noun: 'questions',
    options: quizOptions, title: quizTitle, generate: generateQuiz, render: renderQuiz, actions: quizActions, summary: quizSummary,
    exportHtml: quizHtml, exportLines: quizLines,
    canDownload: (w, ctx) => ctx.canEdit || isPractice(w) || !!X.work.myAttempt(w),
  };

  /* ═══════════════ Study guide kind ═══════════════ */
  const gb = w => ui('guide:' + w.id, {});
  function fallbackGuide(d) {
    const topic = docTopic(d), t = topic.toLowerCase(), c = C(d.id, 1, `${stripExt(d.name)} — an introduction to ${t} and its key terms.`);
    return {
      summary: [`<p><i>${esc(stripExt(d.name))}</i> introduces ${esc(t)}: the main ideas, the terms used and how they connect to the rest of the course [1].</p>`, `<p>This part of the course is about ${esc(t)} — what it is, why it matters and the terms you need to follow later material [1].</p>`],
      simple: `<p>This document explains ${esc(t)} and the words you need to know [1].</p>`,
      cites: [c], terms: [[esc(topic), 'the main subject of this document; its definitions are on the first pages', C(d.id, 2, `This document introduces ${t} and defines its key terms.`)]],
      example: null, check: [`What are the two most important ideas in “${topic}”?`, `How does ${t} connect to earlier material?`],
    };
  }
  const banksFor = sources => sources.map(docById).filter(Boolean).map(d => [d, fallbackGuide(d)]);
  const firstSentence = html => html.replace(/<p>(.*?)<\/p>/s, (m, t) => `<p>${(t.match(/^.*?[.!?](\s*\[\d+\])?(?=\s|$)/s) || [t])[0]}</p>`);
  const KEY_BY_TITLE = { 'In one paragraph': 'summary', 'Key terms': 'terms', 'Worked example': 'example', 'Check yourself': 'check', 'What you missed': 'missed' };
  const TITLE = { summary: 'In one paragraph', terms: 'Key terms', example: 'Worked example', check: 'Check yourself', missed: 'What you missed' };
  /** Build one section from the banks. o = { v (variant), mode: short|simple, depth, from (quiz id) }. */
  function buildSection(key, banks, o = {}) {
    const v = o.v || 0, short = o.mode === 'short', simple = o.mode === 'simple', quick = o.depth === 'quick';
    if (key === 'summary') {
      const parts = banks.slice(0, quick ? 2 : 3).map(([, g]) => ({ html: simple ? g.simple : g.summary[v % g.summary.length], cites: g.cites }));
      let off = 0; const cs = [];
      const text = parts.map(p => { const h = (short ? firstSentence(p.html) : p.html).replace(/\[(\d+)\]/g, (m, n) => `[${+n + off}]`); off += p.cites.length; cs.push(...p.cites); return h.replace(/<\/?p>/g, ''); }).join(' ');
      return { html: `<p>${text}</p>`, cites: cs };
    }
    if (key === 'terms') {
      let all = banks.flatMap(([, g]) => g.terms);
      if (!all.length) return null;
      const k = v % all.length; all = [...all.slice(k), ...all.slice(0, k)];
      const terms = all.slice(0, short ? 3 : quick ? 4 : 8);
      return { html: `<ul>${terms.map(([t, def], i) => `<li><b>${t}</b> — ${simple ? def.split(/[;(]/)[0].trim() : def} [${i + 1}]</li>`).join('')}</ul>`, cites: terms.map(t => t[2]) };
    }
    if (key === 'example') {
      const ex = banks.map(([, g]) => g.example).filter(Boolean);
      if (!ex.length) return null;
      const e = ex[v % ex.length];
      return { html: short || simple ? firstSentence(e.html) : e.html, cites: [e.cite] };
    }
    if (key === 'check') {
      let qs = banks.flatMap(([, g]) => g.check);
      if (!qs.length) return null;
      const k = v % qs.length; qs = [...qs.slice(k), ...qs.slice(0, k)];
      return { html: `<ol>${qs.slice(0, short ? 3 : 5).map(q => `<li>${esc(q)}</li>`).join('')}</ol>`, cites: [] };
    }
    if (key === 'missed') {
      const quiz = X.work.byId(o.from), a = quiz && X.work.myAttempt(quiz);
      const missed = a ? missedOf(quiz, a) : [];
      if (!missed.length) return null;
      const list = short ? missed.slice(0, 2) : missed;
      return { html: `<ul>${list.map((q, i) => `<li><b>${esc(q.q)}</b> The answer is “${esc(q.options[q.answer])}”.${simple ? '' : ` ${esc(q.explain || '')}`} [${i + 1}]</li>`).join('')}</ul>`, cites: list.map(q => q.cite).filter(Boolean) };
    }
    return null;
  }
  function generateGuide(ctx) {
    const banks = banksFor(ctx.sources || []), o = ctx.options || {};
    const depth = o.depth || 'full', check = o.check !== false;
    const keys = [o.from && 'missed', 'summary', 'terms', depth === 'full' && 'example', check && 'check'].filter(Boolean);
    const sections = keys.map(k => [k, buildSection(k, banks, { depth, from: o.from })]).filter(([, s]) => s).map(([k, s], i) => ({ id: 's' + (i + 1), key: k, title: TITLE[k], html: s.html, cites: s.cites, v: 0 }));
    return { depth, check, sections };
  }
  function guideOptions(f) {
    f.opts.depth ??= 'full'; f.opts.check ??= true;
    const from = f.opts.from && X.work.byId(f.opts.from);
    return `${from ? `<div class="field">${alertBox('accent', 'Focused on what you missed', `Starts with the questions you got wrong in ${esc(from.title)}.`)}</div>` : ''}
      <div class="field"><span class="label">Depth</span>${seg({ value: f.opts.depth, options: [['quick', 'Quick summary'], ['full', 'Full guide']], act: 'guide-opt', data: { k: 'depth' }, label: 'Depth' })}<div class="description">${f.opts.depth === 'quick' ? 'A paragraph and the key terms.' : 'Summary, key terms and a worked example.'}</div></div>
      <div class="field">${switchRow({ title: 'Include check-yourself questions', desc: 'A few open questions to test your understanding.', on: f.opts.check, act: 'guide-opt-check' })}</div>`;
  }
  A['guide-opt'] = el => { ui('workNew').opts[el.dataset.k] = el.dataset.value; refresh(); };
  A['guide-opt-check'] = () => { const f = ui('workNew'); f.opts.check = !f.opts.check; refresh(); };
  const guideTitle = ctx => { const docs = ctxDocs(ctx); return docs.length ? `${topicsLine(docs)} — study guide` : 'Study guide'; };
  function renderGuide(w, ctx) {
    const secs = w.data?.sections || [], u = gb(w);
    if (!secs.length) return emptyState({ icon: 'book', title: 'This guide is empty', boxed: true });
    return `<article class="guide">${secs.map(s => {
      const acts = ctx.canEdit ? `<div class="guide-sec__acts">${iconBtn('refresh', 'Regenerate', { size: 'sm', act: 'guide-rewrite', data: { id: w.id, s: s.id, mode: 'regen' }, disabled: !!u.busy })}${btn('Rewrite', { v: 'ghost', size: 'sm', iconRight: 'chevron-down', menu: 'guide-rw', data: { id: w.id + ':' + s.id }, disabled: !!u.busy })}</div>` : '';
      const body = u.busy === s.id ? `<div class="stack gap-8" aria-busy="true"><span class="skeleton skeleton--line" style="width:92%"></span><span class="skeleton skeleton--line" style="width:85%"></span><span class="skeleton skeleton--line" style="width:60%"></span></div>` : X.work.cites(s.html, s.cites);
      return `<section class="guide-sec" aria-labelledby="gs-${s.id}"><div class="guide-sec__head"><h2 class="guide-sec__title" id="gs-${s.id}">${esc(s.title)}</h2>${s.mode ? chip(s.mode === 'short' ? 'Shorter' : 'Simpler', { size: 'sm' }) : ''}<span class="grow"></span>${acts}</div><div class="guide-sec__body">${body}</div></section>`;
    }).join('')}</article>`;
  }
  MENUS['guide-rw'] = el => {
    const [id, s] = el.dataset.id.split(':');
    return [{ label: 'Shorter', icon: 'sliders', run: () => rewrite(id, s, 'short') }, { label: 'Simpler', icon: 'lightbulb', run: () => rewrite(id, s, 'simple') }];
  };
  A['guide-rewrite'] = el => rewrite(el.dataset.id, el.dataset.s, el.dataset.mode);
  async function rewrite(id, sid, mode) {
    const w = X.work.byId(id), sec = w?.data.sections.find(s => s.id === sid); if (!sec || !X.work.canEdit(w)) return;
    const key = sec.key || KEY_BY_TITLE[sec.title]; if (!key) return;
    const u = gb(w); u.busy = sec.id; refresh();
    await sleep(800);
    const opts = { v: mode === 'regen' ? (sec.v || 0) + 1 : sec.v || 0, mode: mode === 'regen' ? null : mode, depth: w.data.depth || 'full', from: w.options?.from };
    const nu = buildSection(key, banksFor(w.sources), opts);
    u.busy = null;
    if (!nu) { refresh(); toast('Couldn’t rewrite this section from these materials.', { tone: 'danger' }); return; }
    const prev = { html: sec.html, cites: sec.cites, v: sec.v, mode: sec.mode, key: sec.key };
    Object.assign(sec, { html: nu.html, cites: nu.cites, v: opts.v, mode: opts.mode, key });
    X.work.save(w); refresh();
    toast(mode === 'regen' ? 'Section regenerated' : mode === 'short' ? 'Made shorter' : 'Made simpler', { action: { label: 'Undo', run: () => { Object.assign(sec, prev); X.work.save(w); refresh(); } } });
  }
  function guideActions(w, ctx) {
    const flows = workflowsFor(ctx.sp).map(f => f.id);
    const wf = flows.includes('practice-quiz') ? ['practice-quiz', 'Practice quiz from this'] : flows.includes('quiz') && ctx.isStaff ? ['quiz', 'Make a quiz from this'] : null;
    return (wf ? btn(wf[1], { icon: 'target', act: 'work-start', data: { workflow: wf[0], space: w.space || '', docs: w.sources.join(',') } }) : '')
      + iconBtn('download', 'Download', { menu: 'work-dl', data: { id: w.id }, muted: false });
  }
  const sup = (html, cs) => String(html).replace(/\[(\d+)\]/g, (m, n) => (cs[n - 1] ? `<sup>[${n}]</sup>` : ''));
  const guideHtml = w => (w.data.sections || []).map(s => `<h2>${esc(s.title)}</h2>${sup(s.html, s.cites || [])}${s.cites?.length ? `<p><small>${s.cites.map((c, i) => `[${i + 1}] ${esc(docById(c.doc)?.name || '')}, page ${c.page} — “${esc(c.quote)}”`).join('<br>')}</small></p>` : ''}`).join('');
  const toText = html => String(html).replace(/<li>/g, '\n• ').replace(/<\/(p|h\d|ul|ol)>/g, '\n').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  const guideLines = w => (w.data.sections || []).flatMap(s => [s.title.toUpperCase(), ...toText(s.html.replace(/\s*\[(\d+)\]/g, ' [$1]')).split('\n').map(l => l.trim()).filter(Boolean), '']);

  WORK_KINDS.guide = {
    label: 'Study guide', icon: 'book', noun: 'study guide',
    options: guideOptions, title: guideTitle, generate: generateGuide, render: renderGuide, actions: guideActions,
    summary: w => `${plural(w.data?.sections?.length || 0, 'section')}${w.data?.depth === 'quick' ? ' · quick summary' : ''}`,
    exportHtml: guideHtml, exportLines: guideLines, headerDownload: true,
  };
})();
