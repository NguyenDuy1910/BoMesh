"use client";

import { Button, Skeleton } from "@heroui/react";
import { useQueryClient } from "@tanstack/react-query";
import { MessageSquare, MessageSquarePlus, RotateCcw, Share } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { useShowWorkSteps } from "@/components/shell/preferences";
import { PageChrome, type Crumb } from "@/components/shell/page-chrome";
import { confirm } from "@/components/ui/Confirm";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { toast } from "@/components/ui/Toast";
import { ApiError, errorMessage, resourceId } from "@/lib/api/client";
import { useWorkspace } from "@/lib/workspace";
import { confirmLeaveFileEdit, FilePanel, useComposerFiles, useFileDrop } from "@/modules/artifacts";
import { ConversationMenu, useConversationProject } from "@/modules/projects";
import { useMySpaces } from "@/modules/spaces";

import { chatKeys, submitFeedback, updateConversation, type ConversationScope, type Message } from "../api";
import { useConversation, useMessages } from "../queries";
import { dismissTurn, sendTurn, sentFiles, stopTurn, useLiveTurn, useStreamingConversation, type AnswerAttempt, type SentFile } from "../runtime";
import { buildThread, RETRY_MODIFIER, type AnswerView } from "../thread";
import type { AnswerSource } from "../turn";
import { CitationPanel } from "./CitationPanel";
import { Composer, useDraft } from "./Composer";
import { FeedbackDialog } from "./FeedbackDialog";
import { ShareConversationDialog } from "./ShareConversationDialog";
import { Answer, UserMessage, type RetryMode } from "./ThreadMessages";

type Panel = { kind: "cite"; answer: string; n: number; sources: AnswerSource[] } | { kind: "file"; artifact: string };

const RETRY_SUFFIX: Record<RetryMode, string> = { again: "", all: "", ...RETRY_MODIFIER };

function ThreadSkeleton() {
  return (
    <div className="chat-thread" aria-busy="true" aria-label="Loading">
      {[0, 1].map((i) => (
        <div key={i} className="stack gap-28">
          <div className="chat-msg chat-msg--user">
            <Skeleton style={{ width: 300 - i * 80, height: 44, borderRadius: "var(--radius-3xl)" }} />
          </div>
          <div className="stack gap-8">
            <Skeleton className="skeleton--line" style={{ width: "40%", height: 10 }} />
            <Skeleton className="skeleton--line" style={{ width: "96%" }} />
            <Skeleton className="skeleton--line" style={{ width: "88%" }} />
            <Skeleton className="skeleton--line" style={{ width: "72%" }} />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * `/chat/[id]` (preview `P.chatThread`): the thread, the docked follow-up
 * composer, and the side panel (a citation's passages or a file).
 */
export function ChatThread({ id }: { id: string }) {
  const { id: ws } = useWorkspace();
  const router = useRouter();
  const queryClient = useQueryClient();
  const conversation = useConversation(id);
  const messages = useMessages(id);
  const live = useLiveTurn(id);
  const streamingIn = useStreamingConversation();
  const showSteps = useShowWorkSteps();
  const project = useConversationProject(conversation.data?.name);
  const spaces = useMySpaces();
  const files = useComposerFiles(id);
  const drop = useFileDrop(files);
  const [draft, setDraft] = useDraft(id);
  const [panel, setPanel] = useState<Panel | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);
  const [commentFor, setCommentFor] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    setPanel(null);
    setEditing(null);
    stick.current = true;
  }, [id]);

  const conv = conversation.data;
  const title = conv?.displayName || "New chat";
  const scope: ConversationScope = conv?.scope ?? {};
  const scoped = !!(scope.collections?.length || scope.spaces?.length);
  const rows = useMemo(() => buildThread(messages.data ?? [], live), [messages.data, live, live?.turn]);
  const streamingHere = streamingIn === id;
  const busy = !!streamingIn;

  /* Keep the newest text in view while streaming, unless the reader scrolled up. */
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });
  const onScroll = () => {
    const el = scroller.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  /* ─── Sending ─── */
  const send = useCallback(
    (input: { message: string; attachments?: string[]; files?: SentFile[]; replaceFromMessage?: string; earlier?: AnswerAttempt[] }) => {
      if (streamingIn) {
        toast(streamingIn === id ? "Wait for this answer to finish, or stop it." : "Another answer is still being written. Wait for it or stop it.", { tone: "accent" });
        return false;
      }
      dismissTurn(id);
      stick.current = true;
      return sendTurn(queryClient, { workspace: ws, conversation: id, ...input });
    },
    [streamingIn, id, queryClient, ws],
  );

  const onSend = () => {
    const message = draft.trim();
    if (!message || !files.ready) return;
    if (send({ message, attachments: files.attachments, files: sentFiles(files.files) })) {
      setDraft("");
      files.clear();
    }
  };

  const onRetry = async (answer: AnswerView, mode: RetryMode) => {
    if (busy) return;
    if (mode === "all") {
      try {
        const updated = await updateConversation(ws, id, { scope: {} }, ["scope"]);
        queryClient.setQueryData(chatKeys.conversation(ws, id), updated);
      } catch (error) {
        toast(errorMessage(error), { tone: "danger" });
        return;
      }
    }
    const current: AnswerAttempt[] =
      answer.message && answer.state !== "streaming"
        ? [{ message: answer.message, text: answer.text, sources: answer.sources, artifacts: answer.artifacts, state: answer.state, rating: answer.rating }]
        : [];
    send({
      message: answer.questionText + RETRY_SUFFIX[mode],
      attachments: answer.files.map((f) => f.item).filter((x): x is string => !!x),
      files: answer.files,
      replaceFromMessage: answer.question,
      earlier: answer.question ? [...answer.earlier, ...current] : [],
    });
  };

  const onEditSave = async (message: Message | undefined, text: string, index: number, sent: SentFile[]) => {
    if (!message?.name) return;
    const later = rows.slice(index + 1).filter((r) => r.kind !== "unanswered").length - 1;
    if (later > 0) {
      const ok = await confirm({
        title: "Edit and resend?",
        description: `The ${later === 1 ? "later message" : `${later} later messages`} in this conversation will be removed. Files the assistant made stay available.`,
        confirmLabel: "Edit and resend",
        tone: "accent",
      });
      if (!ok) return;
    }
    setEditing(null);
    send({ message: text, replaceFromMessage: message.name, files: sent, attachments: sent.map((f) => f.item).filter((x): x is string => !!x) });
  };

  const onFeedback = async (message: string, rating: "HELPFUL" | "UNHELPFUL" | null, reason?: string, comment?: string) => {
    try {
      const updated = await submitFeedback(ws, id, resourceId(message), { rating: rating ?? "RATING_UNSPECIFIED", ...(reason ? { reason } : {}), ...(comment ? { comment } : {}) });
      queryClient.setQueryData<Message[]>(chatKeys.messages(ws, id), (list) => list?.map((m) => (m.name === updated.name ? updated : m)));
      if (rating) toast("Thanks — your feedback goes to the workspace admins");
    } catch (error) {
      toast(errorMessage(error), { tone: "danger" });
    }
  };

  /* ─── Panel ─── */
  const openCite = async (n: number, answer: AnswerView) => {
    if (panel?.kind === "file" && !(await confirmLeaveFileEdit())) return;
    setPanel({ kind: "cite", answer: answer.key, n, sources: answer.sources.filter((s) => s.available) });
  };
  const openFile = async (artifact: string) => {
    if (panel?.kind === "file" && panel.artifact !== artifact && !(await confirmLeaveFileEdit())) return;
    setPanel({ kind: "file", artifact });
  };
  const closePanel = useCallback(async () => {
    if (panel?.kind === "file" && !(await confirmLeaveFileEdit())) return;
    setPanel(null);
    document.querySelector<HTMLTextAreaElement>("#chat-input")?.focus();
  }, [panel]);

  /* Escape: edit → panel (preview `esc-page`). */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || document.querySelector("[role=dialog], [role=menu], [role=listbox]")) return;
      if (editing) setEditing(null);
      else if (panel) void closePanel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editing, panel, closePanel]);

  const onScopeChange = async (next: ConversationScope) => {
    try {
      const updated = await updateConversation(ws, id, { scope: next }, ["scope"]);
      queryClient.setQueryData(chatKeys.conversation(ws, id), updated);
    } catch (error) {
      toast(errorMessage(error), { tone: "danger" });
    }
  };

  /* ─── Chrome ─── */
  const space = scope.spaces?.[0] ? (spaces.data ?? []).find((s) => s.name === scope.spaces![0]) ?? null : null;
  const crumbs: Crumb[] = space
    ? [{ label: "Spaces", href: "/spaces" }, { label: space.displayName, href: `/space/${resourceId(space.name)}` }, { label: title }]
    : project
      ? [{ label: project.displayName, href: `/project/${project.id}` }, { label: title }]
      : [{ label: "Conversations", href: "/chats" }, { label: title }];

  const unavailable = conversation.error instanceof ApiError && conversation.error.isNotFound;
  if (unavailable || conv?.deleteTime) {
    return (
      <div className="page">
        <PageChrome crumbs={[{ label: "Conversations", href: "/chats" }, { label: "Not found" }]} />
        <EmptyState
          icon={MessageSquare}
          title="This conversation isn’t available"
          description="It may have been deleted, or it belongs to someone else."
          actions={
            <>
              <Button variant="primary" onPress={() => router.push("/chat")}>
                <MessageSquarePlus className="i" aria-hidden />
                New chat
              </Button>
              <Button variant="secondary" onPress={() => router.push("/chats")}>
                Conversations
              </Button>
            </>
          }
        />
      </div>
    );
  }

  const error = conversation.error ?? messages.error;
  const loading = conversation.isPending || (messages.isPending && !live);

  return (
    <div className="split chat-split">
      <PageChrome
        crumbs={conv ? crumbs : [{ label: "Conversations", href: "/chats" }]}
        actions={
          conv ? (
            <>
              <Button variant="ghost" size="sm" onPress={() => setSharing(true)}>
                <Share className="i" aria-hidden />
                Share
              </Button>
              <ConversationMenu conversation={conv} />
            </>
          ) : null
        }
      />
      <div className="split__main chat-main chat-drop" {...drop.dropProps}>
        {drop.overlay}
        <div className="chat-scroll" id="chat-scroll" ref={scroller} onScroll={onScroll}>
          {loading ? (
            <ThreadSkeleton />
          ) : error ? (
            <div className="chat-thread">
              <ErrorState error={error} onRetry={() => void Promise.all([conversation.refetch(), messages.refetch()])} />
            </div>
          ) : (
            <>
              <h1 className="sr-only">{title}</h1>
              <div className="chat-thread">
                {rows.map((row, i) => {
                  if (row.kind === "user") {
                    const stored = row.key !== "live-q" ? messages.data?.find((m) => m.name === row.message) : undefined;
                    return (
                      <UserMessage
                        key={row.key}
                        id={row.key}
                        text={row.text}
                        files={row.files}
                        canEdit={!!stored && !busy}
                        editing={editing === row.key}
                        onEdit={() => setEditing(row.key)}
                        onCancel={() => setEditing(null)}
                        onSave={(text) => void onEditSave(stored, text, i, row.files)}
                      />
                    );
                  }
                  if (row.kind === "unanswered") {
                    return (
                      <div key={row.key} className="chat-stopped">
                        <span>This question wasn’t answered.</span>
                        <Button variant="ghost" size="sm" isDisabled={busy} onPress={() => send({ message: row.text, replaceFromMessage: row.question })}>
                          <RotateCcw className="i" aria-hidden />
                          Answer it now
                        </Button>
                      </div>
                    );
                  }
                  const a = row.answer;
                  return (
                    <Answer
                      key={a.key}
                      answer={a}
                      title={title}
                      showSteps={showSteps}
                      busy={busy}
                      scoped={scoped}
                      activeCite={panel?.kind === "cite" && panel.answer === a.key ? panel.n : null}
                      activeArtifact={panel?.kind === "file" ? panel.artifact : null}
                      onCite={(n, answer) => void openCite(n, answer)}
                      onOpenArtifact={(name) => void openFile(name)}
                      onRetry={(answer, mode) => void onRetry(answer, mode)}
                      onFeedback={(message, rating, reason) => void onFeedback(message, rating, reason)}
                      onFeedbackComment={setCommentFor}
                    />
                  );
                })}
              </div>
            </>
          )}
        </div>
        <div className="chat-dock">
          <div className="chat-dock__inner">
            <Composer
              draft={draft}
              onDraftChange={setDraft}
              attachments={files}
              scope={scope}
              onScopeChange={(next) => void onScopeChange(next)}
              placeholder="Ask a follow-up"
              onSend={onSend}
              streaming={streamingHere}
              onStop={() => stopTurn(id)}
            />
          </div>
        </div>
      </div>
      {panel?.kind === "cite" && panel.sources.length ? (
        <CitationPanel conversation={id} sources={panel.sources} n={panel.n} onShow={(n) => setPanel({ ...panel, n })} onClose={() => void closePanel()} />
      ) : null}
      {panel?.kind === "file" ? <FilePanel key={panel.artifact} artifact={panel.artifact} onClose={() => setPanel(null)} /> : null}
      {conv ? <ShareConversationDialog conversation={id} title={title} isOpen={sharing} onClose={() => setSharing(false)} /> : null}
      <FeedbackDialog
        isOpen={!!commentFor}
        onClose={() => setCommentFor(null)}
        onSubmit={(comment) => (commentFor ? onFeedback(commentFor, "UNHELPFUL", undefined, comment.slice(0, 1000)) : Promise.resolve())}
      />
    </div>
  );
}
