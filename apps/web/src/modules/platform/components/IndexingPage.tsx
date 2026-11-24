"use client";

import { Button, Checkbox, Description, FieldError, Input, Label, ListBox, Select, TextField } from "@heroui/react";
import { AlertCircle, CheckCircle2, Database, FileText, List as ListIcon, Pause, Play, RotateCw } from "lucide-react";
import { useState } from "react";

import {
  Callout,
  ClearFilters,
  DataTable,
  EmptyState,
  ErrorState,
  FilterButton,
  FormSection,
  ItemIcon,
  KeyValue,
  List,
  ListItem,
  NoMatches,
  Page,
  PageHeader,
  Pager,
  PreviewChip,
  SaveBar,
  SearchInput,
  Section,
  SkeletonRows,
  StatusChip,
  SwitchRow,
  Tip,
  toast,
  WorkspaceMark,
} from "@/components/ui";
import { errorMessage } from "@/lib/api/client";
import { fmtDate, fmtDateTime, fmtDuration, fmtNum, plural, rel } from "@/lib/format";
import { SEARCH_PAUSE_MS, useDebounced } from "@/lib/debounce";
import { useMessages } from "@/lib/i18n";
import { indexingSections, sectionTitle, useSection } from "@/lib/navigation";
import { cancelIngestionRun } from "@/modules/curation/api";

import { pauseIngestion, resumeIngestion, retryFailed, updateIngestionPolicy, type IngestionPolicy, type IngestionTask, type Workspace } from "../api";
import {
  buildIndexing,
  DEGRADED_FAILURE_RATE,
  ERROR_CLASSES,
  errorClassOf,
  FILE_TYPE_GROUPS,
  fmtRate,
  JOB_STATUS,
  jobStatus,
  lastSegment,
  MAX_FILE_MB,
  PHASE_LABEL,
  policyDirty,
  policyErrors,
  policyForm,
  policyPatch,
  RETENTION_OPTIONS,
  sortIndexing,
  taskDuration,
  userName,
  workspaceIdOf,
  type ErrorClass,
  type IndexStatus,
  type JobStatus,
  type PolicyForm,
  type WorkspaceIndexing,
} from "../model";
import {
  pk,
  useIngestionPolicy,
  useIngestionSummaries,
  useInvalidatePlatform,
  useIsPlatformAdmin,
  useLastPolicyChange,
  usePlatformUser,
  usePlatformWorkspaces,
  useTask,
  useTaskPages,
} from "../queries";
import { PlatformDrawer, PREVIEW_TIP, useUrlState, type UrlState } from "./shared";

const JOBS_PAGE = 12;
/** Latest jobs listed in the workspace drawer. */
const RECENT_JOBS = 6;

function WsName({ workspace }: { workspace?: Workspace }) {
  if (!workspace) return <span className="muted">Không gian làm việc đã gỡ</span>;
  return (
    <span className="row gap-8 pix-min">
      <WorkspaceMark name={workspace.displayName ?? ""} logo={workspace.logoUri} size={20} />
      <span className="truncate" translate="no">
        {workspace.displayName}
      </span>
    </span>
  );
}

const WS_CHIP: Record<IndexStatus, { tone: "success" | "warning" | "default"; label: string; variant: "tertiary" | "soft" }> = {
  healthy: { tone: "success", label: "Ổn định", variant: "tertiary" },
  degraded: { tone: "warning", label: "Suy giảm", variant: "soft" },
  paused: { tone: "default", label: "Đã tạm dừng", variant: "soft" },
};

function IndexChip({ status }: { status: IndexStatus }) {
  const c = WS_CHIP[status];
  return status === "paused" ? (
    <StatusChip label={c.label} tone={c.tone} variant={c.variant} icon={Pause} dot={false} size="sm" />
  ) : (
    <StatusChip label={c.label} tone={c.tone} variant={c.variant} size="sm" />
  );
}

function JobChip({ task, paused }: { task: IngestionTask; paused: boolean }) {
  const st = jobStatus(task, paused);
  if (st === "failed") {
    const e = ERROR_CLASSES[errorClassOf(task.errorClass)];
    return <StatusChip label={e.label} tone="danger" icon={AlertCircle} tooltip={e.hint} size="sm" />;
  }
  const j = JOB_STATUS[st];
  return (
    <StatusChip
      label={j.label}
      tone={j.tone}
      variant={st === "done" ? "tertiary" : "soft"}
      dot={st !== "held"}
      live={st === "running"}
      tooltip={st === "held" ? "Đã tạm dừng lập chỉ mục cho không gian làm việc này" : undefined}
      size="sm"
    />
  );
}

/** The job's short ID (task IDs are item IDs: long and opaque). */
const jobId = (t: IngestionTask) => lastSegment(t.name).slice(0, 8);

/** Running time so far, or the finished duration; null when there is nothing to show. */
function jobDuration(t: IngestionTask): number | null {
  if (t.state === "RUNNING" && t.startTime) return Date.now() - Date.parse(t.startTime);
  return t.state === "QUEUED" ? null : taskDuration(t);
}

/**
 * Pausing holds new work but deletes nothing (published documents stay searchable): at once, with Undo; resuming
 * likewise. Retrying starts a run over the workspace's failed documents; Undo cancels that run.
 */
function useIndexingActions() {
  const invalidate = useInvalidatePlatform();
  const refresh = () => invalidate(pk.workspaces, pk.indexing, pk.tasks);
  const undoWith = (work: () => Promise<unknown>) => () =>
    void work()
      .then(refresh)
      .catch((error: unknown) => toast(errorMessage(error), { tone: "danger" }));

  const togglePause = async (w: Workspace) => {
    const pause = w.ingestionState !== "PAUSED";
    try {
      const updated = await (pause ? pauseIngestion(w) : resumeIngestion(w));
      await refresh();
      toast(pause ? `Đã tạm dừng lập chỉ mục cho ${w.displayName}. Tệp mới chờ trong hàng đợi.` : `Đã tiếp tục lập chỉ mục cho ${w.displayName}. Các tác vụ trong hàng đợi bắt đầu ngay.`, {
        undo: undoWith(() => (pause ? resumeIngestion(updated) : pauseIngestion(updated))),
      });
    } catch (error) {
      toast(errorMessage(error), { tone: "danger" });
    }
  };

  const retry = async (w: Workspace, row: WorkspaceIndexing | undefined) => {
    const n = row?.retryable ?? 0;
    const skipped = (row?.failed ?? 0) - n;
    if (!n) {
      toast(skipped ? `Không tác vụ nào trong số này thử lại được. ${plural(skipped, "job")} cần không gian làm việc thay tệp.` : "Không có tác vụ lỗi để thử lại", { tone: "accent" });
      return;
    }
    try {
      const run = await retryFailed(lastSegment(w.name));
      await refresh();
      const held = w.ingestionState === "PAUSED" ? " · sẽ chạy khi tiếp tục lập chỉ mục" : "";
      toast(`Đang thử lại ${plural(run.counts?.totalCount ?? n, "job")}${held}${skipped > 0 ? ` · ${skipped} không thử lại được` : ""}`, { undo: undoWith(() => cancelIngestionRun(run.name ?? "")) });
    } catch (error) {
      toast(errorMessage(error), { tone: "danger" });
    }
  };

  return { togglePause, retry };
}

/** Open the Jobs section with these filters (preview `showJobs`). */
function showJobs(url: UrlState, f: { ws?: string; status?: string; err?: string }) {
  url.set({ tab: "jobs", open: null, job: null, q: null, page: null, ws: f.ws ?? null, status: f.status ?? null, err: f.err ?? null });
}

/* ── By workspace ── */

function WorkspacesSection({ rows, byId, url }: { rows: readonly WorkspaceIndexing[]; byId: Map<string, Workspace>; url: UrlState }) {
  const actions = useIndexingActions();
  const isAdmin = useIsPlatformAdmin();
  const failed = new Map<ErrorClass, { count: number; workspaces: number }>();
  for (const r of rows) {
    for (const e of r.errors) {
      const cur = failed.get(e.errorClass) ?? { count: 0, workspaces: 0 };
      failed.set(e.errorClass, { count: cur.count + e.count, workspaces: cur.workspaces + 1 });
    }
  }
  const errorList = (Object.keys(ERROR_CLASSES) as ErrorClass[]).filter((k) => failed.has(k)).sort((a, b) => (failed.get(b)?.count ?? 0) - (failed.get(a)?.count ?? 0));

  return (
    <>
      <DataTable
        label="Lập chỉ mục theo không gian làm việc"
        rows={sortIndexing(rows)}
        getRowId={(r) => r.workspaceId}
        onRowAction={(r) => url.set({ open: r.workspaceId })}
        columns={[
          { id: "name", header: "Không gian làm việc", primary: true, cell: (r) => <WsName workspace={byId.get(r.workspaceId)} /> },
          { id: "status", header: "Trạng thái", cell: (r) => <IndexChip status={r.status} /> },
          { id: "queue", header: "Hàng đợi", align: "end", mobileLabel: "Hàng đợi", cell: (r) => <span className="num">{fmtNum(r.queue)}</span> },
          {
            id: "fail",
            header: "Tỷ lệ lỗi",
            align: "end",
            mobileLabel: "Tỷ lệ lỗi",
            cell: (r) => <span className={`num ${r.failureRate >= DEGRADED_FAILURE_RATE ? "text-warning medium" : ""}`}>{fmtRate(r.failureRate)}</span>,
          },
        ]}
        // Paused is the exceptional state, so Resume stays one click away; Pause lives in the row menu.
        rowActionLead={(r) => {
          const w = byId.get(r.workspaceId);
          return w && r.paused && isAdmin ? (
            <Button size="sm" variant="tertiary" onPress={() => void actions.togglePause(w)}>
              <Play className="i" aria-hidden />
              Tiếp tục
            </Button>
          ) : null;
        }}
        rowActions={(r) => {
          const w = byId.get(r.workspaceId);
          if (!w) return [];
          return [
            ...(isAdmin
              ? [{ id: "retry", label: r.retryable ? `Thử lại ${plural(r.retryable, "tác vụ lỗi")}` : "Thử lại tác vụ lỗi", icon: RotateCw, isDisabled: !r.retryable, onAction: () => void actions.retry(w, r) }]
              : []),
            { id: "jobs", label: "Hiện tác vụ", icon: ListIcon, onAction: () => showJobs(url, { ws: r.workspaceId }) },
            ...(isAdmin ? [{ id: "pause", label: r.paused ? "Tiếp tục lập chỉ mục" : "Tạm dừng lập chỉ mục", icon: r.paused ? Play : Pause, onAction: () => void actions.togglePause(w) }] : []),
          ];
        }}
      />
      <Section title="Lỗi" description="Tác vụ lỗi trong 24 giờ qua, theo nguyên nhân.">
        {errorList.length ? (
          <List className="pix-errs">
            {errorList.map((k) => {
              const e = ERROR_CLASSES[k];
              const agg = failed.get(k) ?? { count: 0, workspaces: 0 };
              return (
                <ListItem
                  key={k}
                  lead={<ItemIcon icon={AlertCircle} tone={e.retry ? "warning" : "danger"} size="sm" />}
                  title={e.label}
                  titleExtra={<span className="num muted"> · {fmtNum(agg.count)}</span>}
                  description={
                    <>
                      {e.hint} <span className="muted">Trong {plural(agg.workspaces, "workspace")}.</span>
                    </>
                  }
                  actions={
                    <Button variant="ghost" size="sm" onPress={() => showJobs(url, { err: k, status: "failed" })}>
                      Hiện tác vụ
                    </Button>
                  }
                />
              );
            })}
          </List>
        ) : (
          <EmptyState icon={CheckCircle2} tone="success" title="Không có tác vụ lỗi trong 24 giờ qua" compact boxed />
        )}
      </Section>
    </>
  );
}

/* ── Jobs ── */

/** The server filter for a Jobs status (paused workspaces hold queued and running jobs). */
const STATUS_FILTER: Record<JobStatus, string> = {
  queued: "state = QUEUED",
  running: "state = RUNNING",
  held: "(state = QUEUED OR state = RUNNING)",
  done: "state = SUCCEEDED",
  failed: "state = FAILED",
  cancelled: "state = CANCELLED",
};

function JobsSection({ byId, url }: { byId: Map<string, Workspace>; url: UrlState }) {
  const isPaused = (t: IngestionTask) => byId.get(workspaceIdOf(t.name))?.ingestionState === "PAUSED";
  const q = url.get("q");
  const ws = url.get("ws");
  const status = url.get("status");
  const err = url.get("err");
  const needle = useDebounced(q.trim(), SEARCH_PAUSE_MS);
  const filter = [
    status && STATUS_FILTER[status as JobStatus],
    err && `state = FAILED AND errorClass = ${JSON.stringify(err)}`,
    needle && `name = ${JSON.stringify(`*${needle}*`)}`,
  ]
    .filter(Boolean)
    .join(" AND ");
  const tasks = useTaskPages({ workspace: ws, filter }, JOBS_PAGE);
  const rows = tasks.data?.tasks ?? [];
  const wsOptions = [...byId.entries()].map(([id, w]) => ({ value: id, label: w.displayName ?? "" }));

  return (
    <>
      <div className="toolbar">
        <SearchInput value={q} onChange={(v) => url.set({ q: v, page: null })} placeholder="Tìm ID tác vụ" />
        <FilterButton label="Không gian làm việc" value={ws} onChange={(v) => url.set({ ws: v, page: null })} options={wsOptions} />
        <FilterButton
          label="Trạng thái"
          value={status}
          onChange={(v) => url.set({ status: v, page: null })}
          options={(Object.keys(JOB_STATUS) as JobStatus[]).map((k) => ({ value: k, label: JOB_STATUS[k].label }))}
        />
        <FilterButton
          label="Lỗi"
          value={err}
          onChange={(v) => url.set({ err: v, page: null })}
          options={(Object.keys(ERROR_CLASSES) as ErrorClass[]).map((k) => ({ value: k, label: ERROR_CLASSES[k].label }))}
        />
        <ClearFilters isActive={Boolean(ws || status || err)} onClear={() => url.set({ ws: null, status: null, err: null, page: null })} />
      </div>
      <p className="t-sm muted pix-note">Chỉ siêu dữ liệu tác vụ. Tên và nội dung vẫn nằm trong không gian làm việc.</p>
      {tasks.isError && !tasks.data ? (
        <ErrorState error={tasks.error} onRetry={tasks.refetch} />
      ) : tasks.isPending ? (
        <SkeletonRows rows={6} />
      ) : rows.length ? (
        <DataTable
          label="Tác vụ gần đây"
          rows={rows}
          getRowId={(t) => t.name ?? ""}
          onRowAction={(t) => url.set({ job: t.name ?? null })}
          columns={[
            {
              id: "job",
              header: "Tác vụ",
              primary: true,
              cell: (t) => {
                const ms = jobDuration(t);
                const sub = [t.phase ? PHASE_LABEL[t.phase] : "", ms === null ? "" : fmtDuration(ms)].filter(Boolean).join(" · ");
                return (
                  <div className="row gap-12">
                    <ItemIcon icon={FileText} size="sm" />
                    <div className="stack">
                      <span className="mono pix-job" title={lastSegment(t.name)}>
                        {jobId(t)}
                      </span>
                      {sub ? <span className="cell-sub num">{sub}</span> : null}
                    </div>
                  </div>
                );
              },
            },
            { id: "ws", header: "Không gian làm việc", cell: (t) => <WsName workspace={byId.get(workspaceIdOf(t.name))} /> },
            { id: "status", header: "Trạng thái", cell: (t) => <JobChip task={t} paused={isPaused(t)} /> },
            {
              id: "when",
              header: "Thời điểm",
              align: "end",
              className: "pix-nowrap",
              cell: (t) => (
                <Tip content={fmtDateTime(t.createTime)}>
                  <span className="muted num">{rel(t.createTime)}</span>
                </Tip>
              ),
            },
          ]}
          footer={<Pager page={tasks.page} pageSize={JOBS_PAGE} total={tasks.total} pageCount={rows.length} hasNext={tasks.hasNext} onPageChange={tasks.setPage} />}
        />
      ) : (
        <NoMatches what="tác vụ" onClear={() => url.set({ q: null, ws: null, status: null, err: null, page: null })} />
      )}
    </>
  );
}

/* ── Policies ── */

function PolicySection({ policy, isAdmin }: { policy: IngestionPolicy; isAdmin: boolean }) {
  const invalidate = useInvalidatePlatform();
  const saved = policyForm(policy);
  const [form, setForm] = useState<PolicyForm>(saved);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const errors = tried ? policyErrors(form) : {};
  const dirty = policyDirty(form, saved);
  const patch = (p: Partial<PolicyForm>) => setForm((f) => ({ ...f, ...p }));
  const lastChange = useLastPolicyChange();
  const changer = usePlatformUser(lastChange.data?.actor ? lastSegment(lastChange.data.actor) : null).data;

  const save = async () => {
    setTried(true);
    const e = policyErrors(form);
    if (Object.keys(e).length) {
      document.querySelector<HTMLInputElement>(e.types ? ".pix-types input" : "#pix-maxmb")?.focus();
      return;
    }
    setBusy(true);
    const before = policy;
    try {
      const updated = await updateIngestionPolicy(policyPatch(form, policy));
      await invalidate(pk.policy);
      setTried(false);
      toast("Đã lưu chính sách lập chỉ mục. Tác vụ mới áp dụng ngay.", {
        undo: () =>
          void updateIngestionPolicy({ ...policyPatch(policyForm(before), updated), allowedMimeTypes: before.allowedMimeTypes })
            .then(() => invalidate(pk.policy))
            .catch((error: unknown) => toast(errorMessage(error), { tone: "danger" })),
      });
    } catch (error) {
      toast(errorMessage(error), { tone: "danger" });
    } finally {
      setBusy(false);
    }
  };

  const n = Object.keys(errors).length;
  return (
    <section className="pix-policy" id="pix-policies" aria-label="Chính sách lập chỉ mục">
      <p className="t-sm muted pix-policy__note">
        <span>Áp dụng cho mọi không gian làm việc trên bản triển khai này.</span>
        {lastChange.data ? (
          <span>{changer ? `${userName(changer)} thay đổi lần cuối · ${fmtDate(lastChange.data.createTime)}` : `Thay đổi lần cuối ${fmtDate(lastChange.data.createTime)}`}</span>
        ) : null}
      </p>
      <FormSection title="Loại tệp" description="Các loại khác vẫn được lưu nhưng không tra cứu được.">
        <div className="pix-types" role="group" aria-label="Loại tệp được phép">
          {FILE_TYPE_GROUPS.map((g) => (
            <Checkbox
              key={g.id}
              isSelected={form.types.includes(g.id)}
              isDisabled={!isAdmin}
              onChange={(on) => patch({ types: on ? [...form.types, g.id] : form.types.filter((t) => t !== g.id) })}
            >
              <Checkbox.Content>
                <Checkbox.Control>
                  <Checkbox.Indicator />
                </Checkbox.Control>
                {g.label}
              </Checkbox.Content>
            </Checkbox>
          ))}
        </div>
        {errors.types ? (
          <div className="field-error" role="alert">
            <AlertCircle className="i" aria-hidden />
            <span>{errors.types}</span>
          </div>
        ) : null}
      </FormSection>
      <FormSection title="Kích thước">
        <TextField value={form.maxMb} onChange={(v) => patch({ maxMb: v })} isInvalid={Boolean(errors.maxMb)} isDisabled={!isAdmin} type="number">
          <Label>Kích thước tệp tối đa</Label>
          <div className="pix-size">
            <Input id="pix-maxmb" min={1} max={MAX_FILE_MB} step={1} inputMode="numeric" />
            <span className="t-sm muted">MB</span>
          </div>
          {errors.maxMb ? null : <Description>Tệp lớn hơn sẽ không tải lên được và báo lỗi “Quá lớn”.</Description>}
          <FieldError>{errors.maxMb}</FieldError>
        </TextField>
      </FormSection>
      <FormSection title="Đọc tệp">
        <SwitchRow title="Đọc PDF được quét (OCR)" description="Chậm hơn. Cần cho bản quét và ảnh chụp trang." isSelected={form.ocr} isDisabled={!isAdmin} onChange={(on) => patch({ ocr: on })} />
        <SwitchRow
          title="Phân tích bảng tính"
          description="Đọc trang tính và hàng để câu trả lời có thể trích dẫn ô. Tắt: bảng tính chỉ được lưu dưới dạng tệp."
          isSelected={form.sheets}
          isDisabled={!isAdmin}
          onChange={(on) => patch({ sheets: on })}
        />
      </FormSection>
      <FormSection title="Duyệt">
        <SwitchRow
          title="Tệp tải lên cần được duyệt trước khi công bố"
          description="Luôn bật. Tệp tải lên chỉ tra cứu được sau khi người duyệt trong không gian làm việc duyệt; với tệp đồng bộ, mỗi không gian làm việc tự chọn theo từng nguồn dữ liệu."
          isSelected
          isDisabled
          onChange={() => undefined}
        />
      </FormSection>
      <FormSection title="Lưu giữ">
        <Select fullWidth value={form.retention} isDisabled={!isAdmin} onChange={(key) => key && patch({ retention: String(key) })}>
          <Label>Xóa tài liệu bị từ chối sau</Label>
          <Select.Trigger>
            <Select.Value />
            <Select.Indicator />
          </Select.Trigger>
          <Description>Áp dụng cho mọi không gian làm việc. Cài đặt này không bao giờ xóa tài liệu đã duyệt.</Description>
          <Select.Popover>
            <ListBox>
              {(RETENTION_OPTIONS.some((o) => o.value === form.retention) ? RETENTION_OPTIONS : [...RETENTION_OPTIONS, { value: form.retention, label: plural(Number(form.retention), "day") }]).map((o) => (
                <ListBox.Item key={o.value} id={o.value} textValue={o.label}>
                  {o.label}
                  <ListBox.ItemIndicator />
                </ListBox.Item>
              ))}
            </ListBox>
          </Select.Popover>
        </Select>
      </FormSection>
      <SaveBar
        isDirty={dirty}
        isSaving={busy}
        onSave={() => void save()}
        onDiscard={() => {
          setForm(saved);
          setTried(false);
        }}
        message={`Có thay đổi chưa lưu${tried && n ? ` · ${plural(n, "field")} cần sửa` : ""}`}
      />
    </section>
  );
}

/* ── Drawers ── */

/** Preview `DR['pix-ws']`: one workspace's indexing health, errors and recent jobs; pause/resume and retry. */
function WorkspaceIndexDrawer({ workspace, row, url }: { workspace: Workspace | undefined; row: WorkspaceIndexing | undefined; url: UrlState }) {
  const actions = useIndexingActions();
  const isAdmin = useIsPlatformAdmin();
  const tasks = useTaskPages({ workspace: row?.workspaceId ?? "", filter: "" }, RECENT_JOBS, !!row);
  const close = () => url.set({ open: null });
  if (!workspace || !row) {
    return (
      <PlatformDrawer isOpen onClose={close} title="Không tìm thấy không gian làm việc" footer={<Button onPress={close}>Đóng</Button>}>
        <EmptyState icon={Database} title="Không gian làm việc này không còn tồn tại" compact />
      </PlatformDrawer>
    );
  }
  const recent = tasks.data?.tasks ?? [];
  return (
    <PlatformDrawer
      isOpen
      onClose={close}
      lead={<WorkspaceMark name={workspace.displayName ?? ""} logo={workspace.logoUri} size={36} />}
      title={<span translate="no">{workspace.displayName}</span>}
      description="Chỉ siêu dữ liệu tác vụ"
      footer={
        isAdmin ? (
          <>
            <Button variant="tertiary" onPress={() => void actions.togglePause(workspace)}>
              {row.paused ? <Play className="i" aria-hidden /> : <Pause className="i" aria-hidden />}
              {row.paused ? "Tiếp tục lập chỉ mục" : "Tạm dừng lập chỉ mục"}
            </Button>
            {/* Retry shows only when something failed; disabled (with the reason) when none of the failures can be retried. */}
            {row.failed ? (
              <Tip content={row.retryable ? "" : "Các tác vụ này cần không gian làm việc thay tệp"}>
                <span>
                  <Button variant="primary" isDisabled={!row.retryable} onPress={() => void actions.retry(workspace, row)}>
                    <RotateCw className="i" aria-hidden />
                    {row.retryable ? `Thử lại ${plural(row.retryable, "tác vụ lỗi")}` : "Thử lại tác vụ lỗi"}
                  </Button>
                </span>
              </Tip>
            ) : null}
          </>
        ) : null
      }
    >
      <section className="drawer__section">
        {row.paused ? (
          <div className="mb-16">
            <Callout icon={Pause} title="Đã tạm dừng lập chỉ mục" description="Tệp mới và tệp đã thay đổi chờ trong hàng đợi." />
          </div>
        ) : null}
        <KeyValue
          pairs={[
            ["Trạng thái", <IndexChip key="s" status={row.status} />],
            ["Hàng đợi", <span key="q" className="num">{plural(row.queue, "job")}</span>],
            ["Đã công bố, 24 giờ", <span key="p" className="num">{fmtNum(row.published24)}</span>],
            ["Tỷ lệ lỗi", <span key="f" className={`num ${row.failureRate >= DEGRADED_FAILURE_RATE ? "text-warning medium" : ""}`}>{fmtRate(row.failureRate)}</span>],
            ["Thời gian trung vị", row.medianMs ? fmtDuration(row.medianMs) : "—"],
          ]}
        />
      </section>
      <section className="drawer__section">
        <h3 className="drawer__section-title">Lỗi, 24 giờ qua</h3>
        {row.errors.length ? (
          <List>
            {row.errors.map((e) => (
              <ListItem
                key={e.errorClass}
                lead={<ItemIcon icon={AlertCircle} tone={ERROR_CLASSES[e.errorClass].retry ? "warning" : "danger"} size="sm" />}
                title={ERROR_CLASSES[e.errorClass].label}
                description={ERROR_CLASSES[e.errorClass].hint}
                meta={<span className="num medium">{fmtNum(e.count)}</span>}
              />
            ))}
          </List>
        ) : (
          <p className="t-sm muted">Không có tác vụ lỗi trong 24 giờ qua.</p>
        )}
      </section>
      <section className="drawer__section">
        <div className="row between gap-8">
          <h3 className="drawer__section-title">Tác vụ gần đây</h3>
          <Button variant="ghost" size="sm" onPress={() => showJobs(url, { ws: row.workspaceId })}>
            Hiển thị tất cả
          </Button>
        </div>
        {recent.length ? (
          <List>
            {recent.map((t) => (
              <ListItem
                key={t.name}
                lead={<ItemIcon icon={FileText} size="sm" />}
                title={<span className="mono">{jobId(t)}</span>}
                label={`Tác vụ ${lastSegment(t.name)}`}
                description={`${t.phase ? PHASE_LABEL[t.phase] : "—"} · ${rel(t.createTime)}`}
                actions={<JobChip task={t} paused={row.paused} />}
                onPress={() => url.set({ job: t.name ?? null })}
              />
            ))}
          </List>
        ) : (
          <p className="t-sm muted">Chưa có tác vụ.</p>
        )}
      </section>
    </PlatformDrawer>
  );
}

/** Preview `DR['pix-job']`: one job, metadata only; the workspace is one link away. */
function JobDrawer({ task, workspace, url }: { task: IngestionTask | undefined; workspace: Workspace | undefined; url: UrlState }) {
  const close = () => url.set({ job: null });
  if (!task) {
    return (
      <PlatformDrawer isOpen onClose={close} title="Không tìm thấy tác vụ">
        <EmptyState icon={Database} title="Tác vụ này không còn trong nhật ký" compact />
      </PlatformDrawer>
    );
  }
  const paused = workspace?.ingestionState === "PAUSED";
  const st = jobStatus(task, paused);
  const e = ERROR_CLASSES[errorClassOf(task.errorClass)];
  const ms = jobDuration(task);
  return (
    <PlatformDrawer isOpen onClose={close} lead={<ItemIcon icon={FileText} />} title={<span className="mono">{jobId(task)}</span>} description="Chỉ siêu dữ liệu tác vụ">
      {st === "failed" ? (
        <section className="drawer__section">
          <Callout tone={e.retry ? "warning" : "danger"} icon={AlertCircle} title={e.label} description={e.hint} />
        </section>
      ) : st === "held" ? (
        <section className="drawer__section">
          <Callout icon={Pause} title="Đang chờ" description="Lập chỉ mục đang tạm dừng cho không gian làm việc này. Tác vụ sẽ chạy khi tiếp tục." />
        </section>
      ) : null}
      <section className="drawer__section">
        <KeyValue
          pairs={[
            ["Trạng thái", <JobChip key="s" task={task} paused={paused} />],
            [
              "Không gian làm việc",
              workspace ? (
                <button key="w" type="button" className="link-button pf-link" onClick={() => url.set({ job: null, open: lastSegment(workspace.name) })}>
                  {workspace.displayName}
                </button>
              ) : (
                <span key="w" className="muted">
                  Không gian làm việc đã gỡ
                </span>
              ),
            ],
            ["Giai đoạn", task.phase ? PHASE_LABEL[task.phase] : "—"],
            ["Thời lượng", ms === null ? "—" : fmtDuration(ms)],
            ["Bắt đầu", fmtDateTime(task.startTime ?? task.createTime)],
            ["Mã tác vụ", <span key="id" className="mono t-sm">{lastSegment(task.name)}</span>],
          ]}
        />
      </section>
    </PlatformDrawer>
  );
}

/* ── Page ── */

/** Preview `P.pIndexing`: indexing health across workspaces without content access; sections are sidebar sub-rows. */
export function IndexingPage() {
  const url = useUrlState();
  const tab = useSection(indexingSections, "workspaces");
  const m = useMessages();
  const isAdmin = useIsPlatformAdmin();
  const workspaces = usePlatformWorkspaces();
  const summaries = useIngestionSummaries();
  const job = url.get("job");
  const jobTask = useTask(job || null);
  const policy = useIngestionPolicy();

  const byId = new Map((workspaces.data ?? []).map((w) => [lastSegment(w.name), w]));
  const rows = workspaces.data && summaries.data ? buildIndexing(workspaces.data, summaries.data.now, summaries.data.day) : null;

  /** One sentence: what needs attention right now. */
  const summary = () => {
    if (!rows) return undefined;
    const attention = rows.filter((r) => r.status !== "healthy").length;
    const queued = rows.reduce((a, r) => a + r.queue, 0);
    const failed = rows.reduce((a, r) => a + r.failed, 0);
    return `${attention ? `${plural(attention, "workspace")} cần chú ý` : "Mọi không gian làm việc đều ổn định"} · ${plural(queued, "job")} đang chờ · ${plural(failed, "tác vụ lỗi")} trong 24 giờ qua.`;
  };

  const body = () => {
    if (tab === "policies") {
      if (policy.data) return <PolicySection key={policy.data.etag} policy={policy.data} isAdmin={isAdmin} />;
      if (policy.isError) return <ErrorState error={policy.error} onRetry={policy.refetch} />;
      return <SkeletonRows rows={6} />;
    }
    const error = workspaces.error ?? summaries.error;
    if (error && !rows) return <ErrorState title="Không tải được trạng thái lập chỉ mục" error={error} onRetry={() => void Promise.all([workspaces.refetch(), summaries.refetch()])} />;
    if (!rows) return <SkeletonRows rows={8} />;
    if (!rows.length) return <EmptyState icon={Database} title="Chưa có tác vụ lập chỉ mục" description="Tác vụ sẽ xuất hiện khi các không gian làm việc thêm tài liệu." boxed />;
    return tab === "jobs" ? <JobsSection byId={byId} url={url} /> : <WorkspacesSection rows={rows} byId={byId} url={url} />;
  };

  const open = url.get("open");
  return (
    <Page width="wide">
      <PageHeader title={sectionTitle(indexingSections, tab, m)} chips={<PreviewChip tooltip={PREVIEW_TIP} />} meta={tab === "workspaces" ? summary() : undefined} />
      <div className="pix">{body()}</div>
      {open && rows ? <WorkspaceIndexDrawer workspace={byId.get(open)} row={rows.find((r) => r.workspaceId === open)} url={url} /> : null}
      {job && !jobTask.isPending ? <JobDrawer task={jobTask.data} workspace={byId.get(workspaceIdOf(job))} url={url} /> : null}
    </Page>
  );
}
