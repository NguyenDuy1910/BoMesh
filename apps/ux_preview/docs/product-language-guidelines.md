# Product language guidelines

The single source of truth for **what BoMesh calls things and how it words them**, in English (source) and Vietnamese. Every screen in `apps/ux_preview`, `apps/web` and future clients follows it. Backend `message` strings that reach people follow it too.

## How the language and feedback documents fit together

Each rule has exactly one home. Other documents link to it and never restate it.

| Document | Owns | Does not own |
| --- | --- | --- |
| **product-language-guidelines.md** (this file) | Voice and tone, the canonical vocabulary (EN + VI glossary), writing mechanics, copy patterns per component, Do/Don't | When a message appears, how long it stays, which channel |
| [feedback-design-system.md](feedback-design-system.md) | Which feedback channel to use, toast/inline/banner/dialog/progress behavior, timing, deduplication, Undo, retry, optimistic updates, async and accessibility behavior of feedback | The words inside the message |
| [localization-standards.md](localization-standards.md) | i18n architecture, how to write translatable strings, Vietnamese style, formatting of dates/numbers/sizes, fallback, translation QA | Which term to use (it links here) |
| [product-ux-audit.md](product-ux-audit.md) | Observed findings with code references, current vs recommended wording | Rules (it cites them) |
| [implementation-plan.md](implementation-plan.md) | Architecture decisions, phases, affected files, acceptance criteria, QA checklist | Rules (it cites them) |

Related, unchanged homes: product principles in [PRODUCT_DESIGN_RULES.md](../PRODUCT_DESIGN_RULES.md); components, layout and visual rules in [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md); API and domain contracts in `backend/docs_design` (wording never changes a contract, see [§2.9](#29-ui-words-versus-contract-names)).

## 1. Voice and tone

BoMesh sounds like a **calm, competent colleague**: professional, plain, concise, consistent, accessible and action-oriented.

| Principle | Means | Example |
| --- | --- | --- |
| Plain | Everyday words; no system internals | "Processing" — not "Ingesting", "Indexing job queued" |
| Concise | The shortest wording that stays unambiguous; one idea per sentence | "Collection archived" — not "The collection has been successfully archived" |
| Precise | Name the object and the result; numbers over adjectives | "Moved 12 documents to Policies" — not "Documents moved" |
| Calm | No exclamation marks, no praise for routine work, no alarm | "This link expired. Ask for a new one." — not "Oops! Link expired!" |
| Action-oriented | Every problem says what to do next (DESIGN_SYSTEM rule 7) | "Couldn't save. Check your connection and try again." |
| Respectful | Address the person as **you / bạn**; never blame them; no "please" or "sorry" in routine copy | "This email is already in use." — not "You entered an invalid email." |
| Honest | Say what is true now; never claim success before it happened ([feedback §6](feedback-design-system.md#6-optimistic-updates-and-concurrency)) | "Saving…" then "Saved" — not "Saved" before the server answers |

Tone shifts with the moment, voice does not:

| Moment | Tone | Example |
| --- | --- | --- |
| Routine success | Neutral, terse | "Saved" · "Đã lưu" |
| Waiting | Informative | "Processing 3 of 12 documents" · "Đang xử lý 3/12 tài liệu" |
| Recoverable problem | Practical, solution first | "Couldn't load documents. Try again." · "Không tải được tài liệu. Hãy thử lại." |
| Blocking or risky decision | Serious, specific about the consequence | "Delete “Q3 policies”? Its 14 documents are deleted too." |
| Blocked by permission | Neutral, explains who can help | "Only collection owners can change access. Ask an owner." |
| System at fault | Take responsibility with **we / chúng tôi**, sparingly | "We couldn't reach the server. Try again in a moment." |

## 2. Canonical vocabulary (Vietnamese first)

BoMesh is built for Vietnamese organizations. **Vietnamese is the primary interface language**: terms are *chosen for Vietnamese users*, not translated from English; English is the second language and follows the Vietnamese meaning. This section is the **Bộ thuật ngữ chuẩn** (standard terminology) of the product, reviewed 2026-11-22 for release. Every screen, toast, tooltip, document and test uses exactly these words.

**One concept, one word, in each language.** A screen never invents a synonym, and no two concepts share a Vietnamese word. Vendor names (BoMesh, Google Drive, Confluence, HeroUI), file types, keys, codes and people's names are never translated.

### 2.0 How Vietnamese terms are chosen

1. **Words Vietnamese office workers already use** for the job: *kho tài liệu, tra cứu, duyệt, công bố, phân quyền, nhật ký hoạt động*.
2. **No word whose everyday meaning misleads.** Retired for that reason: *kiểm duyệt* (censorship), *xuất bản* (publishing books), *bộ sưu tập* (art or fashion collections), *hộp thư* (email), *biên tập viên* (newsroom editor), *duyệt tìm* (not Vietnamese usage).
3. **No collision.** *Nguồn* in an answer means the cited documents, so a connector is **Nguồn dữ liệu**; *Mọi người* is the People area's old name, so collection access is **Mọi thành viên**; *Công việc* is Work, so the personal sidebar group is **Cá nhân**.
4. **Short in navigation** (≤ 3 words, no "của bạn"), complete in sentences.
5. **Translate product areas people must understand**: Knowledge Studio is **Quản trị tài liệu**. Only vendor names stay in English.

Columns: **Tiếng Việt** is canonical; **English** is the English UI string; **Mới** marks a term changed by this review (the previous Vietnamese is in §2.7 and must be gone before release).

### 2.1 Places (navigation, page and section names)

| Tiếng Việt | English | Is | Mới |
| --- | --- | --- | --- |
| Trang chủ | Home | Where everyone starts | |
| Tài liệu | Knowledge | Reading published documents: Tra cứu, Đã lưu, Tệp của tôi. Mid-sentence, the place is "mục Tài liệu" ("Mở trong mục Tài liệu") | Mới |
| Tra cứu | Browse | Knowledge's default view of published documents | Mới |
| Bản đồ tài liệu | Knowledge map | Map of kho tài liệu and thư mục (`/knowledge/map`) | Mới |
| Đã lưu | Saved | Your bookmarked documents | |
| Tệp của tôi | My files | Your personal uploads | |
| Trò chuyện mới | New chat | Where a conversation starts (`/chat`) | Mới |
| Gần đây | Recent | Sidebar list of your conversations | |
| Cá nhân | Your work | Sidebar group: Dự án · Cộng đồng · Tài liệu tôi đã gửi | Mới |
| Dự án | Projects | Your folders of related conversations | |
| Tài liệu tôi đã gửi | My contributions | What you sent for approval and where it stands | Mới |
| Công việc | Work | Assistant-made outputs (drafts, reviews, quizzes) | |
| Yêu cầu | Requests | Service requests to a space's staff | |
| Thông báo | Inbox | Notifications addressed to you | Mới |
| Quản trị | Manage | Sidebar group for administration | Mới |
| Tổng quan | Overview | Workspace health and what needs attention | |
| Quản trị tài liệu | Knowledge Studio | Curation area. Sections: **Tài liệu** (views Tất cả · Đang xử lý · Chờ duyệt) · **Kho tài liệu** · **Chủ đề** (views Chủ đề · Gợi ý) · **Nguồn dữ liệu** (views Nguồn dữ liệu · Lịch sử đồng bộ · Tài khoản kết nối) | Mới |
| Người dùng & phân quyền | People | Sections: Thành viên · Nhóm · Vai trò · Yêu cầu truy cập | Mới |
| Trợ lý | Assistant | Assistant settings (Manage) | |
| Nhật ký hoạt động | Activity | Who changed what (audit history) | Mới |
| Cài đặt | Settings | Configuration of a workspace, space or kho tài liệu | |
| Tùy chọn | Preferences | Your personal options (language, appearance) | |
| Bảng điều khiển nền tảng | Platform console | Operators' cross-workspace area | |

### 2.2 Objects

| Tiếng Việt | English | Definition | Distinguish from |
| --- | --- | --- | --- |
| Không gian làm việc | Workspace | A customer's or team's private instance (e.g. HCMUTE) | Never shortened to "không gian"; "không gian" appears only in this term |
| Cộng đồng | Space | A collaboration area inside a workspace (course, team, group) with its members, materials and conversations | Không gian (retired: read as a shortened "không gian làm việc"); Nhóm (= Groups); Phòng (= department names) |
| Kho tài liệu | Collection | Where documents live and who may read them (an access boundary) | Thư mục; never "bộ sưu tập" |
| Thư mục | Folder | A sub-container inside a kho tài liệu; may have its own access | Kho tài liệu |
| Tài liệu | Document | One item of knowledge (a file or page) | Tệp = the file itself ("Thay tệp", "Tải tệp lên") |
| Nguồn dữ liệu | Source | A connection that keeps a kho tài liệu in sync (Drive folder, Confluence space) | **Nguồn** (citations in answers); Tài khoản kết nối |
| Tài khoản kết nối | Account (connected) | The credentials a nguồn dữ liệu uses ("Kết nối tài khoản") | Tài khoản (your sign-in) |
| Trình kết nối | Connector | An app type BoMesh can connect to (platform console) | Nguồn dữ liệu |
| Chủ đề / Lĩnh vực | Topic / Domain | Classification: a lĩnh vực groups chủ đề | Thẻ, danh mục, phân loại (as names) |
| Tài liệu đã gửi | Contribution | A document sent for approval (contributor's view) | — |
| Tài liệu chờ duyệt | Submission | The same item in the approver's queue | "bài gửi" |
| Cuộc trò chuyện | Conversation | One chat with the assistant | Luồng, phiên |
| Câu trả lời | Answer | The assistant's reply, with citations | Phản hồi |
| Nguồn / Trích dẫn | Sources / Citation | Documents an answer cites / one cited passage | Nguồn dữ liệu |
| Dự án | Project | Your folder of related conversations | — |
| Công việc | Work item | One output in Công việc | Tác vụ (platform jobs only) |
| Yêu cầu / Yêu cầu truy cập | Request / Access request | A service request / a request to read a kho tài liệu | Phiếu |
| Thành viên | Member | A person in a workspace or space | Người dùng (platform accounts) |
| Nhóm | Group | A named set of thành viên | — |
| Vai trò | Role | A named bundle of quyền | Quyền |
| Quyền | Permission | One capability inside a vai trò | Quyền truy cập |
| Quyền truy cập | Access | Who can open something | Quyền |
| Người dùng | User | An account across workspaces (platform console only) | Thành viên |
| Tài khoản | Account | Your sign-in identity | Tài khoản kết nối |
| Liên kết mời | Invite link | A link that lets anyone join | Thêm người (existing accounts) |

### 2.3 Actions — the verb decides the consequence

Pick the verb by what happens to the object, then keep it in the button, menu, confirmation, toast and Undo.

| Tiếng Việt | English | Use when | Reversible | Feedback ([feedback §5](feedback-design-system.md#5-destructive-actions-undo-and-confirmation)) | Mới |
| --- | --- | --- | --- | --- | --- |
| Lưu | Save | Persist edits; bookmark a document (Lưu ↔ Đã lưu) | — | Inline state | |
| Bỏ lưu | Remove from saved | Un-bookmark | Yes | State change | Mới |
| Gỡ | Remove | **Detach**; nothing is destroyed (gỡ khỏi cộng đồng, gỡ bộ lọc, gỡ thư mục → nội dung chuyển lên, gỡ thành viên) | Yes | Undo toast; gỡ thành viên khỏi không gian làm việc confirms first | Mới (was "Xóa khỏi không gian làm việc") |
| Rút lại | Withdraw | Take back **your own** gửi duyệt or yêu cầu | Yes | Undo toast | |
| Lưu trữ | Archive | Hide from Tra cứu, search and answers; keep everything | Yes | Undo toast | |
| Ngừng công bố | Unpublish | Readers can no longer open it; it stays in Quản trị tài liệu | Yes | Undo toast | Mới |
| Xóa | Delete | Move to deleted; restorable for a period | Yes, for a period | Undo toast | |
| Xóa vĩnh viễn | Delete permanently | Cannot be restored | **No** | Confirmation | |
| Khôi phục | Restore | Bring back an archived, deleted or earlier version | Yes | Undo toast | |
| Tải lên | Upload | Transfer a file (to Tệp của tôi, or as a replacement) | — | Progress → result | |
| Gửi tài liệu | Contribute | Send a document for approval (entry action) | Rút lại | Toast with Mở | Mới |
| Gửi duyệt | Submit for review | The confirm button that sends it | — | — | Mới |
| Thêm tài liệu | Add documents | An **editor** adds documents directly (no approval) | Xóa | Progress → result | |
| Xử lý / Xử lý lại / Xử lý bản cập nhật | Process / Process again / Process the update | Explicit processing (read, classify, make searchable) | Dừng | Persistent progress | |
| Dừng | Stop | Stop processing; finished work stays | — | State change | |
| Đồng bộ ngay | Sync now | Fetch changes from a nguồn dữ liệu now | — | Persistent progress | |
| Công bố / Công bố lại | Publish / Publish again | Make readable to the kho's readers / after Ngừng công bố | Ngừng công bố | Toast | Mới |
| Duyệt và công bố · Yêu cầu chỉnh sửa · Từ chối | Approve & publish · Request changes · Decline | Decisions on tài liệu chờ duyệt | Undo window | Undo toast | Mới |
| Phê duyệt · Từ chối | Approve · Decline | Decisions on yêu cầu and yêu cầu truy cập | Undo window | Undo toast | |
| Chia sẻ / Ngừng chia sẻ | Share / Stop sharing | Give people access to a conversation, document or kho link | Yes | Toast | |
| Thêm người | Add people | Add existing accounts | Gỡ | Toast | |
| Mời | Invite | Send an invite link or email | Thu hồi | Toast | |
| Tham gia / Rời khỏi | Join / Leave | Become / stop being a member of a cộng đồng | Yes | State change | |
| Tạm ngưng / Kích hoạt lại | Suspend / Reactivate | Block / restore sign-in | Yes | Undo toast | |
| Hỏi AI | Ask AI | Start a cited answer from search, a selection or several documents | — | Navigation | |
| Hỏi | Ask | Ask about the open document (Reader) | — | — | |
| Cập nhật câu trả lời | Update answer | Re-ask a question whose nguồn changed | Câu trả lời trước | State change | |
| Thử lại | Try again / Retry | Recover from a failure / regenerate an answer | — | Replaces the error | |
| Hỏi lại | Ask again | Answer a question that wasn't answered | — | — | Mới (was "Answer it now", untranslated) |
| Đọc lại | Read again | Re-check a paper in an evidence review | — | — | |
| Hoàn tác | Undo | Reverse the last action from its toast | — | Silent restore | |
| Mở | Open | Go to the result (toast and notification actions) | — | Navigation | |
| Sao chép liên kết | Copy link | Put a link on the clipboard | — | Icon → "Đã sao chép" | |
| Tạo … | New X / Create X | Buttons that start creating say **Tạo + object** ("Tạo kho tài liệu"); the dialog confirm says **Tạo** | — | — | |

Rules:
- **Xóa never means Gỡ.** If the object survives elsewhere: Gỡ. If it is gone: Xóa. "Xóa" is reserved for Delete and for clearing all input ("Xóa bộ lọc", "Xóa tất cả").
- **Từ chối is the only negative decision** (EN *Decline*; *Deny/Denied* are retired).
- **Duyệt vs Phê duyệt**: documents are *duyệt* (approval to publish); yêu cầu are *phê duyệt* (formal administrative approval).
- **Gửi tài liệu vs Tải lên vs Thêm tài liệu** are three different promises (needs approval · personal · published directly by an editor); their buttons have different icons.
- **Navigation from feedback** always says **Mở** (never Xem, Theo dõi).

### 2.4 States

Status chips, filters and descriptions use exactly these labels, in the preview and web.

| Group | Tiếng Việt | English | Notes |
| --- | --- | --- | --- |
| Publication | Chờ duyệt · Cần chỉnh sửa · Đã công bố · Đã ngừng công bố · Đã từ chối | In review · Changes requested · Published · Unpublished · Declined | All **Mới** except Đã từ chối. Transition: **Đang công bố** (Publishing) |
| Processing | Chưa xử lý · Đang chờ · Đang xử lý · Đã xử lý · Không xử lý được · Nguồn đã thay đổi · Không hỗ trợ | Not processed · Waiting · Processing · Processed · Processing failed · Changed at the source · Not supported | **Mới**: Không xử lý được, Nguồn đã thay đổi |
| Searchable | Tra cứu được | Searchable | **Mới**. Only when Đã công bố **and** Đã xử lý |
| Verification | Đã xác minh · Chưa xác minh · Cần xác minh lại | Verified · Not verified · Re-verification due | **Mới**: Cần xác minh lại; Tra cứu facet **Xác minh** (EN "Verification", was "Trust") |
| Tệp của tôi | Đã tải lên, chưa tra cứu được | Uploaded, not searchable | **Mới** (was "Đã lưu trữ…", which means Archived) |
| Tài liệu đã gửi | Đã gửi · Đang xử lý · Chờ duyệt · Cần chỉnh sửa · Đã duyệt · Đã công bố · Đã từ chối · Đã rút lại | Submitted · Processing · In review · Changes requested · Approved · Published · Declined · Withdrawn | **Mới**: Đang xử lý (was "Đang phân tích"), Đã duyệt |
| Topic source | Trợ lý · Gợi ý · Do người chọn | Assistant · Suggested · Set by a person | Never a confidence percentage |
| Yêu cầu | Đang mở · Đang chờ bạn · Đã phê duyệt · Đã từ chối · Đã đóng · Đã rút lại | Open · Waiting for you · Approved · Declined · Closed · Withdrawn | "Đang mở" (state) vs "Mở" (verb) need separate keys: done by the catalog (localization §3) |
| Câu trả lời | {tài liệu} đã thay đổi sau câu trả lời này · Đã cập nhật theo phiên bản mới nhất của {tài liệu} | {document} changed after this answer · Updated from the latest version of {document} | Living answers |

### 2.5 Roles and access

| Tiếng Việt | English | Can |
| --- | --- | --- |
| Người xem | Viewer | Tra cứu and read |
| Người chỉnh sửa | Editor | Also add documents and edit details (**Mới**, was "Biên tập viên") |
| Chủ sở hữu | Owner | Also duyệt, manage access and settings |
| Quản trị viên | Workspace admin | Everything in the workspace |
| Người quản lý cộng đồng | Space manager | Manage a cộng đồng (**Mới**: replaces "lead/leads") |
| Mọi thành viên · Hạn chế · Riêng tư | All members · Restricted · Private | Kho access: every member of the workspace (including people who joined a public workspace) / only the people and groups you add / only its owners (**Mới**: *All members* replaces *Everyone* so it can't be read as "anyone") |
| Không gian làm việc công khai | Public workspace | A workspace anyone with a BoMesh account may join by themselves; they become members |

### 2.6 The assistant, AI and background work

- The actor is **Trợ lý** ("Trợ lý đọc từng tệp và gợi ý chủ đề"). Never "AI", "mô hình", "mô hình thị giác", "bot" as the actor in workspace UI.
- **AI** appears only in fixed names: **Hỏi AI**, **Quy trình AI**.
- Members and editors never see infrastructure words: say *Đang chờ · Đang xử lý · bước Đọc tệp · Phân loại · Bổ sung ngữ cảnh · Cho phép tra cứu* — never *lập chỉ mục, embedding, chunk, worker, hàng đợi, tác vụ, pipeline, prompt*. Exceptions: the platform console (operators: *Lập chỉ mục, Tác vụ*) and the classification-rules view for admins ("Xem cách trợ lý phân loại").

### 2.7 Retired terms (must not appear at release)

| Retired (VI) | Use | Retired (VI) | Use |
| --- | --- | --- | --- |
| Bộ sưu tập | Kho tài liệu | Duyệt tìm | Tra cứu |
| Kiểm duyệt (for review) | Duyệt / Chờ duyệt / Người duyệt | Xuất bản, Hủy xuất bản, Đã xuất bản | Công bố, Ngừng công bố, Đã công bố |
| Knowledge Studio (in VI) | Quản trị tài liệu | Hộp thư | Thông báo |
| Biên tập viên | Người chỉnh sửa | Mọi người (for collection access) | Mọi thành viên |
| Mọi người (People area) | Người dùng & phân quyền | Đóng góp, Đóng góp của tôi (as actions/places) | Gửi tài liệu, Tài liệu tôi đã gửi |
| Bài gửi | Tài liệu chờ duyệt | Cuộc trò chuyện mới (nav) | Trò chuyện mới |
| Công việc của bạn | Cá nhân | Trò chuyện AI | Trò chuyện mới / Cuộc trò chuyện |
| Nguồn (for a connector) | Nguồn dữ liệu | Đã thay đổi tại nguồn | Nguồn đã thay đổi |
| Xử lý thất bại, "… thất bại" | Không xử lý được, "Không … được" | Có thể tìm kiếm | Tra cứu được |
| Đến hạn rà soát, Đến hạn xác minh lại, Độ tin cậy | Cần xác minh lại, Xác minh | Đang phân tích, Đã phân tích | Đang xử lý, Đã xử lý |
| Đã lưu trữ (for stored uploads) | Đã tải lên | Đã yêu cầu chỉnh sửa (state) | Cần chỉnh sửa |
| Hủy liên kết, Bỏ liên kết | Gỡ | Hoạt động (nav) | Nhật ký hoạt động |
| Quản lý (sidebar group) | Quản trị | Vui lòng (routine copy), Xin lỗi | Hãy, or a bare verb |
| Được … bởi …, Tải lên bởi … | Active voice: "Do {0} tải lên", "{0} đã chọn" | Prompt phân loại | Cách trợ lý phân loại |
| Không gian (for a Space) | Cộng đồng | Tri thức (any use: Knowledge, knowledge map, knowledge gap, Share as knowledge) | Tài liệu, Bản đồ tài liệu, Khoảng trống tài liệu, Chia sẻ vào kho tài liệu |

English retired terms (unchanged from the previous review): Knowledge base/KB → Collection · AI Chat → New chat · Curation → Knowledge Studio · Deny/Denied → Decline/Declined · Unlink → Remove · Analyzing → Processing · Review due/Trust → Re-verification due/Verification · Stored, not searchable → Uploaded, not searchable · Outdated → Changed at the source · Re-read → Read again · Answer it now → Ask again · Tenant/Organization → Workspace · Module → feature name · SLA → due date · "leads" → space managers.

Vietnamese style rules (address as *bạn*, *Hãy*, *Không … được*, *Đã …*, no "thất bại", no "bởi" passives, no "của bạn" in labels) are specified in [localization-standards.md §9](localization-standards.md#9-vietnamese-style).

### 2.8 Homographs: when one English word needs two meanings

The legacy translator keys by English text ([localization §2](localization-standards.md#2-how-strings-are-translated-today)), so one English string has one VI translation everywhere. When the same English word means two things, either **give the second meaning its own words in the catalog** (web `messages/*`; preview `inLang(en, vi)` where the label is defined) or **change the English** — never patch the dictionary for one screen.

| English | Shared dictionary (legacy) | Second meaning | Where it's resolved |
| --- | --- | --- | --- |
| Sources | Nguồn (citations under an answer) | Nguồn dữ liệu (Studio section, connectors) | Catalog `nav`/`studio`; preview `TAB_DEFS` |
| Review | Duyệt (action) | Chờ duyệt (Documents view) | Catalog `studio`; preview `VIEWS` |
| Manage | Quản trị (sidebar group, menu headers) | — one meaning in Vietnamese | Catalog `nav` for the group |
| Approved / Approve | Đã phê duyệt / Phê duyệt (requests) | Đã duyệt (document decision) | Catalog `state` |
| Open | Mở (verb) | Đang mở (state of a request) | Catalog `state` |
| Open source | Mở bản gốc (document action) | Mở nguồn dữ liệu (connector) | Change the connector English to "Open data source" |
| Joined | Ngày tham gia (column) | Đã tham gia (event) | Change the column English to "Join date" |
| Clear | Xóa | Xóa bộ lọc / Bỏ chọn | Change the English to "Clear filters" / "Clear selection" |
| Indexing | Lập chỉ mục (platform page) | Đang lập chỉ mục (processing phase) | Catalog `state` |
| Lead | Trưởng nhóm | Người quản lý cộng đồng (space role) | Change the role English to "Space manager" (§2.5) |

### 2.9 UI words versus contract names

UI vocabulary follows the domain in `backend/docs_design` but is not bound to field names. `itemKind = COLLECTION` is a Collection, `indexingState = OUTDATED` is "Changed at the source", `IngestionRun` is "processing", `Tenant` is a Workspace. Renaming a UI word never requires an API or schema change; renaming a domain concept requires a design decision in `backend/docs_design` first.

### 2.10 Feature vocabulary

Feature-level names, moved here from DESIGN_SYSTEM.md (this file is now their only home). Tables above win where they overlap.

| Concept | Words |
| --- | --- |
| Containers | **Collection** (where documents live and who may read them; Studio section **Collections**, action **New collection**). Never "knowledge base" |
| Creating | Header and menu buttons that create say **New X** (New collection, New group, New role, New request, New project); the dialog's confirm says **Create …** |
| Find vs answer | **Search documents** (→ Browse with `q`) · **Ask AI** (cited answer). Ask AI ranks first only for question-like text (`isQuestion`) |
| Ask about one document | **Ask about this document** → Reader with the Ask panel (`/doc/:id?ask=1`); the Reader's own button is **Ask** |
| Ask about several | **Ask about these** · **Ask AI** → new conversation |
| Chat | Place **New chat** (`/chat`: the composer; the sidebar row is named for what it does); list **Recent** (the sidebar's conversations; never "All conversations" or a Recent page); object **Conversation**; menu **Delete conversation**; action **Update answer** (an answer whose sources changed) |
| Personal work | Sidebar group **Your work**: **Projects** · **Spaces** · **My contributions** (what you submitted; never a Knowledge section); conversations are the sidebar's **Recent** group |
| Personal sections | Knowledge sub-rows **Saved** · **My files** (never "My library" as a place) |
| Adding knowledge | **Contribute** (shared, goes to review) · **Upload** (My files only) · **Add documents** (a collection editor, published directly) |
| Adding sources | **Add source** everywhere (Studio Sources, empty states "No sources yet", a collection's Sources, ⌘K, setup step **Add sources**); **Connect account** only for accounts; an account's ⋯ **Add source with this account** |
| Review | **Approve & publish** (key A) · **Request changes** (key R) · **Decline**; state **Declined**; **Use my change to improve classification** (the teach checkbox) |
| Curation place | **Knowledge Studio** (Manage › Knowledge Studio; the place is never called "Curation"). Sections (sidebar sub-rows), named after their resources: **Documents** (`?tab=documents`, views **All** · **Processing** · **Review**; All's **Quality** filter: **Re-verification due** · **Missing details** · **Possible duplicates**) · **Collections** · **Topics** (`?tab=topics`, views **Topics** · **Suggestions**) · **Sources** (views **Sources** · **Sync history** · **Accounts**). Overview's summary is **Knowledge health**: **Processing** · **Review** · **Topic suggestions** · **Quality** · **Verified** |
| Two states | See §2.4. Verbs **Process** · **Process again** · **Process the update**; **Stop**; option **Read text in images**. Drawer steps **Received** · **Processed** · **Reviewed** · **Published** · **Searchable** |
| Publishing policy | **Publish automatically** · **Review only what's uncertain** · **Review everything** (never "Send to review first") |
| Scale | **First sync** (a source's initial backfill); **Held back by a sync** (a batch: files held for one reason in a first sync, decided together); **Topics to confirm** (a first sync's published files with the topics the assistant applied, or without one); **Select all matching** (a selection past the page that is a filter, so it carries no number, e.g. every Not processed document) |
| Classification target | **Topics** = the place (Topics → All) for the workspace's **topics** (domain → topic) with **keywords**, **synonyms**, **rules**, **examples** and **guidance**, named by their **names** (topic IDs are internal: never shown, never typed, never called "code"); one concept, never a second "category" list and never "master data" or "Taxonomy" as a place. The card that shows matches is **Classification**; what the contributor checked is **Confirmed by the contributor**; a topic's source reads **Assistant** · **Suggested** · **Set by a person** (never a confidence %) |
| Learning | **Correction** (a reviewer's topic change, recorded by the teach checkbox; summarised in Topics → Suggestions as **Keywords from reviewers' corrections**) · **Show the classification prompt**. There is no auto-tag threshold: the assistant picks topics directly |
| Topics in and out | **Import** (Add and update · Replace, then *Check the changes*) · **Export** |
| Changed at the source | **Process the update** (documents Changed at the source, in Documents → Processing) · **Replace file** (uploads only) |
| Collection access | **All members** (every member can find it and ask about it, including anyone who joins a public workspace) · **Restricted** (only the people and groups you add, plus space members) · **Private** (only its owners) |
| Roles | **Viewer** (search and read) · **Editor** (also add documents and edit details) · **Owner** (also review submissions, manage access and settings) |
| Requests | Service requests: **Requests** (`/requests`), status from `X.requestStatus`; queue segments **Open / Closed**. Access to a collection: **Access requests** (People's section and a collection's section; links **Open access requests**) |
| Work kind | **Evidence review** |
| Admin area | **People** |
| Appearance | **Mode** (Light · Dark · System) · **Theme** (named looks) |

Other fixed VI terms not listed above: Trích dẫn (Citation) · Gợi ý (Suggestions) · Sự cố (Issues) · Chất lượng (Quality) · Giao diện (Appearance) · Ngôn ngữ (Language) · Hoàn tác (Undo).

## 3. Writing mechanics

| Rule | EN | VI |
| --- | --- | --- |
| Capitalization | **Sentence case** for everything: titles, buttons, tabs, menus, chips. Proper nouns only (Knowledge Studio, Google Drive) | Capitalize only the first word ("Chọn tất cả", never "Chọn Tất Cả") |
| Periods | No period on titles, buttons, labels, chips, tabs, menu items or single-phrase toasts. Use periods on full sentences (descriptions, helper text, multi-sentence toasts) — every sentence, including the last | Same |
| Questions | Confirmation titles are questions ("Delete “Q3 policies”?") | Same |
| Exclamation marks | Never | Never |
| Contractions | Use them (can't, couldn't, isn't, you'll) | — |
| Quotation marks | Curly “ ” around names of things people created; ’ for apostrophes — never ASCII `"` `'` in UI text | “ ” — closing quote before the period: “Q3”. |
| Ellipsis | Single character **…**: on a menu item or button that opens a dialog needing more input ("Move…", "Rename…"), and in progress text ("Saving…"). Never `...` | Same |
| Separators | " · " joins independent metadata ("PDF · 2 MB · Updated yesterday"); never inside a sentence | Same; each segment must translate alone ([localization §4](localization-standards.md#4-writing-translatable-strings)) |
| Numbers | Digits always ("3 documents"); format through the locale formatter | `1.234` / `1,5 MB` via formatter |
| Lists | Serial comma in EN prose ("Read, classify and index" — omit only when it reads naturally); prefer short lists | No comma before "và" / "hoặc" |
| Directional words | Never "above", "below", "on the left" | Same |
| Links | Say where they go ("About collection access"); at most one "Learn more" per screen | Same |
| Person | Address **you**; use **we** only when the system is at fault | **bạn**; **chúng tôi** only when the system is at fault |
| Please / sorry | Never in routine copy | Prefer **Hãy** or a bare verb; **Vui lòng** only for formal requests (sign-in, policy); **Xin lỗi** only for outages |

## 4. Copy patterns by component

Patterns name the shape; the [feedback design system](feedback-design-system.md) decides whether the message is shown at all and where.

### 4.1 Page titles and descriptions
- Title = the place or object name from §2.1, noun phrase, no verb, no period ("Documents", "Access requests").
- Entity pages use the entity's own name.
- A description is optional; when present it is **one sentence** that says what the page is for, ends with a period, and never repeats the title ("Select what to process: the assistant reads, classifies and indexes it." → "Choose what to process. The assistant reads each document and makes it searchable.").

### 4.2 Tabs and segmented controls
- 1–2 words, nouns, sentence case: "All · Processing · Review". Counts go in a badge, not the label text.

### 4.3 Buttons and menu items
- **Verb first**, verb + object when the verb alone is ambiguous: "Archive collection", "Add source". Common verbs stand alone: Save, Cancel, Close, Done, Open.
- The confirm button **repeats the title's verb** ("Delete collection" for "Delete “Policies”?"). Never Yes/No/OK/Confirm.
- **Cancel** abandons and discards; **Close** leaves without changing anything (error dialogs, read-only drawers). **Done** ends a flow that already saved.
- Wizards: **Next** / **Back**; the last step names the outcome ("Connect", "Create workspace").
- ⋯ menu items follow the same verbs; destructive items last, after a separator (DESIGN_SYSTEM rule 3).
- Counts in buttons: "Process 12 documents" (via `plural()`), not "Process (12)".

### 4.4 Tooltips
- Icon-only buttons: the tooltip is the action's name, identical to its `aria-label` ("Knowledge map", "Remove filter"). Add a shortcut hint in the tooltip only ("Search (⌘K)").
- Disabled controls (permission-blocked only, DESIGN_SYSTEM rule 6): say why and who can help — "Only collection owners can change access".
- Never repeat a visible label in a tooltip.

### 4.5 Search placeholders and filters
- Placeholder = what you can search, ending with "…": "Search documents…", "Search members…". The global ⌘K field is **"Search or ask…"** in both the sidebar and the palette (**Change**: today "Search anything…" vs "Search, ask or go to…").
- Filter labels are nouns (Topic, Type, Owner, Source, Collection, Verification, Updated, Language). Removable chip: "Topic: Admissions"; its remove button's name is "Remove filter: Topic: Admissions".
- No-results: "No results for “{query}”" + one next step ("Try another word, or clear filters.").

### 4.6 Form labels, helper text and validation
- Labels are nouns, sentence case, no colon ("Display name"). Mark the exception, not the rule: "(optional)".
- Helper text explains a consequence or format in one sentence, ending with a period.
- Validation says **how to fix**, never "Invalid" or "Required": "Enter a title.", "Enter an email like name@company.com.", "Use 40 characters or fewer." It appears inline under the field, clears as the person types (DESIGN_SYSTEM rule 10).
- Server field violations (`google.rpc.BadRequest.fieldViolations`) map to the same inline pattern.

### 4.7 Empty states
Title states the situation; body gives the reason or value in one sentence; one action.

| Case | Title | Body | Action |
| --- | --- | --- | --- |
| First use (blank slate) | "No sources yet" | "Connect a Drive folder or Confluence space to keep this collection in sync." | Add source |
| Filtered to nothing | "No matching documents" | "Try another word, or clear filters." | Clear filters |
| Cleared by the person | "Your queue is clear" | — | — |
| Not available to you | see §4.13 | | |

Never "No data", "Nothing here", "Empty".

### 4.8 Loading and progress text
- In-progress verbs end with "…": "Saving…", "Uploading 3 files…", "Processing 12 documents…".
- Determinate progress states the unit: "3 of 12 processed", "41%". No period.
- Never "Please wait", "Loading data…", "Don't close this window" (say what continues instead: "You can leave this page. Processing continues.").

### 4.9 Success messages
- **Past-tense verb + object**, ≤ 6 words, no period, no "successfully", no "!": "Collection archived", "Moved 12 documents to Policies", "Copied".
- Name the object when the toast is not next to it: "Archived “Q3 policies”".
- VI: **"Đã" + verb + object**: "Đã lưu trữ kho tài liệu", "Đã chuyển 12 tài liệu vào Quy chế".
- Offer **Open** when the result is elsewhere; offer **Undo** when reversible ([feedback §5](feedback-design-system.md#5-destructive-actions-undo-and-confirmation)).

### 4.10 Error messages
Shape: **what happened** + **what to do** (+ fallback). One or two sentences. Never technical detail, raw server text, internal IDs, status codes in the sentence, or blame.

| Situation | EN | VI |
| --- | --- | --- |
| Couldn't load | "Documents didn't load. Try again." | "Không tải được tài liệu. Hãy thử lại." |
| Couldn't save | "Couldn't save your changes. Try again." | "Không lưu được thay đổi. Hãy thử lại." |
| Known cause | "This file is password-protected. Remove the password, then upload it again." | "Tệp này có mật khẩu. Hãy gỡ mật khẩu rồi tải lên lại." |
| Offline / unreachable | "We couldn't reach BoMesh. Check your connection and try again." | "Không kết nối được BoMesh. Hãy kiểm tra kết nối rồi thử lại." |
| Unknown | "Something went wrong. Try again." | "Đã xảy ra lỗi. Hãy thử lại." |
| Conflict (etag) | "Someone else changed this. Reload to see their changes." | "Người khác đã thay đổi mục này. Hãy tải lại để xem thay đổi." |
| Assistant failed | "The assistant couldn't answer. Try again." | "Trợ lý không trả lời được. Hãy thử lại." |

Error **titles** (error states, section messages) are 2–5 words, no period: "Documents didn't load".

### 4.11 Warnings
Before an action, about a consequence the person may not expect: "Archiving hides 14 documents from answers for everyone." Never alarmist words ("Warning!", "Danger").

### 4.12 Confirmation dialogs
- Title: **verb + specific object + "?"** — "Delete “Q3 policies”?", "Remove Lan from this workspace?". Never "Are you sure?".
- Body: the consequence and whether it can be undone, one or two sentences: "Its 14 documents are deleted too. You can't undo this."
- Buttons: the title's verb ("Delete collection") and **Cancel**. Initial focus on Cancel for irreversible actions.
- Typed confirmation (workspace archive only): "Type {name} to confirm." (localized pattern).

### 4.13 Permission and access messages
Say what the person can't do, why (in plain terms) and who can help. Never reveal the existence of something the person can't read (the API answers unreadable like absent, `api_design.md` rule 5).

| Case | EN | VI |
| --- | --- | --- |
| Not allowed to act | "Only workspace admins can change roles." | "Chỉ quản trị viên không gian làm việc mới thay đổi được vai trò." |
| Can't open (page) | Title "You don't have access" · body "Ask an owner of this collection for access." · action Request access | "Bạn không có quyền truy cập" · "Hãy xin quyền từ chủ sở hữu kho tài liệu này." · Yêu cầu quyền truy cập |
| Not found or unreadable | Title "This page isn't available" · body "It may have been moved, or you may not have access." · action Go home | "Trang này không khả dụng" · "Trang có thể đã được chuyển, hoặc bạn không có quyền truy cập." · Về trang chủ |
| Feature off | "Spaces is turned off in this workspace. Ask a workspace admin." | "Cộng đồng đang tắt trong không gian làm việc này. Hãy hỏi quản trị viên." |

### 4.14 Notifications (Inbox)
- Title = who did what to which object, past tense, ≤ 10 words: "Lan approved “Q3 policies”". Body optional, one sentence with the next step. The notification's action is **Open**.
- Notification text is localized on the client from its type and parameters ([localization §7](localization-standards.md#7-server-originated-text)).

### 4.15 Activity history
Events read as **past-tense sentence, actor first**: "Lan Vo archived Policies". The actor is a person, "The assistant", or "A source sync"; never a service name.

### 4.16 Assistant copy
- Suggested questions and prompts are content: they keep the language they were written in.
- Citations, "Sources", "Searched your knowledge" are product chrome and are localized.
- Living answers: "{document} changed after this answer" · "Update answer" · "Updated from the latest version of {document}" · "Previous answer" / "Latest answer".

## 5. Do and Don't (from the current product)

| Don't (observed) | Do | Why |
| --- | --- | --- |
| "Give it a title." as a danger toast (`WorkItemPage.tsx:198`) | Inline under the field: "Enter a title." | Validation belongs at the field (§4.6) |
| "Remove" on a contribution's withdraw action (`ContributionDrawer.tsx:199`) | "Withdraw submission" | Withdraw ≠ Remove (§2.3) |
| "Xóa khỏi không gian làm việc" for *Remove from workspace* | "Gỡ khỏi không gian làm việc" | Remove ≠ Delete in VI (§2.3) |
| "Stored, not searchable" → "Đã lưu trữ…" | "Uploaded, not searchable" → "Đã tải lên, chưa tìm kiếm được" | "Lưu trữ" means Archive |
| "In line: it starts as soon as the worker has a free slot" | "Waiting: it starts when processing is free" | No infrastructure words (§2.6) |
| "The vision model reads every picture…" | "The assistant reads the text in every picture…" | The assistant is the actor (§2.5) |
| `${n} submissions ${n === 1 ? "is" : "are"} waiting… Process ${n === 1 ? "it" : "them"}` | Two whole sentences chosen by count | Slash/ternary grammar can't be translated |
| "Asked Lan for information. The SLA clock pauses until they reply" | "Asked Lan for more information. The due date pauses until they reply." | No jargon; every sentence ends with a period |
| `user:{id} is not an active workspace member.` shown in an error state | "This person isn't an active member of this workspace." | No internal IDs; mapped by reason |
| "Google did not return a sign-in credential. Please try again." | "Google didn't confirm the sign-in. Try again, or use another account." | No jargon, no "please" |
| "Settings saved" toast on a form with a save bar | The save bar shows "Saved" | One feedback channel per action |
| Confidence "87%" badge on topics | "Assistant" / "Suggested" / "Set by a person" | Glossary forbids false precision |

## 6. Changing the vocabulary

1. Propose the term with its EN and VI, the concept it names, and what it replaces — in this file, in the same change that updates `apps/ux_preview` (AGENTS.md: preview first).
2. Check it does not collide with an existing VI term (§2.2 *Everyone* is the cautionary example).
3. Add retired terms to §2.7 so reviews can grep for them.
4. A domain-concept rename (not just wording) needs a `backend/docs_design` decision first.
