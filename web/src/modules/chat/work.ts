import { executionSummary, type ExecutionTurnItem } from "./assistant-turn.ts";
import { turnArtifacts } from "./artifacts.ts";
import {
  isFunctionCallItem,
  isHostedExecutionCallItem,
  isHostedExecutionResultItem,
  isMessageItem,
  isOutputTextPart,
  orderedTurnItems,
} from "./message-stream.ts";
import type { HostedExecutionOutput, RuntimeActivity, TurnState } from "./types";

/**
 * How an answer was found, as one collapsed line and the timeline it opens:
 * "Worked for 26s · Searched HR Policies · Ran 3 commands, 1 failed ·
 * Created 2 files". Built only from the turn's own items and runtime facts —
 * never from model claims about what it did.
 */

export type WorkStepKind = "search" | "read" | "prepare" | "code" | "export" | "edit" | "note" | "other";
export type WorkStepState = "live" | "ok" | "bad";

export interface WorkRun {
  command: string;
  output?: HostedExecutionOutput;
  failed: boolean;
}

export interface WorkStep {
  id: string;
  kind: WorkStepKind;
  label: string;
  detail?: string;
  state: WorkStepState;
  /** The search's own queries, shown under the step. */
  queries?: string[];
  /** Shell commands with what they printed and how they ended. */
  runs?: WorkRun[];
  /** Files a shell run reported changing. */
  files?: string[];
}

export interface TurnWork {
  steps: WorkStep[];
  /** The collapsed line; null when nothing ran. */
  summary: string | null;
  /** What is running right now, for the live line. */
  liveLabel: string | null;
  /** Whether a step ran in the secure workspace (shell). */
  usesShell: boolean;
  /**
   * The turn failed while working on files and saved none of them — the
   * "Nothing was saved" state.
   */
  fileWorkFailed: boolean;
}

type ActivityFact = Pick<RuntimeActivity, "callId" | "toolName" | "state" | "resultCount" | "progress">;

interface ToolWords {
  kind: WorkStepKind;
  live: string;
  done: string;
  failed: string;
}

const TOOL_WORDS: Record<string, ToolWords> = {
  knowledge_search: { kind: "search", live: "Searching", done: "Searched", failed: "Couldn’t search" },
  read_resource: { kind: "read", live: "Reading a source", done: "Read a source", failed: "Couldn’t read a source" },
  inspect_resource: { kind: "read", live: "Inspecting a source", done: "Inspected a source", failed: "Couldn’t inspect a source" },
  materialize_resource: { kind: "prepare", live: "Preparing a file", done: "Prepared a file", failed: "Couldn’t prepare a file" },
  materialize_sandbox_resource: { kind: "prepare", live: "Opening a file in the secure workspace", done: "Opened a file in the secure workspace", failed: "Couldn’t open a file in the secure workspace" },
  export_sandbox_file: { kind: "export", live: "Saving a file", done: "Saved a file", failed: "Couldn’t save the file" },
  artifact_create: { kind: "export", live: "Creating a document", done: "Created a document", failed: "Couldn’t create the document" },
  document_edit: { kind: "edit", live: "Editing a document", done: "Edited a document", failed: "Couldn’t edit the document" },
};

const OTHER_WORDS: ToolWords = { kind: "other", live: "Working on your request", done: "Completed an action", failed: "Couldn’t complete an action" };

export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/** "HR Policies", "HR Policies and Finance", "HR Policies, Finance and 2 more". */
export function scopeLabel(titles: readonly string[]): string {
  if (!titles.length) return "your knowledge";
  if (titles.length <= 2) return titles.join(" and ");
  return `${titles[0]}, ${titles[1]} and ${titles.length - 2} more`;
}

/** Seconds from send to settle, when the turn recorded both. */
export function workDurationSeconds(turn: TurnState | undefined): number | undefined {
  if (!turn?.startedAt || !turn.finishedAt || turn.finishedAt < turn.startedAt) return undefined;
  return Math.max(1, Math.round((turn.finishedAt - turn.startedAt) / 1000));
}

export function turnWork(
  turn: TurnState | undefined,
  options: { scopeTitles?: readonly string[] } = {},
): TurnWork {
  if (!turn) return { steps: [], summary: null, liveLabel: null, usesShell: false, fileWorkFailed: false };
  const streaming = turn.status === "streaming";
  const facts = new Map<string, ActivityFact>();
  for (const entry of turn.workLog ?? []) facts.set(entry.callId, entry);
  for (const activity of turn.runtimeActivities ?? []) facts.set(activity.callId, activity);

  const steps: WorkStep[] = [];
  const seenCalls = new Set<string>();
  const where = scopeLabel(options.scopeTitles ?? []);

  for (const { id, item } of orderedTurnItems(turn)) {
    if (isFunctionCallItem(item)) {
      const fact = facts.get(item.call_id);
      // A function call is model intent; while streaming it only becomes a
      // step once the runtime says it began. A settled turn kept going after
      // the call, so the call ran.
      if (!fact && streaming) continue;
      seenCalls.add(item.call_id);
      steps.push(toolStep(item.call_id, item.name, fact, item.arguments, where, streaming));
      continue;
    }
    if (isHostedExecutionCallItem(item) || isHostedExecutionResultItem(item)) {
      const execution: ExecutionTurnItem = isHostedExecutionResultItem(item)
        ? {
            kind: "execution",
            id,
            callId: item.call_id,
            state: item.output.some((entry) => entry.timed_out)
              ? "timeout"
              : item.output.some((entry) => !entry.timed_out && entry.exit_code !== 0) ? "failed" : "completed",
            commands: item.commands,
            output: item.output,
            files: item.workspace_files?.filter((file) => typeof file === "string") ?? [],
          }
        : { kind: "execution", id, callId: item.call_id, state: "running", commands: item.commands, output: [], files: [] };
      // A result replaces the call it reports on.
      const previous = steps.findIndex((step) => step.kind === "code" && step.id === `code:${item.call_id}`);
      const step = codeStep(execution, streaming);
      if (previous >= 0) steps[previous] = step;
      else steps.push(step);
      continue;
    }
    if (isMessageItem(item) && item.role === "assistant" && item.phase === "commentary") {
      const text = item.content.filter(isOutputTextPart).map((part) => part.text).join("").trim();
      if (text) steps.push({ id: `note:${id}`, kind: "note", label: text.length > 240 ? `${text.slice(0, 239)}…` : text, state: "ok" });
    }
  }
  for (const [callId, fact] of facts) {
    if (!seenCalls.has(callId)) steps.push(toolStep(callId, fact.toolName, fact, undefined, where, streaming));
  }

  const artifacts = turnArtifacts(turn);
  const usesShell = steps.some((step) => step.kind === "code" || step.kind === "prepare");
  const fileWorkFailed = turn.status === "failed"
    && artifacts.length === 0
    && steps.some((step) => (step.kind === "code" || step.kind === "prepare" || step.kind === "export") && step.state !== "ok");
  const live = [...steps].reverse().find((step) => step.state === "live");

  return {
    steps,
    summary: workSummary(turn, steps, artifacts.map((artifact) => artifact.revision)),
    liveLabel: streaming && live ? `${live.label}…` : null,
    usesShell,
    fileWorkFailed,
  };
}

function toolStep(
  callId: string,
  toolName: string,
  fact: ActivityFact | undefined,
  rawArguments: string | undefined,
  where: string,
  streaming: boolean,
): WorkStep {
  const words = TOOL_WORDS[toolName] ?? OTHER_WORDS;
  const state: WorkStepState = !fact
    ? "ok"
    : fact.state === "active"
      ? (streaming ? "live" : "bad")
      : fact.state === "failed" || fact.state === "timeout" ? "bad" : "ok";
  const args = parseArguments(rawArguments);
  if (words.kind === "search") {
    const count = fact?.resultCount ?? numeric(fact?.progress?.result_count);
    const queries = Array.isArray(args?.queries)
      ? args.queries.filter((query): query is string => typeof query === "string" && Boolean(query.trim()))
      : typeof args?.query === "string" ? [args.query] : [];
    return {
      id: `call:${callId}`,
      kind: "search",
      label: state === "bad"
        ? fact?.state === "timeout" ? `Searching ${where} took too long` : `${words.failed} ${where}`
        : `${state === "live" ? words.live : words.done} ${where}`,
      detail: state === "ok" && count !== undefined
        ? count === 0 ? "No relevant passages" : plural(count, "relevant passage")
        : undefined,
      state,
      ...(queries.length ? { queries } : {}),
    };
  }
  const fileName = typeof args?.path === "string" ? args.path.split("/").filter(Boolean).at(-1) : undefined;
  const label = state === "live" ? words.live : state === "bad" ? words.failed : words.done;
  return {
    id: `call:${callId}`,
    kind: words.kind,
    label: fileName && words.kind === "export" && state === "ok" ? `Saved ${fileName}` : label,
    detail: fact?.state === "skipped" ? "Skipped" : fact?.state === "timeout" ? "Took too long" : undefined,
    state,
  };
}

function codeStep(execution: ExecutionTurnItem, streaming: boolean): WorkStep {
  const { label, detail } = executionSummary(execution);
  const running = execution.state === "running";
  return {
    id: `code:${execution.callId}`,
    kind: "code",
    label,
    detail,
    state: running ? (streaming ? "live" : "bad") : execution.state === "completed" ? "ok" : "bad",
    runs: execution.commands.map((command, index) => {
      const output = execution.output[index];
      return { command, output, failed: Boolean(output && (output.timed_out || output.exit_code !== 0)) };
    }),
    ...(execution.files.length ? { files: execution.files } : {}),
  };
}

/**
 * "Worked for 26s · Searched HR Policies · Ran 3 commands, 1 failed ·
 * Created 2 files". Only parts that happened are named.
 */
function workSummary(turn: TurnState, steps: WorkStep[], artifactRevisions: number[]): string | null {
  const ran = steps.filter((step) => step.kind !== "note");
  if (!ran.length && !artifactRevisions.length) return null;
  const parts: string[] = [];
  const search = ran.find((step) => step.kind === "search" && step.state !== "live");
  if (search) parts.push(search.label);
  const runs = ran.flatMap((step) => step.runs ?? []);
  if (runs.length) {
    const failed = runs.filter((run) => run.failed).length;
    parts.push(runs.length === 1 && !failed ? "Ran code" : `Ran ${plural(runs.length, "command")}${failed ? `, ${failed} failed` : ""}`);
  }
  const created = artifactRevisions.filter((revision) => revision <= 1).length;
  const updated = artifactRevisions.length - created;
  if (created) parts.push(`Created ${plural(created, "file")}`);
  if (updated) parts.push(`Updated ${plural(updated, "file")}`);
  if (!parts.length) parts.push(ran[0]!.label);
  const seconds = workDurationSeconds(turn);
  return [seconds ? `Worked for ${seconds}s` : null, ...parts].filter(Boolean).join(" · ");
}

function parseArguments(raw: string | undefined): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function numeric(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
