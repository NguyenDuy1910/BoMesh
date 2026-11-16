"use client";

import { Button, Checkbox, Description, FieldError, Input, Label, ListBox, Select, TextField } from "@heroui/react";
import type { UseQueryResult } from "@tanstack/react-query";
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
  paginate,
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
  usePlatformUsers,
  usePlatformWorkspaces,
  useRecentTasks,
} from "../queries";
import { PlatformDrawer, PREVIEW_TIP, useUrlState, type UrlState } from "./shared";

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
      tooltip={st === "held" ? "Indexing is paused for this workspace" : undefined}
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
      toast(pause ? `Paused indexing for ${w.displayName}. New files wait in the queue.` : `Resumed indexing for ${w.displayName}. Queued jobs start now.`, {
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
      toast(skipped ? `None of these can be retried. ${plural(skipped, "job")} need${skipped === 1 ? "s" : ""} the workspace to replace the file.` : "No failed jobs to retry", { tone: "accent" });
      return;
    }
    try {
      const run = await retryFailed(lastSegment(w.name));
      await refresh();
      const held = w.ingestionState === "PAUSED" ? " · they run when indexing resumes" : "";
      toast(`Retrying ${plural(run.counts?.totalCount ?? n, "job")}${held}${skipped > 0 ? ` · ${skipped} can’t be retried` : ""}`, { undo: undoWith(() => cancelIngestionRun(run.name ?? "")) });
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
        label="Indexing by workspace"
        rows={sortIndexing(rows)}
        getRowId={(r) => r.workspaceId}
        onRowAction={(r) => url.set({ open: r.workspaceId })}
        columns={[
          { id: "name", header: "Workspace", primary: true, cell: (r) => <WsName workspace={byId.get(r.workspaceId)} /> },
          { id: "status", header: "Status", cell: (r) => <IndexChip status={r.status} /> },
          { id: "queue", header: "Queue", align: "end", mobileLabel: "Queue", cell: (r) => <span className="num">{fmtNum(r.queue)}</span> },
          {
            id: "fail",
            header: "Failure rate",
            align: "end",
            mobileLabel: "Failure rate",
            cell: (r) => <span className={`num ${r.failureRate >= DEGRADED_FAILURE_RATE ? "text-warning medium" : ""}`}>{fmtRate(r.failureRate)}</span>,
          },
        ]}
        // Paused is the exceptional state, so Resume stays one click away; Pause lives in the row menu.
        rowActionLead={(r) => {
          const w = byId.get(r.workspaceId);
          return w && r.paused && isAdmin ? (
            <Button size="sm" variant="tertiary" onPress={() => void actions.togglePause(w)}>
              <Play className="i" aria-hidden />
              Resume
            </Button>
          ) : null;
        }}
        rowActions={(r) => {
          const w = byId.get(r.workspaceId);
          if (!w) return [];
          return [
            ...(isAdmin
              ? [{ id: "retry", label: r.retryable ? `Retry ${plural(r.retryable, "failed job")}` : "Retry failed jobs", icon: RotateCw, isDisabled: !r.retryable, onAction: () => void actions.retry(w, r) }]
              : []),
            { id: "jobs", label: "Show jobs", icon: ListIcon, onAction: () => showJobs(url, { ws: r.workspaceId }) },
            ...(isAdmin ? [{ id: "pause", label: r.paused ? "Resume indexing" : "Pause indexing", icon: r.paused ? Play : Pause, onAction: () => void actions.togglePause(w) }] : []),
          ];
        }}
      />
      <Section title="Errors" description="Failed jobs in the last 24 hours, by cause.">
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
                      {e.hint} <span className="muted">In {plural(agg.workspaces, "workspace")}.</span>
                    </>
                  }
                  actions={
                    <Button variant="ghost" size="sm" onPress={() => showJobs(url, { err: k, status: "failed" })}>
                      Show jobs
                    </Button>
                  }
                />
              );
            })}
          </List>
        ) : (
          <EmptyState icon={CheckCircle2} tone="success" title="No failed jobs in the last 24 hours" compact boxed />
        )}
      </Section>
    </>
  );
}

/* ── Jobs ── */

function JobsSection({ tasks, byId, url }: { tasks: UseQueryResult<IngestionTask[]>; byId: Map<string, Workspace>; url: UrlState }) {
  const list = tasks.data ?? [];
  const isPaused = (t: IngestionTask) => byId.get(workspaceIdOf(t.name))?.ingestionState === "PAUSED";
  const q = url.get("q");
  const ws = url.get("ws");
  const status = url.get("status");
  const err = url.get("err");
  const page = Math.max(1, Number(url.get("page")) || 1);
  const needle = q.trim().toLowerCase();
  const rows = list.filter(
    (t) =>
      (!ws || workspaceIdOf(t.name) === ws) &&
      (!status || jobStatus(t, isPaused(t)) === status) &&
      (!err || (t.state === "FAILED" && errorClassOf(t.errorClass) === err)) &&
      (!needle || lastSegment(t.name).toLowerCase().includes(needle)),
  );
  const wsOptions = [...byId.entries()].filter(([id]) => list.some((t) => workspaceIdOf(t.name) === id)).map(([id, w]) => ({ value: id, label: w.displayName ?? "" }));

  return (
    <>
      <div className="toolbar">
        <SearchInput value={q} onChange={(v) => url.set({ q: v, page: null })} placeholder="Search job ID" />
        <FilterButton label="Workspace" value={ws} onChange={(v) => url.set({ ws: v, page: null })} options={wsOptions} />
        <FilterButton
          label="Status"
          value={status}
          onChange={(v) => url.set({ status: v, page: null })}
          options={(Object.keys(JOB_STATUS) as JobStatus[]).map((k) => ({ value: k, label: JOB_STATUS[k].label }))}
        />
        <FilterButton
          label="Error"
          value={err}
          onChange={(v) => url.set({ err: v, page: null })}
          options={(Object.keys(ERROR_CLASSES) as ErrorClass[]).map((k) => ({ value: k, label: ERROR_CLASSES[k].label }))}
        />
        <ClearFilters isActive={Boolean(ws || status || err)} onClear={() => url.set({ ws: null, status: null, err: null, page: null })} />
      </div>
      <p className="t-sm muted pix-note">Job metadata only. Names and content stay in the workspace.</p>
      {tasks.isError && !tasks.data ? (
        <ErrorState error={tasks.error} onRetry={tasks.refetch} />
      ) : tasks.isPending ? (
        <SkeletonRows rows={6} />
      ) : rows.length ? (
        <DataTable
          label="Recent jobs"
          rows={paginate(rows, page, JOBS_PAGE)}
          getRowId={(t) => t.name ?? ""}
          onRowAction={(t) => url.set({ job: t.name ?? null })}
          columns={[
            {
              id: "job",
              header: "Job",
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
            { id: "ws", header: "Workspace", cell: (t) => <WsName workspace={byId.get(workspaceIdOf(t.name))} /> },
            { id: "status", header: "Status", cell: (t) => <JobChip task={t} paused={isPaused(t)} /> },
            {
              id: "when",
              header: "When",
              align: "end",
              className: "pix-nowrap",
              cell: (t) => (
                <Tip content={fmtDateTime(t.createTime)}>
                  <span className="muted num">{rel(t.createTime)}</span>
                </Tip>
              ),
            },
          ]}
          footer={<Pager page={page} pageSize={JOBS_PAGE} total={rows.length} onPageChange={(p) => url.set({ page: p > 1 ? String(p) : null })} />}
        />
      ) : (
        <NoMatches what="jobs" onClear={() => url.set({ q: null, ws: null, status: null, err: null, page: null })} />
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
  const users = usePlatformUsers();
  const changer = lastChange.data ? users.data?.find((u) => u.name === lastChange.data?.actor) : undefined;

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
    <section className="pix-policy" id="pix-policies" aria-label="Indexing policies">
      <p className="t-sm muted pix-policy__note">
        <span>Apply to every workspace on this deployment.</span>
        {lastChange.data ? (
          <span>{changer ? `Last changed by ${userName(changer)} · ${fmtDate(lastChange.data.createTime)}` : `Last changed ${fmtDate(lastChange.data.createTime)}`}</span>
        ) : null}
      </p>
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
          {errors.maxMb ? null : <Description>Larger files fail with “Too large”.</Description>}
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
    </section>
  );
}

/* ── Drawers ── */

/** Preview `DR['pix-ws']`: one workspace's indexing health, errors and recent jobs; pause/resume and retry. */
function WorkspaceIndexDrawer({ workspace, row, tasks, url }: { workspace: Workspace | undefined; row: WorkspaceIndexing | undefined; tasks: readonly IngestionTask[]; url: UrlState }) {
  const actions = useIndexingActions();
  const isAdmin = useIsPlatformAdmin();
  const close = () => url.set({ open: null });
  if (!workspace || !row) {
    return (
      <PlatformDrawer isOpen onClose={close} title="Workspace not found" footer={<Button onPress={close}>Close</Button>}>
        <EmptyState icon={Database} title="This workspace no longer exists" compact />
      </PlatformDrawer>
    );
  }
  const recent = tasks.filter((t) => workspaceIdOf(t.name) === row.workspaceId).slice(0, 6);
  return (
    <PlatformDrawer
      isOpen
      onClose={close}
      lead={<WorkspaceMark name={workspace.displayName ?? ""} size={36} />}
      title={<span translate="no">{workspace.displayName}</span>}
      description="Job metadata only"
      footer={
        isAdmin ? (
          <>
            <Button variant="tertiary" onPress={() => void actions.togglePause(workspace)}>
              {row.paused ? <Play className="i" aria-hidden /> : <Pause className="i" aria-hidden />}
              {row.paused ? "Resume indexing" : "Pause indexing"}
            </Button>
            {/* Retry shows only when something failed; disabled (with the reason) when none of the failures can be retried. */}
            {row.failed ? (
              <Tip content={row.retryable ? "" : "These need the workspace to replace the file"}>
                <span>
                  <Button variant="primary" isDisabled={!row.retryable} onPress={() => void actions.retry(workspace, row)}>
                    <RotateCw className="i" aria-hidden />
                    {row.retryable ? `Retry ${plural(row.retryable, "failed job")}` : "Retry failed jobs"}
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
          <Button variant="ghost" size="sm" onPress={() => showJobs(url, { ws: row.workspaceId })}>
            Show all
          </Button>
        </div>
        {recent.length ? (
          <List>
            {recent.map((t) => (
              <ListItem
                key={t.name}
                lead={<ItemIcon icon={FileText} size="sm" />}
                title={<span className="mono">{jobId(t)}</span>}
                label={`Job ${lastSegment(t.name)}`}
                description={`${t.phase ? PHASE_LABEL[t.phase] : "—"} · ${rel(t.createTime)}`}
                actions={<JobChip task={t} paused={row.paused} />}
                onPress={() => url.set({ job: t.name ?? null })}
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

/** Preview `DR['pix-job']`: one job, metadata only; the workspace is one link away. */
function JobDrawer({ task, workspace, url }: { task: IngestionTask | undefined; workspace: Workspace | undefined; url: UrlState }) {
  const close = () => url.set({ job: null });
  if (!task) {
    return (
      <PlatformDrawer isOpen onClose={close} title="Job not found">
        <EmptyState icon={Database} title="This job is no longer in the log" compact />
      </PlatformDrawer>
    );
  }
  const paused = workspace?.ingestionState === "PAUSED";
  const st = jobStatus(task, paused);
  const e = ERROR_CLASSES[errorClassOf(task.errorClass)];
  const ms = jobDuration(task);
  return (
    <PlatformDrawer isOpen onClose={close} lead={<ItemIcon icon={FileText} />} title={<span className="mono">{jobId(task)}</span>} description="Job metadata only">
      {st === "failed" ? (
        <section className="drawer__section">
          <Callout tone={e.retry ? "warning" : "danger"} icon={AlertCircle} title={e.label} description={e.hint} />
        </section>
      ) : st === "held" ? (
        <section className="drawer__section">
          <Callout icon={Pause} title="On hold" description="Indexing is paused for this workspace. The job runs when it resumes." />
        </section>
      ) : null}
      <section className="drawer__section">
        <KeyValue
          pairs={[
            ["Status", <JobChip key="s" task={task} paused={paused} />],
            [
              "Workspace",
              workspace ? (
                <button key="w" type="button" className="link-button pf-link" onClick={() => url.set({ job: null, open: lastSegment(workspace.name) })}>
                  {workspace.displayName}
                </button>
              ) : (
                <span key="w" className="muted">
                  Removed workspace
                </span>
              ),
            ],
            ["Stage", task.phase ? PHASE_LABEL[task.phase] : "—"],
            ["Duration", ms === null ? "—" : fmtDuration(ms)],
            ["Started", fmtDateTime(task.startTime ?? task.createTime)],
            ["Job ID", <span key="id" className="mono t-sm">{lastSegment(task.name)}</span>],
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
  const isAdmin = useIsPlatformAdmin();
  const workspaces = usePlatformWorkspaces();
  const summaries = useIngestionSummaries();
  const tasks = useRecentTasks();
  const policy = useIngestionPolicy();

  const byId = new Map((workspaces.data ?? []).map((w) => [lastSegment(w.name), w]));
  const rows = workspaces.data && summaries.data ? buildIndexing(workspaces.data, summaries.data.now, summaries.data.day, tasks.data ?? []) : null;
  const taskList = tasks.data ?? [];

  /** One sentence: what needs attention right now. */
  const summary = () => {
    if (!rows) return undefined;
    const attention = rows.filter((r) => r.status !== "healthy").length;
    const queued = rows.reduce((a, r) => a + r.queue, 0);
    const failed = rows.reduce((a, r) => a + r.failed, 0);
    return `${attention ? `${plural(attention, "workspace")} need${attention === 1 ? "s" : ""} attention` : "Every workspace is healthy"} · ${plural(queued, "job")} queued · ${plural(failed, "failed job")} in the last 24 hours.`;
  };

  const body = () => {
    if (tab === "policies") {
      if (policy.data) return <PolicySection key={policy.data.etag} policy={policy.data} isAdmin={isAdmin} />;
      if (policy.isError) return <ErrorState error={policy.error} onRetry={policy.refetch} />;
      return <SkeletonRows rows={6} />;
    }
    const error = workspaces.error ?? summaries.error;
    if (error && !rows) return <ErrorState title="Indexing status didn’t load" error={error} onRetry={() => void Promise.all([workspaces.refetch(), summaries.refetch()])} />;
    if (!rows) return <SkeletonRows rows={8} />;
    if (!rows.length) return <EmptyState icon={Database} title="No indexing jobs yet" description="Jobs appear once workspaces add documents." boxed />;
    return tab === "jobs" ? <JobsSection tasks={tasks} byId={byId} url={url} /> : <WorkspacesSection rows={rows} byId={byId} url={url} />;
  };

  const open = url.get("open");
  const job = url.get("job");
  return (
    <Page width="wide">
      <PageHeader title={sectionTitle(indexingSections, tab)} chips={<PreviewChip tooltip={PREVIEW_TIP} />} meta={tab === "workspaces" ? summary() : undefined} />
      <div className="pix">{body()}</div>
      {open && rows ? <WorkspaceIndexDrawer workspace={byId.get(open)} row={rows.find((r) => r.workspaceId === open)} tasks={taskList} url={url} /> : null}
      {job && tasks.data ? <JobDrawer task={taskList.find((t) => t.name === job)} workspace={byId.get(workspaceIdOf(job))} url={url} /> : null}
    </Page>
  );
}
