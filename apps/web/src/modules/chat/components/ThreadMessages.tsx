"use client";

import { Button, Dropdown, Header, Label, Separator, TextArea } from "@heroui/react";
import clsx from "clsx";
import {
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  Layers,
  List as ListIcon,
  Lock,
  MoreHorizontal,
  Pencil,
  RotateCcw,
  SlidersHorizontal,
  Square,
  ThumbsDown,
  ThumbsUp,
  X,
} from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState, type Key } from "react";

import { Callout } from "@/components/ui/Callout";
import { FileIcon } from "@/components/ui/FileIcon";
import { IconButton } from "@/components/ui/IconButton";
import { Tip } from "@/components/ui/Tip";
import { useWorkspace } from "@/lib/workspace";
import { ArtifactCards, AttachmentChip } from "@/modules/artifacts";
import { useItem } from "@/modules/knowledge/queries";

import { copyRich, copyText, downloadPdf, downloadWord } from "../download";
import type { SentFile } from "../runtime";
import type { AnswerView } from "../thread";
import type { AnswerSource, FoundSource } from "../turn";
import { AnswerMarkdown } from "./AnswerMarkdown";
import { WorkSteps } from "./WorkSteps";

/* ═══════════════ Question ═══════════════ */

export interface UserMessageProps {
  id: string;
  text: string;
  files: readonly SentFile[];
  /** Editing is offered for stored questions while nothing streams. */
  canEdit: boolean;
  editing: boolean;
  onEdit: (id: string) => void;
  onCancel: () => void;
  onSave: (id: string, text: string) => void;
}

/** A question. Memoized: while an answer streams, the questions above it don't re-render. */
export const UserMessage = memo(function UserMessage({ id, text, files, canEdit, editing, onEdit, onCancel, onSave }: UserMessageProps) {
  const [draft, setDraft] = useState(text);
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!editing) return;
    setDraft(text);
    requestAnimationFrame(() => {
      const el = input.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
  }, [editing, text]);

  const filesRow = files.length ? (
    <div className="chat-user__files">
      {files.map((f, i) => (
        <AttachmentChip key={`${f.item ?? f.name}-${i}`} file={f} />
      ))}
    </div>
  ) : null;

  if (editing) {
    return (
      <div className="chat-msg chat-msg--user" id={`msg-${id}`}>
        <div className="chat-edit">
          {filesRow}
          <TextArea
            ref={input}
            id="chat-edit-in"
            rows={3}
            aria-label="Edit your message"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") onCancel();
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                if (draft.trim()) onSave(id, draft.trim());
              }
            }}
          />
          <div className="row gap-8">
            <span className="grow t-xs muted">The answer below will be replaced.</span>
            <Button size="sm" variant="ghost" onPress={onCancel}>
              Cancel
            </Button>
            <Button size="sm" variant="primary" isDisabled={!draft.trim()} onPress={() => onSave(id, draft.trim())}>
              Send
            </Button>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="chat-msg chat-msg--user" id={`msg-${id}`}>
      <div className="chat-user">
        {filesRow}
        <div className="chat-bubble" translate="no">
          {text}
        </div>
        <div className="chat-user__actions">
          <IconButton icon={Copy} tip="Copy" size="sm" onPress={() => void copyText(text)} />
          {canEdit ? <IconButton icon={Pencil} tip="Edit" size="sm" onPress={() => onEdit(id)} /> : null}
        </div>
      </div>
    </div>
  );
});

/* ═══════════════ Answer ═══════════════ */

export type RetryMode = "again" | "detail" | "shorter" | "all";

const REASONS = ["Not accurate", "Missing information", "Wrong source", "Didn’t answer my question"];

export interface AnswerProps {
  answer: AnswerView;
  /** Conversation title (downloads). */
  title: string;
  showSteps: boolean;
  /** Another answer is streaming (retry is blocked). */
  busy: boolean;
  /** The conversation searches a narrowed scope ("Search all knowledge"). */
  scoped: boolean;
  /** The source the panel shows, when it shows one of this answer. */
  activeCite: number | null;
  activeArtifact: string | null;
  onCite: (n: number, answer: AnswerView) => void;
  onOpenArtifact: (artifact: string) => void;
  onRetry: (answer: AnswerView, mode: RetryMode) => void;
  onFeedback: (message: string, rating: "HELPFUL" | "UNHELPFUL" | null, reason?: string) => void;
  onFeedbackComment: (message: string) => void;
  /** A document a step found (opens the preview at the found passage). */
  onOpenSource: (source: FoundSource) => void;
}

interface Shown {
  message?: string;
  text: string;
  sources: AnswerView["sources"];
  artifacts: string[];
  state: AnswerView["state"];
  rating?: "HELPFUL" | "UNHELPFUL";
  reason?: string;
}

/** One answer (preview `aiInner`): steps, text with markers, states, files, sources, actions. Memoized: settled answers
 *  skip the per-frame renders of the one that streams. */
export const Answer = memo(function Answer(props: AnswerProps) {
  const { answer, title, showSteps, busy, scoped, activeCite, activeArtifact, onCite, onOpenArtifact, onRetry, onFeedback, onFeedbackComment, onOpenSource } = props;
  const { workspace } = useWorkspace();
  const attempts: Shown[] = [...answer.earlier, answer];
  const [index, setIndex] = useState(attempts.length - 1);
  useEffect(() => setIndex(attempts.length - 1), [attempts.length]);
  const shown = attempts[Math.min(index, attempts.length - 1)]!;
  const answerRef = useRef<HTMLDivElement>(null);
  const streaming = shown.state === "streaming";
  const visible = shown.sources.filter((s) => s.available);
  // Each cited document's source numbers, so the cards in the flow and the answer point at each other.
  const cited = useMemo(() => new Map(shown.sources.filter((s) => s.available).map((s) => [s.item, [s.n, ...(s.aliases ?? [])]])), [shown.sources]);
  const askAll = `Ask again in all of ${workspace.displayName ?? "the workspace"}`;

  // Built only from knowledge this person can't read: show nothing of it.
  if (shown.sources.length && !visible.length && !streaming) {
    return (
      <div className="chat-msg chat-msg--ai" id={`msg-${answer.key}`}>
        <Callout
          icon={Lock}
          title="This answer uses knowledge you can’t access"
          description="Ask a workspace admin if you need it, or ask again to search only what you can access."
          actions={
            <Button size="sm" variant="secondary" isDisabled={busy} onPress={() => onRetry(answer, "all")}>
              <RotateCcw className="i" aria-hidden />
              Ask again with what I can access
            </Button>
          }
        />
      </div>
    );
  }

  const fileWork = answer.steps.some((s) => s.bad);
  const settled = shown.state === "COMPLETED";
  const cite = (n: number) => onCite(n, { ...answer, sources: shown.sources });

  /** One Copy: the answer as formatted text with Markdown as its plain flavour; markers of sources you can't open are dropped. */
  const copy = () => {
    const open = new Set(visible.flatMap((s) => [s.n, ...(s.aliases ?? [])]));
    const markdown = shown.text.replace(/\s?\[(\d+)\]/g, (m, n: string) => (open.has(Number(n)) ? m : ""));
    void copyRich(markdown, answerRef.current?.querySelector(".chat-answer")?.innerHTML ?? null);
  };

  const message = shown.message;
  const downMenu = (
    <Dropdown>
      <IconButton icon={ThumbsDown} tip="Bad answer" size="sm" className={clsx(shown.rating === "UNHELPFUL" && "is-pressed")} />
      <Dropdown.Popover placement="bottom start">
        <Dropdown.Menu
          aria-label="What was wrong?"
          onAction={(key: Key) => {
            if (!message) return;
            const k = String(key);
            if (k === "other") onFeedbackComment(message);
            else if (k === "remove") onFeedback(message, null);
            else onFeedback(message, "UNHELPFUL", k);
          }}
        >
          <Dropdown.Section>
            <Header>What was wrong?</Header>
            {REASONS.map((r) => (
              <Dropdown.Item key={r} id={r} textValue={r}>
                <Label>{r}</Label>
              </Dropdown.Item>
            ))}
            <Dropdown.Item id="other" textValue="Something else…">
              <Pencil className="i" aria-hidden />
              <Label>Something else…</Label>
            </Dropdown.Item>
          </Dropdown.Section>
          {shown.rating === "UNHELPFUL" ? (
            <Dropdown.Section>
              <Separator />
              <Dropdown.Item id="remove" textValue="Remove feedback">
                <X className="i" aria-hidden />
                <Label>Remove feedback</Label>
              </Dropdown.Item>
            </Dropdown.Section>
          ) : null}
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );

  const moreMenu = (
    <Dropdown>
      <IconButton icon={MoreHorizontal} tip="More" size="sm" />
      <Dropdown.Popover placement="bottom start">
        <Dropdown.Menu
          aria-label="More"
          disabledKeys={busy ? ["detail", "shorter", "all"] : []}
          onAction={(key: Key) => {
            if (key === "detail" || key === "shorter" || key === "all") onRetry(answer, key);
            if (key === "word") downloadWord(title, answerRef.current?.querySelector(".chat-answer") ?? null, shown.text, shown.sources);
            if (key === "pdf") downloadPdf(title, shown.text, shown.sources);
          }}
        >
          <Dropdown.Section>
            <Header>Rewrite</Header>
            <Dropdown.Item id="detail" textValue="More detail">
              <ListIcon className="i" aria-hidden />
              <Label>More detail</Label>
            </Dropdown.Item>
            <Dropdown.Item id="shorter" textValue="Shorter">
              <SlidersHorizontal className="i" aria-hidden />
              <Label>Shorter</Label>
            </Dropdown.Item>
            {scoped ? (
              <Dropdown.Item id="all" textValue={askAll}>
                <Layers className="i" aria-hidden />
                <Label>{askAll}</Label>
              </Dropdown.Item>
            ) : null}
          </Dropdown.Section>
          <Separator />
          <Dropdown.Section>
            <Header>Download</Header>
            <Dropdown.Item id="word" textValue="Word document">
              <Download className="i" aria-hidden />
              <Label className="grow">Word document</Label>
              <span className="menu-item__meta">.doc</span>
            </Dropdown.Item>
            <Dropdown.Item id="pdf" textValue="PDF">
              <Download className="i" aria-hidden />
              <Label className="grow">PDF</Label>
              <span className="menu-item__meta">.pdf</span>
            </Dropdown.Item>
          </Dropdown.Section>
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );

  return (
    <div className="chat-msg chat-msg--ai" id={`msg-${answer.key}`} ref={answerRef}>
      {index === attempts.length - 1 ? (
        <WorkSteps steps={answer.steps} streaming={streaming} working={streaming && !shown.text} show={showSteps} files={shown.artifacts.length > 0} cited={cited} onOpenSource={onOpenSource} />
      ) : null}
      {shown.text || streaming ? <AnswerMarkdown text={shown.text} sources={shown.sources} streaming={streaming && !!shown.text} activeN={activeCite} onCite={cite} /> : null}
      {shown.state === "INTERRUPTED" ? (
        <div className="chat-stopped">
          <Square className="i i-xs" aria-hidden />
          <span>Stopped</span>
          <Button variant="ghost" size="sm" isDisabled={busy} onPress={() => onRetry(answer, "again")}>
            <RotateCcw className="i" aria-hidden />
            Retry
          </Button>
        </div>
      ) : null}
      {shown.state === "FAILED" ? (
        <div className="mt-12">
          <Callout
            tone="danger"
            title={fileWork ? "The file work stopped before it finished" : "The answer stopped before it finished"}
            description={answer.refused && answer.error ? answer.error : fileWork ? "Nothing was saved. Retry to run it again." : "Retry to get the full answer."}
            actions={
              <Button size="sm" variant="secondary" isDisabled={busy} onPress={() => onRetry(answer, "again")}>
                <RotateCcw className="i" aria-hidden />
                Retry
              </Button>
            }
          />
        </div>
      ) : null}
      {settled && visible.length < shown.sources.length ? (
        <p className="chat-hint">
          <Lock className="i i-xs" aria-hidden />
          <span>Knowledge you can’t access may have more on this.</span>
        </p>
      ) : null}
      {!streaming ? <ArtifactCards artifacts={shown.artifacts} activeArtifact={activeArtifact} onOpen={onOpenArtifact} /> : null}
      {!streaming && visible.length ? (
        <div className="chat-sources" role="group" aria-label="Sources">
          {visible.map((s) => (
            <SourceChip key={s.n} source={s} active={activeCite === s.n} onPress={() => cite(s.n)} />
          ))}
        </div>
      ) : null}
      {settled && message ? (
        <div className="chat-actions">
          {attempts.length > 1 ? (
            <span className="chat-pager">
              <IconButton icon={ChevronLeft} tip="Previous answer" size="sm" isDisabled={index === 0 || busy} onPress={() => setIndex(index - 1)} />
              <span className="t-xs num">
                {index + 1}/{attempts.length}
              </span>
              <IconButton icon={ChevronRight} tip="Next answer" size="sm" isDisabled={index >= attempts.length - 1 || busy} onPress={() => setIndex(index + 1)} />
            </span>
          ) : null}
          <IconButton icon={Copy} tip="Copy" size="sm" onPress={copy} />
          <IconButton icon={RotateCcw} tip="Retry" size="sm" isDisabled={busy} onPress={() => onRetry(answer, "again")} />
          <IconButton
            icon={ThumbsUp}
            tip="Good answer"
            size="sm"
            className={clsx(shown.rating === "HELPFUL" && "is-pressed")}
            onPress={() => onFeedback(message, shown.rating === "HELPFUL" ? null : "HELPFUL")}
          />
          {downMenu}
          {moreMenu}
        </div>
      ) : null}
    </div>
  );
});

/** One chip per cited document (preview `sourcesHtml`): its numbers open the matching passages. */
function SourceChip({ source: s, active, onPress }: { source: AnswerSource; active: boolean; onPress: () => void }) {
  const item = useItem(s.item);
  const pages = [...new Set(s.passages.map((p) => p.page).filter((p): p is number => !!p))];
  const ns = [s.n, ...(s.aliases ?? [])];
  const title = s.title || item.data?.displayName || "Document";
  const where = pages.length > 1 ? `, pages ${pages.join(", ")}` : pages.length ? `, page ${pages[0]}` : "";
  return (
    <Tip content={`${title}${where.replace(/^, /, " · ")}`}>
      <button type="button" className="chat-source" aria-pressed={active} aria-label={`${ns.length > 1 ? "Sources" : "Source"} ${ns.join(", ")}: ${title}${where}`} onClick={onPress}>
        <span className="chat-source__ns" aria-hidden>
          {ns.map((n) => (
            <span key={n} className="chat-source__n">
              {n}
            </span>
          ))}
        </span>
        <FileIcon mime={item.data?.document?.mimeType} name={item.data?.document?.fileName ?? title} size="sm" />
        <span className="truncate" translate="no">
          {title}
        </span>
      </button>
    </Tip>
  );
}
