/* Your work → Recent (/recent): what the caller opened or worked on lately — documents they opened, their
   conversations and the work they own or edit (Work module) — in one time-ordered list, grouped Today ·
   This week · Earlier. `?kind=documents|conversations|work` filters it (the seg shows only kinds that exist).
   A row opens its object: documents in the document preview, conversations in AI Chat, work on its page.
   Action: recent-kind. */
(() => {
  'use strict';

  const KINDS = [['documents', 'Documents'], ['conversations', 'Conversations'], ['work', 'Work']];
  const UK = 'recent';

  /** Everything the caller touched, newest first: [{ kind, at, title, row }]. */
  function entries() {
    const out = [];
    recentResources().forEach(({ doc: d, at }) => out.push({ kind: 'documents', at, title: docTitle(d), d }));
    myConvs().forEach(c => out.push({ kind: 'conversations', at: c.at, title: c.title, c }));
    if (hasModule('work') && X.worksVisible) {
      X.worksVisible().filter(w => w.owner === me().id || X.work.canEdit(w)).forEach(w => out.push({ kind: 'work', at: w.updated || w.created, title: w.title, w }));
    }
    return out.filter(e => e.at).sort((a, b) => b.at - a.at);
  }

  function row(e) {
    const meta = esc(rel(e.at));
    // File icons are narrower than icon tiles: centre them in the tile's width so every title starts on one line.
    if (e.d) return item({ lead: `<span style="display:grid;place-items:center;width:28px">${fileIcon(e.d.type, 'sm')}</span>`, title: esc(e.title), desc: esc(['Document', kbById(e.d.kb)?.name].filter(Boolean).join(' · ')), meta, act: 'doc-preview', data: { id: e.d.id } });
    if (e.c) return item({ lead: itemIcon('message', '', 'sm'), title: esc(e.title), desc: esc(['Conversation', X.projects?.of(e.c)?.name].filter(Boolean).join(' · ')), meta, href: '/chat/' + e.c.id });
    const w = e.w;
    return item({ lead: X.work.tile(w, 'sm'), title: esc(e.title), titleExtra: X.work.statusChip(w), desc: esc(['Work', spaceById(w.space)?.name].filter(Boolean).join(' · ')), meta, href: '/work/' + w.id });
  }

  /** Today · This week (the six days before today) · Earlier. */
  function groups(list) {
    const today = new Date().setHours(0, 0, 0, 0), week = today - 6 * DAY;
    return [['Today', e => e.at >= today], ['This week', e => e.at >= week && e.at < today], ['Earlier', e => e.at < week]]
      .map(([label, test]) => [label, list.filter(test)]).filter(([, rows]) => rows.length);
  }

  P.recent = ({ query }) => {
    const all = entries(), present = KINDS.filter(([k]) => all.some(e => e.kind === k));
    const kind = present.some(([k]) => k === query.kind) ? query.kind : 'all';
    const ofKind = kind === 'all' ? all : all.filter(e => e.kind === kind);
    const rows = ofKind.filter(e => matchesQ(UK, e.title));
    const head = pageHeader({ title: 'Recent' });
    const empty = () => emptyState({ icon: 'clock', title: 'Nothing here yet', desc: 'Documents you open, your conversations and your work show up here, newest first.', actions: btn('Browse knowledge', { v: 'primary', icon: 'book', href: '/knowledge' }) + btn('Start a chat', { icon: 'message', href: '/chat' }), boxed: true });
    const body = gate({
      empty,
      ok: () => {
        if (!all.length) return empty();
        const filter = present.length > 1 ? seg({ value: kind, options: [['all', 'All'], ...present], act: 'recent-kind', label: 'Show' }) : '';
        const search = needsTools(ofKind.length, UK) ? searchField({ uiKey: UK, placeholder: 'Search recent' }) : '';
        const toolbar = filter || search ? `<div class="toolbar">${filter}${search}</div>` : '';
        if (!rows.length) return toolbar + noMatches(UK, [], 'items');
        return toolbar + `<div class="stack gap-24">${groups(rows).map(([label, list_], i) => `<section aria-labelledby="recent-g${i}"><h2 class="t-label mb-8" id="recent-g${i}">${esc(label)}</h2>${list(list_.map(row))}</section>`).join('')}</div>`;
      },
    });
    return `<div class="page page--narrow">${head}${body}</div>`;
  };

  A['recent-kind'] = el => setQuery({ kind: el.dataset.value === 'all' ? '' : el.dataset.value });
})();
