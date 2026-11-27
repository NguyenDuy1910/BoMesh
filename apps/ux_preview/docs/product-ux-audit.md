# Product language and feedback audit

Observed findings across BoMesh's user-facing language and feedback behavior, with code references, current English and Vietnamese, and recommendations. Rules cited here live in [product-language-guidelines.md](product-language-guidelines.md) (**PL**), [feedback-design-system.md](feedback-design-system.md) (**FB**) and [localization-standards.md](localization-standards.md) (**LS**); the work is scheduled in [implementation-plan.md](implementation-plan.md).

Audit date: 2026-11-22. Paths are relative to `apps/web/src` unless they start with `apps/`, `backend/` or `docs`.

## 1. Scope, method and evidence

- **Surfaces**: production web (`apps/web`), canonical UX preview (`apps/ux_preview`), backend user-facing messages (`backend/bomesh`). `apps/mobile` **does not exist** in this repository, so no mobile findings.
- **Method**: four read-only audit passes (localization infrastructure; feedback and async; knowledge and Studio copy; the rest of the app), a standards review (Atlassian, Fluent 2, Polaris, Material 3, NN/g, WCAG/APG, Microsoft Vietnamese style guide), then re-verification by the audit owner.
- **Evidence levels**: ✓ = re-verified for this document by grep/read of the cited line and the `vi.ts` value; ◇ = observed by an audit pass with a citation, not re-verified line-by-line. Counts are exact where marked, otherwise approximate.
- **Not covered in depth**: Home and Knowledge map copy, Reader internals, Review queue internals, platform Indexing page, connector-specific error strings. These need a second pass before Phase 3 (implementation plan).
- **Observed vs proposed**: the "Current" columns are observations; "Recommended" columns are proposals governed by the PL/FB/LS rules they cite.

## 2. Executive summary

**Maturity: solid foundation, inconsistent execution.** BoMesh already has the right building blocks: a written vocabulary and rule set (DESIGN_SYSTEM.md Rules/Vocabulary), sentence case almost everywhere, no "successfully", no exclamation marks, a complete bilingual dictionary (5,917 entries ✓) applied by a careful translator with a content guard, an Undo-first philosophy, a `Callout` with correct live-region roles, and good recovery patterns in places (`SettingsPage.tsx:317` "Settings didn't load / Try again. Your settings haven't changed.").

What breaks the "one product" feel:

| Theme | Evidence | Impact |
| --- | --- | --- |
| **Errors pass through raw** | 157 `toast(errorMessage(e))` sites ✓; `errorMessage` returns the server's English `message` (`lib/api/client.ts:76,178-181` ✓); backend messages include internal IDs (`backend/bomesh/iam/policy.py:372` `user:{user_id} is not an active workspace member.` ✓) and provider text (`backend/bomesh/services/conversations/chat.py:357` ✓) | Vietnamese users see English; some messages are technical; no next step |
| **Toasts are the default for everything** | 425 `toast(` calls ✓; ~51 % are danger ◇; danger toasts auto-dismiss after 4 s (`components/ui/Toast.tsx:36` ✓); ~15 success toasts repeat visible state ◇ | Noise; errors disappear before they're read; WCAG 2.2.1 risk for actions |
| **Verbs drift** | Remove/Delete/Unlink/Withdraw, Decline/Deny, Retry/Try again/Re-read/Answer it now, Contribute/Submit/Share/Add documents | People can't predict consequences; VI amplifies it ("Xóa" vs "Gỡ") |
| **Same state, several labels** | "Review due" vs "Re-verification due"; "Changed at the source" vs preview "Outdated"; "Processing" for publishing; "Analyzing" vs "Processing" | Status chips disagree between screens and with the glossary |
| **System internals in copy** | worker/slot (`ProcessingSteps.tsx:62,131` ✓), vision model (`ProcessDialog.tsx:201` ✓), prompt (classification section, line 157 ✓), SLA (`RequestDetailPage.tsx:450` ✓), deployment configuration (`ConnectorsPage.tsx:241` ✓), confidence % (`curation/components/parts.tsx` `ConfBadge` ✓) | Members read engineering language |
| **Mixed-language sentences** | Server text inside `Failed at {0}: {1}` (`curation/components/ProcessingSteps.tsx:110` ✓); lower-cased fragments that miss the dictionary (`artifacts/components/FilePanel.tsx:291` ✓) | Half-English rows in Vietnamese |
| **Vietnamese consistency** | Failures split "Không … được" (52) vs "Không thể" (23 of 79 failure strings) ◇; "thất bại" in 21 values ✓; "Vui lòng" in 7 ✓; *People* and *Everyone* both "Mọi người" ✓; *Archived* and *Stored* both "Đã lưu trữ" ✓ | Reads as several voices |

Desired experience: every action has one predictable outcome and one calm, specific feedback surface; every term means one thing in both languages; nothing technical, nothing untranslated, nothing that disappears before it can be read.

## 3. Feedback behavior findings

| ID | Location | Observed behavior | Problem | Recommendation (rule) | Priority |
| --- | --- | --- | --- | --- | --- |
| FB-01 ✓ | `components/ui/Toast.tsx:36` | `timeout: duration ?? (action ? 8000 : 4000)` for every tone | Danger/warning auto-dismiss in 4 s; Undo window 8 s | Tone-based durations: 6 s / 10 s with action / persistent for warning & danger (FB §4.1) | P1 |
| FB-02 ✓ | 157 sites, e.g. `components/shell/PreferencesDialog.tsx:96`, `modules/chat/components/ChatThread.tsx:197` | `toast(errorMessage(e), { tone: "danger" })` | Raw server English; no routing; no next step | Error catalog + routing (FB §7, LS §7) | P1 |
| FB-03 ✓ | `components/ui/ErrorState.tsx:25-27` ◇ | Shows the server message for status < 500 | Raw English in error states | Catalog message; raw text to logs (FB §7.2) | P1 |
| FB-04 ✓ | `modules/work/components/WorkItemPage.tsx:198`; `modules/people/components/useMemberActions.ts:29`; `modules/workspace-settings/components/SettingsPage.tsx:357,368` ◇ | Validation and blocked actions as danger toasts | Not at the field; no fix | Inline field error / inline notice with the fix (FB §7.1, PL §4.6) | P1 |
| FB-05 ◇ | `components/ui/Toast.tsx:60` + HeroUI queue | Max 3; the oldest is evicted regardless of its action | An Undo can disappear before its window ends | Don't evict actionable toasts (FB §4.3) | P2 |
| FB-06 ◇ | `modules/curation/decisions.ts` (`undoneMessage`), others | Undo emits a second "restored" toast | Contradicts DESIGN_SYSTEM Toast row ("Undo restores silently") | Silent Undo (FB §5.2) | P2 |
| FB-07 ✓ | `modules/knowledge/operations.ts:92` | Confirm "Archive …?" whose description says "You can undo this." | Reversible action behind a dialog | Act + Undo (FB §5.1) | P2 |
| FB-08 ◇ | `modules/artifacts/components/FilePanel.tsx:185-188` (restore version), `modules/requests/components/RequestDetailPage.tsx:112-115` (withdraw) | Confirmation for reversible actions | Same as FB-07 | Act + Undo | P2 |
| FB-09 ✓ | `modules/ingestion/components/AccountsView.tsx:64-67` | Confirm titled "Disconnect …?" whose button is **Show sources** | Title and action disagree; a blocked state shown as a confirmation | Inline notice "Remove its sources first" + Show sources (FB §5.1 Blocked) | P2 |
| FB-10 ✓ | `components/ui/Confirm.tsx:46` | Opening a confirm resolves any pending one `false` | A second request silently cancels the first | Queue confirmations (FB §5.3) | P3 |
| FB-11 ◇ | `modules/knowledge/library/useContributionActions.ts` `remove` | Hold-then-commit without `pagehide` flush (unlike `curation/decisions.ts`) | Closing the tab drops the pending delete; UI and server diverge | Flush on `pagehide` (FB §5.2) | P2 |
| FB-12 ◇ | Same file, `remove` failure; undo-failure toasts in `EditDetailsDialog.tsx:104`, `LinkToSpacesDialog.tsx:62`, `spaces/components/SettingsTab.tsx:152`, `PeopleTab.tsx:306`, `platform/components/UsersPage.tsx:68`, `ConnectorsPage.tsx:52`, `knowledge/map/MapBackground.tsx:151` | Raw error toast; no rollback | State may be wrong after a failed Undo | Roll back + one toast with Try again (FB §5.2) | P2 |
| FB-13 ◇ | `SettingsPage.tsx:105` "Settings saved"; `knowledge/components/SettingsTab.tsx:60` "Changes saved"; `spaces/components/SettingsTab.tsx:127` "Space updated" | Success toast on forms with a save bar | Two channels for one outcome | Save bar only (FB §10) | P3 |
| FB-14 ✓ | `SelectionToolbar.tsx:67` "Copied"; `AboutPane.tsx:57` "Source link copied"; `InviteLinksDialog.tsx:120` "Invite link copied"; `ActivityPage.tsx:568` "Event ID copied"; `SettingsPage.tsx:251` "Workspace ID copied" | Five copy toasts, two shapes | Noise; inconsistent | Icon → check + tooltip "Copied" (FB §10) | P3 |
| FB-15 ◇ | `ChatThread.tsx:132,170,197,236,281`; `ingestion/actions.ts:42,111` | Recoverable problems as `accent` (info) toasts, often with raw text | Wrong tone; chat failures belong on the answer | Warning tone or inline on the answer with Try again (FB §4.1, §12) | P2 |
| FB-16 ◇ | `modules/inbox/components/InboxBell.tsx:253` | "Request approved" success vs "Request denied" accent | Negative outcome looks informational; "denied" retired | "Request declined", neutral tone, Open | P3 |
| FB-17 ◇ | `work/components/GuideView.tsx:79`, `QuizView.tsx:122`, `ReviewView.tsx:202`, `ingestion/components/SyncDrawer.tsx:140`, `knowledge/components/SavedSection.tsx:83` | Request-starting buttons without `isPending` | Double submits | Pending guard (FB §6.2) | P2 |
| FB-18 ✓ | `node_modules/react-aria/dist/private/toast` | Every toast is `role="alertdialog"` with `role="alert"` content | Every toast interrupts screen-reader users | Keep the library; cut toast volume (FB §4.6) | P2 |
| FB-19 ◇ | `apps/ux_preview/scripts/core/overlays.js:107` | One `role="status"` polite region for all toasts; no warning tone | Errors announced politely; tone set differs from web | Errors `role="alert"`; add warning tone (FB §4.1, §11) | P3 |
| FB-20 ◇ | `components/ui/ProgressBar.tsx:11-15` | Default accessible name "Progress" (VI "Tiến độ") | Generic name | Name the process ("Processing progress") (FB §11) | P3 |

## 4. Wording findings

Columns: current EN/VI are observed (`vi.ts` value or "(no entry)"); recommendations follow PL.

### 4.1 Shell, navigation, search

| ID | Location | Current EN | Current VI | Problem | Recommended EN | Recommended VI | Rule | P |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| SH-01 ✓ | `components/shell/Sidebar.tsx:449,456` vs `components/shell/CommandPalette.tsx:501` | "Search anything…" / "Search, ask or go to…" | "Tìm mọi thứ…" / "Tìm, hỏi hoặc đi đến…" | Two names for one ⌘K command | "Search or ask…" (both) | "Tìm kiếm hoặc đặt câu hỏi…" | PL §4.5 | P2 |
| SH-02 ✓ | `components/shell/ShellGate.tsx:122` | "This workspace couldn’t be opened" | "Không mở được không gian làm việc này" | No next step | Title unchanged + body "Try again, or choose another workspace." | "Hãy thử lại hoặc chọn không gian làm việc khác." | PL §4.10 | P2 |
| SH-03 ✓ | `vi.ts` key "AI Chat"; `apps/ux_preview/docs/PRODUCT_FLOW.md:113,160` | "AI Chat" | "Trò chuyện AI" (key has no source use) | Stale: the UI says "New chat". The DESIGN_SYSTEM.md glossary entry was removed in Phase 0 (the glossary now lives in PL §2) | Delete the key; "New chat" / "Recent" in the remaining doc mentions | "Cuộc trò chuyện mới" | PL §2.1, §2.7 | P3 |
| SH-04 ✓ | `vi.ts` "People" and "Everyone" | People (area) · Everyone (collection access) | both "Mọi người" | Two concepts, one word, on the same screens (People → access) | Keep EN | People "Mọi người"; Everyone (access) "Mọi thành viên" | PL §2.2 | P1 |
| SH-05 ◇ | `components/shell/PreferencesDialog.tsx:220`, `AccountMenu.tsx:55` | "Preferences"; aria "Account and preferences" | "Tùy chọn"; aria (no entry) | Untranslated accessible name | "Account and preferences" | "Tài khoản và tùy chọn" | LS §4 #12 | P3 |

### 4.2 Knowledge (Browse, Saved, My files, Contribute)

| ID | Location | Current EN | Current VI | Problem | Recommended EN | Recommended VI | Rule | P |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| KN-01 ✓ | `knowledge/model.ts:186` | "Stored, not searchable" | "Đã lưu trữ, không tìm kiếm được" | VI reads "Archived"; "Stored" is technical | "Uploaded, not searchable" | "Đã tải lên, chưa tìm kiếm được" | PL §2.4 | P1 |
| KN-02 ✓ | `knowledge/model.ts:112`; reader `ReaderPage.tsx:359` | "Review due" | "Đến hạn rà soát" | Glossary and preview Quality filter say "Re-verification due"; "rà soát" collides with Review | "Re-verification due" | "Đến hạn xác minh lại" | PL §2.4 | P2 |
| KN-03 ✓ | `knowledge/browse/catalog.ts:45` | Facet "Trust" | "Độ tin cậy" | Not a glossary term; reads as security | "Verification" | "Xác minh" | PL §2.4 | P2 |
| KN-04 ✓ | `knowledge/library/components/ContributionDrawer.tsx:199` | "Remove" (declined contribution, `Trash2`, deletes after Undo window) | "Gỡ" | The record is deleted, not detached | "Delete" | "Xóa" | PL §2.3 | P2 |
| KN-05 ✓ | `knowledge/library/components/ContributionsPage.tsx:76` | "Share a document with your team. You check what the assistant suggests, then a reviewer publishes it." | "Chia sẻ tài liệu với nhóm. …" | "Share" is the access verb | "Contribute a document for your team. You check what the assistant suggests, then a reviewer publishes it." | "Đóng góp tài liệu cho nhóm. Bạn kiểm tra đề xuất của trợ lý, sau đó người kiểm duyệt sẽ xuất bản." | PL §2.3 | P2 |
| KN-06 ✓ | `knowledge/components/KnowledgeHeader.tsx:25,32` | Contribute button uses the Upload icon | — | Icon doesn't distinguish review from personal upload | Distinct icon for Contribute | — | PL §2.3 | P3 |
| KN-07 ◇ | `knowledge/components/ResourceActions.tsx:183`; `Contribute.tsx:461` | "Submit a new version…" / dialog "Submit a new version" | "Gửi phiên bản mới…" | Entry verb for review is Contribute | "Contribute a new version…" | "Đóng góp phiên bản mới…" | PL §2.3 | P3 |
| KN-08 ◇ | `knowledge/browse/BrowsePage.tsx:152-153` | "Documents appear here once they’re approved and processed. Contribute a file for review, or connect a source." | — | "approved" ≠ Published; "connect a source" ≠ "Add source" | "Documents appear here once they’re published and processed. Contribute a file for review, or add a source." | "Tài liệu sẽ xuất hiện ở đây khi đã được xuất bản và xử lý. Hãy đóng góp tệp để kiểm duyệt hoặc thêm nguồn." | PL §2.3–2.4 | P2 |
| KN-09 ◇ | `knowledge/browse/ViewsMenu.tsx:42,93,95` vs `apps/ux_preview/scripts/features/hub.js:259-261` | "Delete view"; toast `Deleted “…”` without Undo (web) | "Xóa chế độ xem" | Web lacks the preview's Undo | Keep "Delete view"; add Undo | — | FB §5.1 | P3 |
| KN-10 ✓ | `vi.ts` "Remove from saved" | "Remove from saved" | "Gỡ khỏi mục đã lưu" | Long, mirrors English | Keep EN | "Bỏ lưu" | PL §2.3 | P3 |
| KN-11 ✓ | `knowledge/model.ts:175`; `knowledge/library/contributions.ts:315`; `curation/components/review/Inspector.tsx:456` | "Analyzing" / "Analyzed" / "Analyzing…" | "Đang phân tích" | The same pass is "Processing" in Studio | "Processing" / "Processed" / "Processing…" | "Đang xử lý" / "Đã xử lý" / "Đang xử lý…" | PL §2.4 | P2 |
| KN-12 ✓ | `knowledge/library/components/FilesSection.tsx:61` | "This file can’t be processed" (danger toast) | "Không thể xử lý tệp này" | No reason, no fix | Reason from `errorClass` + action ("…Remove the password, then upload it again.") | "Không xử lý được tệp này. …" | PL §4.10, LS §7 | P2 |

### 4.3 Knowledge Studio (Documents, Processing, Review, Classification, Sources)

| ID | Location | Current EN | Current VI | Problem | Recommended EN | Recommended VI | Rule | P |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ST-01 ✓ | `curation/components/ProcessingSteps.tsx:131` | "In line: it starts as soon as the worker has a free slot" | "Trong hàng đợi: bắt đầu ngay khi bộ xử lý có chỗ trống" | Infrastructure words | "Waiting: it starts as soon as processing is free" | "Đang chờ: sẽ bắt đầu ngay khi có thể xử lý" | PL §2.6 | P2 |
| ST-02 ✓ | `ProcessingSteps.tsx:62` | "Waiting for a free slot" | "Đang chờ bộ xử lý có chỗ trống" | Same | "Waiting to start" | "Đang chờ bắt đầu" | PL §2.6 | P2 |
| ST-03 ✓ | `curation/components/ProcessDialog.tsx:201` | "The vision model reads every picture, such as slides saved as images and diagrams. Slower; scanned PDF pages are always read." | "Mô hình thị giác đọc mọi hình ảnh, …" | "vision model" is internal | "The assistant reads the text in every picture, such as slides saved as images and diagrams. Slower; scanned PDF pages are always read." | "Trợ lý đọc chữ trong mọi hình ảnh, như trang chiếu lưu dạng ảnh và sơ đồ. Chậm hơn; các trang PDF quét luôn được đọc." | PL §2.5 | P2 |
| ST-04 ✓ | `ProcessDialog.tsx` description (`vi.ts`) | "The AI reads each file and classifies it. You can keep working." | "AI đọc từng tệp và phân loại. …" | Actor is "the assistant" | "The assistant reads each file and classifies it. You can keep working." | "Trợ lý đọc từng tệp và phân loại. Bạn có thể tiếp tục làm việc." | PL §2.5 | P3 |
| ST-05 ✓ | `curation/components/parts.tsx` `ConfBadge` | Percentage with title "Assistant confidence" | "Độ tin cậy của Trợ lý" | Glossary: never a confidence % | "Assistant" / "Suggested" / "Set by a person" chip | "Trợ lý" / "Gợi ý" / "Do người chọn" | PL §2.4 | P2 |
| ST-06 ✓ | `curation/components/DocumentsSection.tsx:180-184` | `` `${plural(n,"submission")} ${n===1?"is":"are"} waiting… Process ${n===1?"it":"them"} first: the assistant classifies ${…}` `` | partly | Ternary grammar can't translate; "classifies" jargon | Two whole sentences: "1 submission is waiting to be processed. Process it first, then review it here." / "{n} submissions are waiting to be processed. Process them first, then review them here." | "Có 1 bài gửi đang chờ xử lý. Hãy xử lý trước rồi kiểm duyệt tại đây." / "Có {0} bài gửi đang chờ xử lý. …" | LS §4 #2 | P2 |
| ST-07 ✓ | classification section of `curation/components`, line 157 | "Show the classification prompt" | "Xem prompt phân loại" | Mixed language in VI | Keep EN (admin context, PL §2.5) | "Xem lời nhắc phân loại" | PL §2.5, LS §9 | P3 |
| ST-08 ✓ | `vi.ts` "Processing failed" | "Processing failed" | "Xử lý thất bại" | "thất bại" pattern | Keep EN | "Không xử lý được" | LS §9 #3 | P2 |
| ST-09 ◇ | `knowledge/model.ts:184` vs `curation/lifecycle.ts:61` vs `apps/ux_preview/scripts/core/lifecycle.js:76` | Fix pointer "…in Documents → Issues" / "…from Processing" / "…from Documents → Processing" | — | Three pointers for one state | "Process it again from Documents → Processing." | "Hãy xử lý lại trong Tài liệu → Đang xử lý." | PL §2.4 | P3 |
| ST-10 ◇ | `curation/lifecycle.ts:59-61` | "Not read, classified or indexed yet." / "…and indexed: search and the assistant can use it once it’s published." | "Chưa được đọc, phân loại hay lập chỉ mục." | "indexed" in member copy | "Not read or sorted yet. Search and the assistant can’t use it." | "Chưa được đọc hay phân loại. Tìm kiếm và trợ lý chưa dùng được." | PL §2.6 | P3 |
| ST-12 ✓ | `apps/ux_preview/scripts/core/ui.js:46` | Preview status "Outdated" | — | Web says "Changed at the source" | "Changed at the source" | "Đã thay đổi tại nguồn" | PL §2.4 | P3 |
| ST-13 ✓ | `vi.ts` "Changed at source" + "Changed at the source"; "Published as new version" + "Published as a new version" | Two keys each | "Đã xuất bản thành phiên bản mới" / "…dưới dạng phiên bản mới" | Duplicate states with divergent VI | One key each: "Changed at the source", "Published as a new version" | "Đã thay đổi tại nguồn" / "Đã xuất bản thành phiên bản mới" | PL §2.4 | P3 |
| ST-14 ✓ | `vi.ts` "Deny", "Denied", "Denied access request" | Access-request decisions use Deny | "Từ chối" | Decline is the decision verb | "Decline", "Declined access request" | "Từ chối", "Đã từ chối yêu cầu quyền truy cập" | PL §2.3 | P3 |

### 4.4 Assistant (New chat, conversations, Work)

| ID | Location | Current EN | Current VI | Problem | Recommended EN | Recommended VI | Rule | P |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| CH-01 ✓ | `chat/components/ChatThread.tsx:433` | Button "Answer it now" | (no entry) | Reads as the person answering; untranslated | "Ask again" | "Hỏi lại" | PL §2.3 | P1 |
| CH-02 ✓ | `backend/bomesh/services/conversations/chat.py:357` | `Unavailable(event.error.message, reason="MODEL_STREAM_ERROR")` | — | Provider text can reach the UI | Catalog: "The assistant couldn’t answer. Try again." | "Trợ lý không trả lời được. Hãy thử lại." | FB §7.2 | P1 |
| CH-03 ✓ | `ChatThread.tsx:170`, `useStartConversation.ts:44` ◇ | "Another answer is still being written. Wait for it or stop it." | "Một câu trả lời khác vẫn đang được viết. Hãy chờ hoặc dừng nó." | Duplicated source string; accent tone | One keyed toast `chat:busy`: "An answer is still being written. Wait for it or stop it." | "Câu trả lời vẫn đang được viết. Hãy chờ hoặc dừng lại." | FB §4.4 | P3 |
| WK-01 ✓ | `work/components/ReviewView.tsx:545,547,563` | "Re-read this paper", "Re-read …" | "Đọc lại bài báo này" | Method-verb; "paper" is course-specific | "Read again" | "Đọc lại" | PL §2.7 | P3 |
| WK-02 ✓ | `work/components/WorkItemPage.tsx:198` | "Give it a title." (danger toast) | "Hãy đặt tiêu đề." | Validation as toast | Inline: "Enter a title." | "Hãy nhập tiêu đề." | PL §4.6 | P1 |
| WK-03 ✓ | `requests/components/RequestDetailPage.tsx:450` | "Asked {name} for information. The SLA clock pauses until they reply" | — | Jargon; missing final period | "Asked {name} for more information. The due date pauses until they reply." | "Đã hỏi {0} thêm thông tin. Hạn xử lý tạm dừng cho đến khi họ trả lời." | PL §3, §2.7 | P2 |
| WK-04 ✓ | `spaces/components/SettingsTab.tsx:220` | "Only leads of this space can archive it." | (no entry) | Role naming drift; untranslated | "Only space managers can archive it." | "Chỉ người quản lý cộng đồng mới lưu trữ được." | PL §4.13 | P2 |
| WK-05 ✓ | `spaces/components/MaterialsTab.tsx:106,159` | "Unlink from this space", `Unlinked “…”` | "Bỏ liên kết khỏi không gian này" / "Đã hủy liên kết “{0}”" / "Hủy liên kết" | Retired verb; three VI renderings | "Remove from this space", `Removed “{0}” from this space` | "Gỡ khỏi cộng đồng này", "Đã gỡ “{0}” khỏi cộng đồng này" | PL §2.3 | P2 |

### 4.5 People, settings, platform, auth

| ID | Location | Current EN | Current VI | Problem | Recommended EN | Recommended VI | Rule | P |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| PE-01 ✓ | `vi.ts` "Remove from workspace" vs "Remove from space", "Member removed" | — | "Xóa khỏi không gian làm việc" vs "Gỡ khỏi không gian", "Đã gỡ thành viên" | "Xóa" implies the account is deleted | Keep EN | "Gỡ khỏi không gian làm việc" | PL §2.3 | P1 |
| PE-02 ✓ | `people/components/AddPeopleDialog.tsx:243`; orphan key `vi.ts` "Add people by their work email. Anyone without a BoMesh account gets an email invite." | "…Each person needs a BoMesh account." | "Mỗi người cần có tài khoản BoMesh." | The canonical flow (`apps/ux_preview/docs/PRODUCT_FLOW.md` journey 8: "unknown addresses get an email invite, Resend / Revoke") and `CreateWorkspaceDialog.tsx:76` ◇ promise email invites; the web dialog says every person needs an account [INFERENCE: the API has no email invite for unknown addresses] | Until the API supports it: "Add people who already have a BoMesh account. Invite anyone else with an invite link." Afterwards: the preview's behavior and sentence | "Thêm người đã có tài khoản BoMesh. Mời người khác bằng liên kết mời." | PL §2.2 | P1 |
| PE-03 ◇ | `people/model.ts:118` | `` `You can’t ${verb} yourself` `` | — | Verb injected into a sentence | "You can’t suspend yourself." / "You can’t remove yourself." | "Bạn không thể tạm ngưng chính mình." / "Bạn không thể gỡ chính mình." | LS §4 #1 | P2 |
| PE-04 ✓ | `backend/bomesh/iam/policy.py:372`; `backend/bomesh/services/collaboration/members.py:111`; `…/collaboration/requests.py:1247` | `user:{user_id} is not an active workspace member.` / `'{member}' is not an active member of this workspace.` | — | Internal identifiers in user text | Reason `NOT_WORKSPACE_MEMBER` → "This person isn’t an active member of this workspace." | "Người này không phải thành viên đang hoạt động của không gian làm việc." | LS §7 | P1 |
| PE-05 ✓ | `platform/components/ConnectorsPage.tsx:241` | "Connectors are added in the deployment configuration." | "Trình kết nối được thêm trong cấu hình triển khai." | Ops wording; who acts? | "Connectors are set up by your deployment team." | "Trình kết nối do nhóm triển khai thiết lập." | PL §1 | P3 |
| PE-06 ✓ | `platform/components/IndexingPage.tsx:176` | `Retrying ...` (ASCII) | — | Ellipsis convention | "Retrying…" | "Đang thử lại…" | PL §3 | P3 |
| AU-01 ✓ | `auth/google.ts:88` | "Google did not return a sign-in credential. Please try again." | "Google không trả về thông tin đăng nhập. Vui lòng thử lại." | Jargon; "please" | "Google didn’t confirm the sign-in. Try again, or use another account." | "Google chưa xác nhận đăng nhập. Hãy thử lại hoặc dùng tài khoản khác." | PL §3 | P2 |
| AU-02 ◇ | `backend/bomesh/identity/auth.py:137`; `identity/reset_tokens.py:65` | "The sign-in credentials are incorrect." / "The password reset link is invalid or has expired." | — | Untranslated; no next step | Reasons → "The email or password is incorrect." / "This reset link has expired. Request a new one." | "Email hoặc mật khẩu không đúng." / "Liên kết đặt lại đã hết hạn. Hãy yêu cầu liên kết mới." | LS §7 | P2 |

## 5. Localization findings

| ID | Location | Observation | Problem | Recommendation | P |
| --- | --- | --- | --- | --- | --- |
| L-01 ✓ | `vi.ts` "None of these are published" | "Chưa tài liệu nào được xuất bản" | Ungrammatical | "Chưa có tài liệu nào được xuất bản" | P1 |
| L-02 ✓ | `vi.ts` "Not yet. No workspace has added or invited you." (shown on the workspace chooser) | "Chưa có. Chưa không gian làm việc nào thêm hoặc mời bạn." | Ungrammatical | "Chưa có không gian làm việc nào thêm hoặc mời bạn." | P1 |
| L-03 ✓ | `artifacts/components/FilePanel.tsx:291` | `` `edited by you` / `by the assistant` + rel().toLowerCase() `` | Lower-cased fragments miss the keys "Edited by you"/"By the assistant"; English in VI | Whole segments: "Edited by you · {time}" (LS §4 #4) | P1 |
| L-04 ✓ | `curation/components/ProcessingSteps.tsx:110` + `backend/bomesh/services/knowledge_items/file_content.py:153-182` | `Failed at {0}: {1}` with {1} = server sentence | Mixed language on every failed row | Map `errorClass` → localized reason (LS §7) | P1 |
| L-05 ✓ | Same file `:110` | Fallback "Stopped partway" vs key "stopped partway" | — (both exist) | Remove the lowercase duplicate when L-04 lands | P3 |
| L-06 ✓ | `backend/bomesh/services/knowledge_items/file_content.py:171-173` | "…process it with Read text in images" | UI label inside a backend message | Reason + client wording (LS §4 #10) | P2 |
| L-07 ◇ | `modules/inbox/model.ts:23` | Notification title/body are server-authored English | Inbox can't be Vietnamese | Open decision: notification `type` + params (LS §7) | P1 |
| L-08 ◇ | `assistant-settings/model.ts:91` `toLocaleString("en-US")`; `activity/components/ActivityPage.tsx:52` own locale logic | Formatting bypasses `format.ts` | "1,000" in Vietnamese | Use `fmtNum`/`fmtDate` (LS §8) | P2 |
| L-09 ◇ | `chat/components/ShareConversationDialog.tsx:174`, `artifacts/components/ArtifactMenus.tsx:117`, `auth/components/WorkspaceChooserPage.tsx:24-25` | `.toLowerCase()` / capitalization regex on localized output | Breaks VI casing | Remove transforms (LS §4 #4) | P2 |
| L-10 ✓ | `vi.ts` | 5,917 entries; 1,908 (32 %) without a literal match in source/backend | Stale keys mask real gaps; ~runtime-composed share unknown | Stale-key report (LS §3.2) | P2 |
| L-11 ✓ | `vi.ts` failure strings | "Không … được" vs "Không thể" for failures; "thất bại" in 21 values; "Vui lòng" in 7 | Inconsistent voice | LS §9 #2–3; one normalization pass | P2 |
| L-12 ✓ | `vi.ts` "Shown behind the knowledge map for everyone in {0}. It's softened…" | Straight apostrophe in a key | Won't match source written with ’ | Curly quotes in keys (LS §4 #7) | P3 |
| L-13 ◇ | `lib/i18n.ts` vs `apps/ux_preview/scripts/core/i18n.js` | Web has no workspace-names guard | A space named "Home" inside "You joined {0}" is translated | Port the guard (LS §10) | P2 |
| L-14 ✓ | `lib/i18n.ts` | Missing strings fall back silently | Gaps undetected (e.g. CH-01, WK-04, "Download failed" has no entry) | Dev reporter (LS §3.2) | P2 |
| L-15 ✓ | `lib/format.ts` `fmtSize` | "1.5 MB" in Vietnamese | Decimal separator | Locale decimals (LS §8) | P3 |
| L-16 ◇ | `lib/i18n.ts` comment "~3,700-entry dictionary" | Stale comment | — | Update when splitting the dictionary | P3 |

## 6. Systemic patterns (counts)

| Pattern | Count | Rule |
| --- | --- | --- |
| `toast(` calls | 425 ✓ | FB §3 |
| Raw `toast(errorMessage(e))` | 157 ✓ | FB §7 |
| Danger share of toasts | ~51 % ◇ | FB §7.1 |
| `confirm({` sites | 20 ✓ (≥ 4 for reversible actions) | FB §5.1 |
| `useMutation(` (most mutations are ad-hoc async functions) | 16 ✓ | FB §6 |
| `aria-live` attributes | 12 ✓ | FB §11 |
| Success toasts duplicating visible state | ~15 ◇ | FB §3.2 |
| Mixed-language constructions (" · " sentences with EN fragments, ternaries, lower-casing) | ≥ 15 / ≥ 6 / 3 ◇ | LS §4 |
| "Please" in English UI | 4 dictionary keys ◇ | PL §3 |
| Sentence case violations in buttons/titles | 0 observed ◇ | PL §3 (keep) |
| "Successfully", "Sorry", exclamation marks | 0 ◇ | PL §1 (keep) |

## 7. Reviewed and not adopted

Audit passes proposed these; the audit owner rejected or reshaped them.

| Proposal | Decision | Why |
| --- | --- | --- |
| Rename "Ask AI" to "Ask the assistant" (command palette) | **Keep "Ask AI"** | An established vocabulary decision (PL §2.5); short, scannable action label. "Assistant" in Manage is the settings page, a different concept |
| Change "Changed at the source" to "Changed at source" | **Keep "Changed at the source"** | It is the label used across web code and the glossary's state list; the shorter key is the duplicate to remove (ST-13) |
| Rename "Add documents" on a collection to "Contribute documents" | **Keep "Add documents"** | Editors add directly without review — a distinct promise; now defined in PL §2.3 |
| Rename "Submit for review" in the Contribute dialog | **Keep** | The button names the outcome; Contribute is the entry verb |
| "Template literals defeat translation" (`ConfirmDialog.tsx:36`) | **Not a defect** | The translator works on rendered text, so `Type {0} exactly to confirm.` matches as a pattern |
| "Hard-coded English toasts in `useContributionActions.ts`" | **Not a defect by itself** | Rendered text is translated when the pattern exists; the real check is dictionary coverage (L-14) |
| "`Its {1} stay in Recent` invents “dự án”" | **Not a defect** | The toast follows deleting a *project* (`projects/actions.ts:124`); "của dự án" is correct context |
| Translate "Knowledge Studio" | **Keep in English** | Product name rule (PL §2) |
| Relabel the contribution state `publishing` ("Processing") as "Publishing" | **Keep "Processing"** | `knowledge/model.ts:181`: after approval the document *is* being processed ("Being read, classified and indexed"); the key name is internal. "Publishing" remains the label for the publication transition elsewhere |
| Replace "Retry" with "Try again" everywhere | **Two verbs, two meanings** | *Retry* regenerates an answer (with options); *Try again* recovers from a failure (PL §2.3) |

## 8. Terminology usage map (current)

| Concept | Variants observed (EN) | Variants observed (VI) | Canonical (PL) |
| --- | --- | --- | --- |
| Detach | Remove, Unlink, Delete | Gỡ, Xóa, Hủy liên kết, Bỏ liên kết | Remove / Gỡ |
| Destroy (restorable) | Delete, Remove (declined contribution) | Xóa, Gỡ | Delete / Xóa |
| Hide from readers | Archive, "Removes it … from answers" | Lưu trữ | Archive / Lưu trữ |
| Submit for review | Contribute, Submit, Share a document | Đóng góp, Gửi, Nộp bài, Chia sẻ | Contribute / Đóng góp |
| Negative decision | Decline, Deny | Từ chối | Decline / Từ chối |
| Recover | Try again, Retry, Re-read, Answer it now | Thử lại, Đọc lại | Try again / Retry (answers) |
| Verification state | Review due, Re-verification due, Trust | Đến hạn rà soát, Đến hạn xác minh lại, Độ tin cậy | Re-verification due / Verification |
| The actor | the assistant, the AI, the vision model | Trợ lý, AI, Mô hình thị giác | the assistant / Trợ lý |
| Waiting | In line, Waiting for a free slot, Waiting | Trong hàng đợi, Đang chờ | Waiting / Đang chờ |
| Global search | Search anything, Search, ask or go to | Tìm mọi thứ, Tìm, hỏi hoặc đi đến | Search or ask |

## 9. UI and layout pass (2026-11-22, Vietnamese-first)

Browser audit of every web area at 1440, 1280 and 390 px in Vietnamese: Home and chat, Knowledge and the reader, Quản trị tài liệu, administration, shell, auth and Cộng đồng. Defects were fixed in the same pass; the preview got the same fix wherever it had the defect.

| Defect class | Examples | Fix (rule) |
| --- | --- | --- |
| Sentence split across JSX text nodes, so it stays English | "1 of 1", "Đã gửi" + time, "Question 2 of 5", "Tối mode · Chàm accent", dialog titles around a space name, request banners | One template string per sentence; bare counters `n/m`; Pager range from the catalog (LS §4 #13–14) |
| Capitals mid-sentence from relative times | "Đã gửi Vừa xong", "nhập lần cuối Hôm qua" | `relInline()` everywhere; hand-written `.toLowerCase()` variants removed (LS §4 #4) |
| Clipped or wrapping text | Long concept chips on two centered lines; summary textarea cut mid-line; truncated names with no way to read them; skeleton box inside a box | One-line chips with ellipsis + `title`; auto-growing summary; tooltips on truncated names; `SkeletonRows unboxed` (LS §4 #15) |
| Terms that read as another concept | "Người dùng & phân quyền" as a space's member tab and as search group; "Approved" (requests) for a document decision; "Archive" file type = "Lưu trữ"; "In {0}" untranslatable | "Members"/Thành viên; "Approved to publish"/Đã duyệt; "Compressed file"/Tệp nén; "Inside {0}" (PL §2.8) |
| Duplicate or competing elements | "Trò chuyện mới" twice in ⌘K; two "Yêu cầu mới" primaries on an empty page; "Bản nháp" twice in a work row; "· 0" counts on Sources views | One entry each (PRODUCT_DESIGN_RULES) |
| Broken controls | "Thêm chủ đề…" couldn't open with nothing chosen (`useLazyOptions` closed list empty); phone tab row hid the current tab | Closed list keeps one option; the current section tab scrolls into view |
| Missing dictionary entries | ≈ 90 strings (errors, statuses, file types, request banners, Confluence) | Added to `vi.ts` (and `vi.js` where the preview uses them) |

Still open: a concept's `documentCount` is stale after unpublishing (backend); notifications have no document name in their body (backend); the assistant's default welcome "How can I help you today?" is backend data, shown in Vietnamese only through a dictionary entry; option names inside the Preferences sentence keep their capital ("Chế độ Tối"); quizzes, evidence reviews, projects and live streaming answers weren't reachable with this workspace's data and were fixed in code only.

## 10. User management redesign (People, 2026-11-23)

Trigger: on Members, every row carried a full Select for the role and a floating action bar appeared at the bottom of the screen when a row was ticked; Roles was a list of roles beside one role's long checklist, so comparing two roles meant clicking back and forth. Redesigned in the preview first (`features/people.js`, `styles/pages/people.css`, `core/ui.js selectionBar`); `apps/web` follows.

| Problem | Change | Reference practice |
| --- | --- | --- |
| A live Select on every row: heavy to scan, one slip changes someone's access, no idea what a role grants | Role as words (admins carry a shield); changing it is the role dialog — every role with its description, *Current* marked, a warning before making someone an admin, Undo after | GitHub organization People and Slack member management show the role as text and change it in a dialog of role options ([GitHub](https://docs.github.com/en/organizations/managing-peoples-access-to-your-organization-with-roles/roles-in-an-organization), [Slack](https://slack.com/help/articles/218124397-Manage-members-in-your-workspace)) |
| Bulk actions floated at the bottom, far from the selected rows | The selection toolbar takes the filter row's place: count · Change role… · Add to group · Suspend · Clear selection | Carbon data table: the batch action bar replaces the table toolbar while rows are selected ([Carbon](https://www.carbondesignsystem.com/building-blocks/core/components/data-table/guidelines)) |
| Two header actions (Invite link, Add people) competing | One primary, Add people; *Invite with a link instead* inside its dialog | PRODUCT_DESIGN_RULES §2 (one obvious primary action per context) |
| A Groups column of dashes | The column appears once anyone is in a group | PRODUCT_DESIGN_RULES §3 (clarity over density) |
| Roles compared one at a time; then (first redesign) a table that mixed reading and editing — ✓/– for built-in roles, live checkboxes for custom ones, descriptions, locks and ⋯ in every column head, an intro paragraph | A read-only table: role name + *n people* per column, ✓ only where allowed; everything about one role (name, description, permission switches, delete, duplicate) lives in its drawer, the Groups pattern. Long permission labels shortened ("Create collections and review what’s sent to them") | GitHub documents organization roles as one permissions table with a column per role ([GitHub](https://docs.github.com/en/organizations/managing-peoples-access-to-your-organization-with-roles/roles-in-an-organization)); PRODUCT_DESIGN_RULES §2 (one responsibility per component) |
| "Who can read what" mixed into roles | Kept out of the Roles page: the member drawer's Knowledge access section shows what a person can open and why | `item_model.md` §6: collection access comes from collection grants, not workspace roles |

Not changed: Groups, Access requests and the member drawer's knowledge-access section. Other lists (Documents, Review, Re-verification, Requests, Saved, Materials, a collection's Contents) still use the floating `bulkBar`; they move to `selectionBar` in a follow-up so the pattern stays one.
