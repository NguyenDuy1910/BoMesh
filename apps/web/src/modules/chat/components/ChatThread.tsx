"use client";

import { Button, Skeleton, Tooltip } from "@heroui/react";
import { useQueryClient } from "@tanstack/react-query";
import { MessageSquare, RotateCcw, Share, Users, X } from "lucide-react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { useShowWorkSteps } from "@/components/shell/preferences";
import { PageChrome, type Crumb } from "@/components/shell/page-chrome";
import { confirm } from "@/components/ui/Confirm";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { FileIcon } from "@/components/ui/FileIcon";
import { Tip } from "@/components/ui/Tip";
import { toast } from "@/components/ui/Toast";
import { ApiError, errorMessage, resourceId } from "@/lib/api/client";
import { useOpened } from "@/lib/lazy";
import { useWorkspace } from "@/lib/workspace";
import { askForChanges, confirmLeaveFileEdit, fileNameOf, fileViewOf, revisionNumber, useArtifact, useComposerFiles, useFileDrop, useRevising, type Artifact } from "@/modules/artifacts";
import { isSheetView } from "@/modules/artifacts/model";
import { openDocumentPreview } from "@/modules/knowledge/preview/store";
import { ConversationMenu, useConversationProject } from "@/modules/projects";
import { useMySpaces } from "@/modules/spaces";

import { chatKeys, submitFeedback, updateConversation, type ConversationScope, type Message } from "../api";
import { useConversation, useMessages, useShareSummary } from "../queries";
import { dismissTurn, sendTurn, sentFiles, stopTurn, useLiveTurn, useStreamingConversation, type AnswerAttempt, type SentFile } from "../runtime";
import { buildThread, RETRY_MODIFIER, type AnswerView } from "../thread";
import { Composer, useDraft } from "./Composer";
import { Answer, UserMessage, type RetryMode } from "./ThreadMessages";

/* The file panel and dialogs load on first open; the thread's first paint needs none of them. */
const FilePanel = dynamic(() => import("@/modules/artifacts/components/FilePanel").then((m) => m.FilePanel), { ssr: false });
const FeedbackDialog = dynamic(() => import("./FeedbackDialog").then((m) => m.FeedbackDialog), { ssr: false });
const ShareConversationDialog = dynamic(() => import("./ShareConversationDialog").then((m) => m.ShareConversationDialog), { ssr: false });
const ProjectDialogs = dynamic(() => import("@/modules/projects/components/ProjectDialogs").then((m) => m.ProjectDialogs), { ssr: false });

/**
 * The side panel is only ever a generated file: citations open the shared document preview. While it is open the
 * thread composer edits that file, unless its "Editing" chip was removed (`ctxOff`).
 */
type Panel = { kind: "file"; artifact: string; ctxOff?: boolean };

/** Suggested changes for the open file (preview `quickAsks`). */
const QUICK_SHEET = ["Sort by largest amount", "Add a total row", "Add a status column"];
const QUICK_DOC = ["Make it shorter", "More formal tone", "Add an at-a-glance table"];

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
 * composer, and the side panel (a generated file).
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
  const sharingOpened = useOpened(sharing);
  const feedbackOpened = useOpened(commentFor != null);
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
  const shareSummary = useShareSummary(id, { enabled: !!conv });

  /* The file the composer edits: the open panel's file, unless its chip was removed (preview `editTarget`). */
  const target = useArtifact(panel && !panel.ctxOff ? panel.artifact : null).data ?? null;
  const revising = useRevising(target?.name ?? "");
  const askChanges = (instructions: string, file: Artifact) => {
    if (revising) {
      toast(`Wait for version ${revising} of ${fileNameOf(file)} to finish.`, { tone: "accent" });
      return false;
    }
    void askForChanges(queryClient, {
      workspace: ws,
      artifact: file.name ?? "",
      title: fileNameOf(file),
      etag: file.etag,
      instructions,
      nextVersion: revisionNumber(file.revision) + 1,
    });
    return true;
  };

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
    const sent = target ? askChanges(message, target) : send({ message, attachments: files.attachments, files: sentFiles(files.files) });
    if (sent) {
      setDraft("");
      if (!target) files.clear();
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
  /** A citation opens the shared document preview on the cited passage (preview `chat.js` → `X.preview.open`). */
  const openCite = async (n: number, answer: AnswerView) => {
    const sources = answer.sources.filter((s) => s.available);
    if (!sources.length) return;
    openDocumentPreview({
      from: id,
      n,
      citations: sources.flatMap((s) =>
        s.passages.length
          ? s.passages.map((pg) => ({ item: s.item, passage: pg.passage, excerpt: pg.excerpt, page: pg.page ?? undefined, n: s.n }))
          : [{ item: s.item, n: s.n }],
      ),
    });
  };
  const openFile = async (artifact: string) => {
    if (panel?.kind === "file" && panel.artifact !== artifact && !(await confirmLeaveFileEdit())) return;
    setPanel({ kind: "file", artifact, ctxOff: panel?.artifact === artifact ? panel.ctxOff : false });
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

  /* ─── Chrome: the title is the top row's H1, Share and ⋯ its actions; the thread starts right under it. ─── */
  const space = scope.spaces?.[0] ? ((spaces.data ?? []).find((s) => s.name === scope.spaces![0]) ?? null) : null;
  const crumbs: Crumb[] = space
    ? [{ label: "Spaces", href: "/spaces" }, { label: space.displayName, href: `/space/${resourceId(space.name)}` }]
    : project
      ? [{ label: "Projects", href: "/projects" }, { label: project.displayName, href: `/project/${project.id}` }]
      : [{ label: "AI Chat", href: "/chat" }];

  const unavailable = conversation.error instanceof ApiError && conversation.error.isNotFound;
  if (unavailable || conv?.deleteTime) {
    return (
      <div className="page">
        <PageChrome title="Not found" crumbs={[{ label: "AI Chat", href: "/chat" }]} />
        <EmptyState
          icon={MessageSquare}
          title="This conversation isn’t available"
          description="It may have been deleted, or it belongs to someone else."
          actions={
            <Button variant="primary" onPress={() => router.push("/chat")}>
              <MessageSquare className="i" aria-hidden />
              Go to AI Chat
            </Button>
          }
        />
      </div>
    );
  }

  const error = conversation.error ?? messages.error;
  const loading = conversation.isPending || (messages.isPending && !live);
  const shareButton = (
    <Button variant="ghost" size="sm" onPress={() => setSharing(true)}>
      {shareSummary ? <Users className="i" aria-hidden /> : <Share className="i" aria-hidden />}
      {shareSummary ? "Shared" : "Share"}
    </Button>
  );

  /* Editing a file: an "Editing …" chip (removable) in the composer and quick changes above it (preview `ctxChip`, `quickAsks`). */
  const targetName = target ? fileNameOf(target) : "";
  const editingChip = target ? (
    <Tip content="Your message asks for changes to this file">
      <span className="wk-chip wk-chip--ctx">
        <FileIcon size="sm" mime={target.mimeType} name={targetName} />
        <span className="wk-chip__meta">Editing</span>
        <span className="wk-chip__name truncate" translate="no">
          {targetName}
        </span>
        <Tooltip>
          <button type="button" className="wk-chip__x" aria-label={`Stop editing ${targetName}`} onClick={() => setPanel((p) => (p ? { ...p, ctxOff: true } : p))}>
            <X className="i i-xs" aria-hidden />
          </button>
          <Tooltip.Content>Ask about something else</Tooltip.Content>
        </Tooltip>
      </span>
    </Tip>
  ) : null;
  const quick = target && !streamingHere ? (isSheetView(fileViewOf(target.mimeType)) ? QUICK_SHEET : QUICK_DOC) : [];

  return (
    <div className="split chat-split">
      <PageChrome
        title={conv ? title : undefined}
        crumbs={crumbs}
        actions={
          conv ? (
            <span className="chat-top-actions">
              {shareSummary ? (
                <Tooltip>
                  {shareButton}
                  <Tooltip.Content>{shareSummary}</Tooltip.Content>
                </Tooltip>
              ) : (
                shareButton
              )}
              <ConversationMenu conversation={conv} />
            </span>
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
                      activeCite={null}
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
            {quick.length && target ? (
              <div className="wk-quick" role="group" aria-label={`Suggested changes to ${targetName}`}>
                {quick.map((q) => (
                  <Button key={q} variant="tertiary" size="sm" onPress={() => askChanges(q, target)}>
                    {q}
                  </Button>
                ))}
              </div>
            ) : null}
            <Composer
              draft={draft}
              onDraftChange={setDraft}
              attachments={files}
              scope={scope}
              onScopeChange={(next) => void onScopeChange(next)}
              placeholder={target ? `Ask for changes to ${targetName}` : "Ask a follow-up"}
              onSend={onSend}
              streaming={streamingHere}
              onStop={() => stopTurn(id)}
              chips={editingChip}
              hideScope={!!target}
            />
          </div>
        </div>
      </div>
      {panel?.kind === "file" ? <FilePanel key={panel.artifact} artifact={panel.artifact} onClose={() => setPanel(null)} /> : null}
      {conv && sharingOpened ? (
        <ShareConversationDialog
          conversation={id}
          title={title}
          questions={rows.filter((r) => r.kind === "user").length}
          updated={conv.lastMessageTime || conv.updateTime}
          isOpen={sharing}
          onClose={() => setSharing(false)}
        />
      ) : null}
      <ProjectDialogs />
      {feedbackOpened ? (
        <FeedbackDialog
          isOpen={!!commentFor}
          question={rows.flatMap((r) => (r.kind === "answer" && r.answer.message === commentFor ? [r.answer.questionText] : []))[0]}
          onClose={() => setCommentFor(null)}
          onSubmit={(comment) => (commentFor ? onFeedback(commentFor, "UNHELPFUL", undefined, comment) : Promise.resolve())}
        />
      ) : null}
    </div>
  );
}
