'use strict';
/* Prototype controls — outside the product. Demo workspace, persona, forced
   page state, theme, device width, end-to-end journeys, design system and
   data reset. */
const DEMO_WORKSPACES = [['ws-northwind', 'Northwind'], ['ws-finx', 'Finx']];
const JOURNEYS = [
  { ws: 'ws-northwind', who: 'member', title: 'Sign in and ask a question', run: () => { S.signedIn = false; go('/signin'); } },
  { ws: 'ws-northwind', who: 'member', title: 'Start from Home: ask, find or pick up', run: () => go('/home') },
  { ws: 'ws-northwind', who: 'member', title: 'Verify where an answer came from', run: () => goThen('/chat/c1', () => A['cite-open']?.({ dataset: { msg: 'm2', n: '1' } })) },
  { ws: 'ws-northwind', who: 'member', title: 'Find verified sales material', run: () => go('/knowledge?topic=d-sales&trust=verified') },
  { ws: 'ws-northwind', who: 'member', title: 'Request access to restricted knowledge', run: () => go('/knowledge/bases') },
  { ws: 'ws-northwind', who: 'member', title: 'Contribute a document and track it', run: () => goThen('/knowledge', () => A['contribute']?.()) },
  { ws: 'ws-northwind', who: 'member', title: 'Revise a document a reviewer sent back', run: () => go('/knowledge/library?tab=contributions&open=d-sub-2') },
  { ws: 'ws-northwind', who: 'member', title: 'First-run product tour', run: () => X.startTour?.() },
  { ws: 'ws-northwind', who: 'admin', title: 'Create a knowledge base and add files', run: () => goThen('/knowledge/bases', () => A['kb-create']?.()) },
  { ws: 'ws-northwind', who: 'admin', title: 'Review and publish submissions', run: () => go('/documents?tab=review') },
  { ws: 'ws-northwind', who: 'admin', title: 'Merge a duplicate document', run: () => go('/documents?tab=quality&seg=duplicates') },
  { ws: 'ws-northwind', who: 'admin', title: 'Connect a source', run: () => goThen('/sources', () => A['src-connect']?.()) },
  { ws: 'ws-northwind', who: 'admin', title: 'Fix a failed sync', run: () => go('/overview') },
  { ws: 'ws-northwind', who: 'admin', title: 'Approve an access request', run: () => go('/people?tab=requests') },
  { ws: 'ws-northwind', who: 'admin', title: 'Add people and set their role', run: () => goThen('/people', () => A['member-add']?.()) },
  { ws: 'ws-northwind', who: 'admin', title: 'Turn on Spaces for Northwind', run: () => go('/settings?tab=setup') },
  { ws: 'ws-finx', who: 'engineer', title: 'Start from Home: ask, find or pick up', run: () => go('/home') },
  { ws: 'ws-finx', who: 'engineer', title: 'Ask how to get production access, then request it', run: () => go('/chat/fx-c1') },
  { ws: 'ws-finx', who: 'engineer', title: 'Request production access (rules checked first)', run: () => go('/requests/new?type=rt-prod') },
  { ws: 'ws-finx', who: 'engineer', title: 'Read an architecture decision with AI beside it', run: () => go('/doc/fx-eng-adr031') },
  { ws: 'ws-finx', who: 'engineer', title: 'Browse Banking Operations procedures', run: () => go('/knowledge?topic=d-ops') },
  { ws: 'ws-finx', who: 'engineer', title: 'Share a guide for review', run: () => goThen('/home', () => A['contribute']?.()) },
  { ws: 'ws-finx', who: 'engineer', title: 'Fix a contribution the lead sent back', run: () => go('/knowledge/library?tab=contributions&open=fx-sub-10') },
  { ws: 'ws-finx', who: 'engineer', title: 'Draft ADR-042 from earlier decisions', run: () => go('/work/w-draft-adr042') },
  { ws: 'ws-finx', who: 'lead', title: 'Review contributions to Payments Platform', run: () => go('/documents?tab=review') },
  { ws: 'ws-finx', who: 'lead', title: 'Compare event streaming platforms', run: () => go('/work/w-review-stream') },
  { ws: 'ws-finx', who: 'lead', title: 'Curate the payments on-call kit', run: () => go('/knowledge/collections/col-fx-oncall') },
  { ws: 'ws-finx', who: 'analyst', title: 'Find how a metric is defined', run: () => go('/knowledge?topic=t-metrics') },
  { ws: 'ws-finx', who: 'analyst', title: 'Ask about active customers', run: () => go('/chat/fx-c3') },
  { ws: 'ws-finx', who: 'analyst', title: 'Request production access without the training', run: () => go('/requests/new?type=rt-prod') },
  { ws: 'ws-finx', who: 'wsadmin', title: 'Recommend trusted documents on Home', run: () => go('/home') },
  { ws: 'ws-finx', who: 'wsadmin', title: 'Publish an updated procedure as a new version', run: () => go('/documents?tab=review&sel=fx-sub-4') },
  { ws: 'ws-finx', who: 'wsadmin', title: 'Approve a topic the assistant proposed', run: () => go('/documents?tab=topics') },
  { ws: 'ws-finx', who: 'wsadmin', title: 'Fix a document that couldn’t be published', run: () => go('/documents?tab=all&life=attention') },
  { ws: 'ws-finx', who: 'wsadmin', title: 'Keep policies verified and tagged', run: () => go('/documents?tab=quality') },
  { ws: 'ws-finx', who: 'wsadmin', title: 'Work the Risk & Compliance queue', run: () => go('/requests?tab=queue') },
  { ws: 'ws-finx', who: 'wsadmin', title: 'Close a knowledge gap people hit', run: () => go('/overview') },
  { ws: 'ws-finx', who: 'wsadmin', title: 'Configure the workspace', run: () => go('/settings?tab=setup') },
  { ws: 'ws-northwind', who: 'operator', title: 'Create a workspace for a customer', run: () => goThen('/p/workspaces', () => A['pws-create']?.()) },
  { ws: 'ws-northwind', who: 'operator', title: 'Investigate degraded processing', run: () => go('/p/health') },
  { ws: 'ws-northwind', who: 'operator', title: 'Check indexing health without seeing content', run: () => go('/p/indexing') },
];
const personaLabel = k => PERSONAS[k]?.label || k;
function setPersona(p) {
  S.persona = p; S.ui.prefs = null; S.signedIn = true; persist();
  if (S.cur.r.mode === 'platform' && !isOperator()) go(homeRoute()); else refresh();
}
function renderProto() {
  const root = $('#proto-root'); if (!root) return;
  document.body.classList.add('has-proto'); // the bar always owns its band below the product
  if (S.protoMin) { root.innerHTML = `<div class="proto proto--min"><button type="button" class="proto__btn" data-act="proto-max" aria-label="Show prototype controls"><span class="proto__dot"></span>Prototype</button></div>`; return; }
  const stateable = ['workspace', 'platform'].includes(S.cur?.r.mode);
  const pb = (label, act, o = {}) => `<button type="button" class="proto__btn ${o.icon && !label ? 'proto__btn--icon' : ''}" ${act ? `data-act="${act}"` : ''} ${o.menu ? `data-menu="${o.menu}" aria-haspopup="menu" aria-expanded="false"` : ''} ${o.value ? `data-value="${o.value}"` : ''} ${o.pressed != null ? `aria-pressed="${o.pressed}"` : ''} ${o.tip ? `aria-label="${o.tip}" title="${o.tip}"` : ''}>${o.icon ? ic(o.icon, 'i-sm') : ''}${label ? esc(label) : ''}</button>`;
  root.innerHTML = `<div class="proto" role="toolbar" aria-label="Prototype controls">
    <span class="proto__label"><span class="proto__dot" style="display:inline-block;margin-right:6px"></span>Prototype</span>
    ${DEMO_WORKSPACES.map(([id, l]) => pb(l, 'proto-ws', { value: id, pressed: S.ws === id || (id === 'ws-northwind' && S.ws === 'ws-nwfin') })).join('')}
    <span class="proto__sep"></span>
    ${personasForWs(S.ws).map(v => pb(personaLabel(v), 'proto-persona', { value: v, pressed: S.persona === v })).join('')}
    <span class="proto__sep"></span>
    ${pb(stateable ? ({ live: 'Live', loading: 'Loading', empty: 'Empty', error: 'Error' })[S.navLoading ? 'loading' : S.pageState] : 'State', '', { menu: 'proto-state', icon: 'layers' })}
    ${pb('', '', { menu: 'proto-appearance', icon: 'palette', tip: 'Mode and theme' })}
    ${pb(S.lang.toUpperCase(), 'lang-toggle', { icon: 'globe', tip: 'Interface language (English / Tiếng Việt)' })}
    ${pb('', 'proto-device', { value: 'desktop', icon: 'monitor', pressed: S.device === 'desktop', tip: 'Desktop' })}
    ${pb('', 'proto-device', { value: 'tablet', icon: 'tablet', pressed: S.device === 'tablet', tip: 'Tablet (834 px)' })}
    ${pb('', 'proto-device', { value: 'phone', icon: 'smartphone', pressed: S.device === 'phone', tip: 'Phone (390 px)' })}
    <span class="proto__sep"></span>
    ${pb('Journeys', '', { menu: 'journeys', icon: 'route' })}
    ${pb('', 'proto-design', { icon: 'palette', tip: 'Design system' })}
    ${pb('', 'proto-reset', { icon: 'retry', tip: 'Reset demo data' })}
    ${pb('', 'proto-min', { icon: 'chevron-down', tip: 'Hide prototype controls' })}
  </div>`;
}
A['proto-persona'] = el => { setPersona(el.dataset.value); toast(`Viewing as ${personaLabel(S.persona)} · ${me().name}`, { tone: 'accent', duration: 1800 }); };
A['proto-ws'] = el => { if (S.cur.r.mode === 'platform' || S.ws !== el.dataset.value) enterWorkspace(el.dataset.value); };
MENUS['proto-state'] = () => {
  const stateable = ['workspace', 'platform'].includes(S.cur?.r.mode);
  if (!stateable) return [{ section: 'Page state applies to app screens' }];
  return [{ section: 'Force page state' }, ...[['live', 'Live data'], ['loading', 'Loading'], ['empty', 'Empty'], ['error', 'Error']].map(([v, l]) => ({ label: l, checked: S.pageState === v && !S.navLoading, run: () => { S.pageState = v; S.navLoading = false; refresh(); } }))];
};
MENUS['proto-appearance'] = () => [
  ...X.appearance.menuItems(),
  { section: 'Quick themes' },
  ...['bomesh', 'heroui', 'ocean', 'forest', 'midnight', 'lavender', 'sunset', 'graphite'].map(themeById).map(t => ({ html: `<span class="i theme-dot" style="background:${accentColor(t)}" aria-hidden="true"></span><span class="grow">${esc(t.label)}</span>`, checked: S.look.theme === t.id, run: () => A['look-theme']({ dataset: { value: t.id } }) })),
];
A['proto-device'] = el => {
  S.device = el.dataset.value; const f = $('#frame');
  f.classList.toggle('is-device', S.device !== 'desktop'); f.classList.toggle('is-tablet', S.device === 'tablet'); f.classList.toggle('is-phone', S.device === 'phone');
  document.body.classList.toggle('is-device', S.device !== 'desktop');
  S.menu = null; refresh();
};
A['proto-design'] = () => go('/design');
A['proto-min'] = () => { S.protoMin = true; persist(); renderProto(); };
A['proto-max'] = () => { S.protoMin = false; persist(); renderProto(); };
A['proto-reset'] = () => confirmAction({ title: 'Reset demo data?', body: 'Clears chats, documents, people, sources and settings you changed, and restores the original data.', confirm: 'Reset', danger: true, delay: 0, onConfirm: resetPrototype });
MENUS.journeys = () => {
  const out = [];
  DEMO_WORKSPACES.forEach(([ws, wl]) => {
    [...new Set(JOURNEYS.filter(j => j.ws === ws).map(j => j.who))].forEach(who => {
      out.push({ section: `${wl} · ${personaLabel(who)}` });
      JOURNEYS.filter(j => j.ws === ws && j.who === who).forEach(j => out.push({ label: j.title, run: () => {
        S.persona = who; S.ui = {}; S.signedIn = true;
        if (S.ws !== ws && !(ws === 'ws-northwind' && S.ws === 'ws-nwfin')) { S.ws = ws; applyTheme(); }
        persist(); j.run();
      } }));
    });
  });
  return out;
};
