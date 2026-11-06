# Home — the intent-driven entry

Home is where every person lands in every workspace (`/home`, first sidebar item). People don't open a workspace to look at what it contains; they open it to get an answer, find something, carry on, or catch up. Home makes the next of those obvious and leaves the rest to the pages that own it:

| Page | Owns |
| --- | --- |
| **Home** | One box to search documents or ask AI; what's waiting for you and what you were reading; what changed; a few documents; shortcuts into topics |
| **Knowledge** | Browsing, filtering, previewing and reading documents ([KNOWLEDGE_HUB.md](KNOWLEDGE_HUB.md)) |
| **Projects** (sidebar) | AI conversations organised by goal, plus *Recent* for conversations in no project ([PRODUCT_FLOW.md](PRODUCT_FLOW.md#1b-organise-ai-work-in-projects)) |
| **Inbox** (topbar bell, ⌘K) | Notifications, requests and everything that asks for a decision |

```text
Home
├── Good morning, Khoa
├── [ Ask a question or find a document                 ⚲ All of Finx ▾ ]
│     typing → Search documents for “…” · Ask AI “…” (question-like text puts Ask AI first) · matching documents · questions you asked before
│     empty  → your recent questions · questions this workspace suggests
│   Try asking: 3 suggested questions                                    ← first visit only
├── Waiting for you    ≤ 3: changes requested · your review queue · a reply needed or something due soon
├── Continue reading   the documents you opened last → Reader where you left off
├── Worth knowing      ≤ 3 source-backed changes: “Batch cut-off moved from 16:00 to 15:30” — Payment Cut-off Times · Version 5
├── Start here (new) / Recommended for you (returning)   ≤ 3 documents, each with its reason
└── Explore by topic   domain shortcuts → Knowledge filtered to that domain · All knowledge →
```

Every block after the box appears only when it has something real to show. A new person sees the box with three suggested questions, *Worth knowing*, *Start here* and the topics; a returning reader sees what they were reading first.

## What was wrong

| Before | Problem | Now |
| --- | --- | --- |
| "Search or ask across 227 published documents in 7 knowledge bases", Search and Ask buttons, a scope select and four question chips | The first viewport described the system and asked people to choose between two buttons before typing | A short greeting and one box. Typing shows both actions, so nobody has to decide up front, plus the documents and earlier questions that already match |
| Explore knowledge: six large topic cards with descriptions, counts and sub-topic chips, plus Knowledge bases and Collections tabs | The biggest block on Home duplicated Knowledge's taxonomy | One row of topic shortcuts that open Knowledge filtered to the domain. Shared collections live in Browse, your own in My library; a knowledge base is a Browse filter |
| Featured knowledge: eight cards whose previews showed fragments ("Approvals p. 2", "Working hours p. 12") | Fragments without context had to be interpreted | *Worth knowing* states what changed, in the owner's own words, with its source; featured documents feed *Start here* and *Recommended*, shown as title, purpose and reason |
| Recently published and Recommended for you, two columns of rows | Two near-identical lists of documents | One reading row of three documents, each with its reason |
| Pick up where you left off came last: recent documents, conversations, contributions, a review line, Up next | The most useful thing for a returning person was at the bottom, and conversations repeated the sidebar | Continuity comes right after the box as two honestly titled rows: *Waiting for you* first, then *Continue reading*; conversations come back through the box |

## Behaviour

### The box (intent A: an answer; intent B: a document)

- One input with a combobox. Clicking into it, typing or pressing ↓ opens suggestions. It is autofocused only on wide screens with a fine pointer; on touch and phones it waits for a tap, so the keyboard doesn't cover the page.
- **Typing** shows two clearly named actions first: *Search documents for "…"* (opens Knowledge with the query) and *Ask AI "…"* (starts a grounded conversation with sources). *Ask AI* ranks first only when the text reads like a question (`isQuestion`: ends with "?" or starts with how, what, when, why, who, can, do, is, explain…), *Search documents* otherwise. Enter runs the first option, so it is always visible what Enter will do; nothing is sent to the AI silently.
- Below the actions: up to four matching documents (the Knowledge catalog search, same ranking and permissions, query words highlighted; opens the document preview at the match) and up to two earlier questions that match (opens that conversation).
- **Empty box**: your three most recent questions (*Continue a conversation*) and the questions the workspace suggests for your audience (*Ask*).
- ↑/↓ move, Enter picks, Escape closes; options keep focus in the input (ARIA combobox with `aria-activedescendant`).
- **Scope** is a quiet menu inside the box (*All of Finx*, a readable knowledge base, or one of my spaces). It scopes both Ask and Search. On phones it becomes a labelled chip under the box ("In: All of Finx Workspace ▾").
- **Suggested questions** under the box only on a first visit (no reading history, no conversations). Returning people get them in the empty-box suggestions instead.

### Waiting for you · Continue reading (intent C)

Two rows of compact cards, each with its own title. *Waiting for you* (at most three) holds what is waiting on you: one contribution with changes requested, your review queue (*9 documents to review* — the same count as the Manage → Documents badge), and a request that needs your reply or something due soon (Spaces/Requests). *Continue reading* lists the documents you opened last ("Opened 1 h ago") and opens them in the Reader, so you resume where you were rather than in a preview. Conversations aren't repeated: the sidebar's *Recent* and the box already offer them. Each row is absent when it has nothing.

### Worth knowing (intent D)

Source-backed changes, never generated statements:

- a document's new version with its owner's change note ("Standing production access removed; just-in-time access for up to 8 hours" — *Access Control Policy · Version 4*), or
- a recent announcement with its summary.

Only ready, published documents the person can read; changes older than 120 days and announcements older than 60 days drop off; a change disappears once you've opened the document after it. Ranked by your reading and saved topics, your spaces, verification and recency; three at most. The card's headline is the change itself, with the kind and date above and the source document and version below. It opens the document preview. Absent when nothing qualifies.

### Start here · Recommended for you

Three documents, each card showing title, what it's for (summary or opening paragraph) and why it's here; a card opens the document preview. New people get *Start here*: what admins featured (*Recommended by Finx Workspace*), topped up with often-opened verified documents. Returning people get *Recommended for you*: related to what they read (*Because you read ADR-031*), from their spaces, or featured. One per reason first, nothing they have opened, nothing already in *Worth knowing*. Admins edit featured documents in the *Featured documents* drawer (the section's sliders button or ⌘K "Edit featured documents"): rows open the document, × removes with Undo, *Add documents* opens a searchable picker. Documents can also be featured from their ⋯ menu.

### Explore by topic

The workspace's topic domains as small pills with their icon and colour. Each opens Knowledge filtered to that domain (`catalogHref`), where the pill row and sub-topics take over. *All knowledge* opens Knowledge.

## Trust and permissions

Home draws only from the catalog pools: published, readable, shared documents (`catalogPool()` minus My files). Suggestions run the same catalog search as Knowledge. Restricted documents never appear as titles, counts, changes or recommendations. Contributions appear only to their contributor; the review card only to reviewers.

## States and responsiveness

- **Loading**: greeting and box, then skeletons for continue cards and three cards.
- **Empty workspace**: "Your workspace has no published knowledge yet" with *Contribute* and *Browse knowledge*.
- **Error**: retry. Sections without data are left out rather than shown empty.
- **≤ 1023 px**: continue cards two per row, card rows show two. **≤ 679 px**: one column, the greeting aligns left, the scope becomes a labelled chip under the box, suggested questions and topics scroll horizontally, keyboard hints hide. No horizontal overflow at 834 or 390 px.

## Roles and workspaces

Everything is computed from the active workspace and persona: suggested questions follow the person's audience in the published assistant settings (`X.assistantStarters()`: group → role → Everyone), recommendations and *Worth knowing* follow reading history, saved topics and spaces, review cards follow review rights. Northwind (no Spaces) has no space reasons and no due items. The first-run product tour starts here (box, scope, first section, New chat, Search).
