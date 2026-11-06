/**
 * One assistant turn, folded from the `:converse` OpenResponses stream
 * (conversation_loop.md "One reply, one response").
 *
 * The server sends a single response per turn: `response.created` names the
 * assistant message in `metadata.message`; every agent step adds output items
 * (`output_index` keeps counting across steps); one terminal event settles it
 * (`response.completed` · `response.incomplete` · `response.failed`).
 * The answer is the assistant text written after the last tool call — text a
 * step wrote before calling a tool is the model thinking aloud, exactly as the
 * server stores it. Citations arrive as `bomesh:document_citation`
 * annotations bracketing the reader-facing `[n]` already in the text; files
 * the turn saved as `bomesh:artifact` annotations or `artifact` tool progress.
 * Tool activity becomes the work steps.
 *
 * Pure and dependency-free so it runs under `node --test`.
 */

/* ═══════════════ Wire events (the subset the client reads) ═══════════════ */

export interface WireAnnotation {
  type?: string;
  start_index?: number;
  end_index?: number;
  citation?: {
    number?: number;
    passage?: string;
    item?: string;
    title?: string;
    excerpt?: string;
    page_start?: number;
    page?: number;
  };
  artifact?: { id?: string; title?: string; file_name?: string };
}

export interface WirePart {
  type?: string;
  text?: string;
  annotations?: WireAnnotation[];
}

export interface WireItem {
  type?: string;
  id?: string;
  role?: string;
  phase?: string | null;
  content?: WirePart[];
  call_id?: string;
  name?: string;
  arguments?: string;
  output?: string;
}

export interface WireResponse {
  id?: string;
  status?: string;
  metadata?: Record<string, unknown> | null;
  error?: { code?: string; message?: string } | null;
  incomplete_details?: { reason?: string } | null;
}

export interface WireStatus {
  code?: number;
  message?: string;
  details?: { reason?: string }[];
}

export type StreamEvent =
  | { type: "response.created" | "response.queued" | "response.in_progress"; response: WireResponse }
  | { type: "response.completed" | "response.incomplete"; response: WireResponse }
  | { type: "response.failed"; response: WireResponse; error?: WireStatus }
  | { type: "response.output_item.added" | "response.output_item.done"; output_index: number; item: WireItem }
  | { type: "response.content_part.added" | "response.content_part.done"; output_index: number; content_index: number; part: WirePart }
  | { type: "response.output_text.delta"; output_index: number; content_index: number; delta: string }
  | { type: "response.output_text.done"; output_index: number; content_index: number; text: string }
  | { type: "response.output_text.annotation.added"; output_index: number; content_index: number; annotation_index: number; annotation: WireAnnotation }
  | { type: "response.function_call_arguments.delta"; output_index: number; delta: string }
  | { type: "response.function_call_arguments.done"; output_index: number; arguments: string }
  | { type: "tool_started"; call_id: string; tool_name: string }
  | { type: "tool_progress"; call_id: string; tool_name: string; data?: Record<string, unknown> }
  | { type: "tool_completed"; call_id: string; tool_name: string; status: "completed" | "failed" | "timeout" | "skipped"; result_count?: number | null; duration_ms?: number }
  | { type: "error"; error: { message?: string; code?: string } };

/* ═══════════════ Client model ═══════════════ */

export interface SourcePassage {
  /** `workspaces/{w}/items/{item}/passages/{passage}` */
  passage: string;
  page?: number;
  excerpt?: string;
}

/** One cited document: its reader-facing number and the passages cited from it. */
export interface AnswerSource {
  n: number;
  /** `workspaces/{w}/items/{item}`; empty when unavailable. */
  item: string;
  title: string;
  passages: SourcePassage[];
  /** False when the reader can no longer open the document. */
  available: boolean;
  /** Older answers numbered passages, not documents: their extra numbers for this document. */
  aliases?: number[];
}

export interface ShellRun {
  cmd: string;
  out: string;
  exit: number;
  timedOut?: boolean;
}

export type StepKind = "search" | "read" | "prepare" | "code" | "export" | "tool";

export interface WorkStep {
  id: string;
  tool: string;
  kind: StepKind;
  label: string;
  detail?: string;
  live: boolean;
  bad?: boolean;
  runs?: ShellRun[];
}

export type TurnStatus = "streaming" | "completed" | "interrupted" | "failed";

export interface Turn {
  /** Assistant message name, once `response.created` named it. */
  message?: string;
  status: TurnStatus;
  error?: string;
  /** ErrorInfo reason of a failure (e.g. `MODEL_STREAM_ERROR`). */
  reason?: string;
  /** The answer, with `[n]` markers. */
  text: string;
  sources: AnswerSource[];
  /** Artifact names (`workspaces/{w}/artifacts/{a}`) the turn saved. */
  artifacts: string[];
  steps: WorkStep[];
  startedAt: number;
  finishedAt?: number;
  /** @internal folded output items by `output_index`. */
  items: Record<number, FoldedItem>;
  /** @internal runtime tool facts by call id. */
  tools: Record<string, ToolFact>;
}

interface FoldedPart {
  text: string;
  annotations: WireAnnotation[];
}

interface FoldedItem {
  type: string;
  role?: string;
  phase?: string | null;
  callId?: string;
  name?: string;
  arguments?: string;
  output?: string;
  parts: FoldedPart[];
}

interface ToolFact {
  tool: string;
  state: "active" | "completed" | "failed" | "timeout" | "skipped";
  resultCount?: number;
}

export function emptyTurn(startedAt = Date.now()): Turn {
  return { status: "streaming", text: "", sources: [], artifacts: [], steps: [], startedAt, items: {}, tools: {} };
}

const TERMINAL = new Set(["response.completed", "response.incomplete", "response.failed", "error"]);

export function isTerminalEvent(event: StreamEvent): boolean {
  return TERMINAL.has(event.type);
}

/** Fold one event into the turn. Unknown events leave it unchanged. */
export function reduceTurn(turn: Turn, event: StreamEvent, now = Date.now()): Turn {
  switch (event.type) {
    case "response.created":
    case "response.queued":
    case "response.in_progress": {
      const e = event;
      const message = typeof e.response?.metadata?.message === "string" ? e.response.metadata.message : turn.message;
      return { ...turn, message };
    }
    case "response.output_item.added":
    case "response.output_item.done": {
      const e = event;
      return derive({ ...turn, items: { ...turn.items, [e.output_index]: foldItem(turn.items[e.output_index], e.item, e.type.endsWith("done")) } });
    }
    case "response.content_part.added":
    case "response.content_part.done": {
      const e = event;
      return derive(withPart(turn, e.output_index, e.content_index, (p) => ({
        text: typeof e.part?.text === "string" && (e.type.endsWith("done") || !p.text) ? e.part.text : p.text,
        annotations: mergeAnnotations(p.annotations, e.part?.annotations ?? []),
      })));
    }
    case "response.output_text.delta": {
      const e = event;
      return derive(withPart(turn, e.output_index, e.content_index, (p) => ({ ...p, text: p.text + (e.delta ?? "") })));
    }
    case "response.output_text.done": {
      const e = event;
      return derive(withPart(turn, e.output_index, e.content_index, (p) => ({ ...p, text: e.text ?? p.text })));
    }
    case "response.output_text.annotation.added": {
      const e = event;
      return derive(withPart(turn, e.output_index, e.content_index, (p) => ({ ...p, annotations: mergeAnnotations(p.annotations, [e.annotation]) })));
    }
    case "response.function_call_arguments.delta":
    case "response.function_call_arguments.done": {
      const e = event as { output_index: number; delta?: string; arguments?: string };
      const item = turn.items[e.output_index] ?? { type: "function_call", parts: [] };
      const args = e.arguments ?? (item.arguments ?? "") + (e.delta ?? "");
      return derive({ ...turn, items: { ...turn.items, [e.output_index]: { ...item, arguments: args } } });
    }
    case "tool_started":
    case "tool_progress": {
      const e = event as { call_id: string; tool_name: string; data?: Record<string, unknown> };
      const fact = turn.tools[e.call_id];
      let artifacts = turn.artifacts;
      const ref = e.data?.artifact as WireAnnotation["artifact"] | undefined;
      if (ref?.id) artifacts = addArtifact(artifacts, artifactName(turn.message, ref.id));
      return derive({ ...turn, artifacts, tools: { ...turn.tools, [e.call_id]: { tool: e.tool_name, state: fact?.state ?? "active", resultCount: fact?.resultCount } } });
    }
    case "tool_completed": {
      const e = event;
      const resultCount = typeof e.result_count === "number" ? e.result_count : undefined;
      return derive({ ...turn, tools: { ...turn.tools, [e.call_id]: { tool: e.tool_name, state: e.status, resultCount } } });
    }
    case "response.completed":
      return settle(derive(turn), "completed", now);
    case "response.incomplete":
      return settle(derive(turn), "interrupted", now);
    case "response.failed": {
      const e = event;
      const reason = e.error?.details?.find((d) => d.reason)?.reason ?? e.response?.error?.code;
      return settle(derive(turn), "failed", now, e.error?.message || e.response?.error?.message || "The answer stopped before it finished.", reason);
    }
    case "error": {
      const e = event;
      return settle(derive(turn), "failed", now, e.error?.message || "The answer stopped before it finished.", e.error?.code);
    }
    default:
      return turn;
  }
}

/** The client gave up on the stream (Stop, or the connection dropped). */
export function endTurn(turn: Turn, status: Exclude<TurnStatus, "streaming" | "completed">, error?: string, now = Date.now()): Turn {
  if (turn.status !== "streaming") return turn;
  return settle(turn, status, now, error);
}

function settle(turn: Turn, status: TurnStatus, now: number, error?: string, reason?: string): Turn {
  const steps = turn.steps.map((s) => (s.live ? { ...s, live: false } : s));
  return { ...turn, status, error, reason, steps, finishedAt: now };
}

function foldItem(previous: FoldedItem | undefined, item: WireItem, done: boolean): FoldedItem {
  const parts = Array.isArray(item.content)
    ? item.content.map((part, i) => {
        const before = previous?.parts[i];
        const text = typeof part.text === "string" && (done || !before?.text) ? part.text : before?.text ?? "";
        return { text, annotations: mergeAnnotations(before?.annotations ?? [], part.annotations ?? []) };
      })
    : previous?.parts ?? [];
  return {
    type: item.type ?? previous?.type ?? "message",
    role: item.role ?? previous?.role,
    phase: item.phase !== undefined ? item.phase : previous?.phase,
    callId: item.call_id ?? previous?.callId,
    name: item.name ?? previous?.name,
    arguments: item.arguments ?? previous?.arguments,
    output: item.output ?? previous?.output,
    parts,
  };
}

function withPart(turn: Turn, outputIndex: number, contentIndex: number, update: (part: FoldedPart) => FoldedPart): Turn {
  const item = turn.items[outputIndex] ?? { type: "message", role: "assistant", parts: [] };
  const parts = [...item.parts];
  while (parts.length <= contentIndex) parts.push({ text: "", annotations: [] });
  parts[contentIndex] = update(parts[contentIndex]!);
  return { ...turn, items: { ...turn.items, [outputIndex]: { ...item, parts } } };
}

function mergeAnnotations(current: WireAnnotation[], next: WireAnnotation[]): WireAnnotation[] {
  if (!next.length) return current;
  const seen = new Set(current.map((a) => JSON.stringify(a)));
  const out = [...current];
  for (const a of next) {
    const key = JSON.stringify(a);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(a);
    }
  }
  return out;
}

/** Recompute the answer text, sources, artifacts and steps from the folded items. */
function derive(turn: Turn): Turn {
  const indexes = Object.keys(turn.items).map(Number).sort((a, b) => a - b);
  let lastCall = -1;
  for (const i of indexes) if (turn.items[i]!.type === "function_call") lastCall = i;
  const answerItems = indexes
    .filter((i) => i > lastCall)
    .map((i) => turn.items[i]!)
    .filter((it) => it.type === "message" && (it.role ?? "assistant") === "assistant" && it.phase !== "commentary");
  const text = answerItems.flatMap((it) => it.parts.map((p) => p.text)).join("");
  const annotations = answerItems.flatMap((it) => it.parts.flatMap((p) => p.annotations));
  const sources = sourcesFromAnnotations(annotations);
  let artifacts = turn.artifacts;
  for (const it of indexes.map((i) => turn.items[i]!)) {
    for (const p of it.parts) for (const a of p.annotations) if (a.type === "bomesh:artifact" && a.artifact?.id) artifacts = addArtifact(artifacts, artifactName(turn.message, a.artifact.id));
  }
  return { ...turn, text, sources, artifacts, steps: stepsOf(turn, indexes) };
}

function addArtifact(list: string[], name: string): string[] {
  return list.includes(name) ? list : [...list, name];
}

/** `workspaces/{w}/artifacts/{id}`, the workspace taken from the assistant message name. */
export function artifactName(message: string | undefined, id: string): string {
  if (id.includes("/")) return id;
  const ws = message?.match(/^(workspaces\/[^/]+)\//)?.[1];
  return ws ? `${ws}/artifacts/${id}` : id;
}

/** Group streamed citation annotations by their reader-facing number (one per document). */
export function sourcesFromAnnotations(annotations: readonly WireAnnotation[]): AnswerSource[] {
  const byNumber = new Map<number, AnswerSource>();
  for (const a of annotations) {
    const c = a.citation;
    if (a.type !== "bomesh:document_citation" || !c || typeof c.number !== "number") continue;
    let source = byNumber.get(c.number);
    if (!source) {
      source = { n: c.number, item: c.item ?? itemOfPassage(c.passage ?? ""), title: c.title ?? "", passages: [], available: true };
      byNumber.set(c.number, source);
    }
    if (c.passage && !source.passages.some((p) => p.passage === c.passage)) {
      const page = typeof c.page_start === "number" ? c.page_start : typeof c.page === "number" ? c.page : undefined;
      source.passages.push({ passage: c.passage, page, excerpt: c.excerpt });
    }
  }
  return [...byNumber.values()].sort((a, b) => a.n - b.n);
}

/** `workspaces/w/items/i/passages/p` → `workspaces/w/items/i`. */
export function itemOfPassage(passage: string): string {
  const i = passage.indexOf("/passages/");
  return i < 0 ? "" : passage.slice(0, i);
}

/* ═══════════════ Work steps ═══════════════ */

const TOOL_KIND: Record<string, StepKind> = {
  knowledge_search: "search",
  read_resource: "read",
  inspect_resource: "read",
  materialize_resource: "prepare",
  materialize_sandbox_resource: "prepare",
  run_shell: "code",
  export_sandbox_file: "export",
};

const LABELS: Record<StepKind, [live: string, done: string]> = {
  search: ["Searching your knowledge", "Searched your knowledge"],
  read: ["Reading a document", "Read a document"],
  prepare: ["Preparing a file", "Prepared a file"],
  code: ["Running code", "Ran code"],
  export: ["Saving a file", "Saved a file"],
  tool: ["Working", "Used a tool"],
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function stepsOf(turn: Turn, indexes: number[]): WorkStep[] {
  const outputs = new Map<string, string>();
  for (const i of indexes) {
    const it = turn.items[i]!;
    if (it.type === "function_call_output" && it.callId) outputs.set(it.callId, it.output ?? "");
  }
  const steps: WorkStep[] = [];
  const seen = new Set<string>();
  for (const i of indexes) {
    const it = turn.items[i]!;
    if (it.type !== "function_call") continue;
    const id = it.callId ?? `call-${i}`;
    seen.add(id);
    steps.push(step(id, it.name ?? turn.tools[id]?.tool ?? "tool", turn.tools[id], outputs.get(id), it.arguments, turn.status === "streaming"));
  }
  // Runtime facts for calls whose item hasn't arrived yet.
  for (const [id, fact] of Object.entries(turn.tools)) {
    if (!seen.has(id)) steps.push(step(id, fact.tool, fact, outputs.get(id), undefined, turn.status === "streaming"));
  }
  return steps;
}

function step(id: string, tool: string, fact: ToolFact | undefined, output: string | undefined, args: string | undefined, streaming: boolean): WorkStep {
  const kind = TOOL_KIND[tool] ?? "tool";
  const live = streaming && output === undefined && (!fact || fact.state === "active");
  const bad = fact?.state === "failed" || fact?.state === "timeout";
  const [liveLabel, doneLabel] = LABELS[kind];
  let detail: string | undefined;
  if (fact?.state === "timeout") detail = "Timed out";
  else if (fact?.state === "failed") detail = "Failed";
  else if (kind === "search" && typeof fact?.resultCount === "number") detail = fact.resultCount ? plural(fact.resultCount, "relevant passage") : "No relevant passages";
  const s: WorkStep = { id, tool, kind, label: live ? liveLabel : doneLabel, live, ...(detail ? { detail } : {}), ...(bad ? { bad } : {}) };
  if (kind === "code") {
    s.runs = shellRuns(args, output);
    if (s.runs.some((r) => r.exit !== 0)) {
      s.bad = true;
      if (!live) s.label = "Code hit an error";
    }
  }
  return s;
}

/** One entry of `run_shell`'s output JSON. */
interface ShellResult {
  exit_code?: number;
  timed_out?: boolean;
  stdout?: string;
  stderr?: string;
}

/** `run_shell` commands paired with their results (conversation_loop.md "Clients see what ran"). */
export function shellRuns(args: string | undefined, output: string | undefined): ShellRun[] {
  let commands: string[] = [];
  try {
    const parsed = JSON.parse(args || "{}") as { commands?: unknown };
    if (Array.isArray(parsed.commands)) commands = parsed.commands.map(String);
  } catch {
    /* arguments still streaming */
  }
  if (output === undefined) return [];
  let results: ShellResult[] | null = null;
  try {
    const parsed = JSON.parse(output) as { results?: unknown };
    if (Array.isArray(parsed.results)) results = parsed.results as ShellResult[];
  } catch {
    results = null;
  }
  // Not that JSON: a tool error reads as one failed run with its message.
  if (!results) return [{ cmd: commands.join("\n"), out: output, exit: 1 }];
  return results.map((r, i) => ({
    cmd: commands[i] ?? "",
    out: [r.stdout, r.stderr].filter(Boolean).join(r.stdout && r.stderr ? "\n" : ""),
    exit: r.timed_out ? 124 : r.exit_code ?? 0,
    ...(r.timed_out ? { timedOut: true } : {}),
  }));
}
