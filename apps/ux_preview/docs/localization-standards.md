# Localization standards

The single source of truth for **how BoMesh is localized**: the i18n architecture, how to write strings, Vietnamese style, locale formatting, fallback and translation quality. Which words to use (the Vietnamese-first terminology) lives in [product-language-guidelines.md](product-language-guidelines.md); this file explains how those words get on screen correctly. Supersedes the "Language" section of DESIGN_SYSTEM.md, which now points here.

> **Current decision (2026-11-25): Vietnamese only.** Reloads showed English, Vietnamese or a mix, because the web
> rendered English and a DOM translator rewrote it after hydration. Until a later phase designs multilingual support,
> the interface has **one language, Vietnamese**, and there is **no language switch** anywhere (Preferences, account
> menu, sign-in pages, command palette, prototype bar). The web writes Vietnamese directly where each string renders
> (components, and the catalog `src/i18n/messages/vi.ts`); the server renders Vietnamese, `<html lang="vi">`, and
> formatters are `vi-VN`. The DOM translator is gone from the web. The one translation left is **text the server sends
> in English** (error messages, field violations): `serverText()` in `apps/web/src/lib/i18n.ts` looks it up in
> `src/i18n/vi.ts`, loaded in the background at startup. Counter nouns for `plural()` live in `src/i18n/nouns.ts`.
> The preview keeps its English-keyed translator (`scripts/core/i18n.js`, pinned to `vi`) as a prototype mechanism.
> Sections 2–3 and 12 below describe the earlier two-language design and apply again when that phase starts.

## 1. Principles

1. **Vietnamese first.** BoMesh is built for Vietnamese organizations. Vietnamese is the **default and primary** interface language: copy is *written* in Vietnamese by people who use the product, not translated from English. English is the second language and follows the Vietnamese meaning. A screen is not done until the Vietnamese reads like it was designed in Vietnamese.
2. **Interface language is a personal preference.** It changes chrome: menus, buttons, labels, messages, tooltips, placeholders, numbers, dates and relative times. New accounts and signed-out pages start in Vietnamese.
3. **Content keeps the language it was written in**: documents, quotes, citations, assistant answers, suggested questions, user input and workspace-authored names (kho tài liệu, concepts and schemes, spaces, document titles, custom roles, people).
4. **No mixed-language sentence.** A sentence is either fully localized or fully content. English fragments inside a Vietnamese sentence are defects (the most common one today is server text inside a localized template, audit `L-04`).
5. **Context over strings.** A message is identified by *what it means where it appears* (a semantic key), so the same English word can have different Vietnamese wordings in different places ("Mở" the verb, "Đang mở" the state).

## 2. How strings are translated today (legacy)

Verified in `apps/web/src/lib/i18n.ts` and `apps/ux_preview/scripts/core/i18n.js`.

| Aspect | Web | Preview |
| --- | --- | --- |
| Approach | **DOM-level, English-keyed translator**: a `MutationObserver` on `<html>` rewrites text nodes and the attributes `placeholder`, `aria-label`, `title`, `data-tip`, `alt` | Same, before paint |
| Dictionary | `apps/web/src/i18n/vi.ts` — `VI: Record<string, string>` (5,917 entries) + `VI_NOUNS` for `plural()`; lazy-loaded chunk only for Vietnamese sessions | `scripts/i18n/vi.js` (global script) |
| Matching | Exact match after whitespace normalization; then `{0}` **patterns** (≥ 3 letters of real words, ≥ 8 when the string starts and ends with a placeholder), longest first; captured values are translated recursively (depth ≤ 2); `" · "`-separated segments translated independently | Same rules |
| Plural suffixes | `need{1}`-style placeholders glued to a word are treated as optional English plural suffixes and dropped | Same |
| Content guard | `translate="no"` subtrees and `SKIP_SEL` (`.chat-answer`, `.chat-bubble`, `.doc-page`, `.pv-quote`, `.chat-cite__quote`, `.chat-starter__prompt`, `code`, `pre`, `textarea`, `[contenteditable]`) are never touched | Same, **plus** a workspace-names guard: a text node equal to a workspace record name is left as written outside chrome |
| Switching | `setLanguage()` → localStorage, `<html lang>`, cross-tab `storage` sync, account preference; `AppShell` remounts main content (`key={language}`); English restores by `revert()` | `setLang()` re-renders |
| Server render | English; Vietnamese applies after hydration (brief English flash). Fixed by the catalog (§3) | — |
| Missing string | Shown in English, silently | Same |
| Formatters | `lib/format.ts`: `fmtNum`, `fmtCompact`, `fmtDate`, `fmtDateTime`, `rel`, `fmtSize`, `plural` — locale from `<html lang>` (`vi-VN` / `en-US`) | `util.js` equivalents |

Mobile: `apps/mobile` does not exist in this repository; it adopts the catalog (§3) when it is created.

Why this produces poor Vietnamese (2026-11-22 review): every Vietnamese string is a translation of an English one, keyed by the English text, so it inherits English sentence shapes (14 "bởi" passives, 119 "của bạn"), one English word gets one Vietnamese word everywhere regardless of context ("People"/"Everyone" → "Mọi người"; "Clear" → "Xóa" beside real deletes), sentences assembled from English fragments force English word order, and names were translated rather than chosen ("bộ sưu tập", "kiểm duyệt", "xuất bản").

## 3. Architecture decision: a Vietnamese-first message catalog

### 3.1 Decision

Web moves from the English-keyed DOM translator to a **typed message catalog written in Vietnamese first**. No new runtime dependency.

| Option | Verdict | Why |
| --- | --- | --- |
| **Typed TypeScript catalog, Vietnamese source** (§3.2) | **Chosen** | Vietnamese written natively with full sentences and its own grammar (values can be functions); semantic keys give context; TypeScript fails the build when English lacks a key or a parameter; server renders the right language; zero dependency |
| Keep the DOM translator (previous decision) | Rejected | Vietnamese stays derived from English; no context; English flash on load |
| `next-intl` 4 (≈ 13 KB gz; ICU; App Router) | **Revisit trigger** | Adds ICU plural/select and extraction; adopt if a third language or heavy pluralization arrives — the catalog's key structure carries over |
| `react-i18next`, `react-intl` | Rejected | Same migration as next-intl with a weaker App Router fit |

### 3.2 Design

```text
apps/web/src/i18n/messages/
  vi.ts      source of truth — `export const vi = { nav: {…}, state: {…}, action: {…}, … }`
  en.ts      `export const en: Messages = {…}` — must have every key and parameter of vi
  index.ts   `type Messages` (vi with literal strings widened), `messagesFor(lang)`
apps/web/src/lib/i18n.ts   language state (default "vi"), cookie `bomesh.lang` + localStorage + account preference
useMessages()              hook returning the active catalog; components read `m.nav.knowledge`, `m.toast.archived({ name })`
```

- **Values** are strings, or functions for anything with parameters or counts: `archived: ({ name }: { name: string }) => \`Đã lưu trữ “${name}”\``. Vietnamese and English write each sentence their own way; no shared English sentence skeleton.
- **Keys** are semantic and grouped by area (`nav`, `state`, `action`, `common`, `knowledge`, `studio`, `assistant`, `work`, `people`, `settings`, `platform`, `auth`, `errors`), lowerCamelCase in English identifiers (code stays English; copy is Vietnamese).
- **Data modules** (navigation tables, lifecycle/status tables) store message *keys* or accessors, never display strings; components resolve them with `useMessages()`.
- **Server rendering**: the root layout reads the `bomesh.lang` cookie and renders `<html lang>` and the provider with that language; switching writes the cookie, localStorage and the account preference.
- **Formatters** (`lib/format.ts`) take the language from the same state; nouns for counts live in the catalog (`count.documents(n)`), replacing `plural()` + `VI_NOUNS`.
- **HeroUI/React Aria built-in strings** (date pickers, "Close" labels) come from their own locale (`vi-VN` via the I18nProvider), not from the catalog.

### 3.3 Transition

- The legacy DOM translator and `i18n/vi.ts` keep running **only** for strings not yet migrated; a migrated area deletes its legacy entries.
- Order: navigation and shell → shared states and actions → toasts, errors and empty states → screens by area (Quản trị tài liệu, Tri thức, Trò chuyện, Người dùng & phân quyền, Cài đặt, Công việc/Yêu cầu, Bảng điều khiển nền tảng, Đăng nhập).
- **Before release**, regardless of migration progress, every Vietnamese string — catalog and legacy dictionary — uses the standard terminology ([language §2](product-language-guidelines.md#2-canonical-vocabulary-vietnamese-first)); the retired-term check (§9.6) passes.
- The translator is removed when the missing-string reporter shows no legacy strings on any route.
- The UX preview (`apps/ux_preview`) keeps its DOM translator (a prototype), defaults to Vietnamese, and its `vi.js` uses the same terminology; preview copy changes still land first (AGENTS.md).

### 3.4 Tooling (see [implementation-plan.md](implementation-plan.md))

1. **Type check**: `en.ts` is typed `Messages`, so a missing key or parameter fails `tsc`.
2. **Retired-term check (test)**: no retired Vietnamese term ([language §2.7](product-language-guidelines.md#27-retired-terms-must-not-appear-at-release)) in `messages/vi.ts`, `i18n/vi.ts` or the preview `vi.js`.
3. **Missing-string reporter (dev)**: logs English text that reaches the legacy translator unmatched in a Vietnamese session.
4. **Legacy dictionary checks**: curly quotes, placeholder parity, stale keys (report).
5. **Error/notification catalog** for server-originated text (§7) lives in the catalog's `errors` area.
6. **Workspace-name guard** in the legacy translator until it is removed (§10).

## 4. Writing strings

Code-review rules for every new or changed string. Rules 1–8 apply to catalog entries and legacy strings alike; with the catalog, write the Vietnamese entry first.

| # | Rule | Don't | Do |
| --- | --- | --- | --- |
| 1 | **Whole messages.** A sentence is one string with placeholders | `` `Shown to anyone whose role doesn’t have its own (${plural(n,"role")} do).` `` | Two strings: "Shown to anyone whose role doesn’t have its own." + a separate count chip |
| 2 | **No conditional fragments inside a sentence** | `` `${n === 1 ? "is" : "are"} waiting… Process ${n === 1 ? "it" : "them"}` `` | `n === 1 ? "1 submission is waiting to be processed." : \`${n} submissions are waiting to be processed.\`` |
| 3 | **Placeholders carry real words around them** (the pattern needs ≥ 3 letters) | `` `${count} · ${label}` `` as a sentence | Independent " · " segments, each translatable alone |
| 4 | **No case transforms on UI text** (`toLowerCase`, `toUpperCase`, capitalization regexes) | `` `edited by you ${rel(t).toLowerCase()}` `` | "Edited by you · {time}"; a relative time inside a sentence uses `relInline()` (web `lib/format.ts`: "đã gửi vừa xong", never "Đã gửi Vừa xong") |
| 5 | **Counts use `plural()`**, never `(s)` or slashes; register the noun in `VI_NOUNS` | "1 document(s)", "it/them" | `plural(n, "document")` |
| 6 | **One English string, one meaning** (homographs: [language §2.8](product-language-guidelines.md#28-homographs-when-one-english-word-needs-two-meanings)) | "Joined" for a date column and an event | "Join date" / "Joined {space}" |
| 7 | **Consistent punctuation in keys**: curly ’ “ ” and the single-character … | `It's`, `...` | `It’s`, `…` |
| 8 | **Names inside sentences are placeholders**, never translated (§10) | Building "You joined Home" where "Home" is a space name and gets translated | `You joined {0}` with the guard (§10) |
| 9 | **Server text never inside a localized template** | `` `Failed at ${step}: ${error.message}` `` | `Failed at {step}: {localized reason}` from the catalog (§7) |
| 10 | **No UI labels inside backend messages** | Backend: "…process it with Read text in images" | Backend returns a reason; the client words it with the localized label |
| 11 | **Every user-visible string ships in Vietnamese in the same change** — a catalog entry (`vi` + `en`), or for unmigrated screens a legacy `vi.ts` entry (and preview `vi.js`) | Shipping English-only and translating later | Catalog entry; CI passes |
| 12 | **Accessible names are strings too** (`aria-label`, `title`, `alt`, progress labels) | `label = "Progress"` hard-coded | `m.common.progress` |
| 13 | **One text node per sentence in JSX.** `{a} of {b}`, `Submitted {rel}` or `to <Link/>` split the text the translator sees | `<span>{v.resubmitted ? "Resubmitted" : "Submitted"} {rel(at)}</span>` | `` <span>{`Submitted ${relInline(at)}`}</span> ``; names stay in their own `translate="no"` element |
| 14 | **Bare counters are language-neutral**: position and progress counters with no words use `n/m` ("1/3"), never "1 of 3"; ranges with words use a catalog function (`m.common.range`) | `` `${i + 1} of ${n}` `` | `` `${i + 1}/${n}` `` |
| 15 | **Truncated text has a tooltip**: whatever is cut with an ellipsis (chips, names, card titles) carries its full text in `title`; chips stay one line | A long concept chip wrapping onto two centered lines | `.concept-tag` ellipsis + `title={name}` |

## 5. Catalog organization

| Area (`messages/vi.ts`) | Contents |
| --- | --- |
| `common` | Shared words: save, cancel, close, undo, try again, open, copy, loading, empty/error patterns, counts |
| `nav` | Sidebar, groups, route titles, section labels, command palette |
| `state` | Every status chip of PL §2.4 (publication, processing, verification, contribution, request) |
| `action` | Shared verbs of PL §2.3 used across areas |
| `knowledge` | Trang chủ, Tài liệu, Tra cứu, Đã lưu, Tệp của tôi, reader, map, gửi tài liệu |
| `studio` | Quản trị tài liệu: tài liệu, xử lý, duyệt, kho tài liệu, chủ đề, nguồn dữ liệu |
| `assistant` | Trò chuyện, câu trả lời, trích dẫn, dự án, trợ lý settings |
| `work` | Công việc, yêu cầu, cộng đồng |
| `people` | Người dùng & phân quyền, mời, chia sẻ |
| `settings` | Cài đặt, tùy chọn, nhật ký hoạt động, tổng quan |
| `platform` | Bảng điều khiển nền tảng |
| `auth` | Đăng nhập, đăng ký, đặt lại mật khẩu, chọn không gian làm việc |
| `errors` | Error and notification catalog (§7) |

- A string used by several areas lives in `common`, `state` or `action`; areas never redefine it.
- The catalog is split into one file per area under `messages/vi/` and `messages/en/` once it exceeds ~500 lines per language.
- Glossary terms appear in the catalog exactly as in PL §2; a term change is a one-line catalog change plus a retired-term entry.

## 6. Plurals and counts

- Catalog: counts are message functions per language — `vi: documents: (n) => \`${fmtNum(n)} tài liệu\``, `en: documents: (n) => n === 1 ? "1 document" : \`${fmtNum(n)} documents\``. Vietnamese nouns don't inflect; never port English plural logic into Vietnamese.
- Legacy strings: `plural(n, one, many?)` + `VI_NOUNS` until migrated. A noun missing from `VI_NOUNS` leaks English ("3 sign-ins") — add it.
- Zero is a sentence, not a count: "No documents yet" / "Chưa có tài liệu nào", not "0 documents".
- If ICU is adopted later: write Vietnamese messages with only `other` (plus `=0` when zero needs its own sentence). CLDR 49 added a `one` category for `vi` (0 and 1) while older runtimes report only `other`; writing only `other` works on both.

## 7. Server-originated text

Server messages are English and user-safe for API clients and logs. In the UI they are **never shown raw**; the client localizes from stable identifiers.

| Source | Identifier | Client behavior |
| --- | --- | --- |
| API errors (`google.rpc.Status`) | `ErrorInfo.reason` (e.g. `VISION_MODEL_UNAVAILABLE`, `CANDIDATE_NOT_PROCESSED`, `ITEM_TYPE_MISMATCH`, `LAST_ADMIN`) + `metadata` | `errors.ts` catalog maps reason → message with placeholders from `metadata`; fallback by status family ([feedback §7.2](feedback-design-system.md#72-what-an-error-says)) |
| Field violations | `BadRequest.fieldViolations[].field` | Inline field errors; the description is used only if the catalog has no entry for the field+reason |
| Processing failures | `IngestionTask.errorClass` (provider-neutral category already stored, `ingestion_run_items.error_class`) | Catalog maps error class → reason + fix action; the run item's free-text message is not displayed |
| Notifications | Notification type + parameters | Catalog maps type → title/body. **Open decision**: the Inbox renders server-authored English text today (`modules/inbox/model.ts:23`); localizing it needs a `type` (and parameters) on the notification resource — a contract change in `backend/docs_design` |
| Activity events | Event `action` (method name) + target | Client sentences per action (already the pattern in the preview) |

Backend rules: messages never contain internal IDs (`user:{id}`), provider error text, or UI labels; every user-facing failure carries a `reason`. New reasons are added to `api_design.md`/`openapi.yaml` with the change.

## 8. Locale formatting

All formatting goes through `lib/format.ts` (web) / `util.js` (preview) with the interface locale. Never `toLocaleString("en-US")`, never hand-built date strings, never a second copy of the locale logic (today: `assistant-settings/model.ts:91`, `activity/components/ActivityPage.tsx:52`).

| Kind | EN (`en-US`) | VI (`vi-VN`) | Function |
| --- | --- | --- | --- |
| Integer | 1,234 | 1.234 | `fmtNum` |
| Decimal | 1.5 | 1,5 | `fmtNum` |
| Compact | 1.3K / 1.3M | 1,3 N / 1,3 Tr | `fmtCompact` |
| Percent | 65% | 65% | `fmtNum` + "%" (no space) |
| File size | 1.5 MB | 1,5 MB | `fmtSize` (**Change**: use locale decimals) |
| Date | Nov 22, 2026 | 22 thg 11, 2026 | `fmtDate` |
| Date + time | Nov 22, 2026, 2:05 PM | 14:05 22 thg 11, 2026 | `fmtDateTime` |
| Relative | Just now · 5 min ago · Yesterday · 3 days ago | Vừa xong · 5 phút trước · Hôm qua · 3 ngày trước | `rel` (switches to the date after 7 days) |
| Duration | under a second · 2 min 5 s | dưới một giây · 2 phút 5 giây | `fmtDuration` (must be locale-aware) |
| Lists | A, B, and C | A, B và C | `Intl.ListFormat` |

Times are shown in the viewer's time zone. Relative times are never lower-cased by code; the dictionary holds both "Yesterday" and the mid-sentence form if a sentence needs it.

## 9. Vietnamese style

Based on the Microsoft Vietnamese Localization Style Guide and the product's existing dictionary.

1. **Address the person as "bạn".** Use "chúng tôi" only when the system is at fault. Never "người dùng" when speaking to the person.
2. **Imperatives: "Hãy" + verb or a bare verb.** "Vui lòng" only for formal requests that matter (sign-in, security, personal-data removal). Today 7 values use "Vui lòng" (e.g. `vi.ts:5253`).
3. **Failures: "Không … được"** — "Không lưu được thay đổi.", "Không tải được tài liệu.", "Không mở được {0}." Use **"Không thể"** only for genuine inability or permission ("Bạn không thể xóa cộng đồng này vì…"). Avoid **"thất bại"** and **"không thành công"** in person-facing text (today: 21 values contain "thất bại", including the state "Xử lý thất bại"; 40 values start with "Không thể", many of them failures). Use "lỗi" only as the noun "error".
4. **Success: "Đã" + verb + object** ("Đã lưu trữ kho tài liệu", "Đã sao chép"). Never "thành công".
5. **In progress: "Đang" + verb + "…"** ("Đang lưu…", "Đang xử lý 3/12 tài liệu").
6. **Capitalization:** only the first word of a sentence or label, plus proper names (Việt Nam, BoMesh). Never Title Case.
7. **Punctuation:** no space before `. , : ; ! ? ) ] }`; no comma before "và"/"hoặc"; curly quotes with the closing quote before the period or comma (“Q3”.); en dash for ranges (2–5); decimal comma, thousands dot.
8. **Terminology** comes only from the glossary ([language §2](product-language-guidelines.md#2-canonical-vocabulary-vietnamese-first)); in particular "không gian" appears only in "không gian làm việc" (*Workspace*; *Space* is "cộng đồng"), "Gỡ" ≠ "Xóa", "Lưu trữ" means *Archive* only.
9. **Keep English** only for product and vendor names, file types (PDF, DOCX), standard acronyms people use (AI, URL, email, ID shown to admins) and keyboard keys.
10. **Don't translate content** that appears inside chrome patterns: names arrive as placeholders.
11. **Active voice, no English passives.** "Do {0} tải lên", "{0} đã chọn" — never "Được chọn bởi {0}", "Tải lên bởi {0}" (14 values today).
12. **No "của bạn" in labels and titles.** Navigation and headings drop the possessive ("Cộng đồng", not "Cộng đồng của bạn"); keep it in sentences only when it disambiguates (119 values today).
13. **Natural word order and Vietnamese sentence shapes.** Write the Vietnamese sentence first, then the English; never mirror an English clause order ("Đây là những việc sắp tới" not "Đây là những gì sắp tới trong…").

### 9.6 Glossary enforcement

The CI dictionary check (§3.2) verifies, for the glossary's fixed terms, that the Vietnamese value of the English term matches the glossary and that every retired VI term in [language §2.7](product-language-guidelines.md#27-retired-terms-must-not-appear-at-release) is absent from Vietnamese strings (catalog and legacy dictionary), with a short allow-list for content examples.

## 10. Content guard

- Mark content regions `translate="no"`: answers, user messages, document pages, citation quotes, suggested-question chips, user input fields (already done via `SKIP_SEL`).
- **Names inside chrome sentences** ("You joined {space}", "Shared by {owner}", "Welcome, {name}") are captured by patterns and translated recursively; a name that equals a dictionary key ("Home", "Browse", "Classification") would be translated. Port the preview's **workspace-names guard** to web: the translator skips a captured value equal to a known workspace record name (collections, spaces, concepts, people, workspace) unless it sits in chrome elements whose text is a product label.
- Never wrap a placeholder value in `<span translate="no">` inside a sentence: it splits the text node and defeats pattern matching.

## 11. Fallback and missing translations

| Case | Behavior |
| --- | --- |
| String has no Vietnamese entry | Shown in English (unchanged runtime behavior); reported in development (§3.2); a release must have zero known gaps on core flows |
| Pattern partially matches | Whole-string fallback to English (never half-translated) |
| Legacy dictionary chunk fails to load | Catalog strings stay Vietnamese; legacy strings show English; retry on next navigation |
| Server message without a catalog entry | Localized status-family fallback ([feedback §7.2](feedback-design-system.md#72-what-an-error-says)); raw text only in logs |
| Unknown locale stored | Vietnamese (the default) |

## 12. Language switching

- Default: **Vietnamese** for new devices, new accounts and signed-out pages. Where to switch: Preferences → Language, account menu, sign-in/sign-up/workspace chooser pages (picker next to the logo), command palette; in the preview also the prototype bar (EN/VI, `S.lang`). Persisted in the `bomesh.lang` cookie (so the server renders the right language), localStorage and the account's preferences; the device choice wins when set.
- Switching applies immediately to the whole interface with an Undo toast (preview) — the only toast where the action is to revert a preference.
- `<html lang>` follows the interface language (screen readers and hyphenation depend on it). Content blocks keep their own language; when known, set `lang` on content containers.
- Open state survives the switch except main-content component state (web remounts it); forms with unsaved input must not lose it — a dirty form blocks the remount until saved or discarded.

## 13. Layout and typography

- Vietnamese text measured on the current dictionary: overall 1.10× English; labels ≤ 10 characters: median 1.17×, 90th percentile **1.89×**. Design short controls (buttons, chips, tabs, segmented controls) for **+90 %**; never fixed widths for labels; truncation only with a tooltip of the full text.
- Diacritics stack above and below: don't clip text with tight `line-height` or `overflow: hidden` on one-line labels; use the token line heights.
- Test every new screen in Vietnamese at 390 px.

## 14. Translation quality and review

- **Who**: a fluent Vietnamese product reviewer approves new and changed entries in each change that adds UI; engineers add draft translations, the reviewer signs off.
- **Checklist per entry**: matches the glossary; natural Vietnamese (read aloud); "bạn", "Hãy", "Không … được", "Đã …" patterns; placeholders preserved and grammatical in context (check what each `{0}` holds); no English left except allowed names; fits the control at 1.9×.
- **Screens, not strings**: review in the running UI (preview `#` routes or web) in Vietnamese, because the same English key appears in several contexts.
- **Regression**: the QA checklist in [implementation-plan.md](implementation-plan.md#63-checklist) runs for every release.
