"use client";

import { Button, Checkbox, Description, FieldError, Input, Label, ListBox, Select, TextField } from "@heroui/react";
import { AlertCircle, CheckCircle2, Database, List as ListIcon, Lock, Pause, Play, RotateCw, Settings } from "lucide-react";
import { useState } from "react";

import { PageChrome } from "@/components/shell/page-chrome";
import {
  Callout,
  ClearFilters,
  confirm,
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
  paginate,
  PreviewChip,
  SaveBar,
  SearchInput,
  Section,
  SkeletonRows,
  StatusChip,
  SwitchRow,
  toast,
  WorkspaceMark,
} from "@/components/ui";
import { errorMessage } from "@/lib/api/client";
import { fmtDate, fmtDateTime, fmtDuration, fmtNum, plural, rel } from "@/lib/format";

import { cancelRun, pauseIngestion, resumeIngestion, retryFailed, updateIngestionPolicy, type IngestionPolicy, type IngestionTask, type Workspace } from "../api";
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
  useComponents,
  useIngestionPolicy,
  useIngestionSummaries,
  useInvalidatePlatform,
  useIsPlatformAdmin,
  useLastPolicyChange,
  usePlatformUsers,
  usePlatformWorkspaces,
  useRecentTasks,
} from "../queries";
import { PlatformDrawer, PREVIEW_TIP, useUrlState } from "./shared";

const JOBS_PAGE = 12;

function WsName({ workspace }: { workspace?: Workspace }) {
  if (!workspace) return <span className="muted">Removed workspace</span>;
  return (
    <span className="row gap-8 pix-min">
      <WorkspaceMark name={workspace.displayName ?? ""} size={20} />
      <span className="truncate" translate="no">
        {workspace.displayName}
      </span>
    </span>
  );
}

const WS_CHIP: Record<IndexStatus, { tone: "success" | "warning" | "default"; label: string; variant: "tertiary" | "soft" }> = {
  healthy: { tone: "success", label: "Healthy", variant: "tertiary" },
  degraded: { tone: "warning", label: "Degraded", variant: "soft" },
  paused: { tone: "default", label: "Paused", variant: "soft" },
};

function IndexChip({ status }: { status: IndexStatus }) {
  const c = WS_CHIP[status];
  return status === "paused" ? (
    <StatusChip label={c.label} tone={c.tone} variant={c.variant} icon={Pause} size="sm" />
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
      tooltip={st === "held" ? "Indexing is paused for this workspace" : undefined}
      size="sm"
    />
  );
}

/** Pause / resume with the preview's confirmations and Undo; retry failed jobs (Undo cancels the new run). */
function useIndexingActions() {
  const invalidate = useInvalidatePlatform();
  const refresh = () => invalidate(pk.workspaces, pk.indexing, pk.tasks);

  const setPaused = async (w: Workspace, paused: boolean, undo = true) => {
    try {
      const updated = await (paused ? pauseIngestion(w) : resumeIngestion(w));
      await refresh();
      toast(paused ? `Paused indexing for ${w.displayName}` : `Resumed indexing for ${w.displayName}`, undo ? { undo: () => void setPaused(updated, !paused, false) } : {});
    } catch (error) {
      toast(errorMessage(error), { tone: "danger" });
    }
  };

  const togglePause = async (w: Workspace, row: WorkspaceIndexing | undefined) => {
    if (w.ingestionState === "PAUSED") {
      const n = row?.queue ?? 0;
      const ok = await confirm({
        title: `Resume indexing for ${w.displayName}?`,
        description: `${plural(n, "queued job")} start${n === 1 ? "s" : ""} right away.`,
        confirmLabel: "Resume indexing",
        tone: "accent",
      });
      if (ok) await setPaused(w, false);
      return;
    }
    const ok = await confirm({
      title: `Pause indexing for ${w.displayName}?`,
      description: "New and changed files wait in the queue until you resume. Published documents stay searchable.",
      confirmLabel: "Pause indexing",
      tone: "danger",
    });
    if (ok) await setPaused(w, true);
  };

  const retry = async (w: Workspace, row: WorkspaceIndexing | undefined) => {
    const n = row?.retryable ?? 0;
    const skipped = (row?.failed ?? 0) - n;
    if (!n) {
      toast(skipped ? `None of these can be retried. ${plural(skipped, "job")} need${skipped === 1 ? "s" : ""} the workspace to replace the file.` : "No failed jobs to retry", { tone: "accent" });
      return;
    }
    try {
      const run = await retryFailed(lastSegment(w.name));
      await refresh();
      const held = w.ingestionState === "PAUSED" ? " · they run when indexing resumes" : "";
      toast(`Retrying ${plural(run.counts?.totalCount ?? n, "job")}${held}${skipped > 0 ? ` · ${skipped} can’t be retried` : ""}`, {
        undo: () =>
          void cancelRun(run)
            .then(() => refresh())
            .catch((error: unknown) => toast(errorMessage(error), { tone: "danger" })),
      });
    } catch (error) {
      toast(errorMessage(error), { tone: "danger" });
    }
  };

  return { togglePause, retry };
}

/* ── Policies ── */

function PolicySection({ policy, settings, isAdmin }: { policy: IngestionPolicy; settings: { setting: string; name: string }[]; isAdmin: boolean }) {
  const invalidate = useInvalidatePlatform();
  const saved = policyForm(policy);
  const [form, setForm] = useState<PolicyForm>(saved);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const errors = tried ? policyErrors(form) : {};
  const dirty = policyDirty(form, saved);
  const patch = (p: Partial<PolicyForm>) => setForm((f) => ({ ...f, ...p }));
  const lastChange = useLastPolicyChange();
  const users = usePlatformUsers();
  const changer = lastChange.data ? users.data?.find((u) => u.name === lastChange.data?.actor) : undefined;
  const changed = lastChange.data ? (
    <span className="t-xs muted">
      {changer ? `Last changed by ${userName(changer)} · ${fmtDate(lastChange.data.createTime)}` : `Last changed ${fmtDate(lastChange.data.createTime)}`}
    </span>
  ) : null;

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
      toast("Indexing policies saved. New jobs use them right away.", {
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
    <Section id="pix-policies" title="Policies" description="Apply to every workspace on this deployment." actions={changed}>
      <div className="card card--lg pix-policy">
        <FormSection title="File types" description="Other types are stored but not searchable.">
          <div className="pix-types" role="group" aria-label="Allowed file types">
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
        <FormSection title="Size">
          <TextField value={form.maxMb} onChange={(v) => patch({ maxMb: v })} isInvalid={Boolean(errors.maxMb)} isDisabled={!isAdmin} type="number">
            <Label>Maximum file size</Label>
            <div className="pix-size">
              <Input id="pix-maxmb" min={1} max={MAX_FILE_MB} step={1} inputMode="numeric" />
              <span className="t-sm muted">MB</span>
            </div>
            {errors.maxMb ? null : <Description>Larger files are stored but not processed.</Description>}
            <FieldError>{errors.maxMb}</FieldError>
          </TextField>
        </FormSection>
        <FormSection title="Reading">
          <SwitchRow title="Read scanned PDFs (OCR)" description="Slower. Needed for scans and photos of pages." isSelected={form.ocr} isDisabled={!isAdmin} onChange={(on) => patch({ ocr: on })} />
          <SwitchRow
            title="Parse spreadsheets"
            description="Reads sheets and rows so answers can cite cells. Off: spreadsheets are stored as files only."
            isSelected={form.sheets}
            isDisabled={!isAdmin}
            onChange={(on) => patch({ sheets: on })}
          />
        </FormSection>
        <FormSection title="Review">
          <SwitchRow
            title="Uploads need review before publishing"
            description="Always on. Uploads become searchable only after a reviewer in the workspace approves them; workspaces choose this per source for synced files."
            isSelected
            isDisabled
            onChange={() => undefined}
          />
        </FormSection>
        <FormSection title="Retention">
          <Select fullWidth value={form.retention} isDisabled={!isAdmin} onChange={(key) => key && patch({ retention: String(key) })}>
            <Label>Delete declined submissions after</Label>
            <Select.Trigger>
              <Select.Value />
              <Select.Indicator />
            </Select.Trigger>
            <Description>Applies to every workspace. Approved documents are never deleted by this.</Description>
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
        <FormSection title="Deployment settings" description="Read-only. Changed in the deployment configuration and applied on restart.">
          <List className="pix-settings">
            {settings.map((s) => (
              <ListItem key={s.setting} lead={<ItemIcon icon={Settings} size="sm" />} title={<code className="mono">{s.setting}</code>} label={s.setting} description={s.name} />
            ))}
          </List>
        </FormSection>
      </div>
      <SaveBar
        isDirty={dirty}
        isSaving={busy}
        onSave={() => void save()}
        onDiscard={() => {
          setForm(saved);
          setTried(false);
        }}
        message={`Unsaved changes${tried && n ? ` · ${plural(n, "field")} to fix` : ""}`}
      />
    </Section>
  );
}

/* ── Workspace drawer ── */

function IndexingDrawer({
  workspace,
  row,
  tasks,
  onClose,
  onShowJobs,
}: {
  workspace: Workspace | undefined;
  row: WorkspaceIndexing | undefined;
  tasks: readonly IngestionTask[];
  onClose: () => void;
  onShowJobs: () => void;
}) {
  const actions = useIndexingActions();
  if (!workspace || !row) {
    return (
      <PlatformDrawer isOpen onClose={onClose} title="Workspace not found">
        <EmptyState icon={Database} title="This workspace no longer exists" compact />
      </PlatformDrawer>
    );
  }
  const recent = tasks.filter((t) => workspaceIdOf(t.name) === row.workspaceId).slice(0, 6);
  return (
    <PlatformDrawer
      isOpen
      onClose={onClose}
      lead={<WorkspaceMark name={workspace.displayName ?? ""} size={36} />}
      title={<span translate="no">{workspace.displayName}</span>}
      description="Job metadata only"
      footer={
        <>
          <Button variant="tertiary" onPress={() => void actions.togglePause(workspace, row)}>
            {row.paused ? <Play className="i" aria-hidden /> : <Pause className="i" aria-hidden />}
            {row.paused ? "Resume indexing" : "Pause indexing"}
          </Button>
          <Button variant="primary" isDisabled={!row.retryable} onPress={() => void actions.retry(workspace, row)}>
            <RotateCw className="i" aria-hidden />
            {row.retryable ? `Retry ${plural(row.retryable, "failed job")}` : "Retry failed jobs"}
          </Button>
        </>
      }
    >
      <section className="drawer__section">
        {row.paused ? (
          <div className="mb-16">
            <Callout icon={Pause} title="Indexing is paused" description="New and changed files wait in the queue." />
          </div>
        ) : null}
        <KeyValue
          pairs={[
            ["Status", <IndexChip key="s" status={row.status} />],
            ["Queue", <span key="q" className="num">{plural(row.queue, "job")}</span>],
            ["Published, 24 h", <span key="p" className="num">{fmtNum(row.published24)}</span>],
            ["Failure rate", <span key="f" className={`num ${row.failureRate >= DEGRADED_FAILURE_RATE ? "text-warning medium" : ""}`}>{fmtRate(row.failureRate)}</span>],
            ["Median time", row.medianMs ? fmtDuration(row.medianMs) : "—"],
          ]}
        />
      </section>
      <section className="drawer__section">
        <h3 className="drawer__section-title">Errors, last 24 hours</h3>
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
          <p className="t-sm muted">No failed jobs in the last 24 hours.</p>
        )}
      </section>
      <section className="drawer__section">
        <div className="row between gap-8">
          <h3 className="drawer__section-title">Recent jobs</h3>
          <Button variant="ghost" size="sm" onPress={onShowJobs}>
            Show all
          </Button>
        </div>
        {recent.length ? (
          <List>
            {recent.map((t) => (
              <ListItem
                key={t.name}
                lead={<ItemIcon icon={Database} size="sm" />}
                title={<span className="mono">{lastSegment(t.name).slice(0, 8)}</span>}
                label={`Job ${lastSegment(t.name)}`}
                description={`${t.phase ? PHASE_LABEL[t.phase] : "—"} · ${rel(t.createTime)}`}
                meta={<JobChip task={t} paused={row.paused} />}
              />
            ))}
          </List>
        ) : (
          <p className="t-sm muted">No jobs yet.</p>
        )}
      </section>
    </PlatformDrawer>
  );
}

/* ── Page ── */

/** Preview `P.pIndexing`: indexing health across workspaces without content access. */
export function IndexingPage() {
  const url = useUrlState();
  const isAdmin = useIsPlatformAdmin();
  const workspaces = usePlatformWorkspaces();
  const summaries = useIngestionSummaries();
  const tasks = useRecentTasks();
  const policy = useIngestionPolicy();
  const components = useComponents();
  const actions = useIndexingActions();

  const wsList = workspaces.data ?? [];
  const byId = new Map(wsList.map((w) => [lastSegment(w.name), w]));
  const rows = workspaces.data && summaries.data ? buildIndexing(wsList, summaries.data.now, summaries.data.day, tasks.data ?? []) : null;
  const rowById = new Map((rows ?? []).map((r) => [r.workspaceId, r]));
  const taskList = tasks.data ?? [];
  const isPaused = (t: IngestionTask) => byId.get(workspaceIdOf(t.name))?.ingestionState === "PAUSED";

  const jq = url.get("jq");
  const jws = url.get("jws");
  const jstatus = url.get("jstatus");
  const jerr = url.get("jerr");
  const jpage = Math.max(1, Number(url.get("jpage")) || 1);

  const showJobs = (f: { jws?: string; jstatus?: string; jerr?: string }) => {
    url.set({ open: null, jq: null, jpage: null, jws: f.jws ?? null, jstatus: f.jstatus ?? null, jerr: f.jerr ?? null });
    requestAnimationFrame(() => document.getElementById("pix-jobs")?.scrollIntoView({ block: "start", behavior: "smooth" }));
  };

  const summary = () => {
    if (!rows) return "How documents are processed across workspaces.";
    const attention = rows.filter((r) => r.status !== "healthy").length;
    const queued = rows.reduce((a, r) => a + r.queue, 0);
    const failed = rows.reduce((a, r) => a + r.failed, 0);
    return `${attention ? `${plural(attention, "workspace")} need${attention === 1 ? "s" : ""} attention` : "Every workspace is healthy"} · ${plural(queued, "job")} queued · ${plural(failed, "failed job")} in the last 24 hours.`;
  };

  const settings = (components.data ?? []).filter((c) => c.setting).map((c) => ({ setting: c.setting as string, name: c.displayName ?? "" }));
  const pending = workspaces.isPending || summaries.isPending;
  const error = workspaces.error ?? summaries.error;

  const body = () => {
    if (error && !rows) return <ErrorState title="Indexing status didn’t load" error={error} onRetry={() => void Promise.all([workspaces.refetch(), summaries.refetch()])} />;
    if (pending || !rows) return <SkeletonRows rows={8} />;
    if (!rows.length) return <EmptyState icon={Database} title="No indexing jobs yet" description="Jobs appear once workspaces add documents." boxed />;

    const failedAll = new Map<ErrorClass, { count: number; workspaces: number }>();
    for (const r of rows) {
      for (const e of r.errors) {
        const cur = failedAll.get(e.errorClass) ?? { count: 0, workspaces: 0 };
        failedAll.set(e.errorClass, { count: cur.count + e.count, workspaces: cur.workspaces + 1 });
      }
    }
    const errorList = (Object.keys(ERROR_CLASSES) as ErrorClass[]).filter((k) => failedAll.has(k)).sort((a, b) => (failedAll.get(b)?.count ?? 0) - (failedAll.get(a)?.count ?? 0));

    const needle = jq.trim().toLowerCase();
    const jobs = taskList.filter(
      (t) =>
        (!jws || workspaceIdOf(t.name) === jws) &&
        (!jstatus || jobStatus(t, isPaused(t)) === jstatus) &&
        (!jerr || (t.state === "FAILED" && errorClassOf(t.errorClass) === jerr)) &&
        (!needle || lastSegment(t.name).toLowerCase().includes(needle)),
    );
    const wsOptions = wsList.filter((w) => taskList.some((t) => workspaceIdOf(t.name) === lastSegment(w.name))).map((w) => ({ value: lastSegment(w.name), label: w.displayName ?? "" }));

    return (
      <div className="pix">
        <div className="pix-banner">
          <Callout icon={Lock} description="You see job metadata only. Document names and content stay inside each workspace." />
        </div>

        <Section title="Workspaces">
          <DataTable
            label="Indexing by workspace"
            rows={sortIndexing(rows)}
            getRowId={(r) => r.workspaceId}
            onRowAction={(r) => url.set({ open: r.workspaceId })}
            columns={[
              { id: "name", header: "Workspace", primary: true, cell: (r) => <WsName workspace={byId.get(r.workspaceId)} /> },
              { id: "status", header: "Status", cell: (r) => <IndexChip status={r.status} /> },
              { id: "queue", header: "Queue", align: "end", mobileLabel: "Queue", cell: (r) => <span className="num">{fmtNum(r.queue)}</span> },
              { id: "pub", header: "Published, 24 h", align: "end", className: "hide-sm", hideOnMobile: true, cell: (r) => <span className="num">{fmtNum(r.published24)}</span> },
              {
                id: "fail",
                header: "Failure rate",
                align: "end",
                mobileLabel: "Failure rate",
                cell: (r) => <span className={`num ${r.failureRate >= DEGRADED_FAILURE_RATE ? "text-warning medium" : ""}`}>{fmtRate(r.failureRate)}</span>,
              },
              { id: "median", header: "Median time", align: "end", className: "hide-md", hideOnMobile: true, cell: (r) => <span className="num">{r.medianMs ? fmtDuration(r.medianMs) : "—"}</span> },
            ]}
            rowActionLead={(r) => {
              const w = byId.get(r.workspaceId);
              if (!w) return null;
              return r.paused ? (
                <Button size="sm" variant="tertiary" onPress={() => void actions.togglePause(w, r)}>
                  <Play className="i" aria-hidden />
                  Resume
                </Button>
              ) : (
                <Button size="sm" variant="ghost" onPress={() => void actions.togglePause(w, r)}>
                  <Pause className="i" aria-hidden />
                  Pause
                </Button>
              );
            }}
            rowActions={(r) => {
              const w = byId.get(r.workspaceId);
              if (!w) return [];
              return [
                { id: "errors", label: "View errors", icon: AlertCircle, onAction: () => url.set({ open: r.workspaceId }) },
                { id: "retry", label: r.retryable ? `Retry ${plural(r.retryable, "failed job")}` : "Retry failed jobs", icon: RotateCw, isDisabled: !r.retryable, onAction: () => void actions.retry(w, r) },
                { id: "jobs", label: "Show jobs", icon: ListIcon, onAction: () => showJobs({ jws: r.workspaceId }) },
                { id: "pause", label: r.paused ? "Resume indexing" : "Pause indexing", icon: r.paused ? Play : Pause, onAction: () => void actions.togglePause(w, r) },
              ];
            }}
          />
        </Section>

        <Section title="Errors" description="Failed jobs in the last 24 hours, by cause.">
          {errorList.length ? (
            <List className="pix-errs">
              {errorList.map((k) => {
                const e = ERROR_CLASSES[k];
                const agg = failedAll.get(k) ?? { count: 0, workspaces: 0 };
                return (
                  <ListItem
                    key={k}
                    lead={<ItemIcon icon={AlertCircle} tone={e.retry ? "warning" : "danger"} size="sm" />}
                    title={e.label}
                    titleExtra={<span className="num muted"> · {fmtNum(agg.count)}</span>}
                    description={
                      <>
                        {e.hint} <span className="muted">In {plural(agg.workspaces, "workspace")}.</span>
                      </>
                    }
                    actions={
                      <span className="row gap-8 none">
                        <Button variant="ghost" size="sm" onPress={() => showJobs({ jerr: k, jstatus: "failed" })}>
                          Show jobs
                        </Button>
                      </span>
                    }
                  />
                );
              })}
            </List>
          ) : (
            <EmptyState icon={CheckCircle2} tone="success" title="No failed jobs in the last 24 hours" compact boxed />
          )}
        </Section>

        <Section id="pix-jobs" title="Recent jobs" description="Stage and status only. Names and content stay in the workspace.">
          <div className="toolbar">
            <SearchInput value={jq} onChange={(v) => url.set({ jq: v, jpage: null })} placeholder="Search job ID" />
            <FilterButton label="Workspace" value={jws} onChange={(v) => url.set({ jws: v, jpage: null })} options={wsOptions} />
            <FilterButton
              label="Status"
              value={jstatus}
              onChange={(v) => url.set({ jstatus: v, jpage: null })}
              options={(Object.keys(JOB_STATUS) as JobStatus[]).map((k) => ({ value: k, label: JOB_STATUS[k].label }))}
            />
            <FilterButton
              label="Error"
              value={jerr}
              onChange={(v) => url.set({ jerr: v, jpage: null })}
              options={(Object.keys(ERROR_CLASSES) as ErrorClass[]).map((k) => ({ value: k, label: ERROR_CLASSES[k].label }))}
            />
            <ClearFilters isActive={Boolean(jws || jstatus || jerr)} onClear={() => url.set({ jws: null, jstatus: null, jerr: null, jpage: null })} />
          </div>
          {tasks.isError && !tasks.data ? (
            <ErrorState error={tasks.error} onRetry={tasks.refetch} />
          ) : tasks.isPending ? (
            <SkeletonRows rows={6} />
          ) : jobs.length ? (
            <DataTable
              label="Recent jobs"
              rows={paginate(jobs, jpage, JOBS_PAGE)}
              getRowId={(t) => t.name ?? ""}
              onRowAction={(t) => url.set({ open: workspaceIdOf(t.name) })}
              columns={[
                { id: "job", header: "Job", primary: true, cell: (t) => <span className="mono pix-job" title={lastSegment(t.name)}>{lastSegment(t.name).slice(0, 8)}</span> },
                { id: "ws", header: "Workspace", cell: (t) => <WsName workspace={byId.get(workspaceIdOf(t.name))} /> },
                { id: "stage", header: "Stage", className: "hide-md", hideOnMobile: true, cell: (t) => (t.phase ? PHASE_LABEL[t.phase] : "—") },
                { id: "status", header: "Status", cell: (t) => <JobChip task={t} paused={isPaused(t)} /> },
                {
                  id: "dur",
                  header: "Duration",
                  align: "end",
                  className: "hide-md pix-nowrap",
                  hideOnMobile: true,
                  cell: (t) => {
                    if (t.state === "RUNNING" && t.startTime) return <span className="muted num">{fmtDuration(Date.now() - Date.parse(t.startTime))}</span>;
                    const ms = taskDuration(t);
                    return ms === null || t.state === "QUEUED" ? <span className="muted">—</span> : <span className="num">{fmtDuration(ms)}</span>;
                  },
                },
                {
                  id: "when",
                  header: "When",
                  align: "end",
                  className: "pix-nowrap",
                  cell: (t) => (
                    <span className="muted num" title={fmtDateTime(t.createTime)}>
                      {rel(t.createTime)}
                    </span>
                  ),
                },
              ]}
              footer={<Pager page={jpage} pageSize={JOBS_PAGE} total={jobs.length} onPageChange={(p) => url.set({ jpage: p > 1 ? String(p) : null })} />}
            />
          ) : (
            <NoMatches what="jobs" onClear={() => url.set({ jq: null, jws: null, jstatus: null, jerr: null, jpage: null })} />
          )}
        </Section>

        {policy.data ? (
          <PolicySection key={policy.data.etag} policy={policy.data} settings={settings} isAdmin={isAdmin} />
        ) : policy.isError ? (
          <Section title="Policies" description="Apply to every workspace on this deployment.">
            <ErrorState error={policy.error} onRetry={policy.refetch} />
          </Section>
        ) : (
          <SkeletonRows rows={4} />
        )}
      </div>
    );
  };

  const open = url.get("open");
  return (
    <Page>
      <PageChrome crumbs={[{ label: "Indexing" }]} />
      <PageHeader title="Indexing" chips={<PreviewChip tooltip={PREVIEW_TIP} />} description={summary()} />
      {body()}
      {open && rows ? (
        <IndexingDrawer workspace={byId.get(open)} row={rowById.get(open)} tasks={taskList} onClose={() => url.set({ open: null })} onShowJobs={() => showJobs({ jws: open })} />
      ) : null}
    </Page>
  );
}
