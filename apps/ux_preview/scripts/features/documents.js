/* Documents: shared document operations (table row, row menu, details
   drawer, processing, replace, move, archive, download) and the rendition
   model — the readable text of a resource, split into pages, outline and
   passages — used by the reader (reader.js), search snippets and answers.
   Exports: X.docRow, X.docHead, X.docSorters, X.docOpts, X.docSub,
   X.whoCanSee, X.downloadDocument, X.processDocs, X.archiveDocs, X.docFix,
   X.docModel, X.docText. */
(() => {
  'use strict';

  const STATUS_OPTS = [['ready', 'Ready'], ['processing', 'Processing'], ['pending', 'Waiting'], ['outdated', 'Needs update'], ['failed', 'Failed'], ['unsupported', 'Not searchable']];
  const TYPE_OPTS = [['pdf', 'PDF'], ['word', 'Word'], ['excel', 'Spreadsheet'], ['ppt', 'Slides'], ['text', 'Text']];
  const TYPE_GROUP = { pdf: 'pdf', doc: 'word', docx: 'word', xls: 'excel', xlsx: 'excel', csv: 'excel', ppt: 'ppt', pptx: 'ppt', md: 'text', txt: 'text', html: 'text', json: 'text' };
  X.docOpts = { STATUS_OPTS, TYPE_OPTS, typeGroup: d => TYPE_GROUP[d.type] || 'other' };

  /* ── Small helpers ── */
  function audit(action, target) {
    D.audit.unshift({ id: uid('ev'), at: Date.now(), actor: me().id, action, type: 'Knowledge', target, outcome: 'success', ip: '10.4.12.30', device: 'Chrome on macOS' });
  }
  const byYou = d => d.addedBy === 'You' || d.addedBy === me().name;
  function docSub(d) {
    const src = d.source && d.source !== 'upload' ? srcById(d.source) : null;
    return src ? src.name : `Uploaded by ${byYou(d) ? 'you' : d.addedBy}`;
  }
  X.docSub = docSub;
  function shareName(s) { return s.kind === 'group' ? (groupById(s.id)?.name || 'Group') : (memberById(s.id)?.name || 'Someone'); }
  function whoCanSee(kb) {
    if (kb.personal) return { icon: 'user', label: 'Only you', detail: '' };
    if (kb.general === 'workspace') return { icon: 'globe', label: `Everyone in ${curWs().name}`, detail: '' };
    const names = (kb.shares || []).filter(s => kb.general !== 'private' || s.role === 'owner').map(shareName);
    return { icon: 'lock', label: kb.general === 'private' ? 'Only owners' : 'Only people with access', detail: names.join(', ') };
  }
  X.whoCanSee = whoCanSee;

  /* ── Download (browser-native local copy) ── */
  function downloadDocument(doc) {
    const kb = kbById(doc.kb);
    const rows = [['Document', doc.name], ['Knowledge base', kb?.name || doc.kb], ['Status', STATUS.doc[doc.status]?.[1] || doc.status], ['Type', String(doc.type || '').toUpperCase()], ['Pages', doc.pages || '—'], ['Updated', fmtDateTime(doc.updated)], ['Source', docSub(doc)]];
    const msg = `Downloaded ${doc.name}`;
    if (doc.type === 'pdf') return savePdf(withExt(doc.name, '.pdf'), doc.name, rows.map(([k, v]) => `${k}: ${v}`), msg);
    if (['xlsx', 'xls', 'csv'].includes(doc.type)) return saveCsv(withExt(doc.name, '.csv'), [['Field', 'Value'], ...rows], msg);
    if (['docx', 'doc'].includes(doc.type)) return saveWord(withExt(doc.name, '.doc'), doc.name, `<table>${rows.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join('')}</table>`, msg);
    saveLocalFile(withExt(doc.name, doc.type === 'md' ? '.md' : '.txt'), rows.map(([k, v]) => `${k}: ${v}`).join('\n'), 'text/plain;charset=utf-8', msg);
  }
  X.downloadDocument = downloadDocument;

  /* ── Processing (simulated): Waiting → Processing → Ready | Failed ── */
  const stillLocked = d => /password/i.test(d.error || '');
  function processDocs(docs, { msg, quiet } = {}) {
    docs = docs.filter(d => d && !d.archived && d.status !== 'unsupported' && d.status !== 'processing');
    if (!docs.length) return 0;
    docs.forEach(d => { d.status = 'processing'; });
    audit(docs.length === 1 ? 'Processed a document' : `Processed ${plural(docs.length, 'document')}`, kbById(docs[0].kb)?.name || docs[0].name);
    refresh();
    if (msg && !quiet) toast(msg, { tone: 'accent' });
    setTimeout(() => {
      const ok = [], bad = [];
      docs.forEach(d => {
        delete d.fresh;
        if (d.archived || d.status !== 'processing') return;
        if (stillLocked(d)) { d.status = 'failed'; bad.push(d); }
        else { d.status = 'ready'; d.error = ''; d.updated = Date.now(); ok.push(d); }
      });
      refresh();
      if (ok.length) toast(ok.length === 1 ? `${ok[0].name} is ready` : `${plural(ok.length, 'document')} are ready`);
      bad.forEach(d => toast(`Couldn’t process ${d.name}`, { tone: 'danger', action: { label: 'Review', run: () => openDrawer('doc', { id: d.id }) } }));
    }, 2600);
    return docs.length;
  }
  X.processDocs = processDocs;
  A['doc-process'] = el => {
    const d = docById(el.dataset.id); if (!d) return;
    processDocs([d], { msg: `${d.status === 'pending' ? 'Processing' : 'Reprocessing'} ${d.name}` });
  };
  /** Fix for a locked file: pick a new version with the real file picker, then process it. */
  A['doc-replace'] = el => {
    const d = docById(el.dataset.id); if (!d) return;
    const inp = document.createElement('input'); inp.type = 'file'; inp.hidden = true;
    inp.accept = '.' + d.type;
    inp.addEventListener('change', () => {
      const f = inp.files?.[0]; inp.remove(); if (!f) return;
      d.error = ''; d.size = f.size || d.size; d.addedBy = me().name; d.source = 'upload';
      audit('Replaced a document', d.name);
      processDocs([d], { msg: `Processing the new version of ${d.name}` });
    });
    document.body.append(inp); inp.click();
  };

  /* ── Archive / move ── */
  function archiveDocs(docs, onDone) {
    docs = docs.filter(Boolean); if (!docs.length) return;
    const one = docs.length === 1;
    confirmAction({
      title: one ? `Archive “${docs[0].name}”?` : `Archive ${plural(docs.length, 'document')}?`,
      body: `${one ? 'It' : 'They'} will stop appearing in answers and search. You can undo this.`,
      confirm: 'Archive', danger: true, delay: 300,
      onConfirm: () => {
        docs.forEach(d => (d.archived = true));
        const kbId = docs[0].kb; if (S.ui['kbdocs-' + kbId]) S.ui['kbdocs-' + kbId].sel = {};
        onDone?.(); refresh();
        audit(one ? 'Archived document' : `Archived ${plural(docs.length, 'document')}`, one ? docs[0].name : kbById(kbId)?.name);
        toast(one ? `Archived “${docs[0].name}”` : `Archived ${plural(docs.length, 'document')}`, { action: { label: 'Undo', run: () => { docs.forEach(d => (d.archived = false)); refresh(); toast(one ? `Restored “${docs[0].name}”` : `Restored ${plural(docs.length, 'document')}`); } } });
      },
    });
  }
  X.archiveDocs = archiveDocs;
  A['doc-archive'] = el => { const d = docById(el.dataset.id); if (d) archiveDocs([d], () => { if (S.drawer?.name === 'doc') S.drawer = null; }); };

  const moveTargets = from => visibleKbs().filter(k => k.id !== from && !k.personal && canEditKb(k));
  A['doc-move'] = el => {
    const ids = (el.dataset.ids || el.dataset.id || '').split(',').filter(Boolean); if (!ids.length) return;
    const from = docById(ids[0])?.kb;
    setPath('docMove', { to: moveTargets(from)[0]?.id || '' });
    openModal('doc-move', { ids, from });
  };
  M['doc-move'] = ({ ids, from }) => {
    const targets = moveTargets(from), f = ui('docMove');
    const n = ids.length;
    return {
      size: 'sm', title: n === 1 ? `Move “${docById(ids[0])?.name}”` : `Move ${plural(n, 'document')}`,
      desc: `From ${esc(kbById(from)?.name || '')}`,
      body: targets.length
        ? field({ id: 'doc-move-to', label: 'Move to', desc: 'People with access to that knowledge base will see these documents.', control: select({ id: 'doc-move-to', bind: 'docMove.to', value: f.to, options: targets.map(k => [k.id, k.name]) }) })
        : `<p class="muted">There’s no other knowledge base you can edit.</p>`,
      foot: btn('Cancel', { act: 'close-modal' }) + (targets.length ? btn('Move', { v: 'primary', act: 'doc-move-go' }) : ''),
    };
  };
  A['doc-move-go'] = () => {
    const { ids, from } = S.modal.props, target = kbById(ui('docMove').to); if (!target) return;
    const docs = ids.map(docById).filter(Boolean);
    docs.forEach(d => (d.kb = target.id)); target.updated = Date.now();
    if (S.ui['kbdocs-' + from]) S.ui['kbdocs-' + from].sel = {};
    closeModal(); if (S.drawer?.name === 'doc') S.drawer = null; refresh();
    audit(`Moved ${plural(docs.length, 'document')}`, target.name);
    toast(`Moved ${plural(docs.length, 'document')} to ${target.name}`, { action: { label: 'Undo', run: () => { docs.forEach(d => (d.kb = from)); refresh(); toast(`Moved ${plural(docs.length, 'document')} back`); } } });
  };

  /* ── Row, menu, drawer ── */
  /** Table row shared by the knowledge base and all-documents tables. */
  X.docRow = (d, { uiKey, select: withSel, showKb, act = 'doc-details' } = {}) => {
    const kb = kbById(d.kb), on = withSel && !!ui(uiKey).sel?.[d.id];
    return `<tr class="${cx('table__row', d.fresh && 'table__row--new')}" data-act="${act}" data-id="${d.id}" tabindex="0" ${on ? 'aria-selected="true"' : ''}>
      ${withSel ? selCheck(uiKey, d.id, 'Select ' + d.name) : ''}
      <td class="table__cell table__cell--primary"><div class="row gap-12">${fileIcon(d.type)}<div class="grow"><div class="cell-title truncate" title="${esc(d.name)}">${esc(d.name)}</div><div class="cell-sub truncate">${esc(showKb ? kb?.name : docSub(d))}</div></div></div></td>
      <td class="table__cell">${status('doc', d.status)}</td>
      <td class="table__cell muted doc-nowrap" title="${esc(fmtDateTime(d.updated))}">${rel(d.updated)}</td>
      <td class="table__cell table__cell--num table__cell--hide-sm muted num">${fmtSize(d.size)}</td>
      <td class="table__cell table__cell--actions">${iconBtn('more', 'More actions', { size: 'sm', menu: 'doc-row', data: { id: d.id } })}</td></tr>`;
  };
  X.docHead = (uiKey, pageIds) => `${pageIds ? selAllCheck(uiKey, pageIds) : ''}${sortHead('Name', 'name', uiKey)}${th('Status')}${sortHead('Updated', 'updated', uiKey)}${sortHead('Size', 'size', uiKey, 'table__column--num')}${th('<span class="sr-only">Actions</span>', 'table__column--actions')}`;
  X.docSorters = { name: d => d.name.toLowerCase(), updated: d => d.updated, size: d => d.size };

  const processLabel = d => d.status === 'pending' ? 'Process now' : d.status === 'failed' ? 'Try again' : 'Reprocess';
  const canProcess = d => !['unsupported', 'processing'].includes(d.status) && !(d.status === 'failed' && stillLocked(d));
  /** The fix an editor can apply to a file that isn't readable (or changed at the source); '' when none. */
  X.docFix = (d, { v = 'secondary', size } = {}) => {
    const b = (label, icon, act) => btn(label, { v, size, icon, act, data: { id: d.id } });
    if (d.status === 'failed') return stillLocked(d) ? b('Replace file', 'upload', 'doc-replace') : b('Try again', 'retry', 'doc-process');
    if (d.status === 'pending') return b('Process now', 'play', 'doc-process');
    if (d.status === 'outdated') return b('Reprocess', 'retry', 'doc-process');
    return '';
  };
  MENUS['doc-row'] = el => {
    const d = docById(el.dataset.id); if (!d) return [];
    const edit = canEditKb(kbById(d.kb));
    return [
      { label: 'Open', icon: 'file-text', run: () => go('/doc/' + d.id) },
      { label: 'Details', icon: 'info', run: () => openDrawer('doc', { id: d.id }) },
      { label: 'Download', icon: 'download', run: () => downloadDocument(d) },
      ...(edit ? [
        { sep: true },
        canProcess(d) && { label: processLabel(d), icon: d.status === 'pending' ? 'play' : 'retry', run: () => A['doc-process']({ dataset: { id: d.id } }) },
        d.status === 'failed' && stillLocked(d) && { label: 'Replace file', icon: 'upload', run: () => A['doc-replace']({ dataset: { id: d.id } }) },
        !kbById(d.kb).personal && { label: 'Move to…', icon: 'folder', run: () => A['doc-move']({ dataset: { id: d.id } }) },
        { label: 'Archive', icon: 'archive', danger: true, run: () => archiveDocs([d]) },
      ].filter(Boolean) : []),
    ];
  };
  A['doc-details'] = el => openDrawer('doc', { id: el.dataset.id });
  A['doc-open'] = el => go('/doc/' + el.dataset.id);

  function statusNote(d, edit) {
    const fix = edit ? X.docFix(d, { size: 'sm' }) : '';
    switch (d.status) {
      case 'failed': return alertBox('danger', 'Couldn’t process this file', esc(d.error || 'The file couldn’t be opened.') + (edit ? '' : ' Ask an owner of this knowledge base to fix it.'), fix);
      case 'pending': return alertBox('default', 'Waiting to be processed', 'It isn’t searchable yet.', fix);
      case 'outdated': return alertBox('warning', 'The original changed', 'Answers use the previous version until it’s reprocessed.', fix);
      case 'processing': return alertBox('accent', 'Processing', 'It’ll be searchable in a few minutes.');
      case 'unsupported': return alertBox('default', 'Not searchable', 'This file type can’t be read. It’s kept here but not used in answers.');
      default: return '';
    }
  }
  DR.doc = ({ id }) => {
    const d = docById(id), kb = d && kbById(d.kb);
    if (!d || d.archived || !kb || !canReadKb(kb)) return { title: 'Document not available', body: emptyState({ icon: 'file', title: 'This document isn’t available', desc: 'It may have been archived or moved.' }) };
    const edit = canEditKb(kb), src = d.source && d.source !== 'upload' ? srcById(d.source) : null, who = whoCanSee(kb);
    const body = `${statusNote(d, edit) ? `<div class="drawer__section">${statusNote(d, edit)}</div>` : ''}
      <div class="drawer__section"><h3 class="drawer__section-title">Details</h3>${kv([
        ['Knowledge base', `<a class="link" href="#/knowledge/${kb.id}">${esc(kb.name)}</a>`],
        ['Source', src ? `<span class="row gap-8">${appIcon(src.app, 'sm')}${esc(src.name)}</span>` : 'Uploaded file'],
        ['Added by', esc(byYou(d) ? 'You' : d.addedBy)],
        ['Updated', esc(fmtDateTime(d.updated))],
        ['Size', esc(fmtSize(d.size))],
        ['Pages', d.status === 'unsupported' ? '—' : fmtNum(d.pages)],
        d.status === 'ready' && ['Passages', fmtNum(d.passages)],
      ])}</div>
      <div class="drawer__section"><h3 class="drawer__section-title">Who can see this</h3><div class="row gap-8">${ic(who.icon, 'i-sm muted')}<span>${esc(who.label)}</span></div>${who.detail ? `<p class="t-sm muted mt-4">${esc(who.detail)}</p>` : ''}${kbRole(kb) === 'owner' && !kb.personal ? `<div class="mt-8">${linkBtn('Manage access', { href: `/knowledge/${kb.id}?tab=access` })}</div>` : ''}</div>`;
    return {
      title: d.name, lead: fileIcon(d.type, 'lg'), desc: `${esc(kb.name)} · ${status('doc', d.status)}`, body,
      headActions: iconBtn('download', 'Download', { act: 'doc-dl', data: { id: d.id } }),
      footStart: edit ? btn('Archive', { v: 'ghost', icon: 'archive', act: 'doc-archive', data: { id: d.id } }) : '',
      foot: (edit && canProcess(d) && d.status !== 'pending' ? btn(processLabel(d), { icon: 'retry', act: 'doc-process', data: { id: d.id } }) : '') + btn('Open', { v: 'primary', icon: 'external', href: '/doc/' + d.id }),
    };
  };
  A['doc-dl'] = el => { const d = docById(el.dataset.id); if (d) downloadDocument(d); };

  /* ═══════════════════════════ Rendition model ═══════════════════════════
     A readable rendition of a resource: pages (HTML), outline (headings) and
     passages (blocks: paragraphs, list items, table rows with page and
     heading) that the reader cites, highlights and answers from. */
  function build(fn) {
    const out = { pages: [], outline: [], text: '', blocks: [] }; let cur = null, head = '';
    const t = s => { out.text += ' ' + s; return esc(s); };
    const cell = x => (typeof x === 'number' ? fmtNum(x) : String(x));
    const blk = (text, quote = text, kind = 'p') => out.blocks.push({ page: cur.no, heading: head, text: String(text), quote: String(quote), kind });
    const longest = r => r.map(cell).reduce((a, x) => (x.length > a.length ? x : a), '');
    const b = {
      page(no, cls = '') { cur = { no, cls, html: '' }; out.pages.push(cur); return b; },
      title(s, sub) { head = s; cur.html += `<h2>${t(s)}</h2>${sub ? `<p class="doc-sub">${t(sub)}</p>` : ''}`; return b; },
      h(s) { head = s; const id = 'dh-' + out.outline.length; out.outline.push({ id, title: s, page: cur.no }); cur.html += `<h3 id="${id}">${t(s)}</h3>`; return b; },
      p(s) { blk(s); cur.html += `<p>${t(s)}</p>`; return b; },
      ul(items) { items.forEach(x => blk(x, x, 'li')); cur.html += `<ul>${items.map(x => `<li>${t(x)}</li>`).join('')}</ul>`; return b; },
      table(hd, rows) { rows.forEach(r => blk(hd.map((h, i) => `${h}: ${cell(r[i])}`).join(' · '), longest(r), 'row')); cur.html += `<table><thead><tr>${hd.map(x => `<th>${t(x)}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(x => `<td>${t(cell(x))}</td>`).join('')}</tr>`).join('')}</tbody></table>`; return b; },
      sheet(cols, rows, notes = [], tabs = ['Sheet1'], foot = '') {
        const L = 'ABCDEFGHIJ'; cur.cls = 'doc-page--sheet'; if (!head) head = tabs[0];
        rows.forEach(r => blk(cols.map((c, i) => `${c}: ${cell(r[i])}`).join(' · '), cell(r[0]), 'row')); notes.forEach(n => blk(n));
        cur.html += `<div class="doc-sheet"><table><thead><tr><th class="doc-sheet__rn"></th>${cols.map((_, i) => `<th>${L[i]}</th>`).join('')}</tr></thead><tbody><tr class="doc-sheet__hdr"><td class="doc-sheet__rn">1</td>${cols.map(c => `<td>${t(c)}</td>`).join('')}</tr>${rows.map((r, ri) => `<tr><td class="doc-sheet__rn">${ri + 2}</td>${r.map(x => `<td class="${typeof x === 'number' ? 'num' : ''}">${t(cell(x))}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`
          + (notes.length || foot ? `<div class="doc-sheet__notes">${notes.map(n => `<p class="doc-note">${t(n)}</p>`).join('')}${foot ? `<p class="doc-note muted">${esc(foot)}</p>` : ''}</div>` : '')
          + `<div class="doc-sheet__tabs">${tabs.map((x, i) => `<span class="${i ? '' : 'is-on'}">${esc(x)}</span>`).join('')}</div>`;
        return b;
      },
    };
    fn(b); return out;
  }
  /** Section → builder. Section: { h, p:[…], ul:[…], table:[head, rows], after:[…] }. */
  const section = (b, s) => { b.h(s.h); (s.p || []).forEach(x => b.p(x)); if (s.ul) b.ul(s.ul); if (s.table) b.table(s.table[0], s.table[1]); (s.after || []).forEach(x => b.p(x)); };
  /** Lay sections over pages, `per` a page. Long files spread them out so the page numbers look real; slides stay consecutive. */
  function flow(doc, { title, sub, secs, per = 2, cls = '', titlePage = false, spread = true }) {
    return build(b => {
      const total = Math.max(1, doc.pages || 1), groups = titlePage ? [[]] : [];
      secs.filter(Boolean).forEach((s, i) => { if (i % per === 0) groups.push([]); groups.at(-1).push(s); });
      let last = 0;
      groups.forEach((g, gi) => {
        const want = spread && total > groups.length * 2 ? 1 + Math.round(gi * (total - 1) / groups.length) : gi + 1;
        last = Math.max(last + 1, want);
        b.page(last, cls);
        if (!gi) b.title(title, sub);
        g.forEach(s => section(b, s));
      });
    });
  }
  const CLAIMS = [
    ['Kevin Ng', 'Sales', 'Client dinner', 2480, 'Sep 12'], ['Rosa Diaz', 'Sales', 'Airfare', 2150, 'Sep 3'], ['Minh Pham', 'Sales', 'Hotel', 1040, 'Aug 28'],
    ['Lan Do', 'Sales', 'Conference', 980, 'Aug 19'], ['Grace Lee', 'Sales', 'Airfare', 920, 'Jul 30'], ['Nam Tran', 'Sales', 'Client dinner', 850, 'Jul 22'],
    ['David Kim', 'Engineering', 'Training', 1890, 'Sep 15'], ['Omar Haddad', 'Engineering', 'Hardware', 1320, 'Sep 2'], ['Tuan Le', 'Engineering', 'Conference', 1180, 'Aug 11'],
    ['Peter Vo', 'Engineering', 'Software', 920, 'Jul 18'], ['Julia Chen', 'Marketing', 'Event booth', 1760, 'Sep 9'], ['Marco Rossi', 'Marketing', 'Airfare', 1450, 'Aug 25'],
    ['Ivy Tran', 'Marketing', 'Hotel', 850, 'Aug 6'], ['Chi Bui', 'People Ops', 'Training', 1150, 'Jul 27'],
    ['Sara Lopez', 'Legal', 'Taxi', 64, 'Sep 18'], ['Priya Shah', 'Product', 'Meals', 120, 'Sep 17'], ['Ben Walker', 'Product', 'Books', 86, 'Sep 14'], ['An Nguyen', 'People Ops', 'Meals', 210, 'Sep 10'],
    ['Mai Hoang', 'Finance', 'Taxi', 48, 'Sep 8'], ['Lan Do', 'Sales', 'Meals', 340, 'Sep 5'], ['Omar Haddad', 'Engineering', 'Cables', 72, 'Aug 30'], ['Kevin Ng', 'Sales', 'Taxi', 95, 'Aug 21'],
    ['Julia Chen', 'Marketing', 'Printing', 460, 'Aug 14'], ['Tuan Le', 'Engineering', 'Meals', 155, 'Aug 2'],
  ];
  const AUTHORED = {
    'd-hr-travel': () => build(b => {
      b.page(1).title('Travel & Expense Policy', 'Northwind Group · People Ops · Version 6, effective January 1, 2026')
        .h('Purpose').p('This policy explains how to plan business travel, what Northwind pays for, and how to claim it back. It aims to keep travel safe, fair and cost-conscious.')
        .h('Scope').p('It applies to all employees of Northwind Group and its subsidiaries traveling on company business, including part-time staff. Contractors follow the travel terms in their statement of work.')
        .p('Personal travel added to a business trip is at your own cost, and must not increase what Northwind pays.');
      b.page(2).h('Approvals').p('Trips must be approved by your manager before you book. International trips and any trip over USD 3,000 also need approval from your department head.')
        .ul(['Submit the trip request in the travel tool at least 14 days before departure.', 'Include the purpose, dates, estimated cost and any client attending.', 'Trips to high-risk destinations need a security briefing from IT Security.']);
      b.page(3).h('Booking flights and hotels').p('Book through the company travel tool so trips are covered by our insurance and duty-of-care service.')
        .ul(['Economy class for flights under 6 hours; premium economy for longer flights.', 'Hotels up to the city cap shown in the travel tool.', 'Use public transport or ride-hailing for ground travel when practical.']);
      b.page(4).h('Per diem').p('Employees traveling internationally receive a meal per diem of USD 75 per calendar day. The per diem replaces itemized meal receipts for trips longer than one day.')
        .table(['Region', 'Daily meal rate'], [['Domestic', 'USD 45'], ['Asia-Pacific', 'USD 75'], ['Europe', 'USD 75'], ['North America', 'USD 75'], ['High-cost cities (Appendix B)', 'Up to USD 110']])
        .p('On the first and last day of travel you receive 75% of the daily rate.')
        .p('When a client, conference or hotel provides a meal, deduct its share of the daily rate: 20% for breakfast, 30% for lunch and 50% for dinner.');
      b.page(5).h('Receipts').p('Keep itemized receipts for lodging, airfare, ground transportation and any single expense over USD 25. Photos of receipts are accepted.')
        .p('Submit your expense report within 30 days of returning. Reports submitted after 60 days need approval from Finance.')
        .h('Reimbursement').p('Approved claims are paid with the next payroll run. Claims above USD 2,000 need department VP approval before payment.');
      b.page(6).h('Appendix B — High-cost cities').p('Your manager can approve a per diem of up to the rate below before you travel.')
        .table(['City', 'Daily meal rate'], [['London', 'USD 110'], ['New York', 'USD 110'], ['Zurich', 'USD 110'], ['Tokyo', 'USD 105'], ['Paris', 'USD 100'], ['Singapore', 'USD 100'], ['Sydney', 'USD 95']]);
    }),
    'd-hr-handbook': () => build(b => {
      b.page(1).title('Employee Handbook 2026', 'Northwind Group · People Ops')
        .h('Welcome').p('This handbook brings together what you need to know about working at Northwind: how we work, what we offer, and what we expect of each other.')
        .h('How to use this handbook').p('Each section links to the full policy in HR Policies. If the handbook and a policy disagree, the policy applies.');
      b.page(6).h('Contractors and temporary staff').p('Contractors receive access only to the systems named in their statement of work and are not eligible for employee benefits.')
        .p('Every contractor has a Northwind sponsor who approves their access and timesheets.');
      b.page(12).h('Working hours').p('Core collaboration hours are 10:00 to 15:00 in your local office time zone. Outside those hours, plan your day with your team.')
        .p('Overtime for eligible roles must be agreed with your manager in advance.');
      b.page(18).h('Time off and leave').p('Full-time employees receive 20 days of paid annual leave, plus public holidays in their country of employment.')
        .p('Employees should notify their manager and People Ops at least eight weeks before the expected start of parental leave.')
        .p('Sick leave of more than three consecutive days needs a doctor’s note.');
      b.page(31).h('Expenses').p('Northwind reimburses reasonable costs you incur while working, as set out in the Travel & Expense Policy.')
        .p('Expenses for lodging, airfare and ground transportation must be supported by itemized receipts and submitted within 30 days of the employee’s return.')
        .p('Corporate cards must not be used for personal spending.');
      b.page(32).h('Equipment').p('Northwind provides the laptop and accessories you need for your role. Equipment remains company property and is returned when you leave.');
    }),
    'd-hr-parental': () => build(b => {
      b.page(1).title('Parental Leave Guidelines', 'Effective January 1, 2026 · Replaces the 2024 guidelines')
        .h('Purpose').p('These guidelines explain the paid leave Northwind offers when you welcome a child, and how to plan it with your team.')
        .h('Who is eligible').p('All employees with at least three months of service, including adoptive and foster parents.');
      b.page(2).h('Paid leave').p('From January 1, 2026, primary caregivers receive 20 weeks of fully paid parental leave, and secondary caregivers receive 6 weeks that may be taken in up to three blocks within 12 months of the birth or placement.')
        .p('Leave can start up to two weeks before the expected due date, or earlier on medical advice.')
        .h('Returning to work').p('You may return on a phased schedule, working 60% of your usual hours at full pay for up to four weeks.')
        .h('How to apply').p('Submit your leave plan in the People portal and agree on a handover with your manager.');
    }),
    'd-fin-reimb': () => build(b => {
      const all = [...CLAIMS].sort((a, c) => new Date(c[4] + ', 2026') - new Date(a[4] + ', 2026'));
      b.page(1).sheet(['Employee', 'Department', 'Category', 'Amount (USD)', 'Submitted'], all.map(r => [r[0], r[1], r[2], r[3], r[4] + ', 2026']),
        ['Pending claims — Q3 export, 212 rows. Columns: Employee, Department, Category, Amount (USD), Submitted.'], ['Pending claims', 'By department'], `Showing ${all.length} of 212 rows`);
    }),
    'd-fin-approvals': () => build(b => {
      b.page(1).sheet(['Spend type', 'Up to', 'Approver', 'Notes'], [['Purchase', 'USD 5,000', 'Budget owner', ''], ['Purchase', 'USD 25,000', 'Department VP', ''], ['Purchase', 'USD 100,000', 'CFO', 'Two quotes required'], ['Purchase', 'Over USD 100,000', 'CEO and CFO', 'Board notified quarterly'], ['Expense claim', 'USD 2,000', 'Line manager', ''], ['Expense claim', 'Over USD 2,000', 'Department VP', 'Before reimbursement']],
        ['Purchases up to USD 5,000 are approved by the budget owner; USD 5,000 to 25,000 by the department VP.', 'Single expense claims above USD 2,000 require approval from the department VP before reimbursement.'], ['Limits', 'Delegations']);
    }),
    'du-reg-rules': () => build(b => {
      b.page(1).title('Academic Regulations 2024', 'UTE Campus · Academic Affairs Office · Version 3, effective Semester 1, 2026–2027')
        .h('Purpose').p('The rules every undergraduate follows: credit loads, course registration and withdrawal, grading, academic warning and graduation.')
        .p('These regulations implement the national rules for credit-based undergraduate training and replace the 2021 regulations.')
        .h('Scope').p('These regulations apply to all full-time undergraduate students from Semester 1, 2026–2027. Faculties may add stricter rules for their own programs.');
      b.page(3).h('Definitions').ul(['A credit equals 15 hours of lectures, or 30 hours of lab or practice, plus self-study.', 'A regular semester has 15 teaching weeks followed by up to 3 exam weeks.', 'The cumulative GPA counts every graded course, using the best grade of each course.']);
      b.page(17).h('Credit load').p('The minimum registered load in a regular semester is 14 credits; students below this load must be approved by the Faculty.')
        .p('The maximum load is 25 credits. Students with a cumulative GPA of 3.2 or higher may register up to 30 credits.')
        .h('Course registration').p('Students register for courses on the student portal during the registration windows published in the Academic Calendar.')
        .p('Courses can be added or dropped without a record until the end of week 2 of the semester.');
      b.page(18).h('Withdrawal from a course').p('Students may withdraw from a registered course no later than the end of week 10 of the semester. Withdrawn courses appear as W on the transcript and do not count toward the GPA.')
        .p('Withdrawal requests are sent through BoMesh Requests and confirmed by the Academic Affairs Office within 3 working days.')
        .p('After week 10, students who stop attending a course receive a grade of F for it.')
        .p('A withdrawal must not take the registered load below 14 credits unless the Faculty approves it. Tuition for withdrawn courses is not refunded.');
      b.page(24).h('Grading').p('Each course is graded on a 10-point scale and converted to a letter grade and grade points.')
        .table(['Score', 'Letter', 'Grade points'], [['8.5–10', 'A', '4.0'], ['7.0–8.4', 'B', '3.0'], ['5.5–6.9', 'C', '2.0'], ['4.0–5.4', 'D', '1.0'], ['Below 4.0', 'F', '0']])
        .p('A course is passed with a grade of D or higher. Failed required courses must be retaken.');
      b.page(31).h('Publishing grades').p('Lecturers must publish final grades on the student portal within 10 working days after the final exam.')
        .p('Students may request re-grading of an exam within 7 days after the grade is published.');
      b.page(35).h('Academic warning').p('A student receives an academic warning when the semester GPA is below 1.0, or when the cumulative GPA is below 1.2 in the first year, 1.4 in the second year, 1.6 in the third year or 1.8 afterwards.')
        .p('Students with two consecutive academic warnings are suspended for one semester.');
      b.page(41).h('Graduation').p('Students graduate when they meet all of the following conditions:')
        .ul(['Complete every credit of their program, at least 132 credits for engineering programs.', 'Reach a cumulative GPA of 2.0 or higher.', 'Meet the English requirement for graduation.', 'Have no disciplinary action in progress.'])
        .p('Graduation reviews take place in June and December. Students apply on the student portal.');
    }),
    'du-reg-cal': () => build(b => {
      b.page(1).title('Academic Calendar 2026–2027', 'UTE Campus · Academic Affairs Office')
        .h('Semester 1').table(['What', 'When'], [['Classes start', 'Wednesday, 2 September 2026'], ['Course registration closes', 'Tuesday, 15 September 2026 (end of week 2)'], ['Midterm exams', 'Weeks 8–9'], ['Course withdrawal closes', 'Tuesday, 10 November 2026 (end of week 10)'], ['Last day of classes', 'Tuesday, 15 December 2026'], ['Final exams', 'Weeks 17–19']]);
      b.page(2).h('Key dates').p('Week 10 of Semester 1 ends on Tuesday, 10 November 2026.')
        .p('Tuition for Semester 1 must be paid by the end of week 6.')
        .h('Holidays').ul(['Lunar New Year: 9–20 February 2027.', 'Hung Kings’ Commemoration: 16 April 2027.', 'Reunification Day and Labour Day: 30 April–1 May 2027.']);
      b.page(3).h('Semester 2').table(['What', 'When'], [['Course registration opens', 'Tuesday, 1 December 2026'], ['Classes start', 'Monday, 22 February 2027'], ['Course withdrawal closes', 'End of week 10'], ['Final exams', 'Weeks 17–19']]);
      b.page(4).h('Summer term').p('The summer term runs from 5 July to 22 August 2027. Courses open only when at least 20 students register.');
    }),
  };
  const GENERIC = {
    'kb-hr': n => [['Purpose', [`This policy sets out how ${n} works at Northwind and what employees can expect.`]], ['Who this applies to', ['All employees of Northwind Group and its subsidiaries, including part-time staff. Contractors follow the terms in their statement of work.']], ['How it works', null, ['Read this policy before making plans that depend on it.', 'Your manager approves requests in the People portal.', 'People Ops reviews exceptions within five working days.']], ['Questions', ['Contact People Ops at people@northwind.com or open a request in the People portal.']]],
    'kb-sales': n => [['Overview', [`${n} helps account teams prepare for customer conversations and keep our messaging consistent.`]], ['When to use it', ['Use it from first discovery through renewal. Check the version date before sharing anything outside Northwind.']], ['Key points', null, ['Lead with the customer’s goal, not product features.', 'Quantify value with the ROI calculator where you can.', 'Take pricing exceptions to the deal desk early.']], ['Next steps', ['Questions go to Sales Enablement in the #sales-enablement channel.']]],
    'kb-product': n => [['Overview', [`${n} describes how this part of the Northwind platform works and how to use it.`]], ['Before you start', ['You need an administrator role in the Admin Console. Some features depend on your plan.']], ['Steps', null, ['Open the Admin Console and go to Settings.', 'Make the change and review the summary.', 'Save. Changes apply within a few minutes.']], ['Troubleshooting', ['If something doesn’t look right, check the status page, then contact support with the time and the affected account.']]],
    'kb-legal': n => [['Parties', [`This document (${n}) is made between Northwind Group and the counterparty named on the signature page.`]], ['Term', ['The agreement starts on the effective date and continues for 24 months, renewing for 12-month periods unless either party gives 60 days’ written notice.']], ['Obligations', ['Each party keeps the other’s confidential information secret and uses it only to perform this agreement.']], ['Termination', ['Either party may end the agreement for a material breach not fixed within 30 days of written notice.']]],
    'kb-fin': n => [['Purpose', [`${n} explains how Finance & Procurement handles this process.`]], ['Rules', null, ['Raise requests in the procurement system before committing spend.', 'Attach a quote or contract for anything over USD 1,000.', 'Approvals follow the Approval Limits Matrix.']], ['Questions', ['Contact finance-ops@northwind.com.']]],
    'kb-eng': n => [['When to use this', [`Use ${n} when you are on call and something needs attention.`]], ['Steps', null, ['Acknowledge the page within five minutes.', 'Check the dashboards linked in the alert.', 'Post status in #incidents every 30 minutes.']], ['Escalation', ['If you can’t mitigate within 30 minutes, page the secondary on-call engineer.']]],
    'kb-u-regs': n => [['Scope', [`${n} applies to all undergraduate students of UTE from Semester 1, 2026–2027 unless stated otherwise.`]], ['Rules', null, ['Deadlines refer to weeks of the academic calendar published by Academic Affairs.', 'Requests are sent through BoMesh Requests to the Academic Affairs Office.', 'The office answers within the service time shown for each request type.']], ['Fees', ['Fees are listed in Tuition & Fees 2026–2027 and are paid through the student portal.']], ['Contact', ['Academic Affairs Office, A1-102, Monday to Friday 07:30–16:30.']]],
    'kb-u-sso': n => [['Purpose', [`${n} explains a Student Services procedure at UTE.`]], ['Who can apply', ['Enrolled students in good standing. Some services need a minimum GPA, shown on the request form.']], ['How it works', null, ['Send a request from BoMesh Requests.', 'Student Services checks your record and replies in Requests.', 'Pick up documents at A1-108 with your student card.']]],
    'kb-u-ml': n => [['Learning goals', [`After ${n} you should be able to explain the main idea, apply it to a small dataset and recognise when it fails.`]], ['Key ideas', null, ['Start from the loss you are minimising and what each term means.', 'Check training and validation error together, never one alone.', 'Tune hyper-parameters on validation data, not on the test set.']], ['Practice', ['Work through the lab notebook, then try the self-check questions on the last slide.']]],
    'kb-u-db': n => [['Learning goals', [`${n} covers one building block of relational databases and how to use it in SQL.`]], ['Key ideas', null, ['Model the data first: entities, keys and dependencies.', 'Write the query in relational algebra, then translate it to SQL.', 'Check results on a small table before running on the full dataset.']], ['Practice', ['Solve the lab exercises on the course PostgreSQL server.']]],
    'kb-u-agri': n => [['Abstract', [`${n} studies how sensing and machine learning can support farming decisions in the Mekong Delta.`]], ['Method', ['Data were collected on experimental plots and labelled by agronomists; models were evaluated with held-out field data.']], ['Results', ['The approach improves on the baseline under field conditions; details per experiment are reported in the tables.']], ['Limitations', ['Results come from one region and season; broader validation is future work.']]],
    'kb-u-grants': n => [['About this call', [`${n} sets the rules for applying for research funding.`]], ['Eligibility', ['Principal investigators hold a doctorate and a permanent position at the university.']], ['Budget and duration', ['Budgets and duration are listed per programme; justify every line against the work plan.']], ['How to apply', ['Submit through the Science & Technology Office before the internal deadline.']]],
    default: n => [['Notes', [`Working notes for ${n}.`]], ['Key points', null, ['Confirm goals and owners for the next quarter.', 'Agree on the timeline and the next check-in.', 'Share a short summary with the team afterwards.']], ['Next steps', ['Follow up within a week with the open questions.']]],
  };

  /* ── Kind-based renditions: resources without hand-written text (synced syllabi, theses, courseware, notices, uploads) ── */
  const hashOf = s => [...String(s)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
  const lc = s => String(s || '').replace(/^([A-Z])(?![A-Z0-9])/, m => m.toLowerCase());
  const campus = () => curWs()?.template === 'campus';
  const viDate = t => { const d = new Date(t); return `${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear()}`; };
  function ctxOf(doc) {
    const r = res(doc), base = doc.name.replace(/\.[^.]+$/, '');
    const subject = base.replace(/^(notice|news|thông báo|syllabus|lab guide|lab protocol)\s*[—–-]\s*/i, '').replace(/\s*[—–-]\s*(FME|FEEE)$/, '');
    const m = base.match(/^(?:Syllabus\s*[—–-]\s*)?([A-Z]{2}\d{4})\s+(.+)$/);
    return { r, base, subject, code: m?.[1] || '', rest: m?.[2] || base, lead: doc.summary || '', owner: r.owner || r.kb?.name || curWs().name, org: curWs().name, topic: r.topics[0] ? topicName(r.topics[0]) : '', date: fmtDate(doc.updated), h: hashOf(doc.id), vi: r.lang === 'vi' };
  }
  const people = () => (campus() ? 'all students, lecturers and staff' : 'all employees');
  /** Website notices: matched by title, English or Vietnamese body. */
  const NOTICE_TEXT = [
    [/course registration/i, { en: { p: ['Course registration for Semester 2 opens on December 1 on the student portal. Windows open by cohort: final-year students first, then third-, second- and first-year students.'], ul: ['Check your registration window on the student portal.', 'Clear any outstanding tuition first; blocked accounts can’t register.', 'Adding and withdrawing courses follow the Academic Regulations.'] } }],
    [/exam schedule|lịch thi/i, {
      en: { p: ['The exam schedule for Semester 1, 2026–2027 is published on the student portal. Final exams run from week 17 to week 19.'], ul: ['Bring your student card to every exam.', 'Arrive 15 minutes early; students more than 15 minutes late can’t sit the exam.', 'Report exam clashes to the Academic Affairs Office within 5 working days of this notice.'] },
      vi: { p: ['Phòng Đào tạo thông báo lịch thi kết thúc học phần học kỳ 1 năm học 2026–2027 đã được công bố trên cổng thông tin sinh viên. Các kỳ thi diễn ra từ tuần 17 đến tuần 19.'], ul: ['Sinh viên mang theo thẻ sinh viên khi dự thi.', 'Có mặt tại phòng thi trước giờ thi 15 phút; sinh viên đến muộn quá 15 phút không được dự thi.', 'Trường hợp trùng lịch thi, sinh viên báo cho Phòng Đào tạo trong vòng 5 ngày làm việc kể từ ngày thông báo.'], after: ['Mọi thắc mắc xin liên hệ Phòng Đào tạo, phòng A1-102.'] } }],
    [/tuition|học phí/i, {
      en: { p: ['Tuition for Semester 1 must be paid by the end of week 6, on the student portal or at a partner bank.'], ul: ['Students who haven’t paid by the deadline can’t register for the next semester.', 'If you have a scholarship or fee waiver, check the remaining amount before paying.', 'Keep your receipt until the portal shows the payment.'] },
      vi: { p: ['Sinh viên hoàn thành học phí học kỳ 1 trước cuối tuần 6 qua cổng thông tin sinh viên hoặc tại ngân hàng liên kết.'], ul: ['Sinh viên chưa hoàn thành học phí đúng hạn sẽ không được đăng ký học phần học kỳ tiếp theo.', 'Sinh viên được miễn, giảm học phí hoặc nhận học bổng kiểm tra số tiền còn lại trước khi nộp.', 'Giữ lại biên lai cho đến khi cổng thông tin cập nhật khoản thanh toán.'], after: ['Mọi thắc mắc xin liên hệ Phòng Kế hoạch – Tài chính.'] } }],
    [/scholarship results/i, { en: { p: ['Results of the merit scholarship round for Semester 2, 2025–2026 are on the student portal.'], ul: ['Awards are paid to your registered bank account within 30 days.', 'Appeals go to Student Services within 10 working days of this notice.'] } }],
    [/dormitory/i, { en: { p: ['Dormitory registration for Semester 2 is open on the student portal from week 12 to week 14.'], ul: ['Current residents renewing their room have priority until the end of week 12.', 'Room allocations are published in week 16.', 'The monthly fee is paid before check-in.'] } }],
    [/graduation ceremony/i, { en: { p: ['The graduation ceremony for the December 2026 graduation review takes place in the main hall.'], ul: ['Register to attend on the student portal by November 30.', 'Collect your gown in building A1 from three days before the ceremony.', 'Each graduate may bring two guests.'] } }],
    [/xét tốt nghiệp/i, { vi: { p: ['Phòng Đào tạo thông báo kế hoạch xét tốt nghiệp đợt tháng 12 năm 2026 cho sinh viên đại học hệ chính quy.'], ul: ['Sinh viên đủ điều kiện nộp đơn xét tốt nghiệp trên cổng thông tin sinh viên trước ngày 15/11/2026.', 'Điều kiện: tích lũy đủ số tín chỉ của chương trình, điểm trung bình tích lũy từ 2,0 trở lên và đạt chuẩn ngoại ngữ đầu ra.', 'Kết quả xét tốt nghiệp được công bố trong tuần thứ hai của tháng 12.'], after: ['Mọi thắc mắc xin liên hệ Phòng Đào tạo, phòng A1-102.'] } }],
    [/english placement/i, { en: { p: ['The English placement test takes place in week 11 at the Foreign Languages Centre.'], ul: ['Register on the student portal by the end of week 10.', 'Bring your student card and a pencil.', 'Results are published within 7 days and count toward the English requirement for graduation.'] } }],
    [/library opening/i, { en: { p: ['During the exam weeks the library opens from 07:00 to 22:00, Monday to Sunday.'], ul: ['Study rooms can be booked for up to 3 hours a day.', 'Borrowed books are due at the end of week 19.'] } }],
    [/robotics team/i, { en: { p: ['The UTE robotics team won the national robotics contest final with a fully autonomous harvesting robot.', 'The team of eight students from the Faculty of Mechanical Engineering will represent Vietnam at the regional contest next year.'] } }],
    [/field station/i, { en: { p: ['The Smart Agriculture Lab opened a field station in the Mekong Delta to test sensors and drones on working rice farms.', 'Students can join field trips through the lab’s research projects.'] } }],
    [/wi-?fi/i, {
      en: { p: ['Campus Wi-Fi will be unavailable on Saturday from 08:00 to 12:00 for maintenance.'], ul: ['Wired connections in the computer labs are not affected.', 'Save your work before 08:00 if you’re using online systems.'] },
      vi: { p: ['Trung tâm Thông tin thông báo hệ thống Wi-Fi toàn trường tạm ngưng từ 8 giờ đến 12 giờ thứ Bảy để bảo trì.'], ul: ['Kết nối có dây tại các phòng máy không bị ảnh hưởng.', 'Sinh viên lưu lại bài làm trước 8 giờ nếu đang sử dụng các hệ thống trực tuyến.'] } }],
    [/mental health/i, { en: { p: ['Mental health week runs next week with free talks, workshops and one-to-one sessions with counsellors.'], ul: ['Book a counselling session on the student portal.', 'All sessions are confidential.'] } }],
    [/status letters/i, { en: { p: ['Student status confirmation letters are now issued within 2 working days of the request.'], ul: ['Request the letter in BoMesh Requests.', 'Pick it up at A1-108 with your student card.'] } }],
    [/bosch/i, { en: { p: ['UTE signed a partnership with Bosch Vietnam that opens 60 internship places a year for engineering students.', 'Applications open through the faculties at the start of each semester.'] } }],
    [/research week|nghiên cứu khoa học/i, {
      en: { p: ['Research week invites students to present posters on their research projects.'], ul: ['Submit your poster abstract by the end of week 9.', 'Posters are A0, portrait, in English or Vietnamese.', 'The best three posters in each faculty receive an award.'] },
      vi: { p: ['Nhà trường tổ chức Tuần lễ nghiên cứu khoa học sinh viên, mời sinh viên trình bày poster về đề tài nghiên cứu của mình.'], ul: ['Nộp tóm tắt poster trước cuối tuần 9.', 'Poster khổ A0, trình bày dọc, bằng tiếng Việt hoặc tiếng Anh.', 'Ba poster xuất sắc nhất của mỗi khoa được khen thưởng.'] } }],
    [/parking/i, { en: { p: ['Parking next to building A5 closes from next Monday for construction. Use the parking area behind building D.'], ul: ['Motorbike passes stay valid.', 'Allow extra time to walk to classes in building A5.'] } }],
  ];
  const KIND = {
    syllabus: (doc, c) => {
      const course = c.rest, credits = 2 + c.h % 3;
      return flow(doc, { title: `${c.code ? c.code + ' ' : ''}${course}`, sub: `Course syllabus · ${c.owner} · ${credits} credits · Approved ${c.date}`, secs: [
        { h: 'Course description', p: [c.lead || `Approved syllabus for ${course}.`, `${course} is a ${credits}-credit course taught over 15 weeks, with lectures, guided lab work and a team project.`] },
        { h: 'Learning outcomes', p: ['By the end of the course, students can:'], ul: [`Explain the core concepts and vocabulary of ${lc(course)}.`, `Apply ${lc(c.topic || course)} methods to small, well-defined engineering problems.`, 'Design, build and test a team project, and present the results.', 'Read technical material in English and write a clear report.'] },
        { h: 'Weekly plan', table: [['Weeks', 'Topic'], [['1–2', `Foundations of ${lc(course)}`], ['3–5', 'Core methods and worked examples'], ['6–7', 'Applied practice in the lab'], ['8', 'Midterm exam'], ['9–12', 'Advanced topics'], ['13–14', 'Team project and presentations'], ['15', 'Review']]] },
        { h: 'Assessment', p: ['The course is assessed through participation and quizzes (10%), labs and assignments (30%), a midterm exam (20%) and a final exam (40%).'], table: [['Component', 'Weight'], [['Participation and quizzes', '10%'], ['Labs and assignments', '30%'], ['Midterm exam', '20%'], ['Final exam', '40%']]], after: ['Students must score at least 4.0 out of 10 on the final exam to pass the course.', 'Students who miss more than 20% of classes can’t sit the final exam.'] },
        { h: 'Required readings', ul: [`Lecture notes for ${c.code || course}, published weekly on UTEx LMS.`, `A core textbook on ${lc(course)} chosen by the course coordinator.`, 'Papers and lab handouts listed in each week’s module.'] },
        { h: 'Course policies', ul: ['Late submissions lose 10% a day and aren’t accepted after three days.', 'Copying code or text without attribution is reported under the academic integrity rules.', 'Questions about grades go to the lecturer first, then to the Faculty office.'] },
      ] });
    },
    thesis: (doc, c) => {
      const title = c.base.replace(/\s+[—–-]\s+(MSc|BEng) thesis \d{4}$/, ''), msc = /MSc thesis/.test(c.base);
      const author = doc.author || doc.addedBy, year = doc.year || new Date(doc.updated).getFullYear();
      const t = c.r.topics.join(' '), metric = /t-ml|t-cropdisease|t-sensing/.test(t) ? 'accuracy' : /t-net/.test(t) ? 'detection rate' : /t-iot|t-elec|t-irrigation/.test(t) ? 'energy saving' : /t-mech/.test(t) ? 'task success rate' : /t-db/.test(t) ? 'query speed-up' : 'test coverage';
      const base = 68 + c.h % 14, prop = base + 4 + c.h % 9, sup = ['Assoc. Prof. Lê Văn Hùng', 'Dr. Phạm Thu Hà', 'Dr. Trương Quốc Bảo', 'Assoc. Prof. Nguyễn Thanh Sơn'][c.h % 4];
      return flow(doc, { title, sub: `${msc ? 'Master of Science' : 'Bachelor of Engineering'} thesis · ${author} · ${year} · Supervisor: ${sup}`, per: 1, secs: [
        { h: 'Abstract', p: [c.lead || `Thesis by ${author} (${year}): ${title}.`, `We build a working prototype, evaluate it against a baseline on data collected for this study, and report where it helps and where it doesn’t.`, `The proposed approach reaches ${prop}% ${metric}, compared with ${base}% for the baseline.`, ...(c.vi ? [`Tóm tắt: Luận văn nghiên cứu đề tài “${title}”. Phương pháp đề xuất đạt ${prop}% so với ${base}% của phương pháp cơ sở.`] : [])] },
        { h: 'Chapter 1 — Introduction', p: [`${title} matters for ${campus() ? 'universities, students and local industry' : 'the organisation'} in Vietnam, but existing solutions are costly or were built for other settings.`], ul: ['Objective 1: define the problem and collect a representative dataset.', 'Objective 2: design and implement an approach that fits local constraints.', `Objective 3: evaluate it against a baseline using ${metric}.`] },
        { h: 'Chapter 2 — Related work', p: ['Earlier work falls into rule-based systems, classical machine learning and recent deep-learning methods. Few studies use Vietnamese data or report results outside the lab.'] },
        { h: 'Chapter 3 — Method', p: ['Our method has three stages: we collected and cleaned the data, split it into training, validation and test sets, and tuned the system on the validation set.'], ul: ['Data collection and labelling.', 'Model or system design, tuned on the validation set.', 'Evaluation on the held-out test set, five runs each.'] },
        { h: 'Chapter 4 — Results', table: [['Approach', `Main result (${metric}, %)`], [['Baseline', String(base)], ['Proposed approach', String(prop)]]], after: [`Main result: the proposed approach improves ${metric} by ${prop - base} points over the baseline. Most errors come from rare cases that are under-represented in the data.`] },
        { h: 'Chapter 5 — Conclusion', p: ['The results show that the approach is feasible with modest resources and improves on the baseline.', 'Limitations: the data come from one setting and one period, and the test set is small.', 'Future work: collect more varied data and run a longer pilot with real users.'] },
      ] });
    },
    lecture: (doc, c) => {
      const subj = c.rest.split(/\s+[—–-]\s+/)[1] || c.rest;
      return flow(doc, { title: c.rest, sub: `${c.code ? c.code + ' · ' : ''}${c.owner}`, per: 1, cls: 'doc-page--slide', titlePage: true, spread: false, secs: [
        { h: 'Overview', p: [c.lead || `This lecture covers ${lc(subj)} and where it is used in practice.`] },
        { h: 'Learning goals', ul: [`Explain the key idea behind ${lc(subj)}.`, 'Work through a standard example step by step.', 'Spot common mistakes and check your answer.'] },
        { h: 'Key idea', p: [`${subj} starts from a few assumptions about the system. Write them down first, build the model from them, then check it against a simple case you can solve by hand.`] },
        { h: 'Worked example', ul: ['State what is known and what is asked.', 'Choose the model and write its equations.', 'Solve, then check units and orders of magnitude.', 'Interpret the result for the design decision.'] },
        { h: 'Common mistakes', ul: ['Mixing units between steps.', 'Using a formula outside the assumptions it was derived for.', 'Skipping the sanity check at the end.'] },
        { h: 'Self-check', ul: [`What assumptions does ${lc(subj)} rely on?`, 'Solve the worked example again with one input doubled. What changes, and why?', 'When would you not use this approach?'] },
      ] });
    },
    lab: (doc, c) => {
      const subj = c.rest.replace(/^Lab guide\s*[—–-]\s*/i, '');
      return flow(doc, { title: subj, sub: `${c.code ? c.code + ' · ' : ''}Lab guide · ${c.owner}`, secs: [
        { h: 'Objectives', p: [c.lead || `In this lab you practise ${lc(subj)}.`], ul: ['Set up the equipment correctly and safely.', 'Collect measurements and compare them with the theory.', 'Report results clearly, with sources of error.'] },
        { h: 'Preparation', ul: ['Read the lecture notes and prepare answers to the pre-lab questions.', 'Bring your lab notebook and student card.', 'Complete the safety induction for this lab before the session.'] },
        { h: 'Safety rules', ul: ['Wear safety glasses and closed shoes.', 'Ask the technician before switching on any machine or power supply.', 'Report any damage or accident immediately.'] },
        { h: 'Procedure', ul: ['Check the equipment against the list on the bench.', 'Set up as shown in the figure and ask the technician to check it.', 'Run the experiment and record each measurement in your notebook.', 'Repeat three times and compute the average.', 'Switch everything off and tidy the bench.'] },
        { h: 'Report', p: ['Submit a short report on UTEx LMS within one week of the session: setup, results, answers to the questions and sources of error.'] },
        { h: 'Assessment', table: [['Part', 'Weight'], [['Pre-lab questions', '20%'], ['Work in the lab', '40%'], ['Report', '40%']]] },
      ] });
    },
    announcement: (doc, c) => build(b => {
      const hit = NOTICE_TEXT.find(([re]) => re.test(c.base))?.[1];
      const body = (c.vi ? hit?.vi : hit?.en) || (c.vi
        ? { p: [`${c.subject}.`, 'Thông tin chi tiết được đăng trên ute.edu.vn và cổng thông tin sinh viên.'], after: ['Mọi thắc mắc xin liên hệ Phòng Đào tạo, phòng A1-102.'] }
        : { p: [`${c.subject}.`, `Details are published on ${c.r.source.key === 'upload' ? 'the intranet' : c.r.source.name}.`] });
      b.page(1).title(c.base, c.vi ? `ute.edu.vn · Ngày đăng ${viDate(doc.updated)}` : `${c.r.source.name} · Published ${c.date}`);
      if (c.lead) b.p(c.lead);
      body.p.forEach(x => b.p(x)); if (body.ul) b.ul(body.ul); (body.after || []).forEach(x => b.p(x));
      if (!c.vi && !body.after) b.p(`Questions: ${c.owner}.`);
    }),
    calendar: (doc, c) => flow(doc, { title: c.base.replace(/\s*\(.*\)$/, ''), sub: `${c.owner} · Updated ${c.date}`, per: 3, secs: [
      { h: 'Semester 1', p: [c.lead || 'Key dates for the academic year.'], table: [['What', 'When'], [['Classes start', 'Wednesday, 2 September 2026'], ['Course withdrawal closes', 'Tuesday, 10 November 2026 (end of week 10)'], ['Final exams', 'Weeks 17–19']]] },
      { h: 'Semester 2', table: [['What', 'When'], [['Course registration opens', 'Tuesday, 1 December 2026'], ['Classes start', 'Monday, 22 February 2027'], ['Final exams', 'Weeks 17–19']]] },
      { h: 'Holidays', ul: ['Lunar New Year: 9–20 February 2027.', 'Reunification Day and Labour Day: 30 April–1 May 2027.'] },
    ] }),
    policy: (doc, c) => {
      const safety = /safety/i.test(c.base);
      return flow(doc, { title: c.base, sub: `${c.org} · ${c.owner} · Updated ${c.date}`, secs: [
        { h: 'Purpose', p: [c.lead || `This policy sets out the rules for ${lc(c.subject)}.`] },
        { h: 'Who this applies to', p: [`This policy applies to ${people()} of ${c.org}${safety ? ' who use the workshop or lab, and to visitors under supervision' : ''}.`] },
        { h: 'Rules', ul: safety
          ? ['Wear safety glasses and closed shoes at all times; tie back long hair and remove loose clothing.', 'Use a machine only after its induction, once a technician signs you off.', 'Never work alone: at least two people must be present while machines are running.', 'Report every accident, near miss or damaged equipment to the technician immediately.']
          : ['Read this policy before making plans that depend on it.', `Send requests through the official channel named by ${c.owner}.`, 'Keep records and receipts for at least one year.', 'Exceptions need written approval from the policy owner.'] },
        { h: 'Deadlines', p: [safety ? 'Inductions must be completed before week 3 of the semester and are valid for 12 months.' : 'Requests must be submitted at least 5 working days in advance. The owner replies within 10 working days.'] },
        { h: 'Responsibilities', p: [`${c.owner} owns this policy, reviews it every year and answers questions about it.`] },
        { h: 'Contact', p: [`Questions go to ${c.owner}.`] },
      ] });
    },
    procedure: (doc, c) => flow(doc, { title: c.base, sub: `${c.owner} · Updated ${c.date}`, secs: [
      { h: 'Purpose', p: [c.lead || `The steps to follow for ${lc(c.subject.replace(/\s*(procedure|process)$/i, ''))}.`] },
      { h: 'Who can use it', p: [campus() ? 'Enrolled students and staff with an active account.' : 'All employees with an active account.'] },
      { h: 'Steps', ul: ['Check that you meet the conditions and gather the documents listed on the form.', `Submit the request in BoMesh Requests to ${c.owner}.`, `${c.owner} reviews it and replies within 3 working days.`, 'You get a notification when it’s approved, with any next steps.'] },
      { h: 'Timeline', p: ['Submit at least 5 working days before you need the outcome. Urgent requests are handled on a best-effort basis.'] },
      { h: 'Contact', p: [`${c.owner} — open a request or visit the office during working hours.`] },
    ] }),
    guide: (doc, c) => {
      const project = /capstone|project|thesis/i.test(c.base), intern = /internship/i.test(c.base);
      return flow(doc, { title: c.base, sub: `${c.owner} · Updated ${c.date}`, secs: [
        { h: 'Overview', p: [c.lead || `A practical guide to ${lc(c.subject.replace(/\s*(guide|handbook)$/i, ''))}.`] },
        { h: 'Before you start', ul: ['Check that the information is for the current semester or year.', `Have your ${campus() ? 'student or staff' : 'employee'} account ready.`, 'Note the deadlines in the timeline below.'] },
        { h: 'Key steps', ul: project
          ? ['Form a team of 2–4 students and find a supervisor by week 2.', 'Submit the project proposal by week 4.', 'Present progress at the midterm review in week 8.', 'Submit the final report and defend the project in week 15.']
          : intern
            ? ['Choose a host company from the faculty list or propose your own.', 'Get the internship agreement signed before you start.', 'Work at least 8 weeks and keep a weekly log.', 'Submit the internship report and the company’s evaluation within 2 weeks of finishing.']
            : ['Read each section once, then use the outline to jump to what you need.', 'Follow the steps in order and keep copies of what you submit.', `Ask ${c.owner} when something is unclear.`] },
        { h: 'Timeline', p: ['Plan at least four weeks ahead. Milestone dates are confirmed at the start of each semester.'] },
        { h: 'Where to get help', p: [`Contact ${c.owner}.`] },
      ] });
    },
    paper: (doc, c) => {
      const [authors, title] = c.base.includes(' — ') ? c.base.split(' — ') : ['', c.base];
      const base = 70 + c.h % 15, gain = 3 + c.h % 9;
      return flow(doc, { title, sub: [authors, c.r.kb?.name].filter(Boolean).join(' · '), secs: [
        { h: 'Abstract', p: [c.lead || `We study ${lc(title)}.`, `Compared with a strong baseline, our approach improves the main metric from ${base}% to ${base + gain}% on held-out field data.`] },
        { h: '1 Introduction', p: [`${c.topic || 'This problem'} is hard to solve in real conditions: data are noisy, labels are expensive and devices are limited.`] },
        { h: '2 Method', p: ['Our method: we collected data in the field, labelled it with domain experts and evaluated each model with 5-fold cross-validation.'], ul: ['Data: field samples from several sites and seasons.', 'Models: a published baseline and the proposed approach.', 'Metric: the main score on a held-out test set.'] },
        { h: '3 Results', table: [['Method', 'Main metric (%)'], [['Baseline', String(base)], ['Proposed', String(base + gain)]]], after: [`The main result: the proposed method gains ${gain} points over the baseline, with the largest gains under field conditions.`] },
        { h: '4 Discussion', p: ['Most remaining errors come from rare classes and poor lighting. Gains are smaller on clean lab data.'] },
        { h: '5 Limitations', p: ['The data come from one region and a short period, so results may not transfer to other conditions. The test set is small; differences under 2 points are not significant.'] },
      ] });
    },
    dataset: (doc, c) => flow(doc, { title: c.base, sub: `${c.owner} · Updated ${c.date}`, secs: [
      { h: 'Overview', p: [c.lead || `${c.subject}.`] },
      { h: 'Contents', table: [['Folder', 'What it holds'], [['images/', 'Labelled images, one folder per class'], ['labels.csv', 'File name, class, site, date and annotator'], ['splits/', 'Fixed train, validation and test splits'], ['README.md', 'Collection protocol and licence']]] },
      { h: 'How it was collected', p: ['Data were collected in the field following the lab protocol, then labelled by two annotators; disagreements were settled by a third.'] },
      { h: 'Licence and access', p: ['Members of the lab may use it for research. Sharing outside the lab needs written approval from the data owner.'] },
      { h: 'How to cite', p: [`Cite the dataset as: ${c.subject}, ${c.owner}, ${new Date(doc.updated).getFullYear()}.`] },
    ] }),
    protocol: (doc, c) => flow(doc, { title: c.base, sub: `${c.owner} · Updated ${c.date}`, secs: [
      { h: 'Purpose', p: [c.lead || `How to carry out ${lc(c.subject)} the same way every time.`] },
      { h: 'Materials', ul: ['Calibrated instruments listed in the lab inventory.', 'Data sheet and labels.', 'Protective equipment.'] },
      { h: 'Procedure', ul: ['Check and calibrate the instruments before each session.', 'Record site, date, time and conditions on the data sheet.', 'Collect samples following the sampling plan.', 'Upload the data to the lab drive on the same day.'] },
      { h: 'Safety and ethics', ul: ['Get the land owner’s consent before collecting on private plots.', 'Never work alone in the field.'] },
      { h: 'Records', p: ['Keep the signed data sheets for five years.'] },
    ] }),
    template: (doc, c) => flow(doc, { title: c.base, sub: `${c.owner} · Updated ${c.date}`, secs: [
      { h: 'How to use this template', p: [c.lead || 'Copy this template, fill in every section and delete the guidance text before you submit.'] },
      { h: 'Sections to complete', ul: ['Summary: one paragraph on what you propose and why.', 'Objectives and expected results.', 'Work plan and timeline.', 'Budget, with a justification for each line.', 'Team and responsibilities.'] },
      { h: 'Formatting', ul: ['Up to 10 pages, 12-point font.', 'Number every page and table.'] },
      { h: 'Submission', p: [`Submit the completed file to ${c.owner} before the internal deadline.`] },
    ] }),
    form: (doc, c) => flow(doc, { title: c.base, sub: `${c.owner} · Updated ${c.date}`, secs: [
      { h: 'Instructions', p: [c.lead || 'Fill in every field, sign the form and submit it to the office named below.'] },
      { h: 'Fields', table: [['Field', 'What to enter'], [['Full name', 'As on your ID card'], ['ID number', 'Student or staff number'], ['Item or request', 'What you need and why'], ['Dates', 'From and to'], ['Signature', 'Yours, and your supervisor’s if required']]] },
      { h: 'Submission', p: [`Submit the signed form to ${c.owner}. You get an answer within 3 working days.`] },
    ] }),
    report: (doc, c) => flow(doc, { title: c.base, sub: `${c.owner} · ${c.date}`, secs: [
      { h: 'Executive summary', p: [c.lead || `This report reviews ${lc(c.subject)}.`] },
      { h: 'Findings', ul: ['Most targets were met on time.', 'Two areas fell behind because of resourcing.', 'Feedback from users was mostly positive.'] },
      { h: 'Recommendations', ul: ['Keep the current approach where targets were met.', 'Add resources to the two areas that fell behind.', 'Review progress again next quarter.'] },
      { h: 'Next steps', p: [`${c.owner} will follow up on the recommendations by the next review.`] },
    ] }),
    reference: (doc, c) => flow(doc, { title: c.base, sub: `${c.owner} · Updated ${c.date}`, secs: [
      { h: 'Overview', p: [c.lead || `Reference material: ${lc(c.subject)}.`] },
      { h: 'Key information', ul: ['Check the version date before relying on the details.', 'Figures and contacts are correct as of the last update.'] },
      { h: 'Contacts', p: [`Questions go to ${c.owner}.`] },
    ] }),
  };
  KIND.handbook = KIND.guide;

  const SHEET = ['xlsx', 'xls', 'csv'], SLIDES = ['pptx', 'ppt'];
  function rendition(doc) {
    if (AUTHORED[doc.id]) return AUTHORED[doc.id]();
    // Answers saved from Requests or Overview: show the question and the answer as written.
    if (doc.faq) return build(b => { b.page(1).title(doc.faq.q, `${kbById(doc.kb)?.name || ''} · Answered by ${doc.addedBy} · ${fmtDate(doc.updated)}`).h('Answer'); String(doc.faq.a).split(/\n+/).filter(Boolean).forEach(p => b.p(p)); });
    const base = doc.name.replace(/\.[^.]+$/, ''), kb = kbById(doc.kb);
    if (SHEET.includes(doc.type)) return build(b => {
      if (/discount/i.test(base)) b.page(1).sheet(['Discount', 'Approver', 'How'], [['Up to 15%', 'Account executive', 'No approval needed'], ['15–25%', 'Regional sales director', 'Approve in the deal desk'], ['Over 25%', 'Chief Revenue Officer', 'Include a written business case'], ['Multi-year (+5%)', 'Same as above', 'On top of the base limit']], ['Discounts up to 15% may be approved by the account executive. Discounts between 15% and 25% require approval from the regional sales director.'], ['Guidelines']);
      else if (/pipeline/i.test(base)) b.page(1).sheet(['Account', 'Stage', 'Amount (USD)', 'Close date', 'Owner'], [['Acme Corp', 'Negotiation', 186000, 'Oct 30', 'Minh Pham'], ['Fabrikam', 'Proposal', 92000, 'Nov 14', 'Lan Do'], ['Tailspin Travel', 'Discovery', 48000, 'Dec 5', 'Minh Pham'], ['Woodgrove Bank', 'Negotiation', 240000, 'Nov 28', 'Kevin Ng'], ['Litware Labs', 'Qualified', 18000, 'Dec 19', 'Lan Do'], ['Contoso Legal', 'Proposal', 64000, 'Nov 7', 'Minh Pham']], [], ['September']);
      else b.page(1).sheet(['Item', 'Owner', 'Status', 'Updated'], ['Kick-off', 'Review scope', 'Collect inputs', 'Draft', 'Feedback round', 'Final version', 'Share with team', 'Archive'].map((x, i) => [x, ['An Nguyen', 'Ben Walker', 'Mai Hoang', 'Linh Tran'][i % 4], i < 5 ? 'Done' : 'Open', `Sep ${3 + i * 3}`]), doc.summary ? [doc.summary] : [], ['Sheet1']);
    });
    const kind = res(doc).kind;
    if (!GENERIC[doc.kb] && KIND[kind]) return KIND[kind](doc, ctxOf(doc));
    const secs = (GENERIC[doc.kb] || GENERIC.default)(base);
    // The summary leads, so snippets and answers start from what the resource is about.
    if (doc.summary) secs[0] = [secs[0][0], [doc.summary, ...(secs[0][1] || [])], secs[0][2]];
    if (SLIDES.includes(doc.type)) return build(b => {
      b.page(1, 'doc-page--slide').title(base, `${curWs().name} · ${kb?.name || ''}`);
      secs.forEach((s, i) => { b.page(i + 2, 'doc-page--slide').h(s[0]); if (s[1]) s[1].forEach(x => b.p(x)); if (s[2]) b.ul(s[2]); });
    });
    return build(b => {
      const per = Math.max(1, Math.ceil(secs.length / Math.min(doc.pages || 1, 2)));
      secs.forEach((s, i) => { if (i % per === 0) { b.page(Math.floor(i / per) + 1); if (!i) b.title(base, `${kb?.name || ''} · Updated ${fmtDate(doc.updated)}`); } b.h(s[0]); if (s[1]) s[1].forEach(x => b.p(x)); if (s[2]) b.ul(s[2]); });
    });
  }
  /** Rendition of a resource: { pages:[{no, cls, html}], outline:[{id, title, page}], text, blocks:[{page, heading, text, quote}] }.
      Demo workspaces mark the first page as fictional (HTML only — not part of the text). */
  function model(doc) {
    const m = rendition(doc);
    if (isDemoWs() && m.pages[0]) m.pages[0].html += `<p class="doc-demo">${ic('info', 'i-xs')}<span>Demo document — fictional content for the BoMesh prototype.</span></p>`;
    return m;
  }
  X.docModel = model;
  /** Plain text of a readable document (search snippets, answers). */
  X.docText = doc => (isSearchable(doc) ? rendition(doc).text.replace(/\s+/g, ' ').trim() : '');
})();
