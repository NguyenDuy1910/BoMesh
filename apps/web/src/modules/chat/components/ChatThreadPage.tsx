"use client";

import { ArrowDown, Folder, Link2, MessageSquare, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { Page } from "@/components/shell/Page";
import { useCurrentWorkspace } from "@/components/shell/useCurrentWorkspace";
import { Button, ButtonLink } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { ICON_MENU_TRIGGER } from "./icon-menu-trigger";
import { Menu, MenuItem, MenuSeparator } from "@/components/ui/Menu";
import { Skeleton } from "@/components/ui/Skeleton";
import { Tooltip } from "@/components/ui/Tooltip";
import { usePendingFeature } from "@/lib/api/pending";
import { getApiConfiguration } from "@/lib/api/config";
import { cn } from "@/lib/cn";
import { useAccountPreferences } from "@/lib/hooks/useAccountPreferences";
import { useModalLayer } from "@/lib/hooks/useModalLayer";
import { documentHref } from "@/modules/knowledge/preview";
import { turnArtifacts } from "../artifacts";
import {
  answerQuestion,
  editQuestion,
  loadThread,
  sendQuestion,
  setConversationScope,
  stopAnswer,
} from "../chat-runtime";
import { editTruncation } from "../conversation-history";
import { useArtifactTitles } from "../hooks/useArtifactTitles";
import { useComposerAttachments } from "../hooks/useComposerAttachments";
import { useDocumentAccess } from "../hooks/useDocumentAccess";
import { useJumpToLatest } from "../hooks/useJumpToLatest";
import { useReadableCollections } from "../hooks/useReadableCollections";
import { useThread } from "../hooks/useThread";
import { isSamePanel, type ChatPanel } from "../panel";
import { answerSources, type AnswerSource } from "../sources";
import type { ChatMessage, ConversationCollection } from "../types";
import { plural } from "../work";
import { AssistantAnswer } from "./AssistantAnswer";
import { DeleteChatDialog, RenameChatDialog } from "./ChatDialogs";
import { Composer } from "./Composer";
import { FileDropZone } from "./FileDropZone";
import { conversationFiles, FilePanel, FilesInChatPanel, type ConversationFile } from "./files";
import { ShareDialog } from "./ShareDialog";
import { SourcesPanel } from "./SourcesPanel";
import { UserMessage } from "./UserMessage";

const STICK_THRESHOLD_PX = 80;

/** `/chat/[conversationId]` — one chat: header, thread, composer and one side panel. */
export function ChatThreadPage({ conversationId }: { conversationId: string }) {
  const router = useRouter();
  const thread = useThread(conversationId);
  const { workspace } = useCurrentWorkspace();
  const { preferences } = useAccountPreferences();
  const shareEnabled = usePendingFeature("chat.share");
  const { collections, loading: collectionsLoading } = useReadableCollections();
  const attachments = useComposerAttachments();
  const [draft, setDraft] = useState("");
  const [panel, setPanel] = useState<ChatPanel | null>(null);
  const [dialog, setDialog] = useState<"rename" | "delete" | "share" | null>(null);
  const [pendingEdit, setPendingEdit] = useState<{ messageId: string; text: string; dropped: number } | null>(null);
  const [configured, setConfigured] = useState(true);
  const [scrolled, setScrolled] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stackRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const stick = useRef(true);

  useEffect(() => {
    setConfigured(Boolean(getApiConfiguration()));
  }, []);

  const messages = thread.messages;
  const streaming = thread.streamingId !== null;
  const conversation = thread.conversation;
  const title = conversation?.title ?? "Chat";
  const readableIds = useMemo(() => new Set(collections.map((collection) => collection.id)), [collections]);
  const scope: ConversationCollection[] = useMemo(() => {
    const stored = conversation?.scope ?? [];
    return collectionsLoading ? stored : stored.filter((collection) => readableIds.has(collection.id));
  }, [collectionsLoading, conversation?.scope, readableIds]);

  // Every cited document and every document referenced from knowledge is
  // re-checked, so a saved chat never shows what its reader can't open now.
  const checkedIds = useMemo(() => messages.flatMap((message) => message.role === "assistant"
    ? answerSources(message.turn).map((source) => source.itemId)
    : message.parts.flatMap((part) => part.type === "data-document" && part.data.origin === "reference" ? [part.data.id] : [])), [messages]);
  const access = useDocumentAccess(checkedIds);
  const titled = useArtifactTitles();
  const files = useMemo(() => conversationFiles(messages).map((file) => (
    file.kind === "made" ? { ...file, artifact: titled(file.artifact) } : file
  )), [messages, titled]);

  // Follow the answer while the reader is at the bottom; leave them where
  // they are once they scroll up.
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller || !stick.current) return;
    scroller.scrollTop = scroller.scrollHeight;
  }, [messages, thread.status]);
  const { hasMoreBelow, jumpToLatest } = useJumpToLatest(scrollRef, stackRef);

  // A newer version of the open file arrives with the next answer: show it.
  const latestRevision = useMemo(() => {
    if (panel?.kind !== "file") return undefined;
    let latest = 0;
    for (const message of messages) {
      for (const artifact of turnArtifacts(message.turn)) {
        if (artifact.id === panel.artifactId) latest = Math.max(latest, artifact.revision);
      }
    }
    return latest || undefined;
  }, [messages, panel]);
  const seenRevision = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (panel?.kind !== "file" || !latestRevision) return;
    if (seenRevision.current !== undefined && latestRevision > seenRevision.current) {
      setPanel({ kind: "file", artifactId: panel.artifactId, revision: latestRevision });
    }
    seenRevision.current = latestRevision;
  }, [latestRevision, panel]);

  // A file with unsaved hand edits is never replaced or closed silently.
  const fileDirty = useRef(false);
  const shownPanel = useRef<ChatPanel | null>(null);
  shownPanel.current = panel;
  const [discardFor, setDiscardFor] = useState<{ next: ChatPanel | null } | null>(null);
  const changePanel = useCallback((next: ChatPanel | null) => {
    const current = shownPanel.current;
    if (next && isSamePanel(current, next)) return;
    if (current?.kind === "file" && fileDirty.current) {
      setDiscardFor({ next });
      return;
    }
    setPanel(next);
  }, []);
  const onFileDirtyChange = useCallback((dirty: boolean) => {
    fileDirty.current = dirty;
  }, []);
  const closePanel = useCallback(() => changePanel(null), [changePanel]);
  useModalLayer({ open: panel !== null && discardFor === null, onClose: closePanel, panelRef, modal: false, initialFocusRef: false });

  const openPanel = changePanel;
  const openSources = useCallback((messageId: string, source?: AnswerSource) => {
    openPanel({ kind: "sources", messageId, sourceId: source?.id, chunkId: source?.chunkId });
  }, [openPanel]);
  const openFile = useCallback((artifactId: string, revision?: number) => {
    seenRevision.current = undefined;
    openPanel({ kind: "file", artifactId, revision });
  }, [openPanel]);
  const share = useCallback(() => setDialog("share"), []);

  const submit = () => {
    const text = draft.trim();
    if (!text || streaming) return;
    stick.current = true;
    sendQuestion(conversationId, { text, documents: attachments.readyDocuments, collections: scope });
    attachments.clear();
    setDraft("");
  };

  const requestEdit = useCallback((messageId: string, text: string) => {
    const truncation = editTruncation(thread.messages, messageId);
    if (!truncation) return;
    if (truncation.dropped > 0) {
      setPendingEdit({ messageId, text, dropped: truncation.dropped });
      return;
    }
    stick.current = true;
    editQuestion(conversationId, messageId, text);
  }, [conversationId, thread.messages]);

  if (thread.status === "loading") return <ThreadSkeleton />;
  if (thread.status === "error") {
    return (
      <Page width="bare">
        <div className="mx-auto w-full max-w-(--chat-max) px-7 pt-16">
          <ErrorState description="This chat couldn’t be read from this browser." onAction={() => void loadThread(conversationId, { force: true })} />
        </div>
      </Page>
    );
  }
  if (thread.status === "missing") {
    return (
      <Page width="bare">
        <div className="mx-auto w-full max-w-(--chat-max) px-7 pt-16">
          <EmptyState
            action={(
              <div className="flex gap-2">
                <ButtonLink href="/chat" icon={<Plus aria-hidden="true" />} variant="primary">New chat</ButtonLink>
                <ButtonLink href="/chats" variant="secondary">All chats</ButtonLink>
              </div>
            )}
            description="It may have been deleted. Chats are kept in the browser where they were started, so a chat from another device or browser won’t open here."
            icon={<MessageSquare aria-hidden="true" />}
            title="This chat isn’t available"
          />
        </div>
      </Page>
    );
  }

  const lastMessage = messages.at(-1);
  const unanswered = !streaming && lastMessage?.role === "user" ? lastMessage : null;
  const panelMessage = panel?.kind === "sources" ? messages.find((message) => message.id === panel.messageId) : undefined;
  const panelSources = panelMessage
    ? answerSources(panelMessage.turn).filter((source) => access.get(source.itemId) !== "unreadable")
    : [];

  return (
    <Page className="overflow-hidden" width="bare">
      <div className="relative flex min-h-0 flex-1">
        <FileDropZone className="flex min-w-0 flex-1 flex-col" disabled={!configured} onFiles={(dropped) => void attachments.addFiles(dropped)}>
          <header className={cn(
            "flex h-[52px] shrink-0 items-center gap-2 border-b px-3.5 transition-colors duration-(--duration-fast)",
            scrolled ? "border-border-subtle" : "border-transparent",
          )}>
            <Tooltip label="Rename">
              <button
                aria-label={`Rename chat: ${title}`}
                className="inline-flex h-8 min-w-0 max-w-full items-center gap-2 rounded-md px-2 text-section font-semibold text-text-primary hover:bg-surface-hover focus-visible:shadow-(--shadow-focus) focus-visible:outline-none [&>svg]:opacity-0 hover:[&>svg]:opacity-100 focus-visible:[&>svg]:opacity-100"
                onClick={() => setDialog("rename")}
                type="button"
              >
                <h1 className="truncate">{title}</h1>
                <Pencil aria-hidden="true" className="shrink-0 text-text-tertiary" size={13} />
              </button>
            </Tooltip>
            <span className="flex-1" />
            {shareEnabled && (
              <Button icon={<Link2 aria-hidden="true" />} onClick={share} size="sm" variant="ghost">Share</Button>
            )}
            {files.length > 0 && (
              <Button
                aria-pressed={panel?.kind === "files"}
                icon={<Folder aria-hidden="true" />}
                onClick={() => changePanel(panel?.kind === "files" ? null : { kind: "files" })}
                size="sm"
                variant="ghost"
              >
                Files · {files.length}
              </Button>
            )}
            <Menu align="end" ariaLabel="More chat actions" label={<MoreHorizontal aria-hidden="true" />} showChevron={false} tooltip="More" triggerClassName={ICON_MENU_TRIGGER}>
              <MenuItem icon={<Pencil />} onSelect={() => setDialog("rename")}>Rename</MenuItem>
              {shareEnabled && <MenuItem icon={<Link2 />} onSelect={share}>Share chat</MenuItem>}
              <MenuSeparator />
              <MenuItem danger icon={<Trash2 />} onSelect={() => setDialog("delete")}>Delete chat</MenuItem>
            </Menu>
          </header>

          <div
            className="min-h-0 flex-1 overflow-y-auto"
            onScroll={(event) => {
              const scroller = event.currentTarget;
              stick.current = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < STICK_THRESHOLD_PX;
              setScrolled(scroller.scrollTop > 4);
            }}
            ref={scrollRef}
          >
            <div className="mx-auto flex max-w-(--chat-max) flex-col gap-7 px-7 pb-10 pt-3 max-[640px]:px-4" ref={stackRef}>
              {messages.map((message, index) => message.role === "user" ? (
                <UserMessage access={access} canEdit={!streaming} key={message.id} message={message} onEdit={requestEdit} />
              ) : (
                <div className="text-reading text-text-primary" data-chat-role="assistant" id={`message-${message.id}`} key={message.id}>
                  <AssistantAnswer
                    access={access}
                    busy={streaming}
                    conversationId={conversationId}
                    message={message}
                    onCloseSources={closePanel}
                    onOpenFile={openFile}
                    onOpenSources={openSources}
                    onShare={share}
                    panel={panel}
                    question={previousQuestion(messages, index)}
                    scopeTitles={scopeTitlesOf(previousQuestion(messages, index))}
                    shareEnabled={shareEnabled}
                    showWork={preferences.showAgentActivity}
                    streaming={thread.streamingId === message.id}
                  />
                </div>
              ))}
              {unanswered && (
                <Callout
                  actions={<Button onClick={() => answerQuestion(conversationId, unanswered.id)} size="sm" variant="secondary">Answer it now</Button>}
                  title="This question wasn’t answered"
                  tone="neutral"
                >
                  The page closed before the answer started.
                </Callout>
              )}
            </div>
          </div>

          {hasMoreBelow && (
            <Tooltip label="Jump to latest">
              <button
                aria-label="Jump to latest"
                className="absolute bottom-[132px] left-1/2 z-10 grid size-9 -translate-x-1/2 place-items-center rounded-full border border-border-default bg-surface-raised text-text-secondary shadow-(--shadow-2) hover:text-text-primary focus-visible:shadow-(--shadow-focus) focus-visible:outline-none"
                onClick={() => {
                  stick.current = true;
                  jumpToLatest();
                }}
                type="button"
              >
                <ArrowDown aria-hidden="true" size={16} />
              </button>
            </Tooltip>
          )}

          <div className="shrink-0 px-7 pb-[18px] max-[640px]:px-4">
            <Composer
              attachments={attachments.attachments}
              attachmentsBusy={attachments.busy}
              collections={collections}
              collectionsLoading={collectionsLoading}
              enterToSend={preferences.enterToSend}
              onAddFiles={attachments.addFiles}
              onAddReferences={attachments.addReferences}
              onChange={setDraft}
              onRemoveAttachment={attachments.remove}
              onScopeChange={(next) => void setConversationScope(conversationId, next)}
              onStop={() => stopAnswer(conversationId)}
              onSubmit={submit}
              placeholder="Ask a follow-up"
              scope={scope}
              streaming={streaming}
              textareaRef={textareaRef}
              unavailable={!configured}
              value={draft}
            />
          </div>
        </FileDropZone>

        {panel && (
          <div
            className="flex min-h-0 shrink-0 max-[1100px]:absolute max-[1100px]:inset-y-0 max-[1100px]:right-0 max-[1100px]:z-20 max-[1100px]:max-w-[96%] max-[1100px]:shadow-(--shadow-modal) motion-safe:animate-ui-slide-in"
            ref={panelRef}
          >
            {panel.kind === "sources" ? (
              <SourcesPanel
                activeChunkId={panel.chunkId}
                activeSourceId={panel.sourceId}
                onClose={closePanel}
                onSelect={(source, chunkId) => openPanel({ kind: "sources", messageId: panel.messageId, sourceId: source.id, chunkId })}
                sources={panelSources}
              />
            ) : panel.kind === "file" ? (
              <FilePanel
                artifactId={panel.artifactId}
                conversationId={conversationId}
                key={panel.artifactId}
                onAskForChanges={(artifact, instruction) => {
                  stick.current = true;
                  sendQuestion(conversationId, {
                    text: `Update "${artifact.title}": ${instruction}`,
                    documents: [],
                    collections: scope,
                  });
                }}
                // The panel's own close button already asked about unsaved edits.
                onClose={() => {
                  fileDirty.current = false;
                  setPanel(null);
                }}
                onDirtyChange={onFileDirtyChange}
                revision={panel.revision}
                working={streaming}
              />
            ) : (
              <FilesInChatPanel
                files={files}
                onClose={closePanel}
                onOpen={(file: ConversationFile) => {
                  if (file.kind === "made") openFile(file.artifact.id, file.artifact.revision);
                  else router.push(documentHref(file.document.id));
                }}
              />
            )}
          </div>
        )}
      </div>

      {conversation && (
        <>
          <RenameChatDialog conversationId={conversationId} onClose={() => setDialog(null)} open={dialog === "rename"} title={title} />
          <DeleteChatDialog
            conversationId={conversationId}
            onClose={() => setDialog(null)}
            onDeleted={() => router.replace("/chat")}
            open={dialog === "delete"}
            title={title}
          />
          {shareEnabled && (
            <ShareDialog
              conversationId={conversationId}
              messages={messages}
              onClose={() => setDialog(null)}
              open={dialog === "share"}
              title={title}
              workspaceName={workspace?.name ?? "this workspace"}
            />
          )}
        </>
      )}
      <ConfirmDialog
        confirmLabel="Discard changes"
        description="Your edits to this file haven’t been saved as a version."
        onClose={() => setDiscardFor(null)}
        onConfirm={() => {
          if (!discardFor) return;
          fileDirty.current = false;
          setPanel(discardFor.next);
        }}
        open={discardFor !== null}
        title="Discard your changes?"
      />
      <ConfirmDialog
        confirmLabel="Edit and resend"
        description={pendingEdit ? `The ${plural(pendingEdit.dropped, "later message")} in this chat will be removed, and the answer below your question will be replaced.` : ""}
        onClose={() => setPendingEdit(null)}
        onConfirm={() => {
          if (!pendingEdit) return;
          stick.current = true;
          editQuestion(conversationId, pendingEdit.messageId, pendingEdit.text);
        }}
        open={pendingEdit !== null}
        title="Edit and resend?"
      />
    </Page>
  );
}

function previousQuestion(messages: ChatMessage[], index: number): ChatMessage | undefined {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    if (messages[cursor]?.role === "user") return messages[cursor];
  }
  return undefined;
}

function scopeTitlesOf(question: ChatMessage | undefined): string[] {
  return question?.parts.flatMap((part) => part.type === "data-collection" ? [part.data.title] : []) ?? [];
}

/** The thread's loading state: two question bubbles and answer lines. */
function ThreadSkeleton() {
  return (
    <Page width="bare">
      <div aria-busy="true" aria-label="Loading chat" className="mx-auto flex w-full max-w-(--chat-max) flex-col gap-7 px-7 pt-[64px]" role="status">
        {[300, 220].map((width) => (
          <div className="flex flex-col gap-7" key={width}>
            <div className="flex justify-end"><Skeleton className="h-[42px] rounded-[18px]" style={{ width }} /></div>
            <div className="flex flex-col gap-2">
              <Skeleton className="h-2.5 w-2/5" />
              <Skeleton className="h-3 w-[96%]" />
              <Skeleton className="h-3 w-[88%]" />
              <Skeleton className="h-3 w-[72%]" />
            </div>
          </div>
        ))}
      </div>
    </Page>
  );
}
