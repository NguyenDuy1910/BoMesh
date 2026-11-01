/**
 * Local implementation of `chat.share` (proposed
 * `POST /conversations/{conversation_id}/shares`,
 * `GET /conversations/{conversation_id}/shares`,
 * `DELETE /conversations/{conversation_id}/shares/{share_id}`).
 *
 * Conversations live on the device that had them, so a share carries a
 * snapshot of the messages for the server to keep. Here the share and its
 * snapshot stay in this browser, in the owner's account/workspace store — the
 * store namespace is the ownership check — and the `/s/<id>` link opens only
 * where it was made.
 */
import { ApiError, apiRequest } from "@/lib/api/request";
import { pendingCaller, pendingStore, requirePendingPermission } from "@/lib/api/pending";
import type {
  ConversationShare,
  ConversationShareCreate,
  ConversationShareSnapshot,
  SharedConversation,
  SharedConversationSource,
} from "@/modules/chat/api";

const MESSAGE_LIMIT = 500;
const TITLE_MAX = 512;
/** The server resolves each address to a member of the workspace; here only the shape is checked. */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface StoredShare extends ConversationShare {
  snapshot: ConversationShareSnapshot;
}

function sharesStore() {
  const caller = pendingCaller();
  requirePendingPermission(caller, null, "");
  return {
    caller,
    store: pendingStore<StoredShare[]>("chat.share", caller.accountId, caller.workspaceId, () => []),
  };
}

const toShare = ({ snapshot: _snapshot, ...share }: StoredShare): ConversationShare => share;

export function createConversationShare(conversationId: string, body: ConversationShareCreate): ConversationShare {
  const { caller, store } = sharesStore();
  if (body.audience !== "workspace" && body.audience !== "people") {
    throw new ApiError("Choose who can open the link.", 422);
  }
  const emails = [...new Set((body.emails ?? []).map((email) => email.trim().toLowerCase()).filter(Boolean))];
  if (body.audience === "people" && emails.length === 0) throw new ApiError("Add at least one person.", 422);
  const invalid = emails.filter((email) => !EMAIL_PATTERN.test(email));
  if (invalid.length) throw new ApiError(`These aren't email addresses: ${invalid.join(", ")}.`, 422);
  const title = body.snapshot.title.trim();
  if (!title || title.length > TITLE_MAX) throw new ApiError("Give the conversation a title before sharing it.", 422);
  const messages = body.snapshot.messages.filter((message) => message.content.trim());
  if (messages.length === 0) throw new ApiError("There's nothing to share in this conversation yet.", 422);
  if (messages.length > MESSAGE_LIMIT) throw new ApiError(`Share conversations of up to ${MESSAGE_LIMIT} messages.`, 422);

  const id = crypto.randomUUID();
  const share: StoredShare = {
    id,
    conversation_id: conversationId,
    audience: body.audience,
    emails: body.audience === "people" ? emails : [],
    url: `/s/${id}`,
    message_count: messages.length,
    created_at: new Date().toISOString(),
    created_by: { id: caller.accountId!, display_name: caller.displayName ?? caller.email },
    revoked_at: null,
    snapshot: { title, messages },
  };
  store.update((current) => [...current, share]);
  return toShare(share);
}

export function listConversationShares(conversationId: string): ConversationShare[] {
  return sharesStore().store.read()
    .filter((share) => share.conversation_id === conversationId && !share.revoked_at)
    .map(toShare);
}

/** Revoking twice is a no-op; an unknown share is 404 so ids cannot be probed. */
export function revokeConversationShare(conversationId: string, shareId: string): void {
  const { store } = sharesStore();
  const shares = store.read();
  const share = shares.find((candidate) => candidate.id === shareId && candidate.conversation_id === conversationId);
  if (!share) throw new ApiError("That link doesn't exist.", 404);
  if (share.revoked_at) return;
  const revokedAt = new Date().toISOString();
  store.write(shares.map((candidate) => (candidate.id === shareId ? { ...candidate, revoked_at: revokedAt } : candidate)));
}

const STORE_PREFIX = "bomesh.pending.chat.share.";

/**
 * `GET /conversation-shares/{share_id}`. The server finds the share by id
 * and checks the audience; here every account's share store in this browser
 * is searched, so a link opens only in the browser that made it. A share the
 * caller may not open is 404, like an unknown or revoked one, so ids can't
 * be probed. Each cited document is re-read as the caller: one they can't
 * open becomes a bare marker without its title.
 */
export async function getConversationShare(shareId: string): Promise<SharedConversation> {
  const caller = pendingCaller();
  requirePendingPermission(caller, null, "");
  const found = findShare(shareId);
  if (!found || found.share.revoked_at) throw new ApiError("That shared chat doesn't exist.", 404);
  const { share, workspaceId } = found;
  const allowed = share.created_by.id === caller.accountId
    || (workspaceId === caller.workspaceId && (
      share.audience === "workspace"
      || share.emails.includes((caller.email ?? "").toLowerCase())
    ));
  if (!allowed) throw new ApiError("That shared chat doesn't exist.", 404);

  const ids = [...new Set(share.snapshot.messages.flatMap((message) => (message.sources ?? []).map((source) => source.document_id)))];
  const readable = new Set<string>();
  await Promise.all(ids.map(async (documentId) => {
    try {
      await apiRequest(`/documents/${encodeURIComponent(documentId)}`);
      readable.add(documentId);
    } catch {
      // Unreadable or unreachable: never reveal what it was.
    }
  }));
  return {
    id: share.id,
    title: share.snapshot.title,
    audience: share.audience,
    created_at: share.created_at,
    created_by: share.created_by,
    messages: share.snapshot.messages.map((message) => ({
      role: message.role,
      content: message.content,
      sources: (message.sources ?? []).map((source): SharedConversationSource => (
        readable.has(source.document_id) ? { ...source, available: true } : { number: source.number, available: false }
      )),
    })),
  };
}

function findShare(shareId: string): { share: StoredShare; workspaceId: string } | null {
  if (typeof window === "undefined") return null;
  for (let index = 0; index < window.localStorage.length; index += 1) {
    const key = window.localStorage.key(index);
    if (!key?.startsWith(STORE_PREFIX)) continue;
    try {
      const shares = JSON.parse(window.localStorage.getItem(key) ?? "[]") as StoredShare[];
      const share = shares.find((candidate) => candidate.id === shareId);
      if (share) return { share, workspaceId: key.slice(STORE_PREFIX.length).split(".").at(-1) ?? "" };
    } catch {
      // A corrupt store holds nothing to open.
    }
  }
  return null;
}
