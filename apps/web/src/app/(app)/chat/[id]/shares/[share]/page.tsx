import { SharedConversation } from "@/modules/chat/components/SharedConversation";

export default async function Page({ params }: { params: Promise<{ id: string; share: string }> }) {
  const { id, share } = await params;
  return <SharedConversation conversation={id} share={share} />;
}
