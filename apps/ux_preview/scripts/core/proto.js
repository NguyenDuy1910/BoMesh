'use strict';
/* Prototype controls — outside the product. Demo workspace, persona, forced
   page state, theme, device width, end-to-end journeys, design system and
   data reset. */
const DEMO_WORKSPACES = [['ws-northwind', 'Northwind'], ['ws-ute', 'UTE Campus']];
const JOURNEYS = [
  { ws: 'ws-northwind', who: 'member', title: 'Sign in and ask a question', run: () => { S.signedIn = false; go('/signin'); } },
  { ws: 'ws-northwind', who: 'member', title: 'Verify where an answer came from', run: () => goThen('/chat/c1', () => A['cite-open']?.({ dataset: { msg: 'm2', n: '1' } })) },
  { ws: 'ws-northwind', who: 'member', title: 'Find verified sales material', run: () => go('/knowledge/browse?topic=d-sales&trust=verified') },
  { ws: 'ws-northwind', who: 'member', title: 'Request access to restricted knowledge', run: () => go('/knowledge/bases') },
  { ws: 'ws-northwind', who: 'member', title: 'First-run product tour', run: () => X.startTour?.() },
  { ws: 'ws-northwind', who: 'admin', title: 'Create a knowledge base and add files', run: () => goThen('/knowledge/bases', () => A['kb-create']?.()) },
  { ws: 'ws-northwind', who: 'admin', title: 'Merge a duplicate document', run: () => go('/knowledge-health?tab=duplicates') },
  { ws: 'ws-northwind', who: 'admin', title: 'Connect a source', run: () => goThen('/sources', () => A['src-connect']?.()) },
  { ws: 'ws-northwind', who: 'admin', title: 'Fix a failed sync', run: () => go('/overview') },
  { ws: 'ws-northwind', who: 'admin', title: 'Approve an access request', run: () => go('/people?tab=requests') },
  { ws: 'ws-northwind', who: 'admin', title: 'Add people and set their role', run: () => goThen('/people', () => A['member-add']?.()) },
  { ws: 'ws-northwind', who: 'admin', title: 'Turn on Spaces for Northwind', run: () => go('/settings?tab=setup') },
  { ws: 'ws-ute', who: 'student', title: 'Discover knowledge for my courses', run: () => go('/knowledge') },
  { ws: 'ws-ute', who: 'student', title: 'Find a regulation, read it and ask about it', run: () => go('/knowledge/browse?q=withdraw') },
  { ws: 'ws-ute', who: 'student', title: 'Find theses for my topic and save them', run: () => go('/knowledge/browse?topic=t-ml&kind=thesis') },
  { ws: 'ws-ute', who: 'student', title: 'Revise from a course collection', run: () => go('/knowledge/collections/col-u-mlprep') },
  { ws: 'ws-ute', who: 'student', title: 'See what’s due and take the Week 4 quiz', run: () => go('/home') },
  { ws: 'ws-ute', who: 'student', title: 'Make a study guide from lecture slides', run: () => go('/work/new?workflow=study-guide&space=sp-ml') },
  { ws: 'ws-ute', who: 'student', title: 'Check a rule, then withdraw from a course', run: () => go('/chat/cu1') },
  { ws: 'ws-ute', who: 'student', title: 'Ask the teaching team', run: () => go('/space/sp-ml') },
  { ws: 'ws-ute', who: 'student', title: 'Track my requests', run: () => go('/requests') },
  { ws: 'ws-ute', who: 'lecturer', title: 'Curate the midterm reading list', run: () => go('/knowledge/collections/col-u-mlprep') },
  { ws: 'ws-ute', who: 'lecturer', title: 'Link a resource to another course', run: () => go('/doc/du-ml-lab2') },
  { ws: 'ws-ute', who: 'lecturer', title: 'Build and publish a quiz', run: () => go('/work/new?workflow=quiz&space=sp-ml') },
  { ws: 'ws-ute', who: 'lecturer', title: 'Answer student questions', run: () => go('/requests?tab=queue') },
  { ws: 'ws-ute', who: 'lecturer', title: 'See how the class did on a quiz', run: () => go('/work/w-quiz-w4') },
  { ws: 'ws-ute', who: 'researcher', title: 'Read a paper with AI beside it', run: () => go('/doc/du-ag-p1') },
  { ws: 'ws-ute', who: 'researcher', title: 'Compare papers in a literature review', run: () => go('/work/w-review-agri') },
  { ws: 'ws-ute', who: 'researcher', title: 'Start a review from the lab library', run: () => go('/work/new?workflow=review&space=sp-agri') },
  { ws: 'ws-ute', who: 'researcher', title: 'Draft a grant proposal section', run: () => go('/work/w-draft-naf') },
  { ws: 'ws-ute', who: 'staff', title: 'Work the Academic Affairs queue', run: () => go('/requests?tab=queue') },
  { ws: 'ws-ute', who: 'staff', title: 'Keep regulations verified and tagged', run: () => go('/knowledge-health') },
  { ws: 'ws-ute', who: 'staff', title: 'Close a knowledge gap students hit', run: () => go('/overview') },
  { ws: 'ws-ute', who: 'staff', title: 'Configure the workspace template', run: () => go('/settings?tab=setup') },
  { ws: 'ws-northwind', who: 'operator', title: 'Create a workspace for a customer', run: () => goThen('/p/workspaces', () => A['pws-create']?.()) },
  { ws: 'ws-northwind', who: 'operator', title: 'Investigate degraded processing', run: () => go('/p/health') },
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
    ${pb('', '', { menu: 'proto-appearance', icon: resolvedTheme() === 'dark' ? 'moon' : 'sun', tip: 'Theme and background' })}
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
  { section: 'Mode' },
  ...[['light', 'Light', 'sun'], ['dark', 'Dark', 'moon'], ['system', 'Match system', 'monitor']].map(([v, l, i]) => ({ label: l, icon: i, checked: S.theme === v, run: () => setTheme(v) })),
  { sep: true },
  ...MENUS.bg(),
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
