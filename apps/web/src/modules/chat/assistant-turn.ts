import {
  isFunctionCallItem,
  isFunctionCallOutputItem,
  isMessageItem,
  isOutputTextPart,
  orderedTurnItems,
} from "./message-stream.ts";
import type {
  FunctionCallItem,
  FunctionCallOutputItem,
  RuntimeActivity,
  ShellCommandOutput,
  TurnState,
} from "./types";

/** The sandbox shell tool; its call and output items are the shell record. */
export const SHELL_TOOL = "run_shell";

export type AssistantTurnItem =
  | {
      kind: "message";
      id: string;
      phase: "commentary" | "final_answer";
      text: string;
      state: "streaming" | "done";
    }
  | { kind: "activity"; id: string; activity: RuntimeActivity }
  | {
      kind: "execution";
      id: string;
      callId: string;
      state: "running" | "completed" | "failed" | "timeout";
      commands: string[];
      output: ShellCommandOutput[];
      files: string[];
    };

/**
 * Function calls are model intent, not user-visible activity. An activity
 * appears only after the runtime says that call actually began executing; a
 * `run_shell` call becomes a shell run instead.
 */
export function assistantTurnItems(turn: TurnState | undefined): AssistantTurnItem[] {
  if (!turn) return [];
  const activities = new Map(
    (turn.runtimeActivities ?? []).map((activity) => [activity.callId, activity]),
  );
  const outputs = functionOutputs(turn);
  const seenActivities = new Set<string>();
  const items: AssistantTurnItem[] = [];

  for (const ordered of orderedTurnItems(turn)) {
    const { id, item } = ordered;
    if (isMessageItem(item) && item.role === "assistant") {
      const text = item.content
        .filter(isOutputTextPart)
        .map((part) => part.text)
        .join("");
      if (text) {
        items.push({
          kind: "message",
          id,
          phase: item.phase === "commentary" ? "commentary" : "final_answer",
          text,
          state: item.status === "completed" || turn.status !== "streaming"
            ? "done"
            : "streaming",
        });
      }
      continue;
    }

    if (isFunctionCallItem(item)) {
      const activity = activities.get(item.call_id);
      const output = outputs.get(item.call_id);
      if (item.name === SHELL_TOOL) {
        seenActivities.add(item.call_id);
        // Like any call, a shell run is shown once the runtime started it.
        if (activity || output || turn.status !== "streaming") {
          items.push(shellExecution(id, item, output));
        }
        continue;
      }
      if (activity) {
        items.push({ kind: "activity", id: item.call_id, activity });
        seenActivities.add(item.call_id);
      }
    }
  }
  for (const activity of turn.runtimeActivities ?? []) {
    if (!seenActivities.has(activity.callId)) {
      items.push({ kind: "activity", id: activity.callId, activity });
    }
  }
  return items;
}

/** One sandbox shell run, as the chat presents it. */
export type ExecutionTurnItem = Extract<AssistantTurnItem, { kind: "execution" }>;

/** `function_call_output` items of a turn, by the call they answer. */
export function functionOutputs(turn: TurnState): Map<string, FunctionCallOutputItem> {
  const outputs = new Map<string, FunctionCallOutputItem>();
  for (const { item } of orderedTurnItems(turn)) {
    if (isFunctionCallOutputItem(item)) outputs.set(item.call_id, item);
  }
  return outputs;
}

/**
 * A `run_shell` call and its output as one run. The output's `results` align
 * with the call's `commands`; an output that is not that JSON is a tool error
 * and reads as one failed command.
 */
export function shellExecution(
  id: string,
  call: FunctionCallItem,
  output: FunctionCallOutputItem | undefined,
): ExecutionTurnItem {
  const commands = shellCommands(call.arguments);
  if (!output) {
    return { kind: "execution", id, callId: call.call_id, state: "running", commands, output: [], files: [] };
  }
  const run = parseShellRun(output.output);
  const results = run?.results ?? [{ stdout: "", stderr: output.output, exit_code: null, timed_out: false }];
  return {
    kind: "execution",
    id,
    callId: call.call_id,
    state: results.some((entry) => entry.timed_out)
      ? "timeout"
      : results.some((entry) => !entry.timed_out && entry.exit_code !== 0) ? "failed" : "completed",
    commands,
    output: results,
    files: run?.changed_files ?? [],
  };
}

/**
 * One line that says what a shell run did. A failure names the error the
 * failing command printed, since "it failed" alone tells the reader nothing;
 * commands that succeeded may also write to stderr (warnings, progress) and
 * are not the cause.
 */
export function executionSummary(execution: ExecutionTurnItem): { label: string; detail?: string } {
  const count = execution.commands.length;
  if (execution.state === "running") {
    return { label: "Running code", detail: firstLine(execution.commands[0]) };
  }
  if (execution.state === "timeout") return { label: "Code took too long" };
  if (execution.state === "failed") {
    const failures = execution.output.filter((entry) => !entry.timed_out && entry.exit_code !== 0);
    const failing = failures[0];
    // A batch where most commands worked is not "an error": say how much failed.
    const partial = count > 1 && failures.length < count;
    return {
      label: partial ? `Ran ${count} commands, ${failures.length} failed` : "Code hit an error",
      detail: lastMeaningfulLine(failing?.stderr) ?? lastMeaningfulLine(failing?.stdout)
        ?? (failing?.exit_code != null ? `exit code ${failing.exit_code}` : undefined),
    };
  }
  const files = execution.files.length;
  return {
    label: count > 1 ? `Ran ${count} commands` : "Ran code",
    detail: files ? `${files} file${files === 1 ? "" : "s"} changed` : undefined,
  };
}

function shellCommands(rawArguments: string): string[] {
  const commands = parseObject(rawArguments)?.commands;
  return Array.isArray(commands)
    ? commands.filter((command): command is string => typeof command === "string")
    : [];
}

function parseShellRun(raw: string): { results: ShellCommandOutput[]; changed_files: string[] } | undefined {
  const value = parseObject(raw);
  if (!value || !Array.isArray(value.results)) return undefined;
  const results = value.results
    .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
    .map((entry) => ({
      stdout: typeof entry.stdout === "string" ? entry.stdout : "",
      stderr: typeof entry.stderr === "string" ? entry.stderr : "",
      exit_code: typeof entry.exit_code === "number" ? entry.exit_code : null,
      timed_out: entry.timed_out === true,
    }));
  const changed = Array.isArray(value.changed_files)
    ? value.changed_files.filter((file): file is string => typeof file === "string")
    : [];
  return { results, changed_files: changed };
}

function parseObject(raw: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function firstLine(text: string | undefined) {
  return text?.split("\n").map((line) => line.trim()).find(Boolean);
}

/** Tracebacks end with the error; shells print it on the last line too. */
function lastMeaningfulLine(text: string | undefined) {
  return text?.split("\n").map((line) => line.trim()).filter(Boolean).at(-1);
}
