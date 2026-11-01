import { Suspense } from "react";

import { ChatHomePage } from "@/modules/chat/components/ChatHomePage";

export default function ChatPage() {
  // The home page reads `?q=`, `?scope=`, `?doc=` and `?action=` deep links.
  return (
    <Suspense fallback={null}>
      <ChatHomePage />
    </Suspense>
  );
}
