/* Search (/search?q=): one query across knowledge (the resource catalog —
   same ranking and access rules as Browse), collections, knowledge bases,
   conversations and — for people managers — people. Results are grouped with
   counts; Browse holds the full result set; asking the assistant is one click. */
(() => {
  'use strict';

  const PER_GROUP = 5, PER_PAGE = 20;
  /** Highlight q inside text (case-insensitive), escaping everything. */
  function hl(text, q) {
    const s = String(text ?? ''); if (!q) return esc(s);
    const low = s.toLowerCase(), n = q.toLowerCase(); let out = '', at = 0, i;
    while ((i = low.indexOf(n, at)) !== -1) { out += esc(s.slice(at, i)) + `<mark class="srch-hl">${esc(s.slice(i, i + n.length))}</mark>`; at = i + n.length; }
    return out + esc(s.slice(at));
  }
  function snippet(text, q) {
    const i = text.toLowerCase().indexOf(q.toLowerCase()); if (i < 0) return '';
    const start = Math.max(0, text.lastIndexOf(' ', Math.max(0, i - 60)) + 1), end = Math.min(text.length, i + q.length + 120);
    return (start > 0 ? '…' : '') + hl(text.slice(start, end).trim(), q) + (end < text.length ? '…' : '');
  }
  const has = (t, q) => String(t ?? '').toLowerCase().includes(q.toLowerCase());

  function results(q) {
    const docs = catalogSearch(parseCatalogQuery({ q })).rows.map(x => x.doc);
    const fq = fold(q), fhas = t => fold(t).includes(fq);
    const cols = visibleCollections().filter(c => fhas(c.name) || fhas(c.desc));
    const kbs = visibleKbs().filter(k => has(k.name, q) || has(k.desc, q));
    const convs = myConvs().map(c => {
      const msg = (c.messages || []).find(m => has(m.text, q));
      const text = msg ? (X.chat?.plain(msg.text) ?? msg.text.replace(/\*\*|\[\d+\]/g, '')).replace(/\s+/g, ' ') : '';
      return has(c.title, q) || msg ? { c, snip: msg ? snippet(text, q) : '' } : null;
    }).filter(Boolean).sort((a, b) => b.c.at - a.c.at);
    const people = can('user.manage') ? D.members.filter(m => has(m.name, q) || has(m.email, q)) : [];
    return { docs, cols, kbs, convs, people };
  }

  const colItem = (c, q) => {
    const s = shareLabel(c);
    return item({
      lead: itemIcon('layers', '', 'sm'), title: markTokens(c.name, tokens(q)), desc: c.desc ? markTokens(c.desc, tokens(q)) : '',
      meta: `<span class="row gap-4">${ic(s.icon, 'i-xs')}${esc(s.label)}</span> · ${plural(c.items.length, 'item')}`, href: '/knowledge/collections/' + c.id,
    });
  };
  const kbItem = (k, q) => {
    const locked = kbRole(k) === 'none';
    return item({
      lead: X.kbMark(k, 32, locked), title: hl(k.name, q), desc: hl(k.desc || '', q),
      meta: locked ? chip('Locked', { icon: 'lock', size: 'sm' }) : plural(docsIn(k.id).length, 'document'), href: '/knowledge/' + k.id,
    });
  };
  const convItem = ({ c, snip }, q) => item({ lead: itemIcon('message', '', 'sm'), title: hl(c.title, q), desc: snip, meta: rel(c.at), href: '/chat/' + c.id });
  const personItem = (m, q) => item({ lead: avatar(m.name, 'sm'), title: hl(m.name, q), desc: hl(m.email, q), meta: esc(roleById(m.roleId)?.name || ''), act: 'srch-person', data: { id: m.id } });
  P.search = ({ query }) => {
    const q = (query.q || '').trim();
    const box = `<h1 class="sr-only">Search</h1><div class="srch-box">${ic('search', 'i-lg')}<input class="input input--lg" id="srch-q" type="search" value="${esc(query.q || '')}" placeholder="Search documents, knowledge and conversations" aria-label="Search" data-input="srch-q" autocomplete="off" data-autofocus>${q ? `<span class="srch-box__clear">${iconBtn('x', 'Clear search', { size: 'sm', act: 'srch-clear' })}</span>` : ''}</div>`;
    if (!q) return `<div class="page page--narrow">${box}${emptyState({ icon: 'search', title: 'Search your workspace', desc: 'Find documents by name or content, knowledge bases and past conversations.' })}</div>`;

    const r = results(q);
    const browse = linkBtn(r.docs.length > PER_GROUP ? `See all ${fmtNum(r.docs.length)} in Browse` : 'See all in Browse', { href: catalogHref({ q }), icon: 'arrow-right' });
    const groups = [
      { id: 'docs', label: 'Documents', rows: r.docs, render: rows => X.res.rows(rows, { q, data: { q } }), actions: browse, foot: `<div class="srch-more">${browse}</div>` },
      { id: 'cols', label: 'Collections', rows: r.cols, item: colItem },
      { id: 'kbs', label: 'Knowledge bases', rows: r.kbs, item: kbItem },
      { id: 'convs', label: 'Conversations', rows: r.convs, item: convItem },
      can('user.manage') && { id: 'people', label: 'People', rows: r.people, item: personItem },
    ].filter(Boolean);
    const renderRows = (g, rows) => (g.render ? g.render(rows) : list(rows.map(x => g.item(x, q)), 'srch-list'));
    const total = groups.reduce((a, g) => a + g.rows.length, 0);
    const tab = groups.some(g => g.id === query.tab) ? query.tab : 'all';
    const ask = `<button type="button" class="card card--action srch-ask" data-act="srch-ask">${itemIcon('sparkles', 'accent')}<span class="grow stack"><span class="medium">Ask the assistant</span><span class="t-sm muted truncate">“${esc(q)}”</span></span>${ic('arrow-right', 'muted')}</button>`;

    const body = gate({
      loading: () => skelRows(6),
      empty: () => emptyState({ icon: 'search', title: `No results for “${q}”`, desc: 'Try different words, or ask the assistant.', boxed: true }),
      ok: () => {
        if (!total) return emptyState({ icon: 'search', title: `No results for “${q}”`, desc: 'Try different words, or ask the assistant — it can find answers across everything you can access.', actions: btn('Clear search', { act: 'srch-clear' }), boxed: true });
        const tabsHtml = `<div class="page-tabs">${tabs([{ id: 'all', label: 'All', count: total }, ...groups.map(g => ({ id: g.id, label: g.label, count: g.rows.length }))], tab, '', { act: 'srch-tab' })}</div>`;
        if (tab === 'all') {
          return tabsHtml + groups.filter(g => g.rows.length).map(g => section(g.label, renderRows(g, g.rows.slice(0, PER_GROUP)), { actions: g.actions || (g.rows.length > PER_GROUP ? linkBtn(`See all ${fmtNum(g.rows.length)}`, { act: 'srch-tab', data: { value: g.id } }) : '') })).join('');
        }
        const g = groups.find(x => x.id === tab);
        if (!g.rows.length) return tabsHtml + emptyState({ icon: 'search', title: `No ${g.label.toLowerCase()} match`, desc: 'Try another word.', boxed: true, compact: true });
        const page = paginate(g.rows, 'srch', PER_PAGE);
        return tabsHtml + renderRows(g, page) + pager(g.rows.length, 'srch', PER_PAGE) + (g.foot || '');
      },
    });
    return `<div class="page page--narrow">${box}${ask}${body}</div>`;
  };
  A['srch-q'] = el => { ui('srch').page = 1; setQuery({ q: el.value }); };
  A['srch-clear'] = () => { setQuery({ q: '', tab: '' }); $('#srch-q')?.focus(); };
  A['srch-tab'] = el => { ui('srch').page = 1; setQuery({ tab: el.dataset.value === 'all' ? '' : el.dataset.value }); };
  A['srch-ask'] = () => { const q = (S.cur.query.q || '').trim(); if (!q) return; if (A['chat-ask']) A['chat-ask']({ dataset: { q } }); else go('/chat'); };
  A['srch-person'] = el => { const id = el.dataset.id; if (A['member-open']) goThen('/people', () => A['member-open']({ dataset: { id } })); else go('/people'); };
})();
