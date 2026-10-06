/** Date groups and search for the chat history list (`/chats`). */

export type ChatDateGroup = "Today" | "Yesterday" | "Previous 7 days" | "Previous 30 days" | "Older";

const GROUP_ORDER: readonly ChatDateGroup[] = ["Today", "Yesterday", "Previous 7 days", "Previous 30 days", "Older"];
const DAY_MS = 86_400_000;

function startOfDay(timestamp: number): number {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** Calendar days in the reader's time zone, not 24-hour windows. */
export function chatDateGroup(updatedAt: number, now: number): ChatDateGroup {
  const days = Math.round((startOfDay(now) - startOfDay(updatedAt)) / DAY_MS);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return "Previous 7 days";
  if (days < 30) return "Previous 30 days";
  return "Older";
}

/** Newest first, in the fixed group order; empty groups are left out. */
export function groupChatsByDate<T extends { updated_at: number }>(
  chats: readonly T[],
  now: number,
): { group: ChatDateGroup; items: T[] }[] {
  const sorted = [...chats].sort((a, b) => b.updated_at - a.updated_at);
  return GROUP_ORDER
    .map((group) => ({ group, items: sorted.filter((chat) => chatDateGroup(chat.updated_at, now) === group) }))
    .filter((entry) => entry.items.length > 0);
}

/** Every word of the query appears in the title or the preview, any case. */
export function matchesChatQuery(chat: { title: string; preview: string }, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const haystack = `${chat.title} ${chat.preview}`.toLowerCase();
  return words.every((word) => haystack.includes(word));
}

/** "Just now", "12 min ago", "3 h ago", "Yesterday", "3 days ago", then the date. */
export function chatTimeLabel(updatedAt: number, now: number): string {
  const delta = now - updatedAt;
  const group = chatDateGroup(updatedAt, now);
  if (group === "Today") {
    if (delta < 60_000) return "Just now";
    if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} min ago`;
    return `${Math.floor(delta / 3_600_000)} h ago`;
  }
  if (group === "Yesterday") return "Yesterday";
  if (group === "Previous 7 days") return `${Math.round((startOfDay(now) - startOfDay(updatedAt)) / DAY_MS)} days ago`;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    ...(new Date(updatedAt).getFullYear() === new Date(now).getFullYear() ? {} : { year: "numeric" }),
  }).format(updatedAt);
}
