import { ChatThreadPage } from "@/modules/chat/components/ChatThreadPage";

export default async function ChatThreadRoute({ params }: { params: Promise<{ conversationId: string }> }) {
  const { conversationId } = await params;
  // Keyed so another chat starts from a fresh page: its own panel, draft and files.
  return <ChatThreadPage conversationId={conversationId} key={conversationId} />;
}
