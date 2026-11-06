import { ChatThread } from "@/modules/chat/components/ChatThread";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ChatThread id={id} />;
}
