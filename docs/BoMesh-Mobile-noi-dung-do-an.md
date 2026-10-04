# BoMesh Mobile — Tài liệu đồ án Lập trình Mobile

Nội dung lập từ mã Flutter/Dart hiện có và tài liệu thiết kế hệ thống. Các kịch bản UTE, ảnh chụp và kết quả trình diễn cần đối chiếu với dữ liệu và phiên chạy thật trước ngày bảo vệ. Những chức năng chưa có trên Flutter được ghi riêng, không tính vào sản phẩm đã hoàn thành.

# 1. Tổng quan đề tài

**Tên đề tài:** Xây dựng ứng dụng Mobile AI Knowledge Assistant bằng Flutter – BoMesh Mobile, minh họa trải nghiệm cho một workspace UTE. BoMesh là nền tảng Knowledge + AI Assistant có thể phục vụ nhiều workspace; UTE là bối cảnh áp dụng dự kiến cho đồ án, không phải định nghĩa sản phẩm là một chatbot riêng của UTE. Ứng dụng được viết bằng Flutter/Dart; sau khi xác thực, người dùng thao tác chủ yếu ở hai tab Chat và Library. Đây là bài toán thiết kế và hiện thực trải nghiệm mobile, còn máy chủ cung cấp xác thực, dữ liệu tri thức và luồng phản hồi cho client. (Nguồn: `app/pubspec.yaml:1-20`; `app/lib/app/workspace_shell.dart:10-14,206-235`; `backend/docs_design/api_contract.md:10-38`.)

Đóng góp được trình bày ở góc độ ứng dụng: điều hướng, tương tác chat có phản hồi tăng dần, mở nguồn trích dẫn, xem/tìm tài liệu, bảo vệ phiên đăng nhập và xử lý giao diện theo quyền. Không đưa ra nhận định rằng workspace UTE đã có một bộ tài liệu hoặc dữ liệu người dùng cụ thể; mọi tài liệu, tài khoản và đáp án chuyên ngành trong bản trình diễn phải được kiểm tra trước khi sử dụng. Người thực hiện code, integration và demo là người dùng; báo cáo này mô tả mã nguồn hiện tại chứ không thay thế bằng lời hứa triển khai. (Nguồn: `app/lib/features/chat/services/chat_service.dart:29-64`; `app/lib/features/knowledge/library_page.dart:15-19,62-78`.)

# 2. Problem & Objectives

Người sử dụng trên điện thoại cần chuyển nhanh từ một câu hỏi sang tài liệu đáng tin cậy để kiểm tra nội dung câu trả lời, thay vì chỉ nhận một đoạn văn không biết nguồn. Vấn đề thiết kế là giữ một luồng đọc–hỏi–kiểm chứng gọn trên màn hình nhỏ, đồng thời không hiển thị tài liệu ngoài quyền truy cập. Đối với câu ví dụ “Điều kiện để được xét tốt nghiệp là gì?”, câu trả lời đúng chỉ có thể đánh giá sau khi workspace demo thực sự chứa quy định phù hợp và tài khoản được phép đọc tài liệu; bản báo cáo không tự đặt ra quy định tốt nghiệp của UTE. (Nguồn: `backend/docs_design/conversation_loop.md:5-16,44-50`; `app/lib/features/knowledge/document_page.dart:83-122`.)

Mục tiêu chức năng là đăng nhập/khôi phục phiên, hỏi đáp trong Chat, quan sát trạng thái xử lý và dòng chữ đang sinh, mở citation đến đoạn nguồn, quản lý lịch sử cục bộ, tìm và xem tài liệu trong Library, chuyển workspace đã có membership, và xử lý yêu cầu truy cập theo quyền. Mục tiêu kỹ thuật là tổ chức các trách nhiệm UI–state–transport rõ ràng, không giữ token trong một màn hình riêng lẻ, giải mã SSE an toàn khi dữ liệu đến từng phần, và cho thấy loading/empty/error hợp ngữ cảnh. (Nguồn: `app/lib/app/app.dart:19-36,48-92`; `app/lib/features/chat/state/chat_controller.dart:13-34,476-530`; `app/lib/features/requests/requests_page.dart:8-25,119-170`.)

# 3. Scope đồ án Mobile

**Trong phạm vi hiện tại:** Flutter app với AuthPage; shell gồm Chat và Library; account bottom sheet; chuyển workspace; trang Access requests; chat có conversation drawer, composer, SSE, source và artifact; Library gồm My files/Workspace, collection detail, document viewer; tải tài liệu, kích hoạt xử lý khi có quyền. Đây là các điểm trong code, không phải khẳng định đã chạy thành công với dữ liệu UTE. (Nguồn: `app/lib/app/app.dart:70-89`; `app/lib/app/workspace_shell.dart:139-193,206-297`; `app/lib/features/knowledge/library_page.dart:101-143,201-220,305-367`; `app/lib/features/chat/chat_page.dart:40-63,130-180`.)

**Ngoài phạm vi mobile hiện tại:** Home/Profile độc lập; màn hình quản trị workspace gồm danh sách thành viên, tạo/sửa/xóa collection hoặc chỉnh ACL; đồng bộ lịch sử giữa thiết bị; dữ liệu hay kết quả hỏi đáp UTE chưa xác minh. Backend có endpoint cho một số thao tác quản trị nhưng sự tồn tại của API không đồng nghĩa có UI Flutter. Nút tải lên/xử lý/xóa **tài liệu** trong collection theo quyền không phải CRUD **collection**. (Nguồn: `app/lib/app/workspace_shell.dart:10-14,139-193,206-235`; `app/lib/features/knowledge/library_page.dart:15-19,341-367`; `app/lib/features/chat/services/conversation_store.dart:7-26`; `backend/docs_design/api_contract.md:183-211`.)

# 4. User Requirements

| Nhóm nhu cầu | Yêu cầu từ góc nhìn người dùng | Cách hiện thực và điều kiện |
|---|---|---|
| Vào ứng dụng | Đăng nhập, biết mình đang ở workspace nào và có thể chuyển sang workspace được cấp | AuthPage, session và account sheet; chỉ liệt kê membership có thật. `app/lib/features/auth/session.dart:21-55,96-142,207-242`; `app/lib/app/workspace_shell.dart:84-114,139-183` |
| Hỏi đáp | Nhập câu hỏi, chọn phạm vi collection/tài liệu, nhận câu trả lời từng phần, dừng hoặc thử lại | ChatComposer–ChatController–ChatService; câu trả lời thực tế phụ thuộc API. `app/lib/features/chat/state/chat_controller.dart:265-281,429-530`; `app/lib/features/chat/services/chat_service.dart:29-108` |
| Kiểm chứng | Bấm citation và đọc đúng tài liệu/đoạn liên quan | ChatMessageView chuyển sang DocumentPage bằng document/chunk ID; tài liệu vẫn phải qua kiểm quyền. `app/lib/features/chat/widgets/message_view.dart:227-238,507-550`; `app/lib/features/knowledge/document_page.dart:83-122` |
| Tìm, xem và lưu | Tìm tài liệu, mở collection được xem, đọc preview/text/details; tìm, ghim, đổi tên, xóa hội thoại cục bộ | LibraryPage và ConversationStore. `app/lib/features/knowledge/library_page.dart:94-99,201-301`; `app/lib/features/chat/services/conversation_store.dart:42-73,104-174` |
| Quyền và tác vụ | Chỉ thấy nội dung/tác vụ phù hợp; người có quyền duyệt yêu cầu, chính chủ có thể hủy yêu cầu đang chờ | Kiểm tra client để trình bày đúng UI, server là cơ quan quyết định. `app/lib/features/knowledge/document_list.dart:155-165,234-266`; `app/lib/features/requests/requests_page.dart:8-25,177-243`; `backend/docs_design/api_contract.md:31-38,85-94` |

Yêu cầu phi chức năng nhấn mạnh thao tác trên màn hình nhỏ, phân biệt rõ trạng thái đang làm/không có dữ liệu/lỗi, bảo vệ token, ngăn phản hồi phiên cũ làm nhiễm workspace mới. Những điều này được giải quyết bằng bố cục adaptive, secure storage, generation/token guard và HTTP client theo phiên; không suy diễn thành cam kết uptime hay benchmark hiệu năng. (Nguồn: `app/lib/app/workspace_shell.dart:237-297`; `app/lib/features/auth/session.dart:73-120,207-253`; `app/lib/app/workspace_shell.dart:30-48`.)

# 5. Use Cases

**UC1 – Đăng nhập và vào workspace:** người dùng nhập email/username và mật khẩu; app gọi tạo session; nếu hợp lệ, root Navigator thay trang đăng nhập bằng WorkspaceShell. Khi mở lại, token lưu an toàn được xác minh qua current session trước khi hiện nội dung. Ngoại lệ: hết hạn/401 dẫn về đăng nhập; không có chế độ truy cập vô danh. (Nguồn: `app/lib/features/auth/session.dart:96-127,144-191,244-253`; `app/lib/app/app.dart:53-89`; `backend/docs_design/auth_contract.md:5-11`.)

**UC2 – Hỏi và kiểm chứng:** trong Chat, người dùng nhập câu hỏi, có thể chọn collection hoặc tài liệu sẵn có; client tạo tin người dùng và turn assistant tạm, gửi lịch sử, scope và attachment IDs, rồi cập nhật câu trả lời theo sự kiện SSE. Khi có citation, người dùng mở DocumentPage tập trung vào đoạn trích. Nếu dừng hoặc mất kết nối, turn hiển thị trạng thái gián đoạn/thất bại và có thể thử lại. (Nguồn: `app/lib/features/chat/state/chat_controller.dart:302-331,429-539`; `app/lib/features/chat/services/chat_service.dart:29-108`; `app/lib/features/chat/widgets/message_view.dart:227-238`.)

**UC3 – Tìm tài liệu:** người dùng chuyển Library, xem My files hoặc Workspace, nhập từ khóa, mở collection/tài liệu và có thể quay sang Chat với tài liệu làm ngữ cảnh. Chỉ collection/tài liệu cho phép đọc được trả về; thao tác thêm/xử lý/xóa tài liệu có kiểm quyền riêng. (Nguồn: `app/lib/features/knowledge/library_page.dart:62-99,201-301,305-367`; `app/lib/features/knowledge/document_list.dart:109-115,155-165,234-280`.)

**UC4 – Yêu cầu truy cập và đổi workspace:** account sheet cho phép chọn workspace thuộc tài khoản và mở Access requests. Người có `access.manage` hoặc `source.manage` có thể duyệt/từ chối yêu cầu tương ứng đang chờ của người khác; người gửi hủy yêu cầu của chính mình khi còn pending. UC này **không** bao gồm sửa ACL collection hay xem members trong app. (Nguồn: `app/lib/app/workspace_shell.dart:84-114,139-193`; `app/lib/features/requests/requests_page.dart:8-25,119-170,177-243`.)

# 6. Mobile UI/UX

Sau đăng nhập không có Home trung gian: Chat là tab đầu, Library là tab còn lại. Thanh điều hướng đáy phục vụ màn hình hẹp; màn hình rộng dùng NavigationRail. Chat hiển thị tiêu đề hội thoại, trạng thái assistant, vùng tin nhắn có chiều rộng giới hạn và composer cố định theo bố cục; drawer mở danh sách hội thoại trên điện thoại. Menu tài khoản dạng bottom sheet giảm nhu cầu một trang Profile độc lập. (Nguồn: `app/lib/app/workspace_shell.dart:206-297`; `app/lib/features/chat/chat_page.dart:130-180,183-319`.)

Thiết kế ưu tiên nhận biết trạng thái: WelcomeView khi chưa có tin, vòng xoay khi tải, trạng thái đang làm trong header hoặc message, lỗi trên vùng Chat/Library/Document, và nguồn mở sang viewer để kiểm tra. Library chia My files và Workspace bằng SegmentedButton, tìm kiếm sau debounce, mở collection bằng hàng chạm; không hiển thị bộ điều khiển ACL phức tạp. (Nguồn: `app/lib/features/chat/chat_page.dart:216-249,302-315`; `app/lib/features/knowledge/library_page.dart:94-99,180-220,223-301`; `app/lib/features/knowledge/document_page.dart:180-207`.)

# 7. Screen Flow & Navigation

```text
Mở ứng dụng → xác minh token/đang khôi phục
   ├─ chưa có phiên / phiên hết hạn → AuthPage (đăng nhập, đăng ký; Google nếu cấu hình)
   └─ phiên hợp lệ → WorkspaceShell
        ├─ Chat (tab mặc định)
        │    ├─ drawer: hội thoại mới / lịch sử cục bộ
        │    ├─ citation → DocumentPage
        │    └─ artifact → ArtifactPage
        ├─ Library
        │    ├─ My files → DocumentPage
        │    └─ Workspace → collection detail → DocumentPage
        │                        └─ Ask document → Chat
        └─ Account bottom sheet
             ├─ Switch workspace → xác minh/chuyển phiên → shell của workspace mới
             ├─ Access requests → RequestsPage
             └─ Sign out → AuthPage
```

Root dùng `Navigator` với `pages` quyết định theo session và key gồm namespace/token; màn hình chi tiết được `push` qua `MaterialPageRoute`, không có `go_router`. `IndexedStack` giữ trạng thái hai tab; nút Back ở tab Library quay về Chat. Việc đổi workspace làm thay phiên, tránh giữ route/resource của workspace cũ. (Nguồn: `app/lib/app/app.dart:70-89`; `app/lib/app/workspace_shell.dart:30-48,74-114,206-297`; `app/lib/features/knowledge/library_page.dart:132-143`.)

# 8. Flutter Architecture

```text
MaterialApp / root Navigator
  ├─ SessionController (ChangeNotifier) ← ApiClient + secure storage
  └─ WorkspaceShell (tab state, workspace-scoped ApiClient)
       ├─ ChatPage → ChatController (ChangeNotifier)
       │    ├─ ChatService → HTTP POST/SSE
       │    ├─ ChatStreamReducer → ChatTurnState/Message
       │    └─ ConversationStore → SharedPreferencesAsync
       ├─ LibraryPage / DocumentPage → ApiClient + Knowledge models
       └─ RequestsPage → ApiClient
```

Đây là cấu trúc feature-first thực tế, không gắn nhãn Clean Architecture hay tự thêm một repository layer không tồn tại. `ApiClient` là transport dùng chung; feature giữ model, state, service/widget tương ứng. UI nhận thông báo thay đổi từ `ChangeNotifier` qua `AnimatedBuilder`, còn trạng thái tạm trong StatefulWidget dùng `setState`. Backend quyết định nội dung và quyền; mobile quản lý trình bày, tương tác, trạng thái phiên và lưu history tại thiết bị. (Nguồn: `app/lib/app/app.dart:19-30,48-92`; `app/lib/features/chat/chat_page.dart:40-63,130-179`; `app/lib/features/chat/state/chat_controller.dart:13-34`; `app/lib/features/chat/services/conversation_store.dart:7-26`.)

# 9. Flutter Project Structure

| Thư mục/tệp | Vai trò trong mobile |
|---|---|
| `app/lib/main.dart`, `app/lib/app/` | Khởi động, cấu hình, theme, root Navigator, shell hai tab và menu tài khoản (`app/lib/main.dart:5-8`; `app/lib/app/app.dart:19-92`; `app/lib/app/workspace_shell.dart:10-19`). |
| `app/lib/core/` | `ApiClient`, helpers và vận chuyển tệp (`app/lib/core/api_client.dart:12-49,93-158`). |
| `app/lib/features/auth/` | AuthPage, SessionController, Google sign-in có điều kiện cấu hình (`app/lib/features/auth/session.dart:58-75,122-142`; `app/lib/features/auth/auth_page.dart:265-269`). |
| `app/lib/features/chat/` | ChatPage; `models`, `state`, `services`, `widgets` cho SSE, hội thoại và composer (`app/lib/features/chat/chat_page.dart:9-16,40-63`; `app/lib/features/chat/state/chat_controller.dart:13-34`). |
| `app/lib/features/knowledge/` | Library, collection detail, document list/viewer, upload, model/trạng thái (`app/lib/features/knowledge/library_page.dart:5-20`; `app/lib/features/knowledge/document_page.dart:70-123`). |
| `app/lib/features/requests/` | Trang xem và quyết định approval requests (`app/lib/features/requests/requests_page.dart:8-59`). |

Các dependency có chứng cứ gồm `http`, `flutter_secure_storage`, `shared_preferences`, `google_sign_in`, `file_picker`, `flutter_markdown_plus`, `url_launcher`; không mô tả Riverpod/BLoC/Provider/Dio vì chúng không nằm trong danh sách dependency đang dùng. (Nguồn: `app/pubspec.yaml:9-20`.)

# 10. Widget Architecture

ChatPage tổ hợp ChatSidebar, WelcomeView, ChatMessageView và ChatComposer: màn hình chịu bố cục/drawer/scroll, controller giữ hội thoại, widget tin nhắn xử lý markdown, nguồn và hoạt động của agent, composer chịu nhập/chọn scope/đính kèm. LibraryPage tổ hợp SearchBar, SegmentedButton, DocumentList, collection detail; DocumentPage chia Preview/Text/Details. RequestsPage hiển thị nhóm chờ duyệt và yêu cầu của tôi thành các card với hành động có xác nhận. Đây là phân rã hiện hữu, không phải các tên `ChatHeader`, `KnowledgeScreen` hoặc `WorkspaceScreen` giả định. (Nguồn: `app/lib/features/chat/chat_page.dart:13-16,130-180,183-319`; `app/lib/features/knowledge/library_page.dart:180-220,245-267,305-367`; `app/lib/features/knowledge/document_page.dart:257-269`; `app/lib/features/requests/requests_page.dart:119-170,177-243`.)

Cơ chế tái sử dụng nằm ở thành phần tương tác như DocumentList, KnowledgeNotice, ProcessingCard, account button của shell và các model/transport chung; không cần biến mọi đoạn UI thành abstraction. Ví dụ DocumentPage có thể nhận `chunkId` từ trích dẫn lẫn mở tài liệu thông thường, nên một viewer phục vụ hai điểm vào. (Nguồn: `app/lib/features/knowledge/document_page.dart:70-105,180-207,557-585`; `app/lib/app/workspace_shell.dart:195-224`.)

# 11. State Management

`SessionController extends ChangeNotifier` quản lý `restoring`, `busy`, `session`, `error`, `notice`, token hết hạn và hành động login/register/switch/logout. `ProductApp` quan sát bằng AnimatedBuilder để thay cây điều hướng; workspace shell có state tab/danh sách tab đã thăm và badge; mỗi feature giữ state cần thiết bằng `setState`. `ChatController extends ChangeNotifier` quản lý danh sách cuộc hội thoại, tin nhắn, attachment, scope, trạng thái gửi; ChatPage rebuild qua AnimatedBuilder. (Nguồn: `app/lib/features/auth/session.dart:58-83,96-120,179-191`; `app/lib/app/app.dart:48-92`; `app/lib/app/workspace_shell.dart:23-29,51-61`; `app/lib/features/chat/state/chat_controller.dart:13-34`; `app/lib/features/chat/chat_page.dart:130-180`.)

Riêng streaming là trạng thái theo turn: reducer nhận sự kiện có sequence number, bỏ sự kiện cũ, gắn delta text, reasoning, tool activity, annotation và phân biệt completed/failed. Controller thông báo UI sau mỗi event, lưu cục bộ theo nhịp 700 ms và khi kết thúc; phiên lưu dở sau khởi động lại được hiển thị là interrupted, không giả vờ vẫn đang nhận. Library dùng `_loading`, `_error`, `_query`, `_view`; DocumentPage dùng `_loading`, `_restricted`, dữ liệu viewer và document. Không tồn tại một state `workspace.members` trong mobile hiện tại. (Nguồn: `app/lib/features/chat/models/chat_stream.dart:22-53,71-151`; `app/lib/features/chat/state/chat_controller.dart:476-539`; `app/lib/features/chat/services/conversation_store.dart:55-73`; `app/lib/features/knowledge/library_page.dart:36-85`; `app/lib/features/knowledge/document_page.dart:70-122`.)

# 12. Authentication

Login mật khẩu và đăng ký đi qua `/api/v1/auth/sessions` và `/api/v1/auth/accounts`; Google sign-in lấy provider credential rồi dùng cùng endpoint session với `method: google`, chỉ trình bày nút khi có cấu hình client phù hợp. Token lưu bằng `flutter_secure_storage`, key được phân vùng theo API origin; `restore()` đọc token rồi gọi `GET /auth/session`, `refresh()` gọi lại khi app về foreground. Không có refresh-token endpoint và không tự tạo guest session. (Nguồn: `app/lib/features/auth/session.dart:58-75,96-142,193-205`; `app/lib/app/app.dart:23-36`; `app/lib/features/auth/auth_page.dart:265-269`; `backend/docs_design/auth_contract.md:50-82,113-134`.)

`PATCH /auth/session` chỉ nhận `active_workspace_id`, trả session/token mới khi membership hợp lệ; root Navigator và HTTP client workspace được dựng lại. Đăng xuất cố gắng `DELETE /auth/session`, xóa credential cục bộ ngay cả khi backend không xác nhận; UI cảnh báo chứ không nhận vơ đã thu hồi phía server. Khi token hết hạn/401 hợp lệ, phiên bị xóa và màn hình bảo vệ được thay bằng AuthPage. (Nguồn: `app/lib/features/auth/session.dart:207-279`; `app/lib/core/api_client.dart:171-201`; `app/lib/app/app.dart:70-89`; `backend/docs_design/auth_contract.md:89-103,113-130`.)

# 13. API Integration

`ApiClient` chuẩn hóa base URL và tiền tố `/api/v1`, mã hóa JSON cho GET/POST/PUT/PATCH/DELETE, gắn bearer token, giải mã response thành map và ánh xạ lỗi theo HTTP status/code/request ID. HTTP thông thường timeout 45 giây; multipart upload timeout 5 phút và dùng `Idempotency-Key`. Những con số này mô tả cấu hình client, không phải độ trễ thực tế của backend. (Nguồn: `app/lib/app/app_config.dart:2-16`; `app/lib/core/api_client.dart:35-76,78-120,123-206`.)

Từng feature dùng transport theo mục đích: auth current-session; Library `GET /knowledge/home`, `/documents`; DocumentPage `GET /knowledge/documents/{id}` và `/documents/{id}`; chat dùng request HTTP POST riêng với `Accept: text/event-stream` để không gom toàn bộ phản hồi vào JSON. Authorization của người dùng do bearer session xác lập, body chat chỉ chứa câu hỏi/lịch sử/scope/attachment IDs, không tự tuyên bố user hay workspace. (Nguồn: `app/lib/features/knowledge/library_page.dart:62-78`; `app/lib/features/knowledge/document_page.dart:83-89`; `app/lib/features/chat/services/chat_service.dart:29-64`; `backend/docs_design/api_contract.md:24-38,156-180`.)

# 14. Chatbot Mobile

Trong Chat, người dùng tạo hội thoại mới, chọn hội thoại cũ, nhập tối đa 4.000 ký tự, chọn tối đa 10 tài liệu và collection scope, gửi rồi theo dõi tin nhắn assistant đang hiện dần. Nút Stop ngắt HTTP stream; Regenerate gửi lại câu hỏi với history, scope và đính kèm tương ứng; Edit request đưa câu hỏi trước vào ô soạn. Các điều khiển không thay thế quyền của backend. (Nguồn: `app/lib/features/chat/state/chat_controller.dart:265-281,289-331,429-530`; `app/lib/features/chat/widgets/chat_composer.dart:229-302,390-486`; `app/lib/features/chat/widgets/message_view.dart:200-215`.)

Chat có empty welcome, drawer lịch sử, trạng thái hoạt động tool/assistant, citation, thẻ artifact nếu có dữ liệu trả về và đường sang document viewer. Lịch sử được lưu trong SharedPreferencesAsync theo `userId:activeWorkspaceId`, hỗ trợ tìm, ghim, đổi tên và xóa **trên thiết bị**; không có sync liên thiết bị. Tài liệu library được tham chiếu trong chat không bị xóa khi người dùng xóa hội thoại. (Nguồn: `app/lib/features/chat/chat_page.dart:40-63,130-180,239-315`; `app/lib/features/chat/services/conversation_store.dart:7-26,104-174`; `backend/docs_design/conversation_loop.md:87-107`.)

# 15. Streaming

```text
Người dùng bấm Gửi → ChatController tạo user message + assistant turn tạm
→ ChatService POST /api/v1/agent/chat với Accept: text/event-stream
→ giải mã UTF-8, tách dòng, gom các dòng data: thành một SSE event
→ ChatStreamReducer đối chiếu sequence_number, cập nhật turn
→ notifyListeners → AnimatedBuilder dựng lại ChatMessageView
→ completed: hoàn tất/lưu; failed hoặc ngắt: báo lỗi và cho thử lại.
```

Client xử lý `response.output_text.delta/done` cho văn bản, reasoning/tool events cho trạng thái, annotation cho nguồn, `response.completed/failed/error` cho kết thúc. Không gọi đây là WebSocket. Việc có bước “đang tìm kiếm” phụ thuộc backend thực sự phát tool event; UI không phát một nhãn tìm kiếm cố định cho mọi câu hỏi. Giữa hai sự kiện, người dùng vẫn có thể dừng stream; mất kết nối không được hiển thị như câu trả lời hoàn tất. (Nguồn: `app/lib/features/chat/services/chat_service.dart:29-125`; `app/lib/features/chat/models/chat_stream.dart:22-151`; `app/lib/features/chat/state/chat_controller.dart:476-539`; `app/lib/features/chat/widgets/message_view.dart:404-505`.)
Điều cần phân biệt khi thuyết trình: app không hiện nguyên văn “Đang phân tích...” hay “Đang tìm kiếm...” như flow ý tưởng. Trong lúc chờ, UI dùng chỉ báo BoMesh; nếu có sự kiện `knowledge_search`, nhãn thực tế là “Searching your knowledge…”/“Searched your knowledge”. Đây là nhãn đang dùng trong source, không nên dịch rồi nhận là chữ trên màn hình. (Nguồn: `app/lib/features/chat/widgets/message_view.dart:484-544,641-660`.)


# 16. Citation

Citation là đường kiểm chứng từ câu trả lời về tài liệu, không phải trang trí ở cuối đoạn. Khi backend cung cấp annotation hợp lệ, ChatMessageView hiển thị dấu tham chiếu `[n]` và nhóm nguồn; chạm dấu/nguồn mở DocumentPage theo document ID và chunk ID. Viewer tải lại dữ liệu qua endpoint có kiểm quyền, cố gắng tập trung đoạn trích và hiển thị Preview/Text/Details; PDF có thể có ảnh trang/khung vùng trích, định dạng không có ảnh vẫn đọc được đoạn text được trả về. (Nguồn: `app/lib/features/chat/widgets/message_view.dart:227-238,345-356,507-550,670-683`; `app/lib/features/knowledge/document_page.dart:83-122,257-269,336-475,479-555`; `backend/docs_design/conversation_loop.md:109-126`.)
Danh sách sources riêng dưới câu trả lời chỉ hiện sau khi turn đã settled; dấu `[n]` tương tác trong nội dung và lần chạm nguồn đều đi đến `DocumentPage(documentId: source.itemId, chunkId: source.chunkId)`. (Nguồn: `app/lib/features/chat/widgets/message_view.dart:144-169,252-260,677-693`.)


Một tài liệu có thể chứa nhiều passage nhưng số nguồn đọc bởi người dùng được gom theo tài liệu; mở lại một nguồn vẫn giữ passage cụ thể. Nếu bị từ chối quyền hoặc tài liệu đã mất, viewer không hiển thị nội dung nguồn. Không viết một ví dụ citation UTE như dữ liệu đã tồn tại; nguồn phải lấy từ câu trả lời demo thật. (Nguồn: `backend/docs_design/conversation_loop.md:109-126`; `app/lib/features/knowledge/document_page.dart:110-122,180-207`.)

# 17. Knowledge

Knowledge trong app là những tài liệu mà tài khoản có thể tìm, đọc và hỏi AI, không phải bảng điều khiển vector/ingestion. Library đặt SearchBar ở đầu, chuyển My files/Workspace; tài liệu hiển thị dưới dạng danh sách có tìm kiếm và trạng thái, mở viewer để đọc. Workspace mode không tìm kiếm sẽ liệt kê collection được chia sẻ từ `/knowledge/home`; có từ khóa thì tìm tài liệu trong workspace theo quyền. (Nguồn: `app/lib/features/knowledge/library_page.dart:15-19,62-78,180-301`; `app/lib/features/knowledge/document_list.dart:109-115`.)

Người có quyền tương ứng có thể tải tài liệu, yêu cầu xử lý lại hoặc xóa tài liệu; upload chỉ thêm tài liệu vào inventory, còn xử lý là thao tác riêng `POST /ingestion-runs`. Có trạng thái pending/processing/ready/failed/outdated/unsupported để giúp người dùng hiểu vì sao tài liệu chưa tìm được, nhưng báo cáo mobile chỉ giải thích trạng thái cần cho UX, không biến đây thành dashboard vận hành. (Nguồn: `app/lib/features/knowledge/upload_sheet.dart:125-166,237-251`; `app/lib/features/knowledge/document_list.dart:137-172,234-280`; `backend/docs_design/api_contract.md:223-258`.)

# 18. Collection

Collection là nhóm tài liệu theo mục đích/phạm vi sử dụng trong workspace, không phải thuật ngữ cơ sở dữ liệu vector. Ví dụ trong đồ án có thể đề xuất một nhóm tài liệu đào tạo hoặc tốt nghiệp, **nhưng chỉ đưa tên nhóm UTE vào demo khi đã xác minh dữ liệu thật**. Ở tab Workspace, người dùng thấy collection được phép đọc, chạm để vào danh sách tài liệu, mở nội dung gốc hoặc đưa một tài liệu làm ngữ cảnh cho câu hỏi. (Nguồn: `app/lib/features/knowledge/library_page.dart:269-301,305-367`; `app/lib/features/knowledge/document_page.dart:125-160,244-253`.)

Mobile hiện **không** có UI tạo/đổi tên/xóa collection, không có UI gán/chỉnh quyền collection. `GET/PUT/DELETE /collections/{id}/access` là khả năng API chứ không phải màn hình Flutter. Tại collection detail, khi có `collection.update`, người dùng có thể **thêm tài liệu**; khi có `ingestion.run`, có thể xử lý tài liệu. Phân biệt các thao tác đối tượng tài liệu này với quản trị collection. (Nguồn: `app/lib/features/knowledge/library_page.dart:15-19,305-367`; `app/lib/features/knowledge/document_list.dart:155-165,234-280`; `backend/docs_design/api_contract.md:183-211`.)

# 19. Workspace

Workspace là ranh giới ngữ cảnh dữ liệu và quyền của phiên. Account bottom sheet hiển thị tên workspace hiện tại; nếu tài khoản thuộc nhiều workspace, bottom sheet khác liệt kê các workspace có membership để chuyển. SessionController gửi PATCH với ID được chọn, nhận token mới; root Navigator thay shell và HTTP client theo workspace mới, local history dùng namespace mới. Không có màn hình Workspace Overview/Members riêng trên mobile. (Nguồn: `app/lib/app/workspace_shell.dart:84-114,139-183`; `app/lib/features/auth/session.dart:47-55,207-242`; `app/lib/app/app.dart:70-89`; `app/lib/features/chat/services/conversation_store.dart:7-26`.)

Tác vụ quản lý gần nhất có trên điện thoại là Access requests trong account sheet: một số tài khoản có quyền xét yêu cầu đang chờ và thấy badge. Các chức năng cấu hình thành viên, nhóm, role, chia sẻ collection thuộc web console hoặc API, **không phải tính năng app đã hoàn thiện**. (Nguồn: `app/lib/app/workspace_shell.dart:10-14,63-82,139-183`; `app/lib/features/requests/requests_page.dart:8-25,49-59`.)

# 20. Permission UX

App diễn đạt quyền bằng khả năng người dùng thấy và làm: danh sách collection/tài liệu được lọc; nút upload/process/delete tài liệu chỉ hiện nếu quyền tương ứng; Chat cần `knowledge.read`; viewer bị 401/403/404 thay nội dung bằng thông báo nguồn không khả dụng. Những guard phía client cải thiện UX, còn backend luôn kiểm quyền thực tế và không nhận `user_id`/`workspace_id` tự khai trong body. (Nguồn: `app/lib/features/chat/state/chat_controller.dart:45-47`; `app/lib/features/knowledge/library_page.dart:88-92,341-352`; `app/lib/features/knowledge/document_list.dart:155-165`; `app/lib/features/knowledge/document_page.dart:110-122,180-207`; `backend/docs_design/api_contract.md:31-38,85-94`.)

RequestsPage phân biệt “Waiting for you” và “Your requests”: người có `access.manage` quyết định yêu cầu resource access; `source.manage` cho loại còn lại; xác nhận trước Approve/Deny; người gửi chỉ Cancel khi pending. Đây không phải màn hình “chỉnh access” của collection: không duyệt ACL hiện thời, không thêm principal, không save quyền trực tiếp. (Nguồn: `app/lib/features/requests/requests_page.dart:8-25,119-170,177-243`; `backend/docs_design/api_contract.md:192-211`.)

# 21. Mobile ↔ Backend Integration

```text
Flutter UI → SessionController / ChatController / Library state
          → ApiClient (JSON, bearer) hoặc ChatService (POST SSE)
          → /api/v1: session, knowledge, collections/documents, approval-requests, agent/chat
          → dữ liệu/trạng thái/annotation đã được server xác thực
          → Flutter giải mã → cập nhật widget và lịch sử cục bộ.
```

Backend là tầng hỗ trợ: xác thực phiên, xác định workspace, lọc collection/tài liệu, phát sự kiện chat và giải quyết citation. Truy xuất tri thức trên server giới hạn nguồn được phép trước khi cung cấp cho agent; mobile không triển khai retrieval hoặc tự kết luận quyền. Không trình bày chi tiết hạ tầng hoặc cấu trúc index trong báo cáo mobile. (Nguồn: `app/lib/core/api_client.dart:35-120`; `app/lib/features/chat/services/chat_service.dart:29-125`; `backend/docs_design/conversation_loop.md:18-50,87-107`; `backend/docs_design/api_contract.md:31-38,156-180`.)

# 22. Demo Scenario

**Kịch bản 1 – sinh viên hỏi đáp:** mở app, đăng nhập tài khoản thuộc workspace UTE đã chuẩn bị, đi thẳng Chat, hỏi “Điều kiện để được xét tốt nghiệp là gì?”, quan sát trạng thái và text tăng dần, mở citation nếu backend thật trả nguồn phù hợp, hỏi tiếp rồi mở lịch sử cục bộ. Trước trình diễn phải xác minh tài liệu UTE liên quan, membership/quyền, backend SSE và tính đúng của câu trả lời; nếu không có nguồn, không nói app đã chứng minh được chính sách tốt nghiệp. (Nguồn: `app/lib/app/app.dart:70-89`; `app/lib/features/chat/services/chat_service.dart:29-125`; `app/lib/features/chat/widgets/message_view.dart:227-238`; `backend/docs_design/conversation_loop.md:5-16`.)

**Kịch bản 2 – tri thức:** từ Library chọn My files/Workspace, tìm một tài liệu thực tế được phép đọc, mở collection và DocumentPage, xem Preview/Text/Details, dùng “Ask document” để quay về Chat. Thành phần giao diện có trong code; dữ liệu, preview và nút tùy quyền sẽ chỉ xuất hiện khi backend và tài khoản demo đáp ứng. (Nguồn: `app/lib/features/knowledge/library_page.dart:180-301,305-367`; `app/lib/features/knowledge/document_page.dart:83-122,244-269`; `app/lib/app/workspace_shell.dart:56-61`.)

**Kịch bản 3 – manager phải sửa lại:** bản mô tả dự kiến “Workspace → Members → Collection → chỉnh Access → Save” **không khả dụng trong mobile hiện tại**. Kịch bản mobile thay thế hợp lệ là mở account sheet, kiểm tra workspace, chuyển workspace được cấp, mở Access requests và – chỉ nếu tài khoản có quyền cùng yêu cầu pending thích hợp – xác nhận Approve/Deny; yêu cầu do chính tài khoản tạo có thể Cancel khi pending. Nếu cần minh họa chỉnh ACL hoặc member, đó là hoạt động ngoài app mobile, không gộp vào kết quả demo Flutter. (Nguồn: `app/lib/app/workspace_shell.dart:10-14,84-114,139-193`; `app/lib/features/requests/requests_page.dart:8-25,119-170,177-243`; `app/lib/features/knowledge/library_page.dart:15-19`.)

# 23. Kết quả

Đối chiếu mã nguồn, sản phẩm có root auth guard, đăng nhập/đăng ký/Google theo cấu hình, secure session và chuyển workspace; shell Chat/Library thích ứng độ rộng; chat gửi SSE, reducer xử lý text/tool/citation, hội thoại cục bộ; Library tra cứu/xem tài liệu, upload/process theo quyền; Access requests có hành động duyệt/từ chối/hủy. Đây là **kết quả implementation có chứng cứ từ source**, không phải báo cáo đã chạy backend, đo hiệu năng, chụp màn hình, hay kiểm chứng câu trả lời trên UTE. (Nguồn: `app/lib/app/app.dart:19-92`; `app/lib/app/workspace_shell.dart:206-297`; `app/lib/features/chat/models/chat_stream.dart:22-151`; `app/lib/features/knowledge/library_page.dart:101-143,305-367`; `app/lib/features/requests/requests_page.dart:119-243`.)

Lợi ích học thuật phù hợp môn học là minh họa cách một client Flutter duy trì trạng thái phiên, tổ chức nhiều luồng UI, xử lý HTTP streaming và mở nguồn có kiểm quyền trên thiết bị. Đánh giá định lượng (thời gian phản hồi, độ chính xác, số người dùng) và bằng chứng demo cần phép đo riêng; không đưa con số giả định vào phần kết quả. (Nguồn: `app/lib/features/auth/session.dart:58-83`; `app/lib/features/chat/services/chat_service.dart:29-125`; `app/lib/features/knowledge/document_page.dart:83-122`.)

# 24. Hạn chế & Hướng phát triển

Lịch sử conversation chỉ nằm trên thiết bị và tách theo account/workspace; không có đồng bộ đa thiết bị. Mobile không có Home/Profile/Workspace Management độc lập, không có UI members hay collection CRUD/ACL; các thao tác backend tương ứng không nên được tính là đã hoàn thành ở Flutter. Citation và nội dung câu trả lời cần backend, tài liệu được phép đọc và annotation thật; Google login cần cấu hình đúng; kết quả với UTE chưa thể khẳng định từ source. (Nguồn: `app/lib/features/chat/services/conversation_store.dart:7-26`; `app/lib/app/workspace_shell.dart:10-14,139-193,206-235`; `app/lib/features/knowledge/library_page.dart:15-19`; `backend/docs_design/conversation_loop.md:87-107`; `backend/docs_design/auth_contract.md:132-134`.)

**Hướng phát triển, không phải cam kết thực hiện:** nếu yêu cầu sản phẩm thay đổi, có thể thiết kế sync conversation an toàn; mở màn hình xem thành viên/chia sẻ collection với UX đơn giản và quyền server nhất quán; bổ sung quy trình nghiên cứu người dùng, accessibility và đánh giá trên thiết bị thực; xây dựng bộ dữ liệu UTE được xác minh để đánh giá câu trả lời/citation. Những điểm này không nằm trong kết quả hiện tại và không được mô tả như màn hình đã demo.

# 25. Nội dung Report hoàn chỉnh

## 1. Giới thiệu đề tài

BoMesh Mobile là ứng dụng Flutter/Dart để người dùng hỏi đáp trên tri thức của workspace, đọc tài liệu và kiểm chứng nguồn. Trong đồ án, workspace UTE là bối cảnh minh họa dự kiến, còn BoMesh vẫn là nền tảng Knowledge + AI Assistant phục vụ các workspace nói chung. Trọng tâm nghiên cứu và triển khai được trình bày là tương tác trên thiết bị di động, không phải thiết kế hạ tầng AI hay một chatbot chỉ dùng cho UTE. Mã nguồn app hiện có hai tab Chat và Library sau xác thực. (Nguồn: `app/pubspec.yaml:1-20`; `app/lib/app/workspace_shell.dart:10-14,206-235`; `backend/docs_design/api_contract.md:10-38`.)

## 2. Bối cảnh và vấn đề

Tra cứu một quy định trên điện thoại thường đòi hỏi tìm đúng tài liệu, đọc phần liên quan và giữ ngữ cảnh để hỏi tiếp. Một câu trả lời AI không gắn nguồn làm người dùng khó biết phải tin nội dung nào; một danh sách file thuần túy lại chưa giúp đặt câu hỏi bằng ngôn ngữ tự nhiên. BoMesh Mobile nối hai thao tác trong cùng app: Chat nhận phản hồi dần và dẫn về DocumentPage; Library là điểm bắt đầu khi đã biết cần tìm tài liệu. Câu hỏi tốt nghiệp của sinh viên chỉ là ví dụ flow, không phải khẳng định quy định UTE đã có trong hệ thống. (Nguồn: `app/lib/features/chat/chat_page.dart:239-315`; `app/lib/features/knowledge/library_page.dart:180-301`; `app/lib/features/chat/widgets/message_view.dart:227-238`.)

## 3. Mục tiêu đề tài

Mục tiêu trải nghiệm là cho phép đăng nhập, chuyển giữa các workspace mình thực sự tham gia, hỏi–đọc–kiểm chứng tri thức với số bước ít trên màn hình nhỏ, và quan sát được khi assistant còn xử lý hoặc có lỗi. Mục tiêu kỹ thuật Flutter là root navigation theo session; feature widgets có trách nhiệm rõ; ChangeNotifier cho phiên/chat, `setState` cho state cục bộ; HTTP JSON và SSE; secure token cùng conversation history cục bộ theo account/workspace. Những mục tiêu này được cụ thể hóa bằng các lớp đang có, không gắn nhãn framework quản lý state khác. (Nguồn: `app/lib/app/app.dart:48-92`; `app/lib/features/auth/session.dart:58-83`; `app/lib/features/chat/state/chat_controller.dart:13-34`; `app/lib/features/chat/services/chat_service.dart:29-125`.)

## 4. Phạm vi đồ án

Trong phạm vi hiện tại có AuthPage, WorkspaceShell, ChatPage, LibraryPage, DocumentPage và RequestsPage, cùng các luồng upload/process tài liệu theo quyền. Không nằm trong phạm vi mobile hiện tại: màn hình Home/Profile riêng, quản trị members, CRUD/chia sẻ collection và ACL editor, đồng bộ hội thoại giữa máy. Việc backend định nghĩa collection ACL không làm mobile tự nhiên có giao diện quản trị đó. Đề tài chỉ mô tả UTE là tenant mục tiêu để minh họa, không giả lập nội dung quy chế hay số lượng thành viên. (Nguồn: `app/lib/app/app.dart:70-89`; `app/lib/app/workspace_shell.dart:10-14,139-193,206-235`; `app/lib/features/knowledge/library_page.dart:15-19`; `backend/docs_design/api_contract.md:183-211`.)

## 5. Tổng quan BoMesh Mobile

App khởi động, kiểm tra session đã lưu, sau đó hiển thị đăng nhập hoặc shell của workspace. Tab Chat tập trung hỏi đáp, lịch sử, đính kèm và mở citation; tab Library tập trung tìm, duyệt collection và xem tài liệu. Nút tài khoản là nơi xem tên/email, workspace hiện tại, Access requests và đăng xuất. Đường chuyển từ một tài liệu sang Chat tạo câu hỏi có tham chiếu tài liệu chứ không cần sao chép tệp. (Nguồn: `app/lib/app/app.dart:19-36,48-92`; `app/lib/app/workspace_shell.dart:56-61,139-193,206-235`; `app/lib/features/chat/state/chat_controller.dart:302-331`.)

## 6. Đối tượng người dùng

Nhóm người dùng chính có thể là sinh viên/end user trong workspace được cấp quyền đọc tri thức: đăng nhập, hỏi, xem câu trả lời có nguồn, tìm và mở tài liệu. Persona này là **mô hình phân tích nhu cầu**, không phải chứng cứ về một tài khoản UTE hoặc dữ liệu học vụ cụ thể. Nhóm thứ hai là người có trách nhiệm quản lý yêu cầu: ngoài luồng người dùng chung, họ có thể xem badge và quyết định yêu cầu pending đúng loại nếu có `access.manage`/`source.manage`. Chức năng quản trị thành viên và chỉnh ACL collection chưa có trên mobile; gọi người này là manager không biến app thành admin console. (Nguồn: `app/lib/features/chat/state/chat_controller.dart:45-47`; `app/lib/features/requests/requests_page.dart:8-25,177-243`; `app/lib/app/workspace_shell.dart:10-14,63-82`.)

## 7. Phân tích yêu cầu

Yêu cầu được rút thành ba đường sử dụng: (1) bảo vệ và duy trì session; (2) hỏi, theo dõi phản hồi và kiểm chứng citation; (3) duyệt/tra cứu tài liệu trong phạm vi quyền, đồng thời nhận biết có/không thể thao tác. Để không nhầm một màn hình thiết kế với chức năng hiện thực, yêu cầu “xem members/chỉnh access” được ghi nhận là gap: mã Flutter chỉ có chuyển workspace và Access requests. Chất lượng tương tác đòi hỏi loading, empty, lỗi kết nối và lỗi quyền được phân biệt; không đưa các chỉ tiêu số liệu chưa đo. (Nguồn: `app/lib/features/auth/session.dart:96-120,207-279`; `app/lib/features/chat/chat_page.dart:216-249,302-315`; `app/lib/features/knowledge/document_page.dart:180-207`; `app/lib/app/workspace_shell.dart:10-14`.)

## 8. Use Case Mobile

UC đăng nhập: nhập thông tin, nhận session, đến hai tab; nếu khôi phục phiên thất bại thì ở AuthPage. UC hỏi đáp: soạn câu hỏi, tùy chọn tài liệu/collection, xem assistant tạo câu trả lời dần, bấm citation rồi hỏi tiếp. UC Library: tìm kiếm, mở collection, xem preview/text/details và “Ask document”. UC xét yêu cầu: mở account → Access requests → xác nhận Approve/Deny với yêu cầu đủ quyền hoặc Cancel yêu cầu của mình còn pending. Luồng lỗi gồm token hết hạn, network gián đoạn và tài liệu mất quyền; app không được hiển thị dữ liệu bị chặn. (Nguồn: `app/lib/app/app.dart:70-89`; `app/lib/features/chat/state/chat_controller.dart:429-539`; `app/lib/features/knowledge/library_page.dart:180-301,305-367`; `app/lib/features/requests/requests_page.dart:119-243`; `app/lib/features/knowledge/document_page.dart:110-122`.)

## 9. Thiết kế UI/UX

Giao diện tổ chức theo nhiệm vụ: Chat ở tab mặc định, Library bên cạnh; tiêu đề và nút Account luôn gần tay; bottom navigation ở màn nhỏ, rail ở màn rộng. Chat đưa lịch sử vào drawer, composer ở đáy, vùng message cuộn và trạng thái assistant đủ rõ để người dùng không gửi trùng trong lúc đợi. Library dùng hai phân đoạn My files/Workspace, ô tìm và hàng collection/tài liệu; DocumentPage tách Preview/Text/Details để tránh nhồi mọi thông tin vào một khung. Quyền được thể hiện qua việc ẩn tác vụ không phù hợp và nêu thông báo khi nguồn không thể xem. (Nguồn: `app/lib/app/workspace_shell.dart:206-297`; `app/lib/features/chat/chat_page.dart:130-180,183-319`; `app/lib/features/knowledge/library_page.dart:180-301`; `app/lib/features/knowledge/document_page.dart:180-207,257-269`.)

## 10. Screen Flow

```text
Khởi động → khôi phục phiên → {AuthPage | WorkspaceShell}
AuthPage → Chat mặc định ↔ Library
Chat → citation → DocumentPage → quay lại Chat
Library → collection detail → DocumentPage → Ask document → Chat
Account sheet → {Switch workspace | Access requests | Sign out}
```

Không có bước Home giữa login và Chat. Collection detail mở từ Library; RequestsPage chỉ mở qua menu tài khoản. Sau đổi workspace, phiên mới kéo theo một shell mới nên không giữ đường dẫn resource của workspace trước. (Nguồn: `app/lib/app/app.dart:53-89`; `app/lib/app/workspace_shell.dart:74-114,139-193,206-297`; `app/lib/features/knowledge/library_page.dart:132-143,305-367`.)

## 11. Navigation

Root `Navigator(pages: [MaterialPage(...)])` quyết định `/sign-in` hoặc `/workspace` theo session, với key phụ thuộc namespace và token. `WorkspaceShell` chuyển tab bằng `NavigationBar` hoặc `NavigationRail` và dùng `IndexedStack`; từ tab Library, nút Back về Chat. Các trang chi tiết dùng `Navigator.push`/`MaterialPageRoute`, ví dụ `/requests` hoặc collection detail, thay vì khai báo tuyến bằng go_router. Cấu trúc này kết hợp navigation khai báo ở ranh giới xác thực với push/pop cho luồng ngắn. (Nguồn: `app/lib/app/app.dart:70-89`; `app/lib/app/workspace_shell.dart:74-82,237-297`; `app/lib/features/knowledge/library_page.dart:132-143`.)

## 12. Kiến trúc Flutter Application

Trục ứng dụng gồm `ProductApp` tạo `ApiClient`/`SessionController`, `WorkspaceShell` cấp client gắn token của workspace, các feature page sở hữu controller và widget của mình. Chat tách `ChatService` gửi/nhận SSE, `ChatStreamReducer` hợp nhất sự kiện vào model và `ConversationStore` ghi lịch sử trên máy; Library/Document/Requests dùng API client và state trong StatefulWidget. Đây là kiến trúc feature-first, không tuyên bố tuân theo một phân lớp Clean Architecture có repository/domain/use-case riêng. (Nguồn: `app/lib/app/app.dart:19-30`; `app/lib/app/workspace_shell.dart:30-48`; `app/lib/features/chat/chat_page.dart:40-63`; `app/lib/features/chat/models/chat_stream.dart:22-151`; `app/lib/features/chat/services/conversation_store.dart:7-26`.)

## 13. Cấu trúc source code Flutter

`lib/app` chứa config, theme, root và shell; `lib/core` là transport/upload helper; `lib/features/auth` chứa trang xác thực/session; `lib/features/chat` tách models/state/services/widgets; `lib/features/knowledge` chứa Library, list, viewer, upload; `lib/features/requests` xử lý các yêu cầu. Các package thực tế gồm Flutter SDK, `http`, `shared_preferences`, `flutter_secure_storage`, `google_sign_in`, `file_picker`, `flutter_markdown_plus`, `url_launcher`; mô tả source dựa trên tên file và dependency, không gán thêm Riverpod, Dio hay go_router. (Nguồn: `app/lib/app/app.dart:1-10`; `app/lib/features/chat/chat_page.dart:1-16`; `app/lib/features/knowledge/library_page.dart:1-11`; `app/pubspec.yaml:9-20`.)

## 14. Widget Architecture

Ở Chat, ChatPage phối hợp ChatSidebar, ChatMessageView, ChatComposer và WelcomeView. Sidebar lo lựa chọn/tìm hội thoại, message view diễn giải nội dung và nguồn, composer lo nhập và chọn attachment/scope; controller không tự vẽ UI. Ở Library, LibraryPage dùng SearchBar/SegmentedButton/DocumentList; collection detail tái dùng danh sách tài liệu; DocumentPage chia các tab Preview/Text/Details. RequestsPage xây card cho nhóm chờ mình quyết và nhóm do mình gửi. Cách tổ hợp widget này giới hạn phạm vi rebuild và cho phép cùng một DocumentPage phục vụ lối vào citation hoặc Library. (Nguồn: `app/lib/features/chat/chat_page.dart:13-16,130-180,239-315`; `app/lib/features/knowledge/library_page.dart:180-220,245-267,305-367`; `app/lib/features/knowledge/document_page.dart:83-105,257-269`; `app/lib/features/requests/requests_page.dart:177-243`.)

## 15. State Management

`SessionController` và `ChatController` kế thừa ChangeNotifier; `AnimatedBuilder` dựng lại root và ChatPage theo thông báo; các trang Library/Document/Requests dùng `setState` cho loading, dữ liệu, truy vấn, tab hoặc lỗi cục bộ. Trạng thái chat chia status gửi/streaming và turn có text, tool, reasoning, annotation; reducer bỏ sự kiện sequence cũ trước khi cập nhật. State workspace trên mobile chỉ gồm active session, tab và yêu cầu truy cập, không có state members/ACL editor. Khi restore một turn bị dở, store đánh dấu failed/interrupted để không hiển thị spinner vĩnh viễn. (Nguồn: `app/lib/features/auth/session.dart:58-83`; `app/lib/app/app.dart:48-92`; `app/lib/features/chat/chat_page.dart:130-180`; `app/lib/features/chat/state/chat_controller.dart:13-34,476-530`; `app/lib/features/chat/models/chat_stream.dart:22-151`; `app/lib/features/chat/services/conversation_store.dart:55-73`.)

## 16. Authentication

Màn AuthPage gửi password login tới `POST /auth/sessions` (`method: password`) hoặc đăng ký tại `POST /auth/accounts`. Tùy cấu hình, Google sign-in lấy ID credential rồi gửi `method: google` tới cùng endpoint; không nhúng secret vào Flutter. Token lưu trong platform secure storage theo API origin, được xác minh bằng `GET /auth/session` ở lần mở app và lúc về foreground. Token hết hạn/401 đưa người dùng về đăng nhập; logout cố thu hồi session server và luôn xóa credential phía thiết bị, kèm cảnh báo nếu server không xác nhận. `PATCH /auth/session` chỉ đổi sang workspace đã có membership và nhận phiên thay thế. (Nguồn: `app/lib/features/auth/session.dart:58-75,96-142,179-279`; `app/lib/app/app.dart:23-36,70-89`; `backend/docs_design/auth_contract.md:50-82,89-103,113-134`.)

## 17. API Integration

`ApiClient` tạo URL trong `/api/v1`, gắn `Authorization: Bearer`, encode JSON, decode response và giữ code/status/request ID trong `ApiException`; lỗi 401 của token đang sử dụng có thể vô hiệu phiên. Request JSON có timeout 45 giây; upload multipart có timeout 5 phút và `Idempotency-Key`. Chat khác request thường vì phải giữ `http.Client` và đọc `StreamedResponse`; các trang khác gọi client theo endpoint tài nguyên. Không giả định có cơ chế retry tổng quát tự động; người dùng có nút thử lại ở một số trạng thái lỗi. (Nguồn: `app/lib/core/api_client.dart:25-49,51-120,123-206`; `app/lib/features/chat/services/chat_service.dart:29-125`; `app/lib/features/knowledge/library_page.dart:223-235`.)

## 18. Chatbot trên Mobile

Composer hỗ trợ văn bản, tệp được chọn trên máy, tài liệu có sẵn và collection scope. Controller chặn gửi khi đang tạo câu trả lời/upload, có attachment lỗi hoặc vượt giới hạn, rồi tạo user message và assistant turn trước khi gọi mạng để phản hồi UI ngay. Tin nhắn assistant có trạng thái hoạt động tìm kiếm/đọc nguồn khi server phát event; người dùng có thể Stop, Regenerate, Edit request. Chat là giao diện cho agent phía server: Flutter không tự quyết định tool, không tự tổng hợp một đáp án tốt nghiệp từ dữ liệu không được xác thực. (Nguồn: `app/lib/features/chat/state/chat_controller.dart:265-281,302-349,429-530`; `app/lib/features/chat/widgets/chat_composer.dart:62-123,229-302,390-486`; `app/lib/features/chat/widgets/message_view.dart:200-215,404-448`; `backend/docs_design/conversation_loop.md:5-16,87-99`.)

## 19. Streaming Response

`ChatService` gửi `POST /api/v1/agent/chat` với `Accept: text/event-stream`, đọc `response.stream`, giải mã UTF-8 rồi tách dòng và gom nhiều dòng `data:` thành một event JSON. `ChatStreamReducer` áp dụng sequence number, text delta, reasoning, tool progress, citation annotation và terminal event vào cùng turn; `notifyListeners` làm message hiện chữ mới. Stop đóng stream client; cuối luồng thiếu completion thành lỗi gián đoạn. Lưu cục bộ định kỳ 700 ms và sau kết thúc bảo vệ lịch sử khi có nhiều token. Trạng thái “đang tìm kiếm” chỉ hiện nếu tool event thật có mặt, không phải bước mặc định. (Nguồn: `app/lib/features/chat/services/chat_service.dart:29-125`; `app/lib/features/chat/models/chat_stream.dart:22-151`; `app/lib/features/chat/state/chat_controller.dart:476-539`; `app/lib/features/chat/widgets/message_view.dart:404-505`.)
Luồng UI thực tế không dùng literal tiếng Việt “Đang phân tích...”/“Đang tìm kiếm...”: chờ là chỉ báo BoMesh, còn hoạt động tìm kiếm chỉ có khi nhận `knowledge_search` và mang nhãn tiếng Anh “Searching your knowledge…”. (Nguồn: `app/lib/features/chat/widgets/message_view.dart:484-544,641-660`.)


## 20. Citation

Backend trả annotation mang nguồn, còn client trình bày `[n]` trong câu trả lời và danh sách sources. Chạm nguồn mở viewer bằng document/chunk ID; viewer lấy lại quyền truy cập và hiển thị passage phù hợp trong Preview hoặc Text, với Details cho thông tin tệp. Cùng tài liệu có thể có nhiều passage nhưng số hiển thị được gộp theo document; nếu không có preview trang, text trích dẫn vẫn là đường đọc hợp lệ. Khi 401/403/404, viewer xóa dữ liệu cũ và báo nguồn không khả dụng. Chỉ có thể khẳng định citation UTE trong demo nếu câu trả lời thật có annotation và tài liệu được phép xem. (Nguồn: `app/lib/features/chat/widgets/message_view.dart:227-238,345-356,507-550`; `app/lib/features/knowledge/document_page.dart:83-122,180-207,336-475,479-555`; `backend/docs_design/conversation_loop.md:109-126`.)
Danh sách nguồn chỉ hiện khi tin assistant đã settled; khi người dùng chạm nguồn, `DocumentPage` được truyền chính xác `source.itemId` và `source.chunkId`. (Nguồn: `app/lib/features/chat/widgets/message_view.dart:144-169,252-260`.)


## 21. Conversation Management

Mỗi tài khoản và workspace có namespace `userId:activeWorkspaceId`; `ConversationStore` dùng SharedPreferencesAsync giữ danh sách, messages và ID hội thoại được chọn. Người dùng có thể tìm tiêu đề/nội dung, ghim, đổi tên, xóa; bản ghi streaming chưa hoàn tất được nhận diện là gián đoạn sau khởi động lại. Lịch sử này không phải server-side conversation sync: một thiết bị khác không tự có cùng danh sách. Xóa hội thoại không được hiểu là xóa tài liệu Library mà chat tham chiếu; client chỉ giải phóng upload do conversation sở hữu và không còn hội thoại lưu nào tham chiếu. (Nguồn: `app/lib/features/auth/session.dart:47-50`; `app/lib/features/chat/services/conversation_store.dart:7-26,42-73,104-174`; `app/lib/features/chat/state/chat_controller.dart:393-427`; `backend/docs_design/conversation_loop.md:100-107`.)

## 22. Knowledge Module

Library là cửa vào tri thức dành cho người dùng: My files và Workspace, tìm kiếm, danh sách tài liệu hoặc collection, rồi DocumentPage. Khi có từ khóa ở Workspace, app hiển thị kết quả tài liệu phù hợp; không tìm thì hiển thị collection có quyền. DocumentPage yêu cầu đồng thời viewer và metadata, cho đọc hình trang nếu có, văn bản nguồn, thông tin file và mở tệp gốc bằng signed URL được cấp lại trước khi mở. Tải lên/process theo quyền là các tác vụ gắn với tài liệu, không đặt toàn bộ giao diện thành một ingestion dashboard. (Nguồn: `app/lib/features/knowledge/library_page.dart:62-99,180-301`; `app/lib/features/knowledge/document_page.dart:70-160,257-269,336-475,479-585`; `app/lib/features/knowledge/upload_sheet.dart:125-166`.)

## 23. Collection Module

Collection gom những tài liệu cùng ngữ cảnh sử dụng; người dùng mở collection được phép đọc để xem danh sách, chọn một tài liệu hoặc hỏi AI về nó. Collection detail có FAB Upload khi có `collection.update`; có thể bật Process now khi có `ingestion.run`. Mobile **không** có form tạo/sửa/xóa collection hay giao diện chia sẻ/cập nhật ACL. Backend sở hữu API cho các tác vụ đó, nhưng chúng không phải kết quả của module Flutter hiện tại. Ví dụ tên collection về đào tạo UTE chỉ được sử dụng khi dữ liệu thực tế đã được xác minh. (Nguồn: `app/lib/features/knowledge/library_page.dart:15-19,269-301,305-367`; `app/lib/features/knowledge/upload_sheet.dart:125-166,237-251`; `backend/docs_design/api_contract.md:183-211`.)

## 24. Workspace Management

App thể hiện workspace qua session và account bottom sheet: đọc tên hiện tại, chọn workspace khác mà tài khoản tham gia, sau đó đổi token/session và khởi tạo lại shell theo scope mới. Tác vụ quản lý khả dụng trên mobile là xem số yêu cầu cần mình quyết và mở Access requests. App không hiện overview, danh sách members, điều chỉnh role/group, collection ACL hoặc màn workspace quản trị chuyên biệt. Nói “Workspace Manager chỉnh Access trên mobile” là sai với hiện trạng; giao diện web console hoặc API không được cộng vào phần đã triển khai Flutter. (Nguồn: `app/lib/app/workspace_shell.dart:10-14,30-48,63-114,139-193`; `app/lib/features/auth/session.dart:207-242`; `app/lib/app/app.dart:70-89`.)

## 25. Permission UX

Client đưa quyền thành affordance: không hiện nút không thể thực hiện, cho biết khi không có `knowledge.read`, và chặn nội dung viewer khi nguồn không còn được phép đọc. Effective collection permission quyết định upload/xóa tài liệu, `ingestion.run` quyết định nút xử lý; server vẫn phải lọc kết quả và xét mọi request. Trang Access requests nhóm riêng yêu cầu chờ mình duyệt và yêu cầu do mình gửi: chỉ người có quyền đúng loại được Approve/Deny pending sau xác nhận; chính người gửi Cancel pending. Điều này là **quy trình phê duyệt yêu cầu**, khác với trình chỉnh ACL trực tiếp chưa có trên mobile. (Nguồn: `app/lib/features/chat/state/chat_controller.dart:45-47`; `app/lib/features/chat/chat_page.dart:302-315`; `app/lib/features/knowledge/document_list.dart:155-165,234-280`; `app/lib/features/knowledge/document_page.dart:110-122`; `app/lib/features/requests/requests_page.dart:8-25,119-243`; `backend/docs_design/api_contract.md:85-94`.)

## 26. Loading / Error / Empty State

Khi khôi phục phiên, root hiện spinner; Chat hiện spinner khi nạp hội thoại, WelcomeView khi chưa có tin, spinner nhỏ khi assistant làm việc và error banner khi lỗi. Library có spinner, thông báo thử lại khi tải thất bại, thông báo trống cho My files/Workspace/tìm kiếm không kết quả. DocumentPage có trạng thái đang mở, nguồn bị khóa, không có preview hoặc không có text; xử lý tài liệu có pending/processing/failed để giải thích chờ hoặc thử lại. Mỗi trạng thái gắn với hành động tiếp theo; không tuyên bố có skeleton chung cho toàn app. (Nguồn: `app/lib/app/app.dart:53-69`; `app/lib/features/chat/chat_page.dart:216-249,302-315`; `app/lib/features/knowledge/library_page.dart:223-301`; `app/lib/features/knowledge/document_page.dart:180-207,336-475,479-555`; `app/lib/features/knowledge/document_list.dart:137-172`.)

## 27. Mobile ↔ Backend Integration

Flutter dùng một API base URL cấu hình qua compile-time, giữ bearer token và gọi những tài nguyên cần cho UI: session, knowledge home, documents, collection, approval requests; ChatService dùng cùng session để POST SSE. Backend cung cấp lọc quyền, nội dung, luồng agent và điểm giải quyết citation, còn client xử lý vòng đời UI/scroll/history. `ChatRequest` gửi `message`, `conversation_id`, `history`, `collection_ids`, `attachment_ids`, không khai báo tùy ý identity/workspace. Kiến trúc backend và thuật toán truy xuất chỉ được nhắc đủ để giải thích vì sao câu trả lời và nguồn tùy dữ liệu/quyền, không đào sâu vào hạ tầng. (Nguồn: `app/lib/app/app_config.dart:2-16`; `app/lib/core/api_client.dart:35-120`; `app/lib/features/chat/services/chat_service.dart:29-64`; `backend/docs_design/api_contract.md:24-38,156-180`; `backend/docs_design/conversation_loop.md:18-50`.)

## 28. Demo Scenario

Kịch bản sinh viên: xác thực vào workspace UTE đã được chuẩn bị, hỏi một câu liên quan đến tài liệu thực, quan sát stream/tool, mở citation, hỏi tiếp và xem lịch sử. Kịch bản tri thức: tìm tài liệu được cấp quyền ở Library, mở collection và viewer, rồi chọn Ask document. Hai kịch bản này phụ thuộc tài khoản, membership, tài liệu đã xử lý, backend SSE và annotation thật; chưa có bằng chứng đã chạy demo. Kịch bản manager thiết kế ban đầu “mở Workspace/Members/chỉnh Access/Save” phải được **thay bằng** thao tác có trong app: account sheet → đổi workspace nếu có → Access requests → Approve/Deny pending theo quyền hoặc Cancel yêu cầu của mình. Không trình bày chỉnh ACL như một kết quả trình diễn mobile. (Nguồn: `app/lib/app/workspace_shell.dart:10-14,74-114,139-193`; `app/lib/features/knowledge/library_page.dart:180-301,305-367`; `app/lib/features/requests/requests_page.dart:8-25,119-243`; `backend/docs_design/conversation_loop.md:87-107`.)

## 29. Kết quả đạt được

Mã nguồn cho thấy một client Flutter có auth guard, phiên được lưu an toàn/kiểm tra lại, shell hai tab thích ứng, chat SSE và reducer, citation mở nguồn có kiểm quyền, lịch sử cục bộ, Library và document viewer, thao tác tài liệu theo quyền cùng luồng quyết định Access requests. Đây là kết quả **đọc từ implementation**; báo cáo không xác nhận đã chạy API thật, kiểm thử trên máy cụ thể, có ảnh chụp hay trả lời đúng câu hỏi về UTE. Đánh giá chất lượng đáp án và độ trễ chỉ nên ghi sau một phép đo trên bộ dữ liệu thật. (Nguồn: `app/lib/app/app.dart:19-92`; `app/lib/app/workspace_shell.dart:206-297`; `app/lib/features/chat/models/chat_stream.dart:22-151`; `app/lib/features/knowledge/document_page.dart:70-122`; `app/lib/features/requests/requests_page.dart:119-243`.)

## 30. Hạn chế

Conversation history không đồng bộ liên thiết bị, phụ thuộc storage tại máy; chat/citation cần server, tài liệu và quyền hợp lệ. Google login phụ thuộc cấu hình client/provider/server. UI chưa có màn hình quản trị members, collection CRUD/ACL, Home/Profile riêng; việc có API backend không xóa bỏ giới hạn này. Viewer không dựng lại trang gốc từ lời đáp nếu nguồn thiếu preview, và câu hỏi UTE chỉ kiểm chứng được bằng dữ liệu thực. Những hạn chế được nêu đúng ranh giới giữa UI Flutter hiện có và điều kiện môi trường demo. (Nguồn: `app/lib/features/chat/services/conversation_store.dart:7-26`; `backend/docs_design/auth_contract.md:132-134`; `app/lib/features/knowledge/library_page.dart:15-19`; `app/lib/app/workspace_shell.dart:10-14,139-193`; `app/lib/features/knowledge/document_page.dart:336-475`.)

## 31. Hướng phát triển

Nếu có yêu cầu sản phẩm và thiết kế quyền tương ứng, app có thể bổ sung đồng bộ hội thoại có kiểm soát, trải nghiệm quản lý thành viên/collection/access phù hợp điện thoại, hoặc đánh giá truy cập trên nhiều kích thước và điều kiện mạng. Một bộ tri thức UTE được kiểm chứng, tài khoản phân quyền rõ và tiêu chí so sánh đáp án với tài liệu gốc sẽ giúp đánh giá chất lượng thực tế. Đây là **định hướng tương lai**, không phải công việc code mà ba thành viên làm tài liệu đã triển khai, cũng không phải lời cam kết sẽ hoàn thành trong đồ án hiện tại.

## 32. Kết luận

Giá trị của BoMesh Mobile trong môn Lập trình Mobile nằm ở một luồng Flutter có thể hiểu được: xác thực → Chat hoặc Library → hỏi và nhận stream → bấm citation để kiểm chứng; người có quyền có thể xử lý Access requests qua account sheet. App thể hiện ranh giới phiên/workspace và quyền từ góc nhìn người dùng, còn backend là tầng hỗ trợ xác thực và tri thức. Báo cáo giữ hai kết luận tách bạch: những gì mã nguồn mobile đã có và những gì chỉ có thể xác nhận khi chuẩn bị dữ liệu UTE, tài khoản, API và chạy demo thật. Không đánh đồng module web/quản trị hay dự định phát triển với tính năng đã có trên điện thoại. (Nguồn: `app/lib/app/app.dart:70-89`; `app/lib/app/workspace_shell.dart:10-14,139-193,206-297`; `app/lib/features/chat/services/chat_service.dart:29-125`; `app/lib/features/knowledge/library_page.dart:15-19,180-301`.)

# 26. Nội dung PPTX

Khung nói đề xuất: **16 phút / 16 slide**, thêm **3 phút hỏi đáp**. Người trình bày: TV1 nói slide 1–5 (khoảng 5 phút), TV2 nói slide 6–10 (khoảng 5 phút), TV3 nói slide 11–16 (khoảng 6 phút). **Người phụ trách nội dung** có thể khác người đứng nói: TV1 viết slide 1–6; TV2 viết slide 7, 9, 12, 13; TV3 viết slide 8, 10, 11, 14–16. Chủ sở hữu tự viết và duyệt slide của mình; người trình bày dùng lời dẫn đã bàn giao, không có ba người cùng viết một trang. Các số `[1]`–`[43]` trong tài liệu là chú thích nguồn cho người soạn, **không đưa lên mặt slide trình chiếu**. Toàn bộ code, tích hợp, thao tác demo do người thực hiện đồ án đảm nhiệm. Giữ nhãn tiếng Anh của UI và giải thích bằng tiếng Việt. Ảnh nêu dưới đây là **đề xuất chụp từ bản Flutter thật trước khi trình bày**, không khẳng định đã chụp. UTE là tenant minh họa; không giả định dữ liệu UTE, câu hỏi hay tài khoản demo đã sẵn có.

### Slide 01 — Tên đề tài: BoMesh Mobile
- **Thông điệp chính:** Client Flutter/Dart của hệ thống trợ lý tri thức theo workspace, không phải chatbot riêng cho UTE.
- **Mặt slide:**
  - Đồ án cuối kỳ Lập trình Mobile.
  - BoMesh Mobile — hỏi, xem nguồn, làm việc với tài liệu [1].
  - UTE: bối cảnh minh họa cần dữ liệu xác thực.
- **Sơ đồ:** Không cần.
- **Ảnh từ Flutter:** Không cần; dùng tiêu đề chữ, không dựng screenshot hoặc logo trường chưa được cấp.
- **Lời dẫn (TV1, khoảng 80–140 từ):** Em giới thiệu BoMesh Mobile từ góc nhìn môn Lập trình Mobile: đó là một ứng dụng Flutter để người dùng có phiên đăng nhập đặt câu hỏi, đọc lại nguồn tài liệu và truy cập thư viện. Khi nói “UTE”, nhóm chỉ đặt một tình huống sử dụng nhằm giúp hội đồng theo dõi câu chuyện; chưa có căn cứ để nói dữ liệu UTE đã được nạp hoặc câu hỏi tốt nghiệp đã trả lời đúng. Sau khi đăng nhập, giao diện đi vào Chat và Library, không phải một trang Home riêng [1]. Bài thuyết trình tập trung vào điều hướng, vòng đời phiên, trạng thái tương tác và cách kết nối API trên điện thoại.
- **Người phụ trách:** TV1 (slide/lời nói; không nhận code hoặc demo).

### Slide 02 — Bối cảnh & bài toán
- **Thông điệp chính:** Người dùng cần hỏi nhanh nhưng vẫn phải biết câu trả lời dựa vào tài liệu nào và mình có quyền xem hay không.
- **Mặt slide:**
  - Student hỏi thông tin tốt nghiệp: tình huống giả định.
  - Đọc lại nguồn thay vì tin câu trả lời không kiểm chứng [23][24].
  - Quyền workspace/collection giới hạn nội dung [2][41].
- **Sơ đồ:** Không cần.
- **Ảnh từ Flutter:** Không cần; tuyệt đối không dùng câu trả lời, tên văn bản, trường/khoa hoặc chỉ số UTE chưa kiểm chứng.
- **Lời dẫn (TV1, khoảng 80–140 từ):** Giả sử một sinh viên muốn hỏi về một thông tin liên quan tốt nghiệp. Câu hỏi không khó chỉ vì phải có câu trả lời, mà vì người nghe cần kiểm tra lại văn bản làm căn cứ. BoMesh có cơ chế đưa nguồn vào câu trả lời và Flutter có đường chạm số trích dẫn để mở tài liệu liên quan [23][24]. Tuy nhiên, ứng dụng không tự định nghĩa ai được xem dữ liệu: backend lọc nguồn theo quyền workspace và collection trước khi đưa đoạn tài liệu vào câu trả lời [2][41]. Chúng em dùng tình huống UTE để trình bày luồng đó, không biến một kịch bản giả định thành tuyên bố đã triển khai kho tri thức của trường.
- **Người phụ trách:** TV1.

### Slide 03 — Giải pháp BoMesh Mobile
- **Thông điệp chính:** Một client di động nối ba thao tác: hỏi, kiểm tra nguồn và xử lý yêu cầu truy cập theo vai trò.
- **Mặt slide:**
  - Chat: hỏi và theo dõi phản hồi theo dòng [19][20].
  - Library: tìm và mở tài liệu được phép [25][26].
  - Account: chuyển workspace hoặc vào Access Requests [13][29].
- **Sơ đồ:** Không cần; trình bày ba khối tác vụ bằng chữ, chưa cần sơ đồ kỹ thuật.
- **Ảnh từ Flutter:** Có thể dùng ảnh shell hai tab **chỉ sau khi phiên đăng nhập hợp lệ**; account sheet chụp riêng nếu cần, không gọi là Profile screen [1][13].
- **Lời dẫn (TV1, khoảng 80–140 từ):** Giải pháp là trải nghiệm trên điện thoại chứ không phải một giao diện sao chép trang quản trị web. Sinh viên hỏi trong Chat, nhận phản hồi có thể đến từng phần và theo số trích dẫn tới tài liệu. Họ cũng mở Library để xem tệp cá nhân hoặc collection mình được chia sẻ [19][23][25]. Account là một bottom sheet chứa thông tin phiên, workspace hiện tại và đường vào yêu cầu truy cập [13]. Người có quyền thích hợp có thể quyết định một yêu cầu đang chờ; đó không phải quyền chỉnh toàn bộ ACL collection trên điện thoại [29][30]. Ba khối này đủ để kể một hành trình rõ ràng mà không gán thêm màn hình tưởng tượng.
- **Người phụ trách:** TV1.

### Slide 04 — Đối tượng người dùng & Use Case
- **Thông điệp chính:** “Student” và “Manager” là vai trong kịch bản; thao tác thực tế vẫn phụ thuộc session và permission.
- **Mặt slide:**
  - Student: đăng nhập → Chat → nguồn → Library [1][8][23][25].
  - Người có quyền duyệt: Account → Access Requests → Approve/Deny [3][13][29].
  - Người gửi: Cancel request khi còn pending [29].
- **Sơ đồ:** Không cần; hai dòng use case trên mặt slide, không vẽ thêm hệ thống vai trò giả.
- **Ảnh từ Flutter:** Không cần; nếu minh họa request về sau, phải có request pending và phiên được cấp đúng quyền [3].
- **Lời dẫn (TV1, khoảng 80–140 từ):** Hai nhân vật giúp phân biệt việc hỏi kiến thức với việc xét quyền. Sinh viên bắt đầu bằng phiên được backend xác thực, sau đó tìm câu trả lời, mở nguồn và tìm lại tài liệu trong Library [1][8][23][25]. Người đóng vai Manager chỉ được thao tác khi session có `access.manage` cho yêu cầu truy cập tài nguyên hoặc quyền tương ứng đối với loại yêu cầu khác; app còn loại những yêu cầu của chính người duyệt khỏi danh sách chờ xét [3]. Người gửi thấy yêu cầu của mình và có thể hủy khi trạng thái vẫn pending [29]. Đây là luồng minh họa, không khẳng định mọi tài khoản Manager được cấp quyền hay có sẵn yêu cầu UTE.
- **Người phụ trách:** TV1.

### Slide 05 — Mobile Application Overview
- **Thông điệp chính:** App có hai điểm đến chính và một menu ngữ cảnh tài khoản, không có Home/Profile/Workspace Management screen riêng.
- **Mặt slide:**
  - Chat / Library trên NavigationBar điện thoại [1].
  - Account bottom sheet: workspace, Access requests, Sign out [13].
  - Đăng nhập hoặc đăng ký trước khi thấy shell [4][8].
- **Sơ đồ:** Không cần.
- **Ảnh từ Flutter:** Chụp một màn Chat có thanh đáy và account bottom sheet **sau khi đăng nhập**, hoặc hai ảnh Flutter thật đặt cạnh nhau; không gọi bottom sheet là trang Profile [1][13].
- **Lời dẫn (TV1, khoảng 80–140 từ):** Ở quy mô ứng dụng, điểm nhập là trang xác thực. Khi có session hợp lệ, Flutter dựng `WorkspaceShell` gồm hai tab chính; tab Library chỉ được dựng khi đã mở, còn thanh điều hướng trên điện thoại luôn thể hiện Chat và Library [1][4]. Nút avatar không dẫn tới một Profile screen mà mở bottom sheet để xem tài khoản, chuyển workspace nếu tài khoản có hơn một lựa chọn, truy cập yêu cầu và đăng xuất [13]. Quản trị thành viên, nhóm và chia sẻ collection không thuộc các màn này [30]. **Chuyển lời:** TV2 sẽ đi sâu từ cấu trúc tổng quan sang điều hướng Flutter và hành trình hỏi đáp của sinh viên.
- **Người phụ trách:** TV1.

### Slide 06 — Screen Flow & Navigation
- **Thông điệp chính:** Route gốc phụ thuộc session; màn chi tiết mở lên từ ngữ cảnh, không thêm tab giả.
- **Mặt slide:**
  - Navigator pages: `/sign-in` ↔ `/workspace` [4].
  - Chat / Library; màn rộng dùng NavigationRail [1].
  - RequestsPage và DocumentPage mở bằng push/MaterialPageRoute [5][6].
- **Sơ đồ:** **Sơ đồ kỹ thuật 1** để vẽ lại: `SessionController → Navigator(pages) → Sign-in | WorkspaceShell → Chat ⇄ Library`; từ `Account → RequestsPage`, từ `Chat/Library → DocumentPage` [4][5][6].
- **Ảnh từ Flutter:** Chụp thanh hai tab điện thoại **với phiên hợp lệ**; trang chi tiết tài liệu chỉ khi có tài liệu tài khoản được phép mở [1][6].
- **Lời dẫn (TV2, khoảng 80–140 từ):** Sơ đồ này là đường đi trong mã Flutter, không phải sơ đồ backend. `ProductApp` dùng `AnimatedBuilder` để nghe session; khi chưa đăng nhập, `Navigator` cho trang xác thực, còn khi đăng nhập sẽ cho `WorkspaceShell` [4]. Trong shell, người dùng đổi Chat và Library bằng thanh đáy ở kích thước điện thoại; ở màn rộng từ 1000 px, thanh này thay bằng rail bên cạnh [1]. Màn yêu cầu truy cập được đẩy lên từ Account, còn chi tiết tài liệu đến từ hành trình Chat hoặc Library [5][6]. Tên endpoint `/knowledge/home` chỉ là dữ liệu cho Library, không chứng minh có Home screen [7].
- **Người phụ trách nội dung:** TV1; **người trình bày:** TV2.

### Slide 07 — Flutter Architecture
- **Thông điệp chính:** Cấu trúc đơn giản: widget quan sát controller, service gửi HTTP và store giữ lịch sử cục bộ.
- **Mặt slide:**
  - `SessionController`: ChangeNotifier; `AnimatedBuilder` đổi root [4][11].
  - `ChatController` → `ChatService` → SSE reducer → widget [19][20][43].
  - `ConversationStore`: `SharedPreferencesAsync` theo account + workspace [16].
- **Sơ đồ:** **Sơ đồ kiến trúc Flutter** để vẽ: `ProductApp → SessionController → WorkspaceShell`; từ shell tách `ChatPage → ChatController → ChatService → SSE reducer → ChatMessageView` và `LibraryPage → ApiClient`; `ConversationStore → SharedPreferencesAsync` là nhánh lưu cục bộ. Đặt Flutter ở vùng lớn, API ở mép phải, không vẽ tầng backend nội bộ [4][16][19][20][43].
- **Ảnh từ Flutter:** Không cần; mã nguồn kiến trúc không phải screenshot màn hình.
- **Lời dẫn (TV2, khoảng 80–140 từ):** Để quản lý trạng thái mà không dựng một framework điều hướng khác, app dùng controller Flutter và widget quan sát thay đổi. `SessionController` kế thừa `ChangeNotifier`; ở tầng root, `AnimatedBuilder` chọn trang xác thực hay shell theo session [4][11]. Trong Chat, controller điều phối gửi câu hỏi, service nhận stream HTTP, reducer biến sự kiện thành nội dung và trạng thái mà widget hiển thị [19][20][43]. Phần lưu hội thoại dùng `SharedPreferencesAsync` và khóa có namespace từ user ID cùng active workspace ID [16]. Đây là lưu trên thiết bị hiện tại, không phải đồng bộ cloud; khi mở lại một phản hồi dở dang, store đánh dấu gián đoạn thay vì giả vờ stream còn chạy [16].
- **Người phụ trách:** TV2.

### Slide 08 — Chatbot Mobile
- **Thông điệp chính:** Khung chat trên điện thoại tập trung vào nhập câu hỏi, thêm ngữ cảnh và điều khiển lượt trả lời.
- **Mặt slide:**
  - WelcomeView khi chưa có hội thoại cục bộ [14].
  - Nút cộng: tải tệp, chọn từ Library hoặc chọn collection [15].
  - 4.000 ký tự, 10 tệp/câu hỏi, tối đa 20 collection [17][18].
- **Sơ đồ:** Không cần.
- **Ảnh từ Flutter:** Chụp WelcomeView với **namespace chưa có hội thoại**, hoặc menu dấu cộng đang mở; nếu chụp bộ chọn collection thì tên collection phải được trả thật cho tài khoản [14][15][18].
- **Lời dẫn (TV2, khoảng 80–140 từ):** Hành trình của sinh viên bắt đầu ở Chat. Khi chưa có hội thoại lưu trong đúng ngữ cảnh tài khoản và workspace, màn hình chào giúp người dùng bắt đầu thay vì để một vùng trống [14][16]. Dấu cộng cạnh ô nhập gom ba thao tác liên quan câu hỏi: tải một tệp từ thiết bị, lấy một tài liệu đã có trong Library hoặc giới hạn phạm vi collection [15]. Người dùng có thể để bộ chọn trống để tìm trong tất cả nguồn mình được phép xem; chọn tối đa 20 collection [18]. Client cũng có giới hạn văn bản và số tệp để khung soạn dễ điều khiển [17]. Không dùng câu hỏi gợi ý như bằng chứng đã có tài liệu UTE.
- **Người phụ trách nội dung:** TV3; **người trình bày:** TV2.

### Slide 09 — Streaming Response & Citation
- **Thông điệp chính:** Câu trả lời hiện dần qua SSE và có lối quay về nguồn được phép đọc.
- **Mặt slide:**
  - `POST /api/v1/agent/chat` trả `text/event-stream` [19].
  - Reducer xử lý text/tool/reasoning/error theo sequence [20].
  - Citation mở đoạn nguồn; Stop/Retry điều khiển lượt gửi [21][23][24].
- **Sơ đồ:** Không cần; luồng HTTP tổng hợp ở slide 13.
- **Ảnh từ Flutter:** Chụp streaming/citation **chỉ khi backend thật trả các event và nguồn có quyền**; không dựng nhãn tool, số nguồn hay câu trả lời UTE. Nếu chưa có nguồn, dùng ảnh giao diện Chat thực tế [19][20][23].
- **Lời dẫn (TV2, khoảng 80–140 từ):** Khi sinh viên gửi câu hỏi, Flutter gửi một POST kèm history và các ID của tài liệu hoặc collection đã chọn, rồi đọc từng dòng sự kiện SSE [19]. Reducer ghép text theo thứ tự, cập nhật hoạt động tool, reasoning và trạng thái hoàn tất hoặc lỗi; widget phản ánh những gì đã đến, không phải một animation văn bản giả [20]. Người dùng có thể dừng stream và thử lại bằng một request mới [21]. Nếu backend trả trích dẫn, số nguồn trong câu trả lời trở thành liên kết mở `DocumentPage` ở đoạn dẫn tương ứng [23][24]. Trích dẫn và việc tìm đúng nguồn phụ thuộc tài liệu đã được xử lý và quyền thực tế, nên không cam kết một kết quả cụ thể cho UTE.
- **Người phụ trách:** TV2.

### Slide 10 — Knowledge & Collections
- **Thông điệp chính:** Library là nơi đọc/tìm tài liệu và tải tệp theo quyền, không phải màn CRUD/ACL collection.
- **Mặt slide:**
  - `My files` / `Workspace`: tìm và mở collection được chia sẻ [25][26].
  - DocumentPage: Preview, Text, Details, Open original [31][32][33].
  - Upload và Process now theo quyền tương ứng [35][37].
- **Sơ đồ:** Không cần.
- **Ảnh từ Flutter:** Chụp Library khi tài khoản thấy dữ liệu thật; Preview có ảnh/trích dẫn chỉ nếu backend cấp ảnh/tọa độ, còn tài liệu Office/text nên minh họa tab Text. Upload sheet chỉ khi chọn tệp thật [25][31][34][36].
- **Lời dẫn (TV2, khoảng 80–140 từ):** Sau câu trả lời, sinh viên sang Library để tìm lại tài liệu của mình hoặc duyệt collection chung đã được cấp quyền [25][26]. Khi mở tài liệu, Flutter cho xem Preview nếu có trang ảnh, Text cho các đoạn nguồn và Details cho trạng thái cùng thông tin tệp; liên kết bản gốc được lấy lại lúc mở [31][32][33]. My files có thao tác tải tệp, còn collection chung chỉ có nút Upload nếu người dùng được cập nhật nó [35]. Bước Process now là một yêu cầu xử lý riêng theo `ingestion.run`, không tự xảy ra chỉ vì upload đã xong [37][38]. **Chuyển lời:** TV3 sẽ nói phần quyền mobile và ranh giới tích hợp API.
- **Người phụ trách nội dung:** TV3; **người trình bày:** TV2.

### Slide 11 — Workspace trên mobile: chuyển ngữ cảnh & Access Requests
- **Thông điệp chính:** Mobile cho chuyển workspace và xử lý yêu cầu truy cập, không có màn chỉnh ACL hay quản trị workspace.
- **Mặt slide:**
  - Account bottom sheet → Switch nếu có nhiều workspace [13].
  - `Waiting for you`: Approve/Deny; `Your requests`: Cancel pending [3][29].
  - Chỉnh ACL, role/group, quản trị workspace không có UI mobile [30].
- **Sơ đồ:** Không cần.
- **Ảnh từ Flutter:** Chụp Switch **chỉ khi account thuộc ≥2 workspace**; chụp dialog Approve/Deny **chỉ nếu reviewer có quyền và một yêu cầu pending của người khác**. Nếu thiếu điều kiện, chụp `Your requests` hoặc trạng thái rỗng thật [3][13][29].
- **Lời dẫn (TV3, khoảng 80–140 từ):** Giờ ta đổi từ sinh viên sang người xử lý yêu cầu. Account sheet cho biết workspace đang hoạt động; nếu thuộc nhiều workspace, người dùng chọn workspace khác và Flutter nhận session thay thế từ backend [13]. Trong `Access requests`, danh sách `Waiting for you` chỉ có những yêu cầu đang chờ mà quyền của người đó cho phép quyết định. Nút Approve hoặc Deny mở dialog rồi cập nhật trạng thái; `Your requests` cho phép hủy yêu cầu của chính mình nếu vẫn pending [3][29]. Không gọi trang này là Workspace Management hay màn sửa Access. Mobile không có UI thêm người, sửa role/group hoặc thay ACL collection, dù API backend có tài nguyên liên quan [30].
- **Người phụ trách:** TV3.

### Slide 12 — State Management & API Integration
- **Thông điệp chính:** Flutter phản ứng với phiên, lỗi và tiến độ thay vì chỉ hiển thị trạng thái thành công.
- **Mặt slide:**
  - Secure token, restore/resume session và hết hạn [11][12].
  - 401 quay về xác thực; đổi workspace nhận token mới [13][39].
  - Upload có trạng thái tệp; chat đánh dấu lượt bị ngắt [16][36].
- **Sơ đồ:** Không cần.
- **Ảnh từ Flutter:** Có thể chụp loading lúc khôi phục phiên hoặc lỗi upload **chỉ khi trạng thái thật xảy ra**; không tạo thông báo thất bại giả [4][36].
- **Lời dẫn (TV3, khoảng 80–140 từ):** Trên điện thoại, nhiều việc có thể bị ngắt giữa chừng. `SessionController` lưu access token trong secure storage, kiểm tra lại khi khởi động và khi ứng dụng tiếp tục, rồi loại session hết hạn [11][12]. `ApiClient` đính bearer token và báo tình huống 401 về điều khiển phiên; đổi workspace dùng PATCH để nhận token mới, không chỉ đổi nhãn trên màn [13][39]. Trong một lượt tải nhiều tệp, sheet biểu diễn tệp nào đang gửi, đã xong hoặc lỗi và cho thử lại tệp lỗi [36]. Lịch sử chat lưu trên thiết bị theo account/workspace; phản hồi đang streaming khi khôi phục được đánh dấu gián đoạn, không hiển thị như đang chạy [16].
- **Người phụ trách nội dung:** TV2; **người trình bày:** TV3.

### Slide 13 — Mobile ↔ Backend Flow
- **Thông điệp chính:** Mobile phụ trách điều hướng và diễn giải sự kiện; backend giữ phiên, quyền và nguồn tri thức.
- **Mặt slide:**
  - Bearer/session là ranh giới danh tính [39].
  - Chat dùng POST/SSE; Library/Document đọc API tài nguyên [19][40].
  - Nguồn trích dẫn được server lọc quyền và kiểm tra lại [2][41].
- **Sơ đồ:** **Sơ đồ tích hợp Mobile ↔ API** để vẽ lại: `Flutter UI → Controller → ApiClient(http + Bearer) → /api/v1`; nhánh `Chat /agent/chat → SSE → reducer → UI`; nhánh `Library /knowledge/home, /documents → UI`; nhánh `Access /approval-requests → dialog → PATCH` [19][20][29][39][40][42].
- **Ảnh từ Flutter:** Không cần; tự vẽ sơ đồ từ mã, không dùng ảnh server hoặc log giả.
- **Lời dẫn (TV3, khoảng 80–140 từ):** Sơ đồ tích hợp này chỉ giữ những điểm giao tiếp cần hiểu để giải thích ứng dụng mobile. Flutter xây màn, giữ trạng thái tương tác và gửi yêu cầu với bearer token; request không được tự đặt user ID hay workspace ID để lấy quyền [39]. Chat nhận SSE từ một POST, còn Library và tài liệu đọc các endpoint tài nguyên để hiển thị thứ phiên đó được phép xem [19][40]. Khi một nguồn được dùng để trả lời, backend lọc và kiểm tra lại quyền trước khi trao nội dung cho agent [2]. Quyết định yêu cầu truy cập cũng là PATCH chỉ sau khi người dùng xác nhận trên giao diện [29]. Trọng tâm ở đây là ranh giới client/server, không đi sâu vào nội bộ mô hình AI.
- **Người phụ trách nội dung:** TV2; **người trình bày:** TV3.

### Slide 14 — Demo Scenario
- **Thông điệp chính:** Một đường đi Student → Chat/Library → reviewer duyệt request; bước nào thiếu dữ liệu thì nói đúng điều kiện.
- **Mặt slide:**
  - Student đăng nhập → Chat → nguồn → Library [8][23][25].
  - Reviewer vào Account → Access Requests → xác nhận quyết định [3][13][29].
  - Không có bước Manager chỉnh ACL trên mobile [30].
- **Sơ đồ:** Không cần; ba bước theo thời gian bằng chữ, không thêm sơ đồ kỹ thuật thứ ba.
- **Ảnh từ Flutter:** Nếu có, dùng hai ảnh thật: câu trả lời có nguồn **khi backend đã xử lý tài liệu và trả trích dẫn**, Access Requests **khi có request pending/reviewer hợp lệ**; nếu chưa có, thay bằng trạng thái UI thật và ghi rõ sự phụ thuộc [3][23].
- **Lời dẫn (TV3, khoảng 80–140 từ):** Kịch bản này là đường dẫn cho người demo, không phải lời khẳng định demo đã chạy. Bắt đầu với một tài khoản sinh viên thuộc workspace minh họa, nhập câu hỏi mà tài liệu và nội dung đã được xác thực trước. Nếu backend trả câu trả lời có trích dẫn, chạm nguồn và mở tài liệu, sau đó sang Library xem tập tài liệu mình được phép truy cập [2][23][25]. Đổi sang tài khoản reviewer có quyền tương ứng và một yêu cầu pending thật, mở Account rồi Access Requests để xác nhận quyết định [3][13][29]. Không thêm bước chỉnh ACL collection vì Flutter không có màn này [30]. Nếu thiếu quyền hoặc dữ liệu, chỉ trình bày trạng thái thật và giới hạn hiện tại.
- **Người phụ trách:** TV3.

### Slide 15 — Kết quả đạt được trong mã mobile
- **Thông điệp chính:** Kết quả được mô tả bằng chức năng hiện hữu, không bằng KPI hay lời khẳng định demo chưa quan sát.
- **Mặt slide:**
  - Phiên, shell hai tab và chuyển workspace [1][11][13].
  - Chat SSE, lịch sử cục bộ, trích dẫn mở nguồn [16][19][23][24].
  - Library, upload/process và Access Requests theo quyền [25][29][35][37].
- **Sơ đồ:** Không cần.
- **Ảnh từ Flutter:** Không cần; nếu ghép ảnh tổng kết, chỉ dùng ảnh đã chụp từ các trạng thái thật và giữ điều kiện nêu ở slide 8–11.
- **Lời dẫn (TV3, khoảng 80–140 từ):** Phần đạt được nên đo bằng những hành vi có trong mã Flutter chứ không phải số người dùng, độ chính xác AI hay kết quả UTE chưa đo. App có vòng đời phiên, shell Chat/Library và chuyển workspace bằng session thay thế [1][11][13]. Chat gửi câu hỏi qua SSE, quản lý lịch sử trên thiết bị và cho mở nguồn nếu câu trả lời có annotation phù hợp [16][19][23][24]. Library cho tìm/xem tệp, tải tài liệu và khởi tạo xử lý theo quyền; màn Access Requests cho người có quyền xét yêu cầu đang chờ [25][29][35][37]. Đây là phạm vi triển khai client, không đồng nghĩa backend đang chạy ổn định tại lúc trình chiếu.
- **Người phụ trách:** TV3.

### Slide 16 — Hạn chế & hướng phát triển
- **Thông điệp chính:** Nói rõ ranh giới mobile hiện tại; hướng phát triển là khả năng cân nhắc, không phải cam kết đã hoặc sẽ làm.
- **Mặt slide:**
  - Chưa có Home/Profile/Workspace Management hoặc chỉnh ACL mobile [1][30].
  - Lịch sử theo account/workspace trên thiết bị, không đa thiết bị [16].
  - Hướng cân nhắc: đồng bộ an toàn hoặc mở rộng quản trị khi có nhu cầu.
- **Sơ đồ:** Không cần.
- **Ảnh từ Flutter:** Không cần; kết bằng ý chính và phần hỏi đáp, không dùng KPI hoặc screenshot giả.
- **Lời dẫn (TV3, khoảng 80–140 từ):** Điều quan trọng cuối cùng là phân biệt cái đang có với điều có thể nghiên cứu sau này. Flutter hiện vào hai tab chính; thông tin tài khoản và chuyển workspace chỉ ở bottom sheet. Quản lý thành viên, chia sẻ collection hoặc chỉnh ACL không có màn mobile; Access Requests chỉ xử lý yêu cầu theo quyền [1][13][30]. Lịch sử hội thoại được phân tách theo tài khoản và workspace trên thiết bị, nên đăng nhập ở một máy khác không tự mang sang hội thoại [16]. Nếu về sau có nhu cầu, có thể cân nhắc đồng bộ lịch sử an toàn hoặc mở rộng giao diện quản trị, nhưng đó không phải cam kết của đồ án hiện tại. Xin kết thúc và nhận câu hỏi về trải nghiệm Flutter cùng điều kiện dữ liệu UTE.
- **Người phụ trách:** TV3.

**Dẫn nguồn kỹ thuật cho mục 26** (file:line; số được đặt ngay tại slide có nhận định):

[1] `app/lib/app/workspace_shell.dart:10-14,206-236,242-295`.  
[2] `backend/docs_design/conversation_loop.md:23-50`; `backend/docs_design/auth_contract.md:5-11`.  
[3] `app/lib/features/requests/requests_page.dart:8-25,177-220`.  
[4] `app/lib/app/app.dart:19-36,48-92`.  
[5] `app/lib/app/workspace_shell.dart:74-82`; `app/lib/features/knowledge/library_page.dart:132-146`.  
[6] `app/lib/features/knowledge/document_page.dart:10-33`; `app/lib/app/workspace_shell.dart:56-61`.  
[7] `app/lib/features/knowledge/library_page.dart:62-78`; `backend/docs_design/api_contract.md:175-181`.  
[8] `app/lib/features/auth/session.dart:122-138`; `backend/docs_design/auth_contract.md:31-48,50-75`.  
[9] `app/lib/features/auth/session.dart:139-142`; `app/lib/features/auth/auth_page.dart:265-269`; `app/lib/app/app_config.dart:2-16`; `backend/docs_design/auth_contract.md:132-134`.  
[10] `backend/docs_design/auth_contract.md:5-11,26-29,69-73`; `backend/docs_design/api_contract.md:152-154`.  
[11] `app/lib/features/auth/session.dart:60-74,85-120`.  
[12] `app/lib/app/app.dart:24-36`; `app/lib/features/auth/session.dart:96-120,179-205,244-254`.  
[13] `app/lib/app/workspace_shell.dart:84-114,139-193`; `app/lib/features/auth/session.dart:207-242`.  
[14] `app/lib/features/chat/widgets/welcome_view.dart:10-58`; `app/lib/app/workspace_shell.dart:23-25`.  
[15] `app/lib/features/chat/widgets/chat_composer.dart:66-121`.  
[16] `app/lib/features/auth/session.dart:21-50`; `app/lib/features/chat/services/conversation_store.dart:7-26,42-72`; `backend/docs_design/conversation_loop.md:97-105`.  
[17] `app/lib/features/chat/widgets/chat_composer.dart:68-99,248-256`; `app/lib/features/chat/state/chat_controller.dart:274-300`.  
[18] `app/lib/features/chat/widgets/chat_composer.dart:390-425`; `backend/docs_design/conversation_loop.md:89-93`.  
[19] `app/lib/features/chat/services/chat_service.dart:29-108`; `backend/docs_design/api_contract.md:156-167`.  
[20] `app/lib/features/chat/models/chat_stream.dart:22-45,71-121,128-142`.  
[21] `app/lib/features/chat/state/chat_controller.dart:380-401,496-512`; `app/lib/features/chat/widgets/chat_composer.dart:292-302`.  
[22] `app/lib/features/chat/widgets/message_view.dart:279-322,491-543`.  
[23] `app/lib/features/chat/widgets/message_view.dart:326-360,546-600`; `backend/docs_design/conversation_loop.md:109-126`.  
[24] `app/lib/features/knowledge/document_page.dart:83-105`; `backend/docs_design/api_contract.md:175-179`.  
[25] `app/lib/features/knowledge/library_page.dart:13-19,180-213,223-280`.  
[26] `app/lib/features/knowledge/library_page.dart:62-78,237-300`; `app/lib/features/knowledge/document_list.dart:109-115`.  
[27] `app/lib/features/chat/services/conversation_store.dart:104-132,155-173`; `backend/docs_design/conversation_loop.md:97-105`.  
[28] `app/lib/features/knowledge/document_list.dart:234-280`; `app/lib/app/workspace_shell.dart:56-61`.  
[29] `app/lib/features/requests/requests_page.dart:119-169,177-248`.  
[30] `app/lib/features/requests/requests_page.dart:49-53`; `app/lib/features/knowledge/library_page.dart:15-19`; `app/lib/app/workspace_shell.dart:10-14`; `backend/docs_design/api_contract.md:183-209`.  
[31] `app/lib/features/knowledge/document_page.dart:257-269,340-450`.  
[32] `app/lib/features/knowledge/document_page.dart:479-555,557-605`.  
[33] `app/lib/features/knowledge/document_page.dart:83-122,125-160,178-193`.  
[34] `backend/docs_design/conversation_loop.md:118-126`.  
[35] `app/lib/features/knowledge/library_page.dart:101-118,149-164,325-365`.  
[36] `app/lib/features/knowledge/upload_sheet.dart:100-149,207-255`.  
[37] `app/lib/features/knowledge/upload_sheet.dart:151-173,245-279`; `app/lib/features/knowledge/library_page.dart:325-332`.  
[38] `backend/docs_design/api_contract.md:223-258`.  
[39] `app/lib/core/api_client.dart:51-76,177-201`; `backend/docs_design/auth_contract.md:113-129`; `backend/docs_design/api_contract.md:31-41`.  
[40] `backend/docs_design/api_contract.md:156-181,213-221`.  
[41] `backend/docs_design/api_contract.md:85-94,206-211`.  
[42] `app/lib/features/requests/requests_page.dart:73-89,119-169`.  
[43] `app/lib/features/chat/state/chat_controller.dart:67-95,404-485`; `app/lib/features/chat/chat_page.dart:154-194`.

# 27. Phân công công việc cho ba thành viên

## 27.1. Nguyên tắc bàn giao và quyền sở hữu

Người thực hiện sản phẩm (bạn) chịu trách nhiệm toàn bộ mã Flutter, dịch vụ, tích hợp, dữ liệu chạy thử và thao tác demo; ba thành viên dưới đây **không nhận công việc lập trình**. Mỗi chương và mỗi trang chiếu chỉ có một người viết nội dung. Thành viên 3 biên tập định dạng, chính tả, chú thích ảnh và nhịp kể của tệp PPTX cuối, nhưng không viết lại nội dung chuyên môn của thành viên 1 hoặc 2; khi phát hiện sai, trả lại đúng chủ sở hữu sửa. Thành viên 1 quản lý thuật ngữ sản phẩm, thành viên 2 kiểm chứng từng mô tả kỹ thuật với mã, thành viên 3 đối chiếu ảnh và lời demo với phiên chạy thật. Ba người dùng cùng quy ước: **Đã có trong Flutter / Phụ thuộc dữ liệu và dịch vụ / Chưa có trong Flutter**.

Đầu vào chung do người làm demo cung cấp: bản Flutter cố định để chụp ảnh, kích thước màn hình hoặc thiết bị, tài khoản sinh viên/manager có quyền thích hợp, tên workspace thực tế, ít nhất một tài liệu được phép xem và dùng để hỏi đáp, một cuộc hội thoại có trích dẫn và một yêu cầu truy cập đang chờ nếu demo phê duyệt. “UTE” là tenant dùng minh họa: chỉ gắn nhãn UTE trên ảnh khi dữ liệu chạy thực sự là UTE. Không dùng ảnh từ web console hay hình mockup để chứng minh tính năng Flutter.

**Phân vai khi đứng nói (khác với người viết nội dung):** TV1 trình bày slide 1–5; TV2 trình bày slide 6–10 bằng notes do từng chủ sở hữu soạn; TV3 trình bày slide 11–16. TV1 sở hữu slide 6, TV3 sở hữu slide 8 và 10, TV2 sở hữu slide 12 và 13; người trình bày chỉ nhận bàn giao lời dẫn, không tạo bản nội dung thứ hai.

| Thành viên | Ownership | Task cụ thể | Report Section | Slide | Deliverable | Dependency | Done Criteria |
|---|---|---|---|---|---|---|---|
| TV1 — Sản phẩm/UX | Vấn đề, mục tiêu, giới hạn | Viết lý do cần ứng dụng hỏi đáp có nguồn; phân biệt BoMesh với tenant UTE; khóa phạm vi thực có | 1–5 | 1–3 | Văn bản mở đầu và thông điệp giá trị | Kiểm kê mã; tên workspace demo | Không gọi BoMesh là chatbot UTE; không biến backend thành đề tài |
| TV1 — Sản phẩm/UX | Người dùng và yêu cầu | Viết hai chân dung, ma trận chức năng đã có/chưa có, use case và journey sinh viên | 6–8 | 4 | Persona, use case và hành trình | Quyền của tài khoản demo | Có điều kiện đăng nhập/quyền, kết quả quan sát được, không gán chức năng quản trị chưa có |
| TV1 — Sản phẩm/UX | Giao diện và luồng | Vẽ sơ đồ khởi động→đăng nhập→Chat/Library→các trang chi tiết; giải thích drawer, bottom sheet, navigation bar | 9–11 | 5–6 | Sơ đồ IA/screen flow, phân tích UX | `app/lib/app/app.dart`, `workspace_shell.dart`, ảnh từ TV3 | Đúng hai tab Chat và Library; không vẽ Home/Profile/Workspace riêng |
| TV2 — Flutter kỹ thuật | Cấu trúc ứng dụng và widget | Phân tích thư mục `app/`, `features/`, `core/`; màn hình, widget, controller/service/store, khả năng responsive | 12–14 | 7 | Sơ đồ kiến trúc Flutter và chú giải | Phiên mã nguồn cố định | Tên lớp/package đúng mã; không gán Clean Architecture, BLoC, Riverpod, Dio hay go_router |
| TV2 — Flutter kỹ thuật | Trạng thái và xác thực | Trình bày `ChangeNotifier`, `setState`, `AnimatedBuilder`, phiên đăng nhập/khôi phục/hết hạn/chuyển workspace/đăng xuất | 15–16 | 12 (phần state) | Bảng state và luồng phiên | `session.dart`, `chat_controller.dart`; ảnh TV3 | Phân biệt trạng thái UI thật với mô hình ý tưởng; token secure storage, lịch sử local đúng phạm vi |
| TV2 — Flutter kỹ thuật | Kết nối và streaming | Giải thích `ApiClient`, Bearer, API lỗi/timeout, POST SSE, tách event/reducer/render, đóng luồng | 17, 19, 27 | 9, 12 (API), 13 | Hai sơ đồ dữ liệu và đoạn giải thích tích hợp | `api_client.dart`, `chat_service.dart`, `chat_stream.dart`, event demo | Đúng `http` + SSE; không tuyên bố WebSocket/retry tự động; backend gói trong một sơ đồ hỗ trợ |
| TV3 — Tính năng/demo | Hội thoại và trích dẫn | Viết trải nghiệm Chat, lịch sử cục bộ, nguồn tài liệu, stop/retry, điều kiện xuất hiện citation | 18, 20–21 | 8 | Nội dung chức năng chat và ảnh/ghi chú | Ảnh chat do người làm demo cung cấp | Ảnh có stream và trích dẫn thật; không mô tả cloud sync |
| TV3 — Tính năng/demo | Thư viện tri thức | Viết tìm kiếm, My files, workspace collections, danh sách tài liệu, chi tiết, trạng thái tải/trống/lỗi | 22–23, 26 | 10 | Nội dung Library và ảnh theo trạng thái | Tài liệu UTE có quyền truy cập; ảnh Flutter | Collection là nhóm tri thức, không phải vector DB; ảnh đúng dữ liệu hiển thị |
| TV3 — Tính năng/demo | Workspace và quyền | Mô tả chuyển workspace, nút theo quyền, duyệt yêu cầu truy cập; ghi rõ giới hạn quản lý members/ACL/CRUD | 24–25 | 11 | Sơ đồ quyền ở mức UX, lời giải thích chênh lệch kịch bản | Tài khoản reviewer, yêu cầu pending nếu cần ảnh | Không ghi đã chỉnh Access/Save trên Flutter; phân biệt duyệt yêu cầu với chỉnh trực tiếp ACL |
| TV3 — Tính năng/demo | Kịch bản và tổng kết | Chốt tuyến demo thật, kết quả chứng minh được, hạn chế, hướng mở rộng, kết luận | 28–32 | 14–16 | Script demo, bảng kết quả/giới hạn | Người làm demo xác nhận thiết bị, dữ liệu, video/ảnh | Mỗi nhận định “đã chạy” có ảnh/video/log tương ứng; trường hợp không sẵn sàng đánh dấu phụ thuộc |
| TV3 — Tổng hợp | Ảnh và deck cuối | Chọn ảnh thật, đặt chú thích/nguồn, thống nhất font-màu-khoảng trắng, đối chiếu notes và nội dung, xuất PPTX | Minh họa cho 1–32, không viết lại chương của người khác | Định dạng cả 1–16, không chiếm ownership nội dung | Tệp PPTX cuối và danh mục ảnh với đường dẫn | TV1+TV2 bàn giao chữ/sơ đồ; người làm demo bàn giao ảnh | 16 slide, ít chữ, ảnh đọc được, không ảnh web giả là app; TV1/TV2 duyệt phần mình trước khóa deck |

**Trật tự làm việc:** (1) người làm demo khóa phiên app và xác nhận dữ liệu; (2) TV1 và TV2 viết độc lập theo chủ đề, TV3 soạn chương feature/danh sách ảnh; (3) từng người tự so nguồn ở phần mình; (4) TV3 gắn ảnh thật và ráp PPTX; (5) cả ba kiểm tra một lượt bằng checklist mục 29; (6) người làm demo duyệt tính đúng đắn cuối. Không cần các thành viên chạy backend hay sửa code.

# 28. Kế hoạch chụp screenshot từ Flutter App thật

**Quy ước:** Ảnh S01–S16 là danh mục chụp, không phải ảnh đã tồn tại. Chụp trên điện thoại/giả lập ở một kích thước thống nhất, giữ thanh trạng thái đủ rõ và cắt thông tin cá nhân nhạy cảm. Ghi ID ảnh, thời điểm, tài khoản/role, workspace và bước thao tác vào bảng theo dõi. Không tạo ảnh giả cho trạng thái streaming/citation; chuẩn bị tài liệu và chụp đúng thời điểm. Mỗi dòng dưới đây ghi *màn hình — nội dung cần thể hiện — vị trí báo cáo; slide — chú thích đề xuất*.

| Chọn | Ảnh / màn hình | Nội dung cần thể hiện và điều kiện | Report section | Slide | Caption đề xuất |
|---|---|---|---|---|---|
| [ ] S01 — Khôi phục phiên | Màn hình tiến trình “Opening your workspace…” khi mở app có token, không gọi là splash/logo riêng | 10, 15–16 | 6 hoặc không dùng | “Ứng dụng kiểm tra phiên trước khi mở không gian làm việc.” |
| [ ] S02 — Đăng nhập | Form email/username, mật khẩu; chỉ chụp nút Google nếu cấu hình thực tế làm nó hiện | 9, 16 | 5 | “Giao diện đăng nhập Flutter của BoMesh Mobile.” |
| [ ] S03 — Chat lần đầu | Giao diện lời chào, câu hỏi gợi ý, composer và hai tab đáy Chat/Library | 9–11, 14, 18 | 5, 8 | “Chat là điểm bắt đầu; điều hướng di động chỉ có hai tab chính.” |
| [ ] S04 — Trợ lý bắt đầu xử lý | Câu hỏi tốt nghiệp và chỉ báo chờ/thinking thật, không ghi sẵn nhãn “Đang phân tích” nếu UI không hiện | 15, 18–19 | 8–9 | “Trạng thái phản hồi khi yêu cầu mới được gửi.” |
| [ ] S05 — Tìm kiếm và streaming | Tool `knowledge_search` hiển thị nếu backend phát event, chữ trả lời đang tăng dần, nút Stop | 18–19 | 9 | “Sự kiện tìm kiếm và văn bản SSE cập nhật liên tục trên Chat.” |
| [ ] S06 — Câu trả lời hoàn tất | Trả lời đủ ý với số trích dẫn `[1]`, danh sách nguồn; chỉ chụp nếu backend thật sự trả citation | 18–20 | 8–9, 15 | “Câu trả lời được gắn nguồn để người học kiểm chứng.” |
| [ ] S07 — Nguồn trích dẫn | Chạm `[1]` mở DocumentPage, phần trích hoặc trang PDF được focus/highlight thực tế | 20, 22 | 9 | “Từ câu trả lời mở đúng nguồn và đoạn trích được dẫn.” |
| [ ] S08 — Lịch sử hội thoại | Mở drawer Chat trên điện thoại, hiện cuộc hội thoại/ô tìm và thao tác ghim/đổi tên nếu có dữ liệu | 11, 18, 21 | 6, 8 | “Lịch sử hội thoại lưu trên thiết bị theo tài khoản và workspace.” |
| [ ] S09 — Chọn phạm vi câu hỏi | Nút `+`/bottom sheet, bộ chọn collection hoặc chip đã chọn; cần collection được phép xem | 9, 18, 23 | 8 hoặc 10 | “Người dùng thu hẹp phạm vi câu hỏi bằng collection được phép.” |
| [ ] S10 — Library: My files | Thanh tìm kiếm, lựa chọn My files/Workspace, danh sách tệp cá nhân hoặc trạng thái trống, nút Upload | 9, 17, 22, 26 | 10 | “Thư viện tri thức cá nhân trên màn hình nhỏ.” |
| [ ] S11 — Library: Workspace | Các collection được chia sẻ, tên và số tài liệu, không dùng collection tưởng tượng nếu chưa nạp | 22–23, 25 | 10–11 | “Collection mà tài khoản hiện tại có quyền truy cập.” |
| [ ] S12 — Tìm kiếm tài liệu | Gõ tên tài liệu UTE thật trong Library, ảnh cho thấy kết quả; nếu không có thì chụp trạng thái rỗng và đổi caption | 22, 26 | 10 | “Tìm kiếm tài liệu trong phạm vi được phép.” |
| [ ] S13 — Chi tiết collection | Tiêu đề collection, danh sách tài liệu; nút Upload/Process chỉ nếu tài khoản có đúng quyền | 22–23, 25 | 10–11 | “Collection gom tài liệu theo chủ đề và quyền đọc.” |
| [ ] S14 — Xem tài liệu | DocumentPage ở Preview/Text/Details theo loại file; ưu tiên tài liệu có trang/đoạn trích dễ đọc | 20, 22 | 10 | “Xem nội dung và nguồn tham chiếu ngay trong ứng dụng.” |
| [ ] S15 — Tài khoản/workspace | Bottom sheet tài khoản với tên workspace hiện tại, Access requests, Sign out; tùy chọn Switch chỉ khi có nhiều workspace | 10–11, 16, 24 | 6, 11 | “Thông tin phiên và chuyển workspace nằm trong menu tài khoản.” |
| [ ] S16 — Yêu cầu truy cập | RequestsPage có mục chờ duyệt, tên collection và nút Approve/Deny nếu đúng quyền và có request pending; thêm ảnh dialog xác nhận nếu kịp | 24–25, 28 | 11, 14 | “Người có quyền duyệt yêu cầu truy cập ngay trên điện thoại.” |

**Không có ảnh cần chụp:** Home độc lập, Profile độc lập, màn Workspace Overview, danh sách Members, trình chỉnh Collection Access/Save, màn tạo/sửa/xóa collection: source Flutter hiện không cung cấp những màn này (`app/lib/app/workspace_shell.dart:10-14,206-236`; `app/lib/features/knowledge/library_page.dart:15-20,305-365`). Nếu bài thuyết trình cần đề cập, dùng khung “chưa có trên Mobile / hướng phát triển”, tuyệt đối không thay bằng ảnh web console hoặc mockup và không đánh dấu đã demo. Ảnh từ tác vụ Process/Upload chỉ bổ sung nếu thời lượng còn lại, tránh chuyển trọng tâm thành quản trị xử lý tài liệu.

**Checklist dữ liệu trước buổi chụp:** [ ] App chạy trên thiết bị/giả lập; [ ] backend reachable; [ ] tài khoản có membership workspace thực tế; [ ] tài liệu liên quan câu hỏi đã sẵn sàng cho chat; [ ] AI trả streaming và citation với câu hỏi thật; [ ] tài khoản khác dùng để đối chiếu phạm vi nếu trình bày phân quyền; [ ] request đang chờ và người duyệt hợp lệ nếu dùng S16; [ ] ảnh đã che email/token/tên người thật theo yêu cầu lớp học. Nếu một điều kiện không thỏa, bỏ ảnh và sửa slide/note cho đúng, không tuyên bố đã trình diễn.

# 29. Danh sách rà soát cuối

## 29.1. Trọng tâm môn học và mã Flutter
- [ ] Tỷ trọng bản báo cáo/deck khoảng 70–80% trải nghiệm, màn hình và Flutter; 10–20% tích hợp API; khoảng 10% bối cảnh AI/tenant.
- [ ] Tên đề tài đúng: nền tảng BoMesh, app Flutter dùng tenant UTE minh họa; không gọi BoMesh là “chatbot UTE”.
- [ ] Screen flow chỉ gồm phiên đăng nhập, Chat/Library, drawer, trang collection/document, menu tài khoản và yêu cầu truy cập có thật.
- [ ] Navigation đúng `Navigator` pages cấp gốc + `MaterialPageRoute` cho chi tiết; không gán go_router.
- [ ] Widget và feature/module đúng tên file; không gán Clean Architecture, BLoC, Riverpod, Provider, GetX hoặc Dio khi không có.
- [ ] State đúng `ChangeNotifier`, `AnimatedBuilder`, `setState`, reducer sự kiện; trạng thái nghĩ/tìm kiếm chỉ gọi đúng nhãn khi UI thực phát.
- [ ] Đăng nhập, secure storage, phục hồi, tái xác thực, đăng xuất và chuyển workspace đúng source; Google login chỉ tuyên bố được demo khi đã cấu hình và kiểm thử.
- [ ] API đúng `/api/v1`, Bearer, lỗi/timeout; chat qua SSE, không gọi WebSocket hoặc retry tự động.
- [ ] Lịch sử chat là cục bộ phân lập theo người dùng/workspace, không gọi là đồng bộ nhiều thiết bị.

## 29.2. Tính năng và kịch bản thực
- [ ] Có minh chứng Chat trống→gửi→xử lý→delta text→hoàn tất→hỏi tiếp; nếu API không trả dữ liệu, đánh dấu phụ thuộc.
- [ ] Chỉ gắn citation khi phản hồi thật có chú thích; thao tác chạm mở viewer đúng tài liệu/đoạn.
- [ ] Library search, My files, collection workspace và document detail được minh họa bằng ảnh Flutter thật.
- [ ] Quyền đọc collection và nút Upload/Process theo quyền đúng dữ liệu; không công bố danh sách role Student/Giảng viên/Manager như UI ACL hiện hữu.
- [ ] Workspace trên mobile là đổi workspace trong menu và duyệt access request; không nhận vơ màn Members/Overview/chỉnh ACL.
- [ ] Kịch bản manager “Collection→chỉnh Access→Save” của đề xuất gốc được ghi rõ **chưa thể demo bằng Flutter hiện tại**; nếu source được người làm demo cập nhật, kiểm kê lại trước khi sửa lời.
- [ ] Không dùng dữ liệu ví dụ UTE (số members, số collections, quy chế năm 2026) làm số liệu sản phẩm thật nếu chưa xác nhận.

## 29.3. Báo cáo, diagram, ảnh và PPTX
- [ ] Có đủ các mục 1–29 của Google Docs; chương báo cáo mục 25 đọc độc lập được; 16 slide đều có key message, bullet, diagram, ảnh, notes, chủ sở hữu.
- [ ] Mỗi sơ đồ diễn tả luồng Flutter thật; backend ở mức dịch vụ hỗ trợ, không trình bày DB/vector/Kubernetes/deployment.
- [ ] Không invent screen, package, feature, ảnh demo, kết quả chạy hoặc khả năng cấp quyền trực tiếp trên mobile.
- [ ] Không biến Knowledge thành dashboard ingestion/chunk/vector; collection là nhóm tri thức theo chủ đề và quyền sử dụng.
- [ ] Ảnh S01–S16 chụp từ Flutter thật, được đánh ID/caption; ảnh nào chưa có thì để ô chờ hoặc bỏ, không giả lập.
- [ ] Slide ít chữ, phân bổ ảnh/flow rõ, không lặp nguyên báo cáo; chú giải tương phản và đủ lớn trên máy chiếu.
- [ ] Mỗi section/slide có một chủ sở hữu nội dung; thành viên 3 tổng hợp định dạng và kiểm tra xuyên suốt, không viết đè nội dung người khác.
- [ ] Người làm demo duyệt lần cuối theo đúng phiên chạy, tài khoản, dữ liệu, quyền và thời lượng thuyết trình.
