"use client";

import { Plus, RotateCcw } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef } from "react";

import { PageChrome } from "@/components/shell/page-chrome";
import { FileIcon } from "@/components/ui/FileIcon";
import { resourceId } from "@/lib/api/client";
import { rel } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";
import { useComposerFiles } from "@/modules/artifacts";
import { batchGetItems, itemName } from "@/modules/knowledge/api";
import { useItemsByName, useRecentItems } from "@/modules/knowledge/queries";
import { conversationTitle, useRecentConversations, type Conversation } from "@/modules/projects";
import { conversationTime } from "@/modules/projects/conversations";

import type { ConversationScope } from "../api";
import { useAssistant } from "../queries";
import { useStartConversation } from "../useStartConversation";
import { useDraft } from "./Composer";
import { focusComposer, NewChatBox, setHomeStart } from "./NewChatBox";

/**
 * New chat (`/chat`, preview `P.chats`): the composer and its suggestions, what you just read as one-click context, and — when
 * some exist — the conversations whose answers rely on documents that changed since. All your conversations are the sidebar's
 * Recent list.
 *
 * URL entry: `q` drafts the question (`send=1` sends at once), `scope` (collection item IDs, repeatable), `space`
 * (space ID), `doc` (document item IDs, repeatable → attachments) and `project` (project ID).
 */
export function ChatHome() {
  const { id: ws, hasModule } = useWorkspace();
  const assistant = useAssistant();
  const router = useRouter();
  const params = useSearchParams();
  const files = useComposerFiles("home");
  const [, setDraft] = useDraft("home");
  const { start } = useStartConversation();

  /* URL entry: consume once, then clear the address. */
  const consumed = useRef(false);
  useEffect(() => {
    if (consumed.current) return;
    const keys = ["q", "send", "scope", "space", "doc", "project"];
    if (!keys.some((k) => params.has(k))) return;
    consumed.current = true;
    const q = (params.get("q") ?? "").trim();
    const space = params.get("space");
    const scope: ConversationScope =
      space && hasModule("spaces")
        ? { spaces: [`workspaces/${ws}/spaces/${space}`] }
        : params.getAll("scope").length
          ? { collections: params.getAll("scope").map((c) => itemName(ws, c)) }
          : {};
    const docIds = [...new Set(params.getAll("doc").flatMap((d) => d.split(",")).filter(Boolean))].slice(0, 10);
    const project = params.get("project");
    router.replace("/chat");
    void (async () => {
      const loaded = new Map((await batchGetItems(ws, docIds, { view: "FULL" }).catch(() => [])).map((i) => [resourceId(i.name), i]));
      const items = docIds.map((d) => loaded.get(resourceId(d))).filter((i) => !!i && i.itemKind === "DOCUMENT");
      if (q && params.get("send") === "1") {
        await start({
          question: q,
          scope,
          attachments: items.map((i) => i!.name ?? ""),
          files: items.map((i) => ({ name: i!.displayName ?? "", item: i!.name, mime: i!.document?.mimeType })),
          project,
          replaceRunning: true,
        });
        return;
      }
      setHomeStart({ scope, project });
      if (q) setDraft(q);
      if (items.length) files.addRefs(items.map((i) => i!));
      focusComposer();
    })();
  }, [params, router, ws, hasModule, start, setDraft, files]);

  return (
    <div className="chat-canvas">
      {/* The welcome is this page's heading: the top row stays empty. */}
      <PageChrome hero />
      <div className="chat-canvas__inner">
        <h1 className="chat-canvas__title">{assistant.data?.welcomeMessage || "Tôi có thể giúp bạn tìm gì?"}</h1>
        <NewChatBox autoFocus />
        <JustRead />
        <ToReview />
      </div>
    </div>
  );
}

/** What you just read, as one-click context for the next question (preview `chat-ref`). */
function JustRead() {
  const files = useComposerFiles("home");
  const recent = useRecentItems(8);
  const loaded = useItemsByName((recent.data ?? []).map((r) => r.item));
  const attached = new Set(files.files.map((f) => f.item));
  const docs = (recent.data ?? [])
    .map((r) => (r.item ? loaded.items.get(r.item) : undefined))
    .filter((i) => !!i && i.itemKind === "DOCUMENT" && !attached.has(i.name))
    .slice(0, 3);
  if (!docs.length) return null;
  return (
    <div className="chat-context" role="group" aria-label="Hỏi về tài liệu bạn vừa đọc">
      <span className="chat-context__label">Hỏi về tài liệu bạn vừa đọc</span>
      {docs.map((d) => (
        <button
          key={d!.name}
          type="button"
          className="chat-context__doc"
          onClick={() => {
            files.addRefs([d!]);
            focusComposer();
          }}
        >
          <FileIcon size="sm" mime={d!.document?.mimeType} name={d!.document?.fileName ?? d!.displayName} />
          <span className="truncate" title={d!.displayName} translate="no">
            {d!.displayName}
          </span>
          <Plus className="i i-xs" aria-hidden />
        </button>
      ))}
    </div>
  );
}

/** Recent conversations (the sidebar's Recent list, one shared read) whose answers rely on documents that changed since. */
function ToReview() {
  const conversations = useRecentConversations();
  const stale = (conversations.data ?? []).filter((c) => c.outdatedSources?.length).sort((a, b) => conversationTime(b) - conversationTime(a));
  if (!stale.length) return null;
  return (
    <section className="chat-review" aria-labelledby="chat-review-h">
      <h2 className="chat-review__title" id="chat-review-h">
        <RotateCcw className="i i-sm" aria-hidden />
        <span>{stale.length === 1 ? "1 cuộc trò chuyện dựa trên tài liệu đã thay đổi" : `${stale.length} cuộc trò chuyện dựa trên tài liệu đã thay đổi`}</span>
      </h2>
      {stale.slice(0, 3).map((c) => (
        <Link key={c.name} className="chat-review__item" href={`/chat/${resourceId(c.name)}`}>
          <span className="chat-review__name truncate" translate="no">
            {conversationTitle(c)}
          </span>
          <StaleLine conversation={c} />
        </Link>
      ))}
    </section>
  );
}

/** "⟳ {document} changed · when" (preview `staleLine`). */
function StaleLine({ conversation }: { conversation: Conversation }) {
  const sources = conversation.outdatedSources ?? [];
  const first = sources[0];
  if (!first) return null;
  // One text run after the name ("changed · 3 h ago"), so the localizer reads it whole.
  const when = first.updateTime ? ` · ${rel(first.updateTime)}` : "";
  return (
    <span className="conv-stale">
      <RotateCcw className="i i-xs" aria-hidden />
      <span className="truncate">
        {sources.length > 1 ? (
          `${sources.length} nguồn đã thay đổi${when}`
        ) : (
          <>
            <span translate="no">{first.displayName}</span>
            {` đã thay đổi${when}`}
          </>
        )}
      </span>
    </span>
  );
}
