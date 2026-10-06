# BoMesh app — luồng màn hình đầy đủ

Ảnh chụp từng màn hình khi chạy toàn bộ luồng của ứng dụng Flutter `app/` (bản web, khung điện thoại 390×844), theo đúng thứ tự thao tác.

- Ngày chụp: 2026-10-05
- Build: `flutter build web --release --dart-define-from-file=env/local.json` (API `http://localhost:8000`), phục vụ tại `http://127.0.0.1:5174`
- Tài khoản: `admin1@gamil.com` (seed `backend/script/seed_account.py`) — Workspace Administrator của "BoMesh Local", có quyền platform chỉ đọc
- Dữ liệu là dữ liệu thật trong workspace local; câu trả lời của trợ lý là câu trả lời thật từ backend

Thay đổi dữ liệu trong lúc chụp: tải lên `bomesh-demo-upload.txt` vào My files (sau đó đã xoá), tạo một chat mới, đổi tên + ghim chat đó. Các thao tác huỷ được (suspend member, start run, lưu tên workspace, thêm người vào share, tạo group/collection) chỉ mở form rồi huỷ, không lưu.

## Vấn đề quan sát được

- **035**: ngay sau khi upload, chạm vào dòng mới ở đầu "My files" lại mở tài liệu từng đứng đầu trước đó (`Don_dang_ky_chuyen_diem.docx`); chuyển tab My files ↔ Workspace thì hết. Ngoài ra `GET /api/v1/documents/29e276ec-…` trả 404 dù danh sách `GET /documents` vẫn trả tài liệu đó → màn hình "This document isn’t available to you".
- **085**: System health báo "Down" vì health check `openai_chat` không khoẻ lúc chụp (`/health`), dù các câu hỏi trong luồng Ask vẫn được trả lời.
- Không chụp được luồng "Switch workspace": tài khoản chỉ thuộc một workspace nên account sheet không hiện mục chuyển workspace.
- Không có màn hình của persona Member (không có mật khẩu của tài khoản member); mọi màn hình là góc nhìn admin.

## 1. Đăng nhập / Tạo tài khoản

| # | Màn hình | Thao tác / nội dung |
| --- | --- | --- |
| 001 | <img src="001-auth-sign-in.png" width="200"> | Sign in screen<br>`001-auth-sign-in.png` |
| 002 | <img src="002-auth-sign-in-empty-validation.png" width="200"> | Sign in with empty fields → inline validation<br>`002-auth-sign-in-empty-validation.png` |
| 003 | <img src="003-auth-sign-in-wrong-password.png" width="200"> | Wrong password → form-level error, email kept<br>`003-auth-sign-in-wrong-password.png` |
| 004 | <img src="004-auth-create-account.png" width="200"> | Create an account form<br>`004-auth-create-account.png` |
| 005 | <img src="005-auth-create-account-validation.png" width="200"> | Create account with an email that already exists → server error shown inline<br>`005-auth-create-account-validation.png` |

## 2. Ask — trợ lý hỏi đáp

| # | Màn hình | Thao tác / nội dung |
| --- | --- | --- |
| 006 | <img src="006-ask-thread-answer-with-citations.png" width="200"> | After sign-in: last conversation reopens — answer with inline citations and source chips<br>`006-ask-thread-answer-with-citations.png` |
| 007 | <img src="007-ask-citation-source-passage.png" width="200"> | Tap a source chip → cited source passage<br>`007-ask-citation-source-passage.png` |
| 008 | <img src="008-ask-citation-open-document.png" width="200"> | Open document from a citation → document viewer focused on the cited passage<br>`008-ask-citation-open-document.png` |
| 009 | <img src="009-document-more-menu.png" width="200"> | Document “···” menu<br>`009-document-more-menu.png` |
| 010 | <img src="010-ask-thread-question-top.png" width="200"> | Top of the conversation: question, work line and the start of the answer<br>`010-ask-thread-question-top.png` |
| 011 | <img src="011-ask-work-line-reasoning-sheet.png" width="200"> | Tap a work line (“Thought it through”) → “How it got there” reasoning sheet<br>`011-ask-work-line-reasoning-sheet.png` |
| 012 | <img src="012-ask-home-new-chat.png" width="200"> | Ask home (New chat): greeting, starters and composer<br>`012-ask-home-new-chat.png` |
| 013 | <img src="013-ask-composer-plus-menu.png" width="200"> | Composer “+” → add a file, pick from Library, or limit the search<br>`013-ask-composer-plus-menu.png` |
| 014 | <img src="014-ask-limit-to-collections.png" width="200"> | Limit to a collection → collection picker<br>`014-ask-limit-to-collections.png` |
| 015 | <img src="015-ask-limit-selected.png" width="200"> | Collection selected in the scope picker<br>`015-ask-limit-selected.png` |
| 016 | <img src="016-ask-choose-from-library.png" width="200"> | Choose from Library → pick existing documents to ask about<br>`016-ask-choose-from-library.png` |
| 017 | <img src="017-ask-composer-scope-and-attachment.png" width="200"> | Composer ready: scope chip (UTE Knowledge) + referenced Library file<br>`017-ask-composer-scope-and-attachment.png` |
| 018 | <img src="018-ask-composer-typed.png" width="200"> | Question typed, Send enabled<br>`018-ask-composer-typed.png` |
| 019 | <img src="019-ask-streaming.png" width="200"> | Answer streaming: work lines appear while the assistant searches<br>`019-ask-streaming.png` |
| 020 | <img src="020-ask-answer-complete.png" width="200"> | Finished answer (bottom): citations, source chips, Copy / Regenerate<br>`020-ask-answer-complete.png` |
| 021 | <img src="021-ask-answer-body.png" width="200"> | Answer body with inline citation markers<br>`021-ask-answer-body.png` |
| 022 | <img src="022-ask-answer-copied.png" width="200"> | Copy answer → confirmation<br>`022-ask-answer-copied.png` |
| 023 | <img src="023-ask-history.png" width="200"> | History: search, pinned and chats grouped by day<br>`023-ask-history.png` |
| 024 | <img src="024-ask-history-chat-actions.png" width="200"> | History row “···” → Rename / Pin / Delete<br>`024-ask-history-chat-actions.png` |
| 025 | <img src="025-ask-history-pinned.png" width="200"> | Chat pinned → appears in the Pinned group<br>`025-ask-history-pinned.png` |
| 026 | <img src="026-ask-history-rename.png" width="200"> | Rename chat prompt<br>`026-ask-history-rename.png` |
| 027 | <img src="027-ask-history-search.png" width="200"> | Search chats by title<br>`027-ask-history-search.png` |
| 028 | <img src="028-ask-history-renamed.png" width="200"> | Renamed and pinned chat in History<br>`028-ask-history-renamed.png` |
| 029 | <img src="029-ask-history-delete-confirm.png" width="200"> | Delete chat → confirmation (cancelled)<br>`029-ask-history-delete-confirm.png` |

## 3. Library — tài liệu và collection

| # | Màn hình | Thao tác / nội dung |
| --- | --- | --- |
| 030 | <img src="030-library-my-files.png" width="200"> | Library → My files: search, file rows with type/size/status, Upload<br>`030-library-my-files.png` |
| 031 | <img src="031-library-search.png" width="200"> | Search within My files<br>`031-library-search.png` |
| 032 | <img src="032-library-upload-sheet.png" width="200"> | Upload sheet: choose destination, “Make searchable right away”, pick files<br>`032-library-upload-sheet.png` |
| 033 | <img src="033-library-upload-destination.png" width="200"> | Upload → choose where the file goes<br>`033-library-upload-destination.png` |
| 034 | <img src="034-library-uploaded.png" width="200"> | Uploaded file appears at the top of My files (upload sheet had “Make searchable right away” on)<br>`034-library-uploaded.png` |
| 035 | <img src="035-library-document-preview.png" width="200"> | Observed issue: right after the upload, tapping the new top row opened the previous first row (Don_dang_ky_chuyen_diem.docx); GET /documents/{id} returns 404 for it although the list returns it → “This document isn’t available to you”<br>`035-library-document-preview.png` |
| 036 | <img src="036-library-uploaded-ready.png" width="200"> | After processing: the uploaded file no longer shows “Not searchable yet”<br>`036-library-uploaded-ready.png` |
| 037 | <img src="037-library-document-preview.png" width="200"> | Open the uploaded file → text preview with one action, “Ask about this document”<br>`037-library-document-preview.png` |
| 038 | <img src="038-library-ask-about-document.png" width="200"> | “Ask about this document” → Ask with the document attached<br>`038-library-ask-about-document.png` |
| 039 | <img src="039-library-ask-about-document-answer.png" width="200"> | Answer grounded in the attached document<br>`039-library-ask-about-document-answer.png` |
| 040 | <img src="040-library-document-more-menu.png" width="200"> | Document “···”: Download / Delete<br>`040-library-document-more-menu.png` |
| 041 | <img src="041-library-document-delete-confirm.png" width="200"> | Delete document → confirmation<br>`041-library-document-delete-confirm.png` |
| 042 | <img src="042-library-document-deleted.png" width="200"> | Document deleted (removed from My files)<br>`042-library-document-deleted.png` |
| 043 | <img src="043-library-workspace-collections.png" width="200"> | Library → Workspace: shared collections<br>`043-library-workspace-collections.png` |
| 044 | <img src="044-library-collection-detail.png" width="200"> | Open a collection → its documents<br>`044-library-collection-detail.png` |
| 045 | <img src="045-library-collection-share.png" width="200"> | Collection → Share: who has access<br>`045-library-collection-share.png` |
| 046 | <img src="046-library-share-add-person.png" width="200"> | Share → add a person or group picker<br>`046-library-share-add-person.png` |
| 047 | <img src="047-library-share-change-role.png" width="200"> | Share → change a member's access level<br>`047-library-share-change-role.png` |
| 048 | <img src="048-library-collection-more.png" width="200"> | Collection “···” menu<br>`048-library-collection-more.png` |
| 049 | <img src="049-library-collection-rename.png" width="200"> | Rename and describe a collection<br>`049-library-collection-rename.png` |
| 050 | <img src="050-library-document-pdf-preview.png" width="200"> | Document that failed processing: plain-language reason + “Try again”, no preview<br>`050-library-document-pdf-preview.png` |
| 051 | <img src="051-library-document-spreadsheet-preview.png" width="200"> | Spreadsheet document preview<br>`051-library-document-spreadsheet-preview.png` |

## 4. Manage — quản trị workspace

| # | Màn hình | Thao tác / nội dung |
| --- | --- | --- |
| 052 | <img src="052-manage-workspace-overview.png" width="200"> | Manage → Workspace: what needs a decision, workspace at a glance, sections<br>`052-manage-workspace-overview.png` |
| 053 | <img src="053-manage-workspace-sections.png" width="200"> | Manage → Workspace (scrolled): sections the person may open<br>`053-manage-workspace-sections.png` |
| 054 | <img src="054-manage-knowledge.png" width="200"> | Manage → Knowledge: collections, sharing, adding knowledge<br>`054-manage-knowledge.png` |
| 055 | <img src="055-manage-knowledge-add.png" width="200"> | Manage → Knowledge → Add: new collection / add knowledge<br>`055-manage-knowledge-add.png` |
| 056 | <img src="056-manage-knowledge-new-collection.png" width="200"> | New collection form<br>`056-manage-knowledge-new-collection.png` |
| 057 | <img src="057-manage-knowledge-collection-nested.png" width="200"> | Collection with a sub-collection (BoDemo)<br>`057-manage-knowledge-collection-nested.png` |
| 058 | <img src="058-manage-ingestion-runs.png" width="200"> | Manage → Ingestion: runs with progress<br>`058-manage-ingestion-runs.png` |
| 059 | <img src="059-manage-ingestion-run-detail.png" width="200"> | Run detail: counts, failed documents with reasons, “Retry failed”<br>`059-manage-ingestion-run-detail.png` |
| 060 | <img src="060-manage-ingestion-run-detail-items.png" width="200"> | Run detail (scrolled): per-document results<br>`060-manage-ingestion-run-detail-items.png` |
| 061 | <img src="061-manage-ingestion-run-more.png" width="200"> | Run “···” menu<br>`061-manage-ingestion-run-more.png` |
| 062 | <img src="062-manage-ingestion-run-item.png" width="200"> | Tap a failed document in a run → document with failure reason and “Try again”<br>`062-manage-ingestion-run-item.png` |
| 063 | <img src="063-manage-ingestion-new-run.png" width="200"> | Ingestion → New run sheet<br>`063-manage-ingestion-new-run.png` |
| 064 | <img src="064-manage-ingestion-sources.png" width="200"> | Ingestion → Sources (none connected yet; connecting is done on the web)<br>`064-manage-ingestion-sources.png` |
| 065 | <img src="065-manage-access-members.png" width="200"> | Manage → Access → Members<br>`065-manage-access-members.png` |
| 066 | <img src="066-manage-access-member-detail.png" width="200"> | Member detail: roles, groups, status<br>`066-manage-access-member-detail.png` |
| 067 | <img src="067-manage-access-member-role.png" width="200"> | Change a member's role (picker)<br>`067-manage-access-member-role.png` |
| 068 | <img src="068-manage-access-member-suspend-confirm.png" width="200"> | Suspend member → confirmation (cancelled)<br>`068-manage-access-member-suspend-confirm.png` |
| 069 | <img src="069-manage-access-add-member.png" width="200"> | Add member: find an existing account by email<br>`069-manage-access-add-member.png` |
| 070 | <img src="070-manage-access-add-member-no-account.png" width="200"> | Add member with an email that has no account → explained error<br>`070-manage-access-add-member-no-account.png` |
| 071 | <img src="071-manage-access-groups.png" width="200"> | Access → Groups<br>`071-manage-access-groups.png` |
| 072 | <img src="072-manage-access-group-detail.png" width="200"> | Group sheet: members (empty) and how to add people<br>`072-manage-access-group-detail.png` |
| 073 | <img src="073-manage-access-new-group.png" width="200"> | New group form<br>`073-manage-access-new-group.png` |
| 074 | <img src="074-manage-access-roles.png" width="200"> | Access → Roles<br>`074-manage-access-roles.png` |
| 075 | <img src="075-manage-access-role-detail.png" width="200"> | Role detail: what the role can do, written as sentences<br>`075-manage-access-role-detail.png` |
| 076 | <img src="076-manage-activity-usage.png" width="200"> | Manage → Activity: questions & active people, questions-per-day chart, Sign-ins / Audit log<br>`076-manage-activity-usage.png` |
| 077 | <img src="077-manage-activity-usage-more.png" width="200"> | Activity (scrolled): sign-in list with Active / Ended state<br>`077-manage-activity-usage-more.png` |
| 078 | <img src="078-manage-activity-window.png" width="200"> | Activity: choose the time window<br>`078-manage-activity-window.png` |
| 079 | <img src="079-manage-activity-signin-detail.png" width="200"> | Sign-in detail<br>`079-manage-activity-signin-detail.png` |
| 080 | <img src="080-manage-activity-audit-log.png" width="200"> | Activity → Audit log<br>`080-manage-activity-audit-log.png` |
| 081 | <img src="081-manage-activity-filter.png" width="200"> | Activity filter<br>`081-manage-activity-filter.png` |
| 082 | <img src="082-manage-activity-audit-detail.png" width="200"> | Audit event detail<br>`082-manage-activity-audit-detail.png` |
| 083 | <img src="083-manage-settings.png" width="200"> | Manage → Settings: workspace name<br>`083-manage-settings.png` |
| 084 | <img src="084-manage-settings-dirty.png" width="200"> | Settings: name edited → Save appears<br>`084-manage-settings-dirty.png` |

## 5. Manage → Platform

| # | Màn hình | Thao tác / nội dung |
| --- | --- | --- |
| 085 | <img src="085-platform-overview.png" width="200"> | Manage → Platform: system health (shows “Down” — chat model unhealthy at capture time) and platform sections<br>`085-platform-overview.png` |
| 086 | <img src="086-platform-tenants.png" width="200"> | Platform → Tenants (read-only)<br>`086-platform-tenants.png` |
| 087 | <img src="087-platform-tenant-detail.png" width="200"> | Tenant row → detail sheet<br>`087-platform-tenant-detail.png` |
| 088 | <img src="088-platform-tenants-filter-inactive.png" width="200"> | Tenants filtered by status (Inactive)<br>`088-platform-tenants-filter-inactive.png` |
| 089 | <img src="089-platform-users.png" width="200"> | Platform → Users<br>`089-platform-users.png` |
| 090 | <img src="090-platform-user-detail.png" width="200"> | Platform user detail<br>`090-platform-user-detail.png` |
| 091 | <img src="091-platform-audit-log.png" width="200"> | Platform → Audit log (every tenant)<br>`091-platform-audit-log.png` |
| 092 | <img src="092-platform-audit-detail.png" width="200"> | Platform audit event detail<br>`092-platform-audit-detail.png` |

## 6. Tài khoản, giao diện, đăng xuất

| # | Màn hình | Thao tác / nội dung |
| --- | --- | --- |
| 093 | <img src="093-account-sheet.png" width="200"> | Account sheet (avatar): workspace, appearance, sign out<br>`093-account-sheet.png` |
| 094 | <img src="094-account-appearance-dark.png" width="200"> | Appearance → Dark<br>`094-account-appearance-dark.png` |
| 095 | <img src="095-dark-manage-workspace.png" width="200"> | Dark theme: Manage → Workspace<br>`095-dark-manage-workspace.png` |
| 096 | <img src="096-dark-ask-thread.png" width="200"> | Dark theme: Ask thread<br>`096-dark-ask-thread.png` |
| 097 | <img src="097-dark-library.png" width="200"> | Dark theme: Library<br>`097-dark-library.png` |
| 098 | <img src="098-dark-account-sheet.png" width="200"> | Dark theme: Account sheet<br>`098-dark-account-sheet.png` |
| 099 | <img src="099-account-sign-out-confirm.png" width="200"> | Sign out → confirmation (“Your chats stay saved on this phone”)<br>`099-account-sign-out-confirm.png` |
| 100 | <img src="100-account-signed-out.png" width="200"> | Signed out → back to Sign in<br>`100-account-signed-out.png` |
