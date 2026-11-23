# Home — where everyone starts

Home is where every person lands in every workspace (`/home`, first sidebar item, the post-sign-in route). Its one job: within a few seconds, a person — above all a new one — understands **what this workspace can do for them and what to do first**. It answers:

1. **What is this place, and what does it know?** The greeting, and the composer saying how many documents answers come from.
2. **What can I do here?** Ask anything, with answers grounded in documents they can read — the page's one primary action.
3. **What should I read?** Four documents picked for them, each saying why.
4. **Where is everything else?** The domains of the workspace's taxonomy, each opening Knowledge filtered.

| Page | Owns | Identity |
| --- | --- | --- |
| **Home** | Where everyone starts: ask, what's picked for you, the domains | Start & orient |
| **Knowledge** (Browse) | Searching inside documents, filtering, previewing and reading ([KNOWLEDGE_HUB.md](KNOWLEDGE_HUB.md)) | Find & explore |
| **Knowledge map** | The full tree of collections, folders and documents ([KNOWLEDGE_MAP.md](KNOWLEDGE_MAP.md)) | Map & navigate |
| **New chat** · conversations | Asking, with grounded answers and citations; your conversations are the sidebar's Recent list | Ask & understand |
| **Your work** (Projects · My contributions) | What you organised and submitted | Organise & track |
| **Inbox** (top-row bell) · **Search** (sidebar search row, ⌘K) | What needs you · jump to anything | — |

Home has no feeds, KPIs or admin tasks: what needs you is in the Inbox, governance is in Overview and Knowledge Studio.

```text
Home (plain page, one centred column, max 1,040 px; no hero box, no texture)
│                     Welcome, Trương Gia Bảo  |  Good morning, Nguyễn Minh Anh
│     This is where Trường Đại học UTE keeps its knowledge. Ask anything, or start with what's picked for you below.  (new members)
│        ╭──────────────────────────────────────────────────────────────────╮
│        │ Hôm nay bạn cần tìm gì cho việc học, giảng dạy hay thủ tục?      │   ← primary action (the one composer)
│        │ 📎  ◫ All of Trường Đại học UTE ▾                           (↑) │
│        ╰──────────────────────────────────────────────────────────────────╯
│                    [✦ Năm học mới] [✦ Học phí] [✦ Ký túc xá]   (short labels; or a chosen space's workflows)
├── Getting started (new members) ─ 0 of 3 done ▓░░  ×   |   Jump back in  [▭ chat] [▤ cover · title · 1 h ago] ×4
│     ① Ask your first question [Ask] │ ② Open a document picked for you [Open] │ ③ Save one you'll need again
├── Picked for you — From your role's questions, your spaces and what you read.
│     ┌ cover ─────────┐ ┌ cover ─────────┐ ┌ cover ─────────┐ ┌ cover ─────────┐   Browse's doc-card
│     │[💬 Học phí]     │ │[◫ In CSDL]      │ │[# More on …]    │ │[◉ Most read]    │   reason over the cover
│     PDF title, 2-line summary, collection · age · ✓
└── Explore by domain                                                    All 26 domains → | Browse knowledge →
      [icon] Học vụ & Quy chế · 26 documents · 3 new   (description, three topic chips)   ×6
```

## Design references

Researched before the second pass (the first, a boxed hero tinted with the workspace colour over a dot grid, read as a template and pulled the eye away from the composer):

| Reference | What Home takes from it |
| --- | --- |
| Glean's new home ([docs](https://docs.glean.com/administration/management/appearance/home-page)) | Greeting and one large rounded composer on a plain page; activity cards below. Its older user-chosen wallpapers were dropped in the new home. Its New-hire collection is visible only under 90 days' tenure — Getting started follows the same idea. |
| ChatGPT, Claude, Gemini (prompt-starter pattern, [AI UX Playground](https://aiuxplayground.com/pattern/prompt-starters)) | 3–4 short starter labels, not prefilled sentences; a tap fills the composer and nothing is sent by itself; starters follow the person's role. |
| Notion Home | Recently visited as small visual cards; quiet section titles on a plain page. |

So: no hero box, background image or texture; the composer is the focal point; documents are shown by their covers (the same `DocumentFacet.cover` as Browse).

## UX review (PRODUCT_DESIGN_RULES.md)

- **Primary intent:** a member opening the workspace wants an answer or the right document. A new member first needs to know what the place is for.
- **Shortest journey:** type a question on Home → the answer, with sources, in the conversation. Or select a pick → preview → Reader. Both take one step.
- **One primary action:** the Ask box (primary send button). Starters only fill the box; every other action is a card or a quiet link.
- **What was removed:** the Knowledge Atlas moved to Knowledge › Map. It is a navigation tool for people who already know the structure, and as a landing page it answered "how is it organised" before "what can I do". Nothing was deleted: the map, its background and its Settings stay as they were, one click from Browse.
- **No duplication:** Home doesn't list or filter documents (Browse does), shows no inbox items (the bell does) and no admin metrics (Overview does). Each section links into the page that owns its subject.
- **One composer, two doors:** Home's composer and New chat's are the same component and the same draft (`composer('home')`): a question asked on Home opens its conversation, listed first in the sidebar's Recent. Home orients (picks, domains); New chat is for asking and shows which answers need updating ([PRODUCT_FLOW.md](PRODUCT_FLOW.md) › Keep answers current).

## Sections

### Greeting and composer
- No box: the greeting sits on the page, generous space above it. The greeting uses the person's display name (*Good morning / afternoon / evening, {name}*). For a new member it reads *Welcome, {name}*, with a sentence on what the workspace is for. People have no separate given name, and which word of a name is the given one depends on its order, so Home never shortens names.
- **Composer**: the product's one composer component (chat.js `composerHtml`, large) and the draft every new conversation starts from (`composer('home')`): attach, *Search in* (all, a space, or specific collections; the placeholder follows it), Enter or ↑ starts the conversation and opens it (`/chat/:id`). With no scope chosen the placeholder is the assistant's welcome line (Assistant settings). Files dropped anywhere on the greeting and composer attach to the question.
- **Suggestions** (chat.js `suggestions`): up to four, the assistant's starters for the caller's group, else their role, else the workspace's (`X.assistantStarters`, Assistant settings), shown by their short title; the question shows on hover. A starter fills the box and focuses it; it never sends by itself. With a space chosen in *Search in* that has AI workflows, its workflows take their place.

### Getting started or Jump back in (one slot)
- **Getting started** is shown to members in their first 30 days (`member.joined`) until they hide it. Its three steps are completed by doing them for real:
  1. *Ask your first question*: done once they own a conversation with a message (*Ask* focuses the box).
  2. *Open a document picked for you*: done once they open any document in the Reader (*Open* opens the first pick).
  3. *Save one you'll need again*: done once they have a saved item (the bookmark on any card).
- Progress shows as "1 of 3 done" with a bar; the steps sit in one quiet card, side by side with dividers. When all three are done the card says *You're all set* with a *Hide* button; × hides it at any time. Hiding is kept per member and workspace, with Undo.
- **Jump back in** (everyone else, and new members once Getting started is hidden): their latest conversation and the last documents they opened — four small tiles with the document's cover, title and when, newest first. With no history it is not shown.

### Picked for you
Four documents the caller can read and hasn't saved or opened yet. Each card shows the reason it was picked, so the pick can be trusted:

| Reason (chip) | Rule |
| --- | --- |
| *starter title* (💬, e.g. "Học phí") | The document that best answers one of the caller's starter questions. The question's words are weighted by rarity across the readable pool, and title hits count double, so "học phí" outweighs "học". It counts only if it covers at least 20 % of the question, so task-like starters ("what did students ask this week?") get no document. |
| *In {space}* | Linked to one of the caller's spaces (`contexts`), newest first |
| *More on {topic}* | Shares a topic with what the caller recently read |
| *Most read* | Most opened, limited to the domains of the starter answers and of what they read, so a newcomer never gets another faculty's exam |

Order: space, starter, related, starter, starter, space, related, then most read; the first four distinct documents are shown. A newcomer with no history gets starter answers plus the most read in those domains. A card is Browse's document card (`X.res.thumb` cover, type icon, title, 2-line AI summary, collection, age, verified) with the reason chip over the cover. Selecting it opens the document preview; the bookmark appears on hover (always on touch).

### Explore by domain
- The taxonomy's domains (`topicTree`) that hold readable documents, largest first, six at most.
- Each card shows the domain icon in its colour, name, description (*Shown on Home's domain cards*, edited in Knowledge Studio → Topics), document count, "{n} new" (updated in 30 days) and its three largest topics.
- The card opens Knowledge filtered to the domain; a topic chip opens that topic. *All {n} domains* (or *Browse knowledge*) opens Knowledge.

### Not on Home: what changed lately
A "Recently updated" list was removed: it repeated Browse (sorted by Recently updated) and competed with the picks. What's new shows where it helps a decision — each domain card's "{n} new" — and Knowledge sorts by update.

## Trust and permissions

Every number and card comes from the published, readable, shared pool (`sharedPool()`), the same visibility rule as every other listing (`item_model.md` §6). Two people may see different Homes of the same workspace. Someone who joins a public workspace is an ordinary new member: Getting started, the starters of the Member role. Picks never include personal files. Starters are configured text, and Home never shows an answer it hasn't grounded: asking always goes through AI Chat.

## Product tour

Starts once per person and workspace on first landing (and from Help › Product tour). Its steps:
1. the Ask box;
2. Picked for you;
3. Explore by domain;
4. New chat in the sidebar (and the Recent list);
5. Search.

Steps whose target isn't on screen are skipped.

## States and responsiveness

- **Loading**: the greeting and composer, then skeleton cards. **Empty** (no published knowledge): the composer stays (the assistant can still be asked), then *Your workspace has no published knowledge yet*, with Contribute when allowed. **Error**: Try again.
- Sections rise in once per visit (not on re-renders); none with reduced motion.
- **≤ 1023 px**: picks, Jump back in and domains in two columns; Getting started steps stacked.
- **≤ 679 px**: starters, Jump back in and picks scroll sideways (picks and tiles snap, the next one peeking). Domains are one column.

## Demo data

UTE has a **New student** persona (Trương Gia Bảo, K25 · CNTT, joined two days ago, no history). The `g-ute-k25` group has its own starters (academic year, fees, dormitory), which shows the newcomer experience. Journey: *First week: what to ask, read and save*. Northwind and Finx use their existing personas and starters unchanged.

## API

`GetMemberHome` (`members/{member}/home`, `MemberHome` in `openapi.yaml`) carries the page:
- `starterPrompts[] {title, prompt}` → suggestions (the short title on the pill, the prompt fills the box);
- `recommended[].reason {kind, label}` → picks: `STARTER_PROMPT` (label = the starter's title), `FROM_YOUR_SPACE` ("In {space}"), `BECAUSE_YOU_READ` / `SAVED_TOPIC` ("More on {topic}"), `POPULAR` ("Most read"); the client words the label. Cards read the document through `BatchGetItems`, as Browse does;
- `topicDomains[]` (`description`, `icon`, `color`, `documentCount`, `newDocumentCount` — changed in 30 days, `topTopics`) → domains;
- `joinTime`, `counts.conversationCount`, `continue.recentItems`, `counts.savedItemCount` → Getting started (ask, open, save). Hiding it is a per-browser preference, not stored;
- `continue.recentItems` → Jump back in (covers from `DocumentFacet.cover`).

`recentlyPublished` isn't used by Home.
