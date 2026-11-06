(() => {
'use strict';
/* File work in chat: files the assistant makes (artifacts with revisions —
   nothing is overwritten), the file workspace panel (Preview · Changes ·
   History, edit, restore, ask for changes, download, save to knowledge),
   message attachments with validation, and the knowledge file picker.
   Plugs into chat.js through X.chatFiles; uses X.chat for chat internals. */

const C = () => X.chat;
const KIND = t => ['xlsx', 'csv'].includes(t) ? 'sheet' : 'doc';
const FMT = { xlsx: 'Excel spreadsheet', csv: 'CSV', docx: 'Word document', md: 'Markdown', pdf: 'PDF' };
const usd = n => typeof n === 'number' ? '$' + fmtNum(n) : n;
const art = id => D.artifacts[id];
const latest = a => a.revs[a.revs.length - 1];
const revOf = (a, n) => a.revs.find(r => r.n === +n) || latest(a);
const sizeOf = rev => rev.sheets ? 6000 + rev.sheets.reduce((s, sh) => s + sh.rows.length * sh.cols.length * 22, 0) : 9000 + (rev.html || '').length * 2;
function addRev(a, rev) { const r = { n: a.revs.length + 1, at: Date.now(), by: 'assistant', summary: 'First version', ...rev }; r.size = sizeOf(r); a.revs.push(r); return r; }
function newArt({ id, conv, title, file, type, rev, sources = [] }) {
  id = id || uid('art'); const a = { id, conv, title, file, type, revs: [], published: [], sources };
  D.artifacts[id] = a; addRev(a, rev); return a;
}
const panelState = () => { const p = C().cui().panel; return p?.kind === 'file' ? p : null; };

/* ═══════════════ Data for generated files ═══════════════ */
const VENDORS = [
  ['CloudHost', 'Hosting', 184000, 'Nov 30', 'Expired Jun 2026', 'Tuan Le'], ['Payroll Co', 'HR software', 96000, 'Mar 31', 'Missing', 'Mai Hoang'],
  ['DataSafe Backup', 'Storage', 42000, 'Dec 15', 'Missing', 'Tuan Le'], ['TravelDesk', 'Travel booking', 64000, 'Jan 31', 'Missing', 'An Nguyen'],
  ['LegalVault', 'Contract storage', 31000, 'Dec 31', 'Missing', 'Sara Lopez'], ['Insightly Analytics', 'Analytics', 27500, 'Nov 15', 'Expired Aug 2026', 'Ben Walker'],
  ['MailWave', 'Email delivery', 22000, 'Oct 15', 'Expired Jul 2026', 'Priya Shah'], ['SignFlow', 'E-signature', 18500, 'Oct 31', 'Renewal due', 'Sara Lopez'],
  ['ChatOps Pro', 'Collaboration', 12900, 'Feb 28', 'Missing', 'David Kim'], ['FleetCare', 'Vehicles', 8800, 'Nov 1', 'Missing', 'James Carter'],
  ['PrintPoint', 'Printing', 4200, 'Dec 1', 'Renewal due', 'Chi Bui'],
];
function vendorSheet() {
  const total = VENDORS.reduce((s, v) => s + v[2], 0);
  return { sheets: [
    { name: 'Needs review', cols: [{ n: 'Vendor' }, { n: 'Category' }, { n: 'Annual spend', f: 'usd' }, { n: 'Contract ends' }, { n: 'Security review' }, { n: 'Owner' }], rows: clone(VENDORS) },
    { name: 'Summary', cols: [{ n: 'Measure' }, { n: 'Value' }], rows: [['Vendors checked', 48], ['Need attention', 11], ['No current security review', 9], ['Contracts ending by Dec 31', 7], ['Annual spend at risk', usd(total)]] },
  ] };
}
function claimsSheet() {
  const rows = C().CLAIMS.map(r => [r[0], r[1], r[2], r[3], r[4]]);
  const by = {}; rows.forEach(r => { by[r[1]] ??= [0, 0]; by[r[1]][0]++; by[r[1]][1] += r[3]; });
  return { sheets: [
    { name: 'Claims over $500', cols: [{ n: 'Employee' }, { n: 'Department' }, { n: 'Category' }, { n: 'Amount', f: 'usd' }, { n: 'Submitted' }], rows },
    { name: 'By department', cols: [{ n: 'Department' }, { n: 'Claims' }, { n: 'Total', f: 'usd' }], rows: Object.entries(by).map(([d, [n, t]]) => [d, n, t]) },
  ] };
}
function docFromAnswer(title, text) {
  const body = C().plain(text).split('\n').filter(l => l.trim());
  let h = `<h2>${esc(title)}</h2><p class="meta">Drafted by the assistant from ${esc(curWs().name)} knowledge · ${fmtDate(Date.now())}</p>`; let inList = false;
  body.forEach(l => { const li = /^\s*[-*] /.test(l); if (li && !inList) { h += '<ul>'; inList = true; } if (!li && inList) { h += '</ul>'; inList = false; } h += li ? `<li>${esc(l.replace(/^\s*[-*] /, ''))}</li>` : `<p>${esc(l)}</p>`; });
  if (inList) h += '</ul>';
  return h + '<h3>Next steps</h3><ol><li>Review the details with the document owner.</li><li>Share with the people who need it.</li></ol>';
}

/* Seed: c2's spreadsheet is a real file with a revision history. */
(function seed() {
  const m4 = convById('c2')?.messages.find(m => m.artifact);
  if (!m4) return;
  const a = newArt({ id: m4.artifact.id, conv: 'c2', title: m4.artifact.title, file: m4.artifact.file, type: m4.artifact.type, rev: { ...claimsSheet(), summary: 'First version — 14 claims and a total by department' }, sources: ['d-fin-reimb'] });
  a.revs[0].at = ago(3 * HOUR);
  m4.artifacts = [{ id: a.id, rev: 1 }]; delete m4.artifact;
  m4.work = [
    { k: 'search', label: 'Searched Finance & Procurement', d: '1 relevant file' },
    { k: 'prepare', label: 'Opened Pending reimbursements Q3.xlsx in a secure workspace', d: '1 sheet' },
    { k: 'code', label: 'Ran 2 commands', runs: [
      { cmd: 'import pandas as pd\ndf = pd.read_csv("pending-reimb-q3/Claims.csv")\nbig = df[df["Amount (USD)"] > 500]\nprint(len(big), big["Amount (USD)"].sum())', out: '14 18940', exit: 0 },
      { cmd: 'big.groupby("Department")["Amount (USD)"].agg(["count", "sum"]).to_excel("claims_over_500_q3.xlsx")', out: 'Saved claims_over_500_q3.xlsx', exit: 0 },
    ] },
    { k: 'export', label: 'Created claims_over_500_q3.xlsx', d: 'Version 1' },
  ];
  delete m4.activity; m4.dur = 14; m4.state = 'done';
})();
/** Older saved messages may carry a plain `artifact`; turn it into a versioned file. */
function migrate(conv, m) {
  if (!m.artifact || m.artifacts) return;
  const x = m.artifact;
  const a = art(x.id) || newArt({ id: x.id, conv: conv.id, title: x.title, file: x.file, type: x.type, rev: KIND(x.type) === 'sheet' ? { ...claimsSheet(), summary: 'First version' } : { html: docFromAnswer(x.title, m.text || ''), summary: 'First version' } });
  m.artifacts = [{ id: a.id, rev: 1 }]; delete m.artifact;
}

/* ═══════════════ Revisions: transforms ═══════════════ */
const approver = x => x <= 5000 ? 'Budget owner' : x <= 25000 ? 'Department VP' : x <= 100000 ? 'CFO' : 'CEO and CFO';
function sheetTransform(rev, instr) {
  const s = instr.toLowerCase(); const sh = rev.sheets[0]; const numCol = sh.cols.findIndex(c => c.f === 'usd');
  const has = n => sh.cols.some(c => c.n === n); let summary;
  if (/approv/.test(s) && numCol >= 0 && !has('Required approver')) { sh.cols.push({ n: 'Required approver' }); sh.rows.forEach(r => r.push(approver(r[numCol]))); summary = 'Added a Required approver column'; }
  else if (/sort|largest|biggest|highest|order/.test(s) && numCol >= 0) { sh.rows.sort((a, b) => (+b[numCol] || 0) - (+a[numCol] || 0)); summary = `Sorted by ${sh.cols[numCol].n.toLowerCase()}, largest first`; }
  else if (/total|sum/.test(s) && numCol >= 0 && !sh.rows.some(r => r[0] === 'Total')) { const t = sh.rows.reduce((a, r) => a + (+r[numCol] || 0), 0); sh.rows.push(sh.cols.map((_, i) => i === 0 ? 'Total' : i === numCol ? t : '')); summary = 'Added a total row'; }
  else if (/status/.test(s) && !has('Status')) { sh.cols.push({ n: 'Status' }); sh.rows.forEach(r => r.push('Not started')); summary = 'Added a Status column'; }
  else if (/remove|delete|drop/.test(s) && sh.cols.length > 1) { const i = sh.cols.findIndex((c, k) => k > 0 && s.includes(c.n.toLowerCase())); const k = i > 0 ? i : sh.cols.length - 1; const name = sh.cols[k].n; sh.cols.splice(k, 1); sh.rows.forEach(r => r.splice(k, 1)); summary = `Removed the ${name} column`; }
  else if (/owner|email|contact/.test(s) && !has('Owner email')) { const oc = sh.cols.findIndex(c => /owner|employee/i.test(c.n)); sh.cols.push({ n: 'Owner email' }); sh.rows.forEach(r => r.push(String(r[oc >= 0 ? oc : 0]).toLowerCase().replace(/\s+/g, '.') + '@northwind.com')); summary = 'Added an Owner email column'; }
  else { if (!has('Notes')) { sh.cols.push({ n: 'Notes' }); sh.rows.forEach(r => r.push('')); } sh.rows[0][sh.cols.length - 1] = instr.slice(0, 60); summary = 'Added a Notes column with your note'; }
  return { rev: { sheets: rev.sheets }, summary };
}
function docTransform(rev, instr) {
  const s = instr.toLowerCase(); const doc = new DOMParser().parseFromString(`<div id="r">${rev.html}</div>`, 'text/html'); const root = doc.getElementById('r'); let summary;
  if (/short|concise|brief|trim/.test(s)) { const t = root.querySelector('table'); if (t) { const h = t.previousElementSibling; t.remove(); if (h?.tagName === 'H3') h.remove(); } root.querySelectorAll('ul li:nth-child(n+3)').forEach(li => li.remove()); summary = 'Shortened — removed the table and kept the top two points'; }
  else if (/formal|tone|executive/.test(s)) { const p = root.querySelector('p:not(.meta)'); if (p) p.textContent = 'This memo summarises the findings below. The details and recommended next steps follow, with sources for each point.'; summary = 'Rewrote the opening in a more formal tone'; }
  else if (/table|glance|overview/.test(s) && !root.querySelector('.glance')) { const p = root.querySelector('p:not(.meta)'); p?.insertAdjacentHTML('afterend', `<table class="glance"><tr><th>Item</th><th>Detail</th></tr>${[...root.querySelectorAll('li')].slice(0, 3).map((li, i) => `<tr><td>Point ${i + 1}</td><td>${esc(li.textContent.slice(0, 80))}</td></tr>`).join('')}</table>`); summary = 'Added an at-a-glance table'; }
  else { const ol = root.querySelector('ol') || root.appendChild(doc.createElement('ol')); const li = doc.createElement('li'); li.textContent = instr.replace(/^./, c => c.toUpperCase()).replace(/\.?$/, '.'); ol.appendChild(li); summary = `Added “${instr.slice(0, 48)}” to next steps`; }
  return { rev: { html: root.innerHTML }, summary };
}
const transform = (a, instr) => { const base = clone(latest(a)); return KIND(a.type) === 'sheet' ? sheetTransform(base, instr) : docTransform(base, instr); };

/* ═══════════════ Planning a turn (canned, permission-aware) ═══════════════ */
const SHEET_RX = /spreadsheet|excel|xlsx|csv|table of|filter|totals?\b|sum of|count|list (every|all)|analy[sz]e|clean/i;
const DOC_RX = /\b(draft|write|memo|one.?pager|report|proposal|document|docx|letter|brief)\b/i;
function targetArt(conv, q) {
  const arts = Object.values(D.artifacts).filter(a => a.conv === conv.id);
  const named = arts.find(a => q.includes(`“${a.title}”`) || q.toLowerCase().includes(a.title.toLowerCase()) || q.includes(a.file));
  if (named) return named;
  if (arts.length && /^(now |please |can you |also )?(add|remove|delete|change|update|rename|sort|make it|shorten|shorter|formal|include)/i.test(q.trim())) return arts[arts.length - 1];
  return null;
}
const slug = t => t.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
function plan(q, conv, files, mod) {
  const target = targetArt(conv, q);
  if (target) {
    const instr = q.replace(/^Update “[^”]+”:\s*/, '');
    const t = transform(target, instr); const next = target.revs.length + 1;
    return { text: `Done — **${target.title}** is now on version ${next}. ${t.summary}. Open it to review the changes, or restore an earlier version from History.`, citations: [], noResults: null, partial: false, searchLabel: 'the files in this conversation',
      work: [{ k: 'prepare', label: 'Reused the files already open in this conversation' }, { k: 'code', label: 'Ran code', runs: [{ cmd: KIND(target.type) === 'sheet' ? `df = pd.read_excel("${target.file}")\n# ${instr}\ndf.to_excel("${target.file}", index=False)` : `doc = Document("${target.file}")\n# ${instr}\ndoc.save("${target.file}")`, out: `Saved ${target.file}`, exit: 0 }] }, { k: 'export', label: `Updated ${target.file}`, d: `Version ${next}` }],
      apply: () => { const r = addRev(target, { ...t.rev, summary: t.summary }); return [{ id: target.id, rev: r.n }]; }, editOf: target.id };
  }
  const base = C().answer(q, conv.scope || [], files.map(f => f.name), conv.space || null);
  // base.files: undefined = any file work; true = documents only; false = answer only (no generated files).
  const sheetOk = base.files === undefined, docOk = base.files !== false;
  let text = base.text;
  if (mod === 'shorter' && !base.noResults) text = text.split('\n\n').slice(0, 2).join('\n\n');
  if (mod === 'detail' && !base.noResults) text += '\n\nIn more detail: the documents above are the current versions. If your situation is unusual, the document owner listed in each one can confirm the details.';
  const seen = new Set();
  const work = (base.activity || []).filter(s => s.kind !== 'code').map(s => ({ k: s.kind, label: s.label, d: s.detail })).filter(s => { if (s.k !== 'read') return true; if (seen.has(s.label)) return false; seen.add(s.label); return true; });
  const sheetFile = files.find(f => ['xlsx', 'csv'].includes(f.type));
  let apply = null;
  if (!base.noResults && sheetOk && (base.artifact || sheetFile || SHEET_RX.test(q))) {
    const claims = !!base.artifact || /reimburse|claim/i.test(q);
    const title = claims ? 'Claims over $500 — Q3' : sheetFile ? `${sheetFile.name.replace(/\.[^.]+$/, '')} — reviewed` : C().makeTitle(q).replace(/…$/, '');
    const file = slug(title) + '.xlsx';
    work.push({ k: 'prepare', label: 'Started a secure workspace', d: 'Python · no internet' },
      { k: 'code', label: 'Ran 2 commands', runs: claims ? [
        { cmd: 'import pandas as pd\ndf = pd.read_csv("pending-reimb-q3/Claims.csv")\nbig = df[df["Amount (USD)"] > 500]\nprint(len(big), big["Amount (USD)"].sum())', out: '14 18940', exit: 0 },
        { cmd: `big.groupby("Department")["Amount (USD)"].agg(["count", "sum"]).to_excel("${file}")`, out: `Saved ${file}`, exit: 0 },
      ] : [
        { cmd: `import pandas as pd\ndf = pd.read_csv("${slug(sheetFile?.name || 'source')}.csv")\nprint(df.shape)`, out: '(212, 5)', exit: 0 },
        { cmd: `result.to_excel("${file}", index=False)`, out: `Saved ${file}`, exit: 0 },
      ] },
      { k: 'export', label: `Created ${file}`, d: 'Version 1' });
    if (!base.artifact) text = (text ? text + '\n\n' : '') + `I put the results in **${title}** so you can filter and share them.`;
    apply = () => [{ id: newArt({ conv: conv.id, title, file, type: 'xlsx', rev: { ...(claims ? claimsSheet() : vendorSheet()), summary: 'First version' }, sources: base.citations.map(c => c.doc) }).id, rev: 1 }];
  } else if (!base.noResults && docOk && DOC_RX.test(q)) {
    const t0 = q.replace(/\s+/g, ' ').trim().replace(/[?.!]+$/, '').replace(/^(please\s+)?(draft|write|create|make|prepare)\s+(me\s+)?(a|an|the)?\s*/i, '');
    const title = (t0.length > 60 ? t0.slice(0, 57).replace(/\s\S*$/, '') + '…' : t0).replace(/^./, c => c.toUpperCase());
    const file = slug(title).slice(0, 40) + '.docx';
    work.push({ k: 'prepare', label: 'Started a secure workspace', d: 'Python · no internet' }, { k: 'code', label: 'Ran code', runs: [{ cmd: `from docx import Document\ndoc = Document()\ndoc.add_heading("${title}", 1)\n# sections from the cited passages\ndoc.save("${file}")`, out: `Saved ${file}`, exit: 0 }] }, { k: 'export', label: `Created ${file}`, d: 'Version 1' });
    const html = docFromAnswer(title, text);
    text += `\n\nI also saved this as **${title}** — a Word document you can edit and share.`;
    apply = () => [{ id: newArt({ conv: conv.id, title, file, type: 'docx', rev: { html, summary: 'First version' }, sources: base.citations.map(c => c.doc) }).id, rev: 1 }];
  }
  return { text, citations: base.citations, noResults: base.noResults || null, partial: base.partial, next: base.next || null, gap: base.gap || null, lowConf: !!base.lowConf, searchLabel: base.searchLabel, work, apply };
}
function afterStream(am, pl) {
  if (am.state !== 'done' || !am.artifacts?.length) return;
  const ref = am.artifacts[0], a = art(ref.id); if (!a) return;
  if (pl.editOf) {
    const p = panelState();
    if (p?.art === a.id) { Object.assign(p, { rev: ref.rev, tab: 'changes', cell: null }); refresh(); }
    toast(`${a.title} is on version ${ref.rev}`, { action: { label: 'Review changes', run: () => openFile(a.id, ref.rev, 'changes') } });
  } else toast(am.artifacts.length > 1 ? `Created ${am.artifacts.length} files` : `Created ${a.file}`, { action: { label: 'Open', run: () => openFile(a.id, ref.rev) } });
}

/* ═══════════════ Answer cards ═══════════════ */
function cards(m) {
  const refs = (m.artifacts || []).filter(r => art(r.id)); if (!refs.length) return '';
  const p = panelState();
  return `<div class="wk-cards" role="group" aria-label="Files from this answer">${refs.map(r => {
    const a = art(r.id), rev = revOf(a, r.rev), last = latest(a);
    return `<div class="${cx('wk-card', p?.art === a.id && p.rev === rev.n && 'is-on')}" role="button" tabindex="0" data-act="wk-open" data-id="${a.id}" data-rev="${rev.n}" aria-label="Open ${esc(a.title)}, version ${rev.n}">${fileIcon(a.type, 'lg')}<div class="grow"><div class="wk-card__title truncate">${esc(a.title)}</div><div class="t-xs muted truncate">Version ${rev.n} · ${FMT[a.type] || a.type.toUpperCase()} · ${fmtSize(rev.size)}${last.n > rev.n ? ` · <span class="text-accent">Version ${last.n} available</span>` : ''}</div></div>${iconBtn('download', 'Download', { size: 'sm', menu: 'wk-dl', data: { id: a.id, rev: rev.n } })}</div>`;
  }).join('')}</div>`;
}

/* ═══════════════ Sheet, document and diffs ═══════════════ */
const COL = i => String.fromCharCode(65 + i);
const cellHtml = (v, col) => col?.f === 'usd' && typeof v === 'number' ? usd(v) : esc(v);
function sheetHtml(a, rev, p, prev) {
  const si = Math.min(p.sheet || 0, rev.sheets.length - 1), sh = rev.sheets[si];
  const psh = prev?.sheets?.find(x => x.name === sh.name);
  const pcols = psh ? psh.cols.map(c => c.n) : null;
  const pmap = psh ? new Map(psh.rows.map(r => [String(r[0]), r])) : null;
  const sel = !prev && p.cell && p.cell.s === si ? p.cell : null;
  const newCol = c => pcols && !pcols.includes(c.n);
  const head = `<thead><tr><th class="wk-grid__corner"></th>${sh.cols.map((c, i) => `<th class="${cx(newCol(c) && 'is-add')}">${COL(i)}</th>`).join('')}</tr></thead>`;
  const hdr = `<tr class="wk-grid__hdr"><th>1</th>${sh.cols.map((c, i) => `<td class="${cx(newCol(c) && 'is-add', sel && sel.r === 0 && sel.c === i && 'is-sel')}" ${prev ? '' : `data-act="wk-cell" data-r="0" data-c="${i}"`}>${esc(c.n)}</td>`).join('')}</tr>`;
  const rows = sh.rows.map((r, ri) => {
    const pr = pmap?.get(String(r[0])), rowAdd = pmap && !pr;
    return `<tr><th>${ri + 2}</th>${r.map((v, ci) => {
      const c = sh.cols[ci], pi = pcols ? pcols.indexOf(c.n) : -1;
      const moved = ci === 0 && pr && psh.rows.indexOf(pr) !== ri;
      const chg = (pr && pi >= 0 && String(pr[pi]) !== String(v)) || moved;
      return `<td class="${cx(typeof v === 'number' && 'num', (rowAdd || (pcols && pi < 0)) && 'is-add', chg && 'is-chg', sel && sel.r === ri + 1 && sel.c === ci && 'is-sel')}" ${prev ? '' : `data-act="wk-cell" data-r="${ri + 1}" data-c="${ci}"`}>${cellHtml(v, c)}</td>`;
    }).join('')}</tr>`;
  }).join('');
  const gone = pmap ? psh.rows.filter(r => !sh.rows.some(x => String(x[0]) === String(r[0]))).map(r => `<tr><th>–</th>${sh.cols.map(c => { const pi = pcols.indexOf(c.n); return `<td class="is-del">${pi >= 0 ? cellHtml(r[pi], c) : ''}</td>`; }).join('')}</tr>`).join('') : '';
  const sheetTabs = rev.sheets.length > 1 ? `<div class="wk-sheet-tabs" role="tablist" aria-label="Sheets">${rev.sheets.map((s, i) => `<button type="button" role="tab" aria-selected="${i === si}" data-act="wk-sheet" data-i="${i}">${esc(s.name)}</button>`).join('')}</div>` : '';
  let fbar = '';
  if (!prev) {
    const editable = rev.n === latest(a).n && !C().streamingIn(a.conv);
    const v = sel ? (sel.r === 0 ? sh.cols[sel.c]?.n : sh.rows[sel.r - 1]?.[sel.c]) : null;
    const val = !sel ? '<span class="muted">Select a cell to see or edit its value</span>'
      : editable ? input({ id: 'wk-cell-in', value: v ?? '', size: 'sm', onEnter: 'wk-cell-save', cls: 'wk-fbar__input', attrs: `aria-label="Value of ${COL(sel.c)}${sel.r + 1}"` })
        : `<span class="truncate">${cellHtml(v, sel.r ? sh.cols[sel.c] : null)}</span>`;
    fbar = `<div class="wk-fbar"><span class="wk-fbar__ref mono">${sel ? COL(sel.c) + (sel.r + 1) : ''}</span><span class="wk-fbar__val">${val}</span>${sel && editable ? btn('Save', { size: 'sm', act: 'wk-cell-save' }) : `<span class="t-xs muted num none">${plural(sh.rows.length, 'row')} · ${plural(sh.cols.length, 'column')}</span>`}</div>`;
  }
  return `${sheetTabs}${fbar}<div class="wk-grid" id="wk-grid"><table>${head}<tbody>${hdr}${rows}${gone}</tbody></table></div>`;
}
function blocks(html) { const d = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html'); return [...d.body.firstChild.children].map(el => el.outerHTML); }
const tagBlock = (html, cls, tag) => html.replace(/^<(\w+)([^>]*)>/, (m, t, at) => `<${t}${at.replace(/\sclass="[^"]*"/, '')} class="${cls}">${tag ? `<span class="wk-d-tag">${tag}</span>` : ''}`);
function docDiffHtml(prevHtml, html) {
  const a = blocks(prevHtml), b = blocks(html), norm = x => x.replace(/\s+/g, ' ').trim();
  const aSet = new Set(a.map(norm)), bSet = new Set(b.map(norm)); let out = '', i = 0;
  b.forEach(blk => {
    while (i < a.length && !bSet.has(norm(a[i]))) { out += tagBlock(a[i], 'wk-d-del', 'Removed'); i++; }
    if (aSet.has(norm(blk))) { out += blk; i = Math.max(i, a.findIndex((x, k) => k >= i && norm(x) === norm(blk)) + 1); } else out += tagBlock(blk, 'wk-d-add', 'Added');
  });
  while (i < a.length) { if (!bSet.has(norm(a[i]))) out += tagBlock(a[i], 'wk-d-del', 'Removed'); i++; }
  return out;
}

/* ═══════════════ File workspace panel ═══════════════ */
function openFile(id, rev, tab = 'preview') {
  const a = art(id); if (!a) return; const u = C().cui();
  if (u.panel?.kind === 'file' && u.panel.edit && !leaveEdit(() => openFile(id, rev, tab))) return;
  u.panel = { conv: a.conv, kind: 'file', art: id, rev: +rev || latest(a).n, tab, sheet: 0, cell: null, edit: false, draft: null, full: u.panel?.full || false };
  S.ui.wkAsk = { text: '' };
  if (S.cur?.path !== '/chat/' + a.conv) go('/chat/' + a.conv); else refresh();
}
function historyHtml(a, cur) {
  const last = latest(a);
  const revs = list([...a.revs].reverse().map(r => item({
    lead: `<span class="wk-rev-n num">v${r.n}</span>`, title: esc(r.summary),
    titleExtra: (r.n === last.n ? chip('Latest', { tone: 'accent', size: 'sm' }) : '') + (a.published.some(x => x.rev === r.n) ? chip('Saved to knowledge', { tone: 'success', size: 'sm' }) : ''),
    desc: `${r.by === 'you' ? 'Edited by you' : 'By the assistant'} · ${fmtDateTime(r.at)} · ${fmtSize(r.size)}`,
    trail: (r.n !== cur.n ? btn('View', { v: 'ghost', size: 'sm', act: 'wk-goto', data: { rev: r.n } }) : '') + (r.n !== last.n ? btn('Restore', { v: 'ghost', size: 'sm', act: 'wk-restore', data: { rev: r.n } }) : ''),
    cls: cx('wk-rev', r.n === cur.n && 'is-on'),
  })));
  const pub = a.published.map(x => { const k = kbById(x.kb); return item({ lead: itemIcon('book', '', 'sm'), title: esc(k?.name || 'Knowledge base'), desc: `Version ${x.rev} · ${rel(x.at)}`, trail: x.rev < last.n ? btn(`Update to v${last.n}`, { size: 'sm', act: 'wk-publish', data: { id: a.id, kb: x.kb } }) : chip('Up to date', { tone: 'success', variant: 'tertiary', size: 'sm' }) }); });
  const src = (a.sources || []).map(docById).filter(d => d && C().canDoc(d));
  return `<div class="stack gap-24">
    <div><div class="t-label mb-8">Versions</div>${revs}<p class="t-xs muted mt-8">Restoring makes a new version. Nothing is overwritten.</p></div>
    ${pub.length ? `<div><div class="t-label mb-8">Saved to knowledge</div>${list(pub)}</div>` : ''}
    ${src.length ? `<div><div class="t-label mb-8">Built from</div><div class="row gap-6 wrap">${src.map(d => `<a class="chat-source" href="#/doc/${d.id}?from=${a.conv}">${fileIcon(d.type, 'sm')}<span class="truncate">${esc(d.name)}</span></a>`).join('')}</div></div>` : ''}
  </div>`;
}
function askHtml(a, streaming) {
  if (streaming) return `<div class="panel__footer wk-ask"><div class="row gap-8 t-sm muted">${spinner('sm')}<span>Working on version ${a.revs.length + 1}… you can keep reviewing.</span></div></div>`;
  const f = ui('wkAsk', { text: '' }); const sheet = KIND(a.type) === 'sheet';
  const quick = sheet ? ['Sort by largest amount', 'Add a total row', 'Add a status column'] : ['Make it shorter', 'More formal tone', 'Add an at-a-glance table'];
  return `<div class="panel__footer wk-ask"><div class="wk-ask__row">${input({ id: 'wk-ask-in', bind: 'wkAsk.text', value: f.text, placeholder: 'Ask for changes…', onEnter: 'wk-ask-send', attrs: `aria-label="Ask for changes to ${esc(a.title)}"` })}${btn('', { v: 'primary', icon: 'arrow-up', tip: 'Ask for changes', act: 'wk-ask-send' })}</div><div class="wk-quick">${quick.map(q => `<button type="button" class="chip chip--default chip--outline wk-quick__item" data-act="wk-ask-quick" data-q="${esc(q)}">${esc(q)}</button>`).join('')}</div></div>`;
}
function panel(conv, p) {
  const a = art(p.art); if (!a) return '';
  const rev = revOf(a, p.rev), last = latest(a), prev = a.revs.find(r => r.n === rev.n - 1);
  const sheet = KIND(a.type) === 'sheet', streaming = C().streamingIn(conv.id);
  const head = `<div class="panel__header wk-head">${fileIcon(a.type)}<div class="grow"><h2 class="panel__title truncate">${esc(a.title)}</h2><div class="t-xs muted truncate">${esc(a.file)} · ${fmtSize(rev.size)} · ${rev.by === 'you' ? 'edited by you' : 'by the assistant'} ${rel(rev.at).toLowerCase()}</div></div>
    ${btn(`v${rev.n}${rev.n === last.n ? ' · Latest' : ''}`, { v: 'outline', size: 'sm', iconRight: 'chevron-down', menu: 'wk-ver', data: { id: a.id }, tip: 'Versions', cls: 'wk-ver' })}
    ${iconBtn(p.full ? 'chevron-right' : 'maximize', p.full ? 'Narrower' : 'Wider', { size: 'sm', act: 'wk-wide', cls: 'hide-md' })}${iconBtn('download', 'Download', { size: 'sm', menu: 'wk-dl', data: { id: a.id, rev: rev.n } })}${iconBtn('more', 'More', { size: 'sm', menu: 'wk-file-more', data: { id: a.id } })}${iconBtn('x', 'Close', { size: 'sm', act: 'chat-panel-close' })}</div>`;
  const canEdit = !sheet && p.tab === 'preview' && !p.edit && rev.n === last.n;
  const tabsH = `<div class="wk-tabs">${tabs([{ id: 'preview', label: 'Preview' }, { id: 'changes', label: 'Changes' }, { id: 'history', label: 'History', count: a.revs.length }], p.tab, '', { act: 'wk-tab' })}${canEdit ? btn('Edit', { v: 'ghost', size: 'sm', icon: 'pencil', act: 'wk-edit', disabled: streaming }) : ''}</div>`;
  const old = rev.n !== last.n && p.tab !== 'history' ? `<div class="mb-12">${alertBox('default', `You’re viewing version ${rev.n} of ${a.revs.length}`, '', btn('View latest', { size: 'sm', act: 'wk-goto', data: { rev: last.n } }) + btn('Restore', { v: 'ghost', size: 'sm', act: 'wk-restore', data: { rev: rev.n } }), { icon: 'history' })}</div>` : '';
  let body;
  if (p.tab === 'history') body = historyHtml(a, rev);
  else if (p.tab === 'changes') body = !prev ? emptyState({ icon: 'git-compare', title: 'This is the first version', desc: sheet ? 'Edit a cell or ask for changes to make a new version.' : 'Edit it or ask for changes to make a new version.', compact: true })
    : `<div class="wk-legend"><span><i class="wk-legend__add"></i>Added</span>${sheet ? '<span><i class="wk-legend__chg"></i>Changed</span>' : ''}<span><i class="wk-legend__del"></i>Removed</span><span class="grow"></span><span class="medium truncate">v${prev.n} → v${rev.n} · ${esc(rev.summary)}</span></div>` + (sheet ? sheetHtml(a, rev, p, prev) : `<div class="wk-doc"><article class="wk-page wk-page--diff">${docDiffHtml(prev.html, rev.html)}</article></div>`);
  else if (sheet) body = sheetHtml(a, rev, p, null);
  else if (p.edit) body = `<div class="wk-etb" role="toolbar" aria-label="Formatting">${[['bold', '<b>B</b>', 'Bold'], ['italic', '<i>I</i>', 'Italic'], ['formatBlock:h3', '<b>H</b>', 'Heading'], ['insertUnorderedList', ic('list', 'i-sm'), 'Bulleted list'], ['undo', ic('undo', 'i-sm'), 'Undo']].map(([c, l, t]) => `<button type="button" class="button button--ghost button--sm button--icon-only button--muted" data-wk-cmd="${c}" aria-label="${t}" data-tip="${t}">${l}</button>`).join('')}<span class="grow"></span><span class="t-xs muted">Saving makes version ${a.revs.length + 1}</span></div><div class="wk-doc"><article class="wk-page is-editing" contenteditable="true" id="wk-editor" data-input="wk-edit-input" role="textbox" aria-multiline="true" aria-label="Edit ${esc(a.title)}">${p.draft ?? rev.html}</article></div>`;
  else body = `<div class="wk-doc"><article class="wk-page">${rev.html}</article></div>`;
  const dirty = p.draft != null && p.draft !== rev.html;
  const foot = p.edit
    ? `<div class="panel__footer wk-edit-foot"><span class="grow t-xs muted" id="wk-edit-state">${dirty ? 'Unsaved changes' : 'No changes yet'}</span>${btn('Cancel', { size: 'sm', act: 'wk-edit-cancel' })}${btn(`Save as version ${a.revs.length + 1}`, { v: 'primary', size: 'sm', act: 'wk-edit-save', disabled: !dirty, id: 'wk-edit-save' })}</div>`
    : askHtml(a, streaming);
  return `<aside class="${cx('split__panel split__panel--wide wk-panel', p.full && 'wk-panel--full')}" aria-label="${esc(a.title)}">${head}${tabsH}<div class="panel__body wk-body" id="chat-panel-body" data-keep-scroll>${old}${body}</div>${foot}</aside>`;
}
/** Bring the first added/changed spreadsheet column into view once per version. */
function after() {
  const p = panelState(); if (!p) return; const key = `${p.art}:${p.rev}:${p.tab}`; if (p.scrolled === key) return; p.scrolled = key;
  const g = $('#wk-grid'); const c = g && (g.querySelector('thead th.is-add') || g.querySelector('td.is-chg'));
  if (g && c) g.scrollLeft = Math.max(0, c.offsetLeft - g.clientWidth + c.offsetWidth + 24);
}
/** True when there are no unsaved edits (and leaves edit mode); otherwise asks first and returns false. */
function leaveEdit(then) {
  const p = panelState(); if (!p?.edit) return true;
  const a = art(p.art);
  if (p.draft == null || p.draft === revOf(a, p.rev).html) { p.edit = false; p.draft = null; return true; }
  confirmAction({ title: 'Discard your edits?', body: 'Your changes haven’t been saved as a version.', confirm: 'Discard edits', danger: true, delay: 0, onConfirm: () => { p.edit = false; p.draft = null; if (then) then(); else refresh(); } });
  return false;
}

/* Panel actions */
A['wk-open'] = el => openFile(el.dataset.id, el.dataset.rev);
A['wk-tab'] = el => { const p = panelState(); if (!p) return; const go_ = () => { p.tab = el.dataset.value; p.cell = null; refresh(); }; if (leaveEdit(go_)) go_(); };
A['wk-goto'] = el => { const p = panelState(); if (!p) return; p.rev = +el.dataset.rev; if (p.tab === 'history') p.tab = 'preview'; p.cell = null; refresh(); };
A['wk-wide'] = () => { const p = panelState(); if (p) { p.full = !p.full; refresh(); } };
A['wk-sheet'] = el => { const p = panelState(); if (p) { p.sheet = +el.dataset.i; p.cell = null; refresh(); } };
A['wk-cell'] = el => {
  const p = panelState(); if (!p || p.tab !== 'preview') return;
  p.cell = { s: p.sheet || 0, r: +el.dataset.r, c: +el.dataset.c }; refresh();
  requestAnimationFrame(() => { const i = $('#wk-cell-in'); if (i) { i.focus(); i.select(); } });
};
A['wk-cell-save'] = () => {
  const p = panelState(); const inp = $('#wk-cell-in'); if (!p?.cell || !inp) return;
  const a = art(p.art); const base = latest(a); const sheets = clone(base.sheets); const sh = sheets[p.cell.s]; const { r, c } = p.cell;
  const ref = COL(c) + (r + 1); let v = inp.value;
  if (r === 0) { if (!v.trim() || v === sh.cols[c].n) { p.cell = null; refresh(); return; } sh.cols[c].n = v.trim(); }
  else {
    const old = sh.rows[r - 1][c];
    if ((sh.cols[c].f === 'usd' || typeof old === 'number') && v.trim() !== '') { const num = Number(v.replace(/[$,\s]/g, '')); if (!Number.isNaN(num)) v = num; }
    if (String(old) === String(v)) { p.cell = null; refresh(); return; }
    sh.rows[r - 1][c] = v;
  }
  const rv = addRev(a, { sheets, by: 'you', summary: `Edited ${ref}${sh.name !== base.sheets[0].name ? ` in ${sh.name}` : ''}` });
  Object.assign(p, { rev: rv.n, cell: null }); refresh();
  toast(`Saved as version ${rv.n}`, { action: { label: 'Undo', run: () => { if (latest(a) === rv) { a.revs.pop(); p.rev = latest(a).n; refresh(); } } } });
};
MENUS['wk-ver'] = el => {
  const a = art(el.dataset.id); const p = panelState(); if (!a || !p) return []; const last = latest(a);
  return [{ section: 'Versions' }, ...[...a.revs].reverse().map(r => ({ html: `<span class="stack grow" style="min-width:0"><span>Version ${r.n}${r.n === last.n ? ' · Latest' : ''}</span><span class="t-xs muted truncate">${esc(r.summary)} · ${rel(r.at).toLowerCase()}</span></span>`, checked: p.rev === r.n, run: () => { p.rev = r.n; p.cell = null; refresh(); } })),
    { sep: true }, { label: 'Compare with previous', icon: 'git-compare', disabled: revOf(a, p.rev).n === 1, run: () => { p.tab = 'changes'; refresh(); } }, { label: 'All versions', icon: 'history', run: () => { p.tab = 'history'; refresh(); } }];
};
function rowsOf(rev, si = 0) { const sh = rev?.sheets?.[si] || rev?.sheets?.[0]; return sh ? [sh.cols.map(c => c.n), ...sh.rows] : [['Content'], [String(rev?.html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()]]; }
function htmlToMd(html) {
  const d = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html');
  return [...d.body.firstChild.children].map(el => { const t = el.tagName; const tx = el.textContent.trim();
    if (t === 'H2') return '## ' + tx; if (t === 'H3') return '### ' + tx;
    if (t === 'UL') return [...el.children].map(li => '- ' + li.textContent.trim()).join('\n');
    if (t === 'OL') return [...el.children].map((li, i) => `${i + 1}. ${li.textContent.trim()}`).join('\n');
    if (t === 'TABLE') { const rows = [...el.querySelectorAll('tr')].map(tr => [...tr.children].map(c => c.textContent.trim())); return rows.map((r, i) => `| ${r.join(' | ')} |` + (i === 0 ? `\n|${r.map(() => '---').join('|')}|` : '')).join('\n'); }
    return tx; }).join('\n\n');
}
function download(a, rev, format) {
  const base = a.file.replace(/\.[^.]+$/, ''); const p = panelState(); const si = p?.art === a.id ? p.sheet || 0 : 0;
  const rows = rowsOf(rev, si); const msg = name => `Downloaded ${name} (version ${rev.n})`;
  if (format === 'csv') return saveCsv(base + '.csv', rows, msg(base + '.csv'));
  if (format === 'pdf') return savePdf(base + '.pdf', a.title, rev.html ? htmlToMd(rev.html).split('\n').filter(Boolean).slice(0, 44) : rows.slice(0, 44).map(r => r.map(v => typeof v === 'number' ? usd(v) : v).join(' | ')), msg(base + '.pdf'));
  if (format === 'word') return saveWord(base + '.doc', a.title, rev.html || `<table border="1" cellpadding="4">${rows.map(r => `<tr>${r.map(c => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</table>`, msg(base + '.doc'));
  if (format === 'md') return saveLocalFile(base + '.md', rev.html ? htmlToMd(rev.html) : rows.map(r => `| ${r.join(' | ')} |`).join('\n'), 'text/markdown;charset=utf-8', msg(base + '.md'));
}
MENUS['wk-dl'] = el => {
  const a = art(el.dataset.id); if (!a) return []; const rev = revOf(a, el.dataset.rev);
  return KIND(a.type) === 'sheet'
    ? [{ section: `Version ${rev.n}` }, { label: 'Spreadsheet as CSV', icon: 'table', meta: '.csv', run: () => download(a, rev, 'csv') }, { label: 'PDF', icon: 'file', meta: '.pdf', run: () => download(a, rev, 'pdf') }]
    : [{ section: `Version ${rev.n}` }, { label: 'Word document', icon: 'file-text', meta: '.doc', run: () => download(a, rev, 'word') }, { label: 'PDF', icon: 'file', meta: '.pdf', run: () => download(a, rev, 'pdf') }, { label: 'Markdown', icon: 'file', meta: '.md', run: () => download(a, rev, 'md') }];
};
MENUS['wk-file-more'] = el => {
  const a = art(el.dataset.id); if (!a) return [];
  return [{ label: 'Save to knowledge…', icon: 'book', disabled: !visibleKbs().some(canEditKb), run: () => A['wk-publish']({ dataset: { id: a.id } }) },
    { label: 'Rename', icon: 'pencil', run: () => { S.ui.wkRen = { id: a.id, v: a.title, err: '' }; openModal('wk-rename'); } },
    { sep: true }, { label: 'Show in conversation', icon: 'message', run: () => { const m = convById(a.conv)?.messages.find(x => (x.artifacts || []).some(r => r.id === a.id)); document.getElementById('msg-' + m?.id)?.scrollIntoView({ behavior: 'smooth', block: 'center' }); } }];
};
M['wk-rename'] = () => { const f = ui('wkRen'); return { size: 'sm', title: 'Rename file', body: field({ id: 'wk-ren', label: 'Name', error: f.err, control: input({ id: 'wk-ren', bind: 'wkRen.v', value: f.v, autofocus: true, onEnter: 'wk-ren-save', invalid: !!f.err }) }), foot: btn('Cancel', { act: 'close-modal' }) + btn('Save', { v: 'primary', act: 'wk-ren-save' }) }; };
A['wk-ren-save'] = () => {
  const f = ui('wkRen'); const v = f.v.trim(); if (!v) { f.err = 'Enter a name.'; refreshLayer(); return; }
  const a = art(f.id); const before = a.title; a.title = v; closeModal(); refresh();
  toast('File renamed', { action: { label: 'Undo', run: () => { a.title = before; refresh(); } } });
};
A['wk-restore'] = el => {
  const p = panelState(); const a = p && art(p.art); if (!a) return; const from = revOf(a, el.dataset.rev);
  confirmAction({ title: `Restore version ${from.n}?`, body: `This makes version ${a.revs.length + 1}, a copy of version ${from.n}. Every version stays in History.`, confirm: 'Restore', delay: 300,
    onConfirm: () => { const r = addRev(a, { ...(from.sheets ? { sheets: clone(from.sheets) } : { html: from.html }), by: 'you', summary: `Restored version ${from.n}` }); p.rev = r.n; p.tab = 'preview'; refresh(); toast(`Restored as version ${r.n}`); } });
};
/* Ask for changes → an assistant turn → a new version */
A['wk-ask-quick'] = el => { ui('wkAsk').text = el.dataset.q; A['wk-ask-send'](); };
A['wk-ask-send'] = () => {
  const f = ui('wkAsk', { text: '' }); const t = (f.text || '').trim(); const p = panelState(); const a = p && art(p.art);
  if (!a) return; if (!t) { $('#wk-ask-in')?.focus(); return; }
  if (C().busy()) { toast('Wait for the current answer to finish.', { tone: 'accent' }); return; }
  const conv = convById(a.conv); if (!conv) return;
  f.text = ''; C().ask(conv, `Update “${a.title}”: ${t}`);
};
/* Edit in place (documents) */
A['wk-edit'] = () => { const p = panelState(); if (!p) return; Object.assign(p, { edit: true, tab: 'preview', draft: null }); refresh(); requestAnimationFrame(() => $('#wk-editor')?.focus()); };
A['wk-edit-input'] = el => { const p = panelState(); if (!p) return; p.draft = el.innerHTML; const dirty = p.draft !== revOf(art(p.art), p.rev).html; const s = $('#wk-edit-state'); if (s) s.textContent = dirty ? 'Unsaved changes' : 'No changes yet'; const b = $('#wk-edit-save'); if (b) b.disabled = !dirty; };
A['wk-edit-cancel'] = () => { if (leaveEdit()) refresh(); };
A['wk-edit-save'] = () => {
  const p = panelState(); if (!p) return; const a = art(p.art); const html = $('#wk-editor')?.innerHTML ?? p.draft;
  const r = addRev(a, { html, by: 'you', summary: 'Edited by you' });
  Object.assign(p, { edit: false, draft: null, rev: r.n, tab: 'changes' }); refresh();
  toast(`Saved as version ${r.n}`, { action: { label: 'Undo', run: () => { if (latest(a) === r) { a.revs.pop(); p.rev = latest(a).n; p.tab = 'preview'; refresh(); } } } });
};
document.addEventListener('mousedown', e => {
  const b = e.target.closest?.('[data-wk-cmd]'); if (!b) return; e.preventDefault();
  const [cmd, arg] = b.dataset.wkCmd.split(':'); document.execCommand(cmd, false, arg ? `<${arg}>` : null);
  const ed = $('#wk-editor'); if (ed) A['wk-edit-input'](ed);
});
document.addEventListener('keydown', e => { const b = e.target.closest?.('[data-wk-cmd]'); if (b && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); b.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); } });

/* Save to knowledge: publish a version into a knowledge base you can edit */
A['wk-publish'] = el => {
  const a = art(el.dataset.id); const kbs = visibleKbs().filter(canEditKb); if (!a || !kbs.length) return;
  S.ui.wkPub = { id: a.id, kb: el.dataset.kb || a.published[0]?.kb || (kbs.find(k => !k.personal) || kbs[0]).id, name: a.file, err: '' };
  openModal('wk-publish');
};
M['wk-publish'] = p => {
  const f = ui('wkPub'); const a = art(f.id); const l = latest(a); const kbs = visibleKbs().filter(canEditKb); const kb = kbById(f.kb); const existing = a.published.find(x => x.kb === f.kb);
  const who = kb?.personal ? 'Only you can find it.' : kb?.general === 'workspace' ? `Everyone in ${curWs().name} can find and cite it.` : `People with access to ${kb?.name} can find and cite it.`;
  return { title: existing ? 'Update saved copy' : 'Save to knowledge', desc: `${esc(a.title)} · version ${l.n}`,
    body: field({ id: 'wk-pub-kb', label: 'Knowledge base', control: select({ id: 'wk-pub-kb', bind: 'wkPub.kb', value: f.kb, change: 'wk-pub-kb', options: kbs.map(k => [k.id, k.name]) }) })
      + field({ id: 'wk-pub-name', label: 'Document name', error: f.err, control: input({ id: 'wk-pub-name', bind: 'wkPub.name', value: f.name, invalid: !!f.err }) })
      + `<p class="t-sm muted mt-16">${existing ? `Replaces version ${existing.rev}. ` : ''}${who}</p>`,
    foot: btn('Cancel', { act: 'close-modal' }) + btn(existing ? `Update to version ${l.n}` : 'Save', { v: 'primary', act: 'wk-pub-save', loading: p.busy }) };
};
A['wk-pub-kb'] = () => refreshLayer();
A['wk-pub-save'] = async () => {
  const f = ui('wkPub'); const a = art(f.id); const l = latest(a); const kb = kbById(f.kb); const name = f.name.trim();
  if (!name) { f.err = 'Enter a document name.'; refreshLayer(); return; }
  const p = S.modal.props; p.busy = true; p.guard = true; refreshLayer(); await sleep(800);
  const ex = a.published.find(x => x.kb === f.kb); let doc = ex && docById(ex.doc);
  if (doc) Object.assign(doc, { status: 'processing', updated: Date.now(), name });
  else { doc = mkDoc(f.kb, uid('d-pub'), name, { addedBy: me().name, updated: Date.now(), status: 'processing', size: l.size, pages: 2 }); D.docs.push(doc); }
  if (ex) Object.assign(ex, { rev: l.n, at: Date.now() }); else a.published.push({ kb: f.kb, rev: l.n, at: Date.now(), doc: doc.id });
  D.audit.unshift({ id: uid('ev'), at: Date.now(), actor: me().id, action: ex ? 'Updated a saved file' : 'Saved a file from chat', type: 'Knowledge', target: `${name} → ${kb.name}`, outcome: 'success', ip: '10.4.12.30', device: 'Chrome on macOS' });
  closeModal(); refresh();
  toast(ex ? `Updated in ${kb.name}` : `Saved to ${kb.name}`, { action: { label: 'Open', run: () => go('/knowledge/' + kb.id) } });
  setTimeout(() => { doc.status = 'ready'; persist(); }, 3500);
};

/* ═══════════════ Attachments ═══════════════ */
const BLOCKED = /\.(mp4|mov|avi|mkv|exe|dmg|iso|app|msi)$/i;
const MAX = 5, MAXB = 100 * 1048576;
function chipHtml(f, i, inComposer) {
  const t = f.type || f.name.split('.').pop().toLowerCase();
  const doc = f.doc && docById(f.doc); const locked = f.kind === 'ref' && doc && !C().canDoc(doc);
  const x = inComposer && (f.ready || f.error) ? `<button type="button" class="wk-chip__x" data-act="wk-unattach" data-i="${i}" aria-label="Remove ${esc(f.name)}" data-tip="Remove">${ic('x', 'i-xs')}</button>` : '';
  if (f.error) return `<span class="wk-chip is-err" role="group" aria-label="${esc(f.name)}: ${esc(f.error)}" data-tip="${esc(f.error)}">${ic('alert-circle', 'i-sm')}<span class="wk-chip__name truncate">${esc(f.name)}</span><span class="wk-chip__meta">Can’t attach</span>${x}</span>`;
  const uploading = f.progress != null && f.progress < 100;
  const state = uploading ? `<span class="wk-chip__meta num">${Math.round(f.progress)}%</span>` : !f.ready && inComposer ? '<span class="wk-chip__meta">Reading…</span>' : '';
  const meta = f.kind === 'ref' ? `<span class="wk-chip__meta truncate">${locked ? 'No access' : esc(kbById(doc?.kb)?.name || 'Knowledge')}</span>` : '';
  const inner = `${locked ? ic('lock', 'i-sm') : fileIcon(t, 'sm')}<span class="wk-chip__name truncate">${esc(f.name)}</span>${meta}${state}${x}${uploading ? `<span class="wk-chip__bar" style="width:${f.progress}%"></span>` : ''}`;
  const cls = cx('wk-chip', f.kind === 'ref' && 'is-ref', locked && 'is-locked');
  const tip = f.kind === 'ref' ? 'From knowledge — read in place, not copied' : 'Saved to My files';
  return !inComposer && doc && !locked ? `<a class="${cls}" href="#/doc/${doc.id}" data-tip="${tip}">${inner}</a>` : `<span class="${cls}" ${f.ready ? `data-tip="${tip}"` : ''}>${inner}</span>`;
}
function paintFiles(key) {
  if (C().composerKey() !== key) return;
  const box = $('#chat-files'); if (!box) return;
  box.innerHTML = C().composer(key).files.map((f, i) => chipHtml(f, i, true)).join('');
}
async function addFiles(list, key = C().composerKey()) {
  const c = C().composer(key); const fresh = [];
  for (const raw of list) {
    if (c.files.length >= MAX) { toast(`You can add up to ${MAX} files to one message.`, { tone: 'accent' }); break; }
    const name = raw.name, type = name.split('.').pop().toLowerCase();
    const f = { name, type, kind: 'upload', ready: false, progress: 0, size: raw.size || 120e3 };
    if (BLOCKED.test(name)) { f.error = 'Video and app files can’t be attached'; f.progress = null; }
    else if (f.size > MAXB) { f.error = 'Larger than 100 MB'; f.progress = null; }
    else fresh.push(f);
    c.files.push(f);
  }
  refresh();
  await Promise.all(fresh.map(async f => {
    for (let p = 0; p < 100; p += 18 + Math.random() * 20) { f.progress = p; paintFiles(key); await sleep(140); }
    f.progress = null; paintFiles(key); await sleep(400);
    f.ready = true;
    const mine = C().mineKb();
    const ex = D.docs.find(d => d.kb === mine && d.name === f.name);
    if (ex) f.doc = ex.id;
    else { const d = mkDoc(mine, uid('d-me'), f.name, { addedBy: 'You', updated: Date.now(), pages: 4, size: f.size, status: ['png', 'jpg', 'jpeg', 'gif'].includes(f.type) ? 'unsupported' : 'ready' }); D.docs.push(d); f.doc = d.id; }
  }));
  if (fresh.length) { refresh(); C().focusComposer(); toast(fresh.length > 1 ? `Added ${fresh.length} files to My files` : `Added ${fresh[0].name} to My files`); }
}
A['wk-unattach'] = el => { C().composer(C().composerKey()).files.splice(+el.dataset.i, 1); refresh(); C().focusComposer(); };
A['wk-file-picked'] = el => { const fs = [...el.files].map(f => ({ name: f.name, size: f.size })); el.value = ''; if (fs.length) addFiles(fs); };
MENUS['wk-attach'] = () => [
  { section: 'Add to this message' },
  { label: 'Upload from computer…', icon: 'upload', meta: 'To My files', run: () => $('#wk-file-in')?.click() },
  { label: 'Add from knowledge…', icon: 'book', meta: 'Read in place', run: () => openPicker() },
];
/* Drag and drop onto the chat */
document.addEventListener('dragover', e => {
  const zone = e.target.closest?.('.chat-drop'); if (!zone || !e.dataTransfer?.types?.includes('Files')) return;
  e.preventDefault();
  if (!zone.querySelector('.wk-drop')) zone.insertAdjacentHTML('beforeend', `<div class="wk-drop" aria-hidden="true">${ic('upload', 'i-lg')}<span class="medium">Drop files to attach</span><span class="t-xs muted">PDF, Office, text and CSV · up to 100 MB</span></div>`);
});
document.addEventListener('dragleave', e => { const zone = e.target.closest?.('.chat-drop'); if (zone && !zone.contains(e.relatedTarget)) zone.querySelector('.wk-drop')?.remove(); });
document.addEventListener('drop', e => {
  const zone = e.target.closest?.('.chat-drop'); $$('.wk-drop').forEach(x => x.remove()); if (!zone) return;
  e.preventDefault(); const fs = [...(e.dataTransfer?.files || [])].map(f => ({ name: f.name, size: f.size })); if (fs.length) addFiles(fs, zone.dataset.drop);
});

/* Add from knowledge: reference documents instead of re-uploading — to this message, or (wkPick.project) to a project. */
function openPicker() { S.ui.wkPick = { q: '', sel: {} }; openModal('wk-pick'); }
M['wk-pick'] = () => {
  const p = ui('wkPick', { q: '', sel: {} }); const q = p.q.trim().toLowerCase();
  const proj = p.project && X.projects?.byId(p.project), c = proj ? null : C().composer(C().composerKey());
  const have = proj ? X.projects.docIds(proj.id) : c.files.map(f => f.doc);
  const room = proj ? X.projects.room(proj.id) : MAX - c.files.length; const n = Object.values(p.sel).filter(Boolean).length;
  const docs = D.docs.filter(d => !d.archived && d.status !== 'unsupported' && C().canDoc(d) && !have.includes(d.id) && (!q || d.name.toLowerCase().includes(q)));
  const groups = visibleKbs().filter(canReadKb).map(k => [k, docs.filter(d => d.kb === k.id)]).filter(([, l]) => l.length);
  const body = `<div class="search-field wk-pick__search">${ic('search')}${input({ id: 'wk-pick-q', bind: 'wkPick.q', value: p.q, placeholder: 'Search documents you can access', attrs: 'data-live aria-label="Search documents"', autofocus: true, size: 'sm' })}</div>
    ${groups.length ? groups.map(([k, l]) => `<div class="wk-pick__group"><div class="t-label mb-8">${esc(k.name)}</div>${l.slice(0, q ? 20 : 4).map(d => `<div class="wk-pick__row">${checkbox({ checked: !!p.sel[d.id], act: 'wk-pick-t', data: { id: d.id }, disabled: !p.sel[d.id] && n >= room, label: `${fileIcon(d.type, 'sm')}<span class="grow truncate">${esc(d.name)}</span><span class="t-xs muted none">${rel(d.updated)}</span>` })}</div>`).join('')}</div>`).join('')
      : emptyState({ icon: 'search', title: 'No documents match', desc: 'Try another word.', compact: true })}`;
  return { size: 'lg', title: proj ? `Add knowledge to ${proj.name}` : 'Add from knowledge', desc: proj ? 'Every new chat in this project starts with these. Nothing is copied, and access rules still apply.' : 'The assistant reads these where they are. Nothing is copied, and access rules still apply.', body,
    footStart: `<span class="t-sm muted">${room <= 0 ? (proj ? 'This project already has 10 documents' : 'This message already has 5 files') : `${n} of ${room} selected`}</span>`,
    foot: btn('Cancel', { act: 'close-modal' }) + btn(n ? `Add ${plural(n, 'document')}` : 'Add documents', { v: 'primary', act: 'wk-pick-add', disabled: !n }) };
};
A['wk-pick-t'] = (el, e) => { e?.stopPropagation(); const p = ui('wkPick'); p.sel[el.dataset.id] = !p.sel[el.dataset.id]; refreshLayer(); };
A['wk-pick-add'] = () => {
  const p = ui('wkPick'), ids = Object.entries(p.sel).filter(([, v]) => v).map(([id]) => id);
  if (p.project) { const n = X.projects?.addDocs(p.project, ids) || 0; closeModal(); refresh(); if (n) toast(`Added ${plural(n, 'document')} to the project`); return; }
  const c = C().composer(C().composerKey());
  ids.forEach(id => { const d = docById(id); if (d && c.files.length < MAX && !c.files.some(f => f.doc === id)) c.files.push({ name: d.name, type: d.type, kind: 'ref', doc: id, ready: true }); });
  closeModal(); refresh(); C().focusComposer();
};

X.chatFiles = { plan, afterStream, migrate, cards, panel, chip: chipHtml, after, leaveEdit, openFile };
})();
