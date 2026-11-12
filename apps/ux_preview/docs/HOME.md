# Home — Discover & Start

Home is where every person lands in every workspace (`/home`, first sidebar item). It is the workspace's front page, not a second chat composer. In a few seconds it answers three questions:

1. **What can I do here?** Find a document, ask a question answered from the organization's documents, contribute knowledge.
2. **Where should I start?** What needs you, what you were reading, or (first visit) a few documents picked to start with.
3. **What is relevant to me right now?** What changed at the source in documents you can read, and a map of the knowledge by topic.

| Page | Owns | Identity |
| --- | --- | --- |
| **Home** | Orientation, continuity, what changed, discovery shortcuts | Discover & start |
| **Knowledge** | Searching, filtering, previewing and reading documents ([KNOWLEDGE_HUB.md](KNOWLEDGE_HUB.md)) | Find & explore |
| **AI Chat** | Asking — the composer and every earlier conversation; grounded answers with citations ([PRODUCT_FLOW.md](PRODUCT_FLOW.md#1-sign-in-and-ask)) | Ask & understand |
| **Your work** (Recent · Projects · My contributions) | Everything you touched, organised and submitted, in full ([PRODUCT_FLOW.md](PRODUCT_FLOW.md#information-architecture)) | Pick up & track |
| **Inbox** (top-row bell) · **Search** (sidebar search row, ⌘K) | Notifications and decisions · jump to anything | — |

Nothing is typed on Home. Searching belongs to Knowledge (and ⌘K), asking belongs to AI Chat; Home sends people to them in one click. Home shows only the few items that matter now and links to the page that holds the rest: *View all* → Recent, a contribution → My contributions, *Ask a question* → AI Chat (the single entry; Home has no composer).

```text
Home
├── Good morning, Khoa
│   227 documents you can read, across 6 topics · 41 updated in the last 30 days
├── [⌕ Find a document]  [✦ Ask a question]  [⇪ Contribute knowledge | ⌑ Your library]
├── Main                                      Aside ("For you now")
│   ├── Continue reading (≤ 4, Ask ✦)          ├── Needs your attention (≤ 3)
│   ├── Start here (first visit, ≤ 3)          └── What's new (≤ 4 source-backed changes)
│   ├── Explore knowledge (domain cards)
│   └── Recommended for you (returning, ≤ 3)
```

Every section after the intent cards appears only when it has something real to show. Without an aside the main column spans the page (topic cards three across).

## What was wrong with the previous Home

| Before | Problem | Now |
| --- | --- | --- |
| Centered greeting and one large "Ask a question or find a document" box with a scope menu and suggested questions | Looked and behaved like the chat page ("What can I help you find?" + composer) and duplicated ⌘K. Home had no identity of its own; the first viewport was an empty input | Left-aligned greeting with one line of scale, then three intent cards that open the page owning the task (Knowledge, AI Chat, Contribute) |
| Nothing said what the workspace holds | People had to guess what they could ask or find | The lede counts readable documents, topics and recent updates; Explore knowledge shows each domain with what it covers |
| Four or five stacked rows of same-weight cards (Waiting, Continue, Worth knowing, Recommended) | Flat hierarchy; timely items competed with discovery | Two columns: carry on and discover on the left, what is timely on the right |
| Explore by topic: small pills at the bottom | Discovery was the least visible element and showed no scope | Domain cards: name, document count, description and the largest topics, each a filtered Knowledge link |
| Continue reading only opened the Reader | No bridge from a document back into AI | Each row has *Ask about this document* (Reader with Ask open; *Continue in chat* from there) |

## Behaviour

### Header
- *Good morning / afternoon / evening, {name}*.
- Lede computed from what the caller can read: `{n} documents you can read, across {k} topics · {m} updated in the last 30 days`. When nothing is readable (or while loading) it reads *Find documents, ask questions answered from them and share what you know.*

### Intent cards (what can I do here?)
Three equal cards, each one target with a title and a one-line hint from real data. They are entry points, not a composer.

| Card | Hint | Opens |
| --- | --- | --- |
| Find a document | *Search {n} documents by title, topic or content* | Knowledge → Browse with its search field focused (`home-find`) |
| Ask a question | *Answers from {workspace} documents, with citations* | AI Chat (`/chat`), its scope and starters as they are |
| Contribute knowledge (`knowledge.contribute`) | *Share a document; a reviewer publishes it* | The Contribute dialog |
| Your library (everyone else) | *Saved documents, your files and reading lists* | Knowledge → Saved |

Hidden in the Empty state (the empty state carries Contribute and Browse knowledge instead).

### Needs your attention (aside)
At most three: one contribution with changes requested (opens it in My contributions, `/contributions?open=id`), the review queue for reviewers (*9 documents to review*, the same count as the Manage › Knowledge Studio badge → Review), and a request that needs your reply or something due within two days (Spaces/Requests modules). Absent when nothing waits.

### Continue reading (main)
The last four documents you opened (*Opened 1 h ago · Policy*), opening the Reader where you left off. A revealed-on-hover (always visible on touch) *Ask about this document* opens the Reader with its Ask panel (`/doc/{id}?ask=1`); from there *Continue in chat* moves the thread to a conversation. *View all* → Your work → Recent (`/recent`) when there are more. Conversations are not repeated: AI Chat and Recent have them.

### What's new (aside)
Source-backed changes, never generated statements: a document's new version with its owner's change note (*Standing production access removed; just-in-time access for up to 8 hours* — Access Control Policy · Version 4), or a recent announcement with its summary. Ready, published documents the person can read; changes older than 120 days and announcements older than 60 days drop off; a change disappears once you've opened the document after it. Ranked by your reading and saved topics, your spaces, verification and recency; four at most. The change is the headline, kind and date above, source document and version below. Opens the document preview.

### Explore knowledge (main)
One card per topic domain that holds readable documents: tinted icon, name, *{n} documents*, the domain's description and up to three of its largest topics. The card (its name is the stretched link) opens Knowledge filtered to the domain; a topic opens it filtered to that topic (`catalogHref`). Counts come from the same topic facet Knowledge uses, over the readable pool. *All knowledge* → Knowledge. Hierarchy, filters and reading lists stay in Knowledge.

### Start here · Recommended for you (main)
Three documents, each with title, what it's for (summary or opening paragraph) and why it's here; a row opens the document preview. First visit (no reading history and no conversations): *Start here*, placed above Explore — what admins featured (*Recommended by {workspace}*), topped up with often-opened verified documents. Returning people: *Recommended for you*, below Explore — related to what they read (*Because you read ADR-031*), from their spaces, or featured; one per reason first, nothing they have opened, nothing already in What's new. Admins edit featured documents from the section's sliders button (shown when the section holds featured documents) or ⌘K *Edit featured documents*: rows open the document, × removes with Undo, *Add documents* opens a searchable picker.

## Journeys

| Person wants to… | Path from Home |
| --- | --- |
| Get oriented (first visit) | Product tour (intent cards → Needs your attention / Continue → Explore → AI Chat → Search) · *Start here* · topic cards |
| Continue a task | Needs your attention, or Continue reading → Reader |
| Find a specific document | *Find a document* → Knowledge search focused (or ⌘K from anywhere) |
| Explore an unfamiliar topic | Explore knowledge → domain or topic → Browse filtered → preview |
| Ask AI | *Ask a question* → AI Chat; or sidebar AI Chat |
| Move from a document to AI | Continue reading ✦ → Reader Ask → *Continue in chat*; or any preview → *Ask about this document* |

## Trust and permissions

Home draws only from the published, readable, shared pool (`sharedPool()`). Lede counts, topic counts, What's new and recommendations never reveal restricted documents. Contributions appear only to their contributor; the review card only to reviewers; requests and due items follow space roles. The Contribute card requires `knowledge.contribute`.

## States and responsiveness

- **Loading**: greeting, generic lede and intent cards, then skeleton rows (Continue, What's new) and topic cards.
- **Empty workspace** (no readable published documents, or forced Empty): greeting, generic lede, and *Your workspace has no published knowledge yet* with Contribute and Browse knowledge; no intent cards.
- **Error**: intent cards stay (they don't depend on data); the body shows Try again.
- **≤ 1023 px**: one column; main and aside interleave in this order: Needs your attention, Continue reading, Start here, What's new, Explore knowledge, Recommended. Intent cards stack their icon above the text; topic cards two across.
- **≤ 679 px**: intent cards become one compact list (icon, title, one-line hint, arrow); topic cards one column without the description; the lede's update count drops to its own line. No horizontal overflow at 834 or 390 px.

## Roles and workspaces

Everything is computed from the active workspace and persona: the lede and topic cards from the workspace taxonomy and the caller's readable pool, recommendations and What's new from reading history, saved topics and spaces, attention items from contributions, review rights and (Finx) Spaces/Requests. No workspace names or demo records are special-cased; a university, an enterprise or any other tenant gets the same Home from its own taxonomy and documents.
