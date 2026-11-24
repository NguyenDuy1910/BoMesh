import type { IngestionRun, IngestionTask } from "./api";
import type { ProcessingKey } from "./lifecycle";

/**
 * A document's processing steps (preview `PROC_STEPS` / `procSteps` in core/lifecycle.js): an ingestion run task's
 * `phases` (document_contract.md "Processing") grouped into the five steps people read. A step the task went past
 * without entering (no topics to choose among, contextual retrieval off) was skipped.
 */

type Phase = NonNullable<IngestionTask["phase"]>;

export interface ProcStep {
  id: "read" | "classify" | "context" | "embed" | "index";
  label: string;
  phases: readonly Phase[];
  /** What the step does. */
  desc: string;
  /** What it does when the file needed text recognition (OCR). */
  ocrDesc?: string;
  /** Why it was skipped. */
  skipped?: string;
}

export const PROC_STEPS: readonly ProcStep[] = [
  {
    id: "read",
    label: "Đọc tệp",
    phases: ["FETCHING", "PARSING", "OCR"],
    desc: "Mở tệp và tách thành các đoạn",
    ocrDesc: "Mở tệp, nhận dạng chữ (OCR) và tách thành các đoạn",
  },
  { id: "classify", label: "Phân loại", phases: ["CLASSIFYING"], desc: "Chọn chủ đề trong các chủ đề ứng viên", skipped: "Bỏ qua: không có chủ đề để chọn" },
  { id: "context", label: "Thêm ngữ cảnh", phases: ["CHUNKING"], desc: "Gắn ngữ cảnh của tài liệu cho từng đoạn", skipped: "Bỏ qua: đang tắt truy xuất theo ngữ cảnh" },
  { id: "embed", label: "Cho phép tra cứu", phases: ["EMBEDDING"], desc: "Chuyển các đoạn thành vector để tìm kiếm" },
  { id: "index", label: "Lập chỉ mục", phases: ["INDEXING"], desc: "Lưu lại để tìm kiếm và trợ lý tìm thấy" },
];

export type StepState = "todo" | "running" | "done" | "failed" | "skipped";

export interface StepStatus extends ProcStep {
  state: StepState;
  /** Time spent: so far while running, in total once done. */
  ms: number;
  /** The read step recognized the file's text. */
  ocr: boolean;
}

const ENDED: Partial<Record<NonNullable<IngestionTask["state"]>, true>> = { SUCCEEDED: true, FAILED: true, CANCELLED: true };
const time = (t: string | undefined) => (t ? Date.parse(t) : NaN);

/** The task's five steps, in order. */
export function procSteps(task: IngestionTask, now = Date.now()): StepStatus[] {
  const phases = task.phases ?? [];
  const stepOf = (p: Phase | undefined) => PROC_STEPS.findIndex((s) => !!p && s.phases.includes(p));
  const lastSeen = Math.max(-1, ...phases.map((p) => stepOf(p.phase)));
  const ended = !!task.state && !!ENDED[task.state];
  return PROC_STEPS.map((s, i) => {
    const mine = phases.filter((p) => !!p.phase && s.phases.includes(p.phase));
    const ms = mine.reduce((sum, p) => {
      const start = time(p.startTime);
      const end = Number.isFinite(time(p.endTime)) ? time(p.endTime) : now;
      return Number.isFinite(start) ? sum + Math.max(0, end - start) : sum;
    }, 0);
    let state: StepState;
    if (mine.some((p) => p.state === "FAILED")) state = "failed";
    else if (mine.some((p) => p.state === "RUNNING")) state = ended ? "todo" : "running";
    else if (mine.some((p) => p.state === "SUCCEEDED")) state = "done";
    else if (i < lastSeen || task.state === "SUCCEEDED") state = "skipped";
    else state = "todo";
    return { ...s, state, ms, ocr: s.id === "read" && phases.some((p) => p.phase === "OCR") };
  });
}

/** The step it's at (running) or stopped at (failed), with its 1-based position. */
export function procStepAt(steps: readonly StepStatus[]): (StepStatus & { n: number }) | null {
  const i = steps.findIndex((s) => s.state === "running" || s.state === "failed");
  return i < 0 ? null : { ...steps[i], n: i + 1 };
}

/** Time from start (or creation) to end, or to now while it runs; null when unknown. */
export function taskElapsed(task: IngestionTask, now = Date.now()): number | null {
  const start = time(task.startTime ?? task.createTime);
  const end = Number.isFinite(time(task.endTime)) ? time(task.endTime) : now;
  return Number.isFinite(start) ? Math.max(0, end - start) : null;
}

/* ═══════════════ Documents → Processing: the state a row shows ═══════════════ */

/** What a Processing row reads (and its state pills filter on): Waiting is a queued run task, the rest are processing states. */
export type ShownProcessing = ProcessingKey | "waiting";

const TASK_SHOWN: Partial<Record<NonNullable<IngestionTask["state"]>, ShownProcessing>> = { QUEUED: "waiting", RUNNING: "processing", FAILED: "failed", SUCCEEDED: "ready" };

/**
 * The state a Processing row shows (preview `procShown`): its task in the runs in flight — Waiting, Processing, Failed,
 * or Processed until the run ends — else its processing state (`ProcessingState` renders the same choice).
 */
export const shownProcessing = (processing: ProcessingKey, live: IngestionTask | undefined): ShownProcessing => (live?.state && TASK_SHOWN[live.state]) || processing;

/* ═══════════════ Documents → Processing: one page over two lists ═══════════════ */

/** One page of a list: its rows and the next page's token ("" = the last page). */
export interface ListPage<T> {
  rows: T[];
  next: string;
}

/** Where a Processing page starts: in the submissions or in the documents, at a page token ("" = their first page). */
export interface ProcCursor {
  list: "submissions" | "documents";
  token: string;
}

/** Reads one page of a list (`size` rows at most); null when the filters leave nothing to read. */
export type PageReader<T> = ((token: string, size: number) => Promise<ListPage<T>>) | null;

export const FIRST_PAGE: ProcCursor = { list: "submissions", token: "" };

/**
 * One Processing page of `per` rows (preview: submissions first, then documents): a submissions page, or the page
 * that ends them filled up with the first documents (page tokens are offsets, so a smaller first documents page goes
 * on with full ones), or a documents page. Returns the rows and where the next page starts (null: the last page).
 */
export async function walkPage<S, D>(
  cursor: ProcCursor,
  per: number,
  read: { submissions: PageReader<S>; documents: PageReader<D> },
): Promise<{ submissions: S[]; documents: D[]; next: ProcCursor | null }> {
  let submissions: S[] = [];
  if (cursor.list === "submissions" && read.submissions) {
    const page = await read.submissions(cursor.token, per);
    if (page.next) return { submissions: page.rows, documents: [], next: { list: "submissions", token: page.next } };
    submissions = page.rows;
  }
  if (!read.documents) return { submissions, documents: [], next: null };
  const room = per - submissions.length;
  if (room <= 0) return { submissions, documents: [], next: { list: "documents", token: "" } };
  const page = await read.documents(cursor.list === "documents" ? cursor.token : "", room);
  return { submissions, documents: page.rows, next: page.next ? { list: "documents", token: page.next } : null };
}

/* ═══════════════ A run's tasks ═══════════════ */

/** Task ID = item ID. */
export const taskKey = (t: IngestionTask) => (t.item ?? t.name ?? "").split("/").pop() ?? "";

/** Where a page of a run pill reads: the run (index into the runs in flight) and its page token ("" = its first page). */
export interface RunTaskCursor {
  run: number;
  token: string;
}

export const FIRST_RUN_PAGE: RunTaskCursor = { run: 0, token: "" };

/** The page after one read at `at`: the same run's next page, else the next run's first, else none (the last page). */
export function nextRunTaskCursor(at: RunTaskCursor, nextPageToken: string | undefined, runCount: number): RunTaskCursor | null {
  if (nextPageToken) return { run: at.run, token: nextPageToken };
  return at.run + 1 < runCount ? { run: at.run + 1, token: "" } : null;
}
