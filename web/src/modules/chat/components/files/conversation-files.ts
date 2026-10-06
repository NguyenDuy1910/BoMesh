import { turnArtifacts, type TurnArtifact } from "../../artifacts.ts";
import type { ChatMessage, ConversationDocument } from "../../types";

/** A file in this chat: one the assistant made, or one the person attached. */
export type ConversationFile =
  | { kind: "made"; id: string; artifact: TurnArtifact; messageId: string }
  | { kind: "attached"; id: string; document: ConversationDocument; messageId: string };

/**
 * Every file of a conversation, each once, in the order it first appeared.
 *
 * A made file carries its newest revision across all answers (asking for
 * changes adds revisions to the same file); an attached file is the upload
 * or the knowledge document a question carried.
 */
export function conversationFiles(messages: readonly Pick<ChatMessage, "id" | "role" | "parts" | "turn">[]): ConversationFile[] {
  const files = new Map<string, ConversationFile>();
  for (const message of messages) {
    if (message.role === "assistant") {
      for (const artifact of turnArtifacts(message.turn)) {
        const id = `made:${artifact.id}`;
        const existing = files.get(id);
        if (!existing) files.set(id, { kind: "made", id, artifact, messageId: message.id });
        else if (existing.kind === "made" && artifact.revision >= existing.artifact.revision) {
          files.set(id, { ...existing, artifact });
        }
      }
      continue;
    }
    for (const part of message.parts) {
      if (part.type !== "data-document") continue;
      const id = `attached:${part.data.id}`;
      if (!files.has(id)) files.set(id, { kind: "attached", id, document: part.data, messageId: message.id });
    }
  }
  return [...files.values()];
}
