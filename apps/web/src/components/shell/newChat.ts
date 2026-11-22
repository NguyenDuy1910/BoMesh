"use client";

/** How long New chat waits for the composer after navigating. */
const WAIT_MS = 3000;

/**
 * New chat from ⌘K and ⌘⇧O (preview `A['chat-new']`): goes to `/chat` (the sidebar's New chat row is a plain link) and puts
 * the caret in its composer (`#chat-input`) once that page shows and the command palette has let go of focus.
 */
export function startNewChat(push: (href: string) => void): void {
  if (window.location.pathname !== "/chat") push("/chat");
  const until = performance.now() + WAIT_MS;
  const tick = () => {
    const ready = window.location.pathname === "/chat" && !document.querySelector(".palette");
    const input = ready ? document.querySelector<HTMLTextAreaElement>("#chat-input") : null;
    if (input) {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    } else if (performance.now() < until) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
