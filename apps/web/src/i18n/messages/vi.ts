/**
 * Vietnamese interface messages (the interface is Vietnamese only for now). Written with the standard terminology
 * (product-language-guidelines §2) and Vietnamese style (localization §9). Keys are semantic and grouped by area;
 * values are strings, or functions for anything with parameters.
 */

const ALL = "Tất cả";
const IN_REVIEW = "Chờ duyệt";
const CHANGES_REQUESTED = "Cần chỉnh sửa";
const PUBLISHED = "Đã công bố";
const UNPUBLISHED = "Đã ngừng công bố";
const DECLINED = "Đã từ chối";
const NOT_PROCESSED = "Chưa xử lý";
const PROCESSING = "Đang xử lý";
const PROCESSING_FAILED = "Không xử lý được";
const CHANGED_AT_SOURCE = "Nguồn đã thay đổi";
const REVERIFY = "Cần xác minh lại";

const REVIEW_DESC = "Người duyệt sẽ xem xét trước khi công bố.";
const CHANGES_DESC = "Người duyệt yêu cầu chỉnh sửa trước khi công bố.";
const DECLINED_DESC = "Người duyệt đã từ chối. Tài liệu này sẽ không được công bố.";
const UNPUBLISHED_DESC = "Đã ẩn khỏi người đọc, tìm kiếm và câu trả lời. Người chỉnh sửa có thể công bố lại.";

export const vi = {
  common: {
    all: ALL,
    /** Accessible name of a region that is still loading. */
    loading: "Đang tải",
    /** A list footer's range: "1–20 trên 87" (numbers already formatted). */
    range: ({ from, to, total }: { from: string; to: string; total: string }) => `${from}–${to} trên ${total}`,
    noResults: "0 kết quả",
  },

  /** Sidebar, its groups, route titles, section labels and the shell's own controls (PL §2.1). */
  nav: {
    home: "Trang chủ",
    knowledge: "Tài liệu",
    browse: "Tra cứu",
    saved: "Đã lưu",
    myFiles: "Tệp của tôi",
    knowledgeMap: "Bản đồ tài liệu",
    newChat: "Trò chuyện mới",
    conversation: "Cuộc trò chuyện",
    projects: "Dự án",
    project: "Dự án",
    spaces: "Cộng đồng",
    space: "Cộng đồng",
    myContributions: "Tài liệu tôi đã gửi",
    work: "Công việc",
    newWork: "Công việc mới",
    requests: "Yêu cầu",
    newRequest: "Yêu cầu mới",
    request: "Yêu cầu",
    inbox: "Thông báo",
    search: "Tìm kiếm",
    document: "Tài liệu",
    overview: "Tổng quan",
    studio: "Quản trị tài liệu",
    documents: "Tài liệu",
    collections: "Kho tài liệu",
    collection: "Kho tài liệu",
    taxonomy: "Phân loại",
    sources: "Nguồn dữ liệu",
    people: "Người dùng & phân quyền",
    members: "Thành viên",
    groups: "Nhóm",
    roles: "Vai trò",
    accessRequests: "Yêu cầu truy cập",
    assistant: "Trợ lý",
    activity: "Nhật ký hoạt động",
    changes: "Thay đổi",
    signIns: "Lượt đăng nhập",
    settings: "Cài đặt",
    general: "Chung",
    workspaceSetup: "Thiết lập không gian làm việc",
    signIn: "Đăng nhập",
    createAccount: "Tạo tài khoản",
    resetPassword: "Đặt lại mật khẩu",
    chooseWorkspace: "Chọn không gian làm việc",
    sharedLink: "Liên kết chia sẻ",
    joinWorkspace: "Tham gia không gian làm việc",
    notFound: "Không tìm thấy",
    platformConsole: "Bảng điều khiển nền tảng",
    workspaces: "Không gian làm việc",
    users: "Người dùng",
    connectors: "Trình kết nối",
    indexing: "Lập chỉ mục",
    byWorkspace: "Theo không gian làm việc",
    jobs: "Tác vụ",
    indexingJobs: "Tác vụ lập chỉ mục",
    policies: "Chính sách",
    indexingPolicies: "Chính sách lập chỉ mục",
    usage: "Mức sử dụng",
    auditLog: "Nhật ký kiểm tra",
    systemHealth: "Tình trạng hệ thống",
    backTo: ({ name }: { name: string }) => `Quay lại ${name}`,
    unread: ({ count }: { count: number }) => `${count} chưa đọc`,
    group: {
      workspace: "Không gian làm việc",
      yourWork: "Cá nhân",
      manage: "Quản trị",
      recent: "Gần đây",
      console: "Bảng điều khiển",
    },
    sidebar: {
      label: "Điều hướng chính",
      pages: "Trang",
      search: "Tìm mọi thứ…",
      searchLabel: "Tìm mọi thứ (⌘K)",
      searchTip: "Tìm kiếm (⌘K)",
      close: "Đóng thanh bên",
      expand: "Mở rộng thanh bên",
      collapse: "Thu gọn thanh bên",
      needsFixing: "Có mục cần khắc phục",
      needsYou: "Có mục cần bạn xử lý",
      needAttention: ({ count }: { count: number }) => `${count} mục cần chú ý`,
      sourceChanged: ({ name }: { name: string }) => `“${name}” đã thay đổi`,
      someSourceChanged: "Một nguồn đã thay đổi",
      sourcesChanged: ({ count }: { count: number }) => `${count} nguồn đã thay đổi`,
    },
    topbar: {
      openSidebar: "Mở thanh bên",
      breadcrumb: "Đường dẫn",
      search: "Tìm mọi thứ",
    },
  },

  /** Every status chip and its description (PL §2.4). */
  state: {
    /** Can readers see it? */
    publication: {
      review: { label: IN_REVIEW, desc: REVIEW_DESC },
      changes: { label: CHANGES_REQUESTED, desc: CHANGES_DESC },
      published: { label: PUBLISHED, desc: "Ai đọc được kho tài liệu chứa tài liệu này đều mở được." },
      unpublished: { label: UNPUBLISHED, desc: UNPUBLISHED_DESC },
      rejected: { label: DECLINED, desc: DECLINED_DESC },
    },
    /** Can search and the assistant use it? */
    processing: {
      pending: { label: NOT_PROCESSED, desc: "Trợ lý chưa đọc, chưa phân loại tài liệu này. Tìm kiếm và trợ lý chưa dùng được." },
      processing: { label: PROCESSING, desc: "Trợ lý đang đọc, phân loại theo chủ đề và chuẩn bị cho tra cứu." },
      ready: { label: "Đã xử lý", desc: "Đã đọc và phân loại: tìm kiếm và trợ lý dùng được tài liệu này sau khi công bố." },
      failed: { label: PROCESSING_FAILED, desc: "Không đọc được tệp hoặc chưa chuẩn bị được cho tra cứu. Hãy xử lý lại trong Đang xử lý." },
      outdated: { label: CHANGED_AT_SOURCE, desc: "Bản gốc đã thay đổi sau lần xử lý gần nhất. Câu trả lời dùng phiên bản trước cho đến khi xử lý lại." },
      unsupported: { label: "Không hỗ trợ", desc: "Không xử lý được hình ảnh và tệp nén. Người đọc vẫn tải xuống được." },
    },
    /** Verification (Tra cứu's “Xác minh” facet). */
    verification: {
      verified: { label: "Đã xác minh", desc: "Chủ sở hữu đã xác nhận tài liệu chính xác và còn hiệu lực." },
      review: { label: REVERIFY, desc: "Tài liệu có thể đã cũ. Hãy hỏi chủ sở hữu trước khi dựa vào nội dung này." },
      unverified: { label: "Chưa xác minh", desc: "Chưa có chủ sở hữu nào xác nhận tài liệu này." },
      personal: { label: "Tệp cá nhân", desc: "Chỉ bạn xem được." },
    },
    /** The one lifecycle label people see for a document or what they sent for review. */
    lifecycle: {
      analyzing: { label: PROCESSING, desc: "Trợ lý đang đọc tệp và gợi ý chủ đề, kho tài liệu." },
      review: { label: IN_REVIEW, desc: REVIEW_DESC },
      changes: { label: CHANGES_REQUESTED, desc: CHANGES_DESC },
      rejected: { label: DECLINED, desc: DECLINED_DESC },
      withdrawn: { label: "Đã rút lại", desc: "Bạn đã rút lại. Người duyệt không còn thấy tài liệu này." },
      queued: {
        label: NOT_PROCESSED,
        desc: "Đã công bố nhưng chưa xử lý: người đọc mở được từ kho tài liệu; tìm kiếm và trợ lý chỉ dùng được sau khi xử lý xong.",
      },
      publishing: { label: PROCESSING, desc: "Trợ lý đang đọc và phân loại. Vài phút nữa là tra cứu được." },
      published: { label: PUBLISHED, desc: "Tra cứu được và trợ lý dùng được." },
      update: { label: CHANGED_AT_SOURCE, desc: "Bản gốc đã thay đổi. Câu trả lời dùng phiên bản trước cho đến khi xử lý lại." },
      failed: { label: PROCESSING_FAILED, desc: "Không đọc được tệp hoặc chưa chuẩn bị được cho tra cứu. Cách khắc phục nằm ở Tài liệu → Sự cố." },
      merged: { label: "Đã công bố thành phiên bản mới", desc: "Đã thay thế phiên bản trước của tài liệu." },
      stored: { label: "Đã tải lên, chưa tra cứu được", desc: "Loại tệp này không tra cứu được. Người đọc vẫn tải xuống được." },
      unpublished: { label: UNPUBLISHED, desc: UNPUBLISHED_DESC },
      archived: { label: "Đã lưu trữ", desc: "Đã ẩn khỏi Tra cứu, tìm kiếm và câu trả lời." },
    },
  },

  /** Quản trị tài liệu (Knowledge Studio). */
  studio: {
    documentViews: {
      label: "Chế độ xem tài liệu",
      all: ALL,
      processing: PROCESSING,
      review: IN_REVIEW,
    },
    quality: {
      label: "Chất lượng",
      reverify: REVERIFY,
      details: "Thiếu thông tin",
      duplicates: "Có thể trùng lặp",
    },
    taxonomyViews: {
      label: "Trục phân loại",
      suggestions: "Gợi ý",
    },
    sourceViews: {
      label: "Chế độ xem nguồn dữ liệu",
      sources: "Nguồn dữ liệu",
      history: "Lịch sử đồng bộ",
      accounts: "Tài khoản kết nối",
    },
  },

  /** Tài liệu: Tra cứu, Đã lưu, Tệp của tôi, Tài liệu tôi đã gửi. */
  knowledge: {
    browse: {
      facets: {
        type: "Định dạng",
        space: "Cộng đồng",
        owner: "Chủ sở hữu",
        src: "Nguồn dữ liệu",
        kb: "Kho tài liệu",
        trust: "Xác minh",
        upd: "Cập nhật",
        lang: "Ngôn ngữ",
      },
      updated: {
        "7d": "Tuần qua",
        "30d": "Tháng qua",
        "365d": "Năm qua",
      },
    },
    contributionGroups: {
      all: ALL,
      changes: "Cần bạn xử lý",
      review: IN_REVIEW,
      published: PUBLISHED,
      rejected: DECLINED,
    },
  },
} as const;
