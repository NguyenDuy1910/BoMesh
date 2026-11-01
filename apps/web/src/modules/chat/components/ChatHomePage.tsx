"use client";

import { FileText, List, Users, type LucideIcon } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { Page } from "@/components/shell/Page";
import { useCurrentWorkspace } from "@/components/shell/useCurrentWorkspace";
import { Skeleton } from "@/components/ui/Skeleton";
import { useToast } from "@/components/ui/Toast";
import { getApiConfiguration } from "@/lib/api/config";
import { useAccountPreferences } from "@/lib/hooks/useAccountPreferences";
import { getKnowledgeDocument } from "../api";
import { startConversation } from "../chat-runtime";
import { useComposerAttachments } from "../hooks/useComposerAttachments";
import { useHomeContent } from "../hooks/useHomeContent";
import { useReadableCollections } from "../hooks/useReadableCollections";
import type { ConversationCollection } from "../types";
import { Composer } from "./Composer";
import { FileDropZone } from "./FileDropZone";

const STARTER_ICONS: LucideIcon[] = [FileText, List, Users];

/**
 * `/chat` — the welcome, the composer and up to three starters. Deep links:
 * `?q=` drafts a question (`&send=1` sends it), `?scope=<collection_id[,…]>`
 * searches those knowledge bases, `?doc=<document_id>` adds a document from
 * knowledge, and `?action=new` starts from a clean composer.
 */
export function ChatHomePage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const toast = useToast();
  const { workspace } = useCurrentWorkspace();
  const { preferences } = useAccountPreferences();
  const { content, loading: contentLoading } = useHomeContent(workspace?.id);
  const { collections, loading: collectionsLoading } = useReadableCollections();
  const attachments = useComposerAttachments();
  const [draft, setDraft] = useState("");
  const [scope, setScope] = useState<ConversationCollection[]>([]);
  const [sending, setSending] = useState(false);
  const [configured, setConfigured] = useState(true);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const pendingSend = useRef<string | null>(null);
  const pendingScope = useRef<string[] | null>(null);

  useEffect(() => {
    setConfigured(Boolean(getApiConfiguration()));
  }, []);

  const send = useCallback(async (text: string, sendScope: ConversationCollection[]) => {
    const question = text.trim();
    if (!question || sending || attachments.busy) return;
    setSending(true);
    try {
      const id = await startConversation({ text: question, documents: attachments.readyDocuments, scope: sendScope });
      attachments.clear();
      setDraft("");
      router.push(`/chat/${encodeURIComponent(id)}`);
    } catch {
      toast.show({ tone: "err", message: "Your question couldn’t be sent. Try again." });
      setSending(false);
    }
  }, [attachments, router, sending, toast]);

  // Deep links are consumed once, then the address returns to /chat.
  const consumedKey = useRef<string | null>(null);
  useEffect(() => {
    const key = searchParams.toString();
    if (!key) {
      consumedKey.current = null;
      return;
    }
    if (consumedKey.current === key) return;
    consumedKey.current = key;
    const action = searchParams.get("action");
    const query = searchParams.get("q");
    const scopeIds = (searchParams.get("scope") ?? "").split(",").map((value) => value.trim()).filter(Boolean);
    const documentId = searchParams.get("doc");
    if (action === "new") {
      attachments.clear();
      setDraft("");
      setScope([]);
    }
    if (query !== null) setDraft(query);
    if (scopeIds.length) pendingScope.current = scopeIds;
    if (documentId) {
      void getKnowledgeDocument(documentId)
        .then((document) => attachments.addReferences([{
          id: document.id,
          name: document.name,
          contentType: document.content_type,
          sizeBytes: document.size_bytes,
        }]))
        .catch(() => toast.show({ tone: "err", message: "That document couldn’t be added. It may have moved, or you may not have access." }));
    }
    if (searchParams.get("send") === "1" && query?.trim()) pendingSend.current = query;
    router.replace("/chat", { scroll: false });
    window.requestAnimationFrame(() => textareaRef.current?.focus({ preventScroll: true }));
  }, [attachments, router, searchParams, toast]);

  // A linked scope is applied only to knowledge bases the caller can read.
  useEffect(() => {
    if (collectionsLoading) return;
    const ids = pendingScope.current;
    let resolved = scope;
    if (ids) {
      pendingScope.current = null;
      resolved = collections
        .filter((collection) => ids.includes(collection.id))
        .map((collection) => ({ id: collection.id, title: collection.title }));
      setScope(resolved);
    }
    const queued = pendingSend.current;
    if (queued) {
      pendingSend.current = null;
      void send(queued, resolved);
    }
  }, [collections, collectionsLoading, scope, send]);

  return (
    <Page className="overflow-hidden" width="bare">
      <FileDropZone className="flex min-h-0 flex-1 flex-col" disabled={!configured} onFiles={(files) => void attachments.addFiles(files)}>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-(--chat-max) px-7 pb-6 pt-[12vh] max-[640px]:px-4">
            {contentLoading ? (
              <Skeleton className="h-8 w-[320px]" />
            ) : (
              <h1 className="text-display font-semibold tracking-[-0.02em] text-text-primary">{content.welcome}</h1>
            )}
            <div className="mt-[22px]">
              <Composer
                attachments={attachments.attachments}
                attachmentsBusy={attachments.busy || sending}
                collections={collections}
                collectionsLoading={collectionsLoading}
                enterToSend={preferences.enterToSend}
                onAddFiles={attachments.addFiles}
                onAddReferences={attachments.addReferences}
                onChange={setDraft}
                onRemoveAttachment={attachments.remove}
                onScopeChange={setScope}
                onStop={() => undefined}
                onSubmit={() => void send(draft, scope)}
                placeholder="Ask anything about your company knowledge"
                scope={scope}
                streaming={false}
                textareaRef={textareaRef}
                tourAnchors
                unavailable={!configured}
                value={draft}
              />
            </div>
            {!contentLoading && content.starters.length > 0 && (
              <ul aria-label="Starter questions" className="mt-5 grid grid-cols-3 gap-2.5 max-[1100px]:grid-cols-1" data-tour="starters">
                {content.starters.map((starter, index) => {
                  const Icon = STARTER_ICONS[index % STARTER_ICONS.length]!;
                  return (
                    <li key={`${starter.title}:${index}`}>
                      <button
                        className="flex h-full w-full flex-col gap-2 rounded-lg border border-border-subtle bg-surface-base p-3.5 text-left transition-[border-color,box-shadow] duration-(--duration-fast) hover:border-border-default hover:shadow-(--shadow-2) focus-visible:shadow-(--shadow-focus) focus-visible:outline-none disabled:opacity-45"
                        disabled={!configured || sending}
                        onClick={() => void send(starter.prompt, scope)}
                        type="button"
                      >
                        <span className="flex items-center gap-2">
                          <Icon aria-hidden="true" className="text-text-tertiary" size={16} />
                          <span className="font-medium text-text-primary">{starter.title}</span>
                        </span>
                        <span className="text-[0.84375rem] leading-[1.45] text-text-tertiary">{starter.prompt}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      </FileDropZone>
    </Page>
  );
}
