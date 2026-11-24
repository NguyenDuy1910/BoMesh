"use client";

import { getSession } from "@/lib/session";

/** The product tour runs on Home, the landing page. */
export const TOUR_PATH = "/home";

export interface TourStep {
  id: string;
  /** What the step points at; the first match on screen. */
  sel: string;
  title: string;
  body: (ctx: { workspace: string; touch: boolean }) => string;
}

/**
 * The tour's steps in order (preview `features/chat.js` TOUR): the Ask box, Getting started, Picked for you, Explore by
 * domain, New chat and Search. A step whose target isn't on screen is skipped.
 */
export const TOUR: readonly TourStep[] = [
  {
    id: "ask",
    sel: "#home-ask",
    title: "Hỏi bất cứ điều gì",
    body: ({ workspace }) =>
      `Câu trả lời chỉ lấy từ các tài liệu bạn được xem trong ${workspace}, luôn kèm nguồn. Bạn có thể đính kèm tệp hoặc chọn phạm vi tìm; các gợi ý là câu hỏi mà người cùng vai trò với bạn hay hỏi.`,
  },
  {
    id: "start",
    sel: ".home-start:not(.home-start--done)",
    title: "Nên làm gì trước",
    body: () => "Ba bước đầu tiên, mỗi bước có nút riêng. Bước nào bạn đã làm sẽ tự được đánh dấu xong.",
  },
  { id: "picks", sel: ".home-picks", title: "Dành cho bạn", body: () => "Được chọn theo câu hỏi thường gặp của vai trò bạn, các cộng đồng bạn tham gia và những gì bạn đã đọc. Nhãn trên mỗi thẻ cho biết lý do." },
  { id: "domains", sel: ".home-domains", title: "Mọi thứ, theo lĩnh vực", body: () => "Chọn một lĩnh vực để mở mục Tài liệu đã lọc theo lĩnh vực đó; chọn một chủ đề để đến thẳng các tài liệu thuộc chủ đề." },
  {
    id: "chat",
    sel: "#nav-chat",
    title: "Trò chuyện mới",
    body: () => "Bắt đầu cuộc trò chuyện ở đây, kèm tệp và phạm vi bạn chọn. Các cuộc trò chuyện của bạn nằm trong mục Gần đây, phía dưới thanh bên.",
  },
  {
    id: "search",
    sel: "#side-search, #topbar-search",
    title: "Tìm mọi thứ",
    body: ({ touch }) => (touch ? "Tìm cuộc trò chuyện, tài liệu và trang." : "Tìm kiếm cuộc trò chuyện, tài liệu và trang, hoặc nhấn ⌘K."),
  },
];

/** The first on-screen element a step points at (phones show some controls in other places, or not at all). */
export function tourTarget(sel: string): Element | null {
  const width = document.body.clientWidth;
  return (
    [...document.querySelectorAll(sel)].find((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.right > 4 && r.left < width - 4;
    }) ?? null
  );
}

/** The steps on screen right now, in tour order (their ids). */
export function shownTourSteps(): string[] {
  return TOUR.filter((s) => tourTarget(s.sel)).map((s) => s.id);
}

/** Home has finished loading: its Ask box is there and no skeleton is left. */
export function homeReady(): boolean {
  return !!document.querySelector("#home-ask") && !document.querySelector("#scroll .home-skel");
}

/*
 * Home's welcome card (modules/home `HomeWelcome`) greets a new member once per person and workspace on this device.
 * Answering it (Later, Escape) or ending the tour it offers — however the tour ends — records it as seen.
 */
const seenKey = (user: string, workspace: string) => `bomesh.tourSeen.${user}:${workspace}`;

export function welcomeSeen(user: string, workspace: string): boolean {
  return !!window.localStorage.getItem(seenKey(user, workspace));
}

export function markWelcomeSeen(user: string | undefined, workspace: string): void {
  if (user) window.localStorage.setItem(seenKey(user, workspace), String(Date.now()));
}

/**
 * Whether Home's welcome card will greet the person arriving at `path` in `workspace` (a new member's first Home visit on
 * this device). Joining confirms itself with a toast only when it won't: the card says hello in its place.
 */
export function welcomesOnArrival(workspace: string, path: string): boolean {
  const user = getSession()?.user.name;
  return path === TOUR_PATH && !!user && !welcomeSeen(user, workspace);
}
