/* Documents: shared document operations (publishing, replace, move,
   archive, download) and the rendition model — the readable text of a
   resource, split into pages, outline and passages — used by the reader
   (reader.js), the review preview (curation.js), search snippets and answers.
   The document inventory itself lives in Manage → Documents (curation.js).
   Exports: X.whoCanSee, X.downloadDocument, X.processDocs, X.archiveDocs,
   X.docFix, X.docModel, X.docText. */
(() => {
  'use strict';

  /* ── Small helpers ── */
  function audit(action, target) {
    D.audit.unshift({ id: uid('ev'), at: Date.now(), actor: me().id, action, type: 'Knowledge', target, outcome: 'success', ip: '10.4.12.30', device: 'Chrome on macOS' });
  }
  const byYou = d => d.addedBy === 'You' || d.addedBy === me().name;
  function docSub(d) {
    const src = d.source && d.source !== 'upload' ? srcById(d.source) : null;
    return src ? src.name : `Uploaded by ${byYou(d) ? 'you' : d.addedBy}`;
  }
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
    const rows = [['Document', doc.name], ['Knowledge base', kb?.name || doc.kb], ['Status', lifecycleOf(doc).label], ['Type', String(doc.type || '').toUpperCase()], ['Pages', doc.pages || '—'], ['Updated', fmtDateTime(doc.updated)], ['Source', docSub(doc)]];
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
    // Publishing = processing. Submissions are processed only after a reviewer approves them (core/lifecycle.js).
    docs = docs.filter(d => d && !d.archived && isPublishedStage(d) && d.status !== 'unsupported' && d.status !== 'processing');
    if (!docs.length) return 0;
    docs.forEach(d => { d.status = 'processing'; });
    const own = d => !!kbById(d.kb)?.personal;
    audit(docs.every(own) ? (docs.length === 1 ? 'Prepared a private file' : `Prepared ${plural(docs.length, 'private file')}`) : docs.length === 1 ? 'Published a document' : `Published ${plural(docs.length, 'document')}`, kbById(docs[0].kb)?.name || docs[0].name);
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
      // Private files (My files) are never published: they're "ready" for their owner.
      const okOwn = ok.filter(own), okPub = ok.filter(d => !own(d));
      const done = (list, verb) => list.length && toast(list.length === 1 ? `${list[0].name} is ${verb}` : `${plural(list.length, list === okOwn ? 'file' : 'document')} are ${verb}`, { action: list.length === 1 ? { label: 'Open', run: () => go('/doc/' + list[0].id) } : undefined });
      done(okPub, 'published'); done(okOwn, 'ready');
      bad.forEach(d => toast(own(d) ? `Couldn’t prepare ${d.name}` : `Couldn’t publish ${d.name}`, { tone: 'danger', action: { label: own(d) ? 'Open' : 'Review', run: () => go(!own(d) && can('knowledge.manage') && canReviewKb(kbById(d.kb)) ? '/documents?tab=all&life=attention' : '/doc/' + d.id) } }));
    }, 2600);
    return docs.length;
  }
  X.processDocs = processDocs;
  A['doc-process'] = el => {
    const d = docById(el.dataset.id); if (!d) return;
    processDocs([d], { msg: `${d.status === 'pending' ? 'Publishing' : 'Republishing'} ${d.name}` });
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
      processDocs([d], { msg: `Publishing the new version of ${d.name}` });
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
        onDone?.(); refresh();
        const kbName = kbById(docs[0].kb)?.name;
        audit(one ? 'Archived document' : `Archived ${plural(docs.length, 'document')}`, one ? docs[0].name : kbName);
        toast(one ? `Archived “${docs[0].name}”` : `Archived ${plural(docs.length, 'document')}`, { action: { label: 'Undo', run: () => { docs.forEach(d => (d.archived = false)); refresh(); toast(one ? `Restored “${docs[0].name}”` : `Restored ${plural(docs.length, 'document')}`); } } });
      },
    });
  }
  X.archiveDocs = archiveDocs;

  const moveTargets = from => visibleKbs().filter(k => k.id !== from && !k.personal && canEditKb(k));
  A['doc-move'] = el => {
    const ids = (el.dataset.ids || el.dataset.id || '').split(',').filter(Boolean); if (!ids.length) return;
    const from = docById(ids[0])?.kb, targets = moveTargets(from);
    // One possible destination is the obvious choice; with several, the caller picks on purpose.
    setPath('docMove', { to: targets.length === 1 ? targets[0].id : '', tried: false });
    openModal('doc-move', { ids, from });
  };
  M['doc-move'] = ({ ids, from }) => {
    const targets = moveTargets(from), f = ui('docMove'), n = ids.length, src = kbById(from);
    const title = n === 1 ? 'Move document' : `Move ${plural(n, 'document')}`;
    if (!targets.length) return { title, icon: 'folder', size: 'sm', body: emptyState({ icon: 'folder', title: 'Nowhere to move it', desc: 'There’s no other knowledge base you can edit.', compact: true }), foot: btn('Close', { v: 'primary', act: 'close-modal' }) };
    const err = f.tried && !f.to ? 'Choose a knowledge base.' : '';
    const opt = k => {
      const w = X.whoCanSee(k);
      return `<label class="radio mv-opt"><input type="radio" name="doc-move-to" value="${esc(k.id)}" ${f.to === k.id ? 'checked' : ''} data-change="doc-move-pick" data-value="${esc(k.id)}"><span class="radio__control" aria-hidden="true"></span>${X.kbMark ? X.kbMark(k, 24) : ''}<span class="grow"><span class="radio__label mv-opt__name">${esc(k.name)}</span><span class="radio__desc mv-opt__who">${ic(w.icon, 'i-xs')}<span class="truncate">${esc(w.label)}</span></span></span></label>`;
    };
    return {
      title, icon: 'folder', size: 'md',
      desc: n === 1 ? `“${esc(docById(ids[0])?.name || '')}” · from ${esc(src?.name || '')}` : `From ${esc(src?.name || '')}`,
      body: `<div class="field"><span class="label" id="doc-move-label">Move to</span><div class="option-list mv-list" role="radiogroup" aria-labelledby="doc-move-label" ${err ? 'aria-invalid="true" aria-describedby="doc-move-err"' : ''}>${targets.map(opt).join('')}</div>${err ? `<div class="field-error" id="doc-move-err" role="alert">${ic('alert-circle')}<span>${esc(err)}</span></div>` : `<div class="description">Who can see ${n === 1 ? 'it' : 'them'} follows the new knowledge base.</div>`}</div>`,
      footStart: 'You can undo right after.',
      foot: btn('Cancel', { v: 'ghost', act: 'close-modal' }) + btn('Move', { v: 'primary', icon: 'folder', act: 'doc-move-go' }),
    };
  };
  A['doc-move-pick'] = el => { const f = ui('docMove'); f.to = el.dataset.value; refreshLayer(); };
  A['doc-move-go'] = () => {
    const { ids, from } = S.modal.props, f = ui('docMove'), target = kbById(f.to);
    if (!target) { f.tried = true; refreshLayer(); $('#layer .mv-list input')?.focus(); return; }
    const docs = ids.map(docById).filter(Boolean);
    docs.forEach(d => (d.kb = target.id)); target.updated = Date.now();
    closeModal(); S.drawer = null; refresh();
    audit(`Moved ${plural(docs.length, 'document')}`, target.name);
    toast(`Moved ${plural(docs.length, 'document')} to ${target.name}`, { action: { label: 'Undo', run: () => { docs.forEach(d => (d.kb = from)); refresh(); toast(`Moved ${plural(docs.length, 'document')} back`); } } });
  };

  /** The fix an editor can apply to a file that isn't readable (or changed at the source); '' when none. */
  X.docFix = (d, { v = 'secondary', size } = {}) => {
    const b = (label, icon, act) => btn(label, { v, size, icon, act, data: { id: d.id } });
    const own = kbById(d.kb)?.personal;
    // A new file only for uploads; a synced file is fixed at its source, then tried again.
    if (d.status === 'failed') return stillLocked(d) && res(d).source.key === 'upload' ? b('Replace file', 'upload', 'doc-replace') : b('Try again', 'retry', 'doc-process');
    if (d.status === 'pending') return b(own ? 'Make searchable' : 'Publish now', 'play', 'doc-process');
    if (d.status === 'outdated') return b(own ? 'Update' : 'Publish update', 'retry', 'doc-process');
    return '';
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
  /** Vendor evaluations for the event streaming review: findings on pages 3–7 (throughput, exactly-once, operations, residency, cost). */
  function evalDoc(title, what, [perf, eos, ops, res, cost], verdict) {
    return build(b => {
      b.page(1).title(title, `Core Banking Modernization · Platform Engineering · ${what} · Prepared by Nguyễn Hoàng Nam and Trần Minh Khoa`)
        .h('Summary').p(verdict)
        .p('This evaluation supports the decision in ADR-027: ledger balances change only through events, so the streaming platform carries every payment.');
      b.page(2).h('How we evaluated').p('We replayed 40 payment event types from production traffic at three times the 2026 Tết peak, with the same producers and consumers on every platform.')
        .ul(['Throughput and p99 latency at peak.', 'Exactly-once delivery for ledger consumers.', 'Effort for the platform team to run it.', 'Where the data is stored.', 'Total cost over three years.']);
      b.page(3).h('Throughput at peak').p(perf);
      b.page(4).h('Exactly-once support').p(eos);
      b.page(5).h('Operations effort').p(ops);
      b.page(6).h('Data residency').p(res).p('Payment events contain customer account numbers, so hosting them outside Vietnam needs a cross-border transfer assessment under Decree 13/2023.');
      b.page(7).h('Three-year cost').p(cost);
      b.page(8).h('Recommendation').p(verdict).p('Final choice is made by the CBM steering committee after the residency assessment.');
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
    /* ── Finx Workspace (fictional digital bank) ── */
    'fx-sec-access': () => build(b => {
      b.page(1).title('Access Control Policy', 'Finx · Risk & Compliance · Version 5, effective 1 July 2026 · Owner: Võ Thị Lan')
        .h('Purpose').p('This policy sets out how Finx grants, uses and removes access to its systems, so that customer funds and data are protected and every access can be explained to auditors and the State Bank of Vietnam.')
        .h('Scope').p('It applies to all employees, contractors and service accounts that access Finx systems, including the payments gateway, the ledger service, core banking databases and the data platform.');
      b.page(2).h('Principles').ul(['Least privilege: people get only the access their role needs.', 'Separation of duties: nobody approves their own access or their own change.', 'Every access is personal, logged and reviewed.'])
        .h('Access levels').table(['Level', 'Examples', 'Approved by'], [['Standard', 'Email, wiki, ticketing', 'Line manager (automatic on joining)'], ['Elevated', 'Staging, non-production data', 'System owner'], ['Production', 'Payments gateway, ledger, core banking DB', 'System owner and change approver']]);
      b.page(3).h('Production access').p('Production access is granted just in time for a maximum of 8 hours and requires an approved change ticket.')
        .p('Engineers must complete the Secure Coding training before receiving any production access.')
        .p('Requests are sent through BoMesh Requests to the IT Service Desk. Access ends automatically when the window closes; it is never extended silently — open a new request instead.')
        .p('Standing production access is not allowed, except for break-glass accounts held by the SRE on-call lead.');
      b.page(4).h('Break-glass access').p('Break-glass accounts may be used only during a declared Severity 1 or Severity 2 incident. Every use is reviewed by Risk & Compliance within 2 business days.');
      b.page(5).h('Access reviews').p('System owners review every access right each quarter and revoke access that is no longer needed.')
        .p('Access of leavers is removed on their last working day; access of movers is re-approved within 5 business days of the move.');
      b.page(6).h('Exceptions and breaches').p('Exceptions need a Policy exception request with a named risk owner and an end date of at most 90 days.')
        .p('Sharing credentials or bypassing just-in-time access is a disciplinary matter under the Code of Conduct.');
    }),
    'fx-sec-incident': () => build(b => {
      b.page(1).title('Incident Response Plan', 'Finx · Risk & Compliance with Site Reliability Engineering · Version 4 · Reviewed September 2026')
        .h('Purpose').p('How Finx detects, declares, handles and learns from incidents that affect customers, funds, data or regulatory obligations.')
        .h('Severity levels').table(['Severity', 'Meaning', 'Example'], [['Sev 1', 'Customers cannot pay or funds are at risk', 'Card authorization down, wrong ledger postings'], ['Sev 2', 'Major feature degraded for many customers', 'QR payments failing for one bank'], ['Sev 3', 'Limited impact, workaround exists', 'Slow statement downloads']]);
      b.page(2).h('Declaring an incident').p('A Severity 1 incident must be declared in the #incident channel within 15 minutes of detection.')
        .ul(['The on-call engineer who detects it becomes the first incident commander.', 'Open the incident in the status tool; it creates the timeline and pages the SRE lead.', 'Post an update in #incident every 30 minutes until the incident is mitigated.']);
      b.page(3).h('Roles').ul(['Incident commander: coordinates the response and decides on mitigations.', 'Communications lead: updates Customer Care, status page and leadership.', 'Scribe: keeps the timeline for the postmortem.']);
      b.page(4).h('Regulatory notification').p('When customer funds are affected, Risk & Compliance notifies the State Bank of Vietnam within 24 hours.')
        .p('Personal data breaches are also reported to the Ministry of Public Security under Decree 13/2023 within 72 hours. Risk & Compliance drafts both notices; the CEO signs them.');
      b.page(5).h('After the incident').p('Every Sev 1 and Sev 2 incident gets a blameless postmortem within 5 business days, with owners and due dates for each follow-up action.');
    }),
    'fx-sec-vendor': () => build(b => {
      b.page(1).title('Third-party & SaaS Risk Standard', 'Finx · Risk & Compliance · Version 2')
        .h('Purpose').p('How Finx assesses vendors and SaaS tools before buying them, so customer data and payment systems stay protected.');
      b.page(2).h('When an assessment is needed').p('Any new software or SaaS tool that stores or processes customer data needs a vendor security assessment by Risk & Compliance before purchase.')
        .ul(['Request it through BoMesh Requests (IT Service Desk → New software or SaaS tool).', 'Attach the vendor’s SOC 2 Type II report or ISO 27001 certificate.', 'Tools without customer data need only IT Service Desk approval.']);
      b.page(3).h('Data location').p('Customer data must be stored in Vietnam unless a cross-border transfer assessment under Decree 13/2023 has been approved.');
      b.page(4).h('Review').p('Approved vendors are reassessed every year, or sooner after a security incident at the vendor.');
    }),
    'fx-sec-exception': () => build(b => {
      b.page(1).title('Policy Exception Procedure', 'Finx · Risk & Compliance')
        .h('Rule').p('Policy exceptions are time-limited to at most 6 months and need written sign-off from the accountable risk owner.')
        .ul(['State the policy, the reason and the compensating controls.', 'Name the risk owner and the end date.', 'Risk & Compliance records the exception in the risk register.']);
      b.page(2).h('Renewal').p('An exception can be renewed once. After that, the system must comply or the policy must change.');
    }),
    'fx-sec-privacy': () => build(b => {
      b.page(1).title('Customer Data Protection Standard', 'Finx · Risk & Compliance · Version 3 · Implements Decree 13/2023 on personal data protection')
        .h('Purpose').p('The controls every team applies to customer personal data: names, national ID numbers, phone numbers, addresses, account and card data.');
      b.page(2).h('Non-production environments').p('Customer personal data is masked by default in every non-production environment.')
        .ul(['Test data is generated or masked by the data platform pipeline before it reaches staging.', 'Card numbers are never copied outside the PCI cardholder data environment.', 'Screenshots with customer data must not be posted in chat channels or tickets.']);
      b.page(3).h('Access to unmasked data').p('Access to unmasked customer data requires an approved PII access request and the Data privacy training.')
        .p('Requests go to Risk & Compliance through BoMesh Requests and state the purpose, the tables needed and an end date. Access is granted for at most 30 days.');
      b.page(4).h('Retention and deletion').table(['Data', 'Kept for'], [['Transaction records', '10 years'], ['KYC documents', '5 years after the account closes'], ['Call recordings', '2 years'], ['Marketing consent logs', 'As long as consent is active, plus 2 years']]);
    }),
    'fx-sec-pci': () => build(b => {
      b.page(1).sheet(['Req.', 'Control', 'Owner', 'Evidence', 'Status'], [
        ['1.2.1', 'Network security controls restrict traffic to the CDE', 'Platform Engineering', 'Firewall rule review Q3', 'Effective'],
        ['3.5.1', 'PAN rendered unreadable wherever stored', 'Payments Platform', 'Tokenization design + DB scan', 'Effective'],
        ['6.4.3', 'Payment page scripts authorized and inventoried', 'Payments Platform', 'Script inventory export', 'In progress'],
        ['7.2.4', 'User accounts and access reviewed every 6 months', 'Risk & Compliance', 'Quarterly access review sign-off', 'Effective'],
        ['8.4.2', 'MFA for all access into the CDE', 'IT Service Desk', 'IdP policy report', 'Effective'],
        ['10.4.1', 'Audit logs reviewed daily', 'Security Operations', 'SIEM daily review tickets', 'Effective'],
        ['11.3.1', 'Internal vulnerability scans every 3 months', 'Security Operations', 'Scan reports Q2–Q3', 'Effective'],
        ['12.10.1', 'Incident response plan in place and tested', 'Risk & Compliance', 'Tabletop exercise, Aug 2026', 'Effective'],
        ['12.6.1', 'Security awareness training for all staff', 'People & Culture', 'Training completion report', 'Gap: 6% overdue'],
      ], ['PCI DSS v4.0 control matrix — 64 requirements tracked; 9 shown. Fieldwork for the 2026 assessment starts in November.'], ['Controls', 'Evidence log', 'Gaps'], 'Showing 9 of 64 rows');
    }),
    'fx-ops-cutoff': () => build(b => {
      b.page(1).title('Payment Cut-off Times & Settlement Windows', 'Finx · Banking Operations · Updated October 2026')
        .h('Real-time transfers').p('NAPAS 247 interbank transfers settle in real time, 24 hours a day.')
        .p('Transfers between Finx accounts are booked instantly at any time, including weekends and public holidays.');
      b.page(2).h('Batch transfers and cut-offs').p('Batch transfers submitted after 15:30 are settled on the next business day.')
        .table(['Channel', 'Cut-off (ICT)', 'Settlement'], [['NAPAS 247 (up to VND 500 million)', 'None', 'Real time'], ['Interbank batch (CITAD)', '15:30', 'Same business day'], ['Salary and bulk payouts', '14:00', 'Same business day'], ['Card settlement with schemes', '23:00', 'Next business day (T+1)'], ['QR merchant payouts', '22:00', 'Next business day']]);
      b.page(3).h('Holidays').p('During Tết and other public holidays only NAPAS 247 and internal transfers run. Batches queue until the first business day after the holiday.');
    }),
    'fx-ops-dispute': () => build(b => {
      b.page(1).title('Card Dispute Handling Procedure', 'Finx · Banking Operations · Cards & Disputes · Version 2')
        .h('Purpose').p('How Banking Operations handles a cardholder’s disputed card transaction, from intake to chargeback and closure.');
      b.page(2).h('Timelines').p('A cardholder dispute must be acknowledged within 2 business days and resolved within 45 days.')
        .ul(['Log the dispute in the case tool with the transaction ID and the cardholder’s statement.', 'Block the card if the customer reports fraud.', 'Give provisional credit within 10 business days for fraud disputes above VND 2 million.']);
      b.page(3).h('Chargebacks').table(['Reason', 'Scheme deadline', 'Evidence'], [['Fraud — card not present', '120 days', 'Cardholder declaration'], ['Goods not received', '120 days', 'Merchant contact attempt'], ['Duplicate processing', '90 days', 'Both transaction records']]);
      b.page(4).h('Closing a case').p('Tell the customer the outcome in writing, reverse or confirm the provisional credit and attach all evidence to the case.');
    }),
    'fx-ops-recon': () => build(b => {
      b.page(1).title('Daily Reconciliation Runbook', 'Finx · Banking Operations · Reconciliation team')
        .h('When').p('Run every business day at 07:30, after the overnight NAPAS and card scheme settlement files arrive.')
        .h('Steps').ul(['Check that all settlement files (NAPAS, Visa, Mastercard, QR partners) arrived in the recon bucket.', 'Run the matching job in the reconciliation tool for the previous business day.', 'Review unmatched items above VND 10 million first.', 'Assign each break to an owner with a reason code.', 'Post the summary in #ops-recon by 10:00.']);
      b.page(2).h('Breaks').table(['Break type', 'Usual cause', 'Owner'], [['Missing in ledger', 'Late event from the gateway', 'Payments Platform on-call'], ['Missing in scheme file', 'Reversal not settled yet', 'Reconciliation'], ['Amount mismatch', 'FX or fee difference', 'Finance']])
        .p('Breaks open longer than 3 business days are escalated to the Banking Operations lead.');
    }),
    'fx-eng-adr031': () => build(b => {
      b.page(1).title('ADR-031 — Idempotency keys for payment APIs', 'Status: Accepted · Payments Platform · Deciders: Lê Thu Hà, Trần Minh Khoa, Nguyễn Hoàng Nam')
        .h('Context').p('Mobile clients retry payment requests on network timeouts. Without idempotency a retry can debit a customer twice; the October incident review found 37 duplicate QR payments in one week.')
        .h('Decision').p('Every POST to a payment API must carry an Idempotency-Key header.')
        .ul(['Clients generate a UUID v4 per payment intent and reuse it for every retry.', 'Requests without the header are rejected with 400 Bad Request.', 'A key reused with a different request body returns 409 Conflict.']);
      b.page(2).h('Storage').p('The gateway stores the first response for 24 hours and replays it for any retry with the same key.')
        .p('Keys live in the gateway’s Redis cluster, scoped per merchant or per customer.')
        .h('Consequences').ul(['Retries are safe for clients, partners and our own jobs.', 'Every payment API needs a contract test for repeated keys.', 'Redis memory grows with traffic; the 24-hour TTL keeps it bounded.']);
    }),
    'fx-eng-adr027': () => build(b => {
      b.page(1).title('ADR-027 — Event-driven ledger updates', 'Status: Accepted · Core Banking Modernization · Deciders: Lê Thu Hà, Nguyễn Hoàng Nam')
        .h('Context').p('Services wrote directly to ledger tables, so balances could change without an auditable event and reconciliation found breaks every day.')
        .h('Decision').p('Ledger balances are updated only by consuming events from the payments topic, never by direct writes.')
        .ul(['Producers publish PaymentPosted, PaymentReversed and FeeCharged events.', 'The ledger service is the only consumer allowed to change balances.', 'Events are kept for 7 days on the stream and forever in the event archive.']);
      b.page(2).h('Consequences').p('Ledger consumers must process each event exactly once, so the streaming platform must support exactly-once delivery or idempotent consumption.')
        .p('Choosing the streaming platform is tracked in the event streaming evaluation.');
    }),
    'fx-eng-handbook': () => build(b => {
      b.page(1).title('Engineering Handbook 2026', 'Finx · Platform Engineering')
        .h('How we work').p('Small teams own services end to end: design, build, run and fix. This handbook is the shared baseline; team pages add details.');
      b.page(4).h('Code review').ul(['Every change to production code needs one approving review from someone other than the author.', 'Changes to payment flows also need a reviewer from Payments Platform.', 'Keep pull requests under 400 changed lines where possible.']);
      b.page(9).h('Releases').p('Production deploys run Monday to Thursday, 09:00–16:00. Deploys outside that window need an approved emergency change.')
        .p('A change freeze applies from 7 days before Tết until 3 days after it.');
      b.page(14).h('On-call').p('Each service team runs a weekly on-call rotation. On-call engineers acknowledge a page within 5 minutes and follow the service runbook.');
      b.page(22).h('Architecture decisions').p('Significant decisions are written as ADRs in the Engineering wiki and reviewed in the weekly architecture forum.');
    }),
    'fx-eng-eval-kafka': () => evalDoc('Evaluation — Confluent Cloud (Kafka)', 'Managed Apache Kafka on Confluent Cloud', [
      'In our load test Confluent Cloud sustained 180,000 messages per second at a p99 latency of 42 ms.',
      'Idempotent producers and transactions give exactly-once delivery between Kafka topics out of the box.',
      'Brokers, upgrades and scaling are run by the vendor; our team only manages topics, ACLs and connectors.',
      'The nearest Confluent Cloud region is Singapore; no region is available in Vietnam.',
      'The estimated three-year cost is USD 1.26 million, including support and private networking.',
    ], 'Strongest on throughput and operations effort; data residency needs a cross-border transfer assessment before payment events can leave Vietnam.'),
    'fx-eng-eval-pulsar': () => evalDoc('Evaluation — Apache Pulsar (self-hosted)', 'Self-hosted Apache Pulsar in Finx data centers', [
      'On six bare-metal brokers in our Ho Chi Minh City data center, Pulsar sustained 150,000 messages per second at a p99 latency of 55 ms.',
      'Exactly-once processing requires Pulsar transactions, which our client libraries support only for Java.',
      'Running Pulsar needs BookKeeper and ZooKeeper clusters; we estimate 2.5 full-time engineers to operate it.',
      'All data stays in Finx\'s own data centers in Hanoi and Ho Chi Minh City.',
      'Hardware, monitoring licences and staff time come to an estimated USD 0.94 million over three years.',
    ], 'Cheapest and the only option that keeps data in Vietnam, but our Go services would not get exactly-once processing and operations effort is the highest.'),
    'fx-eng-eval-msk': () => evalDoc('Evaluation — Amazon MSK', 'Amazon Managed Streaming for Apache Kafka', [
      'A six-broker MSK cluster sustained 160,000 messages per second at a p99 latency of 48 ms.',
      'MSK runs open-source Apache Kafka, so idempotent producers and transactions work as in any Kafka cluster.',
      'AWS patches brokers, but partition rebalancing, upgrades and capacity planning remain our responsibility.',
      'AWS has no region in Vietnam; the nearest are Singapore and Jakarta.',
      'The estimated three-year cost is USD 1.02 million with reserved brokers.',
    ], 'A middle option: standard Kafka semantics at a lower cost than Confluent, with more operations work and the same residency question.'),
    'fx-pay-runbook': () => build(b => {
      b.page(1).title('Runbook — Payment gateway timeouts', 'Payments Platform · On-call · Alert: gateway_timeout_rate_high')
        .h('Symptoms').p('Card authorizations or QR payments return 504 from the gateway; the timeout-rate panel on the Payments Gateway dashboard turns red.')
        .h('Decide').p('If the timeout rate exceeds 2% for 5 minutes, fail over card authorization to the secondary acquirer.')
        .ul(['Acknowledge the page within 5 minutes.', 'Check the acquirer status panel: is one acquirer or all traffic affected?', 'If it is a Severity 1, declare it in #incident.']);
      b.page(2).h('Fail over').ul(['Run `payctl failover --service card-auth --to secondary` from the bastion.', 'Watch the timeout rate fall below 0.5% within 3 minutes.', 'Tell Customer Care in #cs-payments that cards are on the secondary acquirer.'])
        .h('Fail back').p('Fail back only after the primary acquirer confirms recovery and its health check has been green for 30 minutes.');
    }),
    'fx-pay-api': () => build(b => {
      b.page(1).title('Payments API reference v3', 'Payments Platform · Base URL https://api.finx.vn/payments/v3')
        .h('Authentication').p('Partners authenticate with OAuth 2.0 client credentials and mutual TLS. Tokens expire after 15 minutes.')
        .h('Idempotency').p('Every POST request carries an Idempotency-Key header, as decided in ADR-031.');
      b.page(2).h('Endpoints').table(['Method', 'Path', 'What it does'], [['POST', '/payments', 'Create a payment (card, NAPAS 247 or QR)'], ['GET', '/payments/{id}', 'Get a payment and its status'], ['POST', '/payments/{id}/refunds', 'Refund all or part of a payment'], ['POST', '/qr-codes', 'Create a dynamic VietQR code']]);
      b.page(3).h('Errors and limits').table(['Code', 'Meaning'], [['400', 'Invalid request or missing Idempotency-Key'], ['409', 'Idempotency-Key reused with a different body'], ['429', 'Rate limit: 300 requests per second per partner'], ['504', 'Upstream acquirer timeout — safe to retry with the same key']]);
    }),
    'fx-pay-postmortem': () => build(b => {
      b.page(1).title('Postmortem — QR payments outage, 14 Oct', 'Payments Platform · Severity 1 · Blameless')
        .h('Summary').p('From 19:42 to 20:31 ICT on 14 October, 61% of QR payments failed after a certificate on the VietQR partner connection expired. About 48,000 customers were affected; no funds were lost.');
      b.page(2).h('Timeline').table(['Time', 'Event'], [['19:42', 'Partner certificate expires; QR failures start'], ['19:49', 'Alert fires; on-call acknowledges'], ['19:55', 'Severity 1 declared in #incident'], ['20:24', 'New certificate deployed'], ['20:31', 'Success rate back to normal']]);
      b.page(3).h('Actions').ul(['Alert 30 days before any partner certificate expires (owner: Nguyễn Hoàng Nam).', 'Add certificate expiry to the weekly on-call checklist (owner: Đặng Quốc Huy).', 'Notify the State Bank of Vietnam: not required — no customer funds were affected.']);
    }),
    'fx-data-mau': () => build(b => {
      b.page(1).title('Metric definitions — Active customers', 'Data Platform · Metric owner: Phạm Quốc Bảo · Certified metric')
        .h('Monthly active customers (MAC)').p('A monthly active customer has at least one customer-initiated financial transaction in the calendar month; logins alone do not count.')
        .ul(['Counts: transfers, card payments, QR payments, bill payments, top-ups.', 'Does not count: interest postings, fees, refunds and other bank-initiated entries.', 'Customers are de-duplicated across app and web by customer ID.']);
      b.page(2).h('Related metrics').table(['Metric', 'Definition', 'Table'], [['Daily active customers', 'Same rule, per calendar day (ICT)', 'mart.customer_activity_daily'], ['Engaged customers', 'At least 5 qualifying transactions in the month', 'mart.customer_activity_monthly'], ['Dormant customers', 'No qualifying transaction for 90 days', 'mart.customer_status']])
        .p('Use the certified tables above; dashboards built on raw login events will not match board reporting.');
    }),
    'fx-data-dict': () => build(b => {
      b.page(1).sheet(['Table', 'Column', 'Type', 'Description', 'PII'], [
        ['dwh.customer', 'customer_id', 'STRING', 'Stable customer key across channels', 'No'],
        ['dwh.customer', 'national_id', 'STRING', 'CCCD number — masked outside production', 'Yes'],
        ['dwh.customer', 'kyc_level', 'INT', 'eKYC level 1–3', 'No'],
        ['dwh.account', 'account_no', 'STRING', 'Finx account number', 'Yes'],
        ['dwh.account', 'status', 'STRING', 'open, frozen, dormant, closed', 'No'],
        ['dwh.transaction', 'txn_id', 'STRING', 'Ledger transaction ID', 'No'],
        ['dwh.transaction', 'channel', 'STRING', 'napas247, card, qr, internal, bill', 'No'],
        ['dwh.transaction', 'amount_vnd', 'DECIMAL(18,0)', 'Amount in VND', 'No'],
        ['dwh.transaction', 'initiated_by', 'STRING', 'customer or bank', 'No'],
      ], ['Data dictionary for the core banking warehouse. Columns marked PII are masked by default outside production.'], ['Columns', 'Tables', 'Change log'], 'Showing 9 of 412 rows');
    }),
    'fx-data-fraud': () => build(b => {
      b.page(1).title('Fraud model v2 — Model card', 'Data Platform · Risk models · Approved by the Model Risk Committee, September 2026')
        .h('Intended use').p('Scores every card and NAPAS 247 transaction in real time for fraud risk. Transactions above the decline threshold are blocked; those in the review band go to the fraud queue.');
      b.page(2).h('Training data').p('Trained on 14 months of labelled transactions (Jul 2025 – Aug 2026), 0.08% fraud rate, with confirmed chargebacks and customer-reported fraud as labels.');
      b.page(3).h('Performance').table(['Metric', 'v1', 'v2'], [['Fraud caught (recall at 0.5% review rate)', '71%', '83%'], ['False positive rate', '0.42%', '0.31%'], ['p99 scoring latency', '35 ms', '22 ms']]);
      b.page(4).h('Limitations and monitoring').p('Performance is lower for new merchants with less than 30 days of history. Drift is monitored weekly; the model is retrained every quarter.');
    }),
    'fx-prod-roadmap': () => build(b => {
      const slide = n => b.page(n, 'doc-page--slide');
      slide(1).title('Product roadmap H1 2027', 'Finx · Product · Đỗ Phương Thảo · For all staff');
      slide(2).h('Where we are').ul(['3.2 million monthly active customers, up 38% year on year.', 'QR payments are now 46% of transactions.', 'Core banking modernization is halfway: ledger and accounts are live on the new platform.']);
      slide(3).h('H1 2027 themes').ul(['Pay: instant QR refunds and recurring payments.', 'Save: goal-based savings pockets.', 'Business: SME accounts with payroll.', 'Trust: real-time fraud alerts in the app.']);
      slide(4).h('Q1 2027').table(['Initiative', 'Team', 'Target'], [['Instant QR refunds', 'Payments Platform', 'February'], ['Savings pockets beta', 'Retail', 'March'], ['Fraud alerts in app', 'Data Platform', 'March']]);
      slide(5).h('Q2 2027').table(['Initiative', 'Team', 'Target'], [['SME accounts pilot', 'Business Banking', 'May'], ['Recurring payments', 'Payments Platform', 'June'], ['Open banking partner API (beta)', 'Partners', 'June']]);
      slide(6).h('Dependencies').ul(['Event streaming platform chosen by January (Core Banking Modernization).', 'SBV approval for SME eKYC onboarding.', 'PCI DSS assessment completed in December.']);
      slide(7).h('How to give feedback').p('Comment in the Product shared drive or join the roadmap AMA on the first Friday of each month.');
    }),
    'fx-prod-pricing': () => build(b => {
      b.page(1).title('Pricing & fee schedule 2027', 'Finx · Product & Finance · Effective 1 January 2027')
        .h('Retail customers').table(['Service', 'Fee'], [['NAPAS 247 transfer', 'Free'], ['QR payment', 'Free'], ['Debit card issuance (virtual)', 'Free'], ['Debit card issuance (physical)', 'VND 50,000'], ['Overseas card transaction', '2.5% of amount']]);
      b.page(2).h('Merchants').table(['Service', 'Fee'], [['QR acceptance', '0.6% of amount'], ['Card acceptance (domestic)', '1.1% of amount'], ['Card acceptance (international)', '2.4% of amount'], ['Next-day payout', 'Free']]);
      b.page(3).h('Changes').p('Fee changes are announced to customers at least 30 days in advance through the app and the website, as required by SBV rules.');
    }),
    'fx-pol-hybrid': () => build(b => {
      b.page(1).title('Hybrid Work Policy', 'Finx · People & Culture · Effective 1 March 2026')
        .h('Office days').p('Employees work from the office at least three days a week; Tuesday and Thursday are team days.')
        .p('Teams choose their third office day together and publish it in the team calendar.');
      b.page(2).h('Remote days').ul(['Work from a safe, private place in Vietnam with a reliable connection.', 'Use only Finx-managed laptops and the VPN.', 'Never handle customer data in public places.'])
        .h('Exceptions').p('Managers may approve temporary changes for health or family reasons for up to 4 weeks; longer arrangements need People & Culture approval.');
      b.page(3).h('On-call and operations roles').p('Banking Operations and on-call engineers follow their team rota, which can require more office days.');
    }),
    'fx-pol-travel': () => build(b => {
      b.page(1).title('Travel & Expense Policy', 'Finx · People & Culture with Finance · Version 3')
        .h('Purpose').p('How to plan business travel, what Finx pays for and how to claim it back.');
      b.page(2).h('Approvals').ul(['Domestic trips: approved by your manager in the expense tool before booking.', 'International trips: also approved by your department head.', 'Book flights and hotels through the travel desk.']);
      b.page(3).h('Allowances').table(['Item', 'Domestic', 'International'], [['Daily meal allowance', 'VND 400,000', 'USD 50'], ['Hotel cap per night', 'VND 1,800,000', 'USD 150'], ['Flights', 'Economy', 'Economy (premium economy over 6 hours)']]);
      b.page(4).h('Claims').p('Submit claims with e-invoices (hóa đơn điện tử) within 15 days of returning. Claims are paid with the next payroll.');
    }),
    'fx-pol-onboarding': () => build(b => {
      b.page(1).title('New joiner guide', 'Finx · People & Culture · Welcome to Finx')
        .h('Your first day').ul(['Collect your laptop and badge from the IT Service Desk, floor 12.', 'Sign in to BoMesh to find policies, ask questions and send requests.', 'Meet your buddy for lunch.']);
      b.page(2).h('Your first week').ul(['Complete the Data privacy and Secure coding (engineers) trainings.', 'Read the Code of Conduct and the Access Control Policy.', 'Join your team channels and the #finx-general channel.']);
      b.page(3).h('Your first month').ul(['Agree on goals with your manager.', 'Attend the new joiner session with the leadership team.', 'Engineers: shadow one on-call week before joining the rotation.']);
      b.page(4).h('Who to ask').table(['Topic', 'Where'], [['Laptop, accounts, access', 'IT Service Desk (BoMesh Requests)'], ['Policies and compliance', 'Risk & Compliance'], ['Pay, leave and benefits', 'People & Culture']]);
    }),
    'fx-lead-budget': () => build(b => {
      b.page(1).sheet(['Cost center', 'FY2026 actual (VND bn)', 'FY2027 plan (VND bn)', 'Change', 'Owner'], [
        ['Payments Platform', 182, 214, '+18%', 'Lê Thu Hà'], ['Core Banking Modernization', 236, 268, '+14%', 'Lê Thu Hà'], ['Data Platform', 121, 139, '+15%', 'Phạm Quốc Bảo'],
        ['Banking Operations', 154, 158, '+3%', 'Lâm Bảo Ngọc'], ['Risk & Compliance', 88, 102, '+16%', 'Võ Thị Lan'], ['IT & Workplace', 96, 94, '−2%', 'Huỳnh Minh Quân'], ['Marketing', 210, 230, '+10%', 'Đỗ Phương Thảo'],
      ], ['FY2027 operating budget plan — draft for the Board, confidential. Totals exclude capitalized software.'], ['Plan', 'Headcount', 'Assumptions'], 'Draft v4 · Finance');
    }),
    /* Northwind product documentation: what a Browse preview should be able to tell apart. */
    'd-prod-3': () => build(b => {
      b.page(1).title('API Reference — Orders', 'Product Documentation · REST API v2')
        .h('Overview').p('Create, read and cancel orders. All requests use OAuth 2.0 bearer tokens; amounts are in minor units.')
        .h('Endpoints').ul(['GET /v2/orders — list orders; filter by status, customer and created date.', 'GET /v2/orders/{id} — one order with its lines and payments.', 'POST /v2/orders — create an order; send an Idempotency-Key header.', 'POST /v2/orders/{id}:cancel — cancel an order before fulfilment.']);
      b.page(2).h('Order object').table(['Field', 'Type', 'Notes'], [['id', 'string', 'ord_ prefix'], ['status', 'enum', 'DRAFT, PLACED, PAID, FULFILLED, CANCELLED'], ['total', 'integer', 'Minor units, e.g. 1999 = USD 19.99'], ['lines', 'array', 'Up to 500 lines']])
        .h('Errors').p('400 for invalid fields, 404 for unknown orders, 409 when an order can no longer be cancelled.');
    }),
    'd-prod-4': () => build(b => {
      b.page(1).title('API Reference — Webhooks', 'Product Documentation · REST API v2')
        .h('Overview').p('Northwind calls your HTTPS endpoint when something changes, so you don’t have to poll.')
        .h('Events').ul(['order.placed — a customer placed an order.', 'order.paid — payment was captured.', 'order.cancelled — the order was cancelled.', 'invoice.issued — an invoice PDF is ready.']);
      b.page(2).h('Signatures').p('Every request carries a Northwind-Signature header: an HMAC-SHA256 of the body with your endpoint secret. Reject requests older than five minutes.')
        .h('Retries').p('Non-2xx responses are retried with exponential backoff for 24 hours, then the event is marked failed in the Admin Console.');
    }),
    'd-prod-5': () => build(b => {
      b.page(1).title('Data Retention Spec', 'Product Documentation · Security & compliance')
        .h('Overview').p('How long the Northwind platform keeps each kind of customer data, and how deletion works.')
        .h('Retention periods').table(['Data', 'Kept for'], [['Order and invoice records', '10 years'], ['Audit logs', '7 years'], ['Deleted workspace data', '30 days, then purged'], ['Backups', '35 days, encrypted']]);
      b.page(2).h('Deletion requests').p('Admins can delete a customer’s personal data from the Admin Console. Deletion finishes within 30 days and is recorded in the audit log.');
    }),
    'd-prod-6': () => build(b => {
      b.page(1).title('SSO Setup Guide', 'Product Documentation · Admin & setup')
        .h('Overview').p('Let people sign in with your identity provider: Okta, Microsoft Entra ID or Google Workspace (SAML 2.0).')
        .h('Steps').ul(['In the Admin Console, open Security → Single sign-on.', 'Upload your identity provider’s metadata XML.', 'Map the email attribute and, optionally, groups to roles.', 'Test with one account, then turn on Enforce SSO.']);
      b.page(2).h('Troubleshooting').p('“User not provisioned” means the email in the assertion doesn’t match a Northwind account. Check the attribute mapping.');
    }),
    'd-prod-7': () => build(b => {
      b.page(1).title('Admin Console Guide', 'Product Documentation · Admin & setup')
        .h('What you can do').ul(['Invite people and assign roles.', 'Turn on SSO and two-step verification.', 'Download invoices and change your plan.', 'Export the audit log.'])
        .h('Who can use it').p('Owners and Admins. Billing admins see only Billing.');
    }),
    'd-prod-8': () => build(b => {
      b.page(1).title('Mobile App FAQ', 'Product Documentation · iOS and Android')
        .h('Questions').ul(['Does the app work offline? — You can view recent orders offline; changes sync when you reconnect.', 'Which versions are supported? — iOS 16+ and Android 11+.', 'Can I use SSO? — Yes, the app uses your workspace’s sign-in.', 'How do I turn off notifications? — Settings → Notifications in the app.']);
    }),
    'd-prod-9': () => build(b => {
      b.page(1).title('Integration Guide — SAP', 'Product Documentation · SAP S/4HANA')
        .h('Overview').p('Sync customers, orders and invoices between Northwind and SAP S/4HANA every 15 minutes.')
        .h('Steps').ul(['Create a technical user in SAP with the BAPI_SALESORDER roles.', 'In the Admin Console, add the SAP connection with its host and client number.', 'Map Northwind order statuses to SAP document types.', 'Run a test sync with one customer.']);
      b.page(2).h('Limits').p('Up to 50,000 orders a day. Larger volumes need the batch connector.');
    }),
    'd-prod-11': () => build(b => {
      b.page(1).title('Rate Limits', 'Product Documentation · REST API v2')
        .h('Overview').p('Limits apply per API key and protect the platform for every customer.')
        .h('Limits by plan').table(['Plan', 'Requests per minute', 'Burst'], [['Starter', '600', '100'], ['Business', '3,000', '500'], ['Enterprise', '10,000', '2,000']])
        .h('When you hit a limit').p('You get 429 Too Many Requests with a Retry-After header. Back off and retry; don’t retry in a tight loop.');
    }),
    'd-prod-12': () => build(b => {
      b.page(1).title('Error Codes', 'Product Documentation · REST API v2')
        .h('Overview').p('Errors return a JSON body with a code, a message and the request ID to quote to support.')
        .h('Common codes').table(['Code', 'Meaning'], [['INVALID_ARGUMENT', 'A field is missing or malformed'], ['NOT_FOUND', 'The resource doesn’t exist or you can’t see it'], ['FAILED_PRECONDITION', 'The resource is in the wrong state'], ['RESOURCE_EXHAUSTED', 'Rate limit reached; see Retry-After']]);
    }),
    'd-prod-13': () => build(b => {
      b.page(1).title('Architecture Overview', 'Product Documentation · Platform')
        .h('Overview').p('The Northwind platform is a set of services behind one API gateway, hosted in two AWS regions.')
        .h('Components').ul(['API gateway — authentication, rate limits and routing.', 'Orders and billing services — PostgreSQL, one database per service.', 'Event bus — Kafka; webhooks and integrations read from it.', 'Search — OpenSearch, rebuilt from events.']);
      b.page(2).h('Availability').p('99.95% monthly uptime target; failover to the second region within 15 minutes.');
    }),
    'd-prod-14': () => build(b => {
      b.page(1).title('Roadmap H2', 'Product Documentation · Planned, subject to change')
        .h('Overview').p('What we plan to ship from July to December. Dates are targets, not commitments.')
        .h('Planned').ul(['Partial refunds from the Admin Console (Q3).', 'Webhooks v2 with event replay (Q3).', 'Native SAP Business One connector (Q4).', 'Usage-based billing for Enterprise (Q4).']);
    }),
  };
  const GENERIC = {
    'kb-hr': n => [['Purpose', [`This policy sets out how ${n} works at Northwind and what employees can expect.`]], ['Who this applies to', ['All employees of Northwind Group and its subsidiaries, including part-time staff. Contractors follow the terms in their statement of work.']], ['How it works', null, ['Read this policy before making plans that depend on it.', 'Your manager approves requests in the People portal.', 'People Ops reviews exceptions within five working days.']], ['Questions', ['Contact People Ops at people@northwind.com or open a request in the People portal.']]],
    'kb-sales': n => [['Overview', [`${n} helps account teams prepare for customer conversations and keep our messaging consistent.`]], ['When to use it', ['Use it from first discovery through renewal. Check the version date before sharing anything outside Northwind.']], ['Key points', null, ['Lead with the customer’s goal, not product features.', 'Quantify value with the ROI calculator where you can.', 'Take pricing exceptions to the deal desk early.']], ['Next steps', ['Questions go to Sales Enablement in the #sales-enablement channel.']]],
    'kb-product': n => [['Overview', [`${n} describes how this part of the Northwind platform works and how to use it.`]], ['Before you start', ['You need an administrator role in the Admin Console. Some features depend on your plan.']], ['Steps', null, ['Open the Admin Console and go to Settings.', 'Make the change and review the summary.', 'Save. Changes apply within a few minutes.']], ['Troubleshooting', ['If something doesn’t look right, check the status page, then contact support with the time and the affected account.']]],
    'kb-legal': n => [['Parties', [`This document (${n}) is made between Northwind Group and the counterparty named on the signature page.`]], ['Term', ['The agreement starts on the effective date and continues for 24 months, renewing for 12-month periods unless either party gives 60 days’ written notice.']], ['Obligations', ['Each party keeps the other’s confidential information secret and uses it only to perform this agreement.']], ['Termination', ['Either party may end the agreement for a material breach not fixed within 30 days of written notice.']]],
    'kb-fin': n => [['Purpose', [`${n} explains how Finance & Procurement handles this process.`]], ['Rules', null, ['Raise requests in the procurement system before committing spend.', 'Attach a quote or contract for anything over USD 1,000.', 'Approvals follow the Approval Limits Matrix.']], ['Questions', ['Contact finance-ops@northwind.com.']]],
    'kb-eng': n => [['When to use this', [`Use ${n} when you are on call and something needs attention.`]], ['Steps', null, ['Acknowledge the page within five minutes.', 'Check the dashboards linked in the alert.', 'Post status in #incidents every 30 minutes.']], ['Escalation', ['If you can’t mitigate within 30 minutes, page the secondary on-call engineer.']]],
    default: n => [['Notes', [`Working notes for ${n}.`]], ['Key points', null, ['Confirm goals and owners for the next quarter.', 'Agree on the timeline and the next check-in.', 'Share a short summary with the team afterwards.']], ['Next steps', ['Follow up within a week with the open questions.']]],
  };
  /** Finx knowledge bases: used only for resources whose kind has no generator below. */
  const FALLBACK = {
    'kb-fx-eng': n => [['Context', [`${n} records how Platform Engineering builds and runs Finx services.`]], ['Guidance', null, ['Follow the Engineering Handbook unless this page says otherwise.', 'Link the ADR or ticket that motivated a change.', 'Ask in #eng-platform when something is unclear.']], ['Owner', ['Platform Engineering reviews this page every six months.']]],
    'kb-fx-pay': n => [['Context', [`${n} belongs to the Payments Platform team (gateway, card authorization, NAPAS 247 and QR).`]], ['Guidance', null, ['Payment APIs follow ADR-031: every POST carries an Idempotency-Key.', 'Changes to payment flows need a Payments Platform reviewer.', 'Incidents follow the Incident Response Plan.']], ['On call', ['Page the Payments Platform on-call for anything customer-facing.']]],
    'kb-fx-data': n => [['Context', [`${n} is maintained by the Data Platform team.`]], ['Guidance', null, ['Use certified tables and metric definitions for reporting.', 'Customer personal data is masked outside production.', 'Document every new table in the data dictionary.']], ['Questions', ['Ask in #data-platform or open a request to the Data Platform team.']]],
    'kb-fx-ops': n => [['Purpose', [`${n} is a Banking Operations procedure.`]], ['Steps', null, ['Check the case or file in the operations tool.', 'Follow the cut-off times for the channel concerned.', 'Record the outcome and reason code on the case.']], ['Escalation', ['Escalate to the Banking Operations lead when a case breaches its service time.']]],
    'kb-fx-sec': n => [['Purpose', [`${n} is part of the Finx security and compliance framework (SBV regulations, PCI DSS and Decree 13/2023).`]], ['Requirements', null, ['Follow least privilege and separation of duties.', 'Keep evidence for every control for at least five years.', 'Report suspected incidents in #incident immediately.']], ['Owner', ['Risk & Compliance owns this document and reviews it every year.']]],
    'kb-fx-prod': n => [['Overview', [`${n} is shared by the Product team.`]], ['Key points', null, ['Check the date before sharing outside Finx.', 'Customer numbers are as of the last month end.', 'Pricing changes need Finance approval and 30 days’ customer notice.']], ['Questions', ['Ask in #product.']]],
    'kb-fx-pol': n => [['Purpose', [`${n} is an internal policy from People & Culture.`]], ['Who it applies to', ['All Finx employees. Contractors follow their contract terms.']], ['How it works', null, ['Read the policy before making plans that depend on it.', 'Your manager approves requests in the HR portal.', 'People & Culture handles exceptions within five business days.']]],
    'kb-fx-lead': n => [['Summary', [`${n} is a confidential Leadership & Finance document.`]], ['Key points', null, ['Figures are draft until approved by the Board.', 'Do not forward outside the leadership group.']]],
  };

  /* ── Kind-based renditions: resources without hand-written text (synced pages, notices, uploads) ── */
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
  /** Notices and announcements: matched by title, English or Vietnamese body. */
  const NOTICE_TEXT = [
    [/change freeze|tết|tet\b/i, {
      en: { p: ['A production change freeze applies from 7 days before Tết until 3 days after it. Only emergency changes approved by the change advisory board can be deployed.'], ul: ['Merge and deploy planned work before the freeze starts.', 'Emergency changes need an incident or risk reference.', 'On-call rotations for the holiday are published in each team calendar.'] },
      vi: { p: ['Công ty áp dụng giai đoạn đóng băng thay đổi trên môi trường production từ 7 ngày trước Tết đến 3 ngày sau Tết. Chỉ các thay đổi khẩn cấp được hội đồng phê duyệt thay đổi chấp thuận mới được triển khai.'], ul: ['Hoàn tất triển khai các thay đổi đã lên kế hoạch trước khi đóng băng.', 'Thay đổi khẩn cấp cần có mã sự cố hoặc mã rủi ro kèm theo.', 'Lịch trực Tết được đăng trên lịch của từng nhóm.'] } }],
    [/pci|audit/i, { en: { p: ['The PCI DSS assessment fieldwork runs for two weeks. Assessors will interview control owners and sample evidence from the control matrix.'], ul: ['Check that the evidence for your controls is up to date.', 'Keep your calendar free for your interview slot.', 'Send questions to Risk & Compliance.'] } }],
    [/access review/i, { en: { p: ['The quarterly access review is open. System owners confirm or revoke every access right in their systems.'], ul: ['Complete your review before the deadline in the review tool.', 'Revoke access that is no longer needed.', 'Unreviewed access is removed automatically after the deadline.'] } }],
    [/maintenance|bảo trì/i, {
      en: { p: ['Planned maintenance runs on Saturday night from 23:00 to 02:00. Internal tools may be unavailable; customer payments are not affected.'], ul: ['Save your work before 23:00.', 'Report problems after the window to the IT Service Desk.'] },
      vi: { p: ['Bộ phận CNTT bảo trì hệ thống nội bộ vào tối thứ Bảy từ 23:00 đến 02:00. Giao dịch của khách hàng không bị ảnh hưởng.'], ul: ['Lưu lại công việc trước 23:00.', 'Báo lỗi sau thời gian bảo trì cho IT Service Desk.'] } }],
    [/town ?hall|all.?hands/i, { en: { p: ['Join the quarterly town hall with the leadership team: results, priorities for next quarter and open Q&A.'], ul: ['Send questions in advance through the town hall form.', 'The recording is shared afterwards.'] } }],
    [/holiday|nghỉ lễ/i, {
      en: { p: ['Offices are closed on the public holiday. NAPAS 247 and card payments run as normal; batch transfers settle on the next business day.'], ul: ['Check the on-call rota for your team.', 'Plan approvals that need a business day in advance.'] },
      vi: { p: ['Văn phòng nghỉ lễ theo quy định. Chuyển khoản NAPAS 247 và thanh toán thẻ vẫn hoạt động bình thường; giao dịch theo lô được xử lý vào ngày làm việc tiếp theo.'], ul: ['Kiểm tra lịch trực của nhóm.', 'Lên kế hoạch trước cho các phê duyệt cần ngày làm việc.'] } }],
  ];
  const KIND = {
    syllabus: (doc, c) => {
      const course = c.rest, credits = 2 + c.h % 3;
      return flow(doc, { title: `${c.code ? c.code + ' ' : ''}${course}`, sub: `Course syllabus · ${c.owner} · ${credits} credits · Approved ${c.date}`, secs: [
        { h: 'Course description', p: [c.lead || `Approved syllabus for ${course}.`, `${course} is a ${credits}-credit course taught over 15 weeks, with lectures, guided lab work and a team project.`] },
        { h: 'Learning outcomes', p: ['By the end of the course, students can:'], ul: [`Explain the core concepts and vocabulary of ${lc(course)}.`, `Apply ${lc(c.topic || course)} methods to small, well-defined engineering problems.`, 'Design, build and test a team project, and present the results.', 'Read technical material in English and write a clear report.'] },
        { h: 'Weekly plan', table: [['Weeks', 'Topic'], [['1–2', `Foundations of ${lc(course)}`], ['3–5', 'Core methods and worked examples'], ['6–7', 'Applied practice in the lab'], ['8', 'Midterm exam'], ['9–12', 'Advanced topics'], ['13–14', 'Team project and presentations'], ['15', 'Review']]] },
        { h: 'Assessment', p: ['The course is assessed through participation and quizzes (10%), labs and assignments (30%), a midterm exam (20%) and a final exam (40%).'], table: [['Component', 'Weight'], [['Participation and quizzes', '10%'], ['Labs and assignments', '30%'], ['Midterm exam', '20%'], ['Final exam', '40%']]], after: ['Students must score at least 4.0 out of 10 on the final exam to pass the course.', 'Students who miss more than 20% of classes can’t sit the final exam.'] },
        { h: 'Required readings', ul: [`Lecture notes for ${c.code || course}, published weekly on the learning platform.`, `A core textbook on ${lc(course)} chosen by the course coordinator.`, 'Papers and lab handouts listed in each week’s module.'] },
        { h: 'Course policies', ul: ['Late submissions lose 10% a day and aren’t accepted after three days.', 'Copying code or text without attribution is reported under the academic integrity rules.', 'Questions about grades go to the lecturer first, then to the Faculty office.'] },
      ] });
    },
    thesis: (doc, c) => {
      const title = c.base.replace(/\s+[—–-]\s+(MSc|BEng) thesis \d{4}$/, ''), msc = /MSc thesis/.test(c.base);
      const author = doc.author || doc.addedBy, year = doc.year || new Date(doc.updated).getFullYear();
      const t = c.r.topics.join(' '), metric = /t-ml|t-cropdisease|t-sensing/.test(t) ? 'accuracy' : /t-net/.test(t) ? 'detection rate' : /t-iot|t-elec|t-irrigation/.test(t) ? 'energy saving' : /t-mech/.test(t) ? 'task success rate' : /t-db/.test(t) ? 'query speed-up' : 'test coverage';
      const base = 68 + c.h % 14, prop = base + 4 + c.h % 9, sup = ['the faculty supervisor', 'the lab supervisor', 'the programme supervisor'][c.h % 3];
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
        { h: 'Report', p: ['Submit a short report on the learning platform within one week of the session: setup, results, answers to the questions and sources of error.'] },
        { h: 'Assessment', table: [['Part', 'Weight'], [['Pre-lab questions', '20%'], ['Work in the lab', '40%'], ['Report', '40%']]] },
      ] });
    },
    announcement: (doc, c) => build(b => {
      const hit = NOTICE_TEXT.find(([re]) => re.test(c.base))?.[1];
      const body = (c.vi ? hit?.vi : hit?.en) || (c.vi
        ? { p: [`${c.subject}.`, `Thông tin chi tiết được đăng trên ${c.r.source.key === 'upload' ? 'cổng thông tin nội bộ' : c.r.source.name}.`], after: [`Mọi thắc mắc xin liên hệ ${c.owner}.`] }
        : { p: [`${c.subject}.`, `Details are published on ${c.r.source.key === 'upload' ? 'the intranet' : c.r.source.name}.`] });
      b.page(1).title(c.base, c.vi ? `${c.r.source.name} · Ngày đăng ${viDate(doc.updated)}` : `${c.r.source.name} · Published ${c.date}`);
      if (c.lead) b.p(c.lead);
      body.p.forEach(x => b.p(x)); if (body.ul) b.ul(body.ul); (body.after || []).forEach(x => b.p(x));
      if (!c.vi && !body.after) b.p(`Questions: ${c.owner}.`);
    }),
    calendar: (doc, c) => flow(doc, { title: c.base.replace(/\s*\(.*\)$/, ''), sub: `${c.owner} · Updated ${c.date}`, per: 3, secs: [
      { h: 'Key dates', p: [c.lead || 'Key dates for the year ahead.'], table: [['What', 'When'], [['Quarter-end close', 'Last business day of each quarter'], ['Planning deadline', 'Two weeks before the quarter starts'], ['Reviews', 'First week of each quarter']]] },
      { h: 'Holidays', ul: ['Lunar New Year: 9–20 February 2027.', 'Hung Kings’ Commemoration: 16 April 2027.', 'Reunification Day and Labour Day: 30 April–1 May 2027.', 'National Day: 2 September 2027.'] },
      { h: 'Changes', p: [`${c.owner} publishes changes to these dates at least two weeks in advance.`] },
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
      const project = campus() && /capstone|project|thesis/i.test(c.base), intern = campus() && /internship/i.test(c.base);
      return flow(doc, { title: c.base, sub: `${c.owner} · Updated ${c.date}`, secs: [
        { h: 'Overview', p: [c.lead || `A practical guide to ${lc(c.subject.replace(/\s*(guide|handbook)$/i, ''))}.`] },
        { h: 'Before you start', ul: [`Check that the information is for the current ${campus() ? 'semester' : 'year'}.`, `Have your ${campus() ? 'student or staff' : 'employee'} account ready.`, 'Note the deadlines in the timeline below.'] },
        { h: 'Key steps', ul: project
          ? ['Form a team of 2–4 students and find a supervisor by week 2.', 'Submit the project proposal by week 4.', 'Present progress at the midterm review in week 8.', 'Submit the final report and defend the project in week 15.']
          : intern
            ? ['Choose a host company from the faculty list or propose your own.', 'Get the internship agreement signed before you start.', 'Work at least 8 weeks and keep a weekly log.', 'Submit the internship report and the company’s evaluation within 2 weeks of finishing.']
            : ['Read each section once, then use the outline to jump to what you need.', 'Follow the steps in order and keep copies of what you submit.', `Ask ${c.owner} when something is unclear.`] },
        { h: 'Timeline', p: [`Plan at least four weeks ahead. Milestone dates are confirmed at the start of each ${campus() ? 'semester' : 'quarter'}.`] },
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
      { h: 'Fields', table: [['Field', 'What to enter'], [['Full name', 'As on your ID card'], ['ID number', campus() ? 'Student or staff number' : 'Employee number'], ['Item or request', 'What you need and why'], ['Dates', 'From and to'], ['Signature', 'Yours, and your manager’s if required']]] },
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
    spec: (doc, c) => {
      const slug = c.subject.replace(/^ADR-\d+\s*[—–-]\s*/i, '');
      if (/^ADR-\d+/i.test(c.base)) return flow(doc, { title: c.base, sub: `Status: Accepted · ${c.owner} · ${c.date}`, secs: [
        { h: 'Context', p: [c.lead || `We need a consistent approach to ${lc(slug)} across services.`, 'Teams solved this differently, which made incidents harder to debug and reviews slower.'] },
        { h: 'Decision', p: [`We adopt a single, documented approach to ${lc(slug)} for every new service; existing services migrate when they are next changed.`] },
        { h: 'Alternatives considered', ul: ['Keep the current per-team approach.', 'Adopt a vendor product.', 'Build a shared library (chosen).'] },
        { h: 'Consequences', ul: ['New services follow this ADR from day one.', 'The platform team maintains the shared library and its documentation.', 'Deviations are recorded as new ADRs.'] },
      ] });
      if (/api|reference/i.test(c.base)) return flow(doc, { title: c.base, sub: `${c.owner} · Updated ${c.date}`, secs: [
        { h: 'Overview', p: [c.lead || `${c.subject} describes the endpoints, authentication and errors of this service.`] },
        { h: 'Authentication', p: ['Internal callers use service tokens issued by the platform identity service; partners use OAuth 2.0 client credentials with mutual TLS.'] },
        { h: 'Endpoints', table: [['Method', 'Path', 'Purpose'], [['GET', '/v1/items', 'List items, paginated'], ['GET', '/v1/items/{id}', 'Get one item'], ['POST', '/v1/items', 'Create an item (Idempotency-Key required)']]] },
        { h: 'Errors', table: [['Code', 'Meaning'], [['400', 'Invalid request'], ['401', 'Missing or expired token'], ['409', 'Conflict with an earlier request'], ['429', 'Rate limited — retry after the given seconds']]] },
      ] });
      if (/metric|definition|kpi/i.test(c.base)) return flow(doc, { title: c.base, sub: `${c.owner} · Certified metric · ${c.date}`, secs: [
        { h: 'Definition', p: [c.lead || `How ${lc(slug)} is calculated for reporting.`] },
        { h: 'Rules', ul: ['Calendar periods use Vietnam time (ICT).', 'Test, staff and closed accounts are excluded.', 'Use the certified mart tables, not raw events.'] },
        { h: 'Where to find it', p: ['The metric is published in the certified dashboards and the semantic layer.'] },
      ] });
      return flow(doc, { title: c.base, sub: `${c.owner} · Updated ${c.date}`, secs: [
        { h: 'Overview', p: [c.lead || `${c.subject}: how it works and how to use it.`] },
        { h: 'Design', ul: ['Owned by one team, with a named on-call rotation.', 'Configuration lives in the service repository.', 'Changes go through code review and the standard release process.'] },
        { h: 'Operations', p: ['Dashboards and alerts are linked from the service catalog. Runbooks cover the most common alerts.'] },
        { h: 'Contacts', p: [`Questions go to ${c.owner}.`] },
      ] });
    },
    playbook: (doc, c) => flow(doc, { title: c.base, sub: `${c.owner} · ${c.date}`, per: SLIDES.includes(doc.type) ? 1 : 2, cls: SLIDES.includes(doc.type) ? 'doc-page--slide' : '', titlePage: SLIDES.includes(doc.type), spread: !SLIDES.includes(doc.type), secs: [
      { h: 'Why this matters', p: [c.lead || `${c.subject}: what we want to achieve and for whom.`] },
      { h: 'What we will do', ul: ['Agree on the goal and how we will measure it.', 'Ship the smallest useful version first.', 'Review results with the team and decide what is next.'] },
      { h: 'Who is involved', p: [`${c.owner} leads; partner teams are named in each workstream.`] },
      { h: 'Risks', ul: ['Regulatory approval takes longer than planned.', 'Dependencies on other teams slip.'] },
    ] }),
    faq: (doc, c) => flow(doc, { title: c.base, sub: `${c.owner} · Updated ${c.date}`, secs: [
      { h: 'About these questions', p: [c.lead || `Answers to the questions people ask most about ${lc(c.subject.replace(/\s*faq$/i, ''))}.`] },
      { h: 'Who do I ask when something isn’t covered?', p: [`Send a request to ${c.owner} in BoMesh Requests.`] },
      { h: 'How often is this updated?', p: ['Every quarter, or when the underlying policy changes.'] },
    ] }),
    notes: (doc, c) => flow(doc, { title: c.base, sub: `${c.owner} · ${c.date}`, secs: [
      { h: 'Summary', p: [c.lead || `Notes: ${lc(c.subject)}.`] },
      { h: 'Decisions', ul: ['Agreed the scope and owners for the next step.', 'Open questions are tracked in the team board.'] },
      { h: 'Actions', ul: ['Share these notes with the wider team.', 'Follow up on open questions within a week.'] },
    ] }),
    contract: (doc, c) => flow(doc, { title: c.base, sub: `${c.org} · ${c.owner} · ${c.date}`, secs: [
      { h: 'Parties', p: [c.lead || `This agreement is made between ${c.org} and the counterparty named on the signature page.`] },
      { h: 'Term', p: ['The agreement runs for 24 months from the effective date and renews for 12-month periods unless either party gives 60 days’ written notice.'] },
      { h: 'Data protection', p: ['Each party processes personal data only as needed for this agreement and in line with Decree 13/2023.'] },
      { h: 'Termination', p: ['Either party may terminate for a material breach not remedied within 30 days of written notice.'] },
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
      else if (S.ws === 'ws-northwind') b.page(1).sheet(['Item', 'Owner', 'Status', 'Updated'], ['Kick-off', 'Review scope', 'Collect inputs', 'Draft', 'Feedback round', 'Final version', 'Share with team', 'Archive'].map((x, i) => [x, ['An Nguyen', 'Ben Walker', 'Mai Hoang', 'Linh Tran'][i % 4], i < 5 ? 'Done' : 'Open', `Sep ${3 + i * 3}`]), doc.summary ? [doc.summary] : [], ['Sheet1']);
      else {
        const who = (D.members || []).slice(0, 4).map(m => (Array.isArray(m) ? m[1] : m.name)).filter(Boolean);
        const owners = who.length ? who : [res(doc).owner || curWs().name];
        b.page(1).sheet(['Item', 'Owner', 'Status', 'Due'], ['Scope agreed', 'Inputs collected', 'Controls checked', 'Draft ready', 'Review round', 'Sign-off', 'Published', 'Archived'].map((x, i) => [x, owners[i % owners.length], i < 5 ? 'Done' : 'Open', fmtDate(doc.updated + (i - 4) * 3 * DAY)]), doc.summary ? [doc.summary] : [], ['Tracker']);
      }
    });
    const kind = res(doc).kind;
    if (!GENERIC[doc.kb] && KIND[kind]) return KIND[kind](doc, ctxOf(doc));
    const secs = (GENERIC[doc.kb] || FALLBACK[doc.kb] || GENERIC.default)(base);
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
  /* ═══════════════ Native format ═══════════════
     A document opens the way its own app shows it — PDF pages, a Word page, slides, a spreadsheet, a rendered
     Markdown file, a web page, plain text or an email — never as a separate text rendition. The rendition model
     (pages, outline, blocks) stays the same so search, citations and highlights keep working; the format only
     decides the page chrome (running header, page/slide numbers) and, in the reader, the viewer around it. */
  const FORMAT = { pdf: 'pdf', doc: 'docx', docx: 'docx', ppt: 'slide', pptx: 'slide', xls: 'sheet', xlsx: 'sheet', csv: 'sheet', md: 'markdown', html: 'web', htm: 'web', txt: 'text', log: 'text', json: 'text', msg: 'email', eml: 'email' };
  const formatOf = doc => FORMAT[String(doc?.type || '').toLowerCase()] || 'web';
  X.docFormat = formatOf;
  /** Prose built as pages, shown as a deck: every section becomes a slide (the title page becomes the title slide). */
  function asSlides(pages) {
    const out = [];
    pages.forEach(p => p.html.split(/(?=<h3 )/).filter(s => s.trim()).forEach(html => out.push({ no: p.no, cls: 'doc-page--slide', html })));
    return out;
  }
  /** Rendition of a resource: { format, count, pages:[{no, cls, html}], outline:[{id, title, page}], text, blocks:[{page, heading, text, quote}] }. */
  function model(doc) {
    const m = rendition(doc), f = formatOf(doc);
    m.format = f;
    if (f === 'slide' && !m.pages.some(p => p.cls === 'doc-page--slide')) m.pages = asSlides(m.pages);
    if (f === 'sheet' && !m.pages.some(p => p.cls === 'doc-page--sheet')) m.format = 'pdf';
    // Web-like files have no pages: one continuous page everywhere (passages keep their page for citations).
    if (['markdown', 'web', 'text', 'email'].includes(m.format) && m.pages.length > 1) m.pages = [{ no: 1, cls: m.pages[0].cls || '', html: m.pages.map(p => p.html).join('') }];
    const total = m.format === 'slide' ? m.pages.length : Math.max(doc.pages || 1, ...m.pages.map(p => p.no));
    m.count = total;
    const base = doc.name.replace(/\.[^.]+$/, '');
    m.pages.forEach((p, i) => {
      if (!String(p.cls || '').includes('doc-page--' + m.format)) p.cls = cx(p.cls, 'doc-page--' + m.format);
      // Page chrome lives on the page, like the file's own app prints it — not as labels between pages.
      if (m.format === 'pdf' && i) p.html = `<div class="doc-run" aria-hidden="true"><span>${esc(base)}</span><span>${esc(curWs()?.name || '')}</span></div>` + p.html;
      if (m.format === 'pdf') p.html += `<div class="doc-foot" aria-hidden="true">${p.no}</div>`;
      if (m.format === 'docx') p.html += `<div class="doc-foot" aria-hidden="true">Page ${p.no} of ${total}</div>`;
      if (m.format === 'slide') p.html += `<div class="doc-foot" aria-hidden="true">${i + 1}</div>`;
    });
    if (m.format === 'slide' && m.pages[0]?.html.includes('<h2')) m.pages[0].cls += ' doc-slide--title';
    // An email opens as a message: subject, sender, recipients and date above the body.
    if (m.format === 'email' && m.pages[0]) {
      const from = res(doc).owner || doc.addedBy || curWs()?.name || '', to = kbById(doc.kb)?.name || curWs()?.name || '';
      m.pages[0].html = m.pages[0].html.replace(/^<h2>([\s\S]*?)<\/h2>(<p class="doc-sub">[\s\S]*?<\/p>)?/, (_, subj) =>
        `<header class="doc-mail"><h2>${subj}</h2><div class="doc-mail__from">${avatar(from, 'sm')}<div class="doc-mail__who"><span class="doc-mail__name">${esc(from)}</span><span class="doc-mail__to">To ${esc(to)}</span></div><span class="doc-mail__date">${esc(fmtDateTime(doc.updated))}</span></div></header>`);
    }
    return m;
  }
  X.docModel = model;
  /** Plain text of a readable document (search snippets, answers). */
  X.docText = doc => (isSearchable(doc) ? rendition(doc).text.replace(/\s+/g, ' ').trim() : '');
})();
