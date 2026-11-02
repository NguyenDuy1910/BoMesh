'use strict';
/* Workspace configuration. One BoMesh platform; each workspace picks a
   template (Enterprise, Campus …) that decides which modules are on, the
   space types people organise work in, the AI workflows offered and the
   personas the demo shows. Admins can override modules per workspace
   (Settings → Workspace setup). Feature code asks hasModule(), spaceType(),
   workflowsFor() — never "is this UTE?". */

/** Space types, reusable across templates. roles: [key, label]; staff: roles that run the space (answer questions, publish work, handle requests). */
const SPACE_TYPES = {
  course: { label: 'Course', plural: 'Courses', icon: 'graduation', roles: [['lecturer', 'Lecturer'], ['ta', 'Teaching assistant'], ['student', 'Student']], staff: ['lecturer', 'ta'], join: 'enrolled', desc: 'Materials, assessments and Q&A for one class.' },
  research: { label: 'Research group', plural: 'Research', icon: 'flask', roles: [['pi', 'Principal investigator'], ['researcher', 'Researcher'], ['member', 'Member']], staff: ['pi', 'researcher'], join: 'request', desc: 'A shared paper library, reviews and drafts for a lab or project.' },
  office: { label: 'Office', plural: 'Offices', icon: 'building', roles: [['head', 'Head'], ['staff', 'Staff']], staff: ['head', 'staff'], join: 'open', desc: 'A service team people send requests to.' },
  team: { label: 'Team', plural: 'Teams', icon: 'users', roles: [['lead', 'Lead'], ['member', 'Member']], staff: ['lead'], join: 'request', desc: 'A group that works from shared knowledge.' },
  project: { label: 'Project', plural: 'Projects', icon: 'route', roles: [['owner', 'Owner'], ['member', 'Member']], staff: ['owner'], join: 'request', desc: 'Time-bound work with its own sources and outputs.' },
};

/** AI workflows: outcome-focused tasks that produce a saved piece of Work. Implemented by features/work*.js. */
const WORKFLOWS = {
  'study-guide': { label: 'Study guide', desc: 'A summary, key terms and self-check questions from the materials you pick.', icon: 'book', kind: 'guide', spaceTypes: ['course'], audience: 'member' },
  'practice-quiz': { label: 'Practice quiz', desc: 'Test yourself on chosen materials. Every answer explains itself with a source.', icon: 'check-circle', kind: 'quiz', spaceTypes: ['course'], audience: 'member' },
  'quiz': { label: 'Quiz for students', desc: 'Generate questions with an answer key and sources, edit, then publish to the course.', icon: 'list', kind: 'quiz', spaceTypes: ['course'], audience: 'staff' },
  'review': { label: 'Literature review', desc: 'Compare papers side by side; every cell cites its evidence.', icon: 'table', kind: 'review', spaceTypes: ['research', 'project'], audience: 'any' },
  'draft': { label: 'Draft a document', desc: 'A first draft grounded in your sources — proposals, letters, announcements.', icon: 'pencil', kind: 'draft', spaceTypes: null, audience: 'any' },
};

const TEMPLATES = {
  enterprise: {
    label: 'Enterprise', desc: 'Company knowledge with governed sources and access.',
    modules: { home: false, spaces: false, work: false, requests: false },
    spaceTypes: ['team', 'project'], workflows: ['review', 'draft'],
  },
  campus: {
    label: 'Campus', desc: 'Courses, research groups and offices: learning, research and student services in one workspace.',
    modules: { home: true, spaces: true, work: true, requests: true },
    spaceTypes: ['course', 'research', 'office'], workflows: ['study-guide', 'practice-quiz', 'quiz', 'review', 'draft'],
  },
};
const MODULES = {
  home: { label: 'Home', desc: 'A personal start page: ask, what’s due, and where you left off.' },
  spaces: { label: 'Spaces', desc: 'Organise people, materials and work by course, group, team or project.' },
  work: { label: 'Work', desc: 'AI workflows that produce study guides, quizzes, reviews and drafts.' },
  requests: { label: 'Requests', desc: 'People send requests to offices and teaching teams; staff work a queue.' },
};

const wsTemplateId = (ws = curWs()) => (TEMPLATES[ws?.template] ? ws.template : 'enterprise');
const wsTemplate = (ws = curWs()) => TEMPLATES[wsTemplateId(ws)];
/** Work kinds (artifact types) register their behaviour here — see features/work*.js:
    WORK_KINDS[kind] = { label, icon, noun,
      options(f, ctx) → HTML of kind-specific options in the "new work" flow (f = ui('workNew')),
      title(ctx) → default title, generate(ctx) → data (ctx = { workflow, space, sources, options }),
      render(work, ctx) → HTML of the work page body (ctx = { query, canEdit, isOwner }),
      summary(work) → one line for lists }. */
const WORK_KINDS = {};
/** Is a module on in the active workspace? Workspace overrides win over template defaults. */
function hasModule(m, ws = curWs()) { return ws?.modules?.[m] ?? wsTemplate(ws).modules[m] ?? false; }
const spaceTypeIds = (ws = curWs()) => ws?.spaceTypes || wsTemplate(ws).spaceTypes;
const spaceType = id => SPACE_TYPES[id] || SPACE_TYPES.team;
/** Where a signed-in person lands in the active workspace. */
const homeRoute = () => (hasModule('home') ? '/home' : '/chat');

/* ── Spaces ── */
const spaceById = id => D.spaces?.find(s => s.id === id);
/** The caller's role key in a space, or null. Open spaces (offices) let everyone in as a visitor. */
function spaceRole(sp, userId = me().id) { if (!sp) return null; return sp.members?.find(m => m.user === userId)?.role || null; }
const isSpaceStaff = (sp, userId = me().id) => !!sp && (spaceType(sp.type).staff.includes(spaceRole(sp, userId)) || (isAdmin() && sp.type === 'office' && !!spaceRole(sp, userId)));
const canManageSpace = sp => isAdmin() || isSpaceStaff(sp);
/** Spaces the caller belongs to (not archived), in type order. */
function mySpaces() {
  const order = spaceTypeIds();
  return (D.spaces || []).filter(s => !s.archived && spaceRole(s)).sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type) || a.name.localeCompare(b.name));
}
/** Spaces the caller can see: their own, open ones (offices) and discoverable ones they could request to join. */
const visibleSpaces = () => (D.spaces || []).filter(s => !s.archived && (spaceRole(s) || s.visibility !== 'private' || isAdmin()));

/** Workflows the caller can start, optionally inside a space. */
function workflowsFor(sp) {
  const ids = curWs()?.workflows || wsTemplate().workflows;
  return ids.map(id => ({ id, ...WORKFLOWS[id] })).filter(w => {
    if (sp && w.spaceTypes && !w.spaceTypes.includes(sp.type)) return false;
    if (w.audience === 'staff') return sp ? isSpaceStaff(sp) : mySpaces().some(s => isSpaceStaff(s) && (!w.spaceTypes || w.spaceTypes.includes(s.type)));
    if (w.audience === 'member') return sp ? !isSpaceStaff(sp) : mySpaces().some(s => !isSpaceStaff(s) && (!w.spaceTypes || w.spaceTypes.includes(s.type)));
    return !w.spaceTypes || (sp ? true : mySpaces().some(s => w.spaceTypes.includes(s.type)) || !hasModule('spaces'));
  });
}

/* ── Workspaces & demo personas ── */
const workspacesForMe = () => D.workspaces.filter(w => me().workspaces?.includes(w.id));
const personasForWs = (wsId = S.ws) => Object.keys(PERSONAS).filter(k => PERSONAS[k].workspaces?.includes(wsId)).sort((a, b) => (a === 'operator') - (b === 'operator'));
/** Equivalent demo persona when the prototype jumps between workspaces. */
const PERSONA_MAP = { 'ws-ute': { member: 'student', admin: 'staff' }, 'ws-northwind': { student: 'member', lecturer: 'member', researcher: 'member', staff: 'admin' } };
/** Open a workspace. In the prototype, switching to a workspace the persona isn't in swaps to the matching persona there. */
function enterWorkspace(id, { quiet } = {}) {
  const w = D.workspaces.find(x => x.id === id); if (!w) return;
  if (!PERSONAS[S.persona].workspaces?.includes(id)) S.persona = (PERSONA_MAP[id] || PERSONA_MAP['ws-northwind'])[S.persona] || personasForWs(id)[0];
  const changed = S.ws !== id; S.ws = id; S.ui = {}; S.signedIn = true;
  (D.wsOpened ??= {})[id] = Date.now();
  persist(); applyTheme();
  if (changed && !quiet) toast(`Switched to ${w.name}`, { tone: 'accent' });
  go(homeRoute());
}
