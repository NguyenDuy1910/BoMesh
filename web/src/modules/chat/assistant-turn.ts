import {
  isHostedExecutionCallItem,
  isHostedExecutionResultItem,
  isFunctionCallItem,
  isMessageItem,
  isOutputTextPart,
  orderedTurnItems,
} from "./message-stream.ts";
import type { HostedExecutionOutput, RuntimeActivity, TurnState } from "./types";

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
      output: HostedExecutionOutput[];
      files: string[];
    };

/**
 * Function calls are model intent, not user-visible activity. An activity
 * appears only after the runtime says that call actually began executing.
 */
export function assistantTurnItems(turn: TurnState | undefined): AssistantTurnItem[] {
  if (!turn) return [];
  const activities = new Map(
    (turn.runtimeActivities ?? []).map((activity) => [activity.callId, activity]),
  );
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
      if (activity) {
        items.push({ kind: "activity", id: item.call_id, activity });
        seenActivities.add(item.call_id);
      }
      continue;
    }

    if (isHostedExecutionCallItem(item)) {
      items.push({
        kind: "execution",
        id,
        callId: item.call_id,
        state: "running",
        commands: item.commands,
        output: [],
        files: [],
      });
      continue;
    }

    if (isHostedExecutionResultItem(item)) {
      const timedOut = item.output.some((entry) => entry.timed_out);
      const failed = item.output.some(
        (entry) => !entry.timed_out && entry.exit_code !== 0,
      );
      items.push({
        kind: "execution",
        id,
        callId: item.call_id,
        state: timedOut ? "timeout" : failed ? "failed" : "completed",
        commands: item.commands,
        output: item.output,
        files: item.workspace_files?.filter((file) => typeof file === "string") ?? [],
      });
    }
  }
  for (const activity of turn.runtimeActivities ?? []) {
    if (!seenActivities.has(activity.callId)) {
      items.push({ kind: "activity", id: activity.callId, activity });
    }
  }
  return items;
}

/** One hosted shell run, as the chat presents it. */
export type ExecutionTurnItem = Extract<AssistantTurnItem, { kind: "execution" }>;

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

function firstLine(text: string | undefined) {
  return text?.split("\n").map((line) => line.trim()).find(Boolean);
}

/** Tracebacks end with the error; shells print it on the last line too. */
function lastMeaningfulLine(text: string | undefined) {
  return text?.split("\n").map((line) => line.trim()).filter(Boolean).at(-1);
}
