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
  'review': { label: 'Evidence review', desc: 'Compare papers, vendors or options side by side; every cell cites its evidence.', icon: 'table', kind: 'review', spaceTypes: ['research', 'project', 'team'], audience: 'any' },
  'draft': { label: 'Draft a document', desc: 'A first draft grounded in your sources — proposals, decision records, announcements.', icon: 'pencil', kind: 'draft', spaceTypes: null, audience: 'any' },
};

/** levels: the knowledge map's level vocabulary (Home). The first four name depths 1–4 (root collection = 1);
    any entry can be picked by a collection or folder through its `level`. */
const TEMPLATES = {
  enterprise: {
    label: 'Enterprise', desc: 'Company knowledge with governed sources and access.',
    modules: { spaces: false, work: false, requests: false },
    spaceTypes: ['team', 'project'], workflows: ['review', 'draft'],
    levels: ['Area', 'Section', 'Subsection', 'Folder'],
  },
  campus: {
    label: 'Campus', desc: 'Courses, research groups and offices: learning, research and student services in one workspace.',
    modules: { spaces: true, work: true, requests: true },
    spaceTypes: ['course', 'research', 'office'], workflows: ['study-guide', 'practice-quiz', 'quiz', 'review', 'draft'],
    levels: ['Faculty', 'Academic department', 'Program group', 'Major', 'Administrative office', 'Forms'],
  },
};
/** Optional modules. Home, Knowledge, Inbox and Conversations are core: every workspace has them. */
const MODULES = {
  spaces: { label: 'Spaces', desc: 'Organise people, materials and work by team, project, office or course.' },
  work: { label: 'Work', desc: 'AI workflows that produce reviews, drafts, study guides and quizzes.' },
  requests: { label: 'Requests', desc: 'People send requests to service teams and offices; staff work a queue.' },
};

const wsTemplateId = (ws = curWs()) => (TEMPLATES[ws?.template] ? ws.template : 'enterprise');
const wsTemplate = (ws = curWs()) => TEMPLATES[wsTemplateId(ws)];
/** The knowledge map's level labels: the workspace's own (Settings → Workspace setup) or its template's. A copy. */
const mapLevels = (ws = curWs()) => [...(ws?.mapLevels || wsTemplate(ws).levels)];
/** Work kinds (artifact types) register their behaviour here — see features/work*.js:
    WORK_KINDS[kind] = { label, icon, noun,
      options(f, ctx) → HTML of kind-specific options in the "new work" flow (f = ui('workNew')),
      title(ctx) → default title, generate(ctx) → data (ctx = { workflow, space, sources, options }),
      render(work, ctx) → HTML of the work page body (ctx = { query, canEdit, isOwner }),
      summary(work) → one line for lists }. */
const WORK_KINDS = {};
/** Modules held back for a later phase: hidden everywhere as if the workspace had them off (nav, routes, entry points,
    Settings). Their code and data stay; drop the id here to bring the module back. */
const LATER_PHASE_MODULES = new Set(['work']);
/** Is a module on in the active workspace? Workspace overrides win over template defaults. */
function hasModule(m, ws = curWs()) { return !LATER_PHASE_MODULES.has(m) && (ws?.modules?.[m] ?? wsTemplate(ws).modules[m] ?? false); }
const spaceTypeIds = (ws = curWs()) => ws?.spaceTypes || wsTemplate(ws).spaceTypes;
const spaceType = id => SPACE_TYPES[id] || SPACE_TYPES.team;
/** Where a signed-in person lands: the knowledge-first Home, in every workspace. */
const homeRoute = () => '/home';

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
const personasForWs = (wsId = S.ws) => Object.keys(PERSONAS).filter(k => PERSONAS[k].workspaces?.includes(wsId) || PERSONAS[k].joins?.includes(wsId)).sort((a, b) => (a === 'operator') - (b === 'operator'));
/** Equivalent demo persona when the prototype jumps between workspaces. */
const PERSONA_MAP = {
  'ws-finx': { member: 'engineer', admin: 'wsadmin', student: 'engineer', newstudent: 'engineer', lecturer: 'lead', campusadmin: 'wsadmin' },
  'ws-northwind': { engineer: 'member', lead: 'member', analyst: 'member', wsadmin: 'admin', student: 'member', newstudent: 'member', lecturer: 'member', campusadmin: 'admin' },
  'ws-campus': { member: 'student', admin: 'campusadmin', engineer: 'student', lead: 'lecturer', analyst: 'lecturer', wsadmin: 'campusadmin' },
};
/** Open a workspace. In the prototype, switching to a workspace the persona isn't in swaps to the matching persona there. */
function enterWorkspace(id, { quiet } = {}) {
  const w = D.workspaces.find(x => x.id === id); if (!w) return;
  if (!PERSONAS[S.persona].workspaces?.includes(id)) S.persona = (PERSONA_MAP[id] || PERSONA_MAP['ws-northwind'])[S.persona] || personasForWs(id)[0];
  const changed = S.ws !== id; S.ws = id; S.ui = {}; S.signedIn = true; S.modal = null; S.drawer = null; S.menu = null;
  (D.wsOpened ??= {})[id] = Date.now();
  persist(); applyTheme();
  if (changed && !quiet) toast(`Switched to ${w.name}`, { tone: 'accent' });
  go(homeRoute());
}

/* ── Public workspaces ──
   A public workspace (visibility 'public') lets anyone signed in join by themselves (POST workspaces/{w}:join) and become a
   member with the predefined Member role: they read every collection open to all members, contribute for review and use the
   assistant, like any member. Any member leaves by themselves, except the last workspace admin. */
const isPublicWs = (ws = curWs()) => ws?.visibility === 'public';
/** ListWorkspaces filter visibility = PUBLIC: public workspaces an account isn't in (all of them for an account with no persona
    yet). Only name, description and code are shown. */
const publicWorkspacesToJoin = (p = me()) => D.workspaces.filter(w => isPublicWs(w) && w.status !== 'archived' && !p?.workspaces?.includes(w.id));
/** A persona's `workspaces` follows the workspaces' members (joined, left, removed by an admin). Platform operators keep the
    workspaces they open without a membership. */
function syncMemberships() {
  Object.values(PERSONAS).forEach(p => D.workspaces.forEach(w => {
    const m = wsData(w.id)?.members?.some(x => x.id === p.id), has = !!p.workspaces?.includes(w.id);
    if (m && !has) (p.workspaces ||= []).push(w.id);
    else if (!m && has && !p.perms.some(x => x.startsWith('platform.'))) p.workspaces = p.workspaces.filter(x => x !== w.id);
  }));
}
/** In the prototype a persona's collection roles are stored per workspace: give a new member what members read there. */
function syncNewMember(id, userId) { const prev = S.ws; S.ws = id; try { D.kbs.forEach(k => X.kbSyncPersonas?.(k, [userId])); } finally { S.ws = prev; } }
/** Join a public workspace as a member. False when it isn't public or you're already in. */
function joinWorkspace(id) {
  const w = D.workspaces.find(x => x.id === id), p = me(), store = DB.ws[id];
  if (!isPublicWs(w) || !store || p.workspaces?.includes(id)) return false;
  store.members.push({ id: p.id, name: p.name, email: p.email, roleId: 'r-member', groups: [], status: 'active', joined: Date.now(), lastActive: Date.now() });
  // An account made in the prototype (guest-…) holds its role's permissions, as when it accepts an invite (features/shares.js).
  if (S.persona.startsWith('guest-')) { p.perms = [...(store.roles.find(r => r.id === 'r-member')?.perms || [])]; X.shares?.save?.(); }
  store.audit?.unshift({ id: uid('ev'), at: Date.now(), actor: p.id, action: 'Joined the workspace', type: 'People', target: w.name, outcome: 'success', ip: '10.4.12.30', device: 'Chrome on macOS' });
  w.members = (w.members || 0) + 1;
  syncMemberships(); syncNewMember(id, p.id); persist();
  return true;
}
/** Can the caller leave this workspace? Any member, except the last active workspace admin. */
function canLeave(id = S.ws) {
  const ms = wsData(id)?.members || [], m = ms.find(x => x.id === me().id);
  return !!m && !(m.roleId === 'r-admin' && ms.filter(x => x.roleId === 'r-admin' && x.status === 'active').length <= 1);
}
function leaveWorkspace(id = S.ws) {
  const ms = wsData(id)?.members, i = ms?.findIndex(m => m.id === me().id) ?? -1, w = D.workspaces.find(x => x.id === id);
  if (i < 0 || !canLeave(id)) return false;
  ms.splice(i, 1); if (w) w.members = Math.max(0, (w.members || 1) - 1);
  syncMemberships(); persist();
  return true;
}
