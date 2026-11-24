"use client";

import { Button } from "@heroui/react";
import { Activity, ArrowRight, Copy, Download, Info, Search, Zap } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import {
  ClearFilters,
  DataTable,
  Disclosure,
  EmptyState,
  FilterButton,
  Gate,
  IconButton,
  KeyValue,
  Page,
  PageHeader,
  Pager,
  PreviewChip,
  SearchInput,
  Segmented,
  SkeletonRows,
  StatusChip,
  toast,
  UserAvatar,
} from "@/components/ui";
import { errorMessage } from "@/lib/api/client";
import { SEARCH_PAUSE_MS, useDebounced } from "@/lib/debounce";
import { fmtDateTime, fmtNum, plural, rel } from "@/lib/format";
import { useMessages } from "@/lib/i18n";

import { batchGetUsers, listAuditEvents, type AuditQuery, type Connector, type PlatformAuditEvent, type User, type Workspace, type WorkspaceAuditEvent } from "../api";
import { actionLabel, AUDIT_WINDOWS, CATEGORY_LABEL, DAY, lastSegment, toCsv, userName, workspaceIdOf } from "../model";
import { useAuditPages, useConnectors, usePlatformWorkspaces, useUsersByName } from "../queries";
import { copyText, PlatformDrawer, PREVIEW_TIP, saveFile, useUrlState, WsCell } from "./shared";
import { WorkspaceDrawer } from "./WorkspaceDrawer";

const PAGE = 15;
/** The CSV export reads at most this many events (newest first) and says so when more matched. */
const EXPORT_MAX = 5000;
/** Accounts per batch read when naming the exported events' people. */
const USER_BATCH = 50;

const SYSTEM = "BoMesh";

/** One row of the console's audit log: a platform event or a workspace event (metadata only). */
interface AuditRow {
  id: string;
  at: string | undefined;
  workspaceId: string;
  actor: string;
  action: string;
  category: string;
  area: string;
  target: string;
  /** Resource name the event is about (for the drawer's related object). */
  targetName: string;
  outcome: "success" | "failure";
  ip: string;
}

type Lookups = { users: Map<string, User>; workspaces: Map<string, Workspace>; connectors: Map<string, Connector> };

function actorName(actor: string | undefined, users: Lookups["users"]): string {
  if (!actor || actor === "system") return SYSTEM;
  const u = users.get(actor);
  return u ? userName(u) : "Người không xác định";
}

/** Resource kinds (collection or singleton segment) in plain words, for targets the console has no name for. */
const KIND_LABEL: Record<string, string> = {
  announcements: "Thông báo chung",
  artifacts: "Mục công việc",
  assistant: "Trợ lý",
  auditEvents: "Sự kiện nhật ký",
  components: "Thành phần",
  connections: "Tài khoản đã kết nối",
  connectors: "Trình kết nối",
  contributions: "Bài gửi",
  conversations: "Cuộc trò chuyện",
  events: "Sự kiện",
  groups: "Nhóm",
  incidents: "Sự cố",
  ingestionPolicies: "Chính sách lập chỉ mục",
  ingestionRuns: "Lượt xử lý",
  items: "Tài liệu",
  knowledgeGaps: "Khoảng trống tài liệu",
  materials: "Tài liệu tham khảo",
  members: "Thành viên",
  memberships: "Tư cách thành viên",
  messages: "Tin nhắn",
  notifications: "Thông báo",
  operations: "Thao tác",
  overview: "Tổng quan",
  passages: "Đoạn trích",
  permissions: "Quyền",
  preferences: "Tùy chọn",
  recentItems: "Mục gần đây",
  requests: "Yêu cầu",
  requestTypes: "Loại yêu cầu",
  revisions: "Phiên bản",
  roles: "Vai trò",
  savedItems: "Mục đã lưu",
  savedSearches: "Tìm kiếm đã lưu",
  sessions: "Phiên đăng nhập",
  settings: "Thiết lập",
  shares: "Liên kết chia sẻ",
  shortcuts: "Lối tắt",
  sources: "Nguồn dữ liệu",
  spaces: "Cộng đồng",
  syncs: "Lượt đồng bộ",
  tasks: "Tác vụ",
  topicCorrections: "Lần sửa chủ đề",
  topics: "Chủ đề",
  users: "Người dùng",
  workspaces: "Không gian làm việc",
};

/** A resource name in plain words: people, workspaces and connectors by name; other resources by kind. */
function targetLabel(target: string | undefined, l: Lookups): string {
  if (!target) return "";
  const u = l.users.get(target);
  if (u) return userName(u);
  const w = l.workspaces.get(target);
  if (w) return w.displayName ?? target;
  const c = l.connectors.get(target);
  if (c) return c.displayName ?? target;
  // Collection/id pairs: an odd-length path ends in a singleton resource (e.g. `users/{id}/preferences`).
  const parts = target.split("/");
  const kind = (parts.length % 2 === 1 ? parts.at(-1) : parts.at(-2)) ?? target;
  return KIND_LABEL[kind] ?? "Tài nguyên";
}

/** Names everyone an event mentions (actor, and a user target) so one batch read can resolve them. */
function peopleOf(platform: readonly PlatformAuditEvent[], workspace: readonly WorkspaceAuditEvent[]): string[] {
  return [...platform, ...workspace].flatMap((e) => [e.actor ?? "", e.target ?? ""]).filter((n) => n.startsWith("users/"));
}

/** Rows for events already merged newest first by the server read (platform events plus workspace lifecycle events). */
function toRows(platform: readonly PlatformAuditEvent[], workspace: readonly WorkspaceAuditEvent[], l: Lookups): AuditRow[] {
  const row = (e: PlatformAuditEvent | WorkspaceAuditEvent, workspaceId: string): AuditRow => ({
    id: e.name ?? "",
    at: e.createTime,
    workspaceId,
    actor: actorName(e.actor, l.users),
    action: actionLabel(e.action),
    category: e.category ?? "",
    area: e.category ? CATEGORY_LABEL[e.category] : "—",
    // Workspace lifecycle events carry no target: the workspace itself is what changed (preview: its name under the action).
    target: e.target ? targetLabel(e.target, l) : workspaceId ? (l.workspaces.get(`workspaces/${workspaceId}`)?.displayName ?? (e.category ? CATEGORY_LABEL[e.category] : "")) : "",
    targetName: e.target ?? "",
    outcome: e.outcome === "FAILED" ? "failure" : "success",
    ip: e.ipAddress ?? "",
  });
  return [...platform.map((e) => row(e, workspaceIdOf(e.target))), ...workspace.map((e) => row(e, workspaceIdOf(e.name)))].sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""));
}

/** Preview `X.auditLog.whoAv`: the product itself ("BoMesh") gets a system mark instead of initials. */
function ActorAvatar({ name, size = "sm" }: { name: string; size?: "xs" | "sm" | "lg" }) {
  if (name !== SYSTEM) return <UserAvatar name={name} size={size} />;
  return (
    <span className={`avatar avatar--default avatar--${size} act-sys`} aria-hidden>
      <Zap className="i i-xs" />
    </span>
  );
}

/** Preview `P.pAudit` (built like workspace Activity, plus a Workspace column): search, window, filters, drawer, CSV. */
export function AuditPage() {
  const m = useMessages();
  const url = useUrlState();
  const router = useRouter();
  const win = AUDIT_WINDOWS.some((w) => w.value === url.get("win")) ? url.get("win") : "30";
  const workspaces = usePlatformWorkspaces();
  const connectors = useConnectors();
  const [exporting, setExporting] = useState(false);

  const q = url.get("q");
  const ws = url.get("ws");
  const area = url.get("area");
  const outcome = url.get("outcome");
  const search = useDebounced(q.trim(), SEARCH_PAUSE_MS);
  const query: AuditQuery = {
    windowMs: Number(win) * DAY,
    scope: ws,
    category: area || undefined,
    outcome: outcome === "failure" ? "FAILED" : outcome === "success" ? "SUCCEEDED" : undefined,
    search: search || undefined,
  };
  const events = useAuditPages(query, PAGE);
  const people = useUsersByName(events.data ? peopleOf(events.data.platform, events.data.workspace) : []);
  const lookups: Lookups = {
    users: people,
    workspaces: new Map((workspaces.data ?? []).map((w) => [w.name ?? "", w])),
    connectors: new Map((connectors.data ?? []).map((c) => [c.name ?? "", c])),
  };
  const wsById = new Map((workspaces.data ?? []).map((w) => [lastSegment(w.name), w]));
  const wsName = (id: string) => (id ? (wsById.get(id)?.displayName ?? id) : "Nền tảng");

  const rows = events.data ? toRows(events.data.platform, events.data.workspace, lookups) : [];
  const areas = (Object.keys(CATEGORY_LABEL) as (keyof typeof CATEGORY_LABEL)[]).map((c) => ({ value: c, label: CATEGORY_LABEL[c] }));
  const filtered = Boolean(q || ws || area || outcome);
  const reset = () => url.set({ q: null, ws: null, area: null, outcome: null, win: null, page: null });

  const exportCsv = async () => {
    setExporting(true);
    try {
      const all = await listAuditEvents(query, EXPORT_MAX);
      const names = [...new Set(peopleOf(all.platform, all.workspace))];
      const batches = await Promise.all(Array.from({ length: Math.ceil(names.length / USER_BATCH) }, (_, i) => batchGetUsers(names.slice(i * USER_BATCH, (i + 1) * USER_BATCH))));
      const out = toRows(all.platform, all.workspace, { ...lookups, users: new Map(batches.flat().map((u: User) => [u.name ?? "", u])) });
      if (!out.length) {
        toast("Không có sự kiện để xuất. Hãy đổi bộ lọc và thử lại.", { tone: "danger" });
        return;
      }
      saveFile(
        "platform-audit.csv",
        toCsv([
          ["Thời điểm", "Không gian làm việc", "Người", "Khu vực", "Hành động", "Đối tượng", "Kết quả", "Địa chỉ IP"],
          ...out.map((e) => [e.at ?? "", wsName(e.workspaceId), e.actor, e.area, e.action, e.target, e.outcome === "failure" ? "Lỗi" : "Thành công", e.ip]),
        ]),
      );
      toast(
        all.capped
          ? `Đã lưu ${fmtNum(out.length)} sự kiện mới nhất vào platform-audit.csv. Thu hẹp bộ lọc để xuất phần còn lại.`
          : `Đã lưu ${plural(out.length, "event")} vào platform-audit.csv`,
      );
    } catch (error) {
      toast(errorMessage(error), { tone: "danger" });
    } finally {
      setExporting(false);
    }
  };

  const open = url.get("open");
  const current = open ? rows.find((e) => e.id === open) : undefined;

  // Keep the last event while the drawer animates closed, so it never flashes "Event not found".
  const [shown, setShown] = useState<AuditRow | undefined>(current);
  if (current && current.id !== shown?.id) setShown(current);
  const selected = current ?? (open ? undefined : shown);

  /** The object an event is about, when the console can show it (preview `pRelated`). */
  const related = (e: AuditRow): { label: string; run: () => void } | null => {
    const user = lookups.users.get(e.targetName);
    if (user) return { label: `Xem ${userName(user)}`, run: () => router.push(`/p/users?open=${lastSegment(user.name)}`) };
    const connector = lookups.connectors.get(e.targetName);
    if (connector) return { label: `Mở ${connector.displayName}`, run: () => router.push(`/p/connectors?open=${lastSegment(connector.name)}`) };
    const target = lookups.workspaces.get(e.targetName);
    const id = target ? lastSegment(target.name) : e.workspaceId && wsById.has(e.workspaceId) ? e.workspaceId : "";
    if (id) return { label: "Xem không gian làm việc", run: () => url.set({ open: null, workspace: id }) };
    return null;
  };
  const to = selected ? related(selected) : null;

  return (
    <Page width="wide">
      <PageHeader
        title={m.nav.auditLog}
        chips={<PreviewChip tooltip={PREVIEW_TIP} />}
        actions={
          <Button variant="tertiary" isDisabled={!events.data || exporting} onPress={() => void exportCsv()}>
            <Download className="i" aria-hidden />
            Xuất CSV
          </Button>
        }
      />
      <Gate
        query={events}
        skeleton={<SkeletonRows rows={8} />}
        isEmpty={(d) => d.platform.length + d.workspace.length === 0 && win === "90" && !filtered && events.page === 1}
        empty={<EmptyState icon={Activity} title="Chưa ghi nhận sự kiện nào" description="Thay đổi về không gian làm việc, tài khoản, trình kết nối và lập chỉ mục sẽ hiển thị tại đây." boxed />}
      >
        <div className="toolbar act-toolbar">
          <SearchInput value={q} onChange={(v) => url.set({ q: v, page: null })} placeholder="Tìm kiếm sự kiện" />
          <Segmented label="Khoảng thời gian" value={win} options={AUDIT_WINDOWS} onChange={(v) => url.set({ win: v === "30" ? null : v, page: null })} />
          <FilterButton
            label="Không gian làm việc"
            value={ws}
            onChange={(v) => url.set({ ws: v, page: null })}
            options={[{ value: "platform", label: "Nền tảng" }, ...(workspaces.data ?? []).map((w) => ({ value: lastSegment(w.name), label: w.displayName ?? "" }))]}
          />
          <FilterButton label="Khu vực" value={area} onChange={(v) => url.set({ area: v, page: null })} options={areas} />
          <FilterButton
            label="Kết quả"
            value={outcome}
            onChange={(v) => url.set({ outcome: v, page: null })}
            options={[
              { value: "success", label: "Thành công" },
              { value: "failure", label: "Lỗi" },
            ]}
          />
          <ClearFilters isActive={Boolean(ws || area || outcome)} onClear={() => url.set({ ws: null, area: null, outcome: null, page: null })} />
        </div>
        {rows.length ? (
          <DataTable
            label="Sự kiện nhật ký kiểm tra"
            rows={rows}
            getRowId={(e) => e.id}
            onRowAction={(e) => url.set({ open: e.id })}
            rowClassName={() => "act-change"}
            columns={[
              {
                id: "what",
                header: "Điều đã xảy ra",
                primary: true,
                cell: (e) => (
                  <span className="stack act-what">
                    <span className="row gap-6">
                      <span className="cell-title truncate">{e.action}</span>
                      {e.outcome === "failure" ? <StatusChip kind="outcome" value="failure" size="sm" /> : null}
                    </span>
                    {e.target ? <span className="cell-sub truncate">{e.target}</span> : null}
                  </span>
                ),
              },
              {
                id: "actor",
                header: "Người",
                cell: (e) => (
                  <span className="row gap-8">
                    <ActorAvatar name={e.actor} />
                    <span className="truncate">{e.actor}</span>
                  </span>
                ),
              },
              { id: "ws", header: "Không gian làm việc", className: "hide-md", hideOnMobile: true, cell: (e) => <WsCell workspace={e.workspaceId ? wsById.get(e.workspaceId) : null} /> },
              {
                id: "at",
                header: "Thời điểm",
                cell: (e) => (
                  <span className="muted act-when" title={fmtDateTime(e.at)}>
                    {rel(e.at)}
                  </span>
                ),
              },
            ]}
            footer={<Pager page={events.page} pageSize={PAGE} pageCount={rows.length} hasNext={events.hasNext} onPageChange={events.setPage} />}
          />
        ) : (
          <EmptyState
            icon={Search}
            title="Không có sự kiện nào khớp"
            description="Hãy thử khoảng thời gian dài hơn hoặc xóa bộ lọc."
            actions={
              <Button variant="tertiary" onPress={reset}>
                Đặt lại bộ lọc
              </Button>
            }
            boxed
            compact
          />
        )}
      </Gate>
      <PlatformDrawer
        isOpen={Boolean(open)}
        onClose={() => url.set({ open: null })}
        lead={selected ? <ActorAvatar name={selected.actor} size="lg" /> : undefined}
        title={selected ? selected.action : events.isPending ? "Đang tải sự kiện" : "Không tìm thấy sự kiện"}
        description={selected ? `${selected.actor} · ${rel(selected.at)}` : undefined}
        footer={
          to ? (
            <Button variant="primary" onPress={to.run}>
              {to.label}
              <ArrowRight className="i" aria-hidden />
            </Button>
          ) : null
        }
      >
        {selected ? (
          <>
            <section className="drawer__section">
              <KeyValue
                pairs={[
                  selected.target ? ["Đối tượng", selected.target] : null,
                  ["Khu vực", selected.area],
                  ["Không gian làm việc", <WsCell key="ws" workspace={selected.workspaceId ? wsById.get(selected.workspaceId) : null} />],
                  ["Kết quả", <StatusChip key="o" kind="outcome" value={selected.outcome} />],
                  ["Thời gian", fmtDateTime(selected.at)],
                ]}
              />
            </section>
            <section className="drawer__section">
              <Disclosure icon={Info} title="Chi tiết kỹ thuật">
                <KeyValue
                  pairs={[
                    [
                      "Mã sự kiện",
                      <span key="id" className="row gap-4">
                        <span className="mono t-sm">{lastSegment(selected.id)}</span>
                        <IconButton icon={Copy} tip="Sao chép mã sự kiện" size="sm" className="act-copy" onPress={() => void copyText(lastSegment(selected.id), "Đã sao chép mã sự kiện")} />
                      </span>,
                    ],
                    ["Địa chỉ IP", <span key="ip" className="mono t-sm">{selected.ip || "—"}</span>],
                  ]}
                />
              </Disclosure>
            </section>
          </>
        ) : events.isPending ? (
          <SkeletonRows rows={4} />
        ) : null}
      </PlatformDrawer>
      <WorkspaceDrawer workspaceId={url.get("workspace") || null} onClose={() => url.set({ workspace: null })} />
    </Page>
  );
}
