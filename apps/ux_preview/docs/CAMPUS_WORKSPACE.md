# UTE Campus Workspace

How one BoMesh platform becomes a university workspace without becoming a different product.

## Why

Students, lecturers, researchers and office staff at UTE lose hours to the same problems:

| Who | Today | What BoMesh changes |
| --- | --- | --- |
| Student | Rules live in long PDFs; deadlines are scattered across courses; paperwork means queuing at an office; study material is hard to revise from | One ask box that answers from regulations and course materials with sources; one "Up next" list; requests checked against the rules before they're sent; study guides and practice quizzes from the actual slides |
| Lecturer | Writes assessments by hand; answers the same student question many times; can't see what the class doesn't understand | Quizzes generated from own materials with answer key and sources, published to the course; question queue whose answers become course FAQ knowledge; per-question results |
| Researcher | Reads and compares papers manually; drafts proposals from scratch | Evidence matrix across the lab library (every cell cited); drafts grounded in papers and the funding call |
| Office staff / admin | Repetitive questions; requests by paper or email with missing information; regulations go stale | Students self-serve answers; requests arrive pre-checked with the regulation cited; a queue with SLA; knowledge gaps show what to document next; workspace configured, not customised |

Value proposition: **everyone at UTE gets answers they can trust and gets academic work done — grounded in the university's own regulations, course materials and research library.**

## Platform concepts (generic)

| Concept | What it is | Campus | Enterprise |
| --- | --- | --- | --- |
| Workspace template | Picks modules, space types and AI workflows | Campus | Enterprise |
| Module | A capability that can be switched on per workspace (Settings → Workspace setup) | Home, Spaces, Work, Requests on | Off by default; can be turned on |
| Space | The context people work in: members with roles, linked knowledge, announcements, events, work and a request queue | Course, Research group, Office | Team, Project |
| Workflow → Work | An AI task that produces a saved, cited artifact | Study guide, Practice quiz, Quiz for students, Literature review, Draft | Literature review, Draft |
| Request | Something a person asks a space's staff to do, checked against the rules first | Withdrawal, re-grading, transcript, leave of absence, status letter, scholarship; course questions | Any service catalog (IT, HR) |
| Knowledge | The Knowledge Hub: one permission-filtered catalog across sources, browsed by topic, space, type, owner, source and trust; Reader with in-place Ask; library and collections ([KNOWLEDGE_HUB.md](KNOWLEDGE_HUB.md)) | Regulations, syllabi (LMS), theses (DSpace), open courseware (SharePoint), notices (website), lab papers | Policies, playbooks, docs |

Code asks `hasModule()`, `spaceType()`, `workflowsFor()` — never "is this UTE?" (`scripts/core/workspace.js`).

## Information architecture (Campus)

```text
Home ─ ask box · quick starts · Up next · Continue · Needs you (staff)
Inbox
Work ─ list · New (workflow → materials → options → generate) · item (quiz · guide · review · draft)
Requests ─ My requests · Queue (staff) · New (catalog → rule check → form) · item (thread)
Knowledge ─ Discover · Browse · My library · Knowledge bases · Reader   ·   Conversations · Search (⌘K)
Spaces ─ Machine Learning · Database Systems · Smart Agriculture Lab · (offices are open to all)
   └ space: Overview · Materials · Work · Questions/Requests (staff) · People · Settings
Manage (admin) ─ Overview · Sources · Connections · Knowledge health · People · Assistant · Activity · Settings (General · Workspace setup · Danger zone)
```

## Key journeys

1. **Student — rule to request.** Ask "When is the withdrawal deadline?" → cited answer (deadline, W grade, no refund, 14-credit minimum) → *Start a withdrawal request* → the assistant re-checks the rules against the student's profile → send → Academic Affairs approves → Inbox.
2. **Student — study loop.** Home shows the Week 4 quiz → take it → score with cited explanations → *Make a study guide on what I missed* → guide from the exact slides → *Practice quiz*.
3. **Student — when materials don't answer.** "Can we use scikit-learn in Assignment 1?" → the assistant says what the brief does and doesn't say → *Ask the teaching team* → lecturer answers and adds it to the course FAQ → the next student gets a cited answer.
4. **Lecturer — assessment.** New quiz from W04 + W05 → edit questions (each with answer key and source) → publish with a due date → students see it in Up next → Results shows the hardest questions → *Explain in class*.
5. **Researcher — evidence to draft.** Ask across the lab library → *Compare in a literature review* → matrix with cited cells, add a criterion, synthesize → *Draft related work* → edit, ask for changes, version history → ready for review by the PI.
6. **Admin — run the office and the workspace.** Request queue with SLA, assign, ask for information, approve; Overview attention and knowledge gaps → answer a gap into an FAQ document; Workspace setup toggles modules, space types and workflows.
7. **Everyone — knowledge.** Student: Discover → Browse "withdraw" → read the regulation with *Ask* beside it → save; theses by topic → *Thesis ideas* collection. Lecturer: curate *IT4071 midterm prep*, link *Lab 2* to IT3090. Admin: Knowledge health review, tagging and duplicate merge. Details in [KNOWLEDGE_HUB.md](KNOWLEDGE_HUB.md).

## Personas in the prototype

Switch with the prototype bar (UTE Campus → Student, Lecturer, Researcher, Admin). Sign in with `22110101@student.ute.edu.vn`, `hunglv@ute.edu.vn`, `hapt@ute.edu.vn` or `lanvt@ute.edu.vn`, password `demo`. Data: `scripts/data/ute.js` and `scripts/data/knowledge.js` (week 9 of Semester 1, 2026–2027). All UTE records are fictional demo data and are labelled *Demo data* in the product.
