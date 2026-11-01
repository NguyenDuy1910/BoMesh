"use client";

import {
  BookOpen,
  ChevronLeft,
  ChevronRight,
  Copy,
  FileDown,
  Layers,
  Link2,
  List,
  Lock,
  MoreHorizontal,
  Quote,
  RotateCcw,
  Search,
  SlidersHorizontal,
  Square,
  ThumbsDown,
  ThumbsUp,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { memo, useCallback, useMemo, useState } from "react";

import { EvidenceChip } from "@/components/patterns/EvidenceChip";
import { Button, ButtonLink } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { ICON_MENU_TRIGGER } from "./icon-menu-trigger";
import { Menu, MenuItem, MenuSeparator } from "@/components/ui/Menu";
import { useToast } from "@/components/ui/Toast";
import { Tooltip } from "@/components/ui/Tooltip";
import { saveAnswerToPersonalFiles } from "../api";
import { answerFileName, answerMarkdown, answerPlainText } from "../answer-text";
import { turnArtifacts } from "../artifacts";
import { assistantTurnItems } from "../assistant-turn";
import { retryAnswer, selectAnswerVariant, setAnswerFeedback, STOPPED_MESSAGE } from "../chat-runtime";
import { getMessageText } from "../conversations";
import type { RetryMode } from "../conversation-history";
import { useArtifactTitles } from "../hooks/useArtifactTitles";
import type { DocumentAccess } from "../hooks/useDocumentAccess";
import type { ChatPanel } from "../panel";
import { recoveryForTurn } from "../recovery";
import { answerSources, type AnswerSource } from "../sources";
import type { ChatMessage } from "../types";
import { variantPosition } from "../variants";
import { turnWork } from "../work";
import { FileCards } from "./files";
import { FileIcon } from "./FileIcon";
import { CitationRenderingProvider, citationRenderingSources, IncrementalMarkdown } from "./IncrementalMarkdown";
import { WorkLine } from "./WorkLine";

export interface AssistantAnswerProps {
  conversationId: string;
  message: ChatMessage;
  /** The question this answers. */
  question?: ChatMessage;
  /** This answer is streaming now. */
  streaming: boolean;
  /** Some answer in this chat is streaming: retries and variants wait. */
  busy: boolean;
  scopeTitles: readonly string[];
  access: ReadonlyMap<string, DocumentAccess>;
  panel: ChatPanel | null;
  showWork: boolean;
  shareEnabled: boolean;
  onOpenSources: (messageId: string, source?: AnswerSource) => void;
  onCloseSources: () => void;
  onOpenFile: (artifactId: string, revision?: number) => void;
  onShare: () => void;
}

const RETRY_OPTIONS: { mode: RetryMode; label: string; icon: React.ReactNode }[] = [
  { mode: "again", label: "Try again", icon: <RotateCcw /> },
  { mode: "detail", label: "More detail", icon: <List /> },
  { mode: "shorter", label: "Shorter", icon: <SlidersHorizontal /> },
];

/**
 * One answer, in the prototype's order: how it was found, the streamed text
 * with amber citation chips, the files it made, its sources, then actions.
 * Citations to documents the reader can no longer open are dropped; an answer
 * built only from such documents is hidden behind a request-access call-out.
 */
export const AssistantAnswer = memo(function AssistantAnswer({
  conversationId,
  message,
  question,
  streaming,
  busy,
  scopeTitles,
  access,
  panel,
  showWork,
  shareEnabled,
  onOpenSources,
  onCloseSources,
  onOpenFile,
  onShare,
}: AssistantAnswerProps) {
  const router = useRouter();
  const toast = useToast();
  const turn = message.turn;
  const [revealing, setRevealing] = useState(false);
  const [saving, setSaving] = useState(false);

  const answerItems = useMemo(
    () => assistantTurnItems(turn).filter((item) => item.kind === "message" && item.phase === "final_answer"),
    [turn],
  );
  const work = useMemo(() => turnWork(turn, { scopeTitles }), [scopeTitles, turn]);
  const sources = useMemo(() => answerSources(turn), [turn]);
  const titled = useArtifactTitles();
  const artifacts = useMemo(() => turnArtifacts(turn).map(titled), [titled, turn]);
  const visibleSources = useMemo(
    () => sources.filter((source) => access.get(source.itemId) !== "unreadable"),
    [access, sources],
  );
  const dropped = useMemo(() => new Set(sources
    .filter((source) => access.get(source.itemId) === "unreadable")
    .flatMap((source) => [source.index, ...source.passages.map((passage) => passage.number)])), [access, sources]);
  const activeSourceId = panel?.kind === "sources" && panel.messageId === message.id ? panel.sourceId : undefined;
  const openSource = useCallback((source: AnswerSource) => onOpenSources(message.id, source), [message.id, onOpenSources]);
  const citations = useMemo(() => ({
    sources: citationRenderingSources(visibleSources),
    dropped,
    activeSourceId,
    onOpenSource: openSource,
  }), [activeSourceId, dropped, openSource, visibleSources]);

  const text = getMessageText(message);
  const settled = !streaming && !revealing;
  const failed = turn?.status === "failed";
  const stopped = failed && turn?.error === STOPPED_MESSAGE;
  const recovery = useMemo(() => recoveryForTurn(turn), [turn]);
  const scoped = question?.parts.some((part) => part.type === "data-collection") ?? false;
  const hidden = !streaming && sources.length > 0 && visibleSources.length === 0;
  const searches = work.steps.filter((step) => step.kind === "search");
  const noResults = settled && turn?.status === "completed" && !sources.length && !artifacts.length
    && searches.length > 0 && searches.every((step) => step.detail === "No relevant passages");
  const position = variantPosition(message);
  const sourcesOpen = panel?.kind === "sources" && panel.messageId === message.id;
  const live = streaming && !answerItems.some((item) => item.kind === "message" && item.text.trim());

  if (hidden) {
    return (
      <Callout
        actions={<ButtonLink href="/knowledge" icon={<BookOpen aria-hidden="true" />} size="sm" variant="secondary">Browse knowledge</ButtonLink>}
        icon={<Lock aria-hidden="true" />}
        title="This answer uses knowledge you can’t access"
        tone="neutral"
      >
        Request access to its knowledge base from Knowledge, or ask again to search what you can access.
      </Callout>
    );
  }

  const copy = async (value: string, done: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast.show({ message: done });
    } catch {
      toast.show({ tone: "err", message: "Copying isn’t allowed in this browser." });
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      await saveAnswerToPersonalFiles(
        answerFileName(question ? getMessageText(question) : "Answer"),
        answerMarkdown(text, visibleSources),
      );
      toast.show({ message: "Saved to My files", action: { label: "Open", onClick: () => router.push("/knowledge/personal") } });
    } catch (cause) {
      toast.show({ tone: "err", message: "The answer couldn’t be saved", description: cause instanceof Error ? cause.message : undefined });
    } finally {
      setSaving(false);
    }
  };

  return (
    <CitationRenderingProvider value={citations}>
      <WorkLine
        live={live}
        liveFallback={(turn?.runtimeActivities ?? []).some((activity) => activity.state === "completed")
          ? "Preparing your answer…"
          : "Understanding the request…"}
        showSteps={showWork}
        work={work}
      />
      {answerItems.map((item, index) => item.kind === "message" ? (
        <div className="assistant-content" key={item.id}>
          <IncrementalMarkdown
            isStreaming={streaming && item.state === "streaming"}
            onRevealingChange={index === answerItems.length - 1 ? setRevealing : undefined}
            text={item.text}
          />
        </div>
      ) : null)}

      {stopped && settled && (
        <div className="mt-2.5 flex items-center gap-2 text-[0.8125rem] text-text-tertiary">
          <Square aria-hidden="true" className="fill-current" size={11} />
          <span>Stopped</span>
          <Button disabled={busy} icon={<RotateCcw aria-hidden="true" />} onClick={() => retryAnswer(conversationId, message.id, "again")} size="sm" variant="ghost">
            Retry
          </Button>
        </div>
      )}
      {failed && !stopped && settled && (
        <Callout
          actions={(
            <Button disabled={busy} icon={<RotateCcw aria-hidden="true" />} onClick={() => retryAnswer(conversationId, message.id, "again")} size="sm" variant="secondary">
              Retry
            </Button>
          )}
          className="mt-3"
          title={work.fileWorkFailed ? "The file work stopped before it finished" : recovery?.title ?? "The answer stopped before it finished"}
          tone="err"
        >
          {work.fileWorkFailed
            ? "Nothing was saved. Retry to run it again in a fresh workspace."
            : recovery?.detail ?? "Retry to get the full answer."}
        </Callout>
      )}

      {settled && !failed && noResults && (
        <div className="mt-3 flex flex-wrap gap-2">
          {scoped && (
            <Button disabled={busy} icon={<Search aria-hidden="true" />} onClick={() => retryAnswer(conversationId, message.id, "all_knowledge")} size="sm" variant="secondary">
              Search all knowledge
            </Button>
          )}
          <ButtonLink href="/knowledge" icon={<BookOpen aria-hidden="true" />} size="sm" variant={scoped ? "ghost" : "secondary"}>
            Browse knowledge
          </ButtonLink>
        </div>
      )}
      {settled && dropped.size > 0 && (
        <p className="mt-2.5 flex items-center gap-1.5 text-[0.8125rem] text-text-tertiary">
          <Lock aria-hidden="true" size={13} />
          Knowledge you can’t access may have more on this.
        </p>
      )}

      {artifacts.length > 0 && (
        <FileCards
          activeId={panel?.kind === "file" ? panel.artifactId : undefined}
          artifacts={artifacts}
          onOpen={onOpenFile}
        />
      )}

      {settled && visibleSources.length > 0 && (
        <ul aria-label="Sources" className="mt-3.5 flex flex-wrap gap-1.5">
          {visibleSources.map((source) => (
            <li key={source.id}>
              <EvidenceChip
                icon={<FileIcon name={source.title} size={16} />}
                n={source.index}
                onClick={() => openSource(source)}
                title={source.title}
                tooltip={[source.title, source.locator].filter(Boolean).join(" · ")}
              />
            </li>
          ))}
        </ul>
      )}

      {settled && !failed && !noResults && text.trim() && (
        <div aria-label="Answer actions" className="-ml-1.5 mt-2.5 flex items-center gap-0.5" role="group">
          {position && (
            <span className="mr-1 inline-flex items-center gap-0.5 font-mono text-caption font-medium text-text-tertiary">
              <Button
                aria-label="Previous answer"
                disabled={busy || position.index === 0}
                icon={<ChevronLeft aria-hidden="true" />}
                iconOnly
                onClick={() => selectAnswerVariant(conversationId, message.id, position.index - 1)}
                size="sm"
                variant="ghost"
              />
              <span aria-live="polite">{position.index + 1}/{position.count}</span>
              <Button
                aria-label="Next answer"
                disabled={busy || position.index >= position.count - 1}
                icon={<ChevronRight aria-hidden="true" />}
                iconOnly
                onClick={() => selectAnswerVariant(conversationId, message.id, position.index + 1)}
                size="sm"
                variant="ghost"
              />
            </span>
          )}
          <Tooltip label="Copy">
            <Button aria-label="Copy" icon={<Copy aria-hidden="true" />} iconOnly onClick={() => void copy(answerPlainText(text), "Copied")} size="sm" variant="ghost" />
          </Tooltip>
          <Menu ariaLabel="Retry" disabled={busy} label={<RotateCcw aria-hidden="true" />} showChevron={false} tooltip="Retry" triggerClassName={ICON_MENU_TRIGGER}>
            {RETRY_OPTIONS.map((option) => (
              <MenuItem icon={option.icon} key={option.mode} onSelect={() => retryAnswer(conversationId, message.id, option.mode)}>
                {option.label}
              </MenuItem>
            ))}
            <MenuSeparator />
            <MenuItem icon={<Layers />} onSelect={() => retryAnswer(conversationId, message.id, "all_knowledge")}>
              Search all knowledge
            </MenuItem>
          </Menu>
          <Tooltip label="Good answer">
            <Button
              aria-label="Good answer"
              aria-pressed={message.feedback === "up"}
              icon={<ThumbsUp aria-hidden="true" />}
              iconOnly
              onClick={() => {
                const next = message.feedback === "up" ? undefined : "up";
                setAnswerFeedback(conversationId, message.id, next);
                if (next) toast.show({ message: "Thanks for the feedback" });
              }}
              size="sm"
              variant="ghost"
            />
          </Tooltip>
          <Tooltip label="Bad answer">
            <Button
              aria-label="Bad answer"
              aria-pressed={message.feedback === "down"}
              icon={<ThumbsDown aria-hidden="true" />}
              iconOnly
              onClick={() => {
                const next = message.feedback === "down" ? undefined : "down";
                setAnswerFeedback(conversationId, message.id, next);
                if (next) toast.show({ message: "Thanks for the feedback", description: "Try Retry › More detail, or Search all knowledge." });
              }}
              size="sm"
              variant="ghost"
            />
          </Tooltip>
          {visibleSources.length > 0 && (
            <Button
              aria-pressed={sourcesOpen}
              icon={<Quote aria-hidden="true" />}
              onClick={() => (sourcesOpen ? onCloseSources() : onOpenSources(message.id))}
              size="sm"
              variant="ghost"
            >
              Sources
            </Button>
          )}
          <Menu ariaLabel="More answer actions" label={<MoreHorizontal aria-hidden="true" />} showChevron={false} tooltip="More" triggerClassName={ICON_MENU_TRIGGER}>
            <MenuItem icon={<Copy />} onSelect={() => void copy(answerMarkdown(text, visibleSources), "Copied as Markdown")}>
              Copy as Markdown
            </MenuItem>
            <MenuItem disabled={saving} icon={<FileDown />} onSelect={() => void save()}>
              Save answer to My files
            </MenuItem>
            {shareEnabled && (
              <>
                <MenuSeparator />
                <MenuItem icon={<Link2 />} onSelect={onShare}>Share chat</MenuItem>
              </>
            )}
          </Menu>
        </div>
      )}
    </CitationRenderingProvider>
  );
});
