import type { ReactNode } from "react";

/** Keyboard key (preview `kbd()`). */
export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}
