/* Curation (/documents) — Manage → Documents: the reviewer's single home for
   curation and publication. Tabs: Review (queue + decision), All documents
   (every lifecycle state, publishing problems), Quality and Topics (bodies
   from governance.js: X.gov.quality / X.gov.topics).
   Scope: documents in the knowledge bases the caller owns (workspace admins
   own all) — curatedDocs(). Readers never see any of this.
   Exports: X.docsBadge(), X.reviewNotices(). Actions: cur-*. Menu: cur-row.
   Drawers: cur-doc, cur-compare. Modal: cur-decide. Model: core/lifecycle.js. */
(() => {
  'use strict';

  const BASE = '/documents';
  const TABS = ['review', 'all', 'quality', 'topics'];
  /** Old Knowledge health tabs: details/duplicates are Quality segments now. */
  const LEGACY_SEG = { details: 'details', duplicates: 'duplicates' };
  const QK = 'curQ', AK = 'curAll', PER = 25;
  const names = list => (list.length <= 2 ? list.join(' and ') : `${list.slice(0, 2).join(', ')} and ${plural(list.length - 2, 'other')}`);
  const relLow = ts => rel(ts).replace(/^(Just now|Yesterday)$/, m => m.toLowerCase());
  const lifeKey = d => lifecycleOf(d).key;
  const isLocked = d => /password/i.test(d.error || '');
  const analyzing = d => d.ai?.status === 'analyzing';
  const flagsOf = d => aiOf(d).flags || [];
  const hasFlag = (d, type) => flagsOf(d).some(f => f.type === type);
  const srcKey = d => (d.source && d.source !== 'upload' ? d.source : 'upload');
  const drafts = () => ui('curDraft');
  const accepted = () => ui('curAccepted');

  function tabOf(query) {
    if (LEGACY_SEG[query.tab]) return 'quality';
    if (TABS.includes(query.tab)) return query.tab;
    return reviewQueue().length ? 'review' : 'all';
  }
  const onReview = () => S.cur?.r.page === 'documentsAdmin' && tabOf(S.cur.query) === 'review';

  /* ═══════════════ Badges and inbox ═══════════════ */
  X.docsBadge = () => (can('knowledge.manage') ? reviewQueue().length + curatedDocs().filter(d => lifeKey(d) === 'failed').length : 0);
  X.reviewNotices = () => {
    if (!can('knowledge.manage') || !canReview()) return [];
    const out = [], q = reviewQueue();
    if (q.length) out.push({ id: 'cur-queue-' + q.length, icon: 'clock', tone: 'info', title: `${plural(q.length, 'document')} ${q.length === 1 ? 'is' : 'are'} waiting for your review`, body: names(q.map(d => d.name)), at: Math.max(...q.map(d => lastEvent(d).at)), to: BASE + '?tab=review', cta: 'Review' });
    // Workspace admins already get one notice per base with failed publishes.
    if (!isAdmin()) reviewableKbs().forEach(kb => {
      const failed = curatedDocs().filter(d => d.kb === kb.id && lifeKey(d) === 'failed');
      if (failed.length) out.push({ id: `cur-failed-${kb.id}-${failed.length}`, icon: 'alert-circle', tone: 'warn', title: `${plural(failed.length, 'document')} in ${kb.name} couldn’t be published`, body: failed.map(d => d.name).join(', '), at: Math.max(...failed.map(d => d.updated)), to: `${BASE}?tab=all&life=attention&kb=${kb.id}` });
    });
    return out;
  };

  /* ═══════════════ Page ═══════════════ */
  P.documentsAdmin = ({ query }) => {
    crumbs([{ label: 'Documents' }]);
    const tab = tabOf(query), queue = reviewQueue();
    const q = tab === 'quality' && LEGACY_SEG[query.tab] ? { ...query, tab: 'quality', seg: query.seg || LEGACY_SEG[query.tab] } : query;
    const upKb = S.ui[AK]?.kb, upload = canContribute() ? btn('Upload', { v: 'primary', icon: 'upload', act: 'contribute', data: upKb ? { kb: upKb } : undefined }) : '';
    const head = pageHeader({ title: 'Documents', extra: X.res.demoChip(), desc: 'Every document in the bases you look after, from submission to publication.', actions: upload });
    const proposals = X.gov?.proposalCount?.() || 0;
    const tabList = [
      { id: 'review', label: 'Review', count: queue.length || '', alert: true },
      { id: 'all', label: 'All documents' },
      { id: 'quality', label: 'Quality' },
      { id: 'topics', label: 'Topics', count: proposals || '' },
    ];
    const body = tab === 'review' ? reviewTab(query)
      : tab === 'all' ? allTab(query)
        : (tab === 'quality' ? X.gov?.quality?.({ query: q }) : X.gov?.topics?.({ query: q })) ?? skelRows(6);
    return `<div class="page cur">${head}<div class="page-tabs">${tabs(tabList, tab, BASE)}</div>${body}</div>`;
  };
  const prevAfter = AFTER.documentsAdmin;
  AFTER.documentsAdmin = args => {
    prevAfter?.(args);
    const { query } = args;
    // /knowledge-health?tab=details|duplicates → /documents?tab=quality&seg=…
    if (LEGACY_SEG[query.tab]) {
      const q = { ...query, tab: 'quality', seg: query.seg || LEGACY_SEG[query.tab] };
      history.replaceState(null, '', '#' + BASE + '?' + new URLSearchParams(q));
      S.cur.query = q;
    }
  };

  /* ═══════════════ Review ═══════════════ */
  const FILTERS = [['all', 'All'], ['flagged', 'Flagged'], ['version', 'New versions'], ['sync', 'From sources']];
  const FILTER_FN = {
    all: () => true,
    flagged: d => flagsOf(d).length > 0,
    version: d => !!d.submission?.versionOf,
    sync: d => d.submission?.via === 'sync',
  };
  function queueRows() {
    const u = ui(QK, { q: '', f: 'all', kb: '', sel: {} }), all = reviewQueue();
    const fn = FILTER_FN[u.f] || FILTER_FN.all;
    const rows = all.filter(d => fn(d) && (!u.kb || d.kb === u.kb) && matchesQ(QK, d.name, contributorName(d), kbById(d.kb)?.name, d.submission?.note));
    return { all, rows };
  }
  /** The open item: ?sel when it's in the list, else the first. */
  function currentId(rows) { const s = S.cur?.query.sel; return rows.some(d => d.id === s) ? s : rows[0]?.id || ''; }

  /** The reviewer's working copy of the assistant's suggestion (reset when the document is analyzed again). */
  function draftOf(d) {
    const ai = aiOf(d); if (ai.status !== 'done') return null;
    let f = drafts()[d.id];
    if (!f || f.at !== ai.at) f = drafts()[d.id] = { at: ai.at, kind: ai.kind.value, topics: ai.topics.map(t => t.id), kb: d.kb, summary: ai.summary || '', asVersionOf: '' };
    return f;
  }
  const decisionOf = d => { const f = draftOf(d); return f ? { kind: f.kind, topics: [...f.topics], kb: f.kb, summary: f.summary.trim(), asVersionOf: f.asVersionOf || undefined } : {}; };

  function confBadge(c, edited) {
    if (edited) return '<span class="cur-conf cur-conf--edited">Edited</span>';
    if (c == null) return '';
    const p = Math.round(c * 100);
    return `<span class="cur-conf cur-conf--${p >= 80 ? 'hi' : p >= 60 ? 'mid' : 'lo'}" data-tip="Assistant confidence">${p}%</span>`;
  }
  const FLAG_META = { duplicate: ['copy', 'Possible duplicate', 'warning'], version: ['history', 'New version', 'accent'], personal: ['shield', 'May contain personal data', 'danger'], format: ['file', 'Can’t be searched', 'default'] };
  function flagIcons(d) {
    const ai = aiOf(d);
    const out = (ai.flags || []).map(x => { const [icon, tip, tone] = FLAG_META[x.type] || FLAG_META.format; return `<span class="cur-flag cur-flag--${tone}" data-tip="${esc(tip)}" role="img" aria-label="${esc(tip)}">${ic(icon, 'i-xs')}</span>`; });
    if ((ai.proposed || []).some(id => proposalById(id)?.status === 'open')) out.push(`<span class="cur-flag cur-flag--accent" data-tip="Suggests a new topic" role="img" aria-label="Suggests a new topic">${ic('tag', 'i-xs')}</span>`);
    return out.join('');
  }
  function queueItem(d, active) {
    const u = ui(QK), via = d.submission?.via === 'sync';
    const who = `${via ? appIcon(res(d).source.app, 'sm') : ''}<span class="truncate">${esc(contributorName(d))} · ${esc(relLow(lastEvent(d).at))}</span>`;
    return `<div class="${cx('cur-item', active && 'is-active')}" role="button" tabindex="0" data-act="cur-pick" data-id="${d.id}" ${active ? 'aria-current="true"' : ''}>
      <span class="cur-item__check">${checkbox({ checked: !!u.sel?.[d.id], act: 'sel-toggle', data: { ui: QK, id: d.id }, aria: 'Select ' + d.name })}</span>
      ${fileIcon(d.type)}
      <span class="cur-item__body">
        <span class="cur-item__title truncate" title="${esc(d.name)}">${esc(d.name)}</span>
        <span class="cur-item__meta">${who}</span>
        <span class="cur-item__meta"><span class="truncate">${esc(kbById(d.kb)?.name || '')}</span><span class="cur-item__flags">${analyzing(d) ? lifeChip(d, 'sm') : flagIcons(d)}</span></span>
      </span>
    </div>`;
  }
  function queuePanel(all, rows, cur) {
    const u = ui(QK), f = u.f || 'all';
    const chips = FILTERS.map(([k, l]) => `<button type="button" class="cur-fchip" aria-pressed="${f === k}" data-act="cur-filter" data-value="${k}">${esc(l)}<span class="cur-fchip__n num">${all.filter(FILTER_FN[k]).length}</span></button>`).join('');
    const kbs = [...new Set(all.map(d => d.kb))].map(kbById).filter(Boolean);
    const ids = rows.map(d => d.id), n = ids.filter(id => u.sel?.[id]).length;
    const selRow = `<div class="cur-queue__sel">${checkbox({ checked: !!n && n === ids.length, indeterminate: !!n && n < ids.length, act: 'sel-all', data: { ui: QK, ids: ids.join(',') }, aria: 'Select all', label: n ? `<span class="medium">${n} selected</span>` : `<span class="muted">${plural(rows.length, 'submission')}</span>` })}<span class="grow"></span>${n
      ? btn('Decline…', { v: 'ghost', size: 'sm', act: 'cur-bulk-decline' }) + btn('Approve & publish', { v: 'secondary', size: 'sm', icon: 'check', act: 'cur-bulk-approve' })
      : `<span class="t-xs muted cur-keys">${kbd('J')}${kbd('K')} to move</span>`}</div>`;
    const list = rows.length ? `<div class="cur-queue__list" id="cur-queue" data-keep-scroll role="list">${rows.map(d => queueItem(d, d.id === cur)).join('')}</div>` : `<div class="cur-queue__none">${noMatches(QK, ['f', 'kb'], 'submissions')}</div>`;
    return `<div class="cur-queue">
      <div class="cur-queue__tools">${searchField({ uiKey: QK, placeholder: 'Search submissions' })}
        <div class="cur-fchips" role="group" aria-label="Show">${chips}</div>
        ${kbs.length > 1 ? `<div class="row gap-6">${filterButton('Knowledge base', QK, 'kb', kbs.map(k => [k.id, k.name]))}</div>` : ''}
      </div>${selRow}${list}</div>`;
  }

  /* ── Detail ── */
  function noteHtml(d) {
    const sub = d.submission || {}, last = lastEvent(d);
    const note = last.kind === 'resubmitted' && last.text ? last.text : sub.note;
    const asked = [...(sub.events || [])].reverse().find(e => e.kind === 'changes');
    return (note ? `<figure class="cur-note"><figcaption class="t-label">Note to reviewers</figcaption><blockquote>${esc(note)}</blockquote></figure>` : '')
      + (last.kind === 'resubmitted' && asked ? `<div class="cur-asked">${ic('pencil', 'i-xs')}<span>Resubmitted after ${esc(actorName(asked.by))} asked: “${esc(asked.text)}”</span></div>` : '');
  }
  function flagsHtml(d, f) {
    const out = flagsOf(d).map(x => {
      const o = x.doc && docById(x.doc), seen = o && canSeeDoc(o);
      if (x.type === 'duplicate') {
        if (!seen) return alertBox('warning', 'Possible duplicate', 'It looks like a document you can’t open. Check with a workspace admin.');
        const on = f?.asVersionOf === o.id;
        return `<div class="cur-flagbox">${alertBox('warning', 'Possible duplicate', `Looks like “${esc(o.name)}” (${Math.round((x.sim || 0) * 100)}% similar title).`, btn('Compare', { v: 'secondary', size: 'sm', icon: 'git-compare', act: 'cur-compare', data: { id: d.id, other: o.id } }))}
          ${f ? switchRow({ title: `Publish as a new version of “${o.name}”`, desc: on ? `It becomes v${res(o).version + 1}. The current version stays published until you approve.` : 'Off: it’s published as a separate document.', on, act: 'cur-asver', data: { id: d.id, other: o.id } }) : ''}</div>`;
      }
      if (x.type === 'version') return seen ? alertBox('accent', `Replaces v${res(o).version} of “${o.name}”`, 'The current version stays published until you approve.', btn('Open current', { v: 'ghost', size: 'sm', href: '/doc/' + o.id }), { icon: 'history' }) : '';
      if (x.type === 'personal') return alertBox('warning', 'May contain personal data', 'Names, grades or ID numbers shouldn’t be shared. Check before publishing.', '', { icon: 'shield' });
      if (x.type === 'format') return alertBox('default', 'Can’t be searched', esc(x.text));
      return '';
    }).filter(Boolean);
    return out.length ? `<div class="cur-flags">${out.join('')}</div>` : '';
  }
  function previewCard(d) {
    const fmt = hasFlag(d, 'format');
    let canvas;
    if (fmt) canvas = emptyState({ icon: 'file', title: 'No preview for this file type', desc: 'Download it to check the content.', actions: btn('Download', { size: 'sm', icon: 'download', act: 'doc-dl', data: { id: d.id } }), compact: true });
    else { const p = X.docModel?.(d)?.pages?.[0]; canvas = p ? `<div class="cur-preview__canvas" id="cur-preview-${d.id}" data-keep-scroll tabindex="0" aria-label="First page"><div class="${cx('doc-page', p.cls)}">${p.html}</div></div>` : emptyState({ icon: 'file', title: 'No preview yet', compact: true }); }
    const pages = Math.max(1, d.pages || 1);
    return card(canvas, { title: 'Preview', desc: fmt ? '' : `Page 1 of ${pages}`, cls: 'cur-preview', actions: fmt ? '' : btn('Open full preview', { v: 'ghost', size: 'sm', icon: 'external', href: '/doc/' + d.id }) });
  }
  const sugRow = (label, badge, control, foot = '') => `<div class="cur-sug"><div class="cur-sug__label"><span class="t-label">${esc(label)}</span>${badge}</div><div class="cur-sug__ctl">${control}${foot}</div></div>`;
  function suggestionsCard(d, f) {
    const ai = aiOf(d);
    if (!f) return card(`<div class="cur-analyzing">${spinner()}<span>Reading the file and suggesting a type, topics and a knowledge base…</span></div>`, { title: 'Assistant suggestions', cls: 'cur-sugs' });
    const kinds = Object.entries(RESOURCE_KINDS).map(([id, k]) => [id, k.label]);
    const type = sugRow('Type', confBadge(ai.kind.conf, f.kind !== ai.kind.value), select({ id: 'cur-kind', bind: `curDraft.${d.id}.kind`, value: f.kind, options: kinds, change: 'cur-redraw', size: 'sm', label: 'Type' }));
    // Topics: suggestions toggle on/off; reviewers may add any existing topic.
    const sugg = ai.topics, extra = f.topics.filter(id => !sugg.some(t => t.id === id));
    const tchip = (id, on, badge) => `<button type="button" class="cur-topic" aria-pressed="${on}" data-act="cur-topic" data-id="${d.id}" data-topic="${id}">${ic(on ? 'check' : 'plus', 'i-xs')}<span>${esc(topicName(id))}</span>${badge}</button>`;
    const chipsHtml = [...sugg.map(t => tchip(t.id, f.topics.includes(t.id), t.accepted ? '<span class="cur-conf cur-conf--new">New</span>' : confBadge(t.conf))), ...extra.map(id => tchip(id, true, '<span class="cur-conf cur-conf--edited">Added</span>'))].join('');
    const addOpts = [['', 'Add topic…'], ...topicTree().flatMap(dm => dm.children.filter(t => !f.topics.includes(t.id)).map(t => [t.id, `${dm.name} · ${t.name}`]))];
    const topics = sugRow('Topics', '', `<div class="cur-topics">${chipsHtml || '<span class="t-sm muted">No topic suggested</span>'}${addOpts.length > 1 ? select({ id: 'cur-add-topic', value: '', options: addOpts, change: 'cur-topic-add', size: 'sm', cls: 'cur-add-topic', label: 'Add topic', attrs: `data-id="${d.id}"` }) : ''}</div>`);
    // Proposed new topics: only workspace admins change the taxonomy.
    const props = (ai.proposed || []).map(proposalById).filter(p => p && p.status === 'open');
    const admin = canManageTaxonomy();
    const proposed = props.length ? sugRow('Proposed new topics', '', props.map(p => `<div class="cur-prop">${itemIcon('sparkles', 'accent', 'sm')}<div class="grow"><div class="medium">${esc(p.name)}</div><div class="t-xs muted">${p.parent ? `In ${esc(topicName(p.parent))}` : 'A new domain'} · suggested for ${plural(p.docs.length, 'document')}</div></div>${admin
      ? `<div class="row gap-4 none">${btn('Dismiss', { v: 'ghost', size: 'sm', act: 'cur-prop-dismiss', data: { id: p.id } })}${btn('Accept topic', { v: 'secondary', size: 'sm', icon: 'check', act: 'cur-prop-accept', data: { id: p.id, doc: d.id } })}</div>`
      : `<span class="t-xs muted none cur-prop__wait">${ic('clock', 'i-xs')}Waiting for a workspace admin</span>`}</div>`).join('') + (admin ? '' : '<p class="t-xs muted mt-4">You can publish without it. It’s added once an admin accepts it.</p>')) : '';
    // Knowledge base: where it lives decides who can see it.
    const version = !!(f.asVersionOf || d.submission?.versionOf);
    const kbs = reviewableKbs().filter(k => k.contribute !== false || k.id === d.kb);
    const target = kbById(version ? docById(f.asVersionOf || d.submission.versionOf)?.kb : f.kb) || kbById(d.kb), who = X.whoCanSee(target);
    const kbBadge = version ? '' : ai.kb.by === 'ai' ? confBadge(ai.kb.conf, f.kb !== ai.kb.id) : f.kb !== d.kb ? confBadge(null, true) : '<span class="t-xs muted">Chosen by the contributor</span>';
    const kbCtl = version ? `<div class="cur-fixed">${X.kbMark(target, 20)}<span class="truncate">${esc(target.name)}</span></div>` : select({ id: 'cur-kb', bind: `curDraft.${d.id}.kb`, value: f.kb, options: kbs.map(k => [k.id, k.name]), change: 'cur-redraw', size: 'sm', label: 'Knowledge base' });
    const kb = sugRow('Knowledge base', kbBadge, kbCtl, `<div class="cur-who">${ic(who.icon, 'i-xs')}<span>${version ? 'Same as the current version · ' : ''}${esc(who.label)} will see it</span></div>`);
    const summary = sugRow('Summary', confBadge(null, f.summary.trim() !== (ai.summary || '').trim()), textarea({ id: 'cur-sum-' + d.id, bind: `curDraft.${d.id}.summary`, value: f.summary, rows: 3, attrs: 'maxlength="280" aria-label="Summary"' }));
    return card(`<div class="cur-sug-list">${type}${topics}${proposed}${kb}${summary}</div>`, { title: 'Assistant suggestions', desc: 'Check and edit before you publish.', cls: 'cur-sugs' });
  }
  function decisionBar(d, f) {
    const v = f && (f.asVersionOf || d.submission?.versionOf), o = v && docById(v);
    const hint = !f ? 'Waiting for the assistant…' : o ? `Publishes v${res(o).version + 1} of “${o.name}”` : `Publishes to ${kbById(f.kb)?.name || ''}`;
    return `<div class="cur-decide" role="group" aria-label="Decision">
      <span class="cur-decide__hint truncate">${esc(hint)}</span>
      ${btn('Request changes', { act: 'cur-changes', data: { id: d.id } })}${btn('Decline', { act: 'cur-decline', data: { id: d.id } })}
      ${btn(f ? 'Approve & publish' : 'Analyzing…', { v: 'primary', icon: f ? 'check' : '', act: 'cur-approve', data: { id: d.id }, disabled: !f, loading: !f })}
    </div>`;
  }
  function detailPanel(d, pos, total) {
    const sub = d.submission || {}, kb = kbById(d.kb), f = draftOf(d), via = sub.via === 'sync';
    const resub = lastEvent(d).kind === 'resubmitted';
    const meta = [
      `${via ? 'Synced from' : 'From'} <span class="medium">${esc(contributorName(d))}</span>`,
      `${resub ? 'Resubmitted' : 'Submitted'} ${esc(relLow(lastEvent(d).at))}`,
      `to <a class="link" href="#/knowledge/${kb.id}">${esc(kb.name)}</a>`,
    ].join('<span aria-hidden="true"> · </span>');
    const head = `<div class="cur-detail__head">
      ${iconBtn('arrow-left', 'Back to the queue', { act: 'cur-back', cls: 'cur-back' })}
      ${fileIcon(d.type, 'lg')}
      <div class="grow"><h2 class="cur-detail__title">${esc(d.name)}</h2><div class="cur-detail__meta">${meta}${analyzing(d) ? lifeChip(d, 'sm') : ''}</div></div>
      <div class="cur-detail__nav"><span class="t-xs muted num">${pos + 1} of ${total}</span>${iconBtn('chevron-up', 'Previous (K)', { size: 'sm', act: 'cur-step', data: { dir: -1 }, disabled: pos <= 0 })}${iconBtn('chevron-down', 'Next (J)', { size: 'sm', act: 'cur-step', data: { dir: 1 }, disabled: pos >= total - 1 })}</div>
    </div>`;
    return `<section class="cur-detail" id="cur-detail" aria-label="${esc(d.name)}">${head}${noteHtml(d)}${flagsHtml(d, f)}${previewCard(d)}${suggestionsCard(d, f)}${decisionBar(d, f)}</section>`;
  }
  function reviewTab(query) {
    const caughtUp = () => emptyState({ icon: 'check-circle', tone: 'success', title: 'You’re all caught up', desc: 'New submissions to your knowledge bases show up here.', actions: btn('See all documents', { href: BASE + '?tab=all' }), boxed: true });
    return gate({
      loading: () => `<div class="cur-split"><div class="cur-queue">${skelRows(6)}</div><div class="cur-detail">${skelRows(3)}</div></div>`,
      empty: caughtUp,
      ok: () => {
        // ?kb= (from a knowledge base page) preselects the base filter.
        const qu = ui(QK, { q: '', f: 'all', kb: '', sel: {} }), qkb = query.kb || '';
        if (qu._kb !== qkb) { qu._kb = qkb; qu.kb = qkb; }
        const { all, rows } = queueRows();
        if (!all.length) return caughtUp();
        const u = ui(QK), live = new Set(all.map(d => d.id));
        u.sel = Object.fromEntries(Object.entries(u.sel || {}).filter(([id, on]) => on && live.has(id)));
        const cur = currentId(rows), d = docById(cur), pos = rows.findIndex(x => x.id === cur);
        const open = !!query.sel && cur === query.sel;
        return `<div class="${cx('cur-split', open && 'has-sel')}">${queuePanel(all, rows, cur)}${d ? detailPanel(d, pos, rows.length) : '<div class="cur-detail"></div>'}</div>`;
      },
    });
  }

  /* ── Review actions ── */
  /** Scroll the detail's top into view (after picking or deciding). */
  function showDetail() {
    const sc = $('#scroll'), el = $('#cur-detail'); if (!sc || !el) return;
    const r = el.getBoundingClientRect(), s = sc.getBoundingClientRect();
    if (r.top < s.top) sc.scrollTop += r.top - s.top - 16;
    $(`.cur-item[aria-current="true"]`)?.scrollIntoView({ block: 'nearest' });
  }
  function pick(id) { setQuery({ sel: id }); requestAnimationFrame(showDetail); }
  A['cur-pick'] = (el, e) => {
    // Enter on the open item opens the full preview.
    if (e?.type === 'keydown' && el.getAttribute('aria-current') === 'true') { go('/doc/' + el.dataset.id); return; }
    pick(el.dataset.id);
  };
  A['cur-back'] = () => setQuery({ sel: '' });
  function step(dir) {
    const { rows } = queueRows(); if (!rows.length) return;
    const i = rows.findIndex(d => d.id === currentId(rows)), n = rows[Math.min(rows.length - 1, Math.max(0, i + dir))];
    if (n && n.id !== rows[i]?.id) pick(n.id);
  }
  A['cur-step'] = el => step(+el.dataset.dir);
  A['cur-filter'] = el => { const u = ui(QK); u.f = el.dataset.value; refresh(); };
  A['cur-redraw'] = () => refresh();
  A['cur-topic'] = el => { const f = draftOf(docById(el.dataset.id)); if (!f) return; const t = el.dataset.topic; f.topics = f.topics.includes(t) ? f.topics.filter(x => x !== t) : [...f.topics, t]; refresh(); };
  A['cur-topic-add'] = el => { const f = draftOf(docById(el.dataset.id)); if (!f || !el.value) return; if (!f.topics.includes(el.value)) f.topics.push(el.value); refresh(); };
  A['cur-asver'] = el => { const f = draftOf(docById(el.dataset.id)); if (!f) return; f.asVersionOf = f.asVersionOf === el.dataset.other ? '' : el.dataset.other; refresh(); };

  /* Proposed topics (workspace admins). Accepting tags every document that suggested it. */
  function revertAccept(rec) {
    const p = proposalById(rec.pid); if (!p || p.status !== 'accepted') return;
    rec.created.forEach(id => { const i = D.topics.findIndex(t => t.id === id); if (i >= 0) D.topics.splice(i, 1); });
    p.status = 'open'; delete p.into; delete p.decided; delete p.by;
    (p.docs || []).map(docById).filter(Boolean).forEach(x => {
      if (Array.isArray(x.topics)) x.topics = x.topics.filter(id => id !== rec.topic);
      if (x.ai?.topics) { x.ai.topics = x.ai.topics.filter(t => t.id !== rec.topic); x.ai.proposed = [...new Set([...(x.ai.proposed || []), p.id])]; }
      const f = drafts()[x.id]; if (f) f.topics = f.topics.filter(id => id !== rec.topic);
    });
  }
  A['cur-prop-accept'] = el => {
    const p = proposalById(el.dataset.id), docId = el.dataset.doc; if (!p || !canManageTaxonomy()) return;
    const before = new Set(D.topics.map(t => t.id)), t = acceptProposal(p); if (!t) return;
    const rec = { pid: p.id, topic: t.id, created: D.topics.filter(x => !before.has(x.id)).map(x => x.id) };
    (accepted()[docId] ??= []).push(rec);
    (p.docs || []).forEach(id => { const f = drafts()[id]; if (f && !f.topics.includes(t.id)) f.topics.push(t.id); });
    refresh();
    toast(`Added “${t.name}” to the topics`, { action: { label: 'Undo', run: () => { revertAccept(rec); accepted()[docId] = (accepted()[docId] || []).filter(r => r !== rec); refresh(); toast(`“${p.name}” is a proposal again`, { tone: 'accent' }); } } });
  };
  A['cur-prop-dismiss'] = el => {
    const p = proposalById(el.dataset.id); if (!p || !canManageTaxonomy()) return;
    const prev = (p.docs || []).map(id => [docById(id), docById(id)?.ai?.proposed?.slice()]);
    dismissProposal(p); refresh();
    toast(`Dismissed “${p.name}”`, { action: { label: 'Undo', run: () => { p.status = 'open'; delete p.decided; delete p.by; prev.forEach(([x, pr]) => { if (x?.ai && pr) x.ai.proposed = pr; }); refresh(); } } });
  };

  /** Run a decision on queue items with Undo, then move on to the next item. */
  function decide(docs, run, msg) {
    const { rows } = queueRows(), ids = new Set(docs.map(d => d.id)), i = rows.findIndex(d => d.id === currentId(rows));
    const next = rows.slice(i + 1).find(d => !ids.has(d.id)) || rows.slice(0, Math.max(0, i)).reverse().find(d => !ids.has(d.id));
    const snaps = [];
    docs.forEach(d => {
      snaps.push([d, snapDoc(d)]);
      const o = docById(drafts()[d.id]?.asVersionOf || d.submission?.versionOf);
      if (o && !snaps.some(([x]) => x === o)) snaps.push([o, snapDoc(o)]);
    });
    run();
    const sel = ui(QK).sel || {}; docs.forEach(d => delete sel[d.id]);
    if (onReview()) { setQuery({ sel: next?.id || '' }); requestAnimationFrame(showDetail); } else refresh();
    toast(msg, { action: { label: 'Undo', run: () => undo(snaps, docs) } });
  }
  function undo(snaps, docs) {
    snaps.forEach(([d, s]) => restoreDoc(d, s));
    docs.forEach(d => { (accepted()[d.id] || []).forEach(revertAccept); delete accepted()[d.id]; });
    if (onReview()) setQuery({ sel: docs[0].id }); else refresh();
    toast(docs.length === 1 ? `“${docs[0].name}” is back in review` : `${plural(docs.length, 'document')} are back in review`, { tone: 'accent' });
  }
  const inQueue = id => { const d = docById(id); return d && stageOf(d) === 'review' && canReviewKb(kbById(d.kb)) ? d : null; };
  A['cur-approve'] = el => {
    const d = inQueue(el.dataset.id); if (!d || !draftOf(d)) return;
    const dec = decisionOf(d), o = docById(dec.asVersionOf || d.submission?.versionOf);
    const msg = o ? `Approved. “${o.name}” is publishing as v${res(o).version + 1}.` : `Approved “${d.name}”. Publishing to ${kbById(dec.kb || d.kb)?.name || 'its knowledge base'}.`;
    decide([d], () => approveAndPublish(d, dec), msg);
  };
  A['cur-bulk-approve'] = () => {
    const ids = Object.keys(ui(QK).sel || {}).filter(id => ui(QK).sel[id]);
    const docs = ids.map(inQueue).filter(Boolean);
    const personal = docs.filter(d => !analyzing(d) && hasFlag(d, 'personal')), busy = docs.filter(analyzing);
    const ok = docs.filter(d => !personal.includes(d) && !busy.includes(d));
    const skipped = [personal.length && `${personal.length} with personal data`, busy.length && `${busy.length} still being analyzed`].filter(Boolean).join(' and ');
    if (!ok.length) { toast(`Nothing published: ${skipped || 'select submissions first'}. Review ${personal.length + busy.length === 1 ? 'it' : 'them'} one by one.`, { tone: 'danger' }); return; }
    const decisions = new Map(ok.map(d => [d, decisionOf(d)]));
    decide(ok, () => ok.forEach(d => approveAndPublish(d, decisions.get(d))), `Approved ${plural(ok.length, 'document')}${skipped ? ` · skipped ${skipped}` : ''}`);
    // Keep the skipped ones selected so they're easy to find.
    ui(QK).sel = Object.fromEntries([...personal, ...busy].map(d => [d.id, true])); refresh();
  };

  /* Request changes / decline: a required message the contributor sees. */
  const QUICK = {
    changes: ['Please remove personal data (names, grades, ID numbers) and resubmit.', 'Please add a short note on what this covers and who it’s for.', 'Please upload the final version as a PDF.'],
    decline: ['This is already published. Use the existing document instead.', 'We can’t publish copyrighted material.', 'It contains personal data that can’t be shared.', 'It doesn’t belong in this knowledge base.'],
  };
  function openDecide(mode, ids) {
    const docs = ids.map(inQueue).filter(Boolean); if (!docs.length) return;
    S.ui.curDecide = { text: '', tried: false };
    openModal('cur-decide', { mode, ids: docs.map(d => d.id) });
  }
  A['cur-changes'] = el => openDecide('changes', [el.dataset.id]);
  A['cur-decline'] = el => openDecide('decline', [el.dataset.id]);
  A['cur-bulk-decline'] = () => openDecide('decline', Object.keys(ui(QK).sel || {}).filter(id => ui(QK).sel[id]));
  M['cur-decide'] = ({ mode, ids }) => {
    const f = ui('curDecide'), changes = mode === 'changes', n = ids.length, d = docById(ids[0]);
    const err = f.tried && !f.text.trim() ? (changes ? 'Tell the contributor what to change.' : 'Give a reason. The contributor sees it.') : '';
    const who = n > 1 ? 'Each contributor sees this message.' : d.submission?.by ? `${esc(contributorName(d))} sees this message.` : 'It’s kept with the document’s history.';
    return {
      size: 'md', title: changes ? 'Request changes' : n > 1 ? `Decline ${plural(n, 'submission')}` : 'Decline submission', desc: n === 1 ? esc(d.name) : '',
      body: field({ id: 'cur-msg', label: changes ? 'What should change?' : 'Reason', required: true, error: err, desc: who, control: textarea({ id: 'cur-msg', bind: 'curDecide.text', value: f.text, rows: 4, invalid: !!err, attrs: 'data-autofocus maxlength="600"' }) })
        + `<div class="mt-16"><div class="t-label mb-8">Quick replies</div><div class="cur-quick">${QUICK[mode].map(q => btn(q, { v: 'outline', size: 'sm', act: 'cur-quick', data: { text: q } })).join('')}</div></div>`,
      foot: btn('Cancel', { act: 'close-modal' }) + btn(changes ? 'Send request' : n > 1 ? `Decline ${n}` : 'Decline', { v: changes ? 'primary' : 'danger', act: 'cur-decide-go' }),
    };
  };
  A['cur-quick'] = el => { ui('curDecide').text = el.dataset.text; refreshLayer(); const t = $('#cur-msg'); if (t) { t.focus(); t.setSelectionRange(t.value.length, t.value.length); } };
  A['cur-decide-go'] = () => {
    const f = ui('curDecide'), { mode, ids } = S.modal.props; f.tried = true;
    const text = f.text.trim(); if (!text) { refreshLayer(); $('#cur-msg')?.focus(); return; }
    const docs = ids.map(inQueue).filter(Boolean); closeModal(); if (!docs.length) return;
    const one = docs.length === 1, d = docs[0];
    if (mode === 'changes') decide(docs, () => docs.forEach(x => requestChanges(x, text)), d.submission?.by ? `Asked ${contributorName(d)} for changes` : 'Changes requested');
    else decide(docs, () => docs.forEach(x => rejectSubmission(x, text)), one ? `Declined “${d.name}”` : `Declined ${plural(docs.length, 'submission')}`);
  };

  /* Keyboard: J/K or ↓/↑ move through the queue; Enter opens the full preview. */
  document.addEventListener('keydown', e => {
    if (!onReview() || S.modal || S.drawer || S.menu || S.palette || e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
    const t = e.target;
    if (t.closest?.('input,textarea,select,[contenteditable="true"]')) return;
    const k = e.key;
    if (k === 'j' || k === 'J' || k === 'ArrowDown') { e.preventDefault(); step(1); return; }
    if (k === 'k' || k === 'K' || k === 'ArrowUp') { e.preventDefault(); step(-1); return; }
    if (k === 'Enter' && !t.closest?.('button,a,[role="button"],label,[data-act]')) {
      const { rows } = queueRows(), id = currentId(rows); if (id) { e.preventDefault(); go('/doc/' + id); }
    }
  });

  /* ── Compare (possible duplicate) ── */
  A['cur-compare'] = el => openDrawer('cur-compare', { id: el.dataset.id, other: el.dataset.other });
  function excerpt(d) {
    const m = X.docModel?.(d), text = (m?.blocks?.length ? m.blocks.map(b => b.text).join(' ') : m?.text || '').replace(/\s+/g, ' ').trim();
    return text.length > 420 ? text.slice(0, 420).replace(/\s+\S*$/, '') + '…' : text;
  }
  function cmpCol(d, label) {
    const r = res(d), info = isPublishedStage(d) && stageOf(d) === 'published' ? X.res.details(d) : kv([
      ['Type', esc(kindMeta(aiOf(d).kind?.value || r.kind).label)],
      ['Knowledge base', esc(kbById(d.kb)?.name || '—')],
      ['Contributor', esc(contributorName(d))],
      ['Submitted', esc(fmtDateTime(d.submission?.at || d.updated))],
      ['Size', `${esc(fmtSize(d.size))} · ${plural(d.pages || 1, 'page')}`],
    ]);
    return `<div class="cur-cmp__col"><div class="t-label">${esc(label)}</div><div class="row gap-8">${fileIcon(d.type)}<span class="medium cur-cmp__name">${esc(d.name)}</span></div>
      <p class="cur-cmp__text">${esc(excerpt(d)) || '<span class="muted">No text to show.</span>'}</p>${info}</div>`;
  }
  DR['cur-compare'] = ({ id, other }) => {
    const d = docById(id), o = docById(other);
    if (!d || !o || !canSeeDoc(d) || !canSeeDoc(o)) return { title: 'Comparison not available', body: emptyState({ icon: 'git-compare', title: 'One of these documents isn’t available', desc: 'It may have been archived or decided already.' }) };
    const f = stageOf(d) === 'review' ? draftOf(d) : null, on = f?.asVersionOf === o.id;
    return {
      size: 'xl', title: 'Compare', desc: 'The submission and the published document it resembles.', lead: itemIcon('git-compare', 'warning'),
      body: `<div class="cur-cmp">${cmpCol(d, 'Submission')}${cmpCol(o, `Published · v${res(o).version}`)}</div>`,
      foot: f ? btn('Keep as separate documents', { act: 'cur-cmp-pick', data: { id: d.id, other: '' } }) + btn(on ? 'Publishing as a new version' : 'Publish as a new version', { v: 'primary', icon: on ? 'check' : 'history', act: 'cur-cmp-pick', data: { id: d.id, other: o.id } }) : btn('Close', { act: 'close-drawer' }),
    };
  };
  A['cur-cmp-pick'] = el => { const f = draftOf(docById(el.dataset.id)); if (f) f.asVersionOf = el.dataset.other; closeDrawer(); refresh(); };

  /* ═══════════════ All documents ═══════════════ */
  const SORTERS = { name: d => d.name.toLowerCase(), updated: d => d.updated };
  const LIFE_OF_GROUP = Object.fromEntries(LIFE_GROUPS.map(([k, , keys]) => [k, keys]));
  function syncFromQuery(u, query) {
    const qs = JSON.stringify([query.life, query.kb, query.src, query.q]);
    if (u._qs === qs) return;
    Object.assign(u, { _qs: qs, life: query.life || '', kb: query.kb || '', src: query.src || '', q: query.q || '', kind: '', page: 1, sel: {} });
  }
  function allRows(u) {
    const docs = curatedDocs();
    const rows = docs.filter(d => (!u.life || LIFE_OF_GROUP[u.life]?.includes(lifeKey(d))) && (!u.kb || d.kb === u.kb) && (!u.src || srcKey(d) === u.src) && (!u.kind || res(d).kind === u.kind)
      && matchesQ(AK, d.name, contributorName(d), kbById(d.kb)?.name));
    return { docs, rows: applySort(rows, AK, SORTERS) };
  }
  function allRow(d) {
    const on = !!ui(AK).sel?.[d.id];
    return `<tr class="table__row" data-act="cur-doc" data-id="${d.id}" tabindex="0" ${on ? 'aria-selected="true"' : ''}>
      ${selCheck(AK, d.id, 'Select ' + d.name)}
      <td class="table__cell table__cell--primary"><div class="row gap-12">${fileIcon(d.type)}<div class="grow"><div class="cell-title truncate" title="${esc(d.name)}">${esc(d.name)}</div><div class="cell-sub truncate">${esc(kbById(d.kb)?.name || '')}</div></div></div></td>
      <td class="table__cell">${lifeChip(d, 'sm')}</td>
      <td class="table__cell table__cell--hide-sm"><span class="row gap-6">${appIcon(res(d).source.app, 'sm')}<span class="truncate">${esc(contributorName(d))}</span></span></td>
      <td class="table__cell table__cell--hide-sm muted">${esc(kindMeta(res(d).kind).label)}</td>
      <td class="table__cell muted cur-nowrap" title="${esc(fmtDateTime(d.updated))}">${rel(d.updated)}</td>
      <td class="table__cell table__cell--actions">${iconBtn('more', 'More actions', { size: 'sm', menu: 'cur-row', data: { id: d.id } })}</td></tr>`;
  }
  function failuresAlert(docs, u) {
    const failed = docs.filter(d => lifeKey(d) === 'failed'); if (!failed.length) return '';
    const locked = failed.filter(isLocked), retry = failed.length - locked.length;
    const desc = locked.length ? `${locked.length === failed.length ? (failed.length === 1 ? 'The file is' : 'The files are') : `${locked.length} ${locked.length === 1 ? 'file is' : 'files are'}`} password-protected and ${locked.length === 1 ? 'needs' : 'need'} a copy without a password.` : 'Publishing stopped partway. Try again.';
    const actions = (u.life !== 'attention' ? btn('Show', { v: 'ghost', size: 'sm', act: 'cur-show-failed' }) : '')
      + (retry ? btn('Retry all', { v: 'secondary', size: 'sm', icon: 'retry', act: 'cur-retry-all' }) : locked.length === 1 ? btn('Replace file', { v: 'secondary', size: 'sm', icon: 'upload', act: 'doc-replace', data: { id: locked[0].id } }) : '');
    return `<div class="mb-12">${alertBox('danger', `${plural(failed.length, 'document')} couldn’t be published`, desc, actions)}</div>`;
  }
  function allTab(query) {
    const u = ui(AK, { q: '', life: '', kb: '', src: '', kind: '', sort: { key: 'updated', dir: 'desc' }, page: 1, sel: {} });
    syncFromQuery(u, query);
    const empty = () => emptyState({ icon: 'files', title: 'No documents yet', desc: 'Documents added to the knowledge bases you look after show up here.', actions: canContribute() ? btn('Upload', { v: 'primary', icon: 'upload', act: 'contribute' }) : '', boxed: true });
    return gate({
      loading: () => skelRows(8),
      empty,
      ok: () => {
        const { docs, rows } = allRows(u);
        if (!docs.length) return empty();
        const live = new Set(docs.map(d => d.id));
        u.sel = Object.fromEntries(Object.entries(u.sel || {}).filter(([id, on]) => on && live.has(id)));
        const kbs = [...new Set(docs.map(d => d.kb))].map(kbById).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
        const srcs = [...new Set(docs.map(srcKey))].filter(k => k !== 'upload').map(srcById).filter(Boolean);
        const kinds = [...new Set(docs.map(d => res(d).kind))].map(k => [k, kindMeta(k).label]).sort((a, b) => a[1].localeCompare(b[1]));
        const sortLabel = u.sort?.key === 'name' ? 'Name' : 'Recently updated';
        const toolbar = `<div class="toolbar">${searchField({ uiKey: AK, placeholder: 'Search documents' })}
          ${filterButton('Lifecycle', AK, 'life', LIFE_GROUPS.map(([k, l]) => [k, l]))}
          ${kbs.length > 1 ? filterButton('Knowledge base', AK, 'kb', kbs.map(k => [k.id, k.name])) : ''}
          ${srcs.length ? filterButton('Source', AK, 'src', [['upload', 'Uploads'], ...srcs.map(s => [s.id, s.name])]) : ''}
          ${filterButton('Type', AK, 'kind', kinds)}${clearFilters(AK, ['life', 'kb', 'src', 'kind'])}
          <div class="toolbar__end">${btn(sortLabel, { v: 'ghost', size: 'sm', icon: 'sort', menu: 'cur-sort', aria: `aria-label="Sort: ${esc(sortLabel)}"` })}</div></div>`;
        const alert = failuresAlert(docs, u);
        if (!rows.length) return toolbar + alert + noMatches(AK, ['life', 'kb', 'src', 'kind'], 'documents');
        const page = paginate(rows, AK, PER);
        const bulk = bulkBar(AK, btn('Publish', { v: 'ghost', size: 'sm', icon: 'upload', act: 'cur-bulk-publish' }) + btn('Unpublish', { v: 'ghost', size: 'sm', icon: 'eye-off', act: 'cur-bulk-unpublish' }) + btn('Archive', { v: 'ghost', size: 'sm', icon: 'archive', act: 'cur-bulk-archive' }));
        const head = `${selAllCheck(AK, page.map(d => d.id))}${sortHead('Name', 'name', AK)}${th('Lifecycle')}${th('Contributor / source', 'table__column--hide-sm')}${th('Type', 'table__column--hide-sm')}${sortHead('Updated', 'updated', AK)}${th('<span class="sr-only">Actions</span>', 'table__column--actions')}`;
        return toolbar + alert + `<div class="cur-all">${table({ label: 'Documents', head, rows: page.map(allRow), foot: pager(rows.length, AK, PER) })}</div>` + bulk;
      },
    });
  }
  MENUS['cur-sort'] = () => {
    const u = ui(AK), set = (key, dir) => { u.sort = { key, dir }; u.page = 1; refresh(); };
    return [{ section: 'Sort by' }, { label: 'Recently updated', checked: u.sort?.key !== 'name', run: () => set('updated', 'desc') }, { label: 'Name', checked: u.sort?.key === 'name', run: () => set('name', 'asc') }];
  };
  A['cur-show-failed'] = () => { const u = ui(AK); u.life = 'attention'; u.page = 1; refresh(); };
  A['cur-retry-all'] = () => {
    const docs = curatedDocs().filter(d => lifeKey(d) === 'failed' && !isLocked(d));
    if (!X.processDocs(docs, { msg: `Publishing ${plural(docs.length, 'document')} again` })) toast('These files can’t be published yet', { tone: 'danger' });
  };
  const selectedAll = () => Object.keys(ui(AK).sel || {}).filter(id => ui(AK).sel[id]).map(docById).filter(d => d && canReviewKb(kbById(d.kb)));
  const canPublish = d => { const k = lifeKey(d); return k === 'unpublished' || k === 'queued' || k === 'update' || (k === 'failed' && !isLocked(d)); };
  const canUnpublish = d => stageOf(d) === 'published' && !d.archived;
  function publishDocs(docs) {
    const again = docs.filter(d => stageOf(d) === 'unpublished'), rest = docs.filter(d => stageOf(d) !== 'unpublished');
    again.forEach(republish);
    if (rest.length) X.processDocs(rest, { quiet: true });
  }
  A['cur-bulk-publish'] = () => {
    const docs = selectedAll(), ok = docs.filter(canPublish), skipped = docs.length - ok.length;
    if (!ok.length) { toast('None of these need publishing', { tone: 'danger' }); return; }
    ui(AK).sel = {}; publishDocs(ok); refresh();
    toast(`Publishing ${plural(ok.length, 'document')}${skipped ? ` · ${skipped} skipped` : ''}`, { tone: 'accent' });
  };
  function unpublishDocs(docs, onDone) {
    docs = docs.filter(canUnpublish);
    if (!docs.length) { toast('None of these are published', { tone: 'danger' }); return; }
    const one = docs.length === 1;
    confirmAction({
      title: one ? `Unpublish “${docs[0].name}”?` : `Unpublish ${plural(docs.length, 'document')}?`,
      body: `${one ? 'It' : 'They'} leave${one ? 's' : ''} Browse, search and answers. ${one ? 'It stays' : 'They stay'} here, and you can publish ${one ? 'it' : 'them'} again.`,
      confirm: 'Unpublish', danger: true,
      onConfirm: () => {
        const snaps = docs.map(d => [d, snapDoc(d)]);
        docs.forEach(d => unpublish(d)); onDone?.(); refresh();
        toast(one ? `Unpublished “${docs[0].name}”` : `Unpublished ${plural(docs.length, 'document')}`, { action: { label: 'Undo', run: () => { snaps.forEach(([d, s]) => restoreDoc(d, s)); refresh(); toast(one ? `“${docs[0].name}” is published again` : `${plural(docs.length, 'document')} are published again`, { tone: 'accent' }); } } });
      },
    });
  }
  A['cur-bulk-unpublish'] = () => unpublishDocs(selectedAll(), () => { ui(AK).sel = {}; });
  A['cur-bulk-archive'] = () => X.archiveDocs(selectedAll(), () => { ui(AK).sel = {}; });

  /* ── One document: drawer + row menu ── */
  const closeDocDrawer = () => { if (S.drawer?.name === 'cur-doc') S.drawer = null; };
  const OPS = {
    review: { label: 'Review', icon: 'check', run: d => { closeDocDrawer(); go(`${BASE}?tab=review&sel=${d.id}`); } },
    publish: { label: 'Publish now', icon: 'play', run: d => X.processDocs([d], { msg: `Publishing ${d.name}` }) },
    retry: { label: 'Retry', icon: 'retry', run: d => X.processDocs([d], { msg: `Publishing ${d.name} again` }) },
    replace: { label: 'Replace file', icon: 'upload', run: d => A['doc-replace']({ dataset: { id: d.id } }) },
    update: { label: 'Publish update', icon: 'refresh', run: d => X.processDocs([d], { msg: `Publishing the update to ${d.name}` }) },
    republish: { label: 'Publish again', icon: 'upload', run: d => { const s = snapDoc(d); republish(d); refresh(); toast(`Publishing “${d.name}” again`, { tone: 'accent', action: { label: 'Undo', run: () => { restoreDoc(d, s); refresh(); } } }); } },
    unpublish: { label: 'Unpublish', icon: 'eye-off', run: d => unpublishDocs([d]) },
    edit: { label: 'Edit details…', icon: 'pencil', run: d => A['res-edit']({ dataset: { id: d.id } }) },
    move: { label: 'Move to…', icon: 'folder', run: d => A['doc-move']({ dataset: { id: d.id } }) },
    open: { label: 'Open', icon: 'file-text', run: d => { closeDocDrawer(); go('/doc/' + d.id); } },
    original: { label: 'Open the published document', icon: 'file-text', run: d => { closeDocDrawer(); go('/doc/' + d.mergedInto); } },
    download: { label: 'Download', icon: 'download', run: d => X.downloadDocument(d) },
    archive: { label: 'Archive', icon: 'archive', danger: true, run: d => X.archiveDocs([d], closeDocDrawer) },
  };
  /** { main, more } operations for a document's lifecycle state. */
  function opsFor(d) {
    const k = lifeKey(d), live = ['published', 'update', 'stored', 'queued', 'failed', 'publishing'].includes(k);
    const main = { analyzing: 'review', review: 'review', queued: 'publish', failed: isLocked(d) ? 'replace' : 'retry', update: 'update', unpublished: 'republish', merged: d.mergedInto ? 'original' : 'open' }[k] || 'open';
    const more = [main !== 'open' && 'open', live && 'edit', live && !kbById(d.kb)?.personal && 'move', canUnpublish(d) && 'unpublish'].filter(Boolean);
    return { main, more, tail: ['download', !d.archived && k !== 'merged' && 'archive'].filter(Boolean) };
  }
  A['cur-op'] = el => { const d = docById(el.dataset.id); if (d && canReviewKb(kbById(d.kb))) OPS[el.dataset.op]?.run(d); };
  A['cur-doc'] = el => openDrawer('cur-doc', { id: el.dataset.id });
  MENUS['cur-row'] = el => {
    const d = docById(el.dataset.id); if (!d) return [];
    const { main, more, tail } = opsFor(d), item = op => ({ label: OPS[op].label, icon: OPS[op].icon, danger: OPS[op].danger, run: () => OPS[op].run(d) });
    return [{ label: 'Details', icon: 'info', run: () => openDrawer('cur-doc', { id: d.id }) }, item(main), ...more.map(item), { sep: true }, ...tail.map(item)];
  };
  const EVENTS = {
    submitted: ['upload', 'Submitted', ''], resubmitted: ['upload', 'Resubmitted', ''], changes: ['pencil', 'Changes requested', 'warning'],
    rejected: ['x-circle', 'Declined', 'danger'], approved: ['check-circle', 'Approved', 'success'], published: ['upload', 'Published again', 'success'],
    unpublished: ['eye-off', 'Unpublished', ''], withdrawn: ['archive', 'Withdrawn', ''],
  };
  function timeline(d) {
    const evs = d.submission?.events || [], src = srcKey(d) !== 'upload' ? srcById(d.source) : null;
    const items = evs.length ? evs.map(e => {
      const [icon, label, tone] = EVENTS[e.kind] || ['clock', e.kind, ''];
      return { icon, tone, label, by: e.by ? actorName(e.by) : e.kind === 'submitted' ? contributorName(d) : '', text: e.text, at: e.at };
    }) : [{ icon: src ? 'refresh' : 'upload', label: src ? `Synced from ${src.name}` : 'Added', by: src ? '' : d.addedBy || '', at: d.updated }];
    if (evs.length && lifeKey(d) === 'published' && evs.at(-1).kind !== 'unpublished') items.push({ icon: 'check-circle', tone: 'success', label: 'Published', at: Math.max(d.updated, evs.at(-1).at) });
    return `<ol class="cur-tl">${items.map(x => `<li class="cur-tl__item">${itemIcon(x.icon, x.tone, 'sm')}<div class="grow"><div class="t-sm"><span class="medium">${esc(x.label)}</span>${x.by ? ` · ${esc(x.by)}` : ''}</div>${x.text ? `<div class="cur-tl__text">“${esc(x.text)}”</div>` : ''}<div class="t-xs muted">${esc(fmtDateTime(x.at))}</div></div></li>`).join('')}</ol>`;
  }
  DR['cur-doc'] = ({ id }) => {
    const d = docById(id), kb = d && kbById(d.kb);
    if (!d || !kb || !canReviewKb(kb)) return { title: 'Document not available', body: emptyState({ icon: 'file', title: 'This document isn’t available', desc: 'It may have been moved to a knowledge base you don’t look after.' }) };
    const l = lifecycleOf(d), { main, more, tail } = opsFor(d), k = l.key;
    const opBtn = (op, v = 'secondary') => btn(OPS[op].label, { v, icon: OPS[op].icon, act: 'cur-op', data: { id: d.id, op } });
    const last = [...(d.submission?.events || [])].reverse().find(e => ['changes', 'rejected', 'unpublished'].includes(e.kind));
    const note = k === 'failed' ? alertBox('danger', 'Couldn’t publish', esc(d.error || 'Publishing stopped partway. Try again.'))
      : k === 'update' ? alertBox('warning', 'The original changed', 'Answers use the previous version until you publish the update.')
        : k === 'merged' && d.mergedInto ? alertBox('success', `Published as a new version of “${docById(d.mergedInto)?.name || 'a document'}”`)
          : ['changes', 'rejected', 'unpublished'].includes(k) && last?.text ? `<blockquote class="cur-tl__text">“${esc(last.text)}” — ${esc(actorName(last.by))}</blockquote>` : '';
    const published = stageOf(d) === 'published';
    const body = `<div class="drawer__section"><div class="row gap-8 wrap">${lifeChip(d)}</div><p class="t-sm muted mt-8">${esc(l.desc)}</p>${note ? `<div class="mt-12">${note}</div>` : ''}</div>
      <div class="drawer__section"><h3 class="drawer__section-title">History</h3>${timeline(d)}</div>
      <div class="drawer__section"><h3 class="drawer__section-title">Details</h3>${published ? X.res.details(d) : kv([
        ['Knowledge base', `<a class="link" href="#/knowledge/${kb.id}">${esc(kb.name)}</a>`],
        ['Contributor', esc(contributorName(d))],
        ['Type', esc(kindMeta(res(d).kind).label)],
        ['Size', `${esc(fmtSize(d.size))} · ${plural(d.pages || 1, 'page')}`],
        ['Who could see it', `<span class="row gap-6">${ic(X.whoCanSee(kb).icon, 'i-sm muted')}${esc(X.whoCanSee(kb).label)}</span>`],
      ])}</div>`;
    return {
      title: d.name, lead: fileIcon(d.type, 'lg'), desc: esc(kb.name), size: 'lg', body,
      headActions: (main !== 'open' ? iconBtn('external', 'Open', { act: 'cur-op', data: { id: d.id, op: 'open' } }) : '') + (tail.includes('download') ? iconBtn('download', 'Download', { act: 'cur-op', data: { id: d.id, op: 'download' } }) : ''),
      footStart: tail.includes('archive') ? btn('Archive', { v: 'ghost', icon: 'archive', act: 'cur-op', data: { id: d.id, op: 'archive' } }) : '',
      foot: more.filter(op => op !== 'open' && op !== 'move').map(op => opBtn(op, 'tertiary')).join('') + opBtn(main, 'primary'),
    };
  };
})();
