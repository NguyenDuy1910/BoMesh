import { SharedChatPage } from "@/modules/chat/components/SharedChatPage";

export default async function SharedChatRoute({ params }: { params: Promise<{ shareId: string }> }) {
  const { shareId } = await params;
  return <SharedChatPage key={shareId} shareId={shareId} />;
}
