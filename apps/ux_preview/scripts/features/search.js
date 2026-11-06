/* Search (/search?q=): a grouped overview of one query across the workspace — documents (the resource catalog, same ranking
   and access rules as Knowledge), collections, knowledge bases, conversations and, for people managers, people. Documents show
   the top five and hand the full set to Knowledge (its filters and sort); other types open their full list here (?tab=type).
   One matcher and one highlighter for every group: accent-insensitive words matched at word starts (catalog.js markTokens),
   shown with the neutral search highlight — never the amber evidence colour. Asking the assistant is one click. */
(() => {
  'use strict';

  const PER_GROUP = 5, PER_PAGE = 20;
  /** Every query word (folded) starts a word somewhere in the texts. */
  function matches(toks, ...texts) {
    if (!toks.length) return false;
    const words = ' ' + texts.map(t => fold(t).replace(/[^\p{L}\p{N}]+/gu, ' ')).join(' ');
    return toks.every(t => words.includes(' ' + t));
  }
  function snippet(text, toks) {
    const low = fold(text), i = toks.map(t => low.search(new RegExp(`(^|[^\\p{L}\\p{N}])${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'u'))).filter(x => x >= 0).sort((a, b) => a - b)[0];
    if (i == null) return '';
    const start = Math.max(0, text.lastIndexOf(' ', Math.max(0, i - 60)) + 1), end = Math.min(text.length, i + 140);
    return (start > 0 ? '…' : '') + markTokens(text.slice(start, end).trim(), toks) + (end < text.length ? '…' : '');
  }

  function results(q) {
    const toks = tokens(q);
    const docs = catalogSearch(parseCatalogQuery({ q })).rows.map(x => x.doc);
    const cols = visibleCollections().filter(c => matches(toks, c.name, c.desc));
    const kbs = visibleKbs().filter(k => matches(toks, k.name, k.desc));
    const convs = myConvs().map(c => {
      const msg = (c.messages || []).find(m => matches(toks, m.text));
      const text = msg ? (X.chat?.plain(msg.text) ?? msg.text.replace(/\*\*|\[\d+\]/g, '')).replace(/\s+/g, ' ') : '';
      return matches(toks, c.title) || msg ? { c, snip: msg ? snippet(text, toks) : '' } : null;
    }).filter(Boolean).sort((a, b) => b.c.at - a.c.at);
    const people = can('user.manage') ? D.members.filter(m => matches(toks, m.name, m.email)) : [];
    return { toks, docs, cols, kbs, convs, people };
  }

  const colItem = (c, toks) => {
    const s = shareLabel(c);
    return item({
      lead: itemIcon('layers', '', 'sm'), title: markTokens(c.name, toks), desc: c.desc ? markTokens(c.desc, toks) : '',
      meta: `<span class="row gap-4">${ic(s.icon, 'i-xs')}${esc(s.label)}</span> · ${plural(c.items.length, 'item')}`, href: '/knowledge/collections/' + c.id,
    });
  };
  const kbItem = (k, toks) => {
    const locked = kbRole(k) === 'none';
    return item({
      lead: X.kbMark(k, 32, locked), title: markTokens(k.name, toks), desc: markTokens(k.desc || '', toks),
      meta: locked ? chip('Locked', { icon: 'lock', size: 'sm' }) : plural(docsIn(k.id).length, 'document'), href: kbHref(k),
    });
  };
  const convItem = ({ c, snip }, toks) => item({ lead: itemIcon('message', '', 'sm'), title: markTokens(c.title, toks), desc: snip, meta: rel(c.at), href: '/chat/' + c.id });
  const personItem = (m, toks) => item({ lead: avatar(m.name, 'sm'), title: markTokens(m.name, toks), desc: markTokens(m.email, toks), meta: esc(roleById(m.roleId)?.name || ''), act: 'srch-person', data: { id: m.id } });

  P.search = ({ query }) => {
    const q = (query.q || '').trim();
    const box = `<h1 class="sr-only">Search</h1><div class="srch-top">${searchField({ id: 'srch-q', value: query.q || '', act: 'srch-q', size: 'lg', autofocus: true, placeholder: 'Search documents, knowledge bases and conversations', label: 'Search' })}</div>`;
    if (!q) return `<div class="page page--narrow">${box}${emptyState({ icon: 'search', title: 'Search your workspace', desc: 'Find documents by name or content, knowledge bases and past conversations.' })}</div>`;

    const r = results(q), toks = r.toks;
    const groups = [
      { id: 'docs', label: 'Documents', rows: r.docs, render: rows => X.res.rows(rows, { q, data: { q } }) },
      { id: 'cols', label: 'Collections', rows: r.cols, item: colItem },
      { id: 'kbs', label: 'Knowledge bases', rows: r.kbs, item: kbItem },
      { id: 'convs', label: 'Conversations', rows: r.convs, item: convItem },
      can('user.manage') && { id: 'people', label: 'People', rows: r.people, item: personItem },
    ].filter(Boolean);
    const renderRows = (g, rows) => (g.render ? g.render(rows) : list(rows.map(x => g.item(x, toks)), 'srch-list'));
    const total = groups.reduce((a, g) => a + g.rows.length, 0);
    // Documents never paginate here: their full set (with filters and sort) is Knowledge.
    const open = groups.find(g => g.id === query.tab && g.id !== 'docs');
    // Same wording as Home and ⌘K: "Ask AI", answered with sources.
    const ask = `<button type="button" class="card card--action srch-ask" data-act="srch-ask">${itemIcon('sparkles', 'accent')}<span class="grow stack"><span class="medium">Ask AI</span><span class="t-sm muted truncate"><span translate="no">“${esc(q)}”</span> · Answer with sources</span></span>${ic('arrow-right', 'muted')}</button>`;
    const more = g => (g.id === 'docs'
      ? linkBtn(g.rows.length > PER_GROUP ? `See all ${fmtNum(g.rows.length)} in Knowledge` : 'Open in Knowledge', { href: catalogHref({ q }), icon: 'arrow-right' })
      : g.rows.length > PER_GROUP ? linkBtn(`See all ${fmtNum(g.rows.length)}`, { act: 'srch-tab', data: { value: g.id }, icon: 'arrow-right' }) : '');

    const body = gate({
      loading: () => skelRows(6),
      empty: () => emptyState({ icon: 'search', title: `No results for “${q}”`, desc: 'Try different words, or ask AI above.', boxed: true }),
      ok: () => {
        if (!total) return emptyState({ icon: 'search', title: `No results for “${q}”`, desc: 'Try different words, or ask AI above — it answers from everything you can access.', actions: btn('Clear search', { act: 'srch-clear' }), boxed: true });
        if (open) {
          const page = paginate(open.rows, 'srch', PER_PAGE);
          return `<div class="srch-back">${btn('All results', { v: 'ghost', size: 'sm', icon: 'arrow-left', act: 'srch-tab', data: { value: 'all' } })}</div>`
            + section(`${open.label} · ${fmtNum(open.rows.length)}`, renderRows(open, page) + pager(open.rows.length, 'srch', PER_PAGE));
        }
        return groups.filter(g => g.rows.length).map(g => section(g.label, renderRows(g, g.rows.slice(0, PER_GROUP)), { actions: more(g) })).join('');
      },
    });
    return `<div class="page page--narrow">${box}${ask}${body}</div>`;
  };
  A['srch-q'] = el => { ui('srch').page = 1; setQuery({ q: el.value }); };
  A['srch-clear'] = () => { setQuery({ q: '', tab: '' }); $('#srch-q')?.focus(); };
  A['srch-tab'] = el => { ui('srch').page = 1; setQuery({ tab: el.dataset.value === 'all' ? '' : el.dataset.value }); $('#scroll')?.scrollTo({ top: 0 }); };
  A['srch-ask'] = () => { const q = (S.cur.query.q || '').trim(); if (!q) return; if (A['chat-ask']) A['chat-ask']({ dataset: { q } }); else go('/chat'); };
  A['srch-person'] = el => { const id = el.dataset.id; if (A['member-open']) goThen('/people', () => A['member-open']({ dataset: { id } })); else go('/people'); };
})();
